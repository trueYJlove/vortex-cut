# M2-B3 关键帧动画设计定案

> 状态：设计评审稿。实现须拆分 PR 并引用本文档章节号。
> 对齐 M2_ROADMAP §B3：位置、缩放、旋转、透明度四属性中至少两种；关键帧可视化+可拖拽；播放时插值。

## 0. 范围决策

**实现全部四种属性**（位置 x/y、缩放 scale、旋转 rotate、透明度 opacity）。理由：渲染滤镜链（§4）已验证全部支持逐帧表达式，四属性的模型/操作/插值逻辑完全同构，只做两种并不省结构成本。

**每属性的关键帧是独立时间轴**（如位置有 3 个关键帧、透明度有 2 个），而非"整段一排帧"——与主流剪辑器一致，也让单属性增删不牵连他属性。

**非目标**：缓动曲线编辑（本期固定线性插值，曲线编辑器是 B3 后的独立特性）；属性叠加组合预设；A1 音频轨关键帧。

## 1. 数据模型

### 1.1 文档结构

`TimelineClip` 新增**可选**键 `keyframes`（缺省视为无动画，旧 Revision 零迁移）：

```jsonc
{
  "clip_id": "clip_abc",
  "keyframes": {
    "position": { "unit": "ratio", "frames": [ { "t_us": 0, "x": 0.5, "y": 0.5 }, { "t_us": 1_000_000, "x": 0.3, "y": 0.7 } ] },
    "scale":    { "unit": "ratio", "frames": [ { "t_us": 0, "v": 1.0 }, { "t_us": 2_000_000, "v": 1.5 } ] },
    "rotate":   { "unit": "deg",   "frames": [ { "t_us": 0, "v": 0 },   { "t_us": 2_000_000, "v": 90 } ] },
    "opacity":  { "unit": "ratio", "frames": [ { "t_us": 0, "v": 1.0 }, { "t_us": 500_000, "v": 0.5 } ] }
  }
}
```

语义约定：

- **坐标基准是时间线时间**（`t_us` ∈ [0, 片段时间线时长]），变速/裁剪后关键帧随片段走（时间线语义），不做源时间绑定——与转场的"借用式"哲学一致，避免与 B1/B2 语义纠缠；
- `position` 的 x/y 是**相对画布中心**的比率（0 = 画布中心，−0.5~+0.5 = 画布边缘），渲染时乘画布宽高，天然适配多画幅导出；
- `scale` 比率（0.1–5.0，1 = 适配尺寸）；`rotate` 角度（−180–180，超出取模）；`opacity` 比率（0–1）；
- 每属性 `frames` 按 `t_us` 升序、`t_us` 唯一、≥2 帧才有动画意义（0/1 帧合法但无效果）；
- 每属性最多 32 帧。

### 1.2 插值规则（冻结）

线性插值：`v(t) = v0 + (v1 − v0) × (t − t0) / (t1 − t0)`；窗口外取边界值（首帧前 = 首帧值，末帧后 = 末帧值）。`rotate` 不做角度回绕插值（−180/180 边界由 UI 限制输入规避）。

### 1.3 操作（PATCH_OPERATIONS 新增 4 个）

```
set_clip_keyframes  { op, clip_id, property, frames: [{t_us, ...}] }   // 整属性覆盖（UI 拖拽用幂等全量提交）
clear_clip_keyframes { op, clip_id, property }
```

- `property ∈ {position, scale, rotate, opacity}`；
- **整属性覆盖而非逐帧增删**：拖拽场景每次 pointerup 提交全量帧列表，天然幂等、可撤销（一个 Revision 一步）、与现有 trim/speed 的"操作即全量"风格一致；
- 校验：`t_us` 升序唯一且 ∈ [0, 片段时长]；数值范围按属性；`position` 帧含 x/y、其余含 v；帧数 ≤ 32；
- 联动：锁定片段拒绝；变速（`set_speed`）与图片时长（`set_image_duration`）改变片段时长时，**越界关键帧按比例重映射**到新区间（保持相对位置）；`split_clip` 时关键帧按拆分点切分归两侧（边界帧克隆）；`trim_clip` 时间线语义下不变（关键帧跟时间线）；
- AI patch：`set_clip_keyframes`/`clear_clip_keyframes` 进入 `AI_PATCH_OPERATIONS`。

### 1.4 校验器影响面

- contracts：`isTimelineKeyframes`/`isTimelineKeyframeProperty`；`isTimelineClip` 的 onlyKeys 加 `keyframes`；
- core：`_normalize_and_validate` 全量校验；diff 新增 `keyframes_changed`（clip_changes 内新类型，摘要按属性计）。

## 2. 与既有特性的交互

| 特性 | 规则 |
|---|---|
| 转场（B2） | 转场借用区内的关键帧时间不重映射（借用是渲染概念，文档时间不变）；xfade 与属性动画滤镜链串联 |
| 变速（B1） | 时长按比例缩放，关键帧 t_us 等比重映射（§1.3） |
| 倒放（B1） | 渲染时 reverse 先行，属性动画作用于反转后的输出时间轴（与视觉一致） |
| 布局（fit/crop/blur） | 位置/缩放叠加在布局结果之上（先布局后动画变换），fit 的黑边内动画 |

## 3. 渲染管线（已验证滤镜能力）

每段视觉链在现有"源 trim → 方形像素 → 布局"之后追加**动画变换链**：

- **position**：段转为中间流后 `overlay=x='(W-w)/2 + X*(W/2)':y='(H-h)/2 + Y*(H/2)':eval=frame`（X/Y 为线性插值表达式，由编译器生成 `ld(0)`/分段 `if(between(t,a,b), ...)` 链）；
- **scale**：`scale=w='iw*S(t)':h='ih*S(t)':eval=frame`（S 为插值表达式）；
- **rotate**：`rotate=A(t)*PI/180:c=none@0`（黑透明角）；
- **opacity**：`fade=alpha=1:...` 不适合任意曲线 → 用 `colorchannelmixer=aa=OP(t)`（T. 帧级动属）或 `format=yuva420p,colorchannelmixer`；
- 表达式生成规则：编译器把关键帧列表编译为 `if(lt(t,t1), lerp, if(lt(t,t2), ...))` 嵌套（`t` 为段内相对秒）；帧数 ≤32 时表达式长度可控；
- **指纹**：keyframes 进入 `content_semantics`（经 clips 自动覆盖）。

边界：转场借用区内的动画按段内相对时间继续生效（视觉上转场混合与属性动画叠加，可接受）。

## 4. 桌面 UI

### 4.1 关键帧编辑

- **入口**：属性面板选中片段时新增"动画"区，四属性各一行：添加/清除关键帧按钮 + 当前播放头值输入框（有关键帧时显示插值标记）；
- **可视化**：片段下沿（V1 轨内）绘制属性色点（位置青/缩放黄/旋转橙/透明度白），选中片段时显示；
- **拖拽**：色点水平拖动改 `t_us`（pointerup 提交整属性全量帧）；
- **播放跟随**：交互预览播放时属性面板数值按插值实时刷新（rAF 节流）。

### 4.2 交互预览

HTML5 video 无法做几何变换 → 交互预览**不渲染动画**，属性面板数值与时间线色点正确显示；预览浮层提示"动画仅权威预览生效"（与转场同口径）。

## 5. 验收（对齐 M2_ROADMAP §B3）

1. 为片段添加"缩放 + 透明度"（超出两种的最低要求）关键帧 → 权威预览播放动画平滑；
2. 关键帧色点在时间线可见，拖拽改时间后重渲染动画相应变化；
3. 播放中属性值随插值变化（数值面板校验）；
4. 变速后关键帧随比例重映射；拆分后关键帧归两侧；
5. 撤销/重做覆盖关键帧操作。

## 6. 实施拆分（预计 3 个 PR）

1. **PR-A（core+contracts）**：keyframes 模型、set/clear 操作、重映射/切分联动、校验、diff、单测；
2. **PR-B（渲染）**：关键帧 → FFmpeg 表达式编译器、四属性滤镜链、渲染单测 + 真渲染 E2E（缩放+透明度动画时长/采样验证）；
3. **PR-C（UI）**：属性面板动画区、时间线色点、拖拽、E2E UI 断言。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 嵌套 if 表达式过长导致 FFmpeg 解析失败 | 帧数上限 32；渲染单测覆盖 2/8/32 帧编译 |
| scale+rotate+overlay 叠加的 SAR/坐标精度 | 渲染单测对固定关键帧输出做像素采样断言；E2E 真渲染 |
| 变速重映射与转场借用区叠加的边界 | 单测覆盖"转场 + 变速 + 关键帧"三特性组合 |
| 交互预览不渲染动画造成用户困惑 | 预览浮层与属性面板常驻提示（与转场同口径） |
EOF
git add docs/M2_B3_KEYFRAMES_DESIGN.md && git commit -m "docs: M2-B3 关键帧动画设计定案（四属性/整属性覆盖操作/线性插值/FFmpeg 表达式编译）" && git push -u origin m2-b3-keyframes-design 2>&1 | tail -1 && gh pr create --base master --head m2-b3-keyframes-design --title "docs: M2-B3 关键帧动画设计定案（评审稿）" --body "$(cat <<'EOF'
## 概述

B3 关键帧动画的实现前设计定案（纯文档 PR）。评审通过后按 §6 拆三段实施（core → 渲染 → UI）。

## 关键决策（请重点评审）

1. **四属性全做**：位置/缩放/旋转/透明度。滤镜能力已逐一验证（overlay x/y、scale eval=frame、rotate angle、colorchannelmixer aa），四属性结构同构，做两种不省成本。
2. **每属性独立时间轴**：position 有自己的帧列表、opacity 有自己的，单属性增删不牵连他属性。
3. **坐标基准 = 时间线时间**：关键帧跟片段走；变速时等比重映射、拆分时切分归两侧——与 B1/B2 语义正交。
4. **整属性覆盖操作**：`set_clip_keyframes` 一次提交整属性帧列表（拖拽幂等提交、单 Revision 可撤销），不做逐帧增删。
5. **线性插值冻结**：缓动曲线编辑列为本期后的独立特性。
6. **交互预览不渲染动画**（HTML5 video 无法几何变换），常驻提示与转场同口径。

## 已验证的滤镜能力

overlay x/y 表达式、scale eval=frame、rotate angle（T. 帧级动属）、colorchannelmixer aa——本地 FFmpeg 全部支持逐帧求值。
EOF
)" 2>&1 | tail -1
# M2-B4 字幕与文字叠加设计定案

> 状态：设计评审稿。实现须拆分 PR 并引用本文档章节号。
> 对齐 PRODUCT_ROADMAP（原 M2_ROADMAP）§B4：独立文字轨道 + 多文字片段；字体/字号/颜色/描边/位置可编辑；文字片段时长可拖拽。

## 0. 范围决策

**方案：每字幕样式覆盖（per-caption style overrides），不新建第二类"文字实体"。**

理由：现有 `TimelineCaption` 已是 C1 轨道上的独立片段（有 start/end/text/来源），"添加文字片段"能力已存在（`add_caption`，`source_clip_id=null`）。B4 的实质缺口是**样式不可编辑**（只有 3 个全局预设）与**时长拖拽**。新增独立文字实体会造成两套并行的轨道/渲染/导出路径，成本远超收益。

- 字体：**不开放任意字体选择**（仅打包的 Noto Sans CJK SC 一种，避免字体分发/度量问题），在 UI 中展示但禁用。设计文档如实标注此限制；后续若需多字体再引入字体包管理。
- 字号/颜色（字体+描边）/描边宽度/位置：全部支持 per-caption 覆盖。
- 时长拖拽：C1 轨字幕片段端点拖拽（与 V1 trim 同交互模式），落 `set_caption_timing`（已存在）。

## 1. 数据模型

### 1.1 TimelineCaption 新增可选键 `style_override`

```jsonc
{
  "caption_id": "caption_x",
  "style_override": {
    "font_size": 72,            // 24–144，PlayRes 1080x1920 基准
    "primary_color": "&H00FFFFFF",  // ASS BGR 格式
    "outline_color": "&H00000000",
    "outline": 4,               // 0–10 描边宽度
    "alignment": 2,             // ASS numpad：2=底部 5=居中 8=顶部（预设位置）
    "margin_v": 150,            // 0–600，alignment 为 2/8 时距底/顶偏移
    "pos_x": null, "pos_y": null // 0–1 比率；非 null 时用 \pos() 覆盖 alignment（自定义坐标）
  }
}
```

规则：**部分覆盖**——只存与预设不同的字段；渲染时逐字段与预设合并（preset 提供缺省）。`preset_id` 保留（决定基线预设），用户改样式即写入 override；"恢复预设样式" = 删除 override。

### 1.2 操作（PATCH_OPERATIONS 新增 2 个）

```
set_caption_style     { op, caption_id, style: {部分字段} }   // 合并写入（未提及字段保留）
clear_caption_style   { op, caption_id }                      // 恢复预设样式
```

- 校验：font_size 24–144；outline 0–10；alignment ∈ {2,5,8}；margin_v 0–600；pos_x/pos_y 0–1 比率或 null；颜色必须匹配 `&H[aabbggrr]` 格式（防注入，ASS 文本字段本就有转义）；
- 锁定：沿用 caption 关联 clip 的锁定守卫（`_require_unlocked` 已覆盖 caption_id 路径，扩展 style 操作同）；
- diff：caption_changes 新增 `style_changed`。

### 1.3 校验器影响面

- contracts：`isCaptionStyleOverride`；`isTimelineCaption` onlyKeys 加 `style_override`；两个新操作 case；`TimelineCaptionChangeType` 加 `style_changed`。

## 2. 渲染管线（ass.py）

- `build_ass`/`build_rendition_ass`：Style 行保持按预设生成不变；**有 override 的字幕改用 Dialogue 行内联覆盖标记**（ASS 原生支持行内样式标签）：
  - 字号/颜色/描边：`{\fs72\c&HFFFFFF&\3c&H000000&\bord4}` 前缀；
  - alignment/margin：`{\an2\pos(x,y)}` 或 `{\an8}`（pos 用画布比率 × PlayRes 换算）；
  - 这些标签拼在 escape_ass_text 输出**之前**（标签不参与正文转义，正文转义逻辑不变，注入面不扩大——标签值全部来自服务端校验过的数值/颜色枚举，不接受用户字符串）；
- 指纹：captions 项随 document 自动进入 content_semantics。

## 3. 桌面 UI

### 3.1 字幕样式编辑（CaptionProperties 扩展）

选中字幕时属性面板新增"样式"区（预设选择器下方）：

- 字号数值输入（24–144）；字体颜色/描边颜色取色器（`<input type=color>`，RGB↔ASS 互转）；描边宽度 0–10；
- 位置三选（底部/居中/顶部）+ "自定义坐标"开关（开启后显示 x/y 比率输入 0–1）；
- "恢复预设样式"按钮（clear_caption_style）；
- 任一改动即时提交 `set_caption_style`（防抖 400ms，与文本编辑一致）。

### 3.2 时长拖拽（TimelineCanvas）

C1 轨字幕片段两端 8px 拖拽手柄（复用 V1 trim 的交互模式与 hitTest 优先级），松手提交 `set_caption_timing`（约束沿用 core：≥200ms、不与相邻字幕重叠、≤片段时间线）。拖拽中显示预览时长标签。

## 4. 验收（对齐 PRODUCT_ROADMAP（原 M2_ROADMAP）§B4）

1. `add_caption` 添加多个文字片段（已支持），各自独立选中编辑；
2. 改字号/颜色/描边/位置 → 权威预览 ASS 渲染样式即时更新（diff→stale→重新预览链路复用）；
3. 拖拽字幕端点改时长 → 预览时间轴随动；
4. 撤销/重做覆盖样式与时长操作。

## 5. 实施拆分（预计 2 个 PR）

1. **PR-A（core+contracts+渲染）**：style_override 模型、两操作、ASS 行内标签生成、校验、diff、单测（含 ASS 输出快照断言）；
2. **PR-B（UI）**：样式编辑区、取色器互转、时长拖拽、E2E。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| ASS 标签注入 | 标签值全部为服务端校验的数值/枚举，正文仍走 escape_ass_text；单测覆盖含特殊字符正文 + 样式的组合输出 |
| pos 比率与 PlayRes 换算错位 | 单测固定 PlayRes 1080x1920 断言换算像素 |
| 部分覆盖与预设合并的字段遗漏 | 合并逻辑集中单函数 + 快照测试 |
| 字体单一的限制被用户感知 | 见 §8 多字体包支持 |

---

## 7. 气泡与花字样式覆盖（B4 收官）

> 合并自原 `M2_B4_BUBBLE_FX_DESIGN_2026-09-18.md`。沿用 `per-caption style_override` + 服务端校验 + ASS 渲染范式，不引入第二类文字实体或新操作。

### 7.1 `style_override` 扩展字段与校验

- `border_style`: `1`（描边+阴影，默认）或 `3`（不透明底衬块，气泡模式）；
- `back_color`: ASS `&Haabbggrr` 格式（气泡底色/阴影色，含 alpha）；
- `shadow`: `0–10`（阴影深度 / BorderStyle=3 下底衬外扩感）；
- `fx_preset`: `"none" | "gold-gradient" | "neon-glow" | "sticker-outline" | "soft-shadow"`（模板集交付，不开放自由参数）。
- **互斥规则**：`fx_preset` 与 `primary_color`/`outline_color` 并存时，花字模板标签后置覆盖颜色；UI 选中花字模板时禁用基础色控件并提示。

### 7.2 ASS 渲染映射与范围边界

- `border_style=3` / `back_color` / `shadow`：由于 ASS Dialogue 行内无 BorderStyle 切换，`build_ass` 为含 `border_style=3` 覆盖的字幕生成确定性去重**派生 Style 行**（`{preset_id}__b3`），Dialogue 引用该派生 Style；
- `fx_preset`：展开为固定服务端生成的行内标签前缀（无用户输入注入面），经 `test_b4_bubble_fx_render_real.py` 真渲染验证；
- 明确不做：矢量气泡尾巴、自由花字参数编辑、字幕动画（Tab 维持 `soon`）与矩形渐变 `\clip`。

---

## 8. 多字体支持与字体包设计

> 合并自原 `M2_B4_MULTI_FONT_DESIGN_2026-09-18.md`，解除早期单字体限制。

- **字体包清单（`resources/fonts/bundle.json` v2）**：升级为 `fonts: [{ family, file, license, license_file, sha256, role: "default" | "extra" }]`（`CaptionResources` 向后兼容读取 v1 单对象）：
  - **思源黑体 Noto Sans CJK SC**（`default`）
  - **思源宋体 Noto Serif CJK SC**（`extra`，OFL）
  - **霞鹜文楷 LXGW WenKai**（`extra`，OFL）
- **Core 与校验**：`libass` 经 `fontsdir` 自动加载目录内全部字体文件；`build_ass` 保持 Style 族名，行内 `\fn` 引用注册字体；`_validate_caption_style.font_name` 白名单改为运行时注册表 `family` 集合（拒绝未注册字体名，防止预览与导出静默回退分叉）；新增 `GET /api/v1/caption-fonts` 返回 `{ fonts: [{ family, role }] }`（不含本地路径）。
- **Desktop 预览同步**：Main IPC `media:caption-font-urls` 返回 `[{ family, media_url }]`，`SyntheticPreview` 并行加载并通过 `FontFace(family)` 按真实 family 名注册（取代早期硬编码 `AppCaptionCJK`），`compositor` 按 `override.font_name -> 预设族名 -> default family` 逐级取用。
- **明确不做**：用户自装系统字体、在线字体下载、独立字重下拉（Variable TTF 经 bold 标签表达）。

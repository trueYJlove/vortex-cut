# M2-B2 转场系统设计定案

> 状态：设计评审稿。本文档是 B2 的实现基准；实现须拆分 PR 并引用本文档章节号。
> 作者：LiuWei（架构）；评审：ZhangSan（core/渲染）、YeJing（桌面/UI）、LiuKeAi（验收）。

## 0. 目标与非目标（对齐 PRODUCT_ROADMAP（原 M2_ROADMAP）§B2）

**目标**

1. 至少 5 种转场，可置于 V1 相邻视频/图片片段之间；
2. 转场时长可调：默认 0.5s，范围 0.1s–2s（`MIN_TRANSITION_US = 100_000`，`MAX_TRANSITION_US = 2_000_000`）;
3. 转场在权威预览与最终导出中正确渲染；交互预览给出明确的非权威近似或提示；
4. 时间线可视化显示转场标记，UI 可添加/调整时长/删除；
5. 全链路走 TimelinePatch：可撤销/重做、可 diff、AI patch 协议自动获得能力。

**非目标（本轮不做）**

- A1 音频轨上的转场（音频随视频用 `acrossfade` 自动交叉淡化，见 §4.3；独立的音频转场不做）；
- 转场拖拽素材箱、自定义转场曲线、转场作用在同轨不相邻片段；
- 片段速度（B1）与转场的组合限制之外的交互——速度照常生效，转场作用于时间线区间（见 §2.3 语义）。

## 1. 类型清单（冻结 8 种，覆盖路线图 5 类）

从本地 FFmpeg `xfade` 支持的 58 种中冻结以下 8 种（名称即 `xfade` 的 `transition` 参数值）：

| id | xfade transition | 对应路线图类别 |
|---|---|---|
| `fade` | fade | 淡入淡出 |
| `fadeblack` | fadeblack | 淡入淡出（经黑） |
| `dissolve` | dissolve | 溶解 |
| `wipeleft` | wipeleft | 擦除 |
| `wiperight` | wiperight | 擦除 |
| `slideleft` | slideleft | 滑动 |
| `slideup` | slideup | 滑动 |
| `zoomin` | zoomin | 缩放 |

扩展方式：仅改 `TRANSITION_IDS` 常量（core）+ `TRANSITION_IDS`（contracts 校验），不改结构。

## 2. 数据模型与语义

### 2.1 文档结构

`TimelineDocument` 新增可选顶层键 `transitions`：

```jsonc
{
  "schema_version": 1,
  "transitions": [
    {
      "transition_id": "transition_x7f3a",
      "after_clip_id": "clip_abc",   // 转场发生在该片段与其后继之间
      "kind": "fade",
      "duration_us": 500_000
    }
  ]
}
```

- `transitions` 可选：缺省视为 `[]`（旧 Revision 文档零迁移成本，`onlyKeys` 校验加可选键即可）；
- 每对相邻片段之间至多一个转场（以 `after_clip_id` 唯一性约束）；
- `duration_us` ∈ [100_000, 2_000_000]。

### 2.2 时间语义（关键决策：**不引入重叠，转场借用重叠区**）

现状 V1 是严格连续打包（`_normalize_timing` 从 0 依次拼接）。业界做法是转场区间内两片段时间重叠。为**不破坏现有归一化、锁定平移、裁剪联动、字幕绑定**等全部既有逻辑，采用**借用语义**：

- 转场区间 = 前片段的**尾部** T_us 与后片段的**头部** T_us 在渲染时交叉混合；
- 文档中两片段的 `timeline_start_us/timeline_end_us` **保持连续不变**（前段结束于 t，后段始于 t）；
- 渲染时对前段截取其最后 T_us、后段截取其最先 T_us 做 `xfade`，成片总时长因此**缩短 (N_transition × T_us)**；
- 后片段在渲染计划中的 `offset` 相应前移——由渲染编译器统一推导（§4.2），文档不存冗余时间。

**代价与接受理由**：成片总时长与时间线视觉总时长在加转场后会差 N×T。时间线 UI 在标尺/时长显示处标注"含转场压缩"；这是对现有模型侵入最小的方案，避免重叠区间带来的锁定/字幕/裁剪联动重写。

### 2.3 与 B1 速度的交互

转场作用于**时间线区间** T_us。片段变速只改变片段自身时长（源范围/速度），不影响转场区间定义。渲染时前/后段各自的取窗按其在时间线上的最后/最先 T_us 映射回源时间（除以速度），再进 xfade。实现上即 §4.2 的取窗计算统一走"时间线 → 源"映射函数。

### 2.4 操作与联动（PATCH_OPERATIONS 新增 3 个）

```
add_transition    { op, after_clip_id, kind, duration_us }
update_transition { op, transition_id, kind?, duration_us? }
remove_transition { op, transition_id }
```

联动规则（core `_apply_operation` 内实现）：

- `add_transition`：`after_clip_id` 必须存在，且必须是 V1 轨道 `asset_kind ∈ {video, image}` 的片段，且其后继存在、同为 V1 且 video/image；同位置已有转场则拒绝（`TIMELINE_TRANSITION_EXISTS`）；
- `remove_clip`：删除片段时级联删除 `after_clip_id` 为该片段的转场，以及以该片段后继为起点的转场（即涉及该片段的前后两个转场）；
- `split_clip`：拆分点若落在转场区间内（距片段尾部 < T_us）拒绝，提示先删除或缩短转场；否则转场保持绑定在原片段（跟随片段尾部）；
- 锁定：`_require_unlocked` 扩展——`add/update/remove_transition` 涉及的任一片段被锁定即拒绝；
- AI patch：三个操作全部进入 `AI_PATCH_OPERATIONS`（转场是纯展示/时序操作，无外传风险面）。

### 2.5 校验器影响面

- contracts `isTimelineDocument`：`onlyKeys` 加 `"transitions"`，新增 `isTimelineTransition`（id 格式、kind 枚举、时长范围、`transitions.length ≤ 50`）；
- core `_normalize_and_validate`：同样加可选键 + 逐项校验 + `after_clip_id` 唯一性 + 引用完整性；
- diff：新增 `transitions_changed`（clip_changes 之外的单列清单，复用 caption_changes 的模式）。

## 3. Revision/存储影响

- 文档 JSON 自然携带 `transitions`，`timeline_revisions.document_json` 无表结构变更，**无需 DB 迁移**；
- `document_sha256` 自动覆盖转场（内容指纹含转场 → 转场变更使权威预览过期，复用现有 stale 机制）；
- 渲染计划 `content_semantics`（plan.py）加入 `transitions`，保证指纹正确区分。

## 4. 渲染管线

### 4.1 FFmpeg 滤镜选型（已验证本地 ffmpeg 支持）

- 视频：`xfade`（`transition=KIND:duration=T:offset=O`，链式级联 N-1 次）；
- 音频：`acrossfade`（`duration=T`，链式级联）；无音轨片段按现有 anullsrc 静音段进入交叉淡化（等效淡入淡出静音，语义正确）。

### 4.2 渲染计划与滤镜图改造（ffmpeg.py / plan.py）

- plan 段新增 `transition_in`：`{ transition_id, kind, duration_us } | null`（每个 segment 记录"进入自己头部"的转场）；
- 滤镜图从 `concat` 改为**两分支**：
  - 无转场：保持现有 `concat`（零回归）；
  - 有转场：`[v0][v1]xfade=...[vx1];[vx1][v2]xfade=...[vx2]...`，`offset_i = (前 i+1 段的时间线终点) − (i × T)`；
  - 各段 `trim` 取窗按 §2.2 语义：有尾部转场的段只取到 `source_end − T×speed`，有头部转场的段从 `source_start + T×speed` 取起；图片段按时长裁剪同理；
- `expected_duration`（service.py:328）改为 `末段 timeline_end_us − Σ T`；
- 字幕 `ass` 时间不需要偏移：字幕绑定的是时间线时间，而 xfade 压缩发生在片段之间（设计取舍：转场区间内的字幕与画面存在 ≤2s 的相对偏移，接受并在 UI 提示；若不可接受，后续版本可在 ass 生成时按转场区间做分段压缩映射——列为 backlog）。

### 4.3 音频策略

音频跟随视频交叉淡化（acrossfade），不单独提供音频转场类型；倒放片段（B1 `reverse_playback`）参与转场时正常取窗（先 reverse 再进入 xfade，滤镜顺序天然支持）。

## 5. 桌面 UI

### 5.1 交互入口

- **添加**：V1 两相邻片段之间的间隙位置单击出现"+"热点（画布命中测试，hover 显示"添加转场"提示）→ 弹出转场选择浮层（8 种，图标 + 名称）→ 默认 0.5s 创建；
- **调整**：点击转场标记 → 属性面板显示 kind 下拉 + 时长滑杆/数值输入（0.1–2.0s）+ 删除按钮；
- **删除**：属性面板删除按钮，或选中转场标记后 Delete。

### 5.2 时间线可视化

- 转场标记绘制在两片段交界处：宽度 = T_us × pps（最小可视宽度 6px），居中于边界；样式为双三角/沙漏形 + kind 缩写；选中态高亮描边；
- Selection 联合类型扩展 `{ kind: "transition"; id: string }`；画布命中测试优先级：转场标记 > 片段。

### 5.3 交互预览

交互预览不做 xfade 实时渲染（HTML5 video 无法交叉混合）。转场区间播放时行为：前段播完后直接切后段，预览浮层显示"转场仅权威预览生效"。此为已知近似，验收按此口径。

## 6. 契约与版本

- `CONTRACT_VERSION` 保持 `stage6r-v1`（document 可选键向后兼容，旧客户端读到新文档时 `onlyKeys` 会拒绝 `transitions` —— **需要同步发 contracts 包**，桌面与 core 同仓库同版本发布，无跨版本兼容负担）；
- 新错误码：`TIMELINE_TRANSITION_EXISTS`、`TIMELINE_TRANSITION_INVALID`（加入 ERROR_CODES）。

## 7. 测试与验收（对齐 PRODUCT_ROADMAP（原 M2_ROADMAP）§B2 验收）

**core 单测**：三操作的合法/非法路径；级联删除（remove_clip）；拆分点冲突拒绝；锁定拒绝；归一化后转场引用仍完整；diff 记录转场变更。

**渲染单测**：有转场时滤镜图含 `xfade`/`acrossfade` 链与正确 offset；无转场保持 concat（回归）；expected_duration 扣减转场区间。

**E2E（真实 Electron + FFmpeg）**：两个视频片段间加 0.5s fade → 生成权威预览 → 产物时长 = (D1+D2) − 0.5s（±83ms）；UI 显示转场标记、属性面板可调时长、删除后产物恢复总时长。

**手动验收（LiuKeAi）**：8 种转场逐一渲染检查视觉效果；变速片段 + 转场组合；转场 + 字幕区间提示；撤销/重做链。

## 8. 实施拆分（预计 3 个 PR）

1. **PR-A（core+contracts）**：类型、三操作、级联/锁定/拆分联动、校验、diff、单测——可独立合并，UI 尚不可见；
2. **PR-B（渲染）**：plan 字段、xfade/acrossfade 滤镜图、expected_duration、渲染单测 + E2E；
3. **PR-C（UI）**：画布标记与命中、添加浮层、属性面板、交互预览提示、E2E UI 断言。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| xfade 链式 offset 计算错误导致画面跳变 | 渲染单测覆盖 1/2/3 级联的 offset 公式；E2E 真渲染校验时长 |
| 转场区间字幕偏移被用户感知 | §4.2 已声明为已知近似；backlog 做 ass 分段映射 |
| split 与转场区间冲突 UX | 拒绝时错误消息明确指向"先删除或缩短转场" |
| 交互预览与成片观感差异 | 预览浮层常驻提示；验收口径按权威预览 |

## 10. 真实渲染视觉验收（2026-08-28）

用红/蓝高对比合成源对 8 种转场逐一真实 FFmpeg 渲染，并在转场前、中、后采样像素自动判定：fade、fadeblack、dissolve、wipeleft、wiperight、slideleft、slideup、zoomin 均通过。zoomin 初次中点单像素采样容易误判；增加多点连续采样后确认动画正常。该记录覆盖视觉渲染，不代表交互预览也实时播放转场；交互预览的近似边界仍见 §5.3。

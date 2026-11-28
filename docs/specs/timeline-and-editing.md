# 时间线与核心剪辑规格

> 本文整合多轨时间线、自由定位、转场、关键帧、字幕/气泡花字/多字体以及 Wave 1 剪辑语法与剪辑手法设计。
> 对齐 [`product-baseline.md`](product-baseline.md)；全视觉轨统一合成升级见 [`preview-and-rendering.md`](preview-and-rendering.md)；当前交付状态见 [`../STATUS.md`](../STATUS.md)。

---

## 1. 多轨时间线与自由定位

### 1.1 轨道结构与数据模型

`tracks` 数组顺序即界面自上而下顺序：

```text
[ 动态视频轨 V2+ / 动态文本轨 T1+ ]   ← 可任意添加、删除、交换位置
C1  字幕轨（text）                    ┐
V1  主视频轨（video）                 ├ 三条固定轨：恒存在、相对位置固定
A1  音频轨（audio）                   ┘
```

- **固定轨 vs 动态轨**：固定轨不可删除、不可移动；动态轨只能在 `C1` 之上的区域内换位。
- **轨道对象**：`{ id, kind: "video"|"text"|"audio", locked, hidden, muted, solo }`。
- **旧文档迁移**：kind `visual→video`、`caption→text`，补齐标志位与缺失的 `A1`，经 `_normalize_tracks` 规范化顺序。
- **自由定位语义（OpenCut 式）**：
  - `timeline_start_us` 为权威数据，`_normalize_timing` 不再从 0 重新压平重排，允许片段间留空隙；总时长取所有片段最大 `timeline_end_us`。
  - 同轨禁止重叠（前端拖动时钳制到最近合法空隙并贴齐邻居，Core `_validate_document` 逐对兜底拒绝 `TIMELINE_INVALID`）；跨轨允许叠加，按轨道自上而下遮挡。
  - 视觉片段（`video`/`image`）可在任意视频轨；音频片段固定 `A1`；类型不匹配即拒绝。
  - `trim_clip` 显式落位、`split_clip` 显式拆分、`insert_asset_clip` / `set_speed` / `set_image_duration` 在碰撞时触发 `_ripple_v1_right`（现已推广至同轨）向右涟漪推开后续片段并同步平移绑定字幕。
  - `move_clip` 仅改列表顺序/编号，不再影响时间位置（UI 统一提交 `position_clip`）。

### 1.2 轨道管理 Patch 操作

| op | 说明 |
|---|---|
| `add_track {kind: "video"|"text"}` | 新建 V2+/T1+，插入到 C1 之上（动态区底部） |
| `remove_track {track_id}` | 删除动态轨；其上片段与绑定字幕级联删除（固定轨拒绝） |
| `move_track {track_id, to_index}` | 动态区内换位（结构性操作，锁定轨也允许） |
| `set_track_flags {track_id, locked?, hidden?, muted?, solo?}` | 部分覆盖；`hidden` 仅视频/文本，`muted`/`solo` 仅视频/音频 |

- **轨道锁定**：保护片段内容——锁定轨上的片段操作与投放/删除被拒（`TIMELINE_LOCKED`）；解锁与换位不受限。
- **AI 白名单边界**：AI Patch 禁用全部轨道结构操作。

### 1.3 桌面端时间线交互（对齐剪映细节）

- **轨道属性头**：`[类型标识 V2/T1/A1] [锁定] [隐藏(视频/文本)] [静音(视频/音频)] [独奏(视频/音频)]`；空轨仅显示类型标识，拖入素材后按需展示开关；悬停动态轨头部显示 `↑ ↓ 删除`。
- **行高与滚动**：默认轨道行高固定 56px（显示设置滑杆可调 40–96px），不随窗口挤压；轨道溢出时区域纵向滚动。标尺高度 20px。
- **滚轮策略**：`Ctrl+滚轮` 以光标为锚缩放；普通滚轮纵向滚动（纵向未溢出时横向平移）；`Shift` / 触摸板横向滑动横向平移。
- **拖拽与播放头**：单片段拖动时本体实时跟随鼠标并按目标轨钳制不重叠；组移动保留半透明 ghost；鼠标在空白位置按住即可拖动播放头，`Shift+拖拽` 保留框选。
- **波形与缩略图**：音频波形占比三档（100%/60%/30%）持久化至 `vortex-cut.timeline.prefs.v1`；视频缩略图优先走素材级 Filmstrip Sprite（见 [`preview-and-rendering.md`](preview-and-rendering.md) §3）。
- **工作区与轨道视觉基线**：编辑工作区采用左栏素材库纵贯全高、右列垂直堆叠「预览 + 属性」与时间线的双栏布局；轨头列底色 `--bg-panel`、轨头行 `--tl-row`（选中 `--tl-lane-on`）与画布泳道带同步保持 2px 缝隙可读；标尺顶部无额外内容范围粗线；片段选中框采用纯描边透明底；缩略图运行时兜底保持 `±400px` 视口余量、同素材 busy 重排队不丢弃，且连续 3 次帧级失败自动降级为 `video` seek 兜底。
- **进行中对齐计划**：完整视觉/交互/功能/性能对齐详见 [`../plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md`](../plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md)。

---

## 2. 转场系统（对齐 B2）

### 2.1 目标与类型冻结

- 时长默认 `0.5s`，范围 `0.1s–2.0s`（`MIN_TRANSITION_US = 100_000`，`MAX_TRANSITION_US = 2_000_000`）。
- 冻结 8 种 FFmpeg `xfade` 类型（扩展仅改 Core 与 Contracts 常量 `TRANSITION_IDS`）：

| id | xfade transition | 对应类别 |
|---|---|---|
| `fade` | fade | 淡入淡出 |
| `fadeblack` | fadeblack | 淡入淡出（经黑） |
| `dissolve` | dissolve | 溶解 |
| `wipeleft` | wipeleft | 擦除 |
| `wiperight` | wiperight | 擦除 |
| `slideleft` | slideleft | 滑动 |
| `slideup` | slideup | 滑动 |
| `zoomin` | zoomin | 缩放 |

### 2.2 数据模型与借用式时间语义

- `TimelineDocument` 新增可选顶层键 `transitions: [{ transition_id, after_clip_id, kind, duration_us }]`（`transitions.length ≤ 50`；`after_clip_id` 唯一）。
- **借用语义**：文档中两相邻片段的 `timeline_start_us` / `timeline_end_us` 保持连续，渲染时对前片段尾部 `T_us` 与后片段头部 `T_us` 做 `xfade` / `acrossfade` 交叉混合，成片总时长相应缩短 `Σ T_us`。
- **同轨邻接与休眠态**：随着全视觉轨合成升级（见 [`preview-and-rendering.md`](preview-and-rendering.md) §1），转场支持**同轨内**相邻视频/图片片段（不扩展跨轨）；若片段被移开产生空隙，转场进入**休眠态**（保留在文档中但 UI 不渲染标记、渲染图跳过），重新贴齐后恢复；失去后继时由 `_gc_unreachable_transitions` 清理。
- **与变速联动**：转场作用于时间线区间 `T_us`，渲染前按 `时间线 → 源` 映射回各自源区间（除以速度）。
- **渲染与已知近似**：`ffmpeg` 链式 `xfade`/`acrossfade` 计算 `offset_i = 前 i+1 段终点 − i × T`；ASS 字幕按时间线绝对时间生成，转场区间内存在 ≤2s 相对偏移（UI 常驻提示）；交互预览不实时混叠，仅切换并在浮层提示“转场仅权威预览生效”。

### 2.3 操作与错误码

- `add_transition` / `update_transition` / `remove_transition` 全部进入 `PATCH_OPERATIONS` 与 `AI_PATCH_OPERATIONS`。
- `remove_clip` 级联删除前后关联转场；`split_clip` 若拆分点落入尾部转场区间内拒绝；涉及任一锁定片段即拒绝。
- 错误码：`TIMELINE_TRANSITION_EXISTS`、`TIMELINE_TRANSITION_INVALID`。

---

## 3. 关键帧动画（对齐 B3）

### 3.1 数据模型与插值规则

- `TimelineClip` 可选键 `keyframes`，覆盖全部四种属性：`position`（相对画布中心比率 `x/y`）、`scale`（`0.1–5.0`）、`rotate`（`-180..180` 度）、`opacity`（`0–1`）。
- 每属性独立时间轴，最多 `32` 帧，`t_us` ∈ `[0, 片段时间线时长]` 升序唯一，≥2 帧产生动画。
- **线性插值（冻结）**：`v(t) = v0 + (v1 − v0) × (t − t0) / (t1 − t0)`；窗口外取首/末边界值；`rotate` 不做角度回绕。

### 3.2 操作与特性联动

- `set_clip_keyframes { op, clip_id, property, frames }` 与 `clear_clip_keyframes { op, clip_id, property }`（幂等整属性覆盖，均进入 `AI_PATCH_OPERATIONS`）。
- **联动规则**：`set_speed` / `set_image_duration` 改变片段时长时按比例重映射 `t_us`；`split_clip` 按拆分点切分归两侧并克隆边界帧；`trim_clip` 下保持时间线语义不变；`reverse_playback` 时渲染先反转再应用属性动画；先布局后动画变换。
- **渲染**：Core 编译嵌套 `if(lt(t,t1), lerp, ...)` 表达式接入 FFmpeg 滤镜链，全视觉轨开放（历史局限见 [`preview-and-rendering.md`](preview-and-rendering.md) §2.3）。交互预览通过属性面板插值刷新数值与时间线色点，浮层提示“动画仅权威预览生效”。

---

## 4. 字幕、气泡花字与多字体（对齐 B4）

### 4.1 `style_override` 模型与操作

- 沿用 `C1` 轨道 `TimelineCaption` 实体，不新建第二类文字对象；增加可选部分覆盖 `style_override`：
  - 基础字段：`font_name`、`font_size`（`24–144`，PlayRes `1080×1920`）、`primary_color` / `outline_color`（ASS `&Haabbggrr`）、`outline`（`0–10`）、`alignment`（`2|5|8`）、`margin_v`（`0–600`）、`pos_x` / `pos_y`（`0–1` 比率覆盖 alignment）。
  - 气泡与花字字段：`border_style`（`1` 描边+阴影 / `3` 气泡底衬）、`back_color`（ASS `&Haabbggrr`）、`shadow`（`0–10`）、`fx_preset`（`"none" | "gold-gradient" | "neon-glow" | "sticker-outline" | "soft-shadow"`）。
- **互斥规则**：`fx_preset` 与基础颜色并存时花字模板后置覆盖颜色，UI 禁用基础色控件。
- **Patch 操作**：`set_caption_style { op, caption_id, style }`、`clear_caption_style { op, caption_id }`；C1 片段端点 8px 手柄拖拽时长提交 `set_caption_timing`（≥200ms、同轨不重叠）。

### 4.2 ASS 渲染与多字体包设计

- **ASS 生成**：`build_ass` / `build_rendition_ass` 将校验后的样式标签拼在 `escape_ass_text` 正文之前，杜绝 ASS 标签注入；`border_style=3` 生成确定性派生 Style 行 `{preset_id}__b3`。
- **多字体包（`resources/fonts/bundle.json` v2）**：
  - 内置注册字体：**思源黑体 Noto Sans CJK SC**（`default`）、**思源宋体 Noto Serif CJK SC**（`extra`，OFL）、**霞鹜文楷 LXGW WenKai**（`extra`，OFL）。
  - `libass` 通过 `fontsdir` 自动加载；`_validate_caption_style.font_name` 仅放行注册表内 `family`，防止导出静默回退；Core 提供 `GET /api/v1/caption-fonts`；Desktop Main IPC `media:caption-font-urls` 供 `SyntheticPreview` 通过 `FontFace(family)` 注册与 `compositor` 渲染。
- **明确不做**：矢量气泡尾巴、自由花字参数、字幕动画（Tab 维持 `soon`）、用户自装系统字体或在线字体下载。

---

## 5. 剪辑语法与剪辑手法（Wave 1）

### 5.1 W0.3 声画链接模型（Clip Linkage）

- `TimelineClip` 可选字段 `link_group_id?: string`（缺省不序列化，`PROTOCOL_VERSION` 不变）。
- `detach_audio` 派生 `A1` 音频段并对齐画面起点，同时设原视频 `audio.enabled = false`；`insert_asset_clip(link_to_clip_id)` / `set_clip_link` / `clear_clip_link` 维护链接组。
- 默认整组联动（传 `ignore_link: true` 可绕过）：`remove_clip`、`position_clip`、`trim_clip`（同源且同属 video/audio）、`move_clip`。
- `detach_audio` / `set_clip_link` / `clear_clip_link` 不进入 `AI_PATCH_OPERATIONS`。

### 5.2 W1.1 剪辑语法层骨架（`editing_grammar`）

- `services/core/src/aivs_core/editing_grammar/`：
  - `protocol.py`：纯函数 `Planner` 协议 `plan(document, params, context) -> PlanResult`。
  - `registry.py`：统一规划器注册表与工具描述目录（`GET .../editing-grammar/planners`）。
  - `service.py`：零网络三段式 `prepare`（干跑）→ `propose`（落盘 `editing_grammar_proposals`）→ `apply`（写入 `editing_grammar_applications` 与不可变 Revision，迁移 v24）。
- **确定性与隐私不变量**：同输入多次 `plan()` 产出逐字节相同；全程零网络（不建假 consent）；`apply` 设 `ai=False`；空操作集可 `propose` 标记 `noop`，`apply` 拒绝产生空 Revision；内置参考规划器 `drop_short_clips`。

### 5.3 三大剪辑手法规划器（W1.2–W1.5）

1. **节拍网格分析（W1.2 `beat_grid`）**：
   - `media/beat_grid.py` 纯 `numpy` 实现（不引入 `scipy`/`librosa`）：22050Hz mono PCM → STFT（`n_fft=1024, hop=512`）→ 谱通量 onset envelope → 自相关估速（BPM 60–200）→ 峰值拾取；v1 `downbeats_us = beats_us[phase::4]`（4/4 假设）。
   - 迁移 v26 `beat_grids`（按 `algorithm_version` 行化 + `fingerprint` 判 stale）；无音轨/过短返回 `status='unavailable'`。
   - 验收：合成 120 BPM click 相对误差 ≤ 2%、中位偏差 ≤ 40ms，目标耗时 < 2s/分钟源。
2. **卡点规划器（W1.3 `beat_sync`）**：
   - `slot_j` 占 `beats[j*N : (j+1)*N]`（默认 `N=2`）；镜头重度评分 `score = 3*min(face, 3) + 2*min(motion, 1) + 1*min(sharpness, 1)`，降序优先填强拍槽；超槽截断、不足循环复用并标注 `reused`。`bgm_asset_id` 仅作 provenance。
3. **L-cut / J-cut（W1.4 `split_edit` + `lj_cut`）**：
   - 原子操作 `split_edit { op, clip_id, source_time_us, audio_delta_us }`（已进入 `AI_PATCH_OPERATIONS` 与 Schema 三处同步）：画面在 `source_time_us` 拆分，音频在 `source_time_us + audio_delta_us` 拆分（J-cut < 0、L-cut > 0）；若含内嵌音频则派生 `A1` 并置视频 `audio.enabled = false`。
   - `lj_cut` 依赖 ASR 词表（`transcript_words`）与默认 300–500ms（默认 400ms）偏移窗；无词表返回 `EDITING_GRAMMAR_NO_WORDS`。
4. **跳切 / 去停顿（W1.5 `remove_pauses`）**：
   - 基于 `cv_samples.audio_energy`（或 `silence_intervals_us`），连续 `audio_energy ≤ threshold`（默认 `0.05`）且持续 ≥ `min_silence_us` 的区间两端退让 `pad_us`；短于 `MIN_VIDEO_US` 的保留段合并；无音轨/全零返回 `EDITING_GRAMMAR_NO_SPEECH`。
   - 按源时间降序 `split_clip` → 按 `clip_id` 字典序 `remove_clip` → `position_clip` 顺接消除空隙。

### 5.4 Wave 1 L3 真机手测清单

> 自动化验证见 `apps/desktop/e2e/wave1-editing-tools.electron.spec.ts`；人工听感/审美签字项见 [`../BACKLOG.md`](../BACKLOG.md#wave1-l3)。

- **A. 去停顿（`remove_pauses`）**：参数默认 `0.05 / 400ms / 50ms` 时间轴实时变化；已分析出摘要、未分析明确提示引导；采纳后闭合无停顿段；空操作禁用采纳。
- **B. 卡点（`beat_sync`）**：未分析显示「分析节拍」按钮 → 轮询就绪（BPM / 拍数）→ 干跑采纳后切点落节拍（听感对拍）；无音轨显示「无法检出节拍」且可重试；素材变更显示需重分析。
- **C. L/J Cut（`lj_cut`）**：已转录显示「ASR 词级转录 ✓」；未转录引导先转录；自动/手动 J（提前 300–500ms 入声）/L（延后）预览听感正确。
- **D. 通用**：外部修改时间线触发基线漂移提示并禁用采纳；已采纳提案不可重复采纳；全程零 egress。

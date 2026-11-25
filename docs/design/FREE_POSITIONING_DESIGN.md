# M2 — V1 轨道自由定位（自由拖动）设计说明

状态：已实现（随本文档一同落地的代码与测试见文末清单）
关联：`requirements/PRODUCT_ROADMAP.md` A1（多轨道渲染）的前置子集；对齐剪映"覆盖轨自由定位"与 OpenCut 的轨道内自由拖动体验。

## 1. 目标与决策

- **目标形态**：V1 视频/图片轨道内的自由定位——片段可拖到任意时间位置，允许留空隙（OpenCut 式）。
- **重叠策略**：同轨禁止重叠。前端拖动时钳制到最近空隙（与邻居贴齐），core 兜底拒绝（`TIMELINE_INVALID`）。
- **不采用**：主轨磁吸（删除/缩短自动合拢）、双模式切换。多覆盖轨（剪映式画中画）留给 M2 A1 多轨道工作。

## 2. 数据模型语义变化

| 语义 | 旧模型（磁吸序列） | 新模型（自由定位） |
| --- | --- | --- |
| V1 `timeline_start_us` | 派生值（每次 patch 后从 0 重排） | **权威数据**，`_normalize_timing` 不再重排 |
| 空隙 | 不允许 | 允许；总时长 = 所有片段最大 `timeline_end_us` |
| 同轨重叠 | 不可能出现 | 校验层禁止（`_validate_document` 逐对检查） |
| `position_clip` | 仅 A1 | **V1 + A1**；V1 拒绝重叠；V1 移动时绑定字幕随片段平移 |
| `move_clip` | 重排列表并重新压平 | 仅改列表顺序/编号，**不再影响时间位置** |
| `trim_clip`（视频） | 只改源区间，靠重排回零 | 显式落位：左缘随内容右移、右缘收缩；绑定字幕钳制进新窗口 |
| `split_clip` | 依赖重排 | 显式落位（左段止于拆分点，右段从拆分点起） |
| `insert_asset_clip` | 插入列表后重排 | 落到时间槽 `at_index`（时间序第 k 个 V1 片段的起点）或内容末尾，冲突片段**涟漪右推** |
| `set_speed`/`set_image_duration` | 变长靠重排顺延 | 变长时对后续片段**涟漪右推**；变短留空隙 |
| `remove_clip` | 重排自动合拢 | 留空隙；转场级联按时间序后继计算 |

**涟漪右推**（`_ripple_v1_right`）：从变更片段的新终点向右扫描，把撞上屏障的片段依次推到屏障处（级联），保持相对顺序与既有空隙；被推移片段绑定的字幕同步平移。

## 3. 转场语义（M2 B2 的扩展）

- 添加/更新转场要求锚点与其**时间序**后继**首尾相接**（`_transition_neighbors`）；
- `_transition_successor` 由列表序改为时间序（按 `timeline_start_us` 排序）；
- 片段被移开后，跨空隙的转场进入**休眠**：文档保留、校验通过、UI 不渲染标记、渲染图跳过；片段重新贴齐后自动恢复；
- 时间序中失去后继的转场由 `_gc_unreachable_transitions` 清理（避免移动/删除片段导致文档卡死）；
- UI：`computeTransitionRects` / `hitTestTransitionGap` 只对首尾相接的片段对生效。

## 4. 渲染装配（ffmpeg 图）

`build_timeline_args` 重写为按**时间位置**装配：

1. 只消费视觉段（`asset_kind != "audio"`；audio 段没有视频流，旧实现会让整图失败；A1 混音为后续工作）；
2. 按 `timeline_start_us` 排序（列表顺序不再等于时间序）；
3. 相邻段之间的空隙（含首段前的引导空隙）插入 **lavfi 黑底填充段**，保证 concat 图输出长度 = 时间线总长；
4. 转场只对首尾相接的相邻对生效（休眠转场跳过）；
5. 合并方式从"仅支持从首对开始的转场链"改为**从左到右逐项合并**（普通相邻项 concat、锚点项与后继 xfade + acrossfade），修复了旧实现中"首个转场锚点不在第一个片段对"时图断裂的问题；
6. `_rendered_duration_us`（service.py）= max(end) − 生效转场总和，与图内累积一致。

## 5. 前端交互（apps/desktop）

- **单片段拖动（V1）**：吸附（边缘/播放头/网格）后经 `clampV1MoveStart` 钳制到最近合法位置；ghost 直接跟随目标位置；提交 `position_clip`（不再提交 `move_clip`）；
- **多选组移动（V1）**：刚体平移，`clampV1GroupDelta` 对"成员×障碍"冲突区间做最近可行钳制（贴齐边界算合法）；A1 组仍为自由平移；提交逐片段 `position_clip`；
- **工具栏 向前/向后移动**：语义从"重排顺序"改为"逐帧微调"（±1 帧，含钳制），无可行移动时禁用；
- **geometry 清理**：删除 `packV1Clips` / `computeV1TargetIndex` / `v1ReorderToMixedIndex` / `computeV1GroupTargetIndex` / `computeV1GroupReorder`；`clipDuration` 改为时间轴跨度（修正变速片段宽度显示）；
- **总时长**：`duration()`（App.tsx / TimelineCanvas）取所有片段最大终点；
- 交互预览本就按绝对时间映射（`playhead ∈ [start, end)`），空隙处显示黑帧，无需改动。

## 6. 兼容性说明

- 连续（无空隙）时间线上，涟漪插入/拆分/裁剪的落位结果与旧"重排压平"一致——Stage 5/6R 装配流程与既有文档无需迁移；
- `move_clip` op 保留（列表重排语义），UI 不再使用；
- contracts 的 `TimelinePatchOperation` 无类型变化（`position_clip` 本就是通用形状）。

## 7. 已知限制与后续工作

- **A1 音频混音**：渲染图暂不包含 A1 片段的音频（此前为整图失败，现显式跳过）；需在 M2 A1 多轨道工作中引入 amix/adelay 混音；
- **休眠转场**在 UI 上完全不可见（不显示"存在但休眠"的提示），后续可加弱化标记；
- 多选跨轨（V1+A1 混合）移动暂不支持（保持原有的同轨约束）；
- 拖动自动滚动期间 ghost 可能短暂显示未钳制位置（下一次 mousemove 修正）。

## 8. 测试清单

- core：`services/core/tests/unit/test_timeline.py`（position_clip V1 自由定位/重叠拒绝/贴齐允许、normalize 语义、trim/split/insert/set_speed 落位）、`test_render_ass_ffmpeg_stage1c.py`（空隙黑底填充、引导空隙、休眠转场、audio 段跳过、时长语义）、`test_shot_requirement_timeline_batch_assembly.py`（批量插入涟漪）；
- core 集成：`test_stage1c_timeline_api.py`、`test_stage2b_timeline_patch_api.py`、`test_stage5_timeline_assembly_api.py`、`test_stage6r_timeline_batch_assembly_api.py`、真实渲染 `*_real.py`；
- desktop：`tests/timeline-geometry.test.ts`（钳制函数、ghost、转场几何）、`tests/timeline-panel-interactions.test.tsx`、e2e `m5-timeline-interaction.electron.spec.ts`（自由定位贴齐钳制）。

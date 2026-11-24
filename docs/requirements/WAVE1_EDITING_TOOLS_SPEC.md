# Wave 1 剪辑语法与剪辑手法需求规格

> 本文合并原 W0.3 声画链接、W1.1 剪辑语法层骨架、W1.2 节拍网格、W1.3 卡点规划器、W1.4 L/J Cut 与 W1.5 跳切/去停顿六份规划门；当前交付状态与剩余跟踪项统一见 [`../STATUS.md`](../STATUS.md)。
> 关联决策：[`ADR-0004`](../design/adr/0004-ai-capability-master-plan-decisions.md)；桌面真机手测清单见 [`WAVE1_MANUAL_CHECKLIST_2026-10-10.md`](WAVE1_MANUAL_CHECKLIST_2026-10-10.md)；自动化取证见 [`WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md`](../archive/WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md)。

---

## 1. W0.3 声画链接模型（Clip Linkage）

- **数据模型**：`TimelineClip` 增量可选字段 `link_group_id?: string`（缺省时不序列化该键，保证旧文档字节与 SHA-256 不变；`PROTOCOL_VERSION` 不变）。
- **组建立与解除**：
  - `detach_audio`：从视频 clip 派生 A1 音频 clip（对齐画面 `timeline_start_us`，不再强制落 A1 轨尾），默认同入一个新链接组，并将原视频 clip 设为 `audio.enabled = false`。
  - `insert_asset_clip` 可选 `link_to_clip_id`；`set_clip_link` 将 ≥2 个 clip 并入同一新组；`clear_clip_link` 解散目标所在整组。
- **默认联动规则**（传 `ignore_link: true` 可单次绕过）：
  - `remove_clip`：删除整组成员（含级联字幕/转场）；
  - `position_clip`：全组同 delta 平移；
  - `trim_clip`：全组同 `source_*` 收缩（成员须同 `asset_id` 且属 `video`/`audio`，否则整体拒绝）；
  - `move_clip`：全组保持相对次序移动。
- **AI 准入边界**：`detach_audio` / `set_clip_link` / `clear_clip_link` 属结构操作，**不进入** `AI_PATCH_OPERATIONS`。

---

## 2. W1.1 剪辑语法层骨架（`editing_grammar`）

- **模块边界**（`services/core/src/aivs_core/editing_grammar/`）：
  - `protocol.py`：纯函数 `Planner` 协议 `plan(document, params, context) -> PlanResult`（`operations` + `summary` + `rationale`）。
  - `registry.py`：统一规划器注册表与工具描述目录（`{name, title, description, parameters_schema, preconditions}`），供 `GET .../editing-grammar/planners` 与未来暴露层复用。
  - `service.py`：零网络三段式 `prepare`（干跑校验）→ `propose`（落盘 `editing_grammar_proposals`）→ `apply`（经 `TimelineService.apply_in_memory` + `create_revision_from_document` 写入 `editing_grammar_applications` 与不可变 Revision，迁移 v24）。
- **确定性与隐私不变量**：同输入多次 `plan()` 产出逐字节相同（显式排序键）；全程零网络调用（不建假 consent）；`apply` 的 `ai=False`；空删除集可 `prepare/propose` 标记 `noop`，`apply` 拒绝空操作避免空 Revision；参考实现 `drop_short_clips`（删除短于 `min_duration_us` 的片段）。

---

## 3. W1.2 节拍网格分析（`beat_grid`）

- **算法与依赖**：`media/beat_grid.py` 采用纯 `numpy` 实现（不引入 `scipy`/`librosa`）——22050Hz mono PCM → STFT（`n_fft=1024, hop=512`）→ 谱通量 onset envelope → 自相关估速（BPM 60–200）→ 相位对齐与峰值拾取；v1 `downbeats_us = beats_us[phase::4]`（4/4 假设，需明确告知下游）。
- **持久化与服务**：迁移 v26 表 `beat_grids`（按 `algorithm_version` 行化 + `fingerprint` 判 stale）；`BeatGridService` 作为独立 `job_kind` 调度，无音轨或过短返回 `status='unavailable'` 不抛异常；性能门目标 < 2s/分钟源。
- **验收口径**：合成 120 BPM click 的 BPM 相对误差 ≤ 2%、beats 命中偏差中位 ≤ 40ms，同 PCM 两次结果逐点一致。

---

## 4. W1.3 卡点规划器（`beat_sync`）

- **输入**：`segments[]`（源区间 + `face` / `motion` / `sharpness`）、`beats_us` / `downbeats_us`、`target_duration_us`、`beats_per_shot`（N，默认 2）、`bgm_asset_id`（仅作 provenance，不自动插入 BGM 轨、不改 LLM prepare 契约）。
- **槽位与分配规则**：
  - `slot_j` 占 `beats[j*N : (j+1)*N]`；强拍槽为 `downbeat` 落在槽起点 beat 的槽位；
  - 镜头重度评分公式：`score = 3*min(face, 3) + 2*min(motion, 1) + 1*min(sharpness, 1)`，降序优先填强拍槽，其余按序填弱拍槽；
  - 段数 > 槽数时截断；段数 < 槽数时循环复用并标记 `reused`，全部记录在 `rationale`。
- **验收口径**：全部镜头起止与 beat 对齐（容差 1ms），重段落在 downbeat 槽，确定性且零 egress。

---

## 5. W1.4 L-cut / J-cut（`split_edit` 与 `lj_cut`）

- **原子操作 `split_edit`**：`{op, clip_id, source_time_us, audio_delta_us}`。画面在 `source_time_us` 拆分，音频切点为 `source_time_us + audio_delta_us`（J-cut 为负，L-cut 为正）。若视频含内嵌音频则派生 A1 音频段并强制设两端视频 `audio.enabled = false`（杜绝双声）；画面与音频段均不得越出源区间且画面不得 < `MIN_VIDEO_US`。
- **AI 准入**：`split_edit` 已准入 `AI_PATCH_OPERATIONS`、`TIMELINE_PATCH_OPERATIONS_SCHEMA` 与 `_PATCH_FIELDS`（三处同步）。
- **规划器 `lj_cut`**：结合 ASR 词表（`transcript_words`）与默认偏移窗 300–500ms（默认 400ms）生成 `split_edit`；无词表返回 `EDITING_GRAMMAR_NO_WORDS`（拒绝而非瞎猜）。

---

## 6. W1.5 跳切 / 去停顿（`remove_pauses`）

- **静音判定**：基于 `cv_samples.audio_energy`（或显式 `silence_intervals_us`），连续满足 `audio_energy ≤ threshold`（默认 `0.05`）且持续 ≥ `min_silence_us` 的区间，两端各退让 `pad_us`；收缩后若保留段 < `MIN_VIDEO_US` 则与相邻保留段合并。
- **空轨/全静音保护**：无音轨或全零能量返回 `EDITING_GRAMMAR_NO_SPEECH`（拒绝裁剪，避免把无声视频剪空）。
- **操作序列**：按源时间**降序** `split_clip` → 按 `clip_id` 字典序 `remove_clip` 静音段 → `position_clip` 顺接保留段消除空隙；A1 联动依赖 W0.3 链接组，v1 不包含口癖词语义裁剪。

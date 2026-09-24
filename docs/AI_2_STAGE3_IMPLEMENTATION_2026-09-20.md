# AI-2 Layer 0 CV 信号层（阶段三：召回汇合）——实施记录

> 实施：ZhangSan（Core），2026-09-20。承接阶段一/二实施记录。**Layer 0 至此闭环**：
> 无语音素材（孩子跑、宠物、风景）对 AI 粗剪可见——ADR-0003 D3 的原始缺口关闭。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 召回来源 | `prepare` 增 `candidate_source`（auto/transcript/cv；缺省 auto——旧客户端不传走纯转录，行为与旧图逐字节一致）。auto = 有可用转录用之，否则 CV 场景段 |
| CV 召回 | `_cv_scenes`：项目全部可用视频素材的 ready 分析 → 场景切点合并为 ≥2s 场景段 → 排序（含人脸 > 运动 > 清晰度 > 序，规划门 §5 首版权重）→ 上限 160 |
| 载荷 | 转录段与 CV 场景段统一为 provider 可见段列表（CV 段 `text=""`、带 `cv_features{face,motion,sharpness}`）；`sent_fields` 增量登记 `segments.cv_features`（本地计算零 egress，字段清单如实） |
| 白名单 | 条目带 `source`（transcript/cv）；CV 条目携带生成时钉死的场景范围与特征快照（哈希链保护） |
| 校验 | `_validated_candidates` 双路解析：CV 剪辑同素材校验（放宽裁决见验证报告）；转录路径不变 |
| adopt | 双路建剪辑：CV clip 无转录依赖（asset 可用 + 指纹内时长兜底校验），`caption_policy=auto_from_transcript` 时 CV clip 不生成字幕，`provenance.source_transcript_ids` 不含 CV 素材 |
| Desktop | IPC `planning:prepare` 透传可选 `candidate_source`（preload/MAIN；UI 面板后续小单） |

## 1. 关键裁决

- **CV 场景段的"身份"**：白名单条目直接携带场景范围与特征快照（preview 时钉死进哈希链），`_validated_candidates`/`adopt` 只校验 asset 可用性与时长兜底——不回查 `cv_analyses` 表行（合成 scene_id 非表行 id，且召回后素材再分析不影响本次候选语义）。
- **~~CV 剪辑不跨段拼接~~（已被真实 provider 验证推翻）**：deepseek 自然行为即跨场景取段，粗剪语义本就如此——放宽为同素材校验（2026-09-20，见验证报告）。
- **auto 的回退语义**：`transcript_ids=[]` + auto → CV；显式 `source=transcript` + 空选择 → 校验拒绝（`PLANNING_INVALID`）；CV 无 ready 分析 → `PLANNING_NO_SEGMENTS`（提示先做视频分析）。
- **隐私**：CV 特征为本地计算，无 egress 增量；`sent_fields` 如实登记新字段。

## 2. 验证

- 单测 5 项（`test_planning_cv_recall.py`）：CV-only prepare（场景段/空 text/特征/sent_fields）、无 ready 分析报错、auto 无转录回退 CV、显式 transcript 拒绝空选择、**端到端**（prepare → mock provider 三候选 → run_generation → adopt → Revision 无字幕、剪辑来自 asset、provenance 空）。
- 过程抓到并修复三个实现缺陷：CV 段 rows 键不一致（ref vs segment_id）、白名单缺范围快照、pydantic `model_dump` 带缺省 None 导致旧形状请求被键校验拒绝（8 个既有集成测试暴露）。
- Core 全量 **868 passed + 2 skipped**；Desktop **668 passed**；typecheck 干净。

## 3. Layer 0 全链小结（阶段一/二/三）

```
导入素材 → cv_analysis job（关键帧采样 → 场景/运动/清晰度/亮度/音频能量
          → [阶段二] YuNet 人脸）→ cv_analyses/cv_samples
                                          ↓
AI 粗剪 prepare(candidate_source=auto) → 无转录 → _cv_scenes 排序召回
          → provider 三候选 → adopt → 时间线（无语音素材可剪）
```

- 阶段一（2b3558b）：信号引擎与存储；阶段二（ea1d8e6）：YuNet 人脸；阶段三（本单）：召回汇合。
- ~~性能门（p95 ≤ 10s/分钟源）与采样密度校准仍为待办——需真实素材测量，随 UI 面单独立工作单。~~
  **【2026-09-24 修正】两者均已落地**：采样密度经 `CV_SKIP_FRAME_PLANNING_GATE_2026-09-20`
  裁决为 **skip_frame 混合自适应**（commit `a349866`，算法版本 1→2）；性能门 **1080p 档已达标**
  （完整作业 dance 4.3 / science 7.6 / lichun 3.4 s/分）。
  **残留**：4K60 档从未标定；采样密度"可配"入口未做。详见
  `AI_2_SKIP_FRAME_IMPLEMENTATION_2026-09-24.md` §4，当前状态见 [`docs/STATUS.md`](STATUS.md)。
- ~~剩余后续：Desktop UI（CV 分析入口 + AI 粗剪的来源选择）、MCP 适配层、AI-1 Desktop 面板。~~
  **【2026-09-24 修正】四项中两项已交付**：**CV 分析入口** ✅ 已交付
  （IPC `cv-analysis:get`；验收 DESK-4 ✅）；**AI-1 Desktop 面板** ✅ 已交付
  （`AgentSessionPanel.tsx`；验收 DESK-5 ✅）。**仍未做**：AI 粗剪来源选择 UI、
  MCP 适配层——两者均已在 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` 立项
  （W4.2 / W4.3），**规划状态不在本文声明**。

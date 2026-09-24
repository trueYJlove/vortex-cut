# AI-2 Layer 0 CV 信号层（阶段一：信号引擎与存储）——实施记录

> 实施：ZhangSan（Core），2026-09-20。承接 `AI_2_CV_SIGNALS_PLANNING_GATE_2026-09-20.md`
> 阶段一（AI-2-1）。阶段二（YuNet ONNX 人脸）与阶段三（召回汇合）为后续单。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 迁移 v21 | `cv_analyses`（主行：UNIQUE(asset_id, algorithm_version)，状态 queued/running/ready/stale/failed）+ `cv_samples`（明细：timestamp 网格 + 信号列，face_* 两列阶段二回填恒 NULL） |
| 引擎 | `media/cv_signals.py`：信号纯函数（直方图卡方距离/差分能量/拉普拉斯方差/亮度，纯 numpy）+ 流式采集（FFmpeg 关键帧采样灰度缩略帧 rawvideo stdout + showinfo stderr 时间戳解析；音频 astats 窗口 RMS）+ `CvSignalService`（登记/执行/查询/stale） |
| jobs | 新 kind `cv_analysis`（light×1 优先级 3——当前项目级；`jobs.py _run_media` 分发） |
| 端点 | `POST /api/v1/projects/{pid}/assets/{aid}/cv-analysis`（require_ui，generate=true 懒生成；仅 video 素材；无 internal media 端点——产物为 JSON 表行无二进制） |
| 契约 | `JobKind += "cv_analysis"` |

## 1. 核心语义（对规划门的落实）

- ~~**关键帧采样**：`select='eq(pict_type,I)+gte(t-prev_selected_t,1.0)'`——I 帧或距上个输出帧 ≥1s（长 GOP 素材的采样密度下限兜底）；4K60 只解 I 帧，解码成本与 GOP 数线性。~~
  **【2026-09-24 修正】已改为双路径混合自适应**（`CV_SKIP_FRAME_PLANNING_GATE_2026-09-20`，commit `a349866`）：默认快路径 `-skip_frame nokey` + 纯 `eq(pict_type,I)`；采样点最大间隔 > 4s 判定长 GOP 素材 → **全量解码回退**（恢复 ≥1s 兜底）。上述 select 表达式现仅用于**回退路径**。详见 `AI_2_SKIP_FRAME_IMPLEMENTATION_2026-09-24.md`。
- **存储不走 derived_media_cache**（规划门 §2 裁决）：cv_analyses/cv_samples 独立表，stale 判定复用 transcripts 指纹比对先例；召回层入口 `samples_for_range(asset, start, end)`。
- **单版本单行**：重分析 = 旧行 `ON CONFLICT DO UPDATE` 原地重置（复用行、清明细、重置指纹），不插新行——UNIQUE(asset_id, algorithm_version) 约束的推论。
- ~~**algorithm_version 即信号集版本**：当前 1；调阈值/加信号须递增（新行不与旧条目互撞）。~~
  **【2026-09-24 修正】当前为 `2`**（`cv_signals.py`）：`a349866` 因采样策略变化而递增（信号语义变化——运动能量粒度随路径不同）。递增语义本身不变：调阈值/加信号仍须递增，旧行标 stale 不重算。当前值见 [`STATUS.md`](STATUS.md) §1。
- **隐私（ADR-0003 D4）**：全程本地计算零 egress 零 consent；唯一外部交互是 FFmpeg 子进程读本地文件。
- **音频能量自包含**：同 job 内独立 astats 遍历（不复用懒生成的 waveform 缓存——不保证存在）；无音轨跳过恒 0。

## 2. 验证

- 单测 15 项：纯函数（首帧零运动/均匀序列无切点/突变检出/纹理-平坦 sharpness 序/亮度均值）、stderr 解析（showinfo pts 提取、astats RMS 钳制与 -inf 处理）、参数组装白名单、v21 表约束（UNIQUE/版本 ≥1/信号列 CHECK）、登记幂等与 stale 让位、stat 漂移拒执行、区间查询与 summary。
- 真渲染集成 2 项（bundled ffmpeg，mpeg4 编码——打包 ffmpeg 无 libx264）：合成两场景视频（灰场 1.5s + 亮场 1.5s，GOP 15）→ scene_cut 检出 + 亮度前暗后亮 + 时间戳单调；坏文件 → 行落 failed 不冒充 ready。
- Core 全量 **857 passed + 2 skipped**；Desktop **668 passed**；typecheck 干净。
- 迁移断言面：13 处"最新版本 = v20"随 v21 更新（同 v20 当时的模式，含 stage4d prototype 冻结集排除）。

## 3. 开放边界（阶段二/三）

> **【2026-09-24 修正】本节的"后续单"已全部交付，原文保留作历史记录。**
> 当前状态见 [`STATUS.md`](STATUS.md)。

- ~~阶段二（AI-2-2）：模型注册表放开 provider 枚举 + `models/cv` 目录分层；YuNet ONNX 人脸检测回填 face_count/face_score；模型未就绪时 partial 语义。~~
  **✅ 已交付**（`AI_2_STAGE2_IMPLEMENTATION_2026-09-20.md`，commit `ea1d8e6`）。
- ~~阶段三（AI-2-3）：`planning.py` 召回汇合——segments 查询处聚合 CV 特征、`_select` 排序键融合、`candidate_source` 扩展（无转录素材 CV 场景段召回——本单最终目标）。~~
  **✅ 已交付**（`AI_2_STAGE3_IMPLEMENTATION_2026-09-20.md`；`_cv_scenes`）。**Layer 0 至此闭环。**
- ~~性能门（p95 ≤ 10s/分钟源，1080p30 与 4K60 两档）：需真实素材标定，随阶段三一起做测量工作单。~~
  **✅ 1080p 档已达标**（完整作业 dance 4.3 / science 7.6 / lichun 3.4 s/分）。**残留：4K60 从未标定。**
- ~~采样密度参数校准（GOP 自适应 vs 固定 fps 下限）：当前 1s 下限为初值，阶段三测量后钉死。~~
  **✅ 已裁决并落地**：skip_frame 混合自适应（4s 回退阈值）。**残留：规划门要求的"可配"入口未做。**
  详见 `AI_2_SKIP_FRAME_IMPLEMENTATION_2026-09-24.md` §4。

**计数说明**：§2 的"单测 15 项"是**阶段一交付时点**的计数；`test_cv_signals.py` 现为
19 项（阶段二补入人脸解码/NMS/partial 用例）。引用该计数时注意时点。

# AI-2 本地 CV 信号层（Layer 0）——Planning Gate

> 起草：LiuWei，2026-09-20。承接 ADR-0003（D3 Layer 0：无条件开启的纯本地 CV 信号，
> 解决无语音素材对 AI 召回不可见的缺口；D4：全程零出网）。
> 实施：ZhangSan（Core）。验收：LiuKeAi。分三阶段，每阶段独立验收后进入下一阶段。

## 0. 现状走读结论（2026-09-20 代码级）

- **导入路径无异步分析**：`projects.py` `import_asset` 仅做探测（`media/ffprobe.py`，内存 LRU）与指纹哈希（`background_work.py` 受限线程池）；波形/代理均为消费端懒生成 job，缩略图在 Renderer 侧（`thumbnail-loader.ts`）。
- **job 骨架可照抄**：`KIND_POLICIES`（`job_scheduler.py:61`）注册 → `jobs.py _run` 分发 → runner 以 `WaveformService.run_waveform_job`（stat 校验 → begin_build → 计算 → commit_ready/mark_failed）为模板；取消/进度沿用 `-progress pipe:2` + 0.05s 轮询模式（`media/waveform.py:253`）。
- **存储先例**：`derived_media_cache`（v18）是可 LRU 清理的缓存语义，kind 有 CHECK 白名单——**召回层消费需稳定数据，不宜放可清理缓存**；正确先例是 transcripts 三层结构（主行带 `source_fingerprint` 判 stale，`transcription.py:299`）。
- **依赖现实**：pyproject 仅声明 fastapi/pydantic/uvicorn/faster-whisper/httpx/av；**numpy 2.5 + onnxruntime 1.28 已随 faster-whisper 传递进包且 PyInstaller spec 已 collect_all**——模型无关信号零新增依赖（但 numpy 需升为显式声明，不再依赖传递依赖）。无 cv2/pillow/torch。
- **模型注册表**：`model_registry.py` 受信清单+逐文件 sha256+.ready marker 全链可复用，但 `_validate_manifest`（:558）硬编码 `provider == "faster-whisper"`、`ModelManager.root` 硬编码 `models/asr`（:158）——人脸模型接入需放开。
- **召回汇入点**：`planning.py` `prepare`（:500）的 segments 查询（:536）与 `_select` 排序（:674，关键词命中数 > confidence > start_us，预算 ≤160 段/32000 字符/20min）。**当前召回完全建立在 transcript_segments 之上——无转录素材在召回层不存在，这正是本单要解决的缺口。**

## 1. 范围（三阶段）

### 阶段一 AI-2-1：信号引擎与存储（模型无关）

1. **新 job kind `cv_analysis`**：priority 3、light×1（当前项目级）。runner 挂 `app.py` 装配处，waveform 模板。**v1 全信号基于关键帧采样**（ffmpeg `select=eq(pict_type\,I)`，4K60 也只解码 I 帧，解码成本与 GOP 数线性）。
2. **信号集 v1**（纯 numpy 计算，无模型）：镜头边界（相邻采样帧直方图距离）、运动能量（相邻采样帧差分）、清晰度（拉普拉斯方差，模糊检测）、亮度、场景切点标记。
3. **新表（迁移 v20，附逐版本测试）**：`cv_analyses`（id/asset_id/source_fingerprint/algorithm_version/status/model_revision 可空/created_at，UNIQUE(asset_id, algorithm_version)）+ `cv_samples`（analysis_id/sample_index/timestamp_us/scene_cut/motion_energy/sharpness/brightness，索引 (analysis_id, timestamp_us)）。stale 判定复用 transcripts 指纹比对模式。
4. **音频能量**：同 job 内独立音频通道（astats 窗口），落 `cv_samples.audio_energy`——不复用 waveform 缓存（懒生成不保证存在，自包含优先）。
5. **REST 暴露**：照抄 waveform 两段式——`POST /api/v1/projects/{pid}/assets/{aid}/cv-analysis`（require_ui，generate=true 懒生成，返回 analysis_id/status/job_id/信号集元数据）；无 internal media 端点（产物为 JSON，无二进制消费方）。

### 阶段二 AI-2-2：人脸检测模型接入

6. **模型注册表扩展**：`_validate_manifest` 放开 provider 枚举（新增 onnx + purpose 维度），`ModelManager.root` 按 purpose 分目录（`models/cv`）；`_provider_status` 以 `find_spec("onnxruntime")` 探测。受信下载+哈希校验+.ready marker 全链复用。
7. **人脸信号**：关键帧上跑 ONNX 检测器（候选 YuNet，~350KB/MIT/CPU 实时；模型选型实施时定，约束：manifest 受信源、CPU、≤5MB）。`cv_samples` 增 face_count/face_score 列（迁移并表或 v20 直接带上列、阶段一恒 NULL——**取后者**，免二次迁移）。清单文件进 `resources/model-manifests/`。
8. **job 依赖**：模型未就绪时人脸信号跳过（其余信号正常产出），状态标注 partial；模型下载走既有 `model_download` job。

### 阶段三 AI-2-3：召回汇合（planning.py）

9. **转录召回增强**：`prepare` segments 查询处按 (asset_id, 时间区间) 聚合 CV 特征（均值/峰值/含人脸）挂到 segment dict；`_select` 排序键融合（关键词命中 > 含人脸 > 运动能量 > confidence，权重实施时以测试钉死）。载荷 sent_fields 相应登记（本地计算，无 egress，但字段清单保持如实）。
10. **无转录召回（本单的最终目标）**：`prepare` 请求增 `candidate_source: "auto" | "transcript" | "cv"`（默认 auto：有 ready 转录用之，否则 CV 场景段）。CV 模式下场景切点合并为伪 segment（最小时长 ~2s，text 为空），排序纯按 CV 信号 + duration 适配；`_validated_candidates` 的 0.8–1.2 倍时长约束不变。**契约为增量扩展**（PROTOCOL_VERSION 不动，新可选字段 + 新枚举值）。

### 明确不做（边界）

- **Layer 1/2（本地 VLM、云端关键帧理解）**：ADR-0003 D3 已裁决搁置/后续立项。
- **UI 信号可视化面板**：独立 Desktop 小单。
- **逐帧全量分析 / 光流级运动估计**：v1 关键帧采样已满足召回信号需求；全 fps 属性能优化，测量驱动再议。
- **CV 信号直进时间线（自动剪辑动作）**：信号只进召回/排序层，剪辑决策仍在 provider 候选生成（AI-1 agent / Stage 2A）。

## 2. 设计要点

- **关键帧采样的取舍**：运动能量退化为采样帧间差分（粒度 = GOP 长度），对"孩子跑动 vs 静止机位"级别的召回区分足够；换来 4K60 素材解码成本可控（只解 I 帧）。GOP 超长素材（>10s）的采样密度下限由 fps 补采兜底（`select` 表达式加时间下限），实施时定参。
- **为什么不是 derived_media_cache**：召回层要求稳定可查 + 版本化，缓存语义（可 LRU 清理、内容寻址去重）不匹配；transcripts 先例（指纹判 stale + 主行/明细两层 + 状态机）为本仓库已验证模式。
- **algorithm_version 即"信号集版本"**：算法升级 → 新 version 行 + 旧数据标记 stale，召回层永远取最新 ready；不做原地重算。
- **隐私（ADR-0003 D4）**：信号计算全程本地；唯一网络行为是模型文件受信下载（与 faster-whisper 同模式，下载的是代码资产而非用户数据）；零 egress、零 consent 需求。

## 3. 验收（LiuKeAi，分阶段）

1. **AI-2-1**：合成视频单测（已知切点数/模糊度/亮度序，信号值可断言）；job 生命周期（queued→running→ready/failed、取消传播、stat 漂移中止）；v20 迁移逐版本测试；light 令牌与 waveform 并发不饿死（waveform priority 2 占先）；Core 全量回归。
2. **AI-2-2**：清单校验（错 sha256 拒绝）、断点续传、.ready marker 复验；含人脸 fixture 的 face_count 断言 + 无模型路径 partial 语义；模型下载失败不阻塞其余信号。
3. **AI-2-3**：转录素材召回排序变化可断言（含人脸段加权生效）；无转录素材端到端：CV-only 项目跑通 candidate 生成（provider mock），候选满足时长约束；契约增量回归（旧客户端不传新字段行为不变）。
4. **性能门（仓库惯例）**：每分钟源素材分析墙钟预算（初值 p95 ≤ 10s/分钟源，1080p30 与 4K60 两档），超预算则调采样密度或降级，记入 evidence。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 4K60 解码成本失控 | 关键帧采样从根上限定；性能门 + 采样密度可调 |
| 人脸误检（宠物/画中画） | 分数阈值 + 最小脸尺寸；召回层只做加权不做硬过滤，误检代价是排序偏移而非丢段 |
| 信号算法迭代导致存储 churn | algorithm_version 行化，旧版本标记 stale 不重算 |
| prepare 契约扩展破坏既有 UI | 增量可选字段 + 默认 auto 保持旧行为；契约回归测试 |
| onnxruntime 传递依赖漂移 | pyproject 显式声明 numpy/onnxruntime 版本下限，PyInstaller spec 已含 |

## 5. 开放问题（实施前裁决，ZhangSan）

- 采样密度参数（GOP 长度自适应 vs 固定 fps 下限）与性能门初值校准——阶段一首个测量任务钉死。
- `_select` 融合权重（关键词/人脸/运动/置信度）——阶段三以标注 fixture 回归钉死，不做运行时可调。

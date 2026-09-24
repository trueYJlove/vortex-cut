# AI-2 Layer 0 CV 信号层（阶段二：YuNet 人脸检测）——实施记录

> 实施：ZhangSan（Core），2026-09-20。承接阶段一实施记录（`AI_2_STAGE1_IMPLEMENTATION_2026-09-20.md`）。
> 阶段三（召回汇合）为后续单。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 模型清单 | `resources/model-manifests/yunet-face-detection.json`——OpenCV Zoo `face_detection_yunet_2023mar.onnx`（232KB，sha256 实测钉死，Apache-2.0，trusted_source `github-opencv-zoo`） |
| 注册表 | `model_registry.py`：provider 白名单化（`faster-whisper` + `onnx-cv`，曾硬编码单值）；安装根按 provider 分目录（`models/asr` 保持 / `models/cv` 新增）；`_provider_status` 按表查 runtime 模块（`faster_whisper` / `onnxruntime`）——faster-whisper 行为逐字节不变 |
| 人脸通道 | `media/cv_signals.py`：`FaceDetector`（onnxruntime 懒加载 + CPU EP）+ `analyze_faces`（RGB 160x120 采样遍历，**帧序号与灰度遍历对齐**）+ 结果合并进 `cv_samples.face_count/face_score`。<br>**【2026-09-24 修正】原记为"同 select 表达式"**——现两通道**各自**走快/全路径并同步 `skip_frame`（commit `a349866`），"同一表达式"不再逐字成立，**仅帧序对齐这一语义保持**。该提交同时修复了 `analyze_faces` 的 args 替换未生效残留（视频遍历已走快路径而人脸通道未走，即 25s 差异的来源） |
| partial 语义 | 模型未就绪/推理失败 → 人脸通道跳过、其余信号照常 ready（face 列 NULL、`model_revision` NULL、job 结果标 `faces=partial`）；就绪且合并成功标 `faces=merged` + model_revision 钉死 |
| 装配 | `CvSignalService` 注入 `model_manager`；`face_model_ready()` = 清单存在 + 安装 ready + runtime 可用 |

## 1. 模型规格与解码（实测标定，非官方文档转述）

OpenCV Zoo `face_detection_yunet_2023mar.onnx` 实测规格：

- **固定输入** `1x3x640x640` float RGB（非动态维度、非官方 README 暗示的任意尺寸）——小帧 letterbox 居中缩放填充，单帧 CPU 推理实测 ~7ms；
- **12 输出** = 三尺度（stride 8/16/32，各 `(640/s)²` anchor）×（cls 置信 / obj 目标性 / bbox 回归 / kps 关键点）；
- **bbox 回编码式（关键标定）**：回归值为 `(中心 dx, 中心 dy, 宽, 高) × stride`——非绝对坐标、非 ltrb 距离。验证方法：astronaut 图五强激活 anchor 的两种假设解码，`(dx,dy,w,h)×stride` 的中心全部收敛于 (297,166)、尺寸 ~41×47，与真实人脸位置吻合；
- **阈值校准**：score = cls×obj 过 0.6（官方 demo 语义），NMS 0.45，最小框 16px（640 域，剔除角点 1×1 退化假阳性）。验证：astronaut 512² 恰 1 框（0.859）；testsrc（无人脸）干净空；160 传输尺寸 2 框（小尺寸上采样模糊的次级假阳 0.69——召回层只加权不硬过滤，可接受）。

## 2. 验证

- 单测 19 项（含新增）：NMS 重叠抑制、12 输出解码（anchor 偏移式 + 退化框剔除 + NMS）、partial 语义（无管理器）、双清单加载与安装根分派。
- 真模型集成 2 项（bundled ffmpeg + 真实下载模型，sha256 清单校验）：
  - astronaut（CC0 真人脸）合成 3s 视频 → `faces=merged`、每采样帧检出、score>0.5、`model_revision='2023mar'` 落库；
  - 模型未安装 → `faces=partial`、face 列 NULL、其余信号照常 ready。
- Core 全量 **863 passed + 2 skipped**；Desktop **668 passed**。

## 3. 边界与后续

- 传输帧 160x120（letterbox 上采样到 640 推理）：小脸检出率让位于传输/解码成本——召回层定位是加权信号，非精确计数。
- `resources/.test-model-cache/` 为测试模型缓存（不入 git 语义；.gitignore 待随提交处理）。
- 阶段三（AI-2-3）：`samples_for_range` 已就绪，接 `planning.py` 召回汇合。

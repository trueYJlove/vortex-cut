# W2.2 说话人层 spike —— 证据（2026-10-10）

> 点时间证据。状态口径引用 `docs/STATUS.md`（§4 P88–P92）；方法与被冻结的口径引用
> `docs/W2_2_SPEAKER_LAYER_SPIKE_PLANNING_GATE_2026-10-10.md`。
> harness：`tools/spikes/w22_speaker/`（**非生产代码**）。

## 环境

- 机型：11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz / 31.6 GB / Windows 11 专业版
- 隔离 spike 环境：`.tmp/spike-venv`（**不污染项目 `.venv`**）
  - Python 3.13.1 / numpy 2.5.3 / onnxruntime 1.31.0 / kaldi-native-fbank 1.22.3
- onnxruntime 推理线程：**intra_op 单线程**（保守口径；未测多线程加速）
- ffmpeg：仓库自带 `resources/ffmpeg/win-x64/ffmpeg.exe`（n8.0.1-66）

## 文件

| 文件 | 内容 |
|---|---|
| `spike-report.json` | 主控原始输出：资源轴 / 过分割曲线 / 区分度 / 构造夹具 / 前端口径 A/B |
| `spike-report-rerun.json` | 同条件重跑（重复性核验）：**除计时字段外逐字段一致**；耗时波动 **±15%** 量级（与同机负载相关） |
| `spike-report-w3.json` | **尺度稳健性**：窗口 3.0s/1.5s（其余同）；用于判定离散结论是否随尺度变化 |
| `fbank-validation-oral_a.json` | 纯 numpy fbank vs kaldi-native-fbank 对拍（真实口播 30s） |
| `fbank-validation-music.json` | 同上（真实音乐 30s） |
| `fbank-negative-controls.json` / `.log` | **负向对照**：5 组已知缺陷全部被抓出（基线的 5,488×–16,111×）⇒ 等价断言有区分力 |
| `models.sha256` | 两个候选 ONNX 模型的 sha256 |
| `harness.sha256` | 生成该批证据时 harness 全部源文件的 sha256（评审要求：证据必须钉到可核验的代码快照） |
| `materials-roles.json` | 素材角色映射（**只记角色名，不记用户路径**） |

## 复现

```bash
# 1) 隔离环境
python -m venv .tmp/spike-venv
.tmp/spike-venv/Scripts/python.exe -m pip install --proxy <proxy> "numpy>=2.0,<3" "onnxruntime>=1.18,<2" kaldi-native-fbank==1.22.3

# 2) 模型（Apache-2.0，k2-fsa/sherpa-onnx release 直链）
#    3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx / wespeaker_zh_cnceleb_resnet34.onnx
#    → .tmp/spike-models/（sha256 见 models.sha256）

# 3) 前端对拍（归档 evidence 用的就是 --seconds 30）
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/validate_fbank.py <媒体> --seconds 30

# 4) 前端负向对照（归档 evidence 用的就是 --seconds 30）
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/negative_controls.py <媒体> --seconds 30

# 5) 主控
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/run_spike.py \
  --materials .tmp/spike-materials.json --out .tmp/spike-report.json --snip-edges-ab --excerpt-seconds 180

# 6) 尺度稳健性（窗口 3.0s/1.5s）
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/run_spike.py \
  --materials .tmp/spike-materials.json --out .tmp/spike-report-w3.json --excerpt-seconds 180 \
  --window-s 3.0 --hop-s 1.5
```

> **本文引用的所有数字都以 `--seconds 30` 为准。** 2026-10-10 评审指出：初版归档的负向对照用
> 的是 `--seconds 20`，与本节的 30 不一致（断言本身不受影响，但读者复现会对不上数）——已统一为 30。

## 素材清单格式

```json
{
  "角色名": { "path": "<仓外绝对路径>", "single_speaker": true }
}
```

`single_speaker` **不是装饰**：只有声明为单说话人的素材，「同素材首 8s + 静音 + 末 8s」这类构造夹具
才具备真值（= 1 位）；未声明者该字段记 `null`、**只作观测**——别把观测当结论。

## 口径与边界（**引为现状前必读**）

- 窗口 2.0s / hop 1.0s / 窗内语音占比 ≥ 0.6；聚类 = 余弦距离 + 平均连接（UPGMA）。
- **精度轴未取证**：本机无真实多说话人单麦对话素材；`eval_set` 的 `spoken-multi-*` 是纯音调夹具（非语音），
  **不可**用于 diarization 精度。构造夹具 `cross_identity` 是**易化用例**（跨录音设备），非对话真值。
- `oral_a` 的"1 位说话人"是**推定**（单镜口播 + 单叙述者转录），**未经人工听审**。
- C-重（pyannote 级）**未安装、未运行**：只取证了轮子体积、依赖面与 HF 门禁。
- 负面结论同样重要：`5月11日(3)-1.mp4` 有音轨但为**纯数字静音**（peak 0.0 / RMS −240 dBFS），
  已被排除出夹具——这是素材入夹具前必须做电平核验的现场依据。

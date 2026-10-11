# W2.2 精度轴 —— AMI 公开带标注语料实测（2026-10-11）

> 点时间证据。状态口径引用 `docs/STATUS.md`（P88 ⑩ / P89 / P91 / P93）；
> 方法与冻结口径引用 `docs/W2_2_SPEAKER_LAYER_SPIKE_PLANNING_GATE_2026-10-10.md` §2.7。
> **本目录只放派生结果与哈希，不含第三方音频**（音频在仓外 `.tmp/ami/audio/`，属主自备）。

## 为什么用公开语料

W2.2 的精度轴此前标"未取证"，原因是本机无真实多说话人对话素材。
但**"等用户随手给一段"只能看"像不像"**——公开语料带**官方参考标注**，能算出真正的 DER。
因此改用 AMI Meeting Corpus。

## 许可与署名（CC BY 4.0 要求署名）

见 `sources.txt`。要点：
- **AMI Meeting Corpus**（音频）与 **AMI manual annotations v1.6.2**：**CC BY 4.0**
- **AMI diarization setup**（参考轮次，派生自官方标注）：**Apache-2.0**；引用 Landini et al. (VBx)
- **Silero VAD v6**：项目**已随包分发**（`faster_whisper/assets/`），本 spike 直接复用，**无新增下载**

## 文件

| 文件 | 内容 |
|---|---|
| `ami-report.json` | 主结果：4 场会议 × 2 模型 × 3 VAD 条件 × 11 个 τ 的完整 DER 曲线与分解 |
| `fixed-tau-analysis.txt` | **关键对照**：固定 τ vs 每场用真值调 τ（诚实数字的来源） |
| `summary.txt` | 逐会议/逐条件摘要 |
| `der-selftest.txt` | 评分器自检（9 项，含平移单调性对照） |
| `harness.sha256` / `audio.sha256` | 生成该批结果时的 harness 与音频的 sha256 |

## 评分口径（**引数字前必读**）

- 自实现 DER（`tools/spikes/w22_speaker/der.py`）：10 ms 帧、**0.25 s collar**、
  **忽略重叠语音**、穷举最优说话人映射。
- **参考评分器 `BUTSpeechFIT/dscore` 仓库已不存在（实测 404）**，PyPI 的 `dscore` 是同名无关包。
- ⚠️ **"忽略重叠"会高估质量**（重叠段不计分）⇒ **本目录的 DER 不得与含重叠口径的公开数字直接比大小**。
- ⚠️ 低 τ 处 DER 可 **>100%**：FA 与说话人错误按"计分帧"归一，而过分割使这两项远超分母。
  这是口径的量纲后果，已在评分器 docstring 声明。

## 复现

```bash
# 1) 语料（仓外；CC BY 4.0，请保留署名）
#    AMI 音频：https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/<m>/audio/<m>.Mix-Headset.wav
#    参考标注：https://codeload.github.com/pyannote/AMI-diarization-setup/tar.gz/refs/heads/main

# 2) 评测（用 spike 隔离环境）
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/ami_eval.py \\
  --setup-dir .tmp/ami/AMI-diarization-setup-main --audio-dir .tmp/ami/audio \\
  --meetings ES2004a IS1009a IS1009c EN2002b --models campplus resnet34 \\
  --out .tmp/ami-report.json

# 3) 评分器自检（必须先绿）
PYTHONPATH=tools .tmp/spike-venv/Scripts/python.exe tools/spikes/w22_speaker/der.py
```

## 阈值策略 spike（`threshold-strategies*.{json,txt}` / `normalization-*.{json,txt}`）

回答"不靠真值怎么选 τ"。8 类无监督策略 × 4 场 × 2 模型，τ 网格 0.20–0.80：

| 策略 | 均值 DER | 最差 |
|---|---|---|
| oracle（用真值，上界） | 37.8% | 57.6% |
| dist_pct70 | **49.8%** | **63.6%** |
| silhouette | 50.2% | 62.9% |
| gap_mid | 51.2% | 62.9% |
| fixed 0.45（现基线） | 57.0% | **94.5%** |
| gap_ratio | 73.6% | 101.0% |
| capK4/6/8 | 46.0–47.6% | 62.8% | ⚠️ **不可采信，见下** |

- **现成启发式只填回一半差距**，没有任何一个达可用线；唯一实质收益是**最差一场 94.5% → ~63%**。
- ⚠️ **capK 被数据集混淆**：AMI 人数几乎恒为 4（test 15/16、dev 18/18、train 129/136），
  "限 6–8 人"等于**偷看答案区间**，不能证明其在人数多变素材上成立。
- **两个廉价归一化修法都不成立**：均值中心化 **78.6%**（反而大幅变差）、秩归一化 40.3%（中性）。
  中心化变差的**机制尚未坐实**（候选：中心化后部分向量范数趋零、归一化放噪），
  故只采信"本形态下有害"，不采信"中心化必然有害"。

## 仍未取证

跨语言（AMI 为英语）、重叠语音（本口径忽略）、远场单麦（用 Mix-Headset 头戴混合）、
用户自有素材；以及**重方案与折中方案的本机精度对比**（重方案因模型 gated 未运行）。

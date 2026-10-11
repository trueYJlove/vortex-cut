# W2.2 S0 —— 评测仪器常设化 + 全场语料（2026-10-11）

> 点时间证据。状态口径引用 `docs/STATUS.md`；口径与验收线引用
> `docs/W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md` §5/§6。
> **本目录只放派生结果与哈希，不含第三方音频**（语料在仓外 `.tmp/`，属主自备）。

## 为什么需要 S0

Design Gate §6 S0 的四项完成判据：① 评测仪器常设化**且进 CI**；② 语料扩到全场并逐场校验；
③ 派生 embedding 缓存（键 + sha256 + 复算清单）；④ 跑出自动 τ 基线。

## ① 仪器常设化（**关键：必须进 CI**）

复核 F2 实测：`pyproject.toml` 的 `testpaths` **只收 `services/core/tests`**，
所以迁到 `tools/` 的自检**不会进任何门**。故本项按两层落地：

| 层 | 文件 | 作用 |
|---|---|---|
| 实现 | `tools/quality_eval/diarization.py` | DER 评分器（原 `spikes/w22_speaker/der.py`），**唯一实现** |
| **门（进 CI）** | `services/core/tests/unit/test_diarization_scorer.py` | 9 项自检的 **pytest 形态** + 3 项负向对照 |
| 防漂移 | `tools/spikes/w22_speaker/der.py` | **薄转发**到常设实现，不复制逻辑 |

**行为等价性已核**：走转发器重跑自检，数值与迁移前
（`evidence/2026-10-11-ami-diarization/der-selftest.txt`）**逐位相同**：
`0.0000 / 0.0975 / 0.2292 / 0.6243`，单调性与 5 s 门判定一致。

### 负向对照（证明断言有区分力，不是恒真）

| 对照 | 断言 |
|---|---|
| A | "恒 0 评分器"能过 `identical` 但**必红**于 `empty` ⇒ 两用例共同构成区分力 |
| B | 关掉 collar ⇒ **计分帧数与 DER 都改变**（方向不做先验假设） |
| C | 关掉 `ignore_overlap` ⇒ 计分帧数**变大**（口径开关有效） |

> **B 的教训**：首版断言"关掉 collar ⇒ DER 变小"是**错的**（实测 0.0975 → 0.1239，反而变大）。
> 有区分力的判据是"计分帧数与 DER 都改变"，不是拍一个方向。已按实测改正。

## ② 语料（仓外，36 场全下 + 逐场校验）

| 语料 | 场次 | 许可 | 采集条件 |
|---|---|---|---|
| AMI test | **16/16** | CC BY 4.0 | Mix-Headset（近场头戴混合） |
| AISHELL-4 test | **20/20** | Apache-2.0 | 8 通道阵列的**第 0 通道**（远场） |

- 逐场清单：`corpora-audio.sha256`（36 行，`sha256sum` 格式）。
- **两种采集条件不可直接比大小**（见 Design Gate §5 口径限定）。

### 下载器：为什么单流"下不完"

本机实测（同一 URL、同一时段）：

| 方式 | 聚合速率 | 剩余 ~3.7 GB 预计 |
|---|---|---|
| hf-mirror 单流（原 `.tmp/s0_corpora.py`） | 44–134 KB/s | 8–24 h |
| 4 路并行 Range | 574 KB/s | ~1.8 h |
| **8 路并行 Range（本次采用）** | **~950 KB/s** | **~1.1 h** |

⇒ 单流是"下不完"的真正原因，**不是语料不可得**。工具：
`tools/quality_eval/fetch_diarization_corpora.py`（Range 分段并行 + 逐段续传 + 组装时算 sha256）。
实测单场 224–274 MiB、191–603 s、**449–1431 KB/s**。

## ③ 派生 embedding 缓存

实现：`tools/quality_eval/diarization_cache.py`；测试：
`services/core/tests/unit/test_diarization_cache.py`。

- **键** = `sha256(canonical_json({asset_fingerprint, model_id, algorithm_version, params, schema_version}))`
  ——**不含绝对路径**；`params` 纳入窗长/跳长/前端口径 ⇒ 改参数必换键。
- **校验**：读时逐条 sha256；不符即视为**未命中**（不返回脏数据）。
- **复算清单**：`manifest()` 逐条给 `verified`，可区分 verified / unverified。
- 测试钉死：键对**每一维**输入敏感（含"改窗长必须换键"）、损坏缓存是 miss、清单能报 unverified。

**收益**：S1 换策略/换 τ 只重聚类、**不重跑 ONNX**（推理 36–79 s/场 vs 重聚类 0.3–9.4 s/场）。

## ④ 自动 τ 基线

见同目录 `baseline-ami.json` / `baseline-aishell4.json`（本 README 不复述现役数字，Rule 5；
结论写在 `docs/STATUS.md` §4 的对应登记行）。

## 复现

```bash
# 1) 语料（仓外；CC BY 4.0 / Apache-2.0，请保留署名）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/quality_eval/fetch_diarization_corpora.py \
  --corpus both --streams 8 --chunk-mb 8 --write-sha256 .tmp/corpora-audio.sha256

# 2) 仪器自检（必须先绿）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe -m pytest \
  services/core/tests/unit/test_diarization_scorer.py \
  services/core/tests/unit/test_diarization_cache.py -q

# 3) 基线（AMI / AISHELL-4）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_eval.py \
  --corpus ami --audio-dir .tmp/ami/audio --rttm-dir .tmp/ami/AMI-diarization-setup-main \
  --meetings <16 场> --model-id campplus --out .tmp/w22-baseline-ami.json
PYTHONIOENCODING=utf-8 PYTHONPATH=tools .venv/Scripts/python.exe tools/quality_eval/diarization_eval.py \
  --corpus aishell4 --audio-dir .tmp/aishell4/audio --rttm-dir .tmp/aishell4/rttm --channel 0 \
  --meetings <20 场> --model-id campplus --out .tmp/w22-baseline-aishell4.json
```

> ⚠️ 必须设 `PYTHONIOENCODING=utf-8`（中文 Windows 控制台默认 GBK 会崩）。

## 语料人数分布（**修正 Design Gate 的一处假设**）

`speaker-counts.json`（由 RTTM 直接统计，不依赖音频）：

| 语料 | 人数分布 |
|---|---|
| AMI test | 4 人 ×15、3 人 ×1 |
| AISHELL-4 test | 6 人 ×8、5 人 ×8、**7 人 ×4** |

⇒ **AISHELL-4 test 实际是 5–7 人（最大 7），不是门文档写的"4–8 人"**。
对 O2（`k_max = 8`）的含义：`k_max=8` 仍**高于**全场最大值 7（有余量），
但"覆盖 4–8 档"这一依据表述**不准确**，已回写门文档 §10 O2。

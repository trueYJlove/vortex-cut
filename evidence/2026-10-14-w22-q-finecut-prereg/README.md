# W2.2 「细切 + 按份额合并」预登记实验（ADR-0008 D2-a / D3-a）

> 预登记（**看数之前写定**）：`PRE_REGISTRATION.md`。裁决：`docs/design/adr/0008-w22-o2-rerecheck.md`。

## ⚠️ 证据地位

- 判据、定参规则、语料角色**均在跑数之前写定**，执行期只允许**追加**发现（见预登记 §7）。
- **形态本身来自被污染的观察**（ADR-0008 复核期发现「细切+合并」）⇒ 本实验**只能**
  证伪或未能证伪「该形态可用」，**不能**声称发现了新机制。
- **判定集 56 场在预登记写定前未跑过任何 DER**（可复核：与已读集合交集为空）。
- **零迁移 / 零契约 / 零 egress / 不改生产代码。**

## 目录

| 文件 | 内容 | 何时产生 |
|---|---|---|
| `PRE_REGISTRATION.md` | 判据 / 定参规则 / 语料角色 / 负向对照 / 污染声明 | **跑数前** |
| `tuning-freeze.json` | AMI dev 上的 32 点全网格 + 冻结参数（margin 最大者） | 定参阶段 |
| `judging.json` | 判定集 + 三对照集的 M1–M5 / C1–C3 / NC1–NC5 全量读数 | 判定阶段 |
| `README.md` | 本文件 | — |

## 语料

| 角色 | 语料 | 场次 | 来源 |
|---|---|---|---|
| 定参集 | AMI dev | 18 | 新下载（`--corpus ami-dev`），sha256 见 `.tmp/ami-dev-audio.sha256` |
| 判定集 | VoxConverse 未读子集 | 56 | 本地已有 wav；清单 `.tmp/vc-subset-judge.json` |
| 对照 | AISHELL-4 test | 20 | 已在库 |
| 参考 | AMI test / VoxConverse test K≤3 | 16 / 63 | 已在库（**已读**，只报不改参数） |

## 复现

```bash
# 0（若需重建定参集）
PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/quality_eval/fetch_diarization_corpora.py \
  --corpus ami-dev --streams 8 --write-sha256 .tmp/ami-dev-audio.sha256
# 1 定参（AMI dev）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe .tmp/tune_dev.py
# 2 判定（读冻结参数）
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe .tmp/w22_judge.py
```


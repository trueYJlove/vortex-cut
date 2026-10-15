# W2.2 O5（P105）：含 BLOB 后的备份/恢复体积与耗时实测（2026-10-14）

> 回答 Design Gate §10 **O5** / `docs/STATUS.md` §4 **P105**：
> `speaker_diarizations` 携带窗 embedding BLOB 后，备份/恢复的体积与耗时**未实测**。

## 做法

- **真实迁移库**：`Database.initialize()`（76 张表，`speaker_diarizations` 为 v37 形状）。
- **真实派生行**：从归档 embedding 缓存重建 **36 场**（AMI test 16 + AISHELL-4 test 20）的窗向量，
  经生产函数 `encode_embeddings` 编码后写入 —— **不是造数**。
- **真实备份/恢复**：`sqlite3.Connection.backup()`（SQLite 官方在线备份 API），
  恢复后再做 `PRAGMA integrity_check` + 行数与 BLOB 总量核对。

## 结果（`backup-restore-result.json`）

| 项 | 值 |
|---|---|
| 派生行 | **36**（窗数 527–2109） |
| BLOB 总量 | **39.01 MiB**（平均 **1109.8 KiB/行**） |
| 空库 → 含派生行 | 29.53 MiB → **68.62 MiB**（净增 39.09 MiB） |
| **备份** | **243 ms** → 40.32 MiB |
| **恢复** | **215 ms** |
| 校验 | `integrity_check = ok`；行 36；BLOB 合计 39.01 MiB **逐一复原** |

## 判定（供门 §3 回写）

1. **体积量级可接受**：36 场全语料的派生数据约 **39 MiB**——相对视频素材（GB 级）可忽略；
   单行 ~1.1 MiB，与门 §3 预估（每场约 1.2 MB）**一致**。
2. **耗时可接受**：**备份 243 ms / 恢复 215 ms**（36 场）。按线性外推，
   数百场规模仍在**秒级**，不构成用户可见停顿。
3. **无损**：恢复后行数与 BLOB 总量与源库一致且 `integrity_check` 通过 ⇒
   **备份/恢复路径不因该 BLOB 而损坏或截断**。
4. **边界（如实）**：本机单次测量；未在**大库**（数百场）或**慢盘**上复测；
   未测**并发**（备份进行时仍有写入）与 **Windows 文件锁**场景。

## 复现

```bash
PYTHONIOENCODING=utf-8 PYTHONPATH=tools/quality_eval .venv/Scripts/python.exe \
  evidence/2026-10-14-w22-o5-blob-backup/measure_backup_restore.py
```

（脚本自建临时库于 `.tmp/p105/`；派生向量取自 `.tmp/w22-embedding-cache`，仓外。）

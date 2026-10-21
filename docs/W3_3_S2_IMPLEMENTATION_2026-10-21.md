# W3.3 S2 实施记录 · 帧级外传预览服务 + v40

> **切片**：S2（Design Gate §7，**零网络**）
> **上游**：Design Gate §2（DDL）/ §3.2（签名）/ §4（契约）
> **日期**：2026-10-21

---

## 1. 交付

| 文件 | 行数 | 作用 |
|---|---|---|
| `database_v40.py` | 130 | v40 迁移：**4 张表** + 1 处增列 + 2 个不可变触发器 |
| `keyframe_egress.py` | 312 | 三段式服务：prepare / exclude / create / claim + purge + detach |
| `test_keyframe_egress.py` | 355 | **24 项**测试 |
| `docs/STATUS.md` §1 | — | `latest_migration` 39 → **40**（Rule 2 强制同步） |

---

## 2. 验收核对

| 验收 | 判据 | 结果 |
|---|---|---|
| **A1** 逐张可见+可移除 | 移除帧 ⇒ 最终载荷不含该帧，留审计记录 | ✅ 移除改变 payload 哈希；只增不改；未知序号拒绝 |
| **A2** 未同意不发（I-1） | claim 是唯一放行点 | ✅ consent 只能消费一次；跨项目 claim 拒绝 |
| **A3** payload 可复算（I-2） | 同帧集合同哈希；增删帧必变 | ✅ 哈希由**磁盘真实字节**算，且含帧序号（顺序敏感） |
| **A12** 审计保真（I-4） | 呈现的哈希/字节 == 外传字节 | ✅ 逐帧比对磁盘字节；payload 与 thumbnail 两套且不等 |
| **A14** 到期清理 | 到期真删字节、保留元数据 | ✅ 清理后目录 0 字节、`frames_json` 哈希仍在；幂等 |
| **R17** 素材删除 | 不阻塞（P102）+ 审计留存 | ✅ **双向断言**：不 detach 则 FK 拒绝；detach 后可删且审计行在 |

**A8 由本切片承担的回归锁**：契约与分派均为增量、既有路径零变更——本切片只新增模块与迁移，未改动任何既有符号（见 §6）。

---

## 3. ⚠️ 补齐了设计门漏掉的两张表

**Design Gate §2 只定义了 2 张表**（`keyframe_egress_previews` / `asset_frame_tags`），
但 §3.2 的服务签名需要 `create(consent+generation)` 与 `claim_for_runner`。
写服务时才发现 `keyframe_egress_consents` 与 `keyframe_generations` **在门里根本不存在**。

**处置**：补齐两张表（含 `only_consume` 与 `no_delete` 触发器，照抄既有 `egress_consents` 范式），
并在迁移文件里就地写明「门漏了、实现补齐」。**不做「代码引用不存在的表」这种静默不一致。**

> 这是本包第二次出现「门写得比实现浅」：第一次是 §2 的 DDL 漏表，第二次是下面的 REASON 枚举。

---

## 4. 负向对照（实跑，5 组全部精准变红）

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **NC1** | 哈希只看元数据、不看真实字节（破坏 A3） | **2 failed** / 22 passed |
| **NC2** | 排除集不参与哈希（破坏 A1/I-3） | **5 failed** / 19 passed |
| **NC3** | claim 不消费同意书（破坏 I-1/A2） | **3 failed** / 21 passed |
| **NC4** | 清理只置标记、不删字节（破坏 A14） | **3 failed** / 21 passed |
| **NC5** | detach 什么都不做（破坏 R17） | **2 failed**（`-k detach` 定向） |

---

## 5. 实现中踩到并修掉的四个坑

### 5.1 SQL 字符串里不能写 `#` 注释

为压行宽，我在 `V40_SQL` 的索引语句上方加了 `# ...` 注释，结果迁移报
`sqlite3.OperationalError: unrecognized token: "#"`。
**原因**：`database.py` 的 `_statements()` 按分号切分后**逐条直接执行**，不剥离 `#` 注释。
已移除该行（说明文字移到 Python 注释，即三引号之外）。

### 5.2 SQL 里 `-- noqa` 无效

我一度把 `-- noqa: E501` 追加到 SQL 行尾——它不是 Python 注释，既不会被 ruff 识别，还会被当 SQL 一并执行。
正解是**换行拆分列清单**（SQLite 允许索引定义跨行）。

### 5.3 fixture 必须写全 NOT NULL 列

`projects` 有 `root_dir` / `root_dir_name` / `last_opened_at` 三个 NOT NULL 列；
`provider_configs` 的列是 `kind/display_name/base_url/model`，**没有 `origin`**（那是 DTO 字段名，不是列名）。
两处都先报错才查清——**说明我不该凭记忆写 INSERT**。

### 5.4 R17 测试的顺序曾经写反

首版先 `DELETE FROM assets` 再 `detach`，必然撞 FK。但这反而暴露了更好的写法：
用例现在**显式断言「不 detach 就删会失败」**（证明确实是 NO ACTION 而非 CASCADE），再走正路。
一条用例同时锁住两个方向的回归。

---

## 6. A8 的证据（增量性）

本切片**没有修改任何既有符号**：新增 `database_v40.py`、`keyframe_egress.py` 两个文件；
对 `database.py` 的改动仅 3 行（import / 版本常量 / `MIGRATIONS` 字典新增一项）。
契约文件 `packages/contracts/src/index.ts` **本切片未触碰**（契约增量在 S2 的下一轮或 S3 一并做，见 §7）。

---

## 7. 未完成 / 移交

| 项 | 归属 |
|---|---|
| 契约类型（`KeyframeEgressPreview` / `JobKind` 等）与 `parse*` 校验函数 | **S2b**（本切片未做，A8 的契约锁需与之一并断言） |
| Core 路由 + Desktop IPC | **S2b** |
| 从 `cv_analyses` 读切点并串起 encode+sampling+egress 的编排层 | **S2b** |
| `no_video` 判定 | **S2b** |
| vision 适配器 + 能力探测 | **S3** |

---

## 8. 质量门

| 项 | 结果 |
|---|---|
| `pytest test_keyframe_egress.py` | **24 passed** |
| S1a+S1b+S2 合计 | **69 passed** |
| 含 bootstrap（真迁移）的回归子集 | **155 passed** |
| `ruff check`（本切片 7 文件） | **All checks passed** |
| `pyright`（v40 + 服务） | **0 errors, 0 warnings** |
| 状态源一致性 | **10 passed**（`latest_migration` 已同步为 40） |

# W3.3 S4 实施记录 · 打标执行与落库 + 写入链路打通

> **切片**：S4（Design Gate §7）＋ Verification Gate 收口修复
> **上游**：规划门 D1/D5、A7/A10/A11；Design Gate §3.3 / §3.5 / §5.1 / §6
> **日期**：2026-10-21
> **状态**：Implementation Gate 完成；Verification Gate 见 `W3_3_VERIFICATION_GATE_2026-10-21.md`

---

## 0. 本记录为什么重新写过一次

S4 最初以「`keyframe_tagging.py` + 10 项测试 + 真实网关端到端」收口并被标记为 ✅。
在 W3.3 收口盘点时做**生产链路走查**，发现那条「端到端」只在**测试内部**成立——
真实产品路径上有四处断点，其中任何一处都会让功能对用户完全不可用：

| # | 断点 | 实测依据 |
|---|---|---|
| 1 | `create()` 不建作业 | 签名收 `jobs=None` 却**从未使用**；全仓无任何代码创建 `keyframe_tagging` 作业 |
| 2 | runner 从未接线 | `jobs.py` 有分派分支（槽位空即抛 `RENDER_FAILED`），但 `app.py` 从不赋值；`KeyframeTaggingService` 从未实例化（只出现在自己的定义与测试里） |
| 3 | 调度策略未登记 | `KIND_POLICIES` 无该 kind ⇒ 落 unknown 保守 heavy 单槽 |
| 4 | `provider_invocations` 从不写入 | v40 已加 `keyframe_generation_id` 列，但代码一次没写过该表 ⇒ A10「行数 = 调用次数」**无法断言** |

**教训（与本仓 P149 同型）**：把「测试全绿」当作「链路可用」是错的。
本轮新增的一条判据由此而来——**验收读落库/真实调用，不读「API 存在」**。

---

## 1. 交付（收口后的最终形态）

| 文件 | 变更 | 要点 |
|---|---|---|
| `keyframe_egress.py` | `create` 同事务落作业；`detach_asset` 接受调用方连接；新增 `generation_status`；**新增 vision 能力门禁** | 见 §2、§3 |
| `keyframe_tagging.py` | 新增 `run_tagging_job` / `mark_failed`；每次 HTTP 调用落 `provider_invocations`；逐帧进度 | 见 §4 |
| `jobs.py` | 新增 `insert_keyframe_tagging_job`（调用方事务内） | 与 `insert_captions_provider_job` 同型 |
| `job_scheduler.py` | `KIND_POLICIES` 登记 `JobPolicy("keyframe_tagging", ("light",), 2)` | 设计门 §3.5 第 3 条 |
| `projects.py` | `detach_keyframe_previews` 注入点，在删除事务内调用 | 见 §3 |
| `app.py` | 实例化打标与探测服务、接 runner、接 detach 回调、create 传 jobs、状态路由与 404 映射 | — |
| `test_keyframe_detach.py` | **新建** 4 项 | 走真实 `delete_asset` |
| `test_keyframe_tagging.py` | 10 → 29 项 | — |

---

## 2. 断点 1/2/3：create 原子落作业 + runner 接线 + 策略登记

**create 的四件套必须在同一事务**（规划门 §3.1 原文：`create → 原子落 consent + generation + invocation + job`）。
只用「顺序两句」的可观测差别是：进程在两句之间崩溃会留下「已签同意书、永远排队」的生成记录。
新增 `test_create_is_atomic_when_job_insert_fails` 直接钉住这一点——作业插入抛错 ⇒ 整体回滚、无残留 consent/generation。

**失败态落库**：`mark_failed` 的 `UPDATE` 带 `WHERE status='running'`。
理由不是防御性编程而是语义正确：claim 之前就失败的（例如同意书已被消费）**根本没有进入 running**，
把它改成 `failed` 等于把「未执行」谎报成「执行失败」。取消走 `cancelled`，其余走 `failed`。

`error_code` **不落 `keyframe_generations` 表**：该表没有此列，加列要新迁移；
状态查询改读作业行的 `error_code`——同一事实只有一个出处（P65 记录的失败模式是同一事实存两处必然漂移）。

---

## 3. 断点 4 之外的两处缺口（收口时新增）

### 3.1 素材删除被关键帧外传预览阻塞（P102 原样重演）

`keyframe_egress_previews.asset_id` 对 `assets` 是 `REFERENCES`（NO ACTION），
而 `detach_asset()` 全仓**零调用方**。实测（临时库 + 一条 preview 行）：

```
DELETE assets ⇒ DomainError: ASSET_IN_USE | 素材被镜头需求或生成记录引用，无法删除
```

原因错（真正原因是外传预览行）且**无出路**（界面没有任何入口能断开该引用）。

**为什么既有测试没抓住**：`test_keyframe_egress.py::test_detach_asset_allows_deletion_and_keeps_audit`
**直接调用** `svc.detach_asset()` 再手工 `DELETE`——被测的是 detach 自己，
而不是「删除素材时会不会有人调 detach」。**那是假绿**。
新建的 `test_keyframe_detach.py` 只走真实 `delete_asset`。

**修法**：注入回调 `detach_keyframe_previews(db, asset_id)`，在**同一事务**内于
`DELETE FROM assets` 之前执行；`detach_asset(asset_id, db=None)` 接受调用方连接。
半删状态在结构上不可能（同事务）。

### 3.2 vision 能力门禁（A4 的「此后 create 被拒且零字节外传」）

**原缺口**：`create` 不查 capability ⇒ 从未探测或探测失败的 Provider **仍能建立 consent + generation**，
A4 的判据在生产路径上不成立。门禁原先落在外层服务 `VisionProbeService.create_generation`，
而生产路由直调 `egress.create`——绕过了。

**修法**：把判据下沉进 `KeyframeEgressService.create`：

```
create(..., allow_unprobed=False)
  → if not allow_unprobed: _require_vision_capable(row["provider_config_id"])
  → 在任何 BEGIN / consent INSERT 之前
```

`_require_vision_capable` **只读库**（直查 `provider_configs` 四列），不经 `providers.get()`/`_dto`。
理由：依赖 DTO 会让门禁在 DTO 缺列时**恒假/恒真**——那是「看起来有守卫、实际不可观测」的形态
（本轮同时给 `_dto` 补了六列，但门禁**不依赖**它）。

四条件全部检查（对齐 `CaptionsProviderEgressService._require_capable` 先例）：
`enabled` + `status=='supported'` + `tested_at` 非空 + 适配器可用。
只查 status 不够：status=supported 但缺 tested_at 或适配器不可用时，runner 拿不到可选档位。

### 3.3 `allow_unprobed` 为什么不是通用旁路（两条机器判据）

探测自己必须调 `create`，而那时 provider 还是 `untested` ⇒ 需要一条自举路径。
它的正当性由两条测试守住，不是由注释声明：

1. `test_create_route_does_not_accept_allow_unprobed`：`KeyframeCreateRequest.model_fields`
   恰好等于 `{payload_sha256}`、`extra == "forbid"`、且 create 路由函数体源码里不含该字样。
2. `test_only_probe_path_passes_allow_unprobed`：**AST 遍历 `src` 下全部 `.py`**，
   统计 `allow_unprobed=True` 的关键字实参调用点，断言恰好 1 个且来自 `vision_probe.py`。
   用 AST 而非字符串搜索，避免注释/文档里的同名文字造成假绿或假红。

---

## 4. `provider_invocations` 归属（A10 的可断言性）

每一次**真实 HTTP 调用**落一行，含 token 撞顶后的**重试**。
调用前写 `running`、调用后置 `succeeded`/`failed`，收尾 `UPDATE` 带 `WHERE status='running'` 保证幂等。

**为什么按「调用」而不是按「帧」计数**：撞顶重试是第二次真实调用，也是第二次烧额度。
按帧计数会把重试吞掉，而重试正是重复计费的地方。测试断言 1 帧撞顶 ⇒ **2 行**、状态序列 `['failed','succeeded']`。

---

## 5. 验收交叉核对（Rule 3 要求）

| 验收项 | 结果 | 证据 |
|---|---|---|
| **A7** 词表外改道 notes、计数正确、版本入行 | ✅ | `test_out_of_vocabulary_label_moves_to_notes` / `test_vocabulary_violation_does_not_block_persist` |
| **A10** 真实 provider 端到端 + 行数=调用次数 | ✅（网关已验，见 S3 记录） | `test_invocations_row_count_matches_call_count` / `test_retry_produces_two_invocation_rows`；真实网关端到端见 S3 |
| **A11** 删素材 ⇒ 打标行随 CASCADE 消失；指纹变更 ⇒ stale；指纹与语义索引同源 | ✅ | `test_frame_tags.py`（11 项）；`database_v40.py:64` `ON DELETE CASCADE` |
| **A4** 探测 fail-closed；此后 create 被拒且零字节外传 | ✅ | `test_vision_probe.py` 26 项，含三条零外传判据（网络计数/consent 行数/generation 行数不变） |
| **R17/P102** 素材删除不阻塞 + 审计留存 | ✅ | `test_keyframe_detach.py` 4 项，走真实 `delete_asset` |
| 设计门 §3.5 三处登记 | ✅ | `test_scheduler_policy_is_registered_as_light` + `test_keyframe_contracts.py` |

---

## 6. 负向对照（全部实跑：还原即红、恢复即绿）

| # | 对照 | 红 | 恢复 |
|---|---|---|---|
| 1 | 去掉 `delete_asset` 的 detach 调用 | 1 failed（P102 原样复现：`FOREIGN KEY constraint failed` → `ASSET_IN_USE`） | 4 passed |
| 2 | 作业插入置空 | 4 failed（`assert 0 == 1` 等） | — |
| 3 | 删 `KIND_POLICIES` 登记 | 1 failed（`priority=5` / 三资源类） | — |
| 4 | 断开 runner 接线 | 1 failed（`keyframe_runner` 为 None） | — |
| 5 | 关掉 `mark_failed` | `assert 'running' == 'failed'` | — |
| 6 | 去掉 `provider_invocations` 插入 | 3 failed（`调用 2 次，实得 0 行`） | — |
| 7 | 去掉 vision 门禁 | 3 failed（`DID NOT RAISE DomainError`） | 26 passed |
| 8 | `allow_unprobed` 默认翻成 True | 3 failed | 26 passed |
| 9 | `_dto` 去掉六列 | 1 failed | 26 passed |

**第 1 条由调度方亲手复跑**（不是转述）。第 2 条的 AST 守卫另由调度方注入第二个调用点验证：
`AssertionError: allow_unprobed=True 的调用点应唯一，实际 ['keyframe_orchestration.py:117', 'vision_probe.py:288']` ⇒ 恢复后 1 passed。

---

## 7. 门禁下沉的连带影响（如实记录）

`create` 改为 fail-closed 后，既有测试中「先 prepare 再 create」但未置 capability 的全部变红。
**改夹具的文件 2 个、夹具 3 处、受影响测试 33 条**：

| 文件 | 夹具 | 条数 |
|---|---|---|
| `test_keyframe_egress.py` | `service` fixture 的 provider INSERT | — |
| `test_keyframe_tagging.py` | `_fresh_env` 的 provider INSERT、`_seed_app_world` 的 provider INSERT | — |

门禁加入后、改夹具前实测 **33 failed / 55 passed**；改夹具后 **96 passed**。
**没有一条是靠放宽生产门禁变绿的**——这一点必须如此，否则门禁等于没有。

另有 2 条用例（`test_forged_claim_dict_is_rejected_and_sends_nothing` /
`test_claim_guard_reads_consumed_at_from_db`）在构造前置状态时也走 `create`，
故改用 `allow_unprobed=True` 并注明理由（它们造的是「未消费的 consent」状态，不是在测能力门禁）。**不计入那 33 条**。

---

## 8. 已知局限（如实，勿引用为已解）

1. **`generation_status` 用 `input_json LIKE '%<generation_id>%'` 关联作业行，不是外键**。
   当前 id 形如 `keyframe_gen_<32hex>`，与其他 id 空间不冲突，实际不会误配；
   彻底消除需给 `jobs` 加 `keyframe_generation_id` 列 ⇒ 新迁移 + STATUS §1 同步，本轮未做。
2. **`POST /providers/{id}/vision-capability` 需要 `project_id` query 参数**。
   原因：`prepare` 要写 `keyframe_egress_previews.project_id`（NOT NULL 外键）。
   设计门 §5.1 只冻结了路径与「必须先 prepare→create→claim」，**未规定 project 如何传入**
   ⇒ 这是本实现对门的下沉细节，非门的裁决项。
3. **探测只用常量 JPEG**，它证明的是「网关接受图片内容块 + strict json_schema 这一形状」，
   **不证明模型看得见图**——视觉语义属 A10 的战果，不是 A4 的。
4. **`VisionProbeService.create_generation` 与 `egress.create` 的门禁重复**（前者额外校验
   `credential_status`）。保留是为在 egress 之前给出与探测一致的错误；两处判据必须同步演进。

---

## 9. 与 S4 首版记录的差异汇总

| 项 | 首版 | 本版 |
|---|---|---|
| 生产链路 | 四处断点，功能对用户不可用 | 已打通，端到端有测试 |
| provider_invocations | 从不写入 | 每次调用一行（含重试） |
| 能力门禁 | 只在外层服务 | 下沉到 `egress.create`，fail-closed |
| 素材删除 | 做了预览就删不掉（P102 重演） | 同事务 detach，审计留存 |
| 测试条数 | 10 | 29（tagging）+ 4（detach）+ 26（probe）+ 6（wording） |

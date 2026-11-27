# AGENTS.md

## Governance Overview & Single-Source Division

本仓采用严格的单源工程治理，各类文档职责边界如下，禁止跨文档重复声明同一事实：

| 文档 | 唯一权威职责 | 禁止事项 |
|---|---|---|
| [README.md](README.md) | 仓库总览、开发环境、构建/测试/CI 命令入口 | 禁止复述当前阶段、迁移版本或待办 |
| [CLAUDE.md](CLAUDE.md) | AI Agent 薄入口（引导先读三份权威文档） | 禁止膨胀为完整规范副本 |
| [docs/STATUS.md](docs/STATUS.md) | 唯一当前状态事实源（§1 机器校验块、能力边界、§4 未闭环承诺、§6 历史豁免） | §4 不得滞留已核销（✅）条目；总量保持 `< 50 KiB` |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 现状多进程架构、模块/安全边界、核心数据模型与真实目录分层 | 禁止出现虚拟目录或复述项目进度 |
| `docs/requirements/`、`docs/design/`、`docs/plans/` | 经各自 `README.md` 索引的专题活规格与长期在研提案 | 历史记录归 `docs/archive/`；一次性过程产物仅放 `.tmp/` |

### Code Change → Required Doc Sync Mapping

| 代码改动范围 | 必同步文档 / 约束 | 校验方式 |
|---|---|---|
| SQLite migration / `PATCH_OPERATIONS` / `AI_PATCH_OPERATIONS` / `CV_ALGORITHM_VERSION` / `PROTOCOL_VERSION` | 同步更新 `docs/STATUS.md` §1 | `test_status_doc_consistency.py` 强制门禁 |
| 进程边界、Electron Main/Preload 域、Renderer 顶层分层或 Core 子包结构变更 | 同步更新 `ARCHITECTURE.md` | Verification Gate 人工与链接检查 |
| 核心时间线、播放头、预览/导出变更动作 | 先在 `apps/desktop/src/app/commands/` 定义可序列化 Command，再经 `editorCommands.ts` 接入 UI | Command 层契约与单测 |
| 根级开发、测试、CI 或打包脚本变更 | 同步核对 `README.md` 与 `package.json` | Verification Gate 核对 |
| 专题需求、设计决策或长期方案演进 | 优先扩展既有活规格（先查目录 `README.md`）或登记在 `docs/plans/`；关门按 Rule 7 清理 | `test_status_doc_consistency.py` Rules 6–8 |

### AI Agent Execution Rules

1. **单任务范围封顶**：仅修改当前阶段或任务白名单内文件；若遇到白名单之外的架构问题或大面积测试失败，立即记录事实并暂停汇报，严禁顺带扩大重构范围。
2. **改前先列清单**：动手编辑前先明确最小改动文件清单与对应验收门禁，确认不触碰历史 ADR 或归档记录中的历史表述。
3. **过程产物仅放 `.tmp/`**：一次性执行日志、调试截图、临时脚本输出与中间草稿只允许放在已忽略的 `.tmp/`，严禁向主干残留未索引的过程 `.md`。
4. **收尾必贴实测证据**：合入或交付前必须运行对应检查（聚合检查必须用 `pnpm run ci`，严禁使用 `pnpm ci`），并如实贴出真实命令、退出码与 `git diff --stat`。

## Delivery Gates & Review Discipline

所有功能与治理变更按以下五个客观工程门禁推进，前一门禁未满足条件前不得进入下一阶段：

1. **Planning Gate**：明确变更范围、系统边界、验收标准与风险缓解措施，并将门禁工作包与风险项登记到 `docs/STATUS.md` §4。
2. **Design Gate**：冻结契约/DTO（`packages/contracts`）、SQLite 迁移与核心模块实现方案，确保不破坏跨进程安全边界。
3. **Implementation Gate**：在白名单范围内完成代码、单测与对应权威文档的并行更新。
4. **Verification Gate**：通过独立复核验证范围一致性、隐私/安全/性能约束、自动化测试覆盖率及文档同步纪律（Rules 1–8）。
5. **Release Gate**：全量门禁通过、闭环清理（Rule 7）完成后执行版本控制与发布动作。

跨模块协作坚持三项基本原则：通过显式文档化契约通信；文档与实现并行同步更新；不以局部捷径绕过门禁检查。

## Documentation Sync Discipline

**Why this exists.** The 2026-09-24 documentation audit found ~80 stale items across 17 documents,
including **5 written commitments that were never closed**. The root cause is not carelessness:
status was restated independently in ~22 places, with no single source and no enforcement.
Conventions alone decay — the five-gate process already existed and still leaked. This section
therefore pairs a written rule with a machine check.

### Rule 1 — Single source of truth

`docs/STATUS.md` is the **only** place that declares current state. No other document may restate
the current stage, migration version, capability boundary, or completion status. Other documents
must **reference** STATUS.md instead. This applies to `README.md`, `BRAND_BASELINE.md`, roadmaps,
handoffs, and the user manual alike.

### Rule 2 — Machine-checked facts (enforced by test)

`docs/STATUS.md` §1 holds a machine-readable facts block, verified against code by
`services/core/tests/unit/test_status_doc_consistency.py`. Changing any of the following in code
**requires updating STATUS.md §1 in the same change** — otherwise the test goes red:

| Code change | STATUS.md field |
|---|---|
| SQLite migration added or changed | `latest_migration` |
| TimelinePatch operation added or removed | `patch_operations` |
| AI whitelist operation added or removed | `ai_patch_operations` |
| CV signal algorithm constants changed | `cv_algorithm_version` |
| `PROTOCOL_VERSION` changed | `protocol_version` |

The test also fails if any document outside `docs/STATUS.md` reintroduces a known-stale
status claim (blacklist maintained in the test).

### Rule 3 — Commitments must be registered and closed

**Any** commitment written in a Planning Gate — acceptance item, **risk mitigation**, or resolved
open question — MUST be registered in `docs/STATUS.md` §4. It is closed only by updating §4 with
evidence and date. An unregistered commitment is treated as non-existent; an unclosed one is
tracked debt.

**Registration granularity** (refined 2026-09-24 after first use):

- **A gate is registered as ONE row** (type: 工作包), not one row per acceptance sub-item —
  otherwise §4 becomes unreadable and people stop maintaining it.
- **Individually registered** regardless of the above: risk mitigations, resolved open questions,
  and any acceptance item that has already been silently dropped once. These are the ones with a
  proven failure mode.
- **Closing a gate row requires the implementation record to contain an acceptance cross-check
  table** listing every acceptance item with its outcome (see
  `AI_2_SKIP_FRAME_IMPLEMENTATION_2026-09-24.md` §5 for the pattern). Without that table, the row
  stays open — the gate is not closed by assertion.

Risk mitigations are explicitly included because they are the ones that rot silently: acceptance
items at least have a checklist, mitigations have none.

### Rule 4 — Point-in-time records must not be cited as current

Acceptance records, validation reports, and implementation records describe a moment in time.
When superseded, add a `已被 X 取代` banner at the top **and** list the document in
`docs/STATUS.md` §6. Never cite them as current state.

### Rule 5 — Reference, do not restate

If you are about to write "当前处于…", "最新版本是…", or "尚未实现…" outside `docs/STATUS.md`,
stop and link to STATUS.md instead. Restating state is the origin of drift.

### Rule 6 — Single living doc per module (consolidate, don't multiply)

Before creating a new `.md` file under `docs/requirements/` or `docs/design/`, check
`docs/requirements/README.md` and `docs/design/README.md` to see whether an active living spec
already covers that subsystem. Extend the existing spec with a new numbered section instead of
creating a parallel file; only split when a single document becomes unwieldy (and register the
new file in its directory `README.md` in the same change).

### Rule 7 — Close-gate cleanup (Definition of Done)

Closing a gate or work package in `docs/STATUS.md` is not complete until its doc footprint is cleaned up:
- Merge any durable requirements, architecture, or contract decisions into the module's living spec;
- Remove closed rows from `docs/STATUS.md` §4 once verified (relying on Git commit history for closed ticket logs; do not maintain a separate `STATUS_ARCHIVE.md`);
- Move records that must remain addressable by code comments or open items to `docs/archive/` (marking superseded docs per Rule 4 and `docs/STATUS.md` §6), and delete transient validation logs, round reports, handoffs, debug screenshots, and scratch spikes once merged.

### Rule 8 — Active directories stay lean, indexed, bounded, and cleanly named

Every active `.md` file directly under `docs/requirements/`, `docs/design/`, or `docs/plans/` must
be listed in that directory's `README.md`. `docs/requirements/` and `docs/design/` are each capped
at **20** top-level living specs (excluding `README.md`); active in-progress/proposed plans belong
in `docs/plans/` (deleted or moved into living specs once closed). `docs/STATUS.md` stays under
**50 KiB** with concise open summaries and zero closed (`✅`) rows in §4. Living spec filenames directly under
`docs/requirements/` and `docs/design/` must use stable domain names: no date stamps
(`20XX-XX-XX`), no milestone/wave/work-package prefixes (`M2_`, `W\d`, `WAVE\d`, `P\d+`), and no
process suffixes (`_PLANNING_GATE`, `_DESIGN_GATE`, `*_IMPLEMENTATION_*`, `*_VALIDATION_*`,
`*_HANDOFF*`, `*_ROUND*`, which belong in `docs/archive/` only when kept for reference); H1 headings
of living specs should also omit `Planning Gate` / `Design Gate` draft suffixes.

### Enforcement

- **Rule 2 & Rules 6–8** — enforced by `services/core/tests/unit/test_status_doc_consistency.py`,
  which checks STATUS §1 facts against code, scans live docs (excluding `docs/archive/`) for
  blacklisted stale claims, verifies Markdown relative links, enforces `< 50 KiB` and zero `✅`
  rows in `STATUS.md` §4, requires every active doc under `docs/requirements/`, `docs/design/`,
  and `docs/plans/` to be indexed in its directory `README.md`, caps `docs/requirements/` and
  `docs/design/` at `<= 20` living specs each, and rejects process sprawl, date stamps, draft gate H1
  headings, or milestone/ticket prefixes in active spec filenames. `services/core/tests/unit/test_keyframe_wording.py`
  enforces W3.3 wording consistency across `docs/**/W3_3_*.md` and `docs/**/KEYFRAME_UNDERSTANDING_*.md`.
  CI executes both via `pnpm test:python`
  (`uv run --locked --extra dev pytest services/core/tests/unit`). Run directly with:
  `uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py services/core/tests/unit/test_keyframe_wording.py`.
- **Python unit tests** — `pnpm run ci` covers lint / typecheck / Desktop tests / **Python unit
  tests** / build; `pnpm run ci:release` adds the Electron e2e suite.
  **必须写 `pnpm run ci`，不能写 `pnpm ci`**：`ci` 是 pnpm 的内置命令（`ERR_PNPM_CI_NOT_IMPLEMENTED`），
  直接 `pnpm ci` 会**报错退出而根本不执行本仓脚本**（2026-10-23 实测踩中——此前本节写的就是
  `pnpm ci`，属「写了个无法执行的命令」）。CI 侧由 `.github/workflows/ci.yml` 的两个 job 覆盖：
  `python-unit`（`pnpm test:python`）与 `desktop`（lint / typecheck / vitest / build）。
  `pnpm test:python` 由 `tools/ci/run_pytest_gate.py` 统一执行 `services/core/tests/unit` 与
  `services/core/tests/integration/test_*_routes.py` 路由回归锁，并在 pytest 通过后运行
  `tools/ci/check_pytest_skips.py` 跳过/收集数守卫；其余生成重型真实媒体夹具的
  `services/core/tests/integration/` 集成测试不在默认 CI 管道内（修改路由或跨模块集成链路时需独立回归）。
- **Rules 1, 3, 4, 5** — verified at the Verification Gate through independent review, checking that
  STATUS.md §1 matches code, §4 reflects every open commitment, and no new state restatement
  has appeared elsewhere.

## Repository Size & Binary Admission Rules

To prevent repository bloat and accidental commits of generated media or oversized experiment dumps:

1. **Default Single-File Limit (`<= 500 KB`)**: Do not commit any single tracked file larger than `500 KB` (`512,000` bytes) without explicit architectural approval.
2. **Evidence Directory Limit (`<= 200 KB`)**: Under `evidence/`, only Markdown conclusions and lightweight config/summary JSON files (`<= 200 KB`) may be committed (aligned with `evidence/README.md`). Oversized raw sweeps, full IR dumps, and intermediate logs stay out of Git.
3. **No Script-Regenerable Media in Git**: Media fixtures, screenshots, audio/video samples, and capture outputs that can be deterministically generated by repo scripts (e.g., `tools/openfilm-timeline-parity/generate-fixture-media.py`, `tools/fixtures/generate-media-fixtures.ps1`) MUST NOT be committed to Git; generate them locally on demand and keep them listed in `.gitignore`.
4. **Manifest Registration for Required Large Assets**: Essential runtime/packaging binaries or font bundles exceeding the threshold MUST be explicitly registered in a tracked manifest (e.g., `resources/fonts/bundle.json`, `tools/dependencies/ffmpeg-manifest.json`, `resources/manifests/components.json`) with license, SHA-256, and necessity documented; unmanifested large binaries are forbidden.

## Editor Command Layer Discipline

To keep timeline/playback/render mutations deterministic and ready for future external / MCP tool integration:

- **新编辑功能必须先定义可序列化 Command 再接入 UI**：所有核心时间线编辑、播放头控制、预览/导出触发等变更动作，必须先在 `apps/desktop/src/app/commands/` 中定义入参/出参均为纯 JSON 可序列化数据的 `CommandDefinition`（含结构化 `CommandResult` 与 `inputSchema`），再经 `editorCommands.ts` 统一分发器接入 UI 按钮、快捷键或右键菜单；严禁在 Command 参数中传入 React SyntheticEvent、DOM 节点或组件局部 state setter。

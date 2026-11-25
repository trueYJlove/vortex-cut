# AGENTS.md

## Agent Roles in Vortex Cut Project

This document defines the agent roles used in the Vortex Cut project development process. Each agent has specific responsibilities and areas of expertise.

### LiuWei (Architect)

**Primary Responsibilities:**
- Overall system architecture design
- Stage planning and boundary definition
- Final decision making on design trade-offs
- Plan coordination and gate approval
- Ensuring alignment with overall project goals

**Technical Scope:**
- High-level system design
- Cross-component integration
- Stage boundary definition
- Risk assessment and mitigation planning

**Key Deliverables:**
- Stage planning documents
- Architecture diagrams
- Gate approval decisions
- Final design recommendations

### ZhangSan (Core/Data Model/Rendering Expert)

**Primary Responsibilities:**
- Core system implementation
- Data model design and validation
- Rendering pipeline development
- Task system implementation
- Performance optimization

**Technical Scope:**
- SQLite database schema design
- Core business logic implementation
- Timeline/document model
- Rendering engine integration
- Performance-critical components

**Key Deliverables:**
- Database migrations
- Core service implementations
- Model definitions
- Performance benchmarks

### YeJing (Contracts/Desktop/Electron Expert)

**Primary Responsibilities:**
- API contract design and implementation
- Desktop application development
- Electron integration
- Packaging and distribution
- User interaction design

**Technical Scope:**
- API/DTO definitions
- Desktop UI implementation
- Electron main/preload/renderer processes
- Windows packaging (NSIS)
- User experience flows

**Key Deliverables:**
- Contract definitions
- Desktop UI components
- Packaging scripts
- Integration tests

### LiuKeAi (Independent Reviewer)

**Primary Responsibilities:**
- Independent verification of scope and implementation
- Gate approval verification
- Risk identification
- Validation against project constraints
- Ensuring test coverage completeness

**Technical Scope:**
- Cross-stage compatibility
- Constraint validation (privacy, security, performance)
- Gate condition verification
- Documentation completeness
- Edge case analysis

**Key Deliverables:**
- Gate approval reports
- Risk assessments
- Verification reports
- Documentation reviews

## Workflow Process

The project follows a staged development process with specific gates:

1. **Planning Gate**: LiuWei defines scope and architecture, gets input from other agents
2. **Design Gate**: ZhangSan and YeJing provide detailed implementation plans
3. **Implementation Gate**: Development work with regular check-ins
4. **Verification Gate**: LiuKeAi independently verifies implementation
5. **Release Gate**: Final approval and version control operations

Each stage must pass all gates before proceeding to the next stage.

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
  What the Python step covers and excludes, and its closeout status, are declared in
  `docs/STATUS.md` §4 **P190** — reference it (Rule 5), do not restate it. In particular `services/core/tests/integration` is **not** in the
  pipeline: a route-level regression living there will not be caught — check P190 before relying
  on one.
- **Rules 1, 3, 4, 5** — verified at the Verification Gate by LiuKeAi, who checks that
  STATUS.md §1 matches code, §4 reflects every open commitment, and no new state restatement
  has appeared elsewhere.

## Collaboration Principles

- Agents communicate through documented interfaces and contracts
- Changes must be reviewed by relevant agents before implementation
- Gate approvals require consensus from all relevant agents
- Documentation must be updated in parallel with implementation (see **Documentation Sync Discipline** above)
- Roles may be combined for smaller tasks but maintained for major features

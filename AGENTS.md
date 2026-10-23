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

### Enforcement

- **Rule 2** — enforced by test `services/core/tests/unit/test_status_doc_consistency.py`,
  which the CI workflow `.github/workflows/ci.yml` executes through the root `pnpm test:python`
  script (`uv run --locked --extra dev pytest services/core/tests/unit`), so the check now fires
  without anyone remembering to run it. Run it directly with:
  `uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py`.
- **Python unit tests** — `pnpm ci` covers lint / typecheck / Desktop tests / **Python unit
  tests** / build; `pnpm ci:release` adds the Electron e2e suite. What the Python step covers and
  excludes, and its closeout status, are declared in `docs/STATUS.md` §4 **P190** — reference it
  (Rule 5), do not restate it. In particular `services/core/tests/integration` is **not** in the
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

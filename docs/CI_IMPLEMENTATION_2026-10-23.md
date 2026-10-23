# CI 落地 —— 实施记录（文档纪律同步部分）

> 点时间记录：2026-10-23。所属工作包：`docs/STATUS.md` §4 **P190**。
> **本文只记录"CI 落地"这一工作包中「文档纪律同步」这一片的实施与验收**，不声明项目当前状态——
> 状态一律引用 `docs/STATUS.md`（Rule 1 / Rule 5）。
>
> ⚠️ **本文含未实测项**，见 §4 与 §3 A6。凡标"未实测/未验证"的，**不得**在后续文档里写成既成事实。

## 0. 背景与契机（本任务的正当性来源）

提交 `299c6fd`（`fix(w3.3): 关键帧外传路由 HTTP 500`）修掉的两个 500 缺陷：

1. `app.py` 调用 `state.providers.require(project_id, id)`——`ProviderRepository` **没有该方法**
   （公开方法只有 `create/delete/get/list/patch`）⇒ `AttributeError`；
2. 同一路由的 `ffprobe` 调用**三处同时错**：漏 `await`（`probe` 是 `async def`）、传 `str` 而非
   `Path`（`normalize_probe` 内 `path.stat()`）、按属性读 `detail.duration_us`（实为 `dict`）。
   只补 `await` 仍然 500。

**当时的处境**：关键帧这一侧的 26 项单测**全绿**，而产品里点「准备预览」直接 500——真实界面点不动。
这正是「两侧各自绿、真实接线必红」的失败模式：单测直接调 `state.keyframe_egress.prepare(...)` /
`state.keyframe.prepare_preview(...)`，**没有任何一条走过 HTTP 路由**。

**因此本工作包要做的事**：把 Python 单元测试接进流水线，让「只有人想起来才跑」的检查变成
「每次提交自动跑」。文档纪律的同步是它的直接后果——`AGENTS.md` 与 `docs/STATUS.md` §0 原先明确写着
「本仓库没有 CI 流水线」「不包含任何 Python 测试」，这两句在本工作包之后**不再成立**。

## 1. 已冻结的形态（调度方裁决，本文按此记录，不改数值含义）

| 项 | 冻结值 |
|---|---|
| 工作流 | `.github/workflows/ci.yml`，runner **windows-latest** |
| 根脚本 | `test:python`（新）；`ci` = `pnpm lint && pnpm typecheck && pnpm test && pnpm test:python && pnpm build`；`ci:release`（新）= `pnpm ci && pnpm test:e2e` |
| Python 范围 | **仅 `services/core/tests/unit`**（**134** 个 `test_*.py`，`ls` 实测） |
| 不入管道 | `services/core/tests/integration`（**46** 个文件）、`services/core/tests/prototype`（**7** 项） |
| 不入管道的理由 | 会生成 **10GB+** 真实媒体夹具（`pyproject.toml` 的 pytest 配置注释已记录该代价与"临时目录保留最近 3 次"的取舍） |
| 上轮实测基线 | unit 全量 **1577 passed / 1 skipped / 0 failed**（2026-10-22，带随包 ffmpeg） |
| skip 守卫 | `tools/ci/check_pytest_skips.py`（新），目的：防「跑绿了但用例被跳过」 |
| runner 取值理由 | ffmpeg 不随仓库分发，测试把路径**硬编码**为 `resources/ffmpeg/win-x64/ffmpeg.exe`；工作流先跑 `tools/dependencies/prepare-ffmpeg.ps1` 按 sha256 取包 |

**为什么 runner 必须是 windows-latest（不是偏好，是正确性）**：unit 目录里 `FFMPEG.exists()` 形式的
`skipif` 广泛存在（`grep` 实测：unit 内 45 个文件提到 ffmpeg，13 处 `skipif` / `pytest.skip`）。
Linux runner 上这些用例会**静默跳过**——测试全绿、覆盖为零，正是本工作包要消灭的失败模式
（也因此才需要 skip 守卫做数量断言）。

## 2. 本次改动（文档纪律同步）

### 2.1 `AGENTS.md` 「Enforcement」小节

| | 关键句 |
|---|---|
| 改前 | "**Not yet wired into an automated pipeline**: this repository has no CI configuration, and the root `pnpm ci` script covers only lint / typecheck / Desktop tests / build — it runs **no Python tests**, so this check never fires automatically." |
| 改后 | "…which the CI workflow `.github/workflows/ci.yml` executes through the root `pnpm test:python` script (`uv run --locked --extra dev pytest services/core/tests/unit`), so the check now fires without anyone remembering to run it." + 新增一条 **Python unit tests** 说明：`pnpm ci` 覆盖到 Python 单测、`pnpm ci:release` 追加 Electron e2e、**覆盖范围与收口状态引用 §4 P190 而非复述**（Rule 5），并点明 `services/core/tests/integration` 不在管道内。 |

改后该段**不再包含**"no CI configuration"与"runs no Python tests"两句；「怎么跑」的命令保留并更新为
`uv run --locked --extra dev pytest …`（可直接执行）。

### 2.2 `docs/STATUS.md` §0 引言（原第 9–12 行）

| | 关键句 |
|---|---|
| 改前 | "…但**它不会被自动拦住**：本仓库当前**没有 CI 流水线**，根级 `pnpm ci` 也只覆盖 lint/typecheck/Desktop 测试/构建，**不包含任何 Python 测试**。该检查须显式运行 `pytest …`。" |
| 改后 | "…而这个红现在**会被自动拦住**：CI（`.github/workflows/ci.yml`，经根级 `pnpm test:python`）执行 `services/core/tests/unit`，本检查随之自动运行；…CI 的覆盖范围与收口状态见 **§4 P190**，显式运行：`uv run --locked --extra dev pytest …`。" |

§1 机器事实块（`protocol_version` / `latest_migration` / `patch_operations` /
`ai_patch_operations` / `cv_algorithm_version`）**逐字节未动**——见 §3 A7 与 §3.1 的 `git diff` 证明。

### 2.3 `docs/STATUS.md` §4 新增 P190

一行工作包登记，状态为**进行中**（已完成的部分与三次待回填项都写在状态列里）。
完整文本见 `docs/STATUS.md` §4 末行；逐条要点见 §4 与 §5。

## 3. 验收交叉核对表

> `AGENTS.md` Rule 3：关门需要本表——每个验收项独立列示其**结果**与**证据**。
> 本表刻意区分「已核对」与「未验证」：**未验证项没有证据，就不是绿灯**。

| # | 验收项 | 结果 | 证据 / 说明 |
|---|---|---|---|
| A1 | 本地 `pnpm test:python` 可跑 | ✅ **已实测** | 退出码 **0**；**1589 passed / 1 skipped / 0 failed**，墙钟 **1134.95s（18m54s）**。targets 两处：`services/core/tests/unit` + `services/core/tests/integration/test_keyframe_routes.py`。 |
| A2 | 负向对照：还原 `providers.require` 应变红 | ✅ **已实测（调度方亲手复跑）** | 把 `app.py:2753` 的 `state.providers.get(request.provider_config_id)` 还原为 P189 缺陷形态 `state.providers.require(...)` ⇒ 路由锁 **9 failed / 3 passed**；`git checkout` 恢复后 **12 passed**。⇒ 门确实抓得住该缺陷。**前提是范围含 integration 路由锁**（见 §5 的裁决记录）。 |
| A3 | skip 守卫负向对照 | ✅ **已实测（调度方亲手复跑）** | 把 `MIN_PASSED` 人为抬到 99999 ⇒ `[skip-gate] FAIL 通过数 1589 < floor 99999`，**退出码 1**；还原后 `git diff tools/ci/` 为空。 |
| A4 | 工作流 YAML 可解析 + **真实 runner 上跑通** | ✅ **已核对（含真实运行）** | `pnpm test:python` 与工作流内是**同一条命令**（断言在脚本内部，非只在 CI 生效）。**真实 run `39907136186`（run #13，`liuwei-dev` push）**：前 9 步全绿，含 `Download FFmpeg archive` / `Prepare bundled FFmpeg` / `Install uv` / `uv sync --locked`，**证明 windows-latest 上随包 ffmpeg 能按 sha256 取回、ffmpeg 用例不会静默跳过**。第 10 步「Python unit tests + skip gate」**失败**：`ModuleNotFoundError: No module named 'PIL'`（`test_vision_probe.py` 收集阶段中断，pytest 退出码 2）。**这是 CI 抓到的真实缺陷**：`PIL` 仅测试使用（`services/core/src` 0 处 `from PIL`）却未在 `pyproject.toml` 声明 ⇒ 本机装了 Pillow 才绿。已修：dev 依赖 `pillow>=11,<13` + `uv lock`（pillow v12.3.0）；负向对照（屏蔽 PIL 导入）精确复现该报错，恢复后 32 tests collected。**✅ 最终结论（run `39915123813`，run #16）：16 步全 success，job 总时长 10m39s**；`1560 passed / 30 skipped / 0 failed`、`collected=1590`、`[skip-gate] OK 跳过 30 项，均在白名单内`。**意外发现**：同一门同一 runner，pytest 由 1669.35s（27m49s）降至 **358.86s（5m58s，快 4.6×）**，唯一差别是 `--basetemp` 从系统 `%TEMP%` 换到仓库所在盘 ⇒ **系统临时区是该门的真实性能瓶颈**，也解释了它屡次写满盘。 |
| A5 | 改动边界 | ✅ **已核对** | 本轮只改 `AGENTS.md`（仅 Enforcement 小节）与 `docs/STATUS.md`（§0 引言 + §4 新增一行），并新建本文。未触碰任何代码 / `package.json` / `.github/` / `tools/` / `services/` / `apps/`（`git status --porcelain` 仅两处 ` M` + 一处 `??`）。 |
| A6 | e2e 全量时长 | ✅ **已实测（2026-10-23）** | `pnpm test:e2e` 墙钟 **9.2m**；结果 **12 passed / 19 failed / 15 skipped，退出码 1**。19 项失败与本包改动无关（`apps/`、`services/` 零改动；失败为 UI 超时）。**结论：全量 e2e 现非可通过门**，详见 §4.1 —— `ci:release` 在 19 项清零前不得作发布准入判据。 |
| A7 | 文档纪律同步本体（本次交付） | ✅ **已核对** | ① `uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py -q` → **10 passed**（改动后复跑）；② §1 事实块 `git diff` **零改动**（见 §3.1）；③ P190 行沿用 §4 五列格式并与相邻行同构。 |

### 3.1 A7 的 `git diff` 证明（§1 事实块未变）

```
$ git diff -U0 docs/STATUS.md | grep -c 'STATUS-FACTS\|protocol_version\|latest_migration\|patch_operations\|cv_algorithm_version'
0
```

未命中即事实块未进入任何 diff 上下文；正文明细见交付报告中的完整 `git diff --stat`。

## 4. 未实测项（**不得写成既成事实**）

| 项 | 状态 | 证据 |
|---|---|---|
| `pnpm test:python` 全量 | ✅ **已实测**（2026-10-23） | **1589 passed / 1 skipped / 0 failed**，墙钟 **1134.95s（18m54s）**，退出码 **0**；targets = `services/core/tests/unit` + `services/core/tests/integration/test_keyframe_routes.py` |
| skip 守卫实测 skipped 数 | ✅ **已实测** | `[skip-gate] collected=1590 passed=1589 skipped=1 failed=0`；唯一跳过为 `test_vision_adapter.py::test_real_gateway_tags_a_real_frame`（provider 环境未配置），命中白名单 |
| 全量 e2e（32 spec）时长 | ✅ **已实测（但不是绿）** <!-- E2E-DURATION-PENDING:RESOLVED --> | **12 passed / 19 failed / 15 skipped，墙钟 9.2m**。见下方「e2e 实测结论」——**19 项失败与本次改动无关**，是既存状态 |
| `pnpm ci` 整链端到端 | ⛔ **未验证** | 需在本机完整跑一次（含 Desktop 1600+ vitest 与 build），本轮未跑 |
| GitHub Actions 上首次真实运行结论 | ⛔ **未验证** | 工作流推送后首个 run 的结论（本轮**不** push，无法本地证明远端可用） |

### 4.1 e2e 实测结论（**必须同读**）

在**本机**跑 `pnpm test:e2e` 的实测结果：**12 passed / 19 failed / 15 skipped，9.2m，退出码 1**。

**19 项失败与本次 CI 改动无关**，依据：`git status --porcelain` 显示 `apps/` 与 `services/` **零改动**
（本次只动了 `AGENTS.md` / `docs/*` / `package.json` / `.github/` / `tools/ci/`）；失败形态是
UI 元素超时（如 `m2-b1-speed` 的 `locator('.speed-editor')` 15s 未可见），属既存问题。

**由此得到的直接结论（对本包的设计有实质影响）**：
现阶段**全量 e2e 不是一条可通过的门**。`ci:release` 若直接串 `pnpm test:e2e`，发布前门会**恒红**，
从而失去信号价值（恒红的门等于没有门）。**因此在 e2e 19 项失败清零之前，`ci:release` 只能作为
「隔离并记录既有失败」的观察门使用，不得当作发布准入判据**。处理方式待用户裁决，本包不改 e2e。

上轮（2026-10-22）的 unit 实测基线 **1577 passed / 1 skipped / 0 failed** 是**已测数字**，
但它测的是**本机**、**改动前**的状态；它不能代替"CI 上跑过"。

## 5. 边界与已知局限（需调度方裁决）

1. **管道范围与本次契机不匹配。** 冻结范围是 unit，而 299c6fd 的回归锁在 integration。
   ⇒ 「CI 若跑过 `test_keyframe_routes.py` 当天就会红」这句话，只有在管道**包含 integration**
   时才成立。按当前冻结范围，CI 的正当性来自「Python 单测从 0 覆盖变成每次自动跑」，
   **而不是**「299c6fd 这类缺陷会被抓到」。这个区别必须留在案卷里，否则下一个人会以为已经安全。
2. **route 级覆盖现状。** unit 内仅 3/134 个文件使用 `TestClient`。若要让 route 级缺陷进 CI，
   可选路径：把 `test_keyframe_routes.py` 这类轻量（不产媒体夹具）的路由测试**移入 unit**，
   或在 unit 内新增路由冒烟套件——两者都超出本次边界，未实施。
3. **integration / prototype 排除的代价。** 排除换来的是「不跑 10GB+ 媒体夹具」；
   代价是「集成层回归仍只能手工跑」。这是一次有意识的取舍，不是遗漏。
4. **文档口径的一个判断。** `AGENTS.md` 与 `docs/STATUS.md` §0 现在陈述 CI 的**形态**（配置事实），
   而 §4 P190 陈其**收口状态**（进行中 + 待回填）。这样切分的理由：形态是冻结裁决、不会再变；
   状态是会变的部分，只留在 STATUS.md §4 一处，避免二次漂移。若调度方认为形态陈述也应一并
   锁进 P190、正文只留引用，改动很小。

## 6. 怎么跑（可执行命令）

```bash
# 只跑文档纪律机器校验（本次改动的直接验收集）
uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py

# Python 单元测试全集（CI 的 Python 步骤，本地等价）
uv run --locked --extra dev pytest services/core/tests/unit

# 完整门（脚本落地后可用）
pnpm ci          # lint → typecheck → Desktop tests → Python unit tests → build
pnpm ci:release  # pnpm ci + Electron e2e
```

`pnpm ci` / `pnpm ci:release` 以上述脚本落地为前提；当前工作区尚未落地，见 §3 A1。

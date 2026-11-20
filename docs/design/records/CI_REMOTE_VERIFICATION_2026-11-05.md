# CI 远端验证补齐 —— 实施记录（2026-11-05）

> 点时间记录：2026-11-05（系统时钟与 CI run 均为 2026-11-05）。
> 所属工作包：`docs/STATUS.md` §4 **P190** / **P193**；附带对 **P206** 的判据复核。
> **本文只记录「本轮做了什么、证据是什么」**，不声明项目当前状态——状态一律引用 `docs/STATUS.md`（Rule 1 / Rule 5）。
> 本轮为**文档任务**：`apps/**`、`services/**`、`packages/**`、`tools/**` 零改动。

## 0. 为什么需要这份记录

`docs/STATUS.md` 的 P190 与 P193 两行长期挂在 🟡，共同理由是同一句话：
「远端 CI 首次真实运行 / 新增 desktop job 首跑未取得」。这句话在
run `41949321912` 之后已经**不再成立**——而按 AGENTS.md Rule 3，
关掉一行不能只把 emoji 改绿：必须在实施记录里留下**逐条验收核对表**。
本文即那份核对表；STATUS.md 里两行改为引用本文，不重复本表内容（Rule 5）。

## 1. 证据来源（一次运行，不是拼凑）

本轮的全部远端事实都来自**同一个 run、同一个 commit**，避免「拿 A 次的结果证明 B 次的结论」：

```
$ gh run list --limit 1 --json databaseId,headSha,conclusion
[{"conclusion":"success","databaseId":41949321912,
  "headSha":"0d939f7a476b116a9f0cd44327f9789fb1a36cea"}]
```

```
$ git rev-parse HEAD
0d939f7a476b116a9f0cd44327f9789fb1a36cea
```

**headSha 与工作区 HEAD 逐字符相同**，故本次运行的结论描述的就是当前代码，不含「跑的是旧提交」这一类误判。

运行元数据：

```
$ gh run view 41949321912 --json headSha,conclusion,headBranch,createdAt,jobs \
    --jq '{headSha:.headSha, headBranch:.headBranch, conclusion:.conclusion, createdAt:.createdAt,
           jobs:[.jobs[]|{name,conclusion,startedAt,completedAt}]}'
{"conclusion":"success","createdAt":"2026-11-05T01:33:29Z","headBranch":"liuwei-dev",
 "headSha":"0d939f7a476b116a9f0cd44327f9789fb1a36cea",
 "jobs":[
  {"completedAt":"2026-11-05T01:40:32Z","conclusion":"success",
   "name":"Python unit tests + skip gate","startedAt":"2026-11-05T01:33:32Z"},
  {"completedAt":"2026-11-05T01:40:31Z","conclusion":"success",
   "name":"Desktop lint / typecheck / vitest / build","startedAt":"2026-11-05T01:33:33Z"}]}
```

两个 job **均 conclusion=success**，即 P190 关心的 `python-unit` 与 P193 关心的 `desktop` 在同一次运行里都跑完了。

## 2. 两个 job 的逐步结果（原始输出）

### 2.1 `Python unit tests + skip gate`

前四步与「随包 ffmpeg 能否在 windows-latest 取回」直接相关，第 10 步是门本身：

```
$ gh run view 41949321912 --json jobs \
    --jq '.jobs[]|select(.name|startswith("Python"))|.steps[]|{n:.number,name,conclusion}'
{"conclusion":"success","n":1,"name":"Set up job"}
{"conclusion":"success","n":2,"name":"Run actions/checkout@v4"}
{"conclusion":"success","n":3,"name":"Download FFmpeg archive"}
{"conclusion":"success","n":4,"name":"Prepare bundled FFmpeg"}
{"conclusion":"success","n":5,"name":"Run pnpm/action-setup@v4"}
{"conclusion":"success","n":6,"name":"Run actions/setup-node@v4"}
{"conclusion":"success","n":7,"name":"Install uv"}
{"conclusion":"success","n":8,"name":"Install Python dependencies"}
{"conclusion":"success","n":9,"name":"Install Node dependencies"}
{"conclusion":"success","n":10,"name":"Python unit tests + skip gate"}
{"conclusion":"success","n":11,"name":"Upload pytest junit results"}
… Post 步骤与 Complete job 亦全 success（共 16 步）
```

计数与 skip 守卫（取自 job 日志原文）：

```
$ gh run view 41949321912 --log | grep -E '\[skip-gate\] (collected|OK)'
[skip-gate] collected=1639 passed=1609 skipped=30 failed=0 (junit suite attrs:
  {'tests': '1639', 'skipped': '30', 'failures': '0', 'errors': '0'})
[skip-gate] OK 跳过 30 项，均在白名单内

$ gh run view 41949321912 --log | grep 'passed, 30 skipped'
1609 passed, 30 skipped, 6 warnings in 286.36s (0:04:46)
```

30 项跳过的分布（同一条日志，按文件聚合）：

```
$ gh run view 41949321912 --log | grep 'skip-gate.*allowed:' \
    | sed -E 's/.*allowed: (services[^:]+)::.*/\1/' | sort | uniq -c
      1 services/core/tests/unit/test_beat_analysis_job.py
     12 services/core/tests/unit/test_clip_tokenizer.py
      1 services/core/tests/unit/test_vision_adapter.py
     16 services/core/tests/unit/test_wordpiece_tokenizer.py
```

每条都带着守卫打印的 `skip_msg`（如「CLIP tokenizer 未下载（受信模型，不随仓库分发）」），
**白名单外跳过 0 项**。

### 2.2 `Desktop lint / typecheck / vitest / build`

四步各自独立成 step，逐步结论与耗时：

```
$ gh run view 41949321912 --json jobs \
    --jq '.jobs[]|select(.name|startswith("Desktop"))|.steps[]
          |select(.number>=6 and .number<=9)|{name,start:.startedAt,end:.completedAt}'
{"end":"2026-11-05T01:35:04Z","name":"Lint","start":"2026-11-05T01:34:42Z"}
{"end":"2026-11-05T01:35:23Z","name":"Typecheck","start":"2026-11-05T01:35:04Z"}
{"end":"2026-11-05T01:40:10Z","name":"Desktop unit tests (vitest)","start":"2026-11-05T01:35:23Z"}
{"end":"2026-11-05T01:40:19Z","name":"Build","start":"2026-11-05T01:40:10Z"}
```

vitest 计数（日志原文）：

```
$ gh run view 41949321912 --log | grep -E 'Tests .* passed'
      Tests  1012 passed | 4 skipped (1016)
```

即 `Lint` 22s / `Typecheck` 19s / `vitest` 287s / `Build` 9s，四步全绿；
job 壁钟 `01:33:33Z → 01:40:31Z` ≈ **6m58s**。

## 3. 验收核对表（Rule 3 要求的逐项结果）

### 3.1 P190

| # | P190 的验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | Python 单测在 GitHub Actions 上真实跑起来并通过 | ✅ | run `41949321912` job `Python unit tests + skip gate` = success；`1609 passed, 30 skipped`（§2.1） |
| 2 | **windows-latest 上能按 sha256 取回随包 ffmpeg**（本包核心设计假设） | ✅ | 同 job 第 3 步 `Download FFmpeg archive`、第 4 步 `Prepare bundled FFmpeg` 均 success（§2.1） |
| 3 | **ffmpeg 用例不会静默跳过**（skip 守卫拦住） | ✅ | `[skip-gate] OK 跳过 30 项，均在白名单内`；`[skip-gate] collected=1639 passed=1609 skipped=30 failed=0`；白名单外 0 项（§2.1） |
| 4 | `pnpm ci` 整链的 Desktop 侧（lint / typecheck / vitest / build）在真实 runner 上跑过 | ✅ | job `Desktop lint / typecheck / vitest / build` = success，四步全绿（§2.2） |
| 5 | skip 白名单里 3 个「依赖本机资产」的条目理由在**全新环境**成立 | ✅ | 30 项全部命中白名单并各自带 `skip_msg`，分布见 §2.1；无白名单外跳过 |
| 6 | 全量 e2e 可作为发布准入判据 | ❌ **不在本包范围** | 该缺口是 e2e 缺陷分批处置，归 §4 **P194**；本轮不改变该口径，也不据此宣称发布就绪 |

**结论**：验收项 1–5 全部关闭；第 6 项不属 P190 的验收范围，保留在 P194。P190 因此可改 ✅。

### 3.2 P193

| # | P193 的验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新增 `desktop` job 的**首次真实 runner 运行**取得 | ✅ | run `41949321912` job `Desktop lint / typecheck / vitest / build` = success（§2.2） |
| 2 | 四步各自独立成 step（失败时能一眼看出哪一环红） | ✅ | 步骤名 `Lint` / `Typecheck` / `Desktop unit tests (vitest)` / `Build` 独立出现（§2.2） |
| 3 | 超时预算（`timeout-minutes: 30`）经首跑校正、不越线 | ✅ | job 壁钟 ≈ 6m58s，约为 30 分钟的 23%；无 cancel |
| 4 | `AGENTS.md` 中 `pnpm ci` → `pnpm run ci` 的纠正仍成立 | ✅ | `AGENTS.md` 现文写 `pnpm run ci`；本轮未改动该文件 |
| 5 | `ci:release` 可作发布准入判据 | ❌ **仍为观察门** | e2e 剩余项归 §4 **P194**；本轮不作发布就绪声明 |

**结论**：验收项 1–4 关闭；第 5 项是**门本身的定位**，不是未完成的实现，且已明确归 P194。P193 因此可改 ✅。

## 4. P206：判据复核（本轮未关闭它）

P206 与 P212 是否重复登记，本轮按要求独立复核，**结论是「不重复，且不能关」**。
完整逐条核对写在 `docs/STATUS.md` §4 **P206** 行内（Rule 5：状态与判据只在状态源里维护），
此处只记录复核方法与结论，不复述状态。

### 4.1 P206 自己要求先验的那条前提

P206 原文要求先回答：「只占左侧一条」是否真是「9:16 项目生成了 16:9 IR」。

- `OUTPUT_RATIO_DIMENSIONS["916"]["authoritative_preview"]` = `(540, 960)`（`services/core/src/aivs_core/rendering/plan.py:46`），
  `PROFILES["authoritative_preview"]` 兜底同为 `540×960`（同文件 `:18-21`），
  `ir.py:325-326` 直接取 `plan["output"]` 的宽高 ⇒ **9:16 项目在该通路上生成不了 16:9 IR**。
- 但复核发现另一条真实通路：`apps/desktop/src/app/App.tsx:2345`
  `renderRatio = effectiveRatio === "fit" ? assetOriginalRatio : effectiveRatio`，
  而 `assetOriginalRatio`（`:2332-2344`）只用 `video_streams[0].width/height` 推比例、
  **完全不读 `rotation`**（`App.tsx` 全文 `rotation` 命中 0 处）；
  竖拍 iPhone 的 ffprobe 原始宽高是 3840×2160（`services/core/src/aivs_core/media/ffprobe.py:63-64` 原样保留，
  仅 `:69` 另附 `rotation`）⇒ 走「适应」时会被判成 `169`。
- 该分支**不是默认路径**：`previewRatio` 初值 `"fit"`（`App.tsx:303`）但 `previewRatioTouched=false`（`:304`）
  ⇒ `effectiveRatio = autoRatio`（`:2326`），9:16 项目由项目画布推得 `916`（`:2318-2324`）。

⇒ 所以「先测实际 IR 的 `canvas`」这一步仍然必要，**且必须记录当时比例下拉停在哪一档**。

### 4.2 为什么没把它并进 P212

P212 第⑤条交付的是 **IR 投影层**的修复：geometry 携带 `display_*`、`_fit_content_box` 按显示方向算内容盒，
并有单元级回归锁 `services/core/tests/unit/test_rotation_regression.py:145-146`
（`_fit_content_box(VERTICAL_GEOMETRY, 540, 960) == (0, 0, 540, 960)`，本轮实测 `18 passed`）。

而 P206 的判据是**出帧**的非黑内容包围盒接近整画布。二者不等价：
内容盒算对之后，画面上是否铺满还取决于合成器的 `u_tex_swap`
（`apps/desktop/src/app/preview/compositor-worker.worker.ts:127`，
由 `preview-session.ts:541-546` 依 display 与原始尺寸互换来置位），
而 `grep texSwap|tex_swap|planeSwapped` 在 `apps/desktop/tests` 与 `apps/desktop/e2e` 两目录**均为 0 命中**；
全仓 `_non_black_bounds` 也只有一处定义、一处使用（`services/core/tests/integration/test_stage1c_sar_real.py:107` / `:166`），
且那是 SAR 用例、横版夹具、不含旋转；`test_stage1c_render_real.py:122-129` 虽现造了 `rotated-90.mp4`，
但只把它写进 evidence JSON（`:436`），**没有任何像素断言**。

用单元函数断言去关一条「真机出帧」缺陷，正是 P213 记录过的同型错误。
因此 P206 **保持 🟡**，并在状态源行内写明还缺什么（端到端出帧用例 + 必须确认它在强制门里被收集）。

### 4.3 顺带发现（未在本轮处理）

`_pip_box`（`services/core/src/aivs_core/rendering/ir.py:193-215`）只用 `geometry["width"]`/`geometry["height"]`，
**没有跟进 `display_*`**；主轨 fit 与 `crop_fill` 已跟进（`:531`、`:523-524`），覆盖轨（PIP）没有。
这是一个具体、可复核的残留，已记入 P206 行；本轮为文档任务，不修代码，也不把它当作关闭 P206 的理由。

## 5. 本轮改了什么

只改两个文件：

| 文件 | 改动 |
|---|---|
| `docs/STATUS.md` | P190 行：状态改 ✅ + 逐项结清说明（①–④ 各自结论）；P193 行：状态 ✅ + 补 desktop job 首跑证据与耗时校正；P206 行：回答待验前提、标注已被 P212 推翻的旧「已验状态」条目、写入判据逐条核对与「仍缺什么」。**P203 / P200 / P204 零改动。** |
| `docs/design/records/CI_REMOTE_VERIFICATION_2026-11-05.md` | 本文。 |

按 Rule 5，本文不写「当前 CI 处于什么状态」，只写本轮证据与结论；状态以 `docs/STATUS.md` 为准。

## 6. 复现命令

```
# 远端证据（只读）
gh run list --limit 1 --json databaseId,headSha,conclusion
gh run view 41949321912 --json jobs
gh run view 41949321912 --log | grep -E '\[skip-gate\] (collected|OK)'

# 文档纪律机器校验（本轮验收集）
uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py

# 涉及 P206 判据的两条锁（本轮只读复核，未改动它们）
uv run --locked --extra dev pytest services/core/tests/unit/test_rotation_regression.py
uv run --locked --extra dev pytest services/core/tests/unit/test_frame_decode_rotation.py
```

# W3.3 S2b 实施记录 · 契约增量 + 编排层 + 路由 / IPC

> **切片**：S2b（Design Gate §7 S2 的后半）
> **上游**：Design Gate §4（契约）/ §5.1–5.2（路由与 IPC）/ §3.1（编排）
> **日期**：2026-10-21
> **验收归属**：本文的 A8 结果由 **`W3_3_VERIFICATION_GATE_2026-10-21.md`** 汇总复核；生成状态路由由 S4 收口补齐（`W3_3_S4_IMPLEMENTATION_2026-10-21.md`）。

---

## 1. 交付

| 文件 | 变更 | 说明 |
|---|---|---|
| `packages/contracts/src/index.ts` | +约 150 行 | 4 个类型 + 4 个 `parse*` + `JobKind` 新成员 + 5 个失败码 |
| `keyframe_orchestration.py` | 新增 114 行 | 读切点 / 可用性判定 / 全链路 prepare |
| `app.py` | +约 70 行 | 3 个 Core 路由 + 服务装配 + 启动期清理 |
| `stage2b-ipc.ts` | +约 30 行 | 3 个 IPC 通道 + 2 个 parse 导入 |
| `test_keyframe_contracts.py` | 新增 112 行 | **6 项** A8 契约锁 |
| `test_keyframe_orchestration.py` | 新增 212 行 | **13 项**，含真实 ffmpeg 端到端 |
| `tests/stage2b-ipc.test.ts` | 1 行 | 通道白名单补 3 项 |

---

## 2. A8 契约增量锁（本切片的重点）

`JobKind` 在契约里有**三处**必须同步，只改一处是**静默失败**：

| # | 位置 | 漏改的后果 |
|---|---|---|
| 1 | `JobKind` 类型联合（:81） | 编译期不允许新 kind |
| 2 | `JOB_KINDS` 运行期数组（:1427） | **编译能过，但 `parseJob` 运行期拒绝** |
| 3 | 后端分派 | 作业永远不执行 |

第 2 处正是评审在设计门阶段指出的风险（#8）。`test_keyframe_contracts.py` 把它变成机器可判定：
不只断言「两边都含新成员」，而是**解析出两个集合并断言完全相等**——
任何一边多/少一个成员都会红。

---

## 3. 负向对照（实跑，4 组全部精准变红）

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **NC1** | **只改 union、不改运行期数组**（正是该风险本身） | **2 failed** / 4 passed |
| **NC2** | 数组多一个 union 里没有的成员 | **1 failed** / 5 passed |
| **NC3** | 去掉 `thumbnail_bytes` 字段（破坏 A12 契约前提） | **1 failed** / 5 passed |
| **NC4** | 删掉一个失败码 | **1 failed** / 5 passed |

> NC1 是本切片最该被记住的一条：它证明这把锁**确实能抓到那个特定错误**，
> 而不是「碰巧全绿」。

---

## 4. 编排层：把三种「切点语义」一路传到底

S1b 已在纯函数层区分 `None` / `[]` / `[t…]`，本切片刻意验证它**没有被中途压平**：

| 用例 | 断言 |
|---|---|
| `test_no_analysis_returns_none` | 没分析过 ⇒ `None` |
| `test_analysis_without_cuts_returns_empty_list` | 分析过无切点 ⇒ `[]` |
| `test_non_ready_analysis_is_ignored` | `running` 状态不计数 ⇒ 降级为 `None` |
| `test_plan_mode_scene_cut_when_analysed_without_cuts` | 一路传到 `SamplingPlan.sampling_mode` 仍是 `scene_cut` |

**为什么非要这个区分**：合并它俩，「没做分析」就会被静默伪装成「分析过、没切点」，
这正是规划门 R8 登记的静默降级失败模式。

---

## 5. 端到端（真实 ffmpeg、真实素材）

`test_full_prepare_chain_end_to_end` 跑通「读切点 → 计划 → 真实编码 → 落预览」：

```
sampling_mode = scene_cut，covered_scene_cuts = 2
每帧 payload_bytes > thumbnail_bytes 且两套哈希不等
载荷真的落盘（payload_dir_bytes > 0）
```

---

## 6. 修掉的问题

### 6.1 契约块里混进了裸反引号

我用 ```` 做占位再替换，但替换文本本身含反引号，导致插入的 TS 块里出现
``/** 逐帧元数据。 ...  }```` 这样的伪模板串，`tsc` 报 `Cannot find name 'KeyframePreviewFrame'`。已去除。

### 6.2 契约包必须先构建，桌面端才看得到新导出

`@aivideo/contracts` 的 `exports` 指向 `dist/index.d.ts`。只改 `src` 不构建，
桌面端 `tsc` 报 `has no exported member 'parseKeyframeEgressPreview'`。
**顺序**：改 contracts `src` → `tsc -p packages/contracts` → 再 typecheck desktop。

### 6.3 通道白名单测试是**精确列表**断言

`stage2b-ipc.test.ts:15` 用 `toEqual([...])` 断言全部已注册通道。
新增通道必须同步该列表，否则 1 failed。这是设计如此（防悄悄多注册通道），不是脆弱测试。

### 6.4 `app.py` 的 37 个 ruff 错误是既有债

用 `git stash` 对拍确认：改动前后**同为 37 个**，且我用 `--output-format=concise` 过滤
`keyframe` 相关行**零命中** ⇒ 本切片未新增 lint 债。

---

## 7. 质量门

| 项 | 结果 |
|---|---|
| `pytest`（6 个关键帧套件 + 状态源 + bootstrap） | **110 passed** |
| `vitest run`（桌面全量） | **882 passed**（104 文件） |
| `tsc --noEmit`（contracts + desktop） | **通过** |
| `ruff`（本切片新增文件） | **All checks passed** |
| `pyright`（新增 Python 模块） | **0 errors** |

---

## 8. 未完成 / 移交

| 项 | 归属 |
|---|---|
| Desktop UI（按标签过滤 / 逐张审阅面板） | **S5a** |
| vision 适配器 + 能力探测（真实网关；探测也须走 claim） | **S3** |
| 打标作业分派 + 词表校验 + 落库 | **S4** |
| 盲评包 + 预登记 | **S5b** |
| A13 的打包产物验证（构建 release 后实跑编码） | 待构建 |

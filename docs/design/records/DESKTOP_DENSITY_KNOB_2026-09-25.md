# Desktop 密度旋钮呈现 —— 实施记录

> 实施：YeJing（Desktop），2026-09-25。验收：LiuKeAi。
> 承接：`CV_DENSITY_KNOB_IMPLEMENTATION_2026-09-24.md` §5 L1（ADR-0005 阶段 2 UI 面）。

## 0. 交付面

| 层 | 内容 |
|---|---|
| IPC | `cv-analysis:get` 可选 `target_gap_us` / `budget_per_minute_s`（钳制 100ms–60s / 1–120） |
| Preload / core-client | 同名可选字段透传 |
| UI | 分析入口改开选项框：默认一键 / 自定义间隔与预算 |
| 摘要 | 素材行显示 `密度 full/sparse`（诚实降级可见） |
| 测试 | `stage2b-ipc.test.ts` 旋钮透传 + 非法值拒绝 |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 默认不传旋钮行为不变 | ✅ | 「使用默认设置」只传 generate |
| 2 | 旋钮可选透传 Core | ✅ | IPC 用例 body 含 target_gap_us / budget_per_minute_s |
| 3 | 非法旋钮拒绝（不发 Core） | ✅ | 间隔 10µs / 预算 999 → throw 且 fetch 未增加 |
| 4 | 密度状态可见 | ✅ | `cvSummaryText` 显示 full/sparse |
| 5 | Desktop 回归 | ✅ | **708 tests passed** + typecheck |

## 3. 边界

- 未展示 `sampling_strategy`（在 job result，不在摘要 DTO）；需要时另接 jobs result 读取。
- 旋钮不持久化为用户偏好；每次分析显式选择或走默认。

## 4. 剩余范围

| # | 项 |
|---|---|
| L1 | 作业结果里的 sampling_strategy 呈现 |
| L2 | 用户默认密度偏好持久化 |

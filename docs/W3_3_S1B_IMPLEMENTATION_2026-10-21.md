# W3.3 S1b 实施记录 · 关键帧抽样决策

> **切片**：S1b（Design Gate §7，**纯函数、零 I/O、零 egress**）
> **上游**：规划门 §3.3（D7 + 评审 M2 冻结判据）/ Design Gate §3.1
> **日期**：2026-10-21

---

## 1. 交付

| 文件 | 行数 | 作用 |
|---|---|---|
| `media/keyframe_sampling.py` | 167 | 纯函数抽样：切点优先 / 间隔兜底 / 封顶 24 / 降级判定 |
| `tests/unit/test_keyframe_sampling.py` | 250 | **29 项**测试（含 5 组负向对照） |

---

## 2. 验收核对（映射 A5）

| 判据（规划门 §3.3） | 实现 | 结果 |
|---|---|---|
| k ≤ 24 ⇒ 全切点 + 间隔补齐至 24，covered == k | `cuts[:min(k,limit)]` + `_interval_fill` | ✅ 参数化 k=0/1/5/23/24 |
| k > 24 ⇒ 前 24 切点、**不补齐**，covered == 24 | 不进入 fill 分支 | ✅ 参数化 k=25/40/100 |
| 无 CV 分析 ⇒ sampling_mode='interval_only' | `sampling_mode_of` | ✅ |
| 无视频流 ⇒ unavailable(no_video) | **不在本切片**（S2 服务层） | — |

---

## 3. 一处必须区分、不能合并的语义（本切片核心设计）

规划门 §3.3 只写「无 CV 分析 ⇒ interval_only」，但实现时必须把**三种情况**分开：

| 输入 | 含义 | 采样模式 | covered |
|---|---|---|---|
| `None` | **没做过** CV 分析 | `interval_only` | 0 |
| `[]` | 分析过、**无切点** | `scene_cut` | 0 |
| `[t...]` | 分析过、有 k 个切点 | `scene_cut` | `min(k,24)` |

**为什么不能合并前两行**：若合并，「无分析」会被静默伪装成「分析过、没切点」，
用户与后续排查都看不出真实原因——正是本仓反复出现的**静默降级**失败模式
（规划门 R8 专门登记）。测试 `test_analysed_but_no_cut_is_still_scene_cut_mode` 钉死。

---

## 4. 负向对照（实跑，5 组全部精准变红）

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **NC1** | `sampling_mode_of` 恒返回 interval_only | **3 failed** / 26 passed |
| **NC2** | `covered = cut_count`（不封顶） | **6 failed** / 23 passed |
| **NC3** | 不过滤越界切点 | **1 failed** / 28 passed |
| **NC4** | `_interval_fill` 去掉取点封顶 | **3 failed** / 26 passed |
| **NC5** | 补齐分支改 `if False` | **1 failed** / 28 passed |

---

## 5. ⚠️ 如实登记：一处**结构上不可观测**的冗余防御

源码保留了 `if cut_count <= limit:` 分支。**改成 `if True:` 后 29 项测试全绿。**

**原因（不是测试写漏）**：k > limit 时 covered = limit，points 已含 limit 项
⇒ remaining = 0，而 `_interval_fill` 对 `limit <= 0` 直接返回 `[]`。
两条路径结果**逐字节相同**，不存在能让它变红的测试。

**处置**：保留分支（让代码字面复述门 §3.3 规则、便于评审对照），就地写明
「本分支在可观测行为上冗余、无测试守卫」，**不谎称它是独立守卫**。

> 与 **P149** 处置一致：当时 `worklist create` 守卫被实测证明与 `_start_next_step` 行为等价，
> 便在用例注释中如实标注而非假装有锁。**声明一个不存在的守卫比没有守卫更危险。**

---

## 6. 测试清单（29 项，节选分组）

| 组 | 代表性用例 | 覆盖 |
|---|---|---|
| 模式判定 | `test_analysed_but_no_cut_is_still_scene_cut_mode` | **k=0 ≠ 未分析** |
| A5 上界 | `test_covered_equals_k_below_limit`（5 档） | covered==k 且切点集合精确相等 |
| A5 下界 | `test_covered_caps_at_limit_above_limit`（3 档） | covered==24 且无 interval 帧 |
| | `test_above_limit_never_adds_interval_frames_even_when_room_exists` | 稀疏切点放大差异 |
| | `test_below_limit_does_fill_intervals` | **对照**：防「从不补齐」恒真 |
| 边界 | `test_out_of_range_cuts_are_discarded` / `test_duplicate_cuts_are_deduplicated` | 越界与重复 |
| 退化 | `test_zero_duration_yields_empty_plan` / `test_zero_limit_yields_empty_plan` | 空输入不抛错 |
| 封顶 | `test_frame_count_never_exceeds_limit`（6 档） | D7 统一封顶 |
| 裁剪 | `test_truncate_keeps_cuts_first` / `test_truncate_to_zero_is_empty_but_keeps_mode` | 切点优先、保留模式 |
| 跨模块 | `test_sampling_limit_matches_encode_max_frames` | 与 S1a MAX_FRAMES 一致 |
| 分层 | `test_module_has_no_io_imports` | 纯函数模块不得引 I/O |

---

## 7. 本轮修掉的两个自身缺陷

### 7.1 pyright 抓到真实类型错误

`if not cuts:` 分支里我把 `_interval_fill` 的返回（`list[int]`）赋给复用变量名
`points`（`list[tuple[int, str]]`）。运行时无害但类型错。已改名 `fills`。
**pyright 在这里比测试更早发现问题**——测试只验行为，不验类型。

### 7.2 测试路径依赖 cwd

`test_module_has_no_io_imports` 首版用相对路径读源码，从 `services/core` 启动即
`FileNotFoundError`——**本仓已有同类坑**（P66 修过「必须从仓库根运行」的隐藏假设）。已改 `__file__` 推导。

---

## 8. 质量门

| 项 | 结果 |
|---|---|
| `pytest test_keyframe_sampling.py` | **29 passed** |
| S1a+S1b+状态源+语义+CV 子集 | **119 passed** |
| `ruff check`（本切片 4 文件） | **All checks passed** |
| `pyright`（S1a+S1b 生产模块） | **0 errors, 0 warnings** |

---

## 9. 移交下一片

| 项 | 归属 |
|---|---|
| `no_video` 判定（无视频流 ⇒ unavailable，不登记必失败作业） | **S2** |
| 从 `cv_analyses` 读切点（`samples_for_range`） | **S2** |
| `sampling_mode` / `covered_scene_cuts` 落库 | **S2** |

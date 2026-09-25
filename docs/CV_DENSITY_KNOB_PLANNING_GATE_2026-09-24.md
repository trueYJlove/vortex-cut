# ADR-0005 阶段 2：预算约束下的密度旋钮 —— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接 `docs/adr/0005-cv-sampling-density-policy.md` **D1/D5 阶段 2**。
> 实施：ZhangSan（Core）；验收：LiuKeAi。
> 前置：阶段 1（`CV_SAMPLING_BUDGET_*`）已交付；P1/P2 护栏已核销且**必须保持绿**。
> 排序决策（2026-09-24）：本单先于 W0.4 补素材与 Desktop 语法层 UI——先把长 GOP 从
> 「诚实降级」做成「预算内尽量密」，给后续质量评测更真的信号；未验规则不暴露给用户。

## 0. 现状（阶段 1 之后）

`run_analysis_job` 仍是**二值**：

1. 快路径 `skip_frame=True`（仅 I 帧）；
2. `max_gap > CV_SAMPLE_GAP_FALLBACK_US`(4s) → 估算全量回退；
3. 估算超预算 → **不回退**，保留 I 帧样本，`density_status='sparse'`；
4. 估算通过 → 全量回退；deadline 中止 → **丢弃全部回退结果**，退回 I 帧样本。

长 GOP 4K60 HEVC 因此稳定落在 12 个 I 帧（5.4 s/分、`sparse`）——**诚实，但不密**。
ADR-0005 D1 要求把「全有 / 全无」换成**预算约束下的连续密度**。

### 0.1 物理约束（不可绕过，D4 否决依据仍成立）

| 采样目标 T vs GOP G | 成本 | 机制 |
|---|---|---|
| T ≥ G | 便宜 | 只解 I 帧即可 |
| T < G | ≈ 顺序全解 | 帧间依赖，必须从 I 帧解到目标帧；**定点 seek 更慢（D4）** |

**采样间隔本身几乎不降低顺序解码墙钟**——`select` 仍要解出每一帧才能丢弃。
因此「中间粒度」若只调 `MIN_SAMPLE_INTERVAL`，**买不到墙钟**，只是少落几个样本。
真正的连续杠杆只有两根：

- **A. 时间覆盖**：全量解码跑满剩余预算，未覆盖尾部用 I 帧兜底（预算买多少密度就出多少）；
- **B. 解码层级**：`skip_frame` 档位（`nokey` / `nonref` / `none`）——少解帧，密度与成本同降。

本单以 **A 为主、B 为实测可选增强**；采样间隔作为发射粒度旋钮暴露，但**不假装它能省钱**。

## 1. 范围

### 1.1 必须实现

1. **纯函数 `select_sampling_plan`**（单测主对象）：
   输入 `target_gap_us / duration_us / video_stream / remaining_budget_s / elapsed_s`
   → 输出计划 `{strategy, sample_interval_us, projected_s, reason}`。
   `strategy ∈ {"iframe_only", "budget_capped_full", "full"}`。

2. **策略语义**：
   - `iframe_only`：现状快路径（`skip_frame=True`）；
   - `full`：全量解码 + 发射间隔 `sample_interval_us`（默认对齐 `MIN_SAMPLE_INTERVAL`）；
   - `budget_capped_full`：**阶段 2 的连续密度核心**——全量解码带
     `deadline = remaining_budget`，超时后**保留已采密集样本**，与快路径 I 帧样本
     **按时间轴合并**（密集段优先；未覆盖段用 I 帧），不再整段丢弃。

3. **旋钮暴露（接 STATUS §5「CV 采样密度参数暴露」）**：
   `CvAnalysisRequest` 增**可选**字段（`extra="forbid"` 下新增，默认值 = 现模块常量）：
   - `target_gap_us`：目标最大采样间隔（钳制到 `[MIN_SAMPLE_INTERVAL_US, CV_SAMPLE_GAP_FALLBACK_US]` 以外也允许更粗，见 §2.2）；
   - `budget_per_minute_s`：每分钟墙钟预算（钳制到 `[CV_BUDGET_FLOOR_S 分钟折算, …]` 与既有 floor/cap 一致）。
   不传 = 行为与阶段 1 默认一致。**PROTOCOL_VERSION 不动**（增量可选）。

4. **`algorithm_version` 递增 2 → 3**（ADR D1 明文要求：采样策略语义变化）。
   同步 `docs/STATUS.md` §1 `cv_algorithm_version`。

5. **合并边界诚实性**：`achieved_max_gap_us` / `density_status` 按**合并后**样本集计算；
   合并点若造成 > threshold 的空洞，如实 `sparse`。

6. **P1/P2 保持绿**（sha256 对拍 + 长 GOP 回退触发）；语义若因合并改变，只允许
   在 `budget_capped_full` / 中止路径变化，**非回退短 GOP 双路径仍须逐字节一致**。

7. **契约**：响应 DTO 增 `strategy` / `target_gap_us`（增量可选）；摘要可带。

### 1.2 明确不做

- **定点补洞 / seek 填空**——ADR-0005 D4 否决，不得回潮；
- **硬件解码**——阶段 3；
- **Desktop 密度 UI**——旋钮先落 API/核心；界面与语法层 UI 同属 YeJing 后续小单；
- **改镜头边界/运动/清晰度算法**——`frame_signals` 不动；
- **改 `density_status` 三值语义**——仍 `full`/`sparse` 二值（判据见阶段 1 §2.5）；
- **跳过 P1/P2 或弱化其断言**。

### 1.3 可选增强（实施时一票否决即可）

- **`skip_frame nonref` 中间档**：在 `iframe_only` 与 `full` 之间插入 I+P 解码。
  仅当实测证明「密度提升显著且墙钟低于 full」才纳入 `select_sampling_plan`；
  否则本单不引入第三档，避免未标定的中间态。

## 2. 设计要点

### 2.1 计划选择（伪代码）

```
remaining = max(budget_s - elapsed_s, 0)
full_cost = project_full_decode_s(duration_us, video_stream)   # 阶段 1 模型

if full_cost <= 0:
    # 无法估算 → 交给 deadline 兜底（与阶段 1「可承受」分支一致）
    strategy = "full" if remaining > 0 else "iframe_only"
elif full_cost <= remaining:
    strategy = "full"
elif remaining >= CV_BUDGET_FLOOR_S * 0.25:   # 仍值得尝试一段密集
    strategy = "budget_capped_full"
else:
    strategy = "iframe_only"
```

`target_gap_us` 只影响 `sample_interval_us`（发射粒度）与「是否值得追密」：
若 `target_gap_us ≥ gap_threshold` 且快路径 `max_gap ≤ target_gap_us`，直接 `iframe_only`（已达标）。

### 2.2 合并语义（`budget_capped_full`）

- 密集样本来自顺序全解的前缀 `[0, t_abort)`（FFmpeg 顺序语义）；
- 快路径 I 帧样本覆盖全片；
- 合并规则：
  1. `[0, t_abort)` 内以密集样本为准，去掉落在密集样本 `±target_gap/2` 内的 I 帧重复点；
  2. `[t_abort, end)` 保留 I 帧样本；
  3. 合并后按 `timestamp_us` 排序；
  4. **缝合点 `motion_energy` 不重算**（两段各自的「前帧」语义不同）——
     缝合点样本的 `motion_energy` 标记为来自哪一段即可，不引入假的帧间差；
     简单实现：保留原值，并在 rationale/日志不声称跨缝合运动连续。
- `achieved_max_gap_us` / `density_status` 一律按合并后集合计算。

### 2.3 旋钮钳制

| 参数 | 默认 | 钳制 |
|---|---|---|
| `target_gap_us` | `CV_SAMPLE_GAP_FALLBACK_US`（4s）——**是否追密**的判据，对齐阶段 1 盲区阈值，不传旋钮时决策面不变 | `[100_000, 60_000_000]`；全量发射间隔 = `min(MIN_SAMPLE_INTERVAL_US, target)` |
| `budget_per_minute_s` | `CV_PER_MINUTE_BUDGET_S`（10） | `[1.0, 120.0]`；总预算仍过 floor/cap |

非法值 → 契约层 422（`extra="forbid"` 严格风格，pydantic `Field` 约束）。

### 2.4 版本与存量

- `CV_ALGORITHM_VERSION = 3`：新分析只写 v3 行；v2 ready 行变「历史」，
  `analysis_summary` 已按当前版本优先——行为符合既有 stale/历史语义；
- **不迁移回填 v3**——重分析由用户/作业显式触发（与既有「单版本单行」一致）；
- `STATUS.md` §1 `cv_algorithm_version`: 2 → **3**（同变更机器校验）。

## 3. 验收（LiuKeAi）

### 3.1 单测

1. `select_sampling_plan`：full 可负担 / 预算不足走 `budget_capped_full` / 预算近零走 `iframe_only` / 无法估算分支；
2. 合并：密集前缀 + I 帧尾部；重复点剔除；`achieved_max_gap` 按合并集；
3. 钳制/拒绝：`target_gap_us`、`budget_per_minute_s` 非法路径；
4. 默认不传旋钮时行为与阶段 1 策略决策**一致**（同预算、同素材 → 同 strategy 选择）；
5. `frame_signals` 与算法常量（除版本号）不变；
6. `CV_ALGORITHM_VERSION == 3` 且 STATUS §1 同步（`test_status_doc_consistency`）。

### 3.2 集成（合成 + 既有真实素材路径）

1. **P1 保持绿**：短 GOP 双路径逐字节一致（含反向对照）；
2. **P2 调整面**：长 GOP 在「预算充足」下仍触发全量并 `density_status=='full'`；
   预算压到中档时走 `budget_capped_full`，合并后 `sample_count` **> 纯 I 帧数**，
   且墙钟 ≤ 预算 × 1.2（deadline 误差带）；
3. 4K60 长 GOP：默认预算下不得回退到 40.5 s/分 量级；`sparse` 或 `full` 如实；
4. 零 egress 断言保持。

### 3.3 性能

| 项 | 目标 |
|---|---|
| 4K60 长 GOP 默认预算 | ≤ 10 s/分（与阶段 1 一致或更好） |
| `budget_capped_full` 中档预算 | 合并样本数 > I 帧数，墙钟 ≤ 预算 |
| 1080p 常态 / lichun | 不回归 |

### 3.4 契约与隐私

- `PROTOCOL_VERSION` 不动；请求/响应新字段可选；
- 零 egress；无新迁移（除非实施中发现必须落库 `strategy`——若要加列则走迁移 v27 并登记）。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 合并缝合点运动能量失真 | 不重算、不声称连续；后续评测单独看缝合点 |
| 旋钮被 UI 过早暴露 | 本单不接 Desktop；契约可选字段先落地 |
| 版本递增触发全量重分析负担 | ADR 明文要求递增；v2 行保留可查，不强制迁移 |
| `budget_capped_full` 与 P2「回退触发」断言纠缠 | P2 断言的是「预算充足时仍全量」；预算不足路径用新策略名断言 |
| 实测 `nonref` 无收益却硬塞第三档 | §1.3 一票否决，默认不纳入 |

## 5. 开放问题（实施裁决，ZhangSan）

1. 合并点是否在样本行加 `source` 字段（`dense`/`iframe`）？——倾向**不加列**，
   避免迁移；若调试需要可只进 job result JSON。
2. `target_gap_us` 超粗（如 10s）是否仍强制 gap_threshold 判 `sparse`？——
   **是**：`gap_threshold` 判据不变（阶段 1 §2.5），目标粗只代表用户接受稀，
   不改 `full/sparse` 对「盲区」的定义；调用方看 `achieved_max_gap_us`。
3. `nonref` 档：默认跳过；若实现中 30 分钟内可验证收益再纳入。

## 6. 登记

本单承诺将登记为 `STATUS.md` §4 新行（工作包），完成后按验收核对表核销。

# CV 信号采样策略与预算控制规格（ADR-0005）

> 本文合并原 `CV_SKIP_FRAME`（快路径）、`CV_SAMPLING_BUDGET`（预算与诚实降级，阶段 1）与 `CV_DENSITY_KNOB`（密度旋钮，阶段 2）三份规划门。
> 决策背景见 [`ADR-0005`](../design/adr/0005-cv-sampling-density-policy.md)；当前算法版本号与已交付能力边界见 [`../STATUS.md`](../STATUS.md) §1/§3。

---

## 1. 核心约束与三层策略演进

`select` 滤镜位于全量解码之后，长 GOP 高分辨率素材（如 4K60 HEVC GOP 5s）顺序解码代价极高，而定点 seek 补洞因帧间依赖更慢（已由 ADR-0005 D4 实测否决，**禁止重新引入**）。因此采样架构分三阶段锁定：

1. **快路径 + 稀疏检测**：默认用 `-skip_frame nokey` + 纯 I 帧采样；计算相邻采样点最大间隔 `achieved_max_gap_us`，未超阈值 `CV_SAMPLE_GAP_FALLBACK_US`（4s）即完成。
2. **成本预算 + 硬 Deadline（阶段 1）**：`budget_s = clamp(duration_min × PER_MINUTE_BUDGET_S, FLOOR_S=15, CAP_S=300)`（默认每分钟 10s）。用静态吞吐估算模型（`h264: 894e6 px/s`，`hevc/未知: 331e6 px/s`）预测全量回退成本，结合作业/回退独立取消事件 `fallback_cancel`（严禁把用户作业取消误判为回退中止）。
3. **预算内连续密度与旋钮（阶段 2）**：`select_sampling_plan` 根据剩余预算在 `iframe_only` / `budget_capped_full` / `full` 间决策；`budget_capped_full` 超时后**保留已采密集前缀样本**并与尾部 I 帧样本按时间轴合并（取代早期的整段丢弃）。

---

## 2. 密度诚实性与数据契约

- **`cv_analyses` 密度字段（迁移 v23）**：
  - `density_status`：`full`（`achieved_max_gap_us ≤ gap_threshold_us`）或 `sparse`（`achieved_max_gap_us > gap_threshold_us`，如实标出存在 > 阈值盲区）。
  - `gap_threshold_us`（快照）、`achieved_max_gap_us`、`wall_clock_ms`。
- **缝合边界规则**：`budget_capped_full` 合并密集前缀与尾部 I 帧时，不重算跨缝合点 `motion_energy`，也不声称跨缝合运动连续；`achieved_max_gap_us` 与 `density_status` 一律按**合并后**样本集诚实计算。
- **可选请求旋钮（`CvAnalysisRequest`，`extra="forbid"`，`PROTOCOL_VERSION` 不变）**：
  - `target_gap_us`：默认 `CV_SAMPLE_GAP_FALLBACK_US`（4s），钳制 `[100_000, 60_000_000]`；
  - `budget_per_minute_s`：默认 `CV_PER_MINUTE_BUDGET_S`（10），钳制 `[1.0, 120.0]`。
- **召回层消费**：`_cv_scenes` 对 `density_status='sparse'` 的分析降权（不排除，具体权重以测试钉死）。
- **算法版本与同步**：策略语义变化已同步推进 `CV_ALGORITHM_VERSION`（现值见 [`../STATUS.md`](../STATUS.md) §1），修改常量或版本号必须同步更新 `STATUS.md` §1。

---

## 3. 回归守卫（不得弱化）

1. **短 GOP 双路径逐字节一致**：快路径与全量路径输出 sha256 一致（含反向对照）。
2. **长 GOP 预算控制**：默认预算下 4K60 长 GOP 墙钟 ≤ 10 s/分，如实标记 `sparse`；预算充足时长 GOP 仍可触发回退并达到 `full`；`budget_capped_full` 合并样本数 > 纯 I 帧数。
3. **中途取消清理**：`analyze_video` 置位取消事件后须立即终止 `ffmpeg` 子进程、抛 `JOB_CANCELLED` 且无孤儿进程。
4. **隐私不变量**：全链路零网络 egress。

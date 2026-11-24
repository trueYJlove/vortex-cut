# D11 解码驻留上限与 Electron 升版验证摘要（2026-09）

> **历史汇总。** D11 两步实测合并于此；规划与登记基线见 `PERFORMANCE_D11_RESIDENCY_CEILING_PLANNING_GATE_2026-09-14.md`。详细原始轮次仍在 `evidence/performance/d11-*`，当前状态见 [STATUS.md](../STATUS.md)。

| 步骤 | 方法与结果 | 结论 |
|---|---|---|
| 显式驻留上限与预警验证 | 以约 631KB/unique frame 估算池占用；F02 27,000 帧正向样本 3/3 触发约 15.8GiB 预警，F01 360 帧负向样本 3/3 不触发。预测相对 G0 16.6GiB 实测偏差 −4.8%，在 ±25% 门内。 | 天花板模型与用户可见预警成立；该轮只改 harness/文档，产品代码零改动。 |
| Electron 36→44 驻留池对拍 | 相同 F02P 负载、5 轮 off/on；on 中位从 16,649MB 到 16,583MB，差 −66MB（−0.40%），远低于 ±5% 命中门，轮次窄带稳定。Chromium 136→152 未改变驻留池高水位。 | 升级 Electron 不会移动本轮测得的池上限，按门接受显式上限路线；未另跑 flags 轮，因版本对拍已覆盖该问题。 |

## 兼容性副产物与证据

Electron 44 对 `aivideo://` 的 renderer `fetch` 执行 CORS 校验，导致合成预览装配失败；bench 对照确认 `registerSchemesAsPrivileged` 增加 `corsEnabled: true` 后恢复。该兼容发现应在后续 Electron 升级时核对，不代表本报告已把 bench 改动合入产品。

原始证据位于 `evidence/performance/d11-residency-warn-20260914/`、`d11-residency-warn-f01-20260914/`、`d11-electron44-20260914/` 与 `d11-e44-smoke-f01/`。测试读数是 2026-09 当时的历史结果。

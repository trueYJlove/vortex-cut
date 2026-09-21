# DeepSeek Patch 链路复跑验证报告——2026-09-21

> 执行：LiuWei（授权 AI 代理），2026-09-21。承接
> `AI_VALIDATION_REPORT_2026-09-20.md` 遗留项 4（patch 探测网关慢滴挂起）与
> "deepseek patch 探测复跑（等网关稳定）"。
> 前提差异：本次运行已包含 Provider 韧性工作单（`2f3de00`：探测总预算 deadline
> + 网络错误重试）与 e2e 单（`2a1218a`：probe v2 契约对齐 + agent_session
> 水合修复）。真 provider 配置组不变（`AIVS_REAL_PROVIDER_*`，deepseek-v4.1-flash
> @ apikey.fun），本次经进程环境 `AIVS_REAL_PROVIDER_ENABLED=1` 显式启用。

## 1. 运行结果总览

| 项 | 结果 | 说明 |
|---|---|---|
| 实验 A（CV 信号墙钟） | 3 素材全 ready | dance 11.4s/168s（4.1s/分，skip_frame 混合自适应生效，对照 9-20 的 19.5s/分 **优化 4.8 倍**） |
| candidate 探测 | **supported** | 适配器 candidatescript（chat completions 族） |
| **patch 探测** | **supported** ✅ | 适配器 **patchscript**（见 §2）；**9-20 遗留的挂起未复现**——韧性工作单的总预算+重试下，400 类确定性失败与抖动均正常收敛 |
| 实验 B（CV 召回三候选） | 成功 | balanced 26.4s / compact 30.7s / bold 31.9s，CV 召回链路稳定 |
| 实验 C（多步 agent 会话） | **会话中止** | 首步业务调用 `PROVIDER_INVALID_RESPONSE`（见 §3） |

**patch 探测复跑结论：通过**。上次"网关慢滴挂起拖死 sidecar"未复现；探测在
产品侧总预算（120s）与脚本兜底（300s）内正常终结，网络类失败由重试机制吸收。

## 2. 关键发现 1：网关 json_schema 结构化输出不可用（环境限制）

直接对网关复刻探测请求验证：

- `response_format: json_schema`（json_schema 族适配器的标志）→ 网关
  **HTTP 400**：`This response_format type is unavailable now`。
- 400 映射为 `PROVIDER_UNAVAILABLE`（可重试类）→ 重试 3 次 → 依适配器声明
  顺序降级 → **patchscript 适配器**（不带 response_format）探测成功。
- 即：探测协商逻辑按设计工作，`supported` 记录的 patchscript 是网关能力下
  的正确选择（对照 9-20 报告 json_schema 命中——网关行为已变化）。

## 3. 关键发现 2：实验 C 中止的根因 = 模型多吐字段，非产品缺陷

- patchscript 业务调用实测：deepseek 首步输出 `trim_clip` 时额外携带
  `timeline_start_us`/`timeline_end_us` 两个字段 → `_validate_operation`
  严格域校验（`set(operation) != required`）拒绝 → `PROVIDER_INVALID_RESPONSE`
  → 会话中止。
- **与设计一致**：AI-1 规划门 §4 已载明 patchscript 适配器"多轮反馈注入复杂，
  降级为 message 文本"；provider 解析层失败属确定性失败不参与反馈重试
  （反馈重试覆盖的是 apply 层域错误——`test_session_converges_after_structured_
  feedback` 覆盖）。**无反馈机会即中止是当前设计**，失败会话对用户零副作用
  （无 partial Revision，验证：本 run `agent_steps` 空、Revision 链干净）。
- **可修复性实测**：在 system prompt 中显式枚举 `trim_clip` 允许字段后重发
  同 payload → 模型输出收敛 → `parse_patchscript` 通过（实网 200）。

## 4. 后续工作单（登记）

1. **patchscript 字段纪律提示词迭代**（Core，小单）：`_generate_adapter` 的
   patchscript instructions 当前只说 "only the operation fields allowed by
   the scenario"，未按 op 枚举字段清单；deepseek 类模型在 trim 场景自然多吐
   timeline 字段。将 `_PATCH_FIELDS` 的字段清单注入 system prompt（模板化
   生成，无需硬编码枚举）即可实测收敛。验收：deepseek 实验 C 收敛 succeeded。
2. **可选**：json_schema 400 的网关侧反馈可考虑在错误信息中带
   "response_format 不可用，探测已自动降级 patchscript"的提示（UX 单，不急）。

## 5. 对路线的结论

- **Provider 韧性工作单实测兑现**：慢滴挂起未复现、确定性失败正常短路、
  网络抖动被重试吸收。
- **patch 探测链路（9-20 遗留）正式闭环**：candidate + patch 双 supported。
- **AI-1 agent 管线真实世界状态**：受控环境（e2e `2a1218a`）已全链验证
  succeeded + 反馈收敛；真实 deepseek 环境的中止是网关 json_schema 能力缺失
  与模型字段纪律的组合环境限制，产品行为符合设计。待 §4.1 小单落地后复跑
  实验 C 即可闭环。
- **分支合并条件已满足**（e2e + 验收 + 本次复跑结论），建议走 PR 合入 master。

## 附：本次运行环境

- 脚本：`tools/validation/run_validation.py`（`AIVS_REAL_PROVIDER_ENABLED=1`
  进程级启用，注册表配置组未改动）
- 原始数据：`.validation/report.json` + `.validation/app.db`（不入库）
- CV 性能对照：dance 19.5s/分（9-20）→ 4.1s/分（本次，skip_frame 混合自适应
  `a349866` 落地后）——**4.8 倍加速实测兑现**

# captions Provider 响应适配器阶梯——Planning Gate

> 当前状态以 [`../STATUS.md`](../STATUS.md) 为准。本门只裁决方向与边界，不声明真实 Provider 已交付。

## 1. 背景：一次被误诊的失败

`WORKLIST_CAPTIONS_PROVIDER_EGRESS_IMPLEMENTATION_2026-10-03.md` 之后，使用用户授权环境凭据执行了
真实 captions capability probe，结果记为 `CAPTIONS_PROVIDER_PROVIDER_NETWORK_ERROR`，并被归因为
"endpoint 网络不可达"（见 `REAL_PROVIDER_VERIFICATION_2026-10-03.md` 原始结论）。

2026-10-05 复核推翻了该归因。三个原始证据都不成立：

| 原始证据 | 复核结论 |
|---|---|
| `Test-NetConnection` 返回 false | 该命令只做**直连** TCP，不读系统代理，对"经代理可达性"无证明力 |
| "进程无 proxy 环境变量" | Core 的 `proxy_mode=system` 走注册表 `Internet Settings`（`config.py` 的 `resolve_provider_proxy`），本就不依赖环境变量 |
| captions probe 失败 | 当时脚本已硬编码 `http://127.0.0.1:10809`，不存在"未走代理" |

复核实测（本机 HTTP 代理 `127.0.0.1:10809` 可用）：

| 检查 | 结果 |
|---|---|
| `curl --noproxy '*'` 直连 | `000`（超时） |
| `curl -x http://127.0.0.1:10809` | `401`（可达） |
| `resolve_provider_proxy(Settings())` | `http://127.0.0.1:10809` |
| `GET /v1/models` 经代理 | `200` |
| `POST /chat/completions` + `json_schema` | **`400`** `This response_format type is unavailable now` |
| `POST /responses` + `json_schema` | **`502`** |
| `POST /chat/completions` + `json_object` | `200` |
| `POST /chat/completions` 无 `response_format` | `200` |

**真实阻塞**：该网关不支持 `json_schema` 结构化输出，而 captions 路径恰好固定走该适配器。

## 2. 机制性根因

仓库中 `timeline_patch` 与 `candidate` 两条 Provider 路径都使用同一套**适配器阶梯**：

| 机制 | timeline_patch | candidate | captions（改造前） |
|---|---|---|---|
| 按声明顺序遍历候选适配器 | ✅ `TIMELINE_PATCH_ADAPTER_IDS` | ✅ `CANDIDATE_ADAPTER_IDS` | ❌ 不传 `response_adapter_id` |
| 持久化选中的适配器 | ✅ `timeline_patch_response_adapter_id` | ✅ `candidate_response_adapter_id` | ❌ 无此列 |
| 持久化失败码 | ✅ `..._failure_code` | ✅ `..._failure_code` | ❌ 无此列 |
| 持久化 probe 哈希 | ✅ `..._probe_sha256` | ✅ `..._probe_sha256` | ❌ 无此列 |
| 网络类错误重试 | ✅ `RETRYABLE_PROVIDER_ERRORS` | ✅ 同 | ❌ 无重试 |

`database_v30.py` 只为 captions 增加了 `status` 与 `tested_at` 两列；
`captions_provider_egress.py` 虽算出了 failure code 与 digest，**却从未写库**。

这直接解释了误诊：captions 的失败原因无处落地，只剩一个笼统错误码，
无法区分"网络不可达"与"网关拒绝该 `response_format`"。

同一网关行为在 `providers.py` 的 `_generate_adapter` 注释中**早有记录**
（2026-09-21：网关 `json_schema` 400 后 timeline patch 改用 patchscript 适配器绕开
`response_format`）。captions 路径重复了同一课，但没有接入既有机制。

## 3. 裁决

**captions 路径接入既有适配器阶梯，不新增第三套机制。**

理由：

1. **有先例**：2026-09-21 对 timeline patch 的处置即为"降级到 script 适配器"，captions 只是补课；
2. **机制现成**：探测循环、重试分流、持久化列与不变量触发器均已存在，照抄即可；
3. **不牺牲能力**：`json_schema` 仍是阶梯首档，对支持它的网关保留最强结构化约束；仅在不支持时落到 script 档；
4. **拒绝"仅换 `json_object`"作为独立方案**：`json_object` 只保证"是 JSON"，不保证符合 schema——
   它不是把约束从网关移到本地，而是让约束**消失**，最终仍靠 `validate_captions_provider_value` 兜底。
   若采用，必须作为阶梯的**最后一档**，而非独立实现。

## 4. 验收项

| # | 验收项 | 判据 |
|---|---|---|
| A1 | captions 探测按声明顺序遍历适配器阶梯，首个通过者被持久化 | 单测：首档失败 → 次档成功 → 落库为次档 |
| A2 | 失败码、probe 协议版本、probe 哈希真实落库 | 单测：查询 `provider_configs` 断言三列非空/取值 |
| A3 | 网络类错误重试、schema 类错误不重试 | 单测：`RETRYABLE_PROVIDER_ERRORS` 分流行为 |
| A4 | 能力不变量由数据库触发器强制 | 单测：非法状态组合（supported 但无 adapter / unsupported 但 adapter 非空）被 ABORT |
| A5 | 既有 v30 语义不被破坏 | 既有 `test_captions_provider_egress.py` 回归通过（按新不变量更新 seed） |
| A6 | 生成路径使用已选适配器，不得回退到未探测的适配器 | 代码审查 + 单测：`claim_for_runner` 返回已选 adapter |

## 5. 风险对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | **推理模型 token 预算耗尽导致空 content**：实测该网关模型先输出 `reasoning_content`，`max_tokens=900` 时 2/3 次 `finish_reason=length` 且 `content` 为空 | 登记为风险（见 §6）；`finish_reason=length` 且 content 为空须归为**确定性 schema 失败**而非网络失败，且不重试；后续切片评估显式 `max_tokens` 下限 |
| R2 | 新增适配器扩大 Provider 输出面 | script 解析器严格框定、不修复不提取，解析失败即 `PROVIDER_INVALID_RESPONSE`；不得放宽 `validate_captions_provider_value` |
| R3 | 阶梯探测放大网络调用次数 | 探测有总预算 `PROBE_TOTAL_BUDGET_SECONDS` 兜底；schema 类失败立即跳出，不重试 |
| R4 | 旧数据（改造前探测出的 supported/unsupported）语义不可信 | 迁移 v34 将既有 `supported`/`unsupported` 行重置为 `untested`（对齐 v22 先例） |

## 6. 登记

本门登记为 `STATUS.md` §4 **P42**（工作包），R1 单独登记为 **P43**（风险对策），
R4 的迁移与不变量随实现切片登记为 **P44**。

任何迁移、协议、白名单变化必须同步更新 `STATUS.md` §1。

## 7. Gate 结论

Planning Gate 通过，允许进入 Design Gate 冻结适配器 ID、captionscript 语法、迁移列与错误码。
真实 Provider 端到端调用仍属于 Verification Gate，不可由 mock 代替。

## 变更记录

- 2026-10-05：首次冻结；修正 2026-10-03 的网络不可达误诊。

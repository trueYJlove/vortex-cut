# Real Provider Verification Record — 2026-10-03

> 本记录只归档安全结果码和网络元数据，不包含 API key、raw request/response、字幕文本或 Provider secret。当前状态以 `STATUS.md` 为准。

## Authorization and credential handling

- 用户明确授权使用已有环境凭据；凭据仅通过用户级环境变量读取，未打印、未写入仓库、未写入日志或测试证据。
- 真实调用脚本：`tools/run_real_provider_once.ps1 -Run`。
- captions schema probe 使用临时进程环境注入，脚本只输出安全结果码。

## Results

| Check | Result |
|---|---|
| Real Provider candidate verification | `failed`, safe code `RUNNER_RESULT_UNCLASSIFIED`; pytest started, no pass/fail detail persisted here to avoid raw Provider output leakage |
| captions `caption-text-output-v1` probe | failed, safe code `CAPTIONS_PROVIDER_PROVIDER_NETWORK_ERROR`（**已修正**，见下节：复跑实际为 `CAPTIONS_PROVIDER_PROVIDER_CONTENT_REJECTED`） |
| endpoint metadata | HTTPS, host `api.apikey.fun`, port 443, path `/v1` |
| TCP reachability | failed (`Test-NetConnection` false) — **该检查无效**，见下节 |
| API key exposure | none observed |
| proxy configuration | no process proxy variables available |

## 修正记录（2026-10-03 复核）

本节取代上面「Conclusion / Next action」中把失败归因于网络不可达的结论。原结论的三个证据都不成立：

1. `Test-NetConnection` 只做**直连** TCP，不读系统代理，因此它对"经代理可达性"没有证明力。
2. 「没有 proxy 环境变量」不等于「没有代理」。Core 的 `proxy_mode=system` 走注册表
   `Internet Settings`（`services/core/src/aivs_core/config.py` 的 `resolve_provider_proxy`），
   不依赖环境变量；Python 侧实测能解析出 `http://127.0.0.1:10809`。
3. 当时的 captions probe 脚本本身已硬编码该代理地址，并不存在"未走代理"。

复核实测（本机 v2rayN/Xray 在 `127.0.0.1:10809` 提供 HTTP 代理）：

| 检查 | 结果 |
|---|---|
| `curl --noproxy '*'` 直连 `/v1/models` | `000`（超时，exit 28） |
| `curl -x http://127.0.0.1:10809` 同一 URL | `401`（可达，仅缺凭据） |
| `resolve_provider_proxy(Settings())` | `http://127.0.0.1:10809` |
| `GET /v1/models` 经代理（带凭据） | `200` |
| `POST /chat/completions` 带 `response_format: json_schema` | **`400`** |
| `POST /chat/completions` 带 `response_format: json_object` | `200` |
| `POST /chat/completions` 不带 `response_format` | `200` |

Provider 对 `json_schema` 的原文响应为
`This response_format type is unavailable now`，三个可用模型（`deepseek-v4.1-flash`、
`deepseek-v4-pro`、`deepseek-flash`）表现一致。

**真实阻塞**：网关不支持 `json_schema` 结构化输出，而两条失败路径都恰好走该适配器：

- captions probe：`CaptionsProviderEgressService.test_capability` 构造的
  `StructuredTextRequest` 不带 `response_adapter_id`，因此落入
  `OpenAICompatibleTextProvider._generate_inner` 的 `response_format: json_schema` 分支；
  网关返回 400 后按 `providers.py` 的映射归为 `PROVIDER_CONTENT_REJECTED`。
- real provider runner：`AIVS_REAL_PROVIDER_EXPECTED_ADAPTER=openai_chat_completions_json_schema_v1`
  同样使用 `json_schema`。

同一网关行为在 `services/core/src/aivs_core/providers.py` 的 `_generate_adapter`
注释中已有记录（2026-09-21：网关 `json_schema` 400 后 timeline patch 改用
`patchscript` 适配器绕开 `response_format`）。captions 路径目前没有对应的 script
适配器（`ADAPTERS` 中仅有 `*_patchscript_v1` / `*_candidatescript_v1`），因此在该
网关上无法通过 capability probe。

## Conclusion

真实 Provider 验证未通过，根因是**网关不支持 `json_schema` response_format**，
不是网络不可达、不是代理缺失、也不是凭据问题。网络与代理链路经复核可用。
没有修改 Provider capability 为 supported，也没有创建真实 Provider generation、
Revision 或发布声明。

## Next action

已按 Planning/Design Gate 流程落地修复：captions 路径接入既有适配器阶梯
（`CAPTIONS_ADAPTER_IDS`，`json_schema` 首档 → `captionscript` 兜底），
并补齐失败码/probe 哈希落库与状态不变量。详见
`WORKLIST_CAPTIONS_PROVIDER_ADAPTER_PLANNING_GATE_2026-10-05.md` /
`WORKLIST_CAPTIONS_PROVIDER_ADAPTER_DESIGN_GATE_2026-10-05.md`。

真实 Provider 端到端两步调用与 Electron 验收仍属于 Verification Gate。
凭据仍应通过环境变量或设置界面注入，不要粘贴到聊天或代码。

## 修复后真实 Provider 复测（2026-10-05）

以 `app.py` 的生产接线（`resolve_provider_proxy` + 注入代理的 client factory，
`trust_env=False`）调用 `CaptionsProviderEgressService.test_capability`，使用同一
用户授权凭据与同一网关：

| 检查 | 结果 |
|---|---|
| `resolve_provider_proxy(Settings())` | `http://127.0.0.1:10809` |
| 阶梯第 1 档 `openai_chat_completions_json_schema_v1` | 网关 400 → `PROVIDER_CONTENT_REJECTED`（确定性，不重试） |
| 阶梯第 2 档 `openai_chat_completions_captionscript_v1` | **通过** |
| 落库 `captions_provider_capability_status` | `supported` |
| 落库 `captions_provider_response_adapter_id` | `openai_chat_completions_captionscript_v1` |
| 落库 `captions_provider_probe_protocol_version` | `1` |
| 落库 `captions_provider_capability_failure_code` | `NULL` |

结论：captions capability probe 在真实网关上**首次通过**，且选中的适配器与失败
原因均已可持久化、可区分。这同时验证了 §2 的机制性根因判断——原失败是网关拒绝
`response_format`，而非网络不可达。

仍未完成：Desktop consent/Diff 与 Electron 端到端验收。

## 真实全链路复测（2026-10-05，Slice 4 之后）

补齐真实 runner 与 job 接线后，用生产接线（`resolve_provider_proxy` + 注入代理的
client factory + 真实 `JobService._run` 分派）跑通完整链路。输入为**冗长的口语 ASR
文本**（35 / 32 字），`max_chars_per_caption=24`：

| 步骤 | 结果 |
|---|---|
| 1. capability probe | `supported` / `openai_chat_completions_captionscript_v1`（第 1 档 json_schema 被网关 400 拒绝 → 第 2 档选中） |
| 2. create | generation `queued`，同时原子落 `provider_invocations`（`capability=captions_provider_generation`）与可调度 `jobs` 行 |
| 3. 真实 Provider 调用（经 `JobService._run` 分派） | job `succeeded` / generation `succeeded` / invocation `succeeded`，`provider_may_have_processed=0` |
| 4. 输出（Core 严格校验后规范化落库） | `s1 → 先看今天天气再决定是否出门玩`（14 字）、`s2 → 去公园散步看风景拍照留念`（12 字） |
| 5. proposal | 2 条 `update_caption`，caption_id 与时间码**全部由 Core 绑定** |
| 6. 显式 apply | 新 Revision 落库，`projects.current_timeline_revision_id` 指向新 Revision，`captions_provider_proposal_applications` 有记录 |

关键证据：模型把 35 / 32 字的 ASR 长句**真正压缩**为 14 / 12 字字幕（非回声），
证明真实生成而非占位。另有一次实测中模型对已合规短句原样回显，
`create_proposal` 按预期 fail-closed 抛出 `CAPTIONS_PROVIDER_PROPOSAL_EMPTY`——
该守卫亦得到真实验证。

结论：真实 captions Provider **端到端链路已跑通**（probe → prepare/create → 真实生成
→ proposal → 显式 apply）。仍未完成：Desktop UI 发起入口（当前 UI 只有只读消费端）
与 Electron 端到端验收。

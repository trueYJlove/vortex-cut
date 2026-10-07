# captions Provider 响应适配器阶梯——Design Gate

> 当前状态以 [`STATUS.md`](STATUS.md) 为准。本门冻结适配器 ID、captionscript 语法、
> 迁移 v34 与错误码，不声明真实 Provider 已交付。
> 上游：`WORKLIST_CAPTIONS_PROVIDER_ADAPTER_PLANNING_GATE_2026-10-05.md`。

## 1. 适配器阶梯（冻结）

新增常量，与既有 `TIMELINE_PATCH_ADAPTER_IDS` / `CANDIDATE_ADAPTER_IDS` 同构：

```python
CAPTIONS_ADAPTER_IDS = (
    "openai_chat_completions_json_schema_v1",
    "openai_chat_completions_captionscript_v1",
)
CAPTIONS_PROBE_PROTOCOL_VERSION = "1"
```

**顺序即优先级**，探测按此顺序逐个尝试，首个通过者持久化。

设计取舍：

- **不把 `openai_responses_*` 放入首档**。实测该网关 `/responses` 端点存在（裸调用 200），
  但 `/responses` + `json_schema` 返回 **502**。若置于首档，每次探测都会先浪费一次 502 往返。
  `responses` 族的 captions 支持不在本切片，留待有真实网关证据时再评估。
- **不新增"无 response_format"档**。实测裸输出 200，但它与 `json_object` 同样只提供
  "是 JSON"的弱保证；增加档位只会放大探测调用次数（R3），收益不足。

## 2. captionscript 语法（冻结）

标识：`openai_chat_completions_captionscript_v1`

与 `patchscript` / `candidatescript` 同族：**严格框定、不修复、不提取**。

```
AIVS-CAPTION/1
{"segment_refs":["seg_0"],"text":"..."}
{"segment_refs":["seg_1","seg_2"],"text":"..."}
AIVS-END
```

规则：

| 规则 | 说明 |
|---|---|
| 首行 | 必须精确等于 `AIVS-CAPTION/1` |
| 末行 | 必须精确等于 `AIVS-END` |
| 记录数 | 1 ≤ n ≤ 2000（对齐 `CAPTIONS_PROVIDER_SCHEMA` 的 `maxItems`） |
| 每条记录 | 单行 JSON 对象，字段**恰好** `{segment_refs, text}` |
| `segment_refs` | 非空字符串数组，元素唯一，且必须属于调用方给定的 segment ID 集合 |
| `text` | 非空字符串，长度 ≤ `max_chars_per_caption` |
| 覆盖 | 每个输入 segment ID 必须**恰好出现一次** |
| 空行 | 禁止 |
| 其他文本 | 禁止（Markdown、围栏、注释、前后缀一律拒绝） |

**解析器签名**（与 `parse_patchscript` 对齐）：

```python
def parse_captionscript(raw: str, input_segment_ids: list[str], max_chars_per_caption: int) -> dict[str, Any]
```

`parse_captionscript` 只负责**拆行与框定**；字段级与覆盖级校验委托给既有
`validate_captions_provider_value`，避免两套校验逻辑漂移。

行处理复用 `_candidatescript_lines` 的换行/控制字符规则（BOM、NUL、混用换行、
空行均拒绝）。因该函数当前为 candidatescript 专用命名，实现时提取为中性
`_script_lines`，两个调用点共用，不改变既有行为。

**instructions 提示词**必须显式给出信封格式、字段清单、覆盖要求与
"不得输出其他文本"，并对齐 `candidatescript` 分支的既有措辞强度。
（依据：`providers.py` 2026-09-20 记录——patchscript 曾因缺格式说明而必然失败。）

## 3. 迁移 v34（冻结）

```sql
ALTER TABLE provider_configs ADD COLUMN captions_provider_response_adapter_id TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_probe_protocol_version TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_failure_code TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_probe_sha256 TEXT NULL;

-- 旧探测语义不可信（改造前未记录适配器）：重置为 untested
UPDATE provider_configs SET captions_provider_capability_status='untested',
  captions_provider_response_adapter_id=NULL,
  captions_provider_probe_protocol_version=NULL,
  captions_provider_capability_tested_at=NULL,
  captions_provider_capability_failure_code=NULL,
  captions_provider_capability_probe_sha256=NULL
WHERE captions_provider_capability_status IN ('supported','unsupported');
```

不变量触发器（对齐 v22 的 `provider_*_capability_valid_insert/update` 换血先例）：

| 状态 | 要求 |
|---|---|
| `supported` | adapter ∈ `CAPTIONS_ADAPTER_IDS`；protocol 为 `'1'`；`tested_at` 非空；`failure_code` 为空；`probe_sha256` 非空 |
| `unsupported` | adapter 为空；protocol 为空；`tested_at` 非空；`failure_code` 非空；`probe_sha256` 非空 |
| `untested` | adapter / protocol / `tested_at` / `failure_code` / `probe_sha256` 全空 |

触发器命名：`provider_captions_capability_valid_insert` /
`provider_captions_capability_valid_update`。

> **注意**：v34 是**纯新增**迁移，不重建既有触发器。v22 已存在的
> candidate / timeline_patch 触发器保持不变。

## 4. 错误码（冻结）

沿用既有 `ProviderError` 码，不新增：

| 场景 | 码 |
|---|---|
| 网关拒绝 `json_schema`（400） | `PROVIDER_CONTENT_REJECTED`（确定性，不重试，跳到下一档） |
| `/responses` 不可用（502） | `PROVIDER_UNAVAILABLE`（**可重试**，见 `RETRYABLE_PROVIDER_ERRORS`） |
| 网络/代理失败 | `PROVIDER_NETWORK_ERROR`（可重试） |
| 超时 | `PROVIDER_TIMEOUT`（可重试） |
| script 框定或 schema 不合法 | `PROVIDER_INVALID_RESPONSE`（确定性，不重试） |
| 全部档位失败 | `CAPTIONS_PROVIDER_CAPABILITY_UNSUPPORTED` |

`PROVIDER_UNAVAILABLE` 可重试是既有全局语义（`RETRYABLE_PROVIDER_ERRORS`），
本切片不改动该集合——保持与 candidate/timeline_patch 探测一致。

## 5. 服务改造（冻结）

`CaptionsProviderEgressService.test_capability`：

1. 遍历 `CAPTIONS_ADAPTER_IDS`，构造带 `response_adapter_id` 的 `StructuredTextRequest`；
2. 每档内按 `RETRYABLE_PROVIDER_ERRORS` 重试（沿用既有 3 次上限）；
3. 首个通过 `validate_captions_provider_value` 的档位即为选中适配器；
4. 持久化 `status`、`adapter`、`protocol`、`tested_at`、`failure_code`、`probe_sha256`；
5. `probe_sha256` 汇总各档尝试结果（对齐 `planning.py` 的 `failures` 摘要做法）。

`claim_for_runner` 必须返回 `captions_provider_response_adapter_id`，
供真实 runner 使用**已探测通过**的适配器，禁止回退到未探测档位。

`prepare` / `create` 的 capability 门禁增加"已选适配器存在"条件。

## 6. Implementation Slice 3

1. `providers.py`：新增 `CAPTIONS_ADAPTER_IDS`、`captions_adapter_supported`、
   `captions_adapter_is_captionscript`、`parse_captionscript`、提取 `_script_lines`；
   `_generate_adapter` 扩展为三族分派（timeline_patch / candidate / captions）；
2. `database_v34.py` + `database.py` 注册；
3. `planning.py` 的 `_dto` 暴露四个新列；
4. `captions_provider_egress.py` 探测走阶梯 + 持久化；
5. 单元测试：解析器边界、阶梯顺序、重试分流、不变量触发器、既有回归更新；
6. `STATUS.md` §1 `latest_migration` 33 → 34，§4 登记 P42/P43/P44。

## 7. Gate 结论

Design Gate 通过，允许进入 Implementation Slice 3。真实 Provider 端到端两步调用
与 Electron 验收仍属于 Verification Gate。

## 8. 承诺

本门登记为 `STATUS.md` §4 P42；风险对策 P43；迁移与不变量 P44。
任何迁移、协议、白名单变化必须同步更新 `STATUS.md` §1。

## 变更记录

- 2026-10-05：首次冻结。

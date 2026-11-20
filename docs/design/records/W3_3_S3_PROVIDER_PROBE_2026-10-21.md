# W3.3 S3 真实网关探测记录（事实 0.13 结案）

> **日期**：2026-10-21
> **目的**：回答 Design Gate §0 事实 0.13「图片内容块 + strict json_schema 能否并用」——
> 这是本包**第三条从零能力**（多模态下的结构化输出约束），此前完全没有实测。

---

## 0. 先更正两处我自己的错误判断

| 我说的 | 事实 |
|---|---|
| 网关是 `api.apikey.fun`、模型 `deepseek-flash` | 那是**项目级旧变量**。系统用户级配置是 `http://127.0.0.1:8326/v1` / `workbuddy/deepseek-v4.1-flash` |
| DeepSeek 全系不支持 vision | **错**。该网关 135 个模型中 **98 个**声明 `input:["text","image"]`，含所配置的模型 |

**教训**：我只查了 shell 的 `env` 就下结论，而用户级变量在注册表 `HKCU\\Environment` 里。
同一类错误在本会话已出现第三次（`head -5` 截断、看错被 gitignore 的 spec、这次看错环境作用域）。
**统一改法**：涉及「系统配置」的判断，一律先确认**作用域**再读值。

---

## 1. 事实 0.13 的答案：**能并用**

| 组合 | 结果 |
|---|---|
| 图片块，**不**带 `response_format` | 200，但 `content: null`（内容全在 `reasoning_content`） |
| 图片块，**带** strict `json_schema` | **200，`content` 是合规 JSON** |

**结论**：S3 只需要**一档**适配器（`openai_chat_completions_image_url_v1`），
**不需要**设计门 §3.6 预留的「无 `response_format` + 词表后处理」降级档。
R13 可以按「不触发」核销——但**保留阶梯结构**，因为其他模型未必如此。

---

## 2. 受控词表约束可用（D5 可落地）

真实视频帧（768×432，production `encode_frame` 产出）实测：

```json
{"labels":[],"notes":"SMPTE color bars test pattern; no allowed label applies."}
```

- 模型**没有**把测试彩条硬塞进「室内」或「文字标识」——说明受控词表约束真的生效；
- 词表外描述走 `notes`，与规划门 §3.4「一律改道 notes」一致；
- `labels` 为空数组是**合法且正确**的结果，不是失败。

---

## 3. ⚠️ 新发现：token 预算存在**不稳定**失败面

| `max_tokens` | `finish_reason` | reasoning tokens | 结果 |
|---|---|---|---|
| 300 | length | 300 | ❌ `content: null` |
| 800 | length | 800 | ❌ `content: null` |
| 1500 | stop | — | ✅ |
| 1500 | **length** | — | ❌ **同参数不同结果** |
| 2000 | stop | 164 | ✅ |
| 3000 | stop | 196 | ✅ |

**两件事**：

1. **推理先烧 token**：`finish_reason=length` 且 `reasoning_tokens == max_tokens` ⇒ 输出一个字都不剩。
   这与 STATUS **P43** 记录的形态**完全一致**（推理模型 `reasoning_content` 挤占 `max_tokens`）。
2. **同样的 `max_tokens` 可能成功也可能失败**（1500 两次不同）⇒ **固定预算不是安全区**。

### 这对 P43 的结论构成反证

P43 明文结论是「**显式 `max_tokens` 下限评估结论：不设**」，理由是「网关默认实测够用」且「固定下限会把长负载反向截断」。

**本轮实测表明**：默认预算在**视觉推理**下不够用，且 `finish_reason=length` + 空 `content` 是**真实高频失败**，不是理论风险。

**但这不等于要推翻 P43**——P43 讨论的是**文本**负载（captions），本轮是**图片**负载，推理负担不同源。
**处置**：登记为**新风险**（视觉路径的预算下限），不修改 P43 对文本路径的结论。

---

## 4. 待裁决（需用户决定）

视觉打标路径的 `max_tokens` 策略三选一：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A** | 固定较高下限（如 3000） | 简单；但长推理仍可能撞顶，且对短任务浪费 |
| **B** | 撞顶自动重试一次并倍增预算 | 多一次往返；但能覆盖「同参数偶发失败」 |
| **C** | 不设 `max_tokens`（用网关默认） | 实测默认更小 ⇒ **不可行** |

---

## 5. 环境事实（供复现）

| 项 | 值 |
|---|---|
| 网关 | `http://127.0.0.1:8326/v1`（本地，直连可达，4.6s 拉 50KB 模型列表） |
| 模型 | `workbuddy/deepseek-v4.1-flash`（`input: ["text","image"]`） |
| 密钥 | 环境变量 `AIVS_REAL_PROVIDER_API_KEY`（用户级，43 字符，**未在本文记录内容**） |
| 模型总数 / 支持 image 的数量 | 135 / **98** |

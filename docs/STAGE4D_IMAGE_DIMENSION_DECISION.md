# Stage 4D 图片尺寸语义阻塞决策

> 决策负责人：LiuWei（架构师）
> 日期：2026-08-19
> 关联 Gate：Stage 4D Gate 4D-4
> Provider：`apikey.fun / gpt-image-2`
> 状态：D2 已冻结——接受安全边界内的 Provider 原生 PNG 尺寸
> 性质：契约修订记录；D1 作为历史决策保留，D2 自 Gate 4D-4A 起生效

## 1. 决策问题

Gate 4D-4 已按公开文档发送 `size=1024x1024`，Provider 返回了可解码图片，但 Core 独立解码后的尺寸不等于冻结的 `1024×1024`，因此 Task 以 `GENERATED_IMAGE_DIMENSION_MISMATCH` 安全失败。

当前必须决定：

1. `1K` 是计费档位、像素长边/短边语义，还是严格 `1024×1024` 输出保证；
2. `size=1024x1024` 是否应保证实际输出严格等于请求尺寸；
3. Provider 返回尺寸不符属于暂时异常、模型固有行为还是文档未说明的映射；
4. 在得到可靠答案前，产品是否应接受、规范化或改变输出尺寸。

## 2. 已确认的公开事实

### 2.1 单图接口文档

2026-08-19 只读核对公开文档页面：

- 文生图端点：`POST https://api.apikey.fun/v1/images/generations`；
- 模型：`gpt-image-2`；
- 示例参数：`n=1`、`size=1024x1024`、`stream=true`、`response_format=b64_json`；
- 完成事件：`image_generation.completed`；
- 图片字段示例兼容顶层 `b64_json` 和 `data[0].b64_json`。

公开来源：

- <https://apikey.fun/docs>
- <https://apikey.fun/>

上述内容与 Stage 4D 当前 adapter 一致。

### 2.2 价格页

公开价格模块列出：

```text
gpt-image-2 / 1K / CNY 0.10 每张
gpt-image-2 / 2K / CNY 0.15 每张
```

公开来源：<https://apikey.fun/pricing>

价格页没有公开定义 `1K` 与精确像素宽高的映射，也没有声明 `1K` 必然等于 `1024×1024`。

### 2.3 端点信息

公开站点配置还列出 `img.apikey.fun` 为主端点不可用时的“生图专用 API”。Stage 4D 冻结端点仍是 `api.apikey.fun`；在没有新的契约 Gate 和明确授权前，不得切换备用域名进行试验。

### 2.4 支持渠道

公开联系页提供：

- 邮箱：`admin@apikey.fun`；
- 官网联系页：<https://apikey.fun/contact>。

本记录只准备最小询问模板，不代表已代表用户发送邮件或提交工单。

## 3. 已确认的运行事实

唯一一次第三方真实 dispatch 的安全事实：

```text
Task.status = failed
error_code = GENERATED_IMAGE_DIMENSION_MISMATCH
provider_call_count = 1
provider_may_have_processed = true
automatic_retry_count = 0
Asset delta = 0
Provenance delta = 0
Timeline Revision delta = 0
SQLite v14 / FK / integrity = passed
privacy scan = passed
```

失败 Invocation 没有保存实际宽高、图片字节、base64、原始 SSE 或原始异常。当前证据只能证明“实际尺寸不等于 1024×1024”，不能证明具体返回了何种尺寸。

不得根据价格档位、常见图片尺寸或单次失败猜测实际像素映射。

## 4. 候选处理路径

### A. 保持严格尺寸，等待 Provider 明确澄清

行为：

- 继续把 `size=1024x1024` 解释为严格输出契约；
- 尺寸不匹配继续 fail-closed；
- 不追加真实调用；
- 不修改 endpoint、DTO、SQLite、Asset、渲染或打包实现；
- 获取 Provider 可引用的书面说明或修复确认后，再决定是否复验。

优点：不改变冻结产品语义，不引入画质损失、裁切或无依据兼容。

缺点：Gate 4D-4 保持阻塞，完成时间取决于外部澄清。

### B. 增加本地规范化至 1024×1024

可能行为包括缩放、补边或裁切。该路径会新增图片变换算法、质量语义、hash/provenance、失败补偿和验收矩阵，且“缩放”“补边”“裁切”不能互相替代。

结论：当前不采用。若未来采用，必须建立新的契约 Gate，明确：

- 允许的 Provider 输入尺寸集合；
- contain/cover/stretch 中唯一算法；
- 插值、色彩空间、透明通道、元数据和编码参数；
- 原始 Provider hash 与规范化输出 hash 的 provenance；
- 是否保留原图及其隐私/磁盘策略；
- Windows 正式包确定性与真实画质验收。

### C. 把产品尺寸修改为 Provider 实际输出尺寸

现有证据没有实际宽高，公开文档也没有 1K 的像素映射。直接改为某个候选尺寸会把单次异常固化成产品契约。

结论：当前不采用。只有 Provider 给出稳定、可引用、可复验的精确尺寸定义时才可重新评估。

## 5. 唯一决策 D1

**采用路径 A：保持严格 `1024×1024`，等待 Provider 明确澄清。**

冻结要求：

1. 不再次 dispatch；
2. 不切换至 `img.apikey.fun`；
3. 不接受未知尺寸；
4. 不执行隐式 resize、crop、pad 或格式转换；
5. 不修改 Stage 4D API/DTO、SQLite v14、Asset/Provenance、Desktop/Electron 或 Windows 打包行为；
6. Gate 4D-4 继续保持“未通过，安全停止”；
7. 不进入 Gate 4D-5。

## 6. Provider 最小澄清模板

```text
主题：gpt-image-2 的 size=1024x1024 与 1K 输出尺寸确认

我们通过 POST /v1/images/generations 调用 gpt-image-2，按公开示例使用：
- n=1
- size=1024x1024
- stream=true
- response_format=b64_json

请求成功返回 image_generation.completed，图片可解码，但实际宽高不等于 1024×1024。

请仅确认以下协议事实：
1. size=1024x1024 是否保证输出严格为 1024×1024？
2. 价格页“1K”对应哪些精确像素尺寸或尺寸范围？
3. 返回尺寸与请求不一致是否为已知问题？如是，是否有修复时间或变更说明？
4. api.apikey.fun 与 img.apikey.fun 对该模型的尺寸语义是否完全一致？
5. 是否存在不改变模型、只保证严格 1024×1024 的官方请求参数？

为保护数据，本询问不附 API key、Prompt、请求 payload、原始 SSE、base64、生成图片、绝对路径或内部日志。
```

若通过邮件或工单发送，只能使用上述最小协议信息；不得附加任何项目敏感材料。

## 7. 重新开放契约决策的条件

满足以下任一条件后，才可重新进入尺寸契约评审：

1. Provider 提供可引用的书面确认，明确 `size=1024x1024` 的严格输出保证；
2. Provider 发布修复或变更说明，并明确生效端点、模型和日期；
3. Provider 明确 1K 的固定像素映射，且该映射与现有契约不同；
4. 用户明确授权评审“本地确定性规范化”新契约。

仅有口头推测、价格标签、另一模型的行为或一次额外试调用，不足以重开契约。

## 8. 再次真实复验的前置门禁

即使 Provider 已澄清，再次 dispatch 仍必须同时满足：

- 用户对新增真实调用给出明确授权；
- 说明本次调用相较上次具有新增验收价值；
- 调用前重新核算 USD 2 硬停止线；
- 使用全新 Task，禁止 retry 旧 Task；
- 每 Task 最多一次 dispatch，自动 retry 为 0；
- 先完成离线全量回归和敏感信息扫描；
- endpoint、model、size、SSE 协议与当时已确认契约完全一致；
- 成功仍须经过独立解码、严格尺寸/hash、原子落盘、Asset/Provenance、重启和 Windows 验收；
- 任一异常继续安全停止，不创建第二 Task。

## 9. 对现有实现和工作区的影响

本决策不产生业务代码、迁移、DTO 或打包变更。Stage 4D 未提交实现继续原样保留；README 不处理；不提交、不推送、不创建 PR/MR。
## 10. 后续决策 D2：原生尺寸兼容（Gate 4D-4A）

由于用户无法取得 Provider 对 `1K` 的明确像素语义说明，并明确同意修改验收标准，D1 不再作为后续真实复验的输出尺寸规则。D1 仍用于解释第一次真实 Task 为何按当时契约失败，禁止回写或追溯改判该历史事实。

D2 冻结为：

1. 出站请求仍固定 `size=1024x1024`，它只表示 1K 请求意图和请求 profile；
2. 接受 Provider 返回的原生单帧 PNG，不要求实际宽高等于请求值，也不要求正方形；
3. 实际宽、高均须大于 0 且不超过 4096，总像素不得超过 16,777,216，文件不得超过 25 MiB；
4. Core 在完整解码前先验证 PNG signature、首个 IHDR、CRC 和 IHDR 尺寸安全上限，完整解码后宽高必须与 IHDR 一致；
5. 禁止 resize、crop、pad、拉伸、重编码和格式转换；受管文件、Asset fingerprint、Invocation 与 Provenance hash 均基于 Provider 原始图片字节；
6. `validated_width`、`validated_height`、DTO 和 Desktop 展示实际输出宽高；
7. SQLite v14、API/DTO 字段、Provider 身份、价格、单次 dispatch、隐私与 Timeline 零副作用边界保持不变；
8. 原失败 Task 继续保留 `GENERATED_IMAGE_DIMENSION_MISMATCH`、调用数 1 和零 Asset/Provenance 事实；新契约只适用于 D2 后创建的全新 Task；
9. Gate 4D-4A 离线验证通过前不得真实 dispatch；真实复验必须另获授权并从当前保守累计 USD 0.40 继续核算，单次新增调用后预计 USD 0.55 / USD 2；
10. D2 不授权切换端点、开放 2K、本地规范化、Batch、参考图、编辑或 Timeline 自动装配。

D2 取代本文第 5、7、8 节中关于“等待 Provider 澄清后才能复验”的后续约束；这些章节保留为 D1 的历史审计记录。

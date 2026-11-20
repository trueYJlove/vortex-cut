# captions Provider 真机端到端验收记录（2026-10-09）

> **性质**：Verification Gate 验收证据包（点时间记录）。收口 P36 / P41 / P42 的
> 「真实 Provider + Electron 端到端」残留项，并为 P46 / P47 的收尾注记补证。
> 现状声明见 `docs/STATUS.md`；缺陷修复细节见 §4 P68 行。

## 1. 背景

2026-10-09 用户按「先追加所选片段、再发起优化」的顺序真机走查 AI 字幕优化
全流程（Provider `xkiro2` / `z-ai/glm-5.3-flash`）。走查中发现两处缺陷并当场
定位修复（登记 P68：映射失败 500 + running 步骤排版）。本记录汇总走查产出的
验收证据、日志/数据库复核结论与唯一剩余补跑项。

## 2. 验收核对表

| # | 验收项 | 出处 | 结果 | 证据 |
|---|---|---|---|---|
| A1 | 真实两步 prepare / create（外传 consent 前后边界） | P40 / P41 | ✅ | 三轮真实 run：egress preview → 显式确认 → generation 落库（`captions_provider_egress_previews` / `captions_provider_generations`） |
| A2 | 真实 Provider 网络生成 | P42 / P46 | ✅ | `provider_invocations`：`xkiro2` / `z-ai/glm-5.3-flash`，`status=succeeded` ×3（单次约 5.5s） |
| A3 | 隐私位 `provider_may_have_processed=0` | P46 验收 | ✅ | 三轮 invocation 行实测均为 0 |
| A4 | 适配器阶梯真实选定并落库 | P42 | ✅ | `captions_provider_response_adapter_id=openai_chat_completions_captionscript_v1`、`probe_protocol_version=1`，probe 落库（阶梯第 1 档 400 → 第 2 档成功） |
| A5 | Electron 面板端到端（form → confirm → running → proposal） | P47 | ✅ | 用户真机走通；running 步骤排版缺陷当场发现并修复（P68 ②） |
| A6 | 提案构建端到端 + 诚实终态 | P41 / P56 | ✅ | 两轮生成结果文本与原文**逐字一致**（14/14 字、11/11 字）→ `CAPTIONS_PROVIDER_PROPOSAL_EMPTY` 诚实提示「无需应用」，不假造 diff |
| A7 | 真实非空 diff 的提案展示 + 显式 apply 点击 | P41 | ⚠️ 补跑 | apply 路径已有 Core 级真实证据（P46：35/32 字压缩 → proposal → 显式 apply 新 Revision）+ Electron apply 全自动化回归；xkiro2 两轮均判定原文已够短未改写。补跑配方见 §4（30 秒），属同路径补充证据 |
| A8 | 段↔字幕映射缺陷（P68 ①） | 本次走查副产物 | ✅ | 真实库复盘 + `desktop.log` 04:37:44 traceback 定证（详见 §3.3）；四层修复 + 6 组负向对照，见 STATUS §4 P68 |

## 3. 证据明细

### 3.1 数据库复核（`@aivideo/desktop/data-v2/app.db`，只读）

- generations：03:38 / 03:39 / 04:37 / 04:39 共 4 轮 succeeded + 1 轮 failed（10-07 旧 run）；
- invocations：全部 `capability=captions_provider_generation`、`status=succeeded`、
  `provider_may_have_processed=0`；
- provider_configs：`xkiro`（废弃，capability=`unsupported`）与 `xkiro2`
  （capability=`supported`，适配器 captionscript，协议 1）——P67 的删除能力已在
  同日交付，废弃条目可在设置中删除或停用；
- proposals / proposal_applications：空——对应 A6 的无变化终态（非失败，见下）。

### 3.2 无变化终态的定证

两轮生成的 payload 段文本与 Provider 返回文本**逐字一致**：

| 轮次 | 段 | payload text | result text | 结论 |
|---|---|---|---|---|
| 04:37（gen `8e0be4bd…`） | `segment_054f6914…` | 11 字 | 11 字（相同） | 无改写 → PROPOSAL_EMPTY |
| 04:39（gen `1eea35d7…`） | `segment_6f9f8d9f…` | 14 字 | 14 字（相同） | 无改写 → PROPOSAL_EMPTY |

模型判定原文已在最大字数（24）以内、无需压缩——这是契约设计的诚实分支
（宁可空提案也不假造改写），用户确认行为符合预期。

### 3.3 P68 ① 的日志定证（`logs/desktop.log`）

04:37:44 一轮的 create_proposal traceback 以
`ValueError: Provider segments do not map to one existing caption` 收尾
（旧代码裸 ValueError 穿透路由 → 500）。注意一处陷阱：traceback 的源码行
显示的是 `raise CaptionsProviderMappingError(...)`——那是 **linecache 按磁盘
现文件回显**（当时工作区已含修复），而进程内存是旧代码；以异常类型行
（`ValueError:`）为准。04:38:23 应用重启加载修复后，同一链路走通（A5/A6）。

### 3.4 时间线还原

1. 03:38–03:39：选 `segment_051d…`（24 段素材转录）→ 生成成功 → 提案 500（P68 ① 现场，用户截图报告）；
2. 当日修复 P68（prepare 前置校验 / 类型化映射 / 文案 / 排版）；
3. 04:37：旧构建再跑 → 同段落选到 `segment_054f6914…` → 提案阶段映射失败（该段同样未追加为字幕）；
4. 04:38:23：重启加载修复；04:39:12 按正确顺序「追加转录选定」→ 04:39:16 发起 → 生成成功 → 无变化终态（A6）。

## 4. 补跑配方（可选收尾，30 秒）

转录页选 1 段**长于**「每条字幕最大字数」的文本 → AI 字幕优化 → 把最大字数调低
（如 8）→ 走完全程 → 提案必然产生非空 diff → 点「应用为新的 Revision」。
这一步只是把「真实 diff 的展示 + apply 点击」补进真机证据；apply 路径本身
已有 P46 Core 级真实证据与 Electron 自动化回归。

## 5. 结论

- A1–A6、A8 全部通过：字幕 Provider 线的「真实两步 prepare/create + Electron
  端到端」残留项收口（P36 / P42 / P47）。
- P41 仅余 A7 补跑（非阻塞；同路径补充证据，配方见 §4）。
- 走查副产物 P68（两缺陷）已修复、负向对照完备，当日闭环。

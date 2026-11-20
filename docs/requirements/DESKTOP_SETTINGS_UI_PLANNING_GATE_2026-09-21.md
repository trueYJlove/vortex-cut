# Desktop 设置 UI（代理设置接线 + CV 分析入口 + AI 助手面板）——Planning Gate

> 起草：LiuWei，2026-09-21。来源：AI 功能线（AI-1 agent 会话、AI-2 CV 信号层、
> PROXY_SUPPORT）Core 侧全部落地后的收口单——把这批能力交给用户手的最后一步。
> 实施：YeJing（Desktop）。验收：LiuKeAi。

## 0. 现状走读结论（2026-09-21 代码级）

**Core 侧全部就绪，无需改动**：

1. **代理**：`--proxy-mode`（system/custom/direct）+ `--provider-proxy` CLI 已贯通
   （config.py:55、:95；`resolve_provider_proxy` config.py:106 三级回退，注册表
   ProxyEnable/ProxyServer）；Core 在启动时解析一次（app.py:609），运行中不热生效。
2. **Agent 会话**：四端点齐（app.py:1469–1507：prepare/create/list/get）；
   `agent_session.updated` 事件已发（agent_session.py:755，payload =
   agent_session_id/status/progress/step）；`get_session` 返回 steps 明细
   （ordinal/status/stage/summary/error/duration_ms）；能力门复用
   `timeline_patch_capability_status`（agent_session.py:107–111）；一项目仅一个
   active session（违反报 `AGENT_SESSION_ALREADY_ACTIVE`）。
3. **CV 分析**：`POST /projects/{id}/assets/{aid}/cv-analysis`（app.py:2164，
   generate=True 登记作业，仅 video 素材，返回 status/analysis_id/job_id/
   sample_count/scene_cut_count）；`cv_analysis` 已是合法 job kind
   （contracts:1207）。
4. **DTO**：AgentSession/Status/Prepare/Create 契约齐（contracts:997–1017）。

**Desktop 侧缺口（本单全部范围）**：

- **代理接线断点**：`SidecarSupervisor` 已支持 `providerProxy`/`proxyMode` 选项并
  组装 CLI（sidecar-supervisor.ts:63–64），但 `index.ts:814` 构造处**两个参数都没
  传**——桌面侧至今没有任何路径把代理配置送到 Core；也没有设置持久化（现仅有
  ProviderSecretStore 存密钥，无通用设置存储）。
- **无任何 agentSession / cv-analysis 引用**（renderer、preload、main 全查空）。
- **事件订阅可复用**：`core-client.ts:654` subscribe = WS `/events` + 轮询兜底，
  preload `subscribeJob` 已暴露（index.ts:261/408）；`job.updated` 通道对
  agent_session 与 cv_analysis 作业天然工作（AI-1-7 承载裁决），无需新订阅协议。

## 1. 范围

### 必须实现（Desktop）

1. **设置存储（DESK-1）**：新 `DesktopSettingsStore`（userData/settings.json，
   对齐 ProviderSecretStore 先例，Main-only）；字段 `proxy_mode`（system 默认/
   custom/direct）+ `provider_proxy`（custom 时的 URL）。IPC：`settings:get` /
   `settings:set`（channel 命名对齐 `provider:list` 先例）。
2. **代理接线（DESK-2）**：`index.ts:814` 构造 supervisor 时从设置读出并传入
   `proxyMode`/`providerProxy`。**生效语义 = 重启 sidecar**（Core 启动时解析一次，
   不做热生效）：设置页保存后显示"已保存，待重启生效"，提供"立即重启内核"动作
   （supervisor stop→start 既有路径，重建 CoreAdminClient + reinject 密钥 +
   createSession，对齐 index.ts:826–836 就绪序列）。
3. **设置 UI（DESK-3）**：主界面新增"设置"入口（footer-actions 区）→ 设置对话框：
   代理模式三选（系统代理（默认）/自定义/直连）+ 自定义地址输入（custom 时启用，
   校验 `http://host:port` 形态）+ 当前生效状态行 + "连接测试将使用当前代理设置"
   提示文案（PROXY_SUPPORT 规划门 §1.6 全项）。
4. **CV 分析入口（DESK-4）**：素材库视频条目动作区加"AI 信号分析"：调
   cv-analysis（generate=True）→ `subscribeJob` 跟踪作业 → 完成后条目显示摘要
   （状态 + 采样数 + 场景切换数，文本级）。**不做**信号可视化图表（AI-2 规划门
   已列为独立小单）。
5. **AI 助手面板（DESK-5）**：新 Dialog（独立组件目录 `src/app/agent-session/`，
   不再向 2125 行的 App.tsx 堆代码；footer-actions + 工具菜单 AI 组加入口"AI
   助手"）。四步流程对齐现有三段式先例：
   - **表单**：指令（1–4000 字符）+ Provider 选择（仅 `timeline_patch_capability_status === "supported"`）；
   - **确认**：会话级 egress preview 全项展示（sent_fields 含"多轮反馈"、stats、
     payload_sha256、有效期）——AI-1-6 知情范围原样呈现；
   - **运行**：`subscribeJob` 跟踪（stage/progress/取消按钮沿用 AI 修改面板先例）
     + 会话步数指示（`agent_session.updated` 的 progress/step 若经 job payload 可
     见则用之，否则轮询 `get_session` 兜底）；
   - **结果**：成功态提示"每步已落版本，可 Undo 回退/版本比较查看"；失败态展示
     error_code（STEP_LIMIT/BUDGET_EXCEEDED/BASE_DRIFT）；打开面板时先
     `list_sessions`，存在 active 会话则直接进入运行/结果视图而非新建
     （`AGENT_SESSION_ALREADY_ACTIVE` 防线）。
6. **契约增量**：`agent_session.updated` 事件类型与 cv-analysis 请求/响应 DTO 补进
   contracts（仅新增；PROTOCOL_VERSION 不动，对齐 AI-1 验收 3 的契约纪律）。

### 明确不做（边界）

- **步骤级 diff 浏览**：每步 Revision 已落链，用现有"版本比较"查看；面板 v1 只做
  步骤列表（ordinal/stage/status/summary/耗时）。
- **会话 token 实时聚合展示**（AI-1 风险表的 UI 单消费）：provider_invocations 聚合
  端点未建，后补独立小单。
- **CV 信号可视化**（波形/曲线图）：AI-2 独立小单。
- **代理热生效 / PAC / 认证代理**：上游规划门已定，不动。
- **设置项扩容**（主题、语言等）：本单只立存储骨架 + 代理两字段，其余后续按需加。

## 2. 设计要点

- **重启生效而非热切换**：代理在 Core 启动时解析一次（app.py:609），热切换需
  Core 增设运行时重载面——为一个低频设置引入动态配置通道不值；重启窗口用
  "已保存，待重启生效"状态行如实呈现，杜绝 UI 显示与实际生效不一致。
- **设置读取时机**：supervisor 构造在 app ready 序列内，`DesktopSettingsStore.get()`
  同步读小 JSON 文件，无启动延迟顾虑；文件损坏/缺字段回退默认值（system）+ 日志，
  与"代理是优化不是依赖"同哲学。
- **E2E 证据路径**：`AIVS_E2E_SIDECAR_ARGV_EVIDENCE` argv 证据机制（sidecar-
  supervisor.ts:67）可直接断言 proxy 参数组装；e2e 无需真代理服务器——设置→参数
  传递用证据文件，Core 端三级回退解析已有 Core 单测覆盖。
- **AI 助手面板的事件边界**：`agent_session.updated` 是补充信号，权威状态源仍是
  `get_session`（轮询兜底已有先例）；renderer 对未知事件类型必须忽略不崩
  （core-client.ts:671 的 malformed frame 容错延伸到新类型）。
- **隐私红线**：会话级确认页必须完整展示 preview 的 sent_fields 与 payload 正文
  预览（对齐 AI 粗剪确认页 `egress-text` 先例）；代理不改变外发内容只改变路径，
  无需进 preview 知情范围（PROXY_SUPPORT §2 已裁决）。

## 3. 验收（LiuKeAi）

1. **单测（Desktop）**：DesktopSettingsStore 读写/默认值/损坏 JSON 回退；settings
   IPC get/set 往返；supervisor args 组装含 `--proxy-mode`/`--provider-proxy`
   （含 custom 无 URL 的防御）。
2. **集成/e2e**：
   - 设置流：打开设置→改 custom+URL→保存→重启内核→argv 证据文件含两参数→
     设置页"当前生效：自定义"；
   - CV 流：导入视频→发起 AI 信号分析→作业完成→条目摘要更新（controlled
     sidecar 先例模式）；
   - AI 助手流：controlled provider 跑通 表单→确认（sent_fields 含多轮反馈）→
     运行→成功，步骤列表可见；active 会话存在时新建被拦；
   - 回归：Desktop 全量（668+）+ Core 全量（873+，本单预期零 Core 改动，全绿即证）。
3. **契约**：contracts 新增 DTO/事件通过既有 parse 回归；PROTOCOL_VERSION 不变。
4. **隐私**：会话确认页 sent_fields 与正文预览完整性断言；settings.json 不含任何
   密钥/凭据（密钥仍走 ProviderSecretStore）。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 用户改设置后不重启，误以为已生效 | 状态行区分"已保存/当前生效"两态；provider 连接测试错误信息带代理上下文（**注：该「上游已实现」的原表述为误引，已于 2026-10-24 更正——`providers.py:1001/1003/1216` 实际仍为通用文案，未带代理上下文；见 P196**） |
| 重启 sidecar 中断进行中任务 | 重启按钮二次确认 + 列出 active 任务数；非强制路径，关闭 App 自然重启同语义 |
| App.tsx 继续膨胀 | AI 助手面板独立组件目录；设置对话框同样独立 |
| `agent_session.updated` 与 job.updated 双通道状态竞争 | 权威源 = get_session 轮询；事件只做"触发提前刷新"信号 |
| 契约漂移（Core 手写 dict vs contracts 手写 parse） | 新 DTO 以 Core get_session 实际返回为准逐字段对齐 + parse 单测 |

## 5. 裁决记录（用户，2026-09-21）

- **① 代理"重启 sidecar 生效"语义：接受**（否决 Core 运行时热重载方案）。
- **② AI 助手面板 v1 范围 = 步骤列表：接受**（每步 diff 用现有版本比较查看；
  token 聚合展示与 CV 可视化维持独立小单）。

本门据此进入实施（YeJing 面）。

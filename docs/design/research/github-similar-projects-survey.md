# GitHub 同类开源项目调研：与 Vortex Cut 技术路线对比

**调研日期**：2026-08-29（Star 数、活跃度均为当日 GitHub API 实取值）
**调研对象**：Vortex Cut（本仓库）— 本地优先、AI 驱动的视频剪辑与多平台创作工具
**调研方法**：GitHub Search API 多关键词检索（video editor / electron / ffmpeg / whisper / local-first / MCP / agent / fastapi 等 12 组查询）→ 按 Star 与相关度筛选 40+ 仓库 → 逐个拉取仓库元数据与 README 原文核对技术栈 → 人工分层归类
**第二轮补充（同日）**：新增 8 组检索（mcp video editor / agent timeline / electron python sidecar / gameplay highlight / local-first desktop 等），补充 13 个首轮遗漏项目，并对全部 28 个仓库做 `pushed_at` 活跃度与归档状态核验 → 结果见 §3.6、§4.9、§5.2、§7.4 与附录 B

---

## 0. 结论摘要（TL;DR）

1. **没有找到与本仓库"Electron + Python sidecar + SQLite + FFmpeg + faster-whisper"完全同构的开源项目**。这是目前的一个结构性空位：桌面 AI 剪辑赛道里，JS/TS 栈项目普遍不配 Python 领域服务，Python 栈项目普遍用 Streamlit/Gradio 当界面而不是 Electron。
2. **架构思想上最接近的三个项目**：`OpenChatCut`（Electron + 本地服务 + 命令层 + 提案式应用 + MCP）、`Timeline Studio`（`.timeline` 项目文件为唯一事实来源 + 声明式 JSON 编辑计划 + 事务化应用 + 离线确定性渲染）、`OpenEdit`（Python + faster-whisper + SQLite WAL 追加写 IR 编辑图 + ffmpeg 渲染 + MCP）。
3. **行业正在收敛的一个范式**："**编辑器即本地服务 + 项目文档是唯一事实来源 + 人与 AI 走同一套命令协议**"。Palmier Pro、OpenChatCut、Velocut、FableCut、OpenEdit、Timeline Studio 六个互不相关的项目不约而同采用了这个结构——这与本仓库 ARCHITECTURE.md 的"唯一事实来源 / AI 负责建议，程序负责约束 / 可替换能力"三条原则是一致的，说明路线选择没有走偏。
4. **真正的差异化在"可靠性工程"，不在功能清单**。多数同类项目（尤其 Star 数在 1000 以下的新项目）把精力放在"AI 能否自动剪出一条片子"，而本仓库已经做了 Revision、锁定元素、差异比较、失效重算、Provider capability 显式门控、整数微秒时间轴——这些在调研样本里**只有 OpenChatCut 和 Timeline Studio 部分具备**，是本仓库相对多数竞品的领先项。
5. **需要警惕的两点**：① 竞品普遍把 AI 出口做得很"重"（内置 Agent、MCP、Skills、Remotion 渲染、生成式 AI），产品观感上比本仓库激进；② 本仓库当前**没有对外的 MCP / Agent 接入点**，而 2026 年的这批新项目几乎把 MCP 当标配，这会在生态位上形成压力。
6. **【第二轮新增】MCP 已是这个赛道的事实入场券，且门槛低到"零 Star 项目也在做"**。第二轮检索到的 `WeftCut`(4★)、`kerf`(4★)、`dualcut`(0★)、`FirasEditor`(0★)、`editorvideo-ai`(0★) 全部把"外部 Agent 驱动时间线"写进一句话简介——MCP 已不是差异化，而是**基线**。其中 `FirasEditor` 的定位（"Electron + ffmpeg + MCP server，Windows 离线多轨编辑器"）与我们技术栈**字面一致**，但它建于 2026-08-01 且当天后再无提交，说明**栈选对了不等于能做出来**，执行力才是壁垒。
7. **【第二轮新增】"Electron + Python sidecar"是成熟的通用架构模板，但在视频剪辑领域仍是空白**。`lens-desktop`（Electron + Python HTTP API sidecar 脚手架）、`lintu`、`downany`、`pdf-to-audiobook` 等一批项目都在用这套结构交付本地 AI 桌面应用，说明我们的**架构选型没有工程风险**；但检索范围内**没有一个落在非线性剪辑领域**。这印证了 §0 第 1 条：我们的护城河不是架构新颖，而是"成熟架构 × 剪辑领域工程深度"的组合。

---

## 1. 本仓库技术路线画像（对照基线）

| 维度 | Vortex Cut 现状 |
|---|---|
| 桌面壳 | Electron 36 + React 19 + TypeScript 5.8 + electron-vite + pnpm workspace |
| 领域核心 | Python 3.12 侧车进程（FastAPI + Pydantic + uvicorn），PyInstaller 打包为 `aivs-core` |
| 通信 | Electron 主进程启动 sidecar，绑定 127.0.0.1 随机端口 + 会话令牌；Renderer 经 preload 白名单 IPC |
| 持久化 | SQLite（项目状态、时间线 Revision、Job、Provider 调用记录） |
| 媒体 | FFmpeg/FFprobe 受控子进程 + PyAV；代理（proxy）与派生产物分层 |
| ASR | faster-whisper（本地） |
| 契约 | `@aivideo/contracts` 包，TS ↔ Python 共享 schema |
| 领域模型 | Project / Asset / Analysis / Brief&Recipe / CandidatePlan / TimelineRevision / Render / Provider / Job / Export / Diagnostics |
| 时间模型 | 领域层整数微秒，禁用浮点秒 |
| AI 治理 | AI 输出经 JSON Schema + 引用校验 + 时间范围校验；提案 → 比较 → 显式应用；Provider 未配置或 capability 非 supported 时禁止外传 |
| 目标场景 | 游戏类短视频优先，多平台导出（抖音 / 视频号 / 小红书） |
| 明确不做 | 多 Agent 自由自治组织、n8n/Halo/Redis/PG/K8s 依赖、任意代码插件机制 |

---

## 2. 第一梯队：架构思路高度一致（重点研究）

### 2.1 OpenChatCut — 与本仓库最像的"完全体"

- **链接**：https://github.com/0xsline/OpenChatCut
- **Star / 语言 / 协议**：1,440 / TypeScript / AGPL-3.0（创建于 2026-07，仍在高频迭代）
- **技术栈**：React 19 + TypeScript 6 + Vite 8 + Electron 43；内置本地 Node 服务（`server/plugins/`）+ Remotion 4 无头渲染；whisper-cli + MediaPipe 本地模型；Vercel AI SDK 7 + Agent Skills + MCP SDK；导出走 Remotion + FFmpeg，支持 FCPXML / SRT
- **核心架构特点**：
  - 明确的**分层目录契约**：`src/editor/`（时间线状态与命令，**独立于 UI 与 LLM**）、`src/agent/`、`src/transcript/`、`server/plugins/`、`desktop/`、`remotion/`
  - **不可变时间线状态 + 命令层 + 提案式应用**（proposal-based application）：Agent 只能通过 `EditorCore` 命令改项目，因此可追溯、可撤销
  - **人 / 内置 Agent / 外部 MCP 客户端共用同一套工具与命令**
  - 安全边界与本项目高度一致：API Key 只存在于服务端配置，禁止通过 `VITE_` 泄漏到浏览器；MCP 默认只绑本地 + Bearer Token；媒体目录与云存储凭据不写入项目 JSON
  - 本地项目存储 `~/.openchatcut` + IndexedDB 缓存（仓库内含 sqlite 迁移校验脚本）
- **与我们相同**：
  - 桌面优先 + 本地项目存储 + 嵌入式服务进程，web 与 desktop 构建共享同一套项目 / Agent / 生成 / 导出逻辑
  - "AI 建议 → 校验 → 显式应用"的治理闭环（它叫 proposal，我们叫 AI 修改提案）
  - 词级转录驱动剪辑、字幕与导出产物（MP4 / 字幕 / 工程数据）
  - 对不可回滚操作（生成、导出、删除）做显式隔离
- **与我们不同**：
  - **sidecar 用 Node 而非 Python**（服务端插件化：生成、转录、媒体、导出、存储）
  - 渲染主路径是 **Remotion（React → 无头 Chromium）**，FFmpeg 是辅助；我们是纯 FFmpeg 渲染管线
  - 持久化用文件/IndexedDB 为主的本地项目存储，我们是 SQLite 关系模型
  - 它内置了生成式 AI（图片/视频/语音/音乐/音效）与 WebGL 特效库，我们第一阶段不预置生成模型
  - 它是 AGPL，商用分发约束更紧
- **可借鉴**：`src/editor/` 与 UI/LLM 解耦的目录契约写法；"只暴露 draft-safe 的只读/可回滚工具给外部 Agent"这条工具分级策略；Remotion 作为复杂动效预览/导出的补充路径（可作为我们纯 FFmpeg 渲染的兜底方案评估项）

---

### 2.2 Timeline Studio（MartinDelophy/ai-video-editor）— 声明式编辑计划 + 事务化应用

- **链接**：https://github.com/MartinDelophy/ai-video-editor
- **Star / 语言 / 协议**：613 / JavaScript / MIT（创建于 2026-07，日更）
- **技术栈**：浏览器内 local-first 编辑器；WebGPU 推理（Whisper small q8 ONNX、Stable Audio、MODNet、NanoVSR、JoyVAS A/LivePortrait）；WebCodecs 合成与 MP4/WebM 封装；可安装 PWA；Node ≥ 22.20 的无头命令运行器
- **核心架构特点**：
  - **`.timeline` 可移植项目文件是唯一事实来源**，媒体文件不被重写
  - **声明式 JSON 编辑计划 + 校验器**（`validate_edit_plan.mjs`）+ **事务化应用 + dry-run + 幂等 operation id**
  - 无头 CLI 暴露 `project.inspect / track.inspect / clip.inspect / transcript.inspect / project.diff / project.run / project.render`
  - 模型镜像双源（Hugging Face / ModelScope），按 UI 语言与会话地区自动选择并记忆首个可用源
  - 预览走原生播放，导出走独立的确定性离线渲染路径（预览/导出共享几何）
- **与我们相同**：
  - 项目文档而非聊天记录作为唯一事实来源；AI 编辑必须落成可校验、可 diff、可回滚的结构化计划
  - 局部产物、代理/缩略图、确定性离线渲染、失效与重算边界
  - 本地 ASR、本地配音/配乐、无媒体外传
- **与我们不同**：
  - 纯浏览器（PWA + OPFS/IndexedDB），不是桌面原生应用；模型全部 ONNX/WebGPU 前端推理
  - 模型交付与缓存是它的一等工程问题（Service Worker 缓存 + revision pinning），我们用本地模型管理模块承担同类职责但形态不同
  - 它主打浏览器端数字人/配音/去水印等"AI 工具箱"，我们聚焦粗剪与审片流程
- **可借鉴**：编辑计划的 `diff` 与"幂等 operation id"设计（直接对应我们的差异比较与显式应用）；`project.diff` 这种"先给预测差异再落盘"的交互；双模型源镜像策略（对国内网络环境有直接价值）

---

### 2.3 OpenEdit — Python + SQLite + faster-whisper + MCP，栈结构最近

- **链接**：https://github.com/AH64-dll/OpenEdit
- **Star / 语言 / 协议**：45 / Python / MIT（v1.3.1，Linux / macOS / Windows）
- **技术栈**：Python 3.11+；以 **stdio 运行的本地 MCP Server**；faster-whisper 词级转录；**SQLite（WAL）中的 append-only IR 编辑图**；melt + ffmpeg 渲染
- **核心架构特点**：
  - SHA-256 **内容寻址入库**（ingest）
  - 28 种 IR 编辑操作，全部**记录、可逆、可渲染**
  - **代理审片产物 640×360 + 最终 1080p 导出**的二级渲染
  - 无云、无内置 LLM——外部 Agent（Cursor / Claude Code / 任意 MCP 客户端）持有创作循环，OpenEdit 只持有"机械装置"
- **与我们相同**（栈层面几乎一比一）：
  - Python 领域服务 + SQLite + faster-whisper + FFmpeg 子进程
  - 原素材只读、内容寻址、派生/代理产物分层
  - 代理预览与最终成片分离的二级渲染
  - AI 与程序职责分离：Agent 负责创作决策，程序负责校验与执行
- **与我们不同**：
  - **没有 GUI**，完全由外部 Agent 通过 MCP 驱动（我们是 GUI 为主、AI 提案为辅）
  - IR 编辑图是**追加写（append-only）**的历史模型，我们是时间线 Revision + 锁定元素
  - 渲染用 melt（MLT）而非纯 FFmpeg 命令编排
  - 规模很小（45 Star），成熟度与工程化深度远低于本仓库
- **可借鉴**：append-only IR 编辑图作为"可解释/可重放历史"的实现思路；"代理审片 + 最终导出"二级渲染的显式产物分层；把领域能力直接暴露为 MCP server（这是我们 Stage 3 可以低成本补上的生态位）

---

### 2.4 Velocut — 协议优先、双引擎 + 黄金向量测试

- **链接**：https://github.com/open-ribbi/velocut
- **Star / 语言 / 协议**：450 / TypeScript（核心引擎为 Rust→WASM）/ MIT
- **技术栈**：Rust 权威引擎（`velocut-core`，纯 Rust 无 wasm 依赖）+ TypeScript 参考引擎（`core-ts`），二者用**共享黄金向量（golden vectors）测试锁定行为一致**；WebGPU 合成；WebCodecs 解码/导出；Yjs CRDT 多标签同步；OPFS + IndexedDB
- **核心架构特点**：
  - **协议优先、AI 原生**：人类 UI 与 LLM Agent **走完全相同的 JSON 命令协议**，Agent 被视为系统的一等用户
  - 时间用微秒整数（`atUs`），命令形如 `window.velocut.apply({type:'splitClip', clipId:'clip_2', atUs:1500000})`
  - **分支式编辑历史**（回到过去修改即分叉；人类操作与 AI 操作按颜色区分）
  - Agent 具备"感知"能力：抽帧观察 / 镜头边界检测 / 响度与静音分析
  - 任何引擎行为变更都必须新增一条 golden vector，Rust 与 TS 两侧同时通过才算一致
- **与我们相同**：整数微秒时间模型（这是少数明确与我们有同样取舍的项目）；AI 与人类共用同一套受控命令；可追溯、可分叉的历史
- **与我们不同**：
  - 浏览器运行时（WebGPU/WebCodecs/OPFS），无桌面壳与本地数据库
  - 双引擎 + 黄金向量是一套很重的"行为契约"工程，我们目前靠 contracts 包 + 测试覆盖
  - AI 出口更激进（Agent 主动感知与批量执行）
- **可借鉴**：**黄金向量（golden vectors）作为跨实现的行为契约**——如果未来我们要把渲染计划改成多实现（FFmpeg 直编 / Remotion / 硬件编码分支），这套方法可直接复用；Agent 感知结果以可视化卡片呈现（与本仓库"记录选择理由"的诉求同源）

---

### 2.5 FableCut — 项目文件即接口

- **链接**：https://github.com/ronak-create/FableCut
- **Star / 语言 / 协议**：640 / JavaScript / —  （零 npm 依赖，`node server.js` 单文件启动）
- **核心技术栈**：浏览器 NLE，3 视频轨 + 4 音频轨；**整条时间线是一个 JSON 文档（`project.json`）**；MCP + REST 双通道；SSE 热重载约 150 ms
- **核心架构特点**：把"项目文件即接口"做到极致——任何能写 JSON 的进程都能剪辑；人类与 Agent 可同时在同一时间线上工作
- **与我们相同**：唯一事实来源是可读可验的项目文档；Agent 与人共用同一数据契约
- **与我们不同**：无数据库、无任务系统、无校验层（无 Schema 校验、无引用校验、无时间范围校验），属于"极简换灵活"；渲染依赖浏览器
- **可借鉴**：SSE 热重载带来的"人看着 AI 改"体验，成本极低；把项目文件设计成可被外部进程直接读写的稳定格式（对我们未来做批量/无头导出有参考价值）

---

### 2.6 Palmier Pro — 明星项目，但源码已闭源

- **链接**：https://github.com/palmier-io/palmier-pro
- **Star / 语言 / 协议**：14,140 / Swift / GPL-3.0（**仅到 v0.7.6，见 `last-gpl-source` 分支；之后为专有**）
- **技术栈**：macOS 26 (Tahoe) + Apple Silicon 独占；Swift 原生重写；内置生成式模型（Seedance、Kling、Nano Banana Pro）；**应用运行时暴露 MCP Server：`http://127.0.0.1:19789/mcp`**
- **核心架构特点**："为 AI 而生的 Premiere"，Agent 直接在时间线上创作；提供 mcpb 一键装进 Claude Desktop
- **与我们相同**：本地 MCP 端口暴露编辑器能力；时间线为事实来源；AI 生成与剪辑同处一个工作区
- **与我们不同**：闭源转向（只能作为历史参考）；macOS 独占；生成式 AI 为一等功能
- **判断**：**只宜作为产品形态与 MCP 接入方式的参考，不宜作为代码级参考**。但它把 MCP 端点做成"应用内可一键安装"的交付方式，值得我们在 Stage 3 复刻。

---

### 2.7 oh-my-cassette — Python + MCP 剪辑搭档，但素材上云（第二轮新增）

- **链接**：https://github.com/Cassette-Editor/oh-my-cassette
- **Star / 语言 / 协议**：139 / Python / MIT（创建于 2026-06-10，最后推送 2026-08-27，活跃）
- **技术栈**：Python 3.11–3.13 + ffmpeg；本体是**本地 MCP Server**，以 Claude Code / Codex / OpenCode / Hermes 的 **plugin marketplace** 形式分发；实际剪辑与渲染跑在 Cassette 云端服务（需注册账号）
- **核心架构特点**：
  - 彻底放弃 GUI 与时间线 UI，自我定位是 "No timeline. No editing software. No GPU."
  - **每轮对话只返回 timeline digest + contact sheet（接图表，每片段抽一帧）**，用户批准后才触发渲染——"Nothing Renders Until You Say So"
  - 剪辑能力：节拍同步剪切、自动配乐匹配、字幕、转场、画中画、调色、lower-third
  - **公开真实成本数据**：一个 30 秒成片会话约 55K output / 2.33M input tokens（Opus 5，约 $4），端到端 8–15 分钟
  - 官方案例中明确包含 **game highlights** 方向
- **与我们相同**：
  - Python + ffmpeg 的技术底座；面向中文用户的多平台短视频产出
  - **"先给可审阅的摘要，批准后才执行昂贵渲染"**——与我们的「AI 候选粗剪 → 确认 → 比较/采纳」+ 「外传确认」是同一思想的轻量实现
- **与我们不同**：
  - **不是本地优先**：素材需上传到 Cassette 云、需注册账号（我们默认不上传、不要求账号）
  - 无本地项目数据库、无 Revision、无锁定元素；"编辑状态"在云端 Agent 侧
  - 无 GUI 时间线 → **没有局部微调能力**，改稿只能再下一轮 prompt，成本随轮次线性叠加
  - 按 token 计费，单次成片 ~$4，成本不可控
- **可借鉴**：
  - **contact sheet（接图表）是极高性价比的审片交互**——渲染前用"每片段一帧"让用户秒懂 AI 选了什么，开销接近零。建议列入 Stage 2C/3 的 AI 提案预览，作为我们现有"差异比较"的轻量化前置
  - 主动公开单次会话的 token/费用实测，是很好的产品透明化做法；我们的 `ProviderInvocation` 已记录费用，可在 UI 侧做同等呈现
  - 把能力打包成 agent plugin 走 marketplace 分发，是零成本触达开发者用户的渠道

---

## 3. 第二梯队：同一产品形态（桌面剪辑器），AI 深度不同

| 项目 | Star / 语言 | 技术栈与架构要点 | 与我们相同 | 与我们不同 |
|---|---|---|---|---|
| **CartCut**<br>https://github.com/cartesiancs/cartcut | 589 / TypeScript（MIT） | Electron + webpack；**FFmpeg/ffprobe 二进制随包分发（`bin/{platform}-arch}/`）**；**图层式（layer-based）编辑而非传统轨道**；无限图层、关键帧、WebGL 模糊、whisper 自动字幕、ChromaKey、录屏；Playwright E2E（smoke/extreme 多档） | 桌面优先、ffmpeg 子进程、本地 ASR 字幕、项目文件存读、多平台打包 | 图层模型 vs 轨道模型；**无后端领域服务、无数据库、无 AI 审片治理**；AI 仅用于自动字幕；当前 0.4.x 正在重构、README 自述不稳定 |
| **WolfCut**<br>https://github.com/jub0t/WolfCut | 144 / TypeScript（MPL-2.0） | **Rust 引擎 + React 界面**；whisper.cpp 本地字幕；ffmpeg 做语音滤波；多轨时间线、模板复用；Alpha 阶段 | 跨平台桌面 CapCut 替代品、本地 whisper 字幕、ffmpeg 处理 | 无本地服务与数据库；Rust 而非 Python；功能面还很早期（对象/人脸跟踪、自动重构画均在 Roadmap） |
| **OpenCut**<br>https://github.com/OpenCut-app/OpenCut | 87,777 / TypeScript（MIT） | 当前版本可用的是 `opencut-app/opencut-classic`：**Next.js + React + FFmpeg.wasm** 的浏览器编辑器。**正在用 Rust core 从零重写**，规划 Editor API、插件优先架构、桌面/移动/浏览器同一代码库、MCP Server、无头模式、编辑器内脚本 Tab | 目标形态（桌面 + web + 本地）与我们一致；规划中的 MCP / 无头批量与我们 Stage 3 相似 | 当前实现是 Web 栈 + FFmpeg.wasm（性能路径与我们完全不同）；重写期不接受外部贡献，架构未定；进度风险高 |
| **LosslessCut**<br>https://github.com/mifi/lossless-cut | 43,272 / TypeScript（GPL-2.0） | Electron + React；**纯 FFmpeg 命令行编排**，以"无损剪切"为第一性原理；分段（segment）模型而非完整 NLE 时间线；项目文件保存切段；同时提供 **CLI 与 HTTP API**；黑场/静音/场景变化检测 | **Electron 壳 + FFmpeg 子进程 + 本地项目文件**这套底座与我们完全一致；原素材不重编码 | 无后端领域服务、无数据库、无时间线/轨道概念、无 AI；定位是 FFmpeg GUI 而非创作工具。**是我们验证"Electron→FFmpeg 子进程管理、进度解析、取消与进程树清理"的最佳成熟样本** |
| **Cap**<br>https://github.com/CapSoftware/Cap | 21,316 / Rust（自建协议） | **Tauri + Rust + React**；录屏 → 本地编辑 → 分享/导出；转录与 AI 标题/摘要/章节；可完全自托管（Docker Compose + S3 兼容存储） | 本地优先 + 数据自有 + AI 增强元数据（转录/字幕）；桌面 + 服务双形态 | 核心场景是录屏协作而非剪辑创作；Rust/Tauri 而非 Electron/Python；默认走云服务与团队空间 |

---

## 4. 第三梯队：AI 剪辑流水线（后端技术栈同构，形态不同）

这一梯队**几乎全部是"Python + 前端面板（Streamlit/Gradio）+ ffmpeg/moviepy + whisper"**——本仓库的 Python 核心服务正是这套栈的"工程化升级版"，但我们的交付形态是桌面应用，它们是可脚本化的流水线。

| 项目 | Star / 语言 | 技术栈与架构要点 | 与我们相同 | 与我们不同 |
|---|---|---|---|---|
| **MoneyPrinterTurbo**<br>https://github.com/harry0703/MoneyPrinterTurbo | 118,169 / Python（MIT） | Python 3.11+；**Streamlit WebUI + FastAPI API + CLI + AI Agent 四种入口，代码按 controller / service / model 分层**；moviepy 2.2.1 + faster-whisper 1.1.0 + edge-tts + litellm；9:16 / 16:9 批量生成、多素材源（Pexels/Pixabay/Coverr）、文生视频（Seedance）、一键发布 TikTok/IG/YT Shorts | **后端技术栈几乎同构**（FastAPI + Pydantic 系 + faster-whisper + ffmpeg + 多 Provider 聚合网关）；"Provider 可替换"与"能力分层"思路一致；面向短视频平台导出 | **无时间线、无审片、无 Revision**——它生成即成品，不可再编辑；无项目数据库与任务状态机；依赖 Streamlit 面板而非桌面 GUI；无本地优先约束（默认走云 LLM/TTS/素材） |
| **NarratoAI**<br>https://github.com/linyqh/NarratoAI | 10,906 / Python（MIT） | Python + Streamlit；LLM 文案 → 逐帧视觉分析 → 自动剪辑 → 配音 → 字幕的一站式影视解说流水线；TTS 引擎可插拔（IndexTTS / 腾讯云 / 豆包 / Sonilo 配乐）；`uv` + Python 3.12 本地运行流程 | 面向中文短视频平台的"配方式"内容生产；LLM + 视觉分析 + 剪辑的编排思路与我们 Planning/Recipe 模块一致 | 无时间线数据模型与版本化；无本地优先/凭据隔离设计；依赖云端 LLM 与 TTS；WebUI 一次性任务，不做项目恢复 |
| **VideoLingo**<br>https://github.com/Huanshere/VideoLingo | 18,280 / Python | Streamlit 一键启动；**WhisperX 词级识别** + NLP 字幕切分 + 三步翻译（Translate-Reflect-Adaptation）+ GPT-SoVITS 配音；**支持任意步骤暂停/恢复** | 词级时间轴对齐是我们字幕链路要解决的同一问题；长任务可暂停可恢复的诉求一致 | 定位是翻译/配音本地化而非剪辑决策；无时间线与候选方案；无项目数据库 |
| **AI YouTube Shorts Generator**<br>https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator | 4,756 / Python | Opus Clip 开源替代；yt-dlp + faster-whisper/Whisper API + OpenCV 人脸跟踪竖屏裁切 + LLM 爆点排序（hook/情绪峰值/金句/冲突等）+ 去重 + 长视频分块；`--mode local` 全离线；支持 JSON 输出 | **长视频 → 多候选片段 → 打分排序 → 竖屏重构画 → 导出**这条链路，与我们的 CandidatePlan 阶段高度对应；支持全本地模式 | 无人工审片与局部修改闭环；打分是启发式 prompt 而非可解释领域规则；无项目/时间线/重算模型；单片一次性产出 |
| **agentic-video-editor**<br>https://github.com/poseljacob/agentic-video-editor | 479 / Python（MIT） | Python 3.11 + Google ADK；**Director / TrimRefiner / Editor / Reviewer 多 Agent 流水线**，用 **YAML manifest 定义 pipeline 步骤 + `retry_if` 门控 + 反馈回传**；产出 EditPlan → FFmpeg/MoviePy 渲染；每次重试另存 `v1/v2/v3` | **"AI 产出编辑计划 → 渲染 → 评审 → 不达标则回退重试"** 与我们的"AI 候选粗剪 + 确认 + 比较/采纳"是同一思想的两种实现；版本化产物 | 多 Agent 自治（本仓库架构文档明确排除）；评审基于模型主观打分而非确定性校验；无 GUI、无项目数据库、无锁定/局部重算 |
| **opensource-clipping**<br>https://github.com/NaufalRizqullah/opensource-clipping | 78 / Python（MIT） | Whisper + Gemini + MediaPipe + Pyannote；人脸跟踪 + 卡拉OK 动效字幕 + 情境 B-roll + AI 配音 + 自动上传 | 长转短、字幕动效、B-roll 插入的组合打法与目标平台一致 | 一体化脚本，无分层架构与状态管理；强依赖云端模型 |
| **montage-ai**<br>https://github.com/mfahsold/montage-ai | 46 / Python | Docker 化；转录驱动剪辑 + 节拍对齐切点；**导出 OTIO/EDL 给 Premiere/Resolve**；`QUALITY_PROFILE=preview` 预览档 | **"粗剪交给程序，精修回到专业软件"+ 预览档/成片档** 的分层，与我们"候选粗剪 → 人工审片 → 权威导出"理念一致；OTIO/EDL 是很好的互操作出口 | 规模很小；Docker 交付而非桌面应用；无 GUI 时间线 |

> 小结：这一梯队验证了一件事——**"Python 做领域与编排、ffmpeg 做渲染、whisper 做转录"是事实标准组合**，本仓库选型没有风险。它们的共性短板（无项目状态、无审片闭环、无局部重算）恰恰是本仓库的差异化所在。

---

## 5. 第四梯队：可直接复用/借鉴的组件与规范

| 项目 | Star | 用途与可借鉴点 |
|---|---|---|
| **editly**<br>https://github.com/mifi/editly | 5,479 / TypeScript (MIT) | **声明式 NLE：JSON/JSON5 编辑规格 → 流式 ffmpeg 渲染**，天然支持任意宽高比（1:1 / 9:16 / 16:9）、自动 letterbox、自动升降速匹配 `cutFrom`/`cutTo`、音频自动交叉淡化与 ducking、GL shader 与 Canvas 动态层。**是我们"时间线 JSON → Render Plan → ffmpeg"思路最直接的开源先例**，其 spec 字段设计值得对照审查我们的 Render Plan schema（最近更新 2025-05，活跃度一般） |
| **Remotion**<br>https://github.com/remotion-dev/remotion | 57,638 / TypeScript | React 组件 → 视频；无头 Chromium 渲染。OpenChatCut 用它做导出主路径。对复杂动效/字幕排版/模板化包装是 FFmpeg 滤镜链的强力替代，代价是包体与内存 |
| **Diffusion Studio Core**<br>https://github.com/diffusionstudio/core | 1,231 / TypeScript (MPL-2.0) | 浏览器视频引擎：Canvas2D + WebCodecs 硬件加速；声明式时间线组合、静音移除、关键帧、蒙版、检查点（checkpoint）、实时播放与高保真渲染双模式。其"检查点"与"双模式渲染"概念可对照我们的预览/权威渲染设计 |
| **Twick**<br>https://github.com/ncounterspecialist/twick | 534 / TypeScript | React 视频编辑 SDK：canvas 时间线、WebGL 特效、AI 字幕（Vertex AI Gemini）、**Serverless MP4 导出**。若我们未来做 Web 端，这是成熟度较高的组件来源 |
| **auto-editor**<br>https://github.com/WyattBlue/auto-editor | 5,097 / **Nim**（早期为 Python，Unlicense） | 命令行自动剪辑的事实标准：以**音频响度/运动量**检测"死区"，`--edit "(or audio:0.03 motion:0.06)"` 这种可组合编辑方法表达式、margin 节奏控制。**其"可组合的编辑方法表达式"是我们 Analysis/Recipe 模块化很好的参照** |
| **ffmpeg-webCLI**<br>https://github.com/tejaswigowda/ffmpeg-webCLI | 1,391 / JavaScript (GPL-3.0) | 浏览器内 ffmpeg.wasm 编辑器，无上传无服务器。验证 Web 端纯本地方案的性能边界（对我们判断"是否要上 Web 版"有参考） |
| **文本驱动剪辑小集群**：`preston176/openscript`(19)、`SinanTang/poddie`(20)、`jinyang0530/podcut`(109)、`mfahsold/montage-ai`(46) | — | 均在做"编辑文本即编辑视频"。共性做法：词级时间戳 ↔ 时间线片段的双向绑定、删除文本即删除片段。可作为我们字幕编辑交互的交互范式参考 |

---

## 6. 横向对比矩阵

图例：✅ 明确具备 ｜ 🟡 部分/规划中 ｜ ❌ 无

| 项目 | 桌面原生 | 本地优先 | 领域服务 | 项目 DB | 时间线 | Rev/历史 | AI 提案需校验 | 局部重算 | 代理/预览 | 确定性渲染 | MCP/Agent |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Vortex Cut（我们）** | ✅ Electron | ✅ | ✅ Python FastAPI | ✅ SQLite | ✅ 轨道 | ✅ Revision + 锁定 | ✅ Schema+引用+时间校验 | ✅ 失效重算 | ✅ | ✅ Render Plan | 🟡 仅内部受控 Provider |
| OpenChatCut | ✅ Electron 43 | ✅ | ✅ Node 插件服务 | 🟡 本地存储 + IndexedDB | ✅ 多轨 | ✅ 命令层 + 提案 | ✅ 命令层校验 | 🟡 | ✅ | ✅ Remotion/FFmpeg | ✅ MCP + Skills |
| Timeline Studio | ❌ 浏览器/PWA | ✅ | ❌ | 🟡 `.timeline` 文件 | ✅ 主轨+叠加 | ✅ 版本化 JSON 计划 | ✅ validate + 幂等 | 🟡 | ✅ | ✅ 离线渲染路径 | ✅ Agent Skill |
| OpenEdit | ❌ 无 GUI | ✅ | ✅ Python | ✅ SQLite WAL | ✅ IR 编辑图 | ✅ append-only | ✅ 28 种 IR 操作 | ✅ | ✅ 640×360 代理 | ✅ melt/ffmpeg | ✅ MCP stdio |
| Velocut | ❌ 浏览器 | ✅ | ❌ | 🟡 OPFS/IndexedDB | ✅ 多轨 | ✅ 分支历史 | ✅ 协议校验 | 🟡 | ✅ | ✅ WebCodecs | ✅ 同协议 Agent |
| FableCut | ❌ 浏览器 | ✅ | ❌ | 🟡 `project.json` | ✅ 3V+4A | 🟡 undo/redo | ❌ | ❌ | 🟡 | 🟡 | ✅ MCP + REST |
| CartCut | ✅ Electron | ✅ | ❌ | ❌ 项目文件 | 🟡 图层式 | 🟡 | ❌ | ❌ | 🟡 | ✅ ffmpeg | ❌ |
| WolfCut | ✅ Rust 引擎 | ✅ | ❌ | 🟡 | ✅ 多轨 | 🟡 | ❌ | ❌ | 🟡 | ✅ ffmpeg | ❌ |
| LosslessCut | ✅ Electron | ✅ | ❌ | 🟡 项目文件 | 🟡 分段 | ✅ undo/redo | ❌ | ❌ | 🟡 | ✅ ffmpeg | ❌ 仅有 HTTP API |
| OpenCut（classic） | 🟡 规划中 | 🟡 | 🟡 规划 Editor API | 🟡 | ✅ | 🟡 | ❌ | ❌ | 🟡 | ✅ ffmpeg.wasm | 🟡 规划中 |
| Cap | ✅ Tauri | ✅ | ✅ Rust 服务 | ✅ | 🟡 录屏剪辑 | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Palmier Pro | ✅ Swift | ✅ | — | 🟡 | ✅ | 🟡 | 🟡 | ❌ | ✅ | ✅ | ✅ MCP |
| MoneyPrinterTurbo | ❌ | 🟡 可本地 | ✅ FastAPI | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | ✅ moviepy/ffmpeg | 🟡 AI Agent 入口 |
| NarratoAI / VideoLingo | ❌ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | ✅ | ❌ |
| AI Shorts Generator | ❌ | ✅ `--mode local` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| agentic-video-editor | ❌ | ❌ | ❌ | ❌ | 🟡 EditPlan | ✅ v1/v2/v3 | 🟡 打分门控 | ❌ | ❌ | ✅ | ✅ 多 Agent |

---

## 7. 差异化分析与行动建议

### 7.1 我们领先的地方（要守住、要对外讲清楚）

1. **工程化的可靠性闭环**：Revision + 锁定元素 + 差异比较 + 失效重算，在调研样本中只有 OpenChatCut（命令层/提案）与 Timeline Studio（版本化计划/幂等）部分覆盖，其余项目要么没有、要么只做 undo/redo。
2. **确定性约束下的 AI 治理**：JSON Schema + 引用校验 + 时间范围校验 + Provider capability 显式门控 + "未配置/未 supported 不得外传"。竞品普遍没有"外传前确认"这一层，OpenChatCut 有 approval policy，是唯一可类比的。
3. **整数微秒时间模型**：调研中只有 Velocut（`atUs`）明确采用同一取舍。对可变帧率游戏录像这是正确决策。
4. **领域模型与部署形态解耦**（模块化单体 + 桌面/服务器同一核心）：比 Streamlit 流水线类项目高一个工程层级，比微服务化的多 Agent 项目更适合单机场景。

### 7.2 我们的短板（建议列入 Stage 3 议程）

1. **缺少 Agent/MCP 接入点**——这是 2026 年这批新项目的最大公约数。Palmier Pro、OpenChatCut、Velocut、FableCut、OpenEdit 全部把"外部 Agent 驱动时间线"作为一等功能。我们的 sidecar 已经是本地 HTTP 服务，**暴露一层只读/可回滚工具 + 写操作需显式批准，成本不高、收益很大**。
2. **渲染路径单一**：纯 FFmpeg 滤镜链在动效字幕、模板包装、复杂转场上表达力弱于 Remotion/Chromium 方案。建议评估"**FFmpeg 主路径 + 复杂包装可选 Remotion**"的混合渲染（OpenChatCut 已验证可行）。
3. **互操作出口缺失**：montage-ai 的 OTIO/EDL 导出、OpenChatCut 的 FCPXML 导出，都是让专业用户"把活带回 Premiere/Resolve"的通道。对游戏短视频创作者，导出 FCPXML/EDL 能显著降低迁移成本。
4. **缺少 golden-vector 式的行为契约测试**：如果要引入多渲染后端或跨平台引擎差异，Velocut 的"双引擎 + 黄金向量"是值得抄的工程质量手段。
5. **模型/依赖交付**：Timeline Studio 的 HF/ModelScope 双源镜像 + revision pinning，对我们的国内网络环境和"离线可用"承诺是直接可用的做法。

### 7.3 需要持续观察的对象

- **OpenChatCut**：路线最重合，且迭代极快（2026-07 建仓已 1.4k Star），建议列为**头号跟踪对象**，重点关注其命令层与提案审批策略的演进。
- **OpenCut 的 Rust 重写**：如果其 "Rust core + 桌面/浏览器同构 + MCP + 无头" 落地，会成为本赛道最有分量的基础设施，需关注其 Editor API 设计。
- **CartCut**：图层式编辑模型是轨道模型之外的另一条路，可作为我们时间线模型扩展的对照。

### 7.4 关于"游戏高光 / 直播切片"

本次检索在**游戏高光自动检测**方向上没有找到有影响力的开源项目（相关仓库多在 0–3 Star，如 Auto-clipper、WatchDog、twitch-toolkit），这是一个**供给真空但需求真实**的方向。我们的首发场景（游戏类短视频）在开源侧缺少直接竞品，建议保留优势；同时可参考 `auto-editor` 的可组合检测方法表达式（`audio/motion` 阈值组合）来构建游戏录像的"事件检测配方"。

---

## 8. 参考链接清单

**第一梯队（重点）**
1. OpenChatCut — https://github.com/0xsline/OpenChatCut
2. Timeline Studio — https://github.com/MartinDelophy/ai-video-editor
3. OpenEdit — https://github.com/AH64-dll/OpenEdit
4. Velocut — https://github.com/open-ribbi/velocut
5. FableCut — https://github.com/ronak-create/FableCut
6. Palmier Pro — https://github.com/palmier-io/palmier-pro

**第二梯队（桌面编辑器）**
7. LosslessCut — https://github.com/mifi/lossless-cut
8. OpenCut — https://github.com/OpenCut-app/OpenCut （经典版 https://github.com/opencut-app/opencut-classic ）
9. Cap — https://github.com/CapSoftware/Cap
10. CartCut — https://github.com/cartesiancs/cartcut
11. WolfCut — https://github.com/jub0t/WolfCut

**第三梯队（AI 剪辑流水线）**
12. MoneyPrinterTurbo — https://github.com/harry0703/MoneyPrinterTurbo
13. VideoLingo — https://github.com/Huanshere/VideoLingo
14. NarratoAI — https://github.com/linyqh/NarratoAI
15. AI YouTube Shorts Generator — https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator
16. agentic-video-editor — https://github.com/poseljacob/agentic-video-editor
17. opensource-clipping — https://github.com/NaufalRizqullah/opensource-clipping
18. montage-ai — https://github.com/mfahsold/montage-ai

**第四梯队（组件/规范）**
19. editly — https://github.com/mifi/editly
20. Remotion — https://github.com/remotion-dev/remotion
21. Diffusion Studio Core — https://github.com/diffusionstudio/core
22. Twick — https://github.com/ncounterspecialist/twick
23. auto-editor — https://github.com/WyattBlue/auto-editor
24. ffmpeg-webCLI — https://github.com/tejaswigowda/ffmpeg-webCLI
25. openscript — https://github.com/preston176/openscript

**其他提及（低 Star，方向性参考）**
- poddie — https://github.com/SinanTang/poddie
- podcut — https://github.com/jinyang0530/podcut
- reelo — https://github.com/soysebas-reyes/reelo
- openscene — https://github.com/Theorvane/openscene
- deadair — https://github.com/ather-techie/deadair

---

## 附录：调研口径说明

- Star 数、语言、许可证、最后推送时间取自 GitHub REST API（`gh api repos/{owner}/{repo}`），快照时间 2026-08-29。
- 技术栈与架构描述取自各仓库 `main`/`master` 分支 README 原文，以及必要的 `package.json` / `requirements.txt` 核对，未采信第三方二手评测。
- "Star 数"只用于衡量社区热度与维护资源，**不代表架构质量**；本报告已剔除大量 2026 年新建、描述华丽但无实质实现的小仓库（搜索结果中存在较多此类噪声）。
- 本仓库已有的 `open-source-video-editors-survey.md` 覆盖的是 Kdenlive / Shotcut / OpenShot / Olive / Blender VSE 等**原生 C++/Qt NLE**；本报告聚焦 **JS/TS 桌面壳 + Python/AI 流水线**这条技术路线，两份文档互补。

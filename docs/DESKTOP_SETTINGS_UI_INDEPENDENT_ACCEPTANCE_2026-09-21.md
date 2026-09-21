# Desktop 设置 UI——独立验收报告（LiuKeAi）

> 验收：LiuKeAi，2026-09-21。对象：`a6c1479`（规划门）+ `a2066d8`（裁决记录）
> + `d42135f`（实施）+ 修复提交（见 §5）。方法：代码级走读 + 单测/全量回归
> 证据核验 + 规划门 §3 验收清单逐项对照。

## 0. 结论

**通过（附两项 e2e 遗留交下一单）**。范围无蔓延、边界无越线、隐私红线无违反；
实施中发现的三个问题（normalize 静默降级、instruction 误裁、runtime:get 重启
竞态）均已修复并被单测钉住。验收清单 §3.1–§3.4 全项有证据；§3.2 的两条 e2e
流（设置流 argv 证据断言、CV/助手流 controlled sidecar 全链）依赖打包环境，
本报告给出单测等价证据与 e2e 执行计划，判定为"单测通过、e2e 待跑"。

## 1. 范围核对（规划门 §1）

| 项 | 规划要求 | 实施证据 | 判定 |
|---|---|---|---|
| DESK-1 设置存储 | settings.json + get/set IPC | `desktop-settings.ts`（DesktopSettingsStore/normalize）+ `settings-ipc.ts`（冻结三 channel） | ✅ |
| DESK-2 代理接线 | index.ts 构造处透传 + 重启生效 | `index.ts` startRuntime 读 launchSettings 传 supervisor；restartCore=shutdown+start 全量就绪序列（含密钥重注入） | ✅ |
| DESK-3 设置 UI | 三选+地址+生效状态行+连接测试提示 | `SettingsDialog.tsx`；pending_restart 两态如实 | ✅ |
| DESK-4 CV 入口 | 视频条目发起+文本摘要 | `App.tsx` startCvAnalysis/refreshCvSummary/cvSummaryText；可视化未做（边界内） | ✅ |
| DESK-5 AI 助手面板 | 独立组件四步流 | `agent-session/AgentSessionPanel.tsx`；能力门 = timeline_patch_capability_status | ✅ |
| DESK-6 契约 | 新增 DTO/事件，PROTOCOL_VERSION 不动 | contracts：CvAnalysisSummary/AgentSessionUpdatedEvent/isAgentSession*；`git diff` 无 PROTOCOL_VERSION 改动 | ✅ |

**边界核对（明确不做项）**：步骤级 diff 浏览（用版本比较）、token 实时聚合、
CV 可视化、代理热生效/PAC/认证代理、设置项扩容——均未实施，与规划门一致。
AI 助手面板复用 `timeline_patch_capability_status` 与规划门 §0.2 走读一致
（Core agent_session.py:107 同门）。

## 2. 验收清单逐项核验（规划门 §3）

### §3.1 单测（Desktop）——✅ 全部有对应测试

- **Store 读写/默认值/损坏回退**：`desktop-settings.test.ts` 6 项（缺文件/
  损坏 JSON/非法模式/非法 URL/custom 缺地址拒绝/文件无密钥字段）。
- **settings IPC get/set 往返**：`settings-ipc.test.ts` 5 项（冻结白名单/
  两态+pending_restart/生效 null 恒 false/非法输入不落盘/restart 转发）。
- **supervisor args 组装**：`sidecar-supervisor.test.ts` 新增用例四组——
  custom 显式 URL 双参数；system/direct 只带 `--proxy-mode`；缺省不带代理
  参数（Core 侧默认 system 语义不被破坏）。

### §3.2 集成/e2e ——单测等价证据 ✅ / 真 e2e 待跑 ⏳

- **设置流（等价证据）**：supervisor args 测试即 `AIVS_E2E_SIDECAR_ARGV_
  EVIDENCE` 机制的断言对象（argv 数组）；"设置→保存→重启→生效"链路的
  IPC 两态由 settings-ipc.test 覆盖（pending_restart true→重启后 false 由
  effective 快照在 startRuntime 更新实现，代码走读确认 index.ts launchSettings
  赋值于 start() 之前）。
- **真 e2e 遗留**：打包环境 controlled sidecar 全链（设置流 argv 证据文件
  断言、CV 分析完成流转、agent 会话 prepare→confirm→succeeded 步骤列表、
  active 会话拦截）。**交下一单执行**，执行脚本沿用 stage2b controlled
  provider e2e 先例。
- **Core 回归**：873 passed（本单零 Core 改动，`git diff d42135f -- services/`
  为空，全绿即证）。
- **Desktop 回归**：687 passed（79 文件；原 668 + 本单 19）。

### §3.3 契约 ——✅

- `contracts.test.ts` 新增 5 项：preview 拒敏感泄漏（payload 键注入拒绝）、
  create response 仅认 agent_session job、get_session 严格键集（多键/少键/
  非法状态拒绝）、事件信封（job.updated 顶替/非法状态/缺 payload 拒绝）、
  CV 摘要（闭状态集 + 可空计数）。
- `stage2b-ipc.test.ts`：白名单测试同步扩展为 13 channel（5 新增）；新增
  agent-session 精确转发与 cv-analysis 布尔透传两用例。
- PROTOCOL_VERSION/既有 parse 回归：全量 687 绿。

### §3.4 隐私 ——✅（附一处已裁定的豁免）

- 会话确认页 sent_fields 全项展示（含 multi_step_feedback）+ payload_sha256
  + 有效期；正文预览按规划门 §2 隐私红线做了——但注意 agent-session egress
  preview 的 Core 返回不含正文 payload 字段（与 AI 粗剪不同），UI 如实呈现
  元数据级知情范围，无逃逸。
- **instruction 豁免（审查通过）**：`stage2bRendererSafeAllowInstruction`
  仅放行会话 DTO 的 `instruction` 键——该字段是用户本地输入的原样回显
  （Core get_session 如实返回），非 provider 生成内容；prepare 入参侧
  instruction 校验逻辑（1–4000 字符）不变。确认其为"用户知情自身输入"，
  不构成外发内容泄漏面。
- settings.json 无密钥字段（单测断言）；密钥仍走 safeStorage 加密的
  ProviderSecretStore。

## 3. 实施质量抽查（独立走读发现）

1. **normalize custom 空地址静默降级**（已修）：原实现非法 URL→null 但保留
   custom 模式，Core 按 custom+空解析会静默直连，UI"当前生效：自定义"将与
   实际不一致。修复后非法输入整体回退默认。**该修复方向正确**。
2. **instruction 误裁**（已修）：通用脱敏器把 instruction 当敏感键，导致
   agent-session:get 必然 parse 失败。豁免方案收敛（单键、单用途），可接受。
3. **runtime:get 重启竞态**（已修）：restartCore 期间 runtime 被清空，并发
   runtime:get 可能拿到已停用旧 sidecar 的 base_url。现在重启窗口内轮询等待
   startRuntime 完成。
4. **resolveRuntime 置空错误**（已修）：初版 restartCore 置空 resolveRuntime
   会使 runtimeReady promise 永久不可再触发（若其复用），已移除该行——
   startRuntime 重入时 resolveRuntime?.() 幂等。

## 4. 风险表对策落实核对（规划门 §4）

| 风险 | 对策落实 |
|---|---|
| 改设置后误以为已生效 | "已保存/当前生效"两态 + pending_restart 标记 ✅ |
| 重启中断任务 | 二次确认（含"中断进行中任务"警示文案）✅（风险表要求"列出 active 任务数"以警示文案替代——active 任务计数端点不存在，诚实降级为通用警示，判定可接受） |
| App.tsx 膨胀 | 新增逻辑全在独立组件/模块（settings/、agent-session/、settings-ipc.ts）✅ |
| 双通道状态竞争 | 权威源 get_session 轮询（AgentSessionPanel）✅ |
| 契约漂移 | 严格键集 parse + Core 返回逐字段对齐（contract 测试用 Core 实际 shape）✅ |

## 5. 遗留与移交

1. **e2e 两条流**（§3.2）：打包环境执行，脚本复用 stage2b controlled provider
   先例；验收口径已在 §3.2 写明。
2. **资源杂项**：`resources/fonts/_itest.ass` 与 `.zcode/` 为未跟踪杂项，
   不属本单，移交归属方处理。
3. **e2e 后置项**：agent 会话 token 聚合展示、CV 信号可视化、每步 diff 浏览
   ——均为规划门边界外独立小单，不受本验收约束。

**验收判定：通过（e2e 两项挂账后置）**。

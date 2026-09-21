# Desktop 设置 UI e2e（设置流 + AI 助手流）——Implementation 工作单

> 起草：LiuWei，2026-09-21。承接 `DESKTOP_SETTINGS_UI_PLANNING_GATE_2026-09-21.md`
> §3.2 挂账（独立验收通过的两条 e2e）。实施：YeJing（Desktop）。验收：LiuKeAi 抽检。

## 0. 现状走读（2026-09-21 代码级）

- **受控 Provider e2e 先例**（`e2e/stage2b-controlled-provider.electron.spec.ts`）：
  loopback http server 模拟 OpenAI 兼容网关（区分 capability probe 与业务调用、
  四适配器协商、usage 回填），Electron launch 注入
  `AIVS_SIDECAR_EXECUTABLE=.venv python -m aivs_core.bootstrap` + `PYTHONPATH`
  直跑源码 Core；证据落 `result.json` + 敏感扫描。
- **argv 证据先例**（stage1a）：`AIVS_E2E_SIDECAR_ARGV_EVIDENCE` 指向 userData 内
  JSON，Main 每次启动写 `{executable,args,cwd}`（sidecar-supervisor.ts:67）。
- **agent 会话线协议**（本 e2e 的 mock 设计依据）：
  - probe：`probe_protocol_version` + nonce + scenario（set_layout→fit），
    走 `testTimelinePatchProviderCapability`（agent 会话复用此能力门）；
  - 业务调用：`/responses` 或 `/chat/completions`，payload 含
    `instruction/timeline/allowed_operations/...`，json_schema 结构化响应
    `{"summary","operations":[...]}`；每步成功落 Revision。
  - `agent_session.updated` 事件经 job 通道；一项目一个 active session。

## 1. 范围（两个新 e2e 文件，产品代码零改动）

### E2E-1 设置流（`e2e/settings-proxy.electron.spec.ts`）

1. Electron launch 注入 `AIVS_E2E_SIDECAR_ARGV_EVIDENCE`（userData 内）；
   预置 `settings.v1.json`：`{proxy_mode:"custom",provider_proxy:"http://127.0.0.1:10809"}`。
2. 断言 argv 证据 `args` 含 `--proxy-mode custom` 与 `--provider-proxy
   http://127.0.0.1:10809`（Core 侧收到；loopback provider 无需真代理——
   参数传递即被证，Core 端三级回退解析由 Core 单测覆盖）。
3. `settings:get` → `pending_restart=false`（生效=保存=custom）。
4. `settings:set direct` → `settings:get` → `pending_restart=true`；
   断言设置 UI 状态行渲染"有已保存未生效的更改"（page 驱动真 UI 打开设置对话框）。
5. `restartCore` → argv 证据出现第二份（新 sidecar）`--proxy-mode direct`；
   `settings:get` → `pending_restart=false`、`effective=direct`。
6. 防御：`settings:set custom+空 URL` 被 IPC 拒绝（rejects），保存值不变。

### E2E-2 AI 助手流（`e2e/agent-session-controlled.electron.spec.ts`）

受控 loopback provider（复用 stage2b mock 骨架）：

1. **能力门**：probe 请求返回合法 set_layout→fit 响应；
   `testTimelinePatchProviderCapability` → `supported`（agent 面板 Provider
   下拉仅列 supported，UI 断言）。
2. **会话成功链**：`prepareAgentSession` → 断言 egress preview 元数据
   （sent_fields 含 `feedback`/`allowed_operations`、无正文 payload 字段、
   max_steps=6）；`createAgentSession` → 业务调用计数 +1 → mock 返回
   `{"summary":"step-1","operations":[{set_layout→fit}]}` → 会话
   succeeded；`getAgentSession` 断言 steps=[1]/succeeded、Revision +1
   （每步落版本语义）；`agent_session.updated` 不致崩溃（未知事件容错）。
3. **active 拦截**：会话运行中再次 `createAgentSession` →
   `AGENT_SESSION_ALREADY_ACTIVE`（或 list 断言复看视图）。
4. **失败反馈重试**：mock 第 2 步返回非法 op（`add_transition`，不在 AI
   白名单）→ 结构化错误反馈注入步 2 → mock 步 3 返回合法 op → succeeded；
   断言 steps=3、失败步不落 Revision（Revision 净 +2）、两次业务调用均含
   `feedback` 字段（反馈注入可见性 = 会话级 sent_fields 如实）。
5. **敏感扫描**：证据目录无 instruction 明文 / providerSecret（沿用
   countSensitiveMatches 先例）。

## 2. 明确不做

- 真实外部代理服务器（参数传递证据足够；代理可达性属 Core 单测域）；
- step-limit/budget-exceeded 全链（Core 单测已覆盖，e2e 不重复造长链）；
- CV 分析流 e2e（单测已覆盖 IPC/DTO 全链，素材导入即作业登记属 Core 域）；
- 打包产物安装级 e2e（沿用现有 stage3b 手动 gate 流程，不在本单）。

## 3. 验收

1. `pnpm test:e2e -- --grep "settings|agent-session"` 两条新流全绿；
2. 既有 e2e 回归（stage1a/2a/2b 至少受影响子集）不回归；
3. Desktop 单测 687 + Core 873 保持全绿（预期零产品代码改动）；
4. 证据文件落盘且敏感扫描通过。

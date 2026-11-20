# Vortex Cut UI/UX 首轮重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不新增未冻结业务能力的前提下，将 Vortex Cut 桌面端整理为“专业编辑骨架 + 四种任务模式 + 受控 AI 辅助层”，并完成真实 Electron 窗口验收。

**Architecture:** 保留现有 React Renderer、Electron Main/Preload、Contracts、Core 和 SQLite 链路。首轮以 `App.tsx` 的 UI 状态编排和 `styles.css` 的布局/视觉收敛为主；仅在现有 IPC 不足以表达已存在 UI 状态时补充最小接口，不改变 Timeline、Revision、Provider 或导出业务语义。大型模态工作台继续由既有组件承担，主编辑壳负责统一入口、焦点、预览和任务反馈。

**Tech Stack:** React 19、TypeScript、Vite/electron-vite、Electron、lucide-react、Vitest、Playwright、pnpm。

## Global Constraints

- 产品定位固定为“专业能力与易用性平衡”。
- 交互模型固定为“专业编辑骨架 + 任务模式 + 受控 AI 辅助层”。
- 本轮不新增完整多轨音频、转场、关键帧、变速、倒放、平台发布 API 或任意停靠式工作区。
- 本轮不绕过 Core、Electron preload 白名单、Contracts 或现有 Revision 机制。
- AI 操作必须经过输入、处理/外传预览、用户确认、候选/提案、显式采用和 Revision。
- 保存状态、预览状态和异步任务状态必须分别表达，不能互相替代。
- 桌面端最低可用窗口约束继续满足现有 `body { min-width: 1024px; min-height: 720px; }`。
- 不创建临时恢复脚本、备份文件或与本任务无关的文档；不提交 Git。
- 所有代码修改完成后运行 `pnpm lint`、`pnpm test`、`pnpm build` 和 `git diff --check`。

## 文件地图

### 现有文件

- `apps/desktop/src/app/App.tsx`：主编辑壳、项目/素材/时间线/预览/导出状态和工作台入口；只保留编排逻辑，不在其中重复实现新的业务 API。
- `apps/desktop/src/styles.css`：桌面端布局、主题、面板、时间线、状态和模态样式；首轮应收敛 Stage 9 多次覆盖，避免继续无序追加同名选择器。
- `apps/desktop/src/app/Dialog.tsx`：统一模态对话框；用于可访问的确认、错误和任务详情容器，不复制为新的模态实现。
- `apps/desktop/src/app/safeErrors.ts`：Renderer 安全错误消息转换；所有新错误展示继续走此边界。
- `apps/desktop/electron/main/index.ts`：窗口控制和主进程 IPC；只有发现现有窗口状态接口不足时才修改。
- `apps/desktop/electron/preload/index.ts`：白名单桌面 API；任何新增 IPC 必须在此显式暴露并保持最小表面积。
- `apps/desktop/tests/dialog.test.tsx`：现有 Dialog 测试约定；新增 UI 状态测试应沿用 Vitest/Testing Library 约定并放在 `apps/desktop/tests/`。
- `docs/design/superpowers/specs/2026-08-23-vortex-cut-ui-ux-design.md`：已确认设计基线，本计划不得扩大其范围。
- `docs/requirements/M2_ROADMAP.md`：后续编辑能力基准；本计划只改善已有能力的可理解性，不提前实现 A/B/C 新功能。

### 计划新增文件

- `apps/desktop/tests/editor-shell.test.tsx`：主编辑壳的模式、状态标签、焦点和空态测试；只在现有测试无法容纳时创建。
- `apps/desktop/tests/editor-commands.test.tsx`：阶段 3 命令注册/作用域测试；仅当实际引入独立命令模块时创建。
- `apps/desktop/src/app/editorCommands.ts`：阶段 3 的纯数据命令注册表；不承担业务执行，只描述稳定命令 ID、名称、快捷键和上下文。

## Task 1: 建立主编辑壳状态基线

**Files:**
- Modify: `apps/desktop/src/app/App.tsx`，围绕现有状态声明、顶部布局和主编辑区 JSX。
- Modify: `apps/desktop/src/styles.css`，围绕 `.editor-shell`、`.editor-topbar`、`.editor-grid`、`.stage-pane`、`.timeline-pane` 和 Stage 9B 覆盖区。
- Test: `apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: 现有 `project`、`saveState`、`previewMode`、`previews`、`jobs`、`exports`、`selection`、`tab` 和窗口最大化状态。
- Produces: 稳定的主编辑壳结构、工作模式状态和可定位的状态标签；不新增 Core/IPC 合同。

- [ ] **Step 1: 先写壳层结构测试**

测试应验证默认渲染拥有项目栏、命令栏、媒体区、预览区、时间线、属性区和状态栏，并且默认模式为“剪辑”。测试使用可访问名称，不依赖 CSS 类名：

```tsx
it("renders the editor shell with editing mode and status regions", async () => {
  render(<App />);
  expect(await screen.findByRole("region", { name: "媒体库" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "项目预览" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "时间线" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "上下文属性" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "剪辑" })).toHaveAttribute("aria-pressed", "true");
});
```

如果现有 `App` 依赖初始化桥接，在测试文件中沿用仓库既有 `window.desktop` mock，不修改生产 API 以适应测试。

- [ ] **Step 2: 运行测试确认缺口**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: 新测试先因现有语义区域或模式按钮不存在而失败；记录失败断言，不修改测试使其适配旧结构。

- [ ] **Step 3: 增加有限工作模式状态**

在 `App.tsx` 增加单一状态类型：

```ts
type EditorMode = "edit" | "captions" | "ai" | "export";
const [editorMode, setEditorMode] = useState<EditorMode>("edit");
```

模式按钮只切换 Renderer 显示密度和入口，不清空 `selection`、`playhead`、`working`、`jobs`、`previews` 或任一 AI 工作台状态。已有 `tab` 继续表示媒体区内部的素材/转录标签，不能用它替代全局工作模式。

- [ ] **Step 4: 重排主壳语义区域**

给现有主区域增加稳定的 `aria-label` 和可见模式按钮：

```tsx
<nav aria-label="工作模式">
  <button aria-pressed={editorMode === "edit"} onClick={() => setEditorMode("edit")}>剪辑</button>
  <button aria-pressed={editorMode === "captions"} onClick={() => setEditorMode("captions")}>字幕</button>
  <button aria-pressed={editorMode === "ai"} onClick={() => setEditorMode("ai")}>AI 工作台</button>
  <button aria-pressed={editorMode === "export"} onClick={() => setEditorMode("export")}>导出</button>
</nav>
```

主区域使用 `<section aria-label="媒体库">`、`<section aria-label="项目预览">`、`<section aria-label="时间线">` 和 `<aside aria-label="上下文属性">`。已有按钮行为通过回调保留，不把业务逻辑复制到新按钮中。

- [ ] **Step 5: 收敛首轮 CSS 结构**

将最终生效的 `.editor-shell`、`.editor-topbar`、`.editor-grid`、`.stage-pane`、`.timeline-pane` 规则集中到 Stage 9B 主题区后，删除仅被后续同名规则完全覆盖的旧布局声明。保留 `--left-width`、`--right-width` 和 `--timeline-height` 的可调尺寸机制。确保 `.editor-grid` 仍为 `var(--left-width) minmax(470px, 1fr) var(--right-width)`，并保留最小窗口媒体查询。

- [ ] **Step 6: 运行单测和类型检查**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop typecheck`
Expected: PASS，无新增 TypeScript 错误。

## Task 2: 统一预览、保存和任务反馈

**Files:**
- Modify: `apps/desktop/src/app/App.tsx`，现有 `previewMode`、`saveState`、`jobs`、`exports` 和顶部/预览/状态栏渲染处。
- Modify: `apps/desktop/src/styles.css`，状态标签、预览标签、任务摘要和过期提示样式。
- Modify: `apps/desktop/src/app/safeErrors.ts`，仅在新状态展示需要已有错误类型映射时调整。
- Test: `apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: 现有 `previewMode: "interactive" | "authoritative"`、`previews`、`saveState`、`jobs`、`exports` 和 `notice`。
- Produces: 三类彼此独立的状态显示：保存状态、预览状态、任务状态；不改变渲染、导出或保存 API。

- [ ] **Step 1: 写状态显示测试**

覆盖已保存、保存中、预览过期、任务运行中和任务失败：

```tsx
it("keeps save, preview, and job status separate", async () => {
  render(<App />);
  expect(await screen.findByText("已保存")).toBeInTheDocument();
  expect(screen.getByText(/交互预览|权威预览/)).toBeInTheDocument();
  const status = screen.getByRole("status", { name: "任务状态" });
  expect(status).toBeInTheDocument();
});
```

测试中使用现有 mock 返回任务和预览数据，禁止把任务成功直接当作保存成功断言。

- [ ] **Step 2: 添加明确的预览上下文标签**

把当前 `previewMode` 渲染为可见标签：

```tsx
<span className={`preview-context ${previewMode === "authoritative" ? "authoritative" : "interactive"}`}>
  {previewMode === "authoritative" ? "权威预览" : "交互预览"}
</span>
```

素材级预览入口使用 `素材预览` 标签；项目播放入口使用 `项目预览` 标签。没有有效权威预览时，不能显示“权威预览”作为最新状态；使用 `权威预览已过期` 或 `尚未生成权威预览`。

- [ ] **Step 3: 分离顶部状态与局部状态**

顶部只保留短摘要：保存状态、运行任务数量、权威预览是否过期。详细失败原因和任务操作放在任务区/导出模式/相关工作台。调用 `safeErrorMessage` 或 `safeTaskErrorMessage` 后再展示错误文本，不显示异常对象本身。

- [ ] **Step 4: 完成样式和可访问状态**

状态不能只依赖颜色：每个状态同时提供文字；按钮使用 `aria-label`，状态容器使用 `role="status"` 或 `role="alert"`。为 `.save-state`、`.preview-context`、`.job-state`、`.stale` 和失败状态定义统一颜色语义，并确保窄宽度下文本可换行或省略而不覆盖控件。

- [ ] **Step 5: 运行验证**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop lint`
Expected: PASS。

## Task 3: 收敛媒体库和上下文属性面板

**Files:**
- Modify: `apps/desktop/src/app/App.tsx`，媒体区、素材/转录选择处理和属性区 JSX。
- Modify: `apps/desktop/src/styles.css`，媒体过滤工具栏、素材状态、属性空态和对象态样式。
- Test: `apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: 现有 `assets`、`transcripts`、`transcriptSummaries`、`tab`、`selection`、`project` 和已有预览/转录 handlers。
- Produces: 搜索/类型过滤入口、素材状态信息、对象上下文属性；不改变素材列表 IPC 或转录数据模型。

- [ ] **Step 1: 写媒体筛选和属性空态测试**

```tsx
it("filters visible assets without changing project data", async () => {
  render(<App />);
  const search = await screen.findByRole("searchbox", { name: "搜索素材" });
  await userEvent.type(search, "口播");
  expect(screen.getByText("口播-01.mp4")).toBeInTheDocument();
  expect(screen.queryByText("商品图.png")).not.toBeInTheDocument();
});

it("shows contextual properties for the selected timeline object", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /Clip 1/ }));
  expect(screen.getByRole("heading", { name: "片段属性" })).toBeInTheDocument();
});
```

使用实际测试 fixture 的素材名称和按钮可访问名；如果现有 fixture 没有两个素材，先在测试 mock 中补充最小数据，不修改 Core。

- [ ] **Step 2: 添加 Renderer 局部筛选状态**

增加：

```ts
type AssetFilter = "all" | AssetKind;
const [assetQuery, setAssetQuery] = useState("");
const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
const visibleAssets = useMemo(() => assets.filter(item => {
  const matchesQuery = item.asset.display_name.toLocaleLowerCase().includes(assetQuery.trim().toLocaleLowerCase());
  const matchesKind = assetFilter === "all" || item.asset.kind === assetFilter;
  return matchesQuery && matchesKind;
}), [assetQuery, assetFilter, assets]);
```

筛选只影响显示，不重新请求、不改变 `assets`，缺失/已变更/不支持状态继续沿用 `availabilityLabels`。

- [ ] **Step 3: 实现媒体库上下文工具栏**

在资产列表前添加 `role="searchbox"`、类型选择和结果计数。保留现有导入按钮、拖放和素材预览按钮。每个素材项显示名称、类型/时长、可用性、转录状态和已生成/已使用状态中已有的数据；不猜测不存在的数据字段。

- [ ] **Step 4: 实现上下文属性分支**

按 `selection` 分支渲染：

```tsx
if (!selection) return <ProjectProperties />;
if (selection.kind === "clip") return <ClipProperties clipId={selection.id} />;
return <CaptionProperties captionId={selection.id} />;
```

在当前大文件中可先使用局部 JSX 分支或小型纯组件，不为了首轮 UI 重构拆分整个 `App.tsx`。空态显示项目概览、保存/预览检查和下一步动作；对象态只显示对应已有字段。

- [ ] **Step 5: 运行测试和构建**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop typecheck`
Expected: PASS。

## Task 4: 强化时间线焦点、播放头和拖放反馈

**Files:**
- Modify: `apps/desktop/src/app/App.tsx`，时间线渲染、选中处理、播放头和拖放 handlers。
- Modify: `apps/desktop/src/styles.css`，轨道、播放头、选中/锁定/缺失/拖放目标状态。
- Test: `apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: 现有 `working`、`timeline`、`selection`、`playhead`、`playing`、拖放实现和 `beginResize`。
- Produces: 可见且可访问的时间线对象焦点、播放头和拖放目标；不实现 M2 A1/A3 的新编辑语义。

- [ ] **Step 1: 写时间线交互测试**

```tsx
it("marks the selected clip and exposes the playhead", async () => {
  render(<App />);
  const clip = await screen.findByRole("button", { name: /Clip 1/ });
  await userEvent.click(clip);
  expect(clip).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("slider", { name: "时间线播放头" })).toBeInTheDocument();
});
```

拖放测试使用 HTML5 `dataTransfer` fixture，断言目标轨道出现 `drop-active` 对应的可访问状态，不断言未冻结的时间线几何细节。

- [ ] **Step 2: 暴露播放头语义**

将现有播放头/播放进度输入绑定到：

```tsx
<input
  type="range"
  aria-label="时间线播放头"
  min={0}
  max={duration(working)}
  value={playhead}
  onChange={event => setPlayhead(Number(event.currentTarget.value))}
/>
```

保留现有 `videoRef` 同步逻辑；仅补充 aria 和可见时间码，不改变播放精度协议。

- [ ] **Step 3: 统一对象状态类和属性**

时间线对象必须能通过 `selected`、`locked`、`missing` 或 `pending` 状态表达；如果当前数据没有对应状态，只有已有状态才渲染，不创建虚假状态。选中对象增加 `aria-pressed="true"` 或 `aria-current="true"`。

- [ ] **Step 4: 收敛拖放视觉反馈**

保留现有 `.timeline-drop-zone`、`.drop-active` 和空轨道投放区，增加可见文本/aria 状态，例如“释放后插入视频轨道”。拖放结束、取消和失败后都清除高亮，不能残留整条轨道的 active 样式。

- [ ] **Step 5: 运行测试**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop build`
Expected: main、preload 和 renderer 构建成功。

## Task 5: 完成四种工作模式的渐进式视图

**Files:**
- Modify: `apps/desktop/src/app/App.tsx`，模式切换后的局部工具栏、媒体标签、AI/导出入口。
- Modify: `apps/desktop/src/styles.css`，模式导航、模式标题、焦点工具区样式。
- Test: `apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: Task 1 的 `EditorMode`、Task 2 的状态摘要、现有 `openAi`、`openPatch`、`setRenderPanelOpen`、`setGenerationOpen`、`setShotRequirementsOpen` 和导出 handlers。
- Produces: 四种模式的稳定入口和上下文，不复制业务工作台。

- [ ] **Step 1: 写模式切换保留状态测试**

```tsx
it("switches modes without clearing the selected object", async () => {
  render(<App />);
  const clip = await screen.findByRole("button", { name: /Clip 1/ });
  await userEvent.click(clip);
  await userEvent.click(screen.getByRole("button", { name: "字幕" }));
  expect(screen.getByRole("button", { name: "字幕" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("heading", { name: "片段属性" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 为模式提供可见任务目标**

在不改变数据区域的情况下，按 `editorMode` 显示短标题和主要动作：剪辑显示导入/加入时间线；字幕显示转录/字幕校对；AI 工作台显示 AI 粗剪/修改提案/生成素材；导出显示权威预览/导出任务。所有动作调用当前既有 handler。

- [ ] **Step 3: 将现有工作台入口归类**

把 `openAi`、`openPatch`、图片生成、镜头需求和渲染/批量导出入口放到对应模式的工具区。不得复制 Modal 内容；保持 `Dialog`、`MediaGenerationWorkbench`、`ProviderImageGenerationWorkbench` 和镜头需求工作台为现有内容容器。

- [ ] **Step 4: 运行验证**

Run: `pnpm --dir apps/desktop test -- editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop lint && pnpm --dir apps/desktop typecheck`
Expected: both PASS。

## Task 6: 建立统一命令注册表和焦点作用域

**Files:**
- Create: `apps/desktop/src/app/editorCommands.ts`。
- Modify: `apps/desktop/src/app/App.tsx`，菜单、快捷键和命令搜索入口。
- Modify: `apps/desktop/src/styles.css`，命令搜索浮层和快捷键标签。
- Test: `apps/desktop/tests/editor-commands.test.tsx`、`apps/desktop/tests/editor-shell.test.tsx`。

**Interfaces:**
- Consumes: Task 1 的 `EditorMode` 和现有 handlers。
- Produces: 纯数据命令注册表：

```ts
export type EditorCommandScope = "global" | "timeline" | "asset" | "caption" | "ai" | "export";
export type EditorCommand = {
  id: string;
  label: string;
  shortcut?: string;
  scopes: EditorCommandScope[];
};
export const editorCommands: readonly EditorCommand[];
```

- [ ] **Step 1: 写命令注册表测试**

```tsx
it("keeps command identifiers unique and exposes required core commands", () => {
  const ids = editorCommands.map(command => command.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining(["timeline.undo", "timeline.redo", "timeline.split", "timeline.delete", "preview.generate", "export.open"]));
});
```

- [ ] **Step 2: 添加最小命令数据**

`editorCommands.ts` 只定义当前已有或明确计划的入口：播放/暂停、撤销、重做、拆分、删除、预览、导出、AI 工作台和命令搜索。每个命令包含稳定 ID、中文标签、快捷键和作用域；不在此文件执行 IPC。

- [ ] **Step 3: 添加命令搜索 UI**

命令搜索只过滤 `editorCommands` 并显示标签、快捷键和当前作用域是否可用。执行后调用现有 handler；不可用命令显示禁用原因或不显示，不伪造业务能力。输入框获得焦点时阻止时间线快捷键。

- [ ] **Step 4: 添加作用域快捷键守卫**

在全局键盘监听中先判断 `event.target` 是否为 `input`、`textarea`、`select` 或 `contenteditable`，是则直接返回；再依据 `editorMode`、`selection` 和当前焦点决定是否执行命令。删除/空格等高风险快捷键必须有明确时间线焦点。

- [ ] **Step 5: 运行测试**

Run: `pnpm --dir apps/desktop test -- editor-commands.test.tsx editor-shell.test.tsx`
Expected: PASS。

Run: `pnpm --dir apps/desktop typecheck`
Expected: PASS。

## Task 7: Electron 真实窗口验收和回归收口

**Files:**
- Modify only if required by evidence: `apps/desktop/electron/main/index.ts`、`apps/desktop/electron/preload/index.ts`。
- Modify only if required by evidence: `apps/desktop/tests/*.test.tsx` or existing E2E test files。
- Do not modify: Core, Contracts, migration files, provider protocols, or unrelated recovery artifacts.

**Interfaces:**
- Consumes: Tasks 1-6 的 UI、状态和命令行为，以及现有 Electron window controls/preload API。
- Produces: 可复现的桌面端验收记录和无回归构建结果；不新增业务合同。

- [ ] **Step 1: 执行静态检查**

Run from repository root:

```bash
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: 全部成功；记录实际测试数量，不在文档中预填未执行的数字。

- [ ] **Step 2: 启动 Electron 开发环境**

Run: `pnpm dev`
Expected: Electron 窗口打开，Renderer 加载成功，无 preload 白名单错误、未捕获异常或空白主视图。

- [ ] **Step 3: 验证窗口尺寸和布局**

依次检查默认窗口、最小允许窗口、左右面板拖动、时间线高度拖动和最大化/还原。确认媒体区、预览区、时间线、属性区不重叠；长项目名、长素材名和长错误文本不遮挡邻近控件。

- [ ] **Step 4: 验证典型主路径**

执行并记录：创建/打开项目 -> 导入或选择素材 -> 素材预览 -> 加入时间线 -> 选择时间线片段 -> 项目预览 -> 保存状态确认 -> 权威预览 -> 导出任务。每一步确认焦点和状态文字可见。

- [ ] **Step 5: 验证中国用户重点路径**

使用已有能力检查中文口播转录/字幕、竖屏预览、电商素材筛选、AI 候选确认/采用和导出任务；AI 外传预览、确认、候选、采用和 Revision 必须保持顺序，Provider 未配置时显示安全可行动错误。

- [ ] **Step 6: 验证异常状态**

检查缺失素材、权威预览过期、保存失败/草稿冲突、任务取消/失败、Provider 未配置和窗口恢复。错误文本应来自 `safeErrors.ts` 处理结果，不显示堆栈或凭据。

- [ ] **Step 7: 记录验收结论**

将实际命令、结果、已知未覆盖项记录在本次变更说明或验收记录中；不修改 `README.md`，不把尚未实施的 M2 高级能力写成完成状态，不创建 Git 提交。

## 完成判定

- [ ] 四区主编辑骨架和四种模式可理解、可切换。
- [ ] 素材预览、项目预览、权威预览具有明确标签和状态。
- [ ] 保存、预览、任务三类状态独立可见。
- [ ] 媒体搜索/筛选和上下文属性不改变现有业务数据语义。
- [ ] 时间线选中、播放头、拖放反馈清晰，未提前引入 M2 新编辑能力。
- [ ] AI 入口和结果保持确认、提案/候选、显式采用、Revision 约束。
- [ ] 命令搜索和快捷键具有稳定 ID、作用域和输入框守卫。
- [ ] Electron 真实窗口无重叠、溢出、空白或失焦误操作。
- [ ] `pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check` 全部通过。
- [ ] 未创建提交，工作区中的既有无关变更未被回滚或覆盖。

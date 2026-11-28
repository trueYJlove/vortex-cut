import type { CommandDefinition } from "./types.js";

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const uiCommands: readonly CommandDefinition<Record<string, never>, { triggered: true }>[] = [
  {
    id: "export.open",
    label: "导出",
    description: "打开渲染与导出面板。",
    scopes: ["export", "global"],
    group: "时间线",
    shortcut: "Ctrl+E",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.openRenderPanel();
      return { ok: true, command: "export.open", data: { triggered: true } };
    },
  },
  {
    id: "ai.open",
    label: "AI 粗剪",
    description: "打开 AI 粗剪工作流弹窗。",
    scopes: ["ai", "global"],
    group: "工具",
    shortcut: "Ctrl+I",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (ctx.project && ctx.timeline ? undefined : "需要项目和时间线"),
    async execute(ctx) {
      await ctx.openAi();
      return { ok: true, command: "ai.open", data: { triggered: true } };
    },
  },
  {
    id: "ai.revise",
    label: "AI 修改",
    description: "打开 AI 时间线自然语言修改弹窗。",
    scopes: ["global"],
    group: "工具",
    shortcut: "Ctrl+Shift+I",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (ctx.timeline ? undefined : "需要时间线"),
    async execute(ctx) {
      await ctx.openPatch();
      return { ok: true, command: "ai.revise", data: { triggered: true } };
    },
  },
  {
    id: "project.manage",
    label: "项目管理",
    description: "打开项目管理库弹窗。",
    scopes: ["global"],
    group: "项目",
    shortcut: "Ctrl+Alt+P",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.openProjectManager();
      return { ok: true, command: "project.manage", data: { triggered: true } };
    },
  },
  {
    id: "project.refresh",
    label: "刷新项目",
    description: "刷新项目列表与当前项目状态。",
    scopes: ["global"],
    group: "项目",
    shortcut: "F5",
    mcpExpose: false,
    inputSchema: emptySchema,
    async execute(ctx) {
      await ctx.refreshProjects();
      return { ok: true, command: "project.refresh", data: { triggered: true } };
    },
  },
  {
    id: "ui.resetLayout",
    label: "恢复默认布局",
    description: "重置左右面板与时间线高度至默认尺寸。",
    scopes: ["global"],
    group: "界面",
    shortcut: "Ctrl+Alt+L",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.resetLayout();
      return { ok: true, command: "ui.resetLayout", data: { triggered: true } };
    },
  },
  {
    id: "ui.shortcuts",
    label: "快捷键设置",
    description: "打开快捷键自定义设置弹窗。",
    scopes: ["global"],
    group: "界面",
    shortcut: "Ctrl+Alt+K",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.openShortcuts();
      return { ok: true, command: "ui.shortcuts", data: { triggered: true } };
    },
  },
  {
    id: "tools.compare",
    label: "版本比较",
    description: "打开 Timeline Revision 版本差异比较弹窗。",
    scopes: ["global"],
    group: "工具",
    shortcut: "Ctrl+Alt+V",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (ctx.project ? undefined : "需要项目"),
    async execute(ctx) {
      await ctx.openRevisionCompare();
      return { ok: true, command: "tools.compare", data: { triggered: true } };
    },
  },
  {
    id: "tools.shots",
    label: "镜头需求",
    description: "打开镜头需求工作台。",
    scopes: ["global"],
    group: "工具",
    shortcut: "Ctrl+Alt+S",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (!ctx.project ? "需要项目" : ctx.project.status !== "active" ? "项目已归档" : undefined),
    execute(ctx) {
      ctx.openShotRequirements();
      return { ok: true, command: "tools.shots", data: { triggered: true } };
    },
  },
  {
    id: "tools.verify",
    label: "生成验证（模拟）",
    description: "打开模拟媒体生成验证工作台。",
    scopes: ["global"],
    group: "工具",
    shortcut: "Ctrl+Alt+G",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (!ctx.project ? "需要项目" : ctx.project.status !== "active" ? "项目已归档" : undefined),
    execute(ctx) {
      ctx.openGeneration();
      return { ok: true, command: "tools.verify", data: { triggered: true } };
    },
  },
  {
    id: "tools.imageGen",
    label: "真实图片生成",
    description: "打开 Provider 真实图片生成工作台。",
    scopes: ["global"],
    group: "工具",
    shortcut: "Ctrl+Alt+I",
    mcpExpose: false,
    inputSchema: emptySchema,
    disabledReason: ctx => (!ctx.project ? "需要项目" : ctx.project.status !== "active" ? "项目已归档" : undefined),
    execute(ctx) {
      ctx.openImageGeneration();
      return { ok: true, command: "tools.imageGen", data: { triggered: true } };
    },
  },
  {
    id: "help.manual",
    label: "用户使用手册",
    description: "提示用户使用手册文档路径。",
    scopes: ["global"],
    group: "帮助",
    shortcut: "F1",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.showNotice("请查看 docs/guides/user-manual.md", "info");
      return { ok: true, command: "help.manual", data: { triggered: true } };
    },
  },
  {
    id: "command.search",
    label: "命令搜索",
    description: "打开命令搜索面板。",
    scopes: ["global"],
    group: "帮助",
    shortcut: "Ctrl+K",
    mcpExpose: false,
    inputSchema: emptySchema,
    execute(ctx) {
      ctx.openCommandSearch();
      return { ok: true, command: "command.search", data: { triggered: true } };
    },
  },
];

type EditorCommandScope = "global" | "timeline" | "asset" | "caption" | "ai" | "export";

/** 命令面板分组：原型按主菜单语义分组展示，而不是一条平铺长列表。 */
export type EditorCommandGroup = "项目" | "编辑" | "时间线" | "界面" | "工具" | "帮助";

export type EditorCommand = {
  id: string;
  label: string;
  shortcut?: string;
  scopes: EditorCommandScope[];
  group: EditorCommandGroup;
};

/** 命令标签与主菜单条目一一对应（menuShortcut 按 label 匹配展示快捷键）。 */
export const editorCommands: readonly EditorCommand[] = [
  { id: "play.pause", label: "播放/暂停", shortcut: "空格", scopes: ["timeline"], group: "时间线" },
  { id: "timeline.undo", label: "撤销", shortcut: "Ctrl+Z", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.redo", label: "重做", shortcut: "Ctrl+Shift+Z / Ctrl+Y", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.split", label: "拆分所选片段", shortcut: "Ctrl+B", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.copy", label: "复制所选片段", shortcut: "Ctrl+C", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.cut", label: "剪切所选片段", shortcut: "Ctrl+X", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.paste", label: "粘贴片段", shortcut: "Ctrl+V", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.delete", label: "删除所选对象", shortcut: "Delete / Backspace", scopes: ["timeline"], group: "编辑" },
  { id: "timeline.create", label: "创建空时间线", shortcut: "Ctrl+N", scopes: ["global"], group: "时间线" },
  { id: "preview.generate", label: "生成预览", shortcut: "Ctrl+Enter", scopes: ["export", "global"], group: "时间线" },
  { id: "export.open", label: "导出", shortcut: "Ctrl+E", scopes: ["export", "global"], group: "时间线" },
  { id: "ai.open", label: "AI 粗剪", shortcut: "Ctrl+I", scopes: ["ai", "global"], group: "工具" },
  { id: "ai.revise", label: "AI 修改", shortcut: "Ctrl+Shift+I", scopes: ["global"], group: "工具" },
  { id: "project.manage", label: "项目管理", shortcut: "Ctrl+Alt+P", scopes: ["global"], group: "项目" },
  { id: "project.refresh", label: "刷新项目", shortcut: "F5", scopes: ["global"], group: "项目" },
  { id: "ui.resetLayout", label: "恢复默认布局", shortcut: "Ctrl+Alt+L", scopes: ["global"], group: "界面" },
  { id: "ui.shortcuts", label: "快捷键设置", shortcut: "Ctrl+Alt+K", scopes: ["global"], group: "界面" },
  { id: "tools.compare", label: "版本比较", shortcut: "Ctrl+Alt+V", scopes: ["global"], group: "工具" },
  { id: "tools.shots", label: "镜头需求", shortcut: "Ctrl+Alt+S", scopes: ["global"], group: "工具" },
  { id: "tools.verify", label: "生成验证（模拟）", shortcut: "Ctrl+Alt+G", scopes: ["global"], group: "工具" },
  { id: "tools.imageGen", label: "真实图片生成", shortcut: "Ctrl+Alt+I", scopes: ["global"], group: "工具" },
  { id: "help.manual", label: "用户使用手册", shortcut: "F1", scopes: ["global"], group: "帮助" },
  { id: "command.search", label: "命令搜索", shortcut: "Ctrl+K", scopes: ["global"], group: "帮助" },
];

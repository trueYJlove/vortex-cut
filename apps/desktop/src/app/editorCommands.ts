type EditorCommandScope = "global" | "timeline" | "asset" | "caption" | "ai" | "export";

export type EditorCommand = {
  id: string;
  label: string;
  shortcut?: string;
  scopes: EditorCommandScope[];
};

/** 命令标签与主菜单条目一一对应（menuShortcut 按 label 匹配展示快捷键）。 */
export const editorCommands: readonly EditorCommand[] = [
  { id: "play.pause", label: "播放/暂停", shortcut: "空格", scopes: ["timeline"] },
  { id: "timeline.undo", label: "撤销", shortcut: "Ctrl+Z", scopes: ["timeline"] },
  { id: "timeline.redo", label: "重做", shortcut: "Ctrl+Shift+Z / Ctrl+Y", scopes: ["timeline"] },
  { id: "timeline.split", label: "拆分所选片段", shortcut: "Ctrl+B", scopes: ["timeline"] },
  { id: "timeline.copy", label: "复制所选片段", shortcut: "Ctrl+C", scopes: ["timeline"] },
  { id: "timeline.cut", label: "剪切所选片段", shortcut: "Ctrl+X", scopes: ["timeline"] },
  { id: "timeline.paste", label: "粘贴片段", shortcut: "Ctrl+V", scopes: ["timeline"] },
  { id: "timeline.delete", label: "删除所选对象", shortcut: "Delete / Backspace", scopes: ["timeline"] },
  { id: "timeline.create", label: "创建空时间线", shortcut: "Ctrl+N", scopes: ["global"] },
  { id: "preview.generate", label: "生成预览", shortcut: "Ctrl+Enter", scopes: ["export", "global"] },
  { id: "export.open", label: "导出", shortcut: "Ctrl+E", scopes: ["export", "global"] },
  { id: "ai.open", label: "AI 粗剪", shortcut: "Ctrl+I", scopes: ["ai", "global"] },
  { id: "ai.revise", label: "AI 修改", shortcut: "Ctrl+Shift+I", scopes: ["global"] },
  { id: "project.manage", label: "项目管理", shortcut: "Ctrl+Alt+P", scopes: ["global"] },
  { id: "project.refresh", label: "刷新项目", shortcut: "F5", scopes: ["global"] },
  { id: "ui.resetLayout", label: "恢复默认布局", shortcut: "Ctrl+Alt+L", scopes: ["global"] },
  { id: "ui.shortcuts", label: "快捷键设置", shortcut: "Ctrl+Alt+K", scopes: ["global"] },
  { id: "tools.compare", label: "版本比较", shortcut: "Ctrl+Alt+V", scopes: ["global"] },
  { id: "tools.shots", label: "镜头需求", shortcut: "Ctrl+Alt+S", scopes: ["global"] },
  { id: "tools.verify", label: "生成验证（模拟）", shortcut: "Ctrl+Alt+G", scopes: ["global"] },
  { id: "tools.imageGen", label: "真实图片生成", shortcut: "Ctrl+Alt+I", scopes: ["global"] },
  { id: "help.manual", label: "用户使用手册", shortcut: "F1", scopes: ["global"] },
  { id: "command.search", label: "命令搜索", shortcut: "Ctrl+K", scopes: ["global"] },
];

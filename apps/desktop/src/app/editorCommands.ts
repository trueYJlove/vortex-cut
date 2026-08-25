type EditorCommandScope = "global" | "timeline" | "asset" | "caption" | "ai" | "export";

export type EditorCommand = {
  id: string;
  label: string;
  shortcut?: string;
  scopes: EditorCommandScope[];
};

export const editorCommands: readonly EditorCommand[] = [
  { id: "play.pause", label: "播放/暂停", shortcut: "空格", scopes: ["timeline"] },
  { id: "timeline.undo", label: "撤销", shortcut: "Ctrl+Z", scopes: ["timeline"] },
  { id: "timeline.redo", label: "重做", shortcut: "Ctrl+Shift+Z / Ctrl+Y", scopes: ["timeline"] },
  { id: "timeline.split", label: "拆分所选片段", shortcut: "Ctrl+B", scopes: ["timeline"] },
  { id: "timeline.delete", label: "删除所选对象", shortcut: "Delete", scopes: ["timeline"] },
  { id: "preview.generate", label: "生成权威预览", shortcut: "Ctrl+Enter", scopes: ["export", "global"] },
  { id: "export.open", label: "打开渲染与导出", shortcut: "Ctrl+E", scopes: ["export", "global"] },
  { id: "ai.open", label: "打开 AI 粗剪", shortcut: "Ctrl+I", scopes: ["ai", "global"] },
  { id: "command.search", label: "命令搜索", shortcut: "Ctrl+K", scopes: ["global"] },
];

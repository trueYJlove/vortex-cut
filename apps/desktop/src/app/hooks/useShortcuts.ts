import { useEffect, useRef, useState } from "react";
import { editorCommands } from "../editorCommands.js";
import {
  DEFAULT_SHORTCUTS,
  bindingLabel,
  findConflict,
  loadShortcuts,
  matchesBinding,
  normalizeRecordedBinding,
  saveShortcuts,
  type ShortcutCommandId,
  type ShortcutEntry,
} from "../shortcuts.js";
import type { NoticeTone } from "../appHelpers.js";

export interface UseShortcutsParams {
  commandSearchOpen: boolean;
  dispatchCommand: (id: string, payload?: Record<string, unknown>) => Promise<unknown> | void;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

export function useShortcuts({
  commandSearchOpen,
  dispatchCommand,
  showNotice,
}: UseShortcutsParams) {
  // C3：快捷键自定义（注册表 + localStorage 持久化 + 面板录制状态）。
  const [shortcuts, setShortcuts] = useState<Record<ShortcutCommandId, ShortcutEntry>>(() => loadShortcuts());
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(null);

  const applyShortcuts = (next: Record<ShortcutCommandId, ShortcutEntry>) => {
    setShortcuts(next);
    saveShortcuts(next);
  };

  const resetShortcutsToDefault = () => {
    applyShortcuts(structuredClone(DEFAULT_SHORTCUTS));
    setRecordingId(null);
    showNotice("已恢复默认快捷键。");
  };

  const handleRecordKey = (event: React.KeyboardEvent, id: ShortcutCommandId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { setRecordingId(null); return; }
    const binding = normalizeRecordedBinding(event.nativeEvent);
    if (!binding) { showNotice("该按键不可用：单字符键需配合 Ctrl 使用；可用的还有空格与 Delete。", "warning"); return; }
    const conflict = findConflict(shortcuts, id, binding);
    if (conflict) { showNotice(`按键与「${shortcuts[conflict].label}」冲突，请先改绑后者。`, "warning"); return; }
    applyShortcuts({ ...shortcuts, [id]: { ...shortcuts[id], binding } });
    setRecordingId(null);
  };

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
    if (commandSearchOpen) return;
    // 按钮聚焦时保留原生激活语义：Space/Enter 触发按钮而非播放头。
    if (tag === "BUTTON" && (event.key === " " || event.key === "Enter")) return;
    const key = (event.key ?? "").toLowerCase();
    const inTimeline = Boolean(target?.closest?.(".timeline-pane"));
    // C3：固定别名（不进自定义表）——Ctrl+Shift+Z 重做、Backspace/Delete 删除。
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") {
      event.preventDefault();
      void dispatchCommand("timeline.redo");
      return;
    }
    if (!(event.ctrlKey || event.metaKey) && (key === "backspace" || key === "delete") && inTimeline) {
      event.preventDefault();
      void dispatchCommand("timeline.delete", event.shiftKey ? { mode: "ripple" } : {});
      return;
    }
    // 方向键逐帧步进（C1）：1 帧，Shift 加速 5 帧。
    if (!(event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (inTimeline) {
        event.preventDefault();
        const frames = (event.shiftKey ? 5 : 1) * (event.key === "ArrowRight" ? 1 : -1);
        void dispatchCommand("playback.stepFrames", { frames });
      }
      return;
    }
    // C3：自定义快捷键注册表命中检测（顺序即注册表定义顺序）。
    for (const [commandId, entry] of Object.entries(shortcutsRef.current) as Array<[ShortcutCommandId, ShortcutEntry]>) {
      if (matchesBinding(event, entry.binding)) {
        // Delete/播放暂停仅在时间线聚焦时生效（防全局误触）。
        if ((commandId === "timeline.delete" || commandId === "play.pause") && !inTimeline) continue;
        event.preventDefault();
        void dispatchCommand(commandId);
        return;
      }
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current?.(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const menuShortcut = (label: string): string | undefined => {
    const command = editorCommands.find(item => item.label === label);
    if (!command) return undefined;
    const entry = (shortcutsRef.current as Record<string, ShortcutEntry>)[command.id as ShortcutCommandId];
    return entry ? bindingLabel(entry.binding) : undefined;
  };

  return {
    shortcuts,
    shortcutsRef,
    shortcutsOpen,
    setShortcutsOpen,
    recordingId,
    setRecordingId,
    applyShortcuts,
    resetShortcutsToDefault,
    handleRecordKey,
    menuShortcut,
  };
}

/** M2 C3：可自定义快捷键注册表（localStorage 持久化）。 */

export type ShortcutCommandId =
  | "play.pause"
  | "timeline.undo"
  | "timeline.redo"
  | "timeline.split"
  | "timeline.copy"
  | "timeline.cut"
  | "timeline.paste"
  | "timeline.delete"
  | "preview.generate"
  | "export.open"
  | "ai.open"
  | "command.search";

/** 单个键位的规范化表示：主键 + 修饰符集合。 */
export interface ShortcutBinding {
  key: string;
  ctrl: boolean;
  shift: boolean;
}

export interface ShortcutEntry {
  label: string;
  binding: ShortcutBinding;
}

const STORAGE_KEY = "vortex-cut.shortcuts.v1";

/** 路线图 §C3 默认键位。 */
export const DEFAULT_SHORTCUTS: Record<ShortcutCommandId, ShortcutEntry> = {
  "timeline.split": { label: "拆分所选片段", binding: { key: "b", ctrl: true, shift: false } },
  "timeline.delete": { label: "删除所选对象", binding: { key: "delete", ctrl: false, shift: false } },
  "timeline.copy": { label: "复制所选片段", binding: { key: "c", ctrl: true, shift: false } },
  "timeline.cut": { label: "剪切所选片段", binding: { key: "x", ctrl: true, shift: false } },
  "timeline.paste": { label: "粘贴片段", binding: { key: "v", ctrl: true, shift: false } },
  "timeline.undo": { label: "撤销", binding: { key: "z", ctrl: true, shift: false } },
  "timeline.redo": { label: "重做", binding: { key: "y", ctrl: true, shift: false } },
  "play.pause": { label: "播放/暂停", binding: { key: " ", ctrl: false, shift: false } },
  "preview.generate": { label: "生成权威预览", binding: { key: "enter", ctrl: true, shift: false } },
  "export.open": { label: "打开渲染与导出", binding: { key: "e", ctrl: true, shift: false } },
  "ai.open": { label: "打开 AI 粗剪", binding: { key: "i", ctrl: true, shift: false } },
  "command.search": { label: "命令搜索", binding: { key: "k", ctrl: true, shift: false } },
};

const MUTABLE_IDS: ShortcutCommandId[] = Object.keys(DEFAULT_SHORTCUTS) as ShortcutCommandId[];

/** 路线图同时要求 Ctrl+Shift+Z 重做与 Backspace 删除别名；它们不进入自定义表。 */
export function loadShortcuts(): Record<ShortcutCommandId, ShortcutEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SHORTCUTS);
    const saved = JSON.parse(raw) as Partial<Record<ShortcutCommandId, ShortcutBinding>>;
    const merged = structuredClone(DEFAULT_SHORTCUTS);
    for (const id of MUTABLE_IDS) {
      const binding = saved[id];
      if (binding && typeof binding.key === "string" && binding.key.length > 0) {
        merged[id].binding = { key: binding.key.toLowerCase(), ctrl: Boolean(binding.ctrl), shift: Boolean(binding.shift) };
      }
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_SHORTCUTS);
  }
}

export function saveShortcuts(shortcuts: Record<ShortcutCommandId, ShortcutEntry>): void {
  try {
    const payload: Partial<Record<ShortcutCommandId, ShortcutBinding>> = {};
    for (const id of MUTABLE_IDS) payload[id] = shortcuts[id].binding;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 持久化失败时静默使用内存值 */
  }
}

/** KeyboardEvent → 规范化主键名（与绑定表键空间一致）。 */
export function eventKey(event: KeyboardEvent): string {
  const key = (event.key ?? "").toLowerCase();
  if (key === " ") return " ";
  if (key === "delete") return "delete";
  return key;
}

/** 判断事件是否命中绑定。 */
export function matchesBinding(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  if (binding.ctrl && !ctrl) return false;
  if (!binding.ctrl && ctrl) return false;
  if (binding.shift !== event.shiftKey) return false;
  return eventKey(event) === binding.key;
}

/** 绑定的人类可读表示（面板/菜单展示）。 */
export function bindingLabel(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  const key = binding.key;
  parts.push(key === " " ? "空格" : key === "delete" ? "Delete" : key.toUpperCase());
  return parts.join("+");
}

/** 校验用户录入的键位：主键必须为单字符/空格/Delete，Ctrl 需修饰符或单功能键。 */
export function normalizeRecordedBinding(event: KeyboardEvent): ShortcutBinding | null {
  const key = eventKey(event);
  if (!key) return null;
  if (key.length !== 1 && key !== "delete") return null;
  const ctrl = event.ctrlKey || event.metaKey;
  // 无修饰符的单字符键保留给文本输入；仅允许空格/Delete/功能键裸按。
  if (!ctrl && key !== " " && key !== "delete") return null;
  return { key, ctrl, shift: event.shiftKey };
}

/** 检查新绑定是否与其他命令冲突，返回被占用的命令 id。 */
export function findConflict(shortcuts: Record<ShortcutCommandId, ShortcutEntry>, id: ShortcutCommandId, binding: ShortcutBinding): ShortcutCommandId | null {
  for (const other of MUTABLE_IDS) {
    if (other === id) continue;
    const otherBinding = shortcuts[other].binding;
    if (otherBinding.key === binding.key && otherBinding.ctrl === binding.ctrl && otherBinding.shift === binding.shift) {
      return other;
    }
  }
  return null;
}

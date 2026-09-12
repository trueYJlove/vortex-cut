import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  bindingLabel,
  eventKey,
  findConflict,
  matchesBinding,
  normalizeRecordedBinding,
} from "../src/app/shortcuts.js";

function key(parts: { key: string; ctrl?: boolean; shift?: boolean }): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: parts.key, ctrlKey: parts.ctrl ?? false, shiftKey: parts.shift ?? false, bubbles: true });
}

describe("C3 快捷键注册表", () => {
  it("默认键位覆盖路线图要求的命令集合", () => {
    const ids = Object.keys(DEFAULT_SHORTCUTS);
    for (const required of ["timeline.split", "timeline.delete", "timeline.copy", "timeline.paste", "timeline.undo", "timeline.redo", "play.pause"]) {
      expect(ids).toContain(required);
    }
    expect(DEFAULT_SHORTCUTS["timeline.split"].binding).toEqual({ key: "b", ctrl: true, shift: false });
    expect(DEFAULT_SHORTCUTS["play.pause"].binding).toEqual({ key: " ", ctrl: false, shift: false });
  });

  it("matchesBinding 区分修饰符与主键", () => {
    const ctrlB = DEFAULT_SHORTCUTS["timeline.split"].binding;
    expect(matchesBinding(key({ key: "b", ctrl: true }), ctrlB)).toBe(true);
    expect(matchesBinding(key({ key: "b" }), ctrlB)).toBe(false);
    expect(matchesBinding(key({ key: "b", ctrl: true, shift: true }), ctrlB)).toBe(false);
  });

  it("eventKey 规范化空格与 Delete", () => {
    expect(eventKey(key({ key: " " }))).toBe(" ");
    expect(eventKey(key({ key: "Delete" }))).toBe("delete");
  });

  it("normalizeRecordedBinding 拒绝无修饰符单字符键、接受空格/Delete/Ctrl 组合", () => {
    expect(normalizeRecordedBinding(key({ key: "s" }))).toBeNull();
    expect(normalizeRecordedBinding(key({ key: " " }))).toEqual({ key: " ", ctrl: false, shift: false, alt: false });
    expect(normalizeRecordedBinding(key({ key: "Delete" }))).toEqual({ key: "delete", ctrl: false, shift: false, alt: false });
    expect(normalizeRecordedBinding(key({ key: "s", ctrl: true }))).toEqual({ key: "s", ctrl: true, shift: false, alt: false });
  });

  it("findConflict 检出新键位与既有命令冲突", () => {
    expect(findConflict(DEFAULT_SHORTCUTS, "timeline.split", { key: "c", ctrl: true, shift: false })).toBe("timeline.copy");
    expect(findConflict(DEFAULT_SHORTCUTS, "timeline.split", { key: "s", ctrl: true, shift: false })).toBeNull();
  });

  it("bindingLabel 生成人类可读键位文本", () => {
    expect(bindingLabel({ key: "b", ctrl: true, shift: false })).toBe("Ctrl+B");
    expect(bindingLabel({ key: " ", ctrl: false, shift: false })).toBe("空格");
    expect(bindingLabel({ key: "delete", ctrl: false, shift: false })).toBe("Delete");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModePicker, timelineModeFromKeyEvent } from "../src/ui/of/ModePicker.js";

describe("timeline edit tools", () => {
  it("exposes all five tools through a keyboard-operable labelled select", () => {
    const onPick = vi.fn();
    render(<ModePicker mode="select" onPick={onPick} />);
    const picker = screen.getByRole("combobox", { name: "时间线工具，当前选择" });
    expect(picker).toBeInTheDocument();
    expect(Array.from((picker as HTMLSelectElement).options).map(option => option.value)).toEqual(["select", "split", "roll", "slip", "slide"]);
    fireEvent.change(picker, { target: { value: "slip" } });
    expect(onPick).toHaveBeenCalledWith("slip");
  });

  it("matches OpenFilm's separate select/split mode button while retaining the edit modes menu", () => {
    const onPick = vi.fn();
    const { container, rerender } = render(<ModePicker mode="select" onPick={onPick} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="分割 (B)"]')!);
    expect(onPick).toHaveBeenCalledWith("split");

    rerender(<ModePicker mode="split" onPick={onPick} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="选择 (A)"]')!);
    expect(onPick).toHaveBeenLastCalledWith("select");
    expect(screen.getByRole("combobox", { name: "时间线工具，当前分割" })).toBeInTheDocument();
  });

  it("maps OpenFilm tool keys and leaves modified or text-entry keys alone", () => {
    const key = (value: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: value, ...init });
    expect(timelineModeFromKeyEvent(key("a"))).toBe("select");
    expect(timelineModeFromKeyEvent(key("v"))).toBe("select");
    expect(timelineModeFromKeyEvent(key("b"))).toBe("split");
    expect(timelineModeFromKeyEvent(key("b", { ctrlKey: true }))).toBeNull();
    expect(timelineModeFromKeyEvent(key("b", { repeat: true }))).toBeNull();

    const input = document.createElement("input");
    const inputKey = key("b");
    input.dispatchEvent(inputKey);
    expect(timelineModeFromKeyEvent(inputKey)).toBeNull();
  });
});

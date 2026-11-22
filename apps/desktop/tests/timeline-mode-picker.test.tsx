import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModePicker } from "../src/ui/of/ModePicker.js";

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
});

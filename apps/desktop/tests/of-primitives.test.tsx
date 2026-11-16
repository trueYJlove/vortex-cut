import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Section, NumField } from "../src/ui/of/inspector-fields.js";

describe("移植后的 OpenFilm 原语可用性（P2 验证）", () => {
  it("Section 渲染标题与折叠按钮", () => {
    const { container } = render(<Section id="t" title="位置大小"><div>child</div></Section>);
    const btn = container.querySelector("button");
    expect(btn?.textContent).toContain("位置大小");
    expect(container.textContent).toContain("child");
  });

  it("NumField 渲染左端标记（而非 ▲▼ 步进器）", () => {
    const { container } = render(<NumField value={100} onChange={() => undefined} label="宽度" prefix="W" />);
    const text = container.textContent ?? "";
    expect(text).toContain("W");
    // 参照没有步进器：不应出现增大/减小的按钮
    expect(container.querySelectorAll('button[aria-label*="增大"]').length).toBe(0);
  });
});

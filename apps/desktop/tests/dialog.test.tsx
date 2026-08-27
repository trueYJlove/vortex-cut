import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { Dialog } from "../src/app/Dialog.js";

afterEach(() => { document.body.innerHTML = ""; });

function DialogHarness({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开</button>
    {open && <Dialog label="测试对话框" onClose={() => setOpen(false)}>
      {empty ? <p>没有可聚焦内容</p> : <><button>第一个</button><button>最后一个</button></>}
    </Dialog>}
  </>;
}

function NestedDialogHarness() {
  const [firstOpen, setFirstOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  return <>
    <button onClick={() => setFirstOpen(true)}>打开</button>
    {firstOpen && <Dialog label="第一层" onClose={() => setFirstOpen(false)}>
      <button>一层按钮</button>
      <button onClick={() => setSecondOpen(true)}>打开第二层</button>
    </Dialog>}
    {secondOpen && <Dialog label="第二层" onClose={() => setSecondOpen(false)}>
      <button>二层按钮</button>
    </Dialog>}
  </>;
}

describe("共享 Dialog", () => {
  it("打开后将焦点移入，并在 Escape 后返回触发按钮", () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "测试对话框" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("在 Tab 和 Shift+Tab 到边界时循环焦点", () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "最后一个" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("没有可聚焦内容时让对话框本身获得焦点", () => {
    render(<DialogHarness empty />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "测试对话框" })).toHaveFocus();
  });

  it("堆叠对话框时聚焦随关闭逐层返回，Escape 只关闭顶层", () => {
    render(<NestedDialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    const firstDialog = screen.getByRole("dialog", { name: "第一层" });
    expect(screen.getByRole("button", { name: "一层按钮" })).toHaveFocus();

    const openSecond = screen.getByRole("button", { name: "打开第二层" });
    openSecond.focus();
    fireEvent.click(openSecond);
    const secondDialog = screen.getByRole("dialog", { name: "第二层" });
    expect(screen.getByRole("button", { name: "二层按钮" })).toHaveFocus();

    fireEvent.keyDown(secondDialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "第二层" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "第一层" })).toBeInTheDocument();
    expect(openSecond).toHaveFocus();

    fireEvent.keyDown(firstDialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "第一层" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
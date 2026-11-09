import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * 真父子嵌套（子 Dialog 渲染在父 Dialog 内部）——2026-11-06 重设计新增。
 * 旧测试用的是兄弟堆叠，从未覆盖「一次 Escape 被两层同时收到」的路径；
 * 共享 Dialog 的 handleKeyDown 已加 stopPropagation，本组用例即为该行为的锁。
 */
function TrueNestedHarness() {
  const [firstOpen, setFirstOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  return <>
    <button onClick={() => setFirstOpen(true)}>打开</button>
    {firstOpen && <Dialog title="父层" label="父层" onClose={() => setFirstOpen(false)}>
      <button>父层按钮</button>
      <button onClick={() => setSecondOpen(true)}>打开子层</button>
      {secondOpen && <Dialog title="子层" label="子层" onClose={() => setSecondOpen(false)}>
        <button>子层按钮</button>
      </Dialog>}
    </Dialog>}
  </>;
}

describe("共享 Dialog · 结构化头/体/底栏", () => {
  it("提供 title 时自动渲染标题区、内容区与底栏，并带上关闭按钮", () => {
    const onClose = vi.fn();
    render(<Dialog title="导出视频" subtitle="当前 Revision" label="导出视频" onClose={onClose} footer={<button>导出</button>}>
      <p>正文</p>
    </Dialog>);
    const dialog = screen.getByRole("dialog", { name: "导出视频" });
    expect(dialog.querySelector(".modal-heading")).not.toBeNull();
    expect(dialog.querySelector(".modal-body")).not.toBeNull();
    expect(dialog.querySelector(":scope > .modal-actions")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭导出视频" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未提供 title 时保持旧结构（children 原样渲染，不注入头尾）", () => {
    render(<Dialog label="旧结构" onClose={() => undefined}><p>只有内容</p></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "旧结构" });
    expect(dialog.querySelector(".modal-heading")).toBeNull();
    expect(dialog.querySelector(".modal-body")).toBeNull();
    expect(screen.getByText("只有内容")).toBeInTheDocument();
  });

  it("closeLabel 覆盖自动生成的关闭名称", () => {
    render(<Dialog title="设置" label="设置" closeLabel="关闭应用设置" onClose={() => undefined}>内容</Dialog>);
    expect(screen.getByRole("button", { name: "关闭应用设置" })).toBeInTheDocument();
  });

  it("真父子嵌套时一次 Escape 只关闭子层，父层保留", () => {
    render(<TrueNestedHarness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("button", { name: "打开子层" }));
    const child = screen.getByRole("dialog", { name: "子层" });
    expect(screen.getByRole("dialog", { name: "父层" })).toBeInTheDocument();
    fireEvent.keyDown(child, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "子层" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "父层" })).toBeInTheDocument();
  });

  it("真父子嵌套时 Tab 圈只在自己这一层循环", () => {
    render(<TrueNestedHarness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("button", { name: "打开子层" }));
    const childButton = screen.getByRole("button", { name: "子层按钮" });
    const childDialog = screen.getByRole("dialog", { name: "子层" });
    const childClose = within(childDialog).getByRole("button", { name: "关闭子层" });
    // DOM 顺序：标题区关闭钮在前，正文按钮在后。
    childButton.focus();
    fireEvent.keyDown(childButton, { key: "Tab" });
    expect(childClose).toHaveFocus();
    fireEvent.keyDown(childClose, { key: "Tab", shiftKey: true });
    expect(childButton).toHaveFocus();
  });
});
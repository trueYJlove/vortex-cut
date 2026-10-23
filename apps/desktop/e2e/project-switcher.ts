import { expect, type Page } from "@playwright/test";

/**
 * Opened via the custom titlebar project switcher. The native 当前项目 <select>
 * was removed from the toolbar, so e2e must drive the top-bar switcher instead.
 *
 * 切换器不渲染 project_id（App.tsx:2588 的 option 只有 role="option"、项目名与状态），
 * 因此这里先用 project_id 取回项目名，再按 role/name 精确定位对应 option。
 * 签名保持不变：27 个调用点仍按 project_id 调用。
 */
export async function selectProject(page: Page, projectId: string): Promise<void> {
  const name = await page.evaluate(
    (id: string) => window.desktop.getProject(id as never).then(project => project.name),
    projectId
  );
  await page.getByRole("button", { name: "切换项目" }).click();
  const listbox = page.getByRole("listbox", { name: "选择项目" });
  try {
    await listbox.getByRole("option").filter({ has: page.getByText(name, { exact: true }) }).click();
  } catch (error) {
    const shown = await listbox.getByRole("option").allInnerTexts().catch(() => []);
    throw new Error(`项目切换器未列出项目「${name}」(${projectId})；当前可见：${shown.join(" / ") || "(无)"}`, { cause: error });
  }
}

/** Opens the project management dialog from the titlebar switcher dropdown. */
export async function openProjectManagement(page: Page): Promise<void> {
  await page.getByRole("button", { name: "切换项目" }).click();
  await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
}

/** Asserts the given project name is shown in the titlebar switcher.
 * The titlebar refreshes via a 1500ms polling refresh, so allow time for
 * e2e-created projects to be picked up.
 */
export async function expectCurrentProject(page: Page, name: string, timeout = 15_000): Promise<void> {
  await expect(page.locator(".titlebar-project-name")).toHaveText(name, { timeout });
}

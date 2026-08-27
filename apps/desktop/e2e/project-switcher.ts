import { expect, type Page } from "@playwright/test";

/**
 * Opened via the custom titlebar project switcher. The native 当前项目 <select>
 * was removed from the toolbar, so e2e must drive the top-bar switcher instead.
 */
export async function selectProject(page: Page, projectId: string): Promise<void> {
  await page.getByRole("button", { name: "切换项目" }).click();
  await page.locator(`[data-project-id="${projectId}"]`).click();
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

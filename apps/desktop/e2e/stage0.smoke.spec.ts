import { test, expect } from "@playwright/test";

test("Stage 0 verification page exposes the core workflow", async ({ page }) => {
  await page.goto(process.env.ELECTRON_RENDERER_URL ?? "http://127.0.0.1:5173");
  await expect(page.getByRole("heading", { name: "验证本地媒体处理链路" })).toBeVisible();
  await expect(page.getByText("生成竖屏样片")).toBeVisible();
  await expect(page.getByText("产物校验")).toBeVisible();
});

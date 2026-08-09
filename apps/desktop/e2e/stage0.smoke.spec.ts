import { test, expect } from "@playwright/test";

test("Stage 0 verification page exposes the core workflow", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { desktop: unknown }).desktop = {
      getRuntime: async () => ({ base_url: "http://127.0.0.1:0", ui_token: "e2e", protocol_version: 1 }),
      chooseMedia: async () => null,
      probeMedia: async () => null,
      createJob: async () => null,
      getJob: async () => null,
      cancelJob: async () => null,
      resolveArtifact: async () => null,
      openArtifact: async () => undefined,
      openArtifactFolder: async () => undefined
    };
  });
  await page.goto(process.env.ELECTRON_RENDERER_URL ?? "http://127.0.0.1:5173");
  await expect(page.getByRole("heading", { name: "Stage 0 verification" })).toBeVisible();
  await expect(page.getByText("Generate portrait sample")).toBeVisible();
  await expect(page.getByText("Artifact validation")).toBeVisible();
});

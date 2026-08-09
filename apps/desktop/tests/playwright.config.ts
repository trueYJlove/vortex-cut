import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const chromeCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((value): value is string => Boolean(value));
const executablePath = chromeCandidates.find(path => existsSync(path));

export default defineConfig({
  testDir: "../e2e",
  timeout: 30_000,
  webServer: {
    command: "node scripts/serve-renderer.mjs",
    cwd: "..",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000
  },
  use: {
    viewport: { width: 1280, height: 900 },
    launchOptions: executablePath ? { executablePath } : undefined
  }
});

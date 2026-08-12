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
  timeout: 120_000,
  // Each Electron test owns a fresh user-data database and spawned sidecar.
  // A single worker makes teardown observable before the next instance starts,
  // preventing process/port/token overlap while preserving every E2E assertion.
  workers: 1,
  fullyParallel: false,
  use: {
    viewport: { width: 1440, height: 960 },
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});

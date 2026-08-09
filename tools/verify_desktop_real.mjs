import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktop = join(root, "apps", "desktop");
const electron = join(desktop, "release", "win-unpacked", "AIVideo Studio.exe");
const playwright = join(root, "node_modules", ".pnpm", "playwright@1.62.1", "node_modules", "playwright", "index.mjs");
const fixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const port = 19333;
// Use an isolated profile per run so Electron's single-instance lock from a
// previous interrupted run cannot redirect this test to a stale process.
const userData = join(root, "test-results", `electron-real-user-data-${process.pid}-${Date.now()}`);

function jsonRequest(path) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolvePromise(JSON.parse(body)));
    });
    request.on("error", reject);
    request.end();
  });
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const env = { ...process.env, AIVS_E2E_MEDIA_PATH: fixture };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const electronProcess = spawn(electron, ["--remote-debugging-port=" + port, "--user-data-dir=" + userData], {
  cwd: desktop,
  env,
  stdio: "ignore",
  windowsHide: true,
});
electronProcess.on("error", error => console.error("ELECTRON_PROCESS_ERROR", error.message));
electronProcess.on("exit", (code, signal) => console.error("ELECTRON_PROCESS_EXIT", code, signal));
if (process.env.AIVS_E2E_OBSERVE_ONLY === "1") {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 20_000));
  console.log(JSON.stringify({ status: electronProcess.exitCode === null ? "alive" : "exited", exitCode: electronProcess.exitCode }));
  if (!electronProcess.killed) electronProcess.kill();
  process.exit(0);
}

try {
  let version;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { version = await jsonRequest("/json/version"); break; }
    catch { await sleep(250); }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("Electron CDP endpoint timeout");
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  if (process.env.AIVS_E2E_CONNECT_ONLY === "1") {
    console.error("CDP_CONNECTED_ONLY");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20_000));
    console.error("CDP_CONNECT_ONLY_STATUS", electronProcess.exitCode === null ? "alive" : `exited:${electronProcess.exitCode}`);
    process.exit(0);
  }
  const context = browser.contexts()[0];
  let page = context?.pages()[0];
  while (!page && Date.now() < deadline) { await sleep(250); page = context?.pages()[0]; }
  if (!page) throw new Error("Electron renderer page not found");
  console.error("ELECTRON_PAGES", JSON.stringify(context.pages().map(item => ({ url: item.url() }))));
  page.on("console", message => console.error("RENDERER_CONSOLE", message.type(), message.text()));
  page.on("pageerror", error => console.error("RENDERER_ERROR", error.message));
  page.on("close", () => console.error("RENDERER_PAGE_CLOSE"));
  browser.on("disconnected", () => console.error("CDP_DISCONNECTED"));
  console.error("RENDERER_BODY", (await page.locator("body").innerText().catch(error => String(error))).slice(0, 500));
  await page.getByRole("heading", { name: "Stage 0 verification" }).waitFor();
  await page.getByText("Core connected").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /Choose a video file/ }).click();
  await page.getByText("cfr-landscape-av.mp4").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Generate proxy" }).click();
  await page.getByText("succeeded").waitFor({ timeout: 90_000 });
  await page.getByText("Validated artifact").waitFor();
  console.log(JSON.stringify({ status: "passed", title: await page.title(), url: page.url() }));
  await browser.close();
} finally {
  if (!electronProcess.killed) electronProcess.kill();
  await new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, 5_000);
    electronProcess.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

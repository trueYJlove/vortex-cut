import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
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
  const context = browser.contexts()[0];
  let page = context?.pages()[0];
  while (!page && Date.now() < deadline) { await sleep(250); page = context?.pages()[0]; }
  if (!page) throw new Error("Electron renderer page not found");
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

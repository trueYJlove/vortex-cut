import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const executable = process.env.AIVS_STAGE4B_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE4B_INSTALL_ROOT;
const installer = process.env.AIVS_STAGE4B_INSTALLER;
const runRoot = process.env.AIVS_STAGE4B_RUN_ROOT ?? join(root, "test-results", `stage4b-real-${process.pid}-${Date.now()}`);
const sourceVideo = process.env.AIVS_STAGE4B_SOURCE_VIDEO ?? join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const resultFile = process.env.AIVS_STAGE4B_RESULT_FILE ?? join(runRoot, "result.json");
const userData = join(runRoot, "user-data");
const installed = Boolean(executable);

// Gate 4B evidence must never retain form content in Playwright traces or screenshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

const launch = () => electron.launch(installed ? {
  executablePath: executable,
  args: [`--user-data-dir=${userData}`],
  cwd: installRoot,
  env: {
    ...process.env,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceVideo }),
    AIVS_RESOURCES_PATH: undefined,
    AIVS_SIDECAR_EXECUTABLE: undefined,
    AIVS_SIDECAR_EXECUTABLE_ARGS: undefined,
    PYTHONPATH: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined,
  },
} : {
  args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`],
  cwd: desktop,
  env: {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceVideo }),
    AIVS_SIDECAR_EXECUTABLE: python,
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined,
  },
});

async function ready(app: any) {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => window.desktop.getRuntime()), { timeout: 120_000 }).toMatchObject({ status: "ready" });
  await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
  return page;
}

async function openWorkbench(page: any) {
  await page.getByRole("button", { name: "打开生成任务模拟验证" }).click();
  await expect(page.getByRole("heading", { name: "生成验证（模拟）" })).toBeVisible();
  await expect(page.getByText("模拟验证：Provider 调用 0 次；不会生成媒体，不会注册素材，也不会写入时间线。").first()).toBeVisible();
}

async function createUiRequest(page: any, kind: "image" | "tts", prompt: string, assetName: string) {
  await page.getByRole("tab", { name: "新建验证" }).click();
  if (kind === "tts") await page.getByLabel("TTS 参数验证").check();
  else await page.getByLabel("图片参数验证").check();
  await page.getByLabel("生成验证 Prompt").fill(prompt);
  await page.getByLabel(`引用素材 ${assetName}`).check();
  await page.getByRole("button", { name: "准备验证" }).click();
  await expect(page.getByRole("heading", { name: "确认模拟验证请求" })).toBeVisible();
  await expect(page.getByText(`${prompt.length} 字符；正文不回显`)).toBeVisible();
  await expect(page.locator(".generation-confirm")).not.toContainText(prompt);
  await page.getByRole("button", { name: "确认并创建验证任务" }).click();
  await expect(page.getByText("验证完成，未生成媒体 · Provider 调用 0 次").last()).toBeVisible({ timeout: 30_000 });
}

async function cancelQueuedThroughOfficialApi(page: any, projectId: string, assetId: string) {
  return page.evaluate(async ({ projectId, assetId }) => {
    // The simulation runner is intentionally very fast. Create+cancel is issued
    // through the production Preload API in one renderer turn; bounded retries
    // avoid changing production timing or adding a packaged debug switch.
    for (let index = 0; index < 12; index += 1) {
      const prompt = ["gate", "4b", "cancel", String(index), String(Date.now())].join("-");
      const request = { generation_kind: "image" as const, prompt, input_refs: [assetId as never], parameters: { width: 320, height: 320, seed: index } };
      const prepared = await window.desktop.prepareMediaGeneration({ project_id: projectId as never, request });
      const created = await window.desktop.createMediaGeneration({ project_id: projectId as never, request: { ...request, request_sha256: prepared.request_sha256 } });
      try {
        const cancelled = await window.desktop.cancelMediaGenerationTask(created.task.task_id);
        return { request: created.request, task: cancelled };
      } catch {
        // A completed simulation is safe and remains provider-free; try a new request.
      }
    }
    throw new Error("GENERATION_CANCEL_WINDOW_UNAVAILABLE");
  }, { projectId, assetId });
}

function inspectDatabase(database: string, prompts: string[], sourcePath: string) {
  const script = String.raw`
import json,sqlite3,sys
p=sys.argv[1]; prompts=json.loads(sys.argv[2]); source_path=sys.argv[3].lower(); raw=open(p,'rb').read().lower()
c=sqlite3.connect(p)
def one(sql): return c.execute(sql).fetchone()[0]
result={
 "schema_v11": one("select count(*) from schema_migrations where version='v11'")==1,
 "schema_count": one("select count(*) from schema_migrations"),
 "request_count": one("select count(*) from media_generation_requests"),
 "task_count": one("select count(*) from media_generation_tasks"),
 "succeeded_count": one("select count(*) from media_generation_tasks where status='succeeded'"),
 "cancelled_count": one("select count(*) from media_generation_tasks where status='cancelled'"),
 "retry_count": one("select count(*) from media_generation_tasks where retry_of_task_id is not null"),
 "provider_invocation_count": one("select count(*) from provider_invocations"),
 "generation_output_asset_count": one("select count(*) from media_generation_tasks where output_asset_id is not null"),
 "generation_artifact_count": one("select count(*) from artifacts a join jobs j on j.id=a.job_id where j.kind='media_generation'"),
 "timeline_revision_count": one("select count(*) from timeline_revisions"),
 "asset_count": one("select count(*) from assets"),
 "prompt_bytes_detected": any(x.encode('utf-8').lower() in raw for x in prompts),
 "generation_payload_path_detected": source_path in " ".join(str(x or "").lower() for row in c.execute("select r.input_refs_json,r.parameters_json,j.input_json from media_generation_requests r join media_generation_tasks t on t.request_id=r.id join jobs j on j.id=t.job_id") for x in row),
}
print(json.dumps(result,separators=(',',':')))
`;
  const checked = spawnSync(python, ["-c", script, database, JSON.stringify(prompts), sourcePath], { encoding: "utf8", windowsHide: true });
  if (checked.status !== 0) throw new Error("STAGE4B_DATABASE_INSPECTION_FAILED");
  return JSON.parse(checked.stdout.trim());
}

async function generatedMediaCount(path: string): Promise<number> {
  const media = new Set([".mp4", ".mov", ".mkv", ".webm", ".wav", ".mp3", ".m4a", ".aac", ".png", ".jpg", ".jpeg", ".webp"]);
  let count = 0;
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (media.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) count += 1;
    }
  }
  await walk(path);
  return count;
}

test("Gate 4B-4 真实 Electron/安装版本模拟工作台、取消重试与重启恢复", async () => {
  test.setTimeout(600_000);
  await mkdir(runRoot, { recursive: true });
  expect((await stat(sourceVideo)).size).toBeGreaterThan(0);
  const promptImage = ["stage", "4b", "image", "memory", "only"].join("-");
  const promptTts = ["stage", "4b", "tts", "memory", "only"].join("-");
  const promptSwitch = ["stage", "4b", "switch", "must", "clear"].join("-");
  const assetName = sourceVideo.split(/[\\/]/).at(-1)!;
  let saved: { projectId: string; requestIds: string[]; retryParent: string; retryTask: string; assetId: string };

  const first = await launch();
  try {
    const page = await ready(first);
    await page.getByLabel("项目名称").fill("Stage 4B Real Acceptance");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "导入video" }).click();
    await expect(page.locator(".asset-row").filter({ hasText: assetName })).toBeVisible({ timeout: 30_000 });
    const setup = await page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name === "Stage 4B Real Acceptance")!;
      const assets = await window.desktop.listAssets({ project_id: project.project_id, limit: 100 });
      return { projectId: project.project_id, assetId: assets.items[0].asset.asset_id };
    });

    await openWorkbench(page);
    await page.getByRole("tab", { name: "历史与任务" }).click();
    await expect(page.getByText("尚无模拟验证记录。")).toBeVisible();
    await createUiRequest(page, "image", promptImage, assetName);
    await createUiRequest(page, "tts", promptTts, assetName);

    const cancelled = await cancelQueuedThroughOfficialApi(page, setup.projectId, setup.assetId);
    await page.getByRole("tab", { name: "历史与任务" }).click();
    await page.getByRole("button", { name: "刷新历史" }).click();
    await page.locator(".generation-request-list button").filter({ hasText: cancelled.request.request_sha256 }).click();
    await expect(page.locator(".generation-task").filter({ hasText: cancelled.task.task_id })).toContainText("已取消");
    await page.locator(".generation-task").filter({ hasText: cancelled.task.task_id }).getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("Attempt 2")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("验证完成，未生成媒体 · Provider 调用 0 次").last()).toBeVisible({ timeout: 30_000 });
    const retryTasks = await page.evaluate(async requestId => (await window.desktop.listMediaGenerationTasks({ request_id: requestId as never, limit: 100 })).items, cancelled.request.request_id);
    const retry = retryTasks.find(item => item.attempt === 2)!;
    expect(retry.retry_of_task_id).toBe(cancelled.task.task_id);
    expect(retry.task_id).not.toBe(cancelled.task.task_id);
    expect(retry.status).toBe("succeeded");

    await page.getByRole("button", { name: "关闭生成验证" }).click();
    await page.getByLabel("项目名称").fill("Stage 4B Switch Target");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await openWorkbench(page);
    await page.getByLabel("生成验证 Prompt").fill(promptSwitch);
    await page.getByLabel("当前项目").selectOption(setup.projectId);
    await expect(page.getByRole("heading", { name: "生成验证（模拟）" })).not.toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(promptSwitch);

    const requests = await page.evaluate(async projectId => (await window.desktop.listMediaGenerationRequests({ project_id: projectId as never, limit: 100 })).items, setup.projectId);
    const publicState = { requests, retryTasks };
    const publicText = JSON.stringify(publicState).toLowerCase();
    for (const forbidden of [promptImage, promptTts, promptSwitch, sourceVideo, userData, "absolute_path", "provider_payload", "raw_exception", "stderr", "traceback"]) {
      expect(publicText).not.toContain(forbidden.toLowerCase());
    }
    saved = { projectId: setup.projectId, requestIds: requests.map(item => item.request_id), retryParent: cancelled.task.task_id, retryTask: retry.task_id, assetId: setup.assetId };
  } finally {
    await first.close().catch(() => undefined);
  }

  let upgraded = false;
  if (installed && installer && installRoot) {
    const reinstall = spawnSync(installer, ["/S", `/D=${installRoot}`], { windowsHide: true, timeout: 240_000 });
    expect(reinstall.status).toBe(0);
    upgraded = true;
  }

  const second = await launch();
  try {
    const page = await ready(second);
    await page.getByLabel("当前项目").selectOption(saved.projectId);
    await openWorkbench(page);
    await page.getByRole("tab", { name: "历史与任务" }).click();
    await expect(page.locator(".generation-request-list button")).toHaveCount(saved.requestIds.length, { timeout: 30_000 });
    const persisted = await page.evaluate(async ({ projectId, parentId, retryId }) => {
      const requests = await window.desktop.listMediaGenerationRequests({ project_id: projectId as never, limit: 100 });
      const tasks = (await Promise.all(requests.items.map(item => window.desktop.listMediaGenerationTasks({ request_id: item.request_id, limit: 100 })))).flatMap(item => item.items);
      const jobs = await window.desktop.listJobs({ project_id: projectId as never, limit: 100 });
      return {
        requestIds: requests.items.map(item => item.request_id),
        parent: tasks.find(item => item.task_id === parentId),
        retry: tasks.find(item => item.task_id === retryId),
        providerJobs: jobs.items.filter(item => item.kind.includes("provider")).length,
      };
    }, { projectId: saved.projectId, parentId: saved.retryParent, retryId: saved.retryTask });
    expect(saved.requestIds.every(id => persisted.requestIds.includes(id))).toBe(true);
    expect(persisted.parent?.status).toBe("cancelled");
    expect(persisted.retry).toMatchObject({ status: "succeeded", retry_of_task_id: saved.retryParent, attempt: 2 });
    expect(persisted.providerJobs).toBe(0);
  } finally {
    await second.close().catch(() => undefined);
  }

  const database = join(userData, "data-v2", "app.db");
  const forbidden = [promptImage, promptTts, promptSwitch];
  const databaseEvidence = inspectDatabase(database, forbidden, sourceVideo);
  expect(databaseEvidence).toMatchObject({
    schema_v11: true,
    provider_invocation_count: 0,
    generation_output_asset_count: 0,
    generation_artifact_count: 0,
    timeline_revision_count: 0,
    asset_count: 1,
    prompt_bytes_detected: false,
    generation_payload_path_detected: false,
  });
  expect(databaseEvidence.cancelled_count).toBeGreaterThanOrEqual(1);
  expect(databaseEvidence.retry_count).toBeGreaterThanOrEqual(1);
  expect(databaseEvidence.succeeded_count).toBeGreaterThanOrEqual(3);
  const diskMediaCount = await generatedMediaCount(userData);
  expect(diskMediaCount).toBe(0);
  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  for (const forbiddenValue of forbidden) expect(desktopLog.toLowerCase()).not.toContain(forbiddenValue.toLowerCase());

  const evidence = {
    schema_version: 1,
    status: "passed",
    target: installed ? "installed_nsis" : "development_electron",
    checks: {
      runtime_ready: true,
      empty_history: true,
      image_simulation: true,
      tts_simulation: true,
      quick_terminal_observed: true,
      cancellation_observed: true,
      retry_lineage_observed: true,
      project_switch_cleared_form: true,
      restart_restored_history: true,
      in_place_reinstall_preserved_history: upgraded,
      provider_invocation_count: databaseEvidence.provider_invocation_count,
      generated_media_file_count: diskMediaCount,
      generated_asset_count: databaseEvidence.generation_output_asset_count,
      generated_artifact_count: databaseEvidence.generation_artifact_count,
      timeline_revision_count: databaseEvidence.timeline_revision_count,
      prompt_detected: databaseEvidence.prompt_bytes_detected,
      generation_payload_path_detected: databaseEvidence.generation_payload_path_detected,
      sqlite_v11: databaseEvidence.schema_v11,
      request_count: databaseEvidence.request_count,
      task_count: databaseEvidence.task_count,
      cancelled_count: databaseEvidence.cancelled_count,
      retry_count: databaseEvidence.retry_count,
    },
    ids: {
      project_id: saved.projectId,
      retry_parent_task_id: saved.retryParent,
      retry_task_id: saved.retryTask,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
});

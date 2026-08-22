import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as {
  _electron: { launch: (options: Record<string, unknown>) => Promise<any> };
};
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const python = process.env.AIVS_STAGE6R_PYTHON ?? join(root, ".venv", "Scripts", "python.exe");
const executable = process.env.AIVS_STAGE6R_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE6R_INSTALL_ROOT;
const mode = process.env.AIVS_STAGE6R_MODE ?? (executable ? "installed_fresh" : "development_fresh");
const upgrade = mode.endsWith("upgrade_v16");
const installed = Boolean(executable);
const runRoot = process.env.AIVS_STAGE6R_RUN_ROOT ?? join(root, "test-results", `stage6r-${mode}-${process.pid}-${Date.now()}`);
const resultFile = process.env.AIVS_STAGE6R_RESULT_FILE ?? join(runRoot, "result.json");
const userData = join(runRoot, "user-data");
const dataDir = join(userData, "data-v2");
const database = join(dataDir, "app.db");
const pythonPath = [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";");

test.use({ trace: "off", screenshot: "off", video: "off" });

function runPython(script: string, args: string[]) {
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(";") },
  });
  if (result.status !== 0) throw new Error("STAGE6R_ELECTRON_EVIDENCE_HELPER_FAILED");
  return result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
}

function seedDatabase() {
  const script = String.raw`
import importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1]); data=Path(sys.argv[2]); upgrade=sys.argv[3]=='1'
spec=importlib.util.spec_from_file_location('stage6r_acceptance',root/'tools'/'verify_stage6r_offline_real.py')
v=importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
ids=v.seed(data,'stage6r-electron-offline-admin',upgrade)
print(json.dumps(ids,separators=(',',':')))
`;
  return JSON.parse(runPython(script, [root, dataDir, upgrade ? "1" : "0"]));
}

function inspectDatabase() {
  const script = String.raw`
import importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1]); database=Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('stage6r_acceptance',root/'tools'/'verify_stage6r_offline_real.py')
v=importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
print(json.dumps(v.inspect(database),separators=(',',':')))
`;
  return JSON.parse(runPython(script, [root, database]));
}

function generationSnapshot(value: any) {
  return {
    provider_call_count: value.provider_call_count,
    invocation_count: value.invocation_count,
    request_count: value.request_count,
    task_count: value.task_count,
    provenance_count: value.provenance_count,
    link_count: value.link_count,
    adoption_count: value.adoption_count,
    asset_count: value.asset_count,
  };
}

const gpuFallbackArgs = ["--disable-gpu", "--disable-gpu-compositing", "--use-gl=swiftshader", "--in-process-gpu"];
const launch = () => electron.launch(installed ? {
  executablePath: executable,
  args: [`--user-data-dir=${userData}`, ...gpuFallbackArgs],
  cwd: installRoot,
  env: {
    ...process.env,
    AIVS_ADMIN_TOKEN: "stage6r-electron-offline-admin",
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: "false",
    AIVS_REAL_PROVIDER_ENABLED: "false",
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_RESOURCES_PATH: undefined,
    AIVS_SIDECAR_EXECUTABLE: undefined,
    AIVS_SIDECAR_EXECUTABLE_ARGS: undefined,
    AIVS_E2E_MODEL_DIR: undefined,
    PYTHONPATH: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined,
  },
} : {
  args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`, ...gpuFallbackArgs],
  cwd: desktop,
  env: {
    ...process.env,
    AIVS_ADMIN_TOKEN: "stage6r-electron-offline-admin",
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: "false",
    AIVS_REAL_PROVIDER_ENABLED: "false",
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_RESOURCES_PATH: resources,
    AIVS_SIDECAR_EXECUTABLE: python,
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    AIVS_E2E_MODEL_DIR: undefined,
    PYTHONPATH: pythonPath,
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

async function openBatchPanel(page: any, projectId: string) {
  await page.getByLabel("当前项目").selectOption(projectId);
  await page.getByRole("button", { name: "打开镜头与资产需求清单" }).click();
  await expect(page.getByRole("heading", { name: "镜头与资产需求清单" })).toBeVisible();
  await page.getByRole("tab", { name: "图片履约" }).click();
  const panel = page.getByRole("region", { name: "已采用图片批量时间线装配" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Provider 调用、网络外传和费用增量均为/)).toBeVisible();
  await expect(panel.locator(".stage6r-batch-candidates label")).toHaveCount(24, { timeout: 30_000 });
  return panel;
}

async function performBatch(page: any, projectId: string, count: number, duration: string) {
  const panel = await openBatchPanel(page, projectId);
  const candidates = panel.locator(".stage6r-batch-candidates label");
  for (let index = 0; index < count; index += 1) {
    await candidates.nth(index).locator("input").check();
  }
  const order = panel.locator(".stage6r-batch-order > div");
  await expect(order).toHaveCount(count);
  for (let index = 0; index < count; index += 1) {
    await order.nth(index).getByLabel(/批量图片时长 /).fill(duration);
  }
  await panel.getByRole("button", { name: "准备批量时间线装配" }).click();
  const dialog = panel.getByRole("dialog", { name: "确认批量时间线装配" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(new RegExp(`将以一个事务装配 ${count} 个图片 Clip`))).toBeVisible();
  await dialog.getByRole("button", { name: "显式确认批量装配" }).click();
  await expect.poll(async () => panel.getByRole("status").innerText()).toContain("Timeline");
}

test.setTimeout(180_000);

test(`Stage 6-R Electron offline batch assembly: ${mode}`, async () => {
  await mkdir(dataDir, { recursive: true });
  const seed = seedDatabase();
  expect(seed.schema_count).toBe(upgrade ? 16 : 17);
  const baseline = inspectDatabase();
  const first = await launch();
  let firstPage: any;
  try {
    firstPage = await ready(first);
    await performBatch(firstPage, seed.project_id, 24, "1");
  } finally {
    await first.close().catch(() => undefined);
  }

  const afterFirst = inspectDatabase();
  expect(generationSnapshot(afterFirst)).toEqual(generationSnapshot(baseline));
  expect(afterFirst.timeline_revision_count).toBe(baseline.timeline_revision_count + 1);
  expect(afterFirst.batch_preview_count).toBe(1);
  expect(afterFirst.batch_preview_item_count).toBe(24);
  expect(afterFirst.batch_count).toBe(1);
  expect(afterFirst.batch_item_count).toBe(24);
  expect(afterFirst.render_job_count).toBe(0);
  expect(afterFirst.artifact_count).toBe(0);

  const second = await launch();
  let restored: any;
  try {
    const page = await ready(second);
    restored = await page.evaluate(async project => {
      const timeline = await window.desktop.getTimeline(project as never);
      const batches = await window.desktop.listShotRequirementTimelineBatches({
        project_id: project as never, limit: 20,
      });
      const batch = batches.items[0];
      const items = await window.desktop.listShotRequirementTimelineBatchAssemblyItems({
        batch_id: batch.batch_assembly_id as never, limit: 100,
      });
      const undo = await window.desktop.undoTimeline({
        project_id: project as never, base_revision_id: timeline.current_revision.timeline_revision_id as never,
      });
      const redo = await window.desktop.redoTimeline({
        project_id: project as never, base_revision_id: undo.current_revision.timeline_revision_id as never,
      });
      return {
        clip_count: timeline.current_revision.document.clips.length,
        batch_count: batches.items.length,
        item_count: items.items.length,
        output_preserved: redo.current_revision.timeline_revision_id === timeline.current_revision.timeline_revision_id,
        undo_clip_count: undo.current_revision.document.clips.length,
      };
    }, seed.project_id);
  } finally {
    await second.close().catch(() => undefined);
  }
  expect(restored).toEqual({
    clip_count: 24, batch_count: 1, item_count: 24,
    output_preserved: true, undo_clip_count: 0,
  });

  const third = await launch();
  let stage5: any;
  try {
    const page = await ready(third);
    stage5 = await page.evaluate(async ({ project, requirement, adoption }) => {
      const timeline = await window.desktop.getTimeline(project as never);
      const prepared = await window.desktop.prepareShotRequirementTimelineAssembly({
        project_id: project as never, requirement_id: requirement as never,
        request: {
          expected_adoption_id: adoption as never,
          base_timeline_revision_id: timeline.current_revision.timeline_revision_id as never,
          at_index: 24, duration_us: 2_000_000, layout: "fit",
        },
      });
      const applied = await window.desktop.applyShotRequirementTimelineAssembly({
        project_id: project as never, requirement_id: requirement as never,
        request: {
          assembly_preview_id: prepared.preview_id as never,
          proposed_document_sha256: prepared.proposed_document_sha256, confirmed: true,
        },
      });
      return { clip_count_before: prepared.clip_count_before, reused: applied.reused, assembly: Boolean(applied.assembly) };
    }, {
      project: seed.project_id,
      requirement: seed.requirement_ids[0],
      adoption: "stage6r-real-adoption-0",
    });
  } finally {
    await third.close().catch(() => undefined);
  }
  expect(stage5).toEqual({ clip_count_before: 24, reused: false, assembly: true });

  const final = inspectDatabase();
  expect(final).toMatchObject({ schema_count: 17, foreign_key_ok: true, integrity_ok: true });
  expect(generationSnapshot(final)).toEqual(generationSnapshot(baseline));
  expect(final.timeline_revision_count).toBe(baseline.timeline_revision_count + 2);
  expect(final.batch_preview_count).toBe(1);
  expect(final.batch_preview_item_count).toBe(24);
  expect(final.batch_count).toBe(1);
  expect(final.batch_item_count).toBe(24);
  expect(final.render_job_count).toBe(0);
  expect(final.artifact_count).toBe(0);
  if (upgrade) {
    for (const [key, value] of Object.entries(seed.prior_checksums)) {
      expect(final.migration_checksums?.[key]).toBe(value);
    }
  }

  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  expect(desktopLog).not.toContain("STAGE6R_OFFLINE_PRIVATE_REQUIREMENT_BODY");
  const evidence = {
    schema_version: 1,
    status: "passed",
    target: mode,
    checks: {
      runtime_ready: true,
      installed_runtime: installed,
      provider_network_disabled: true,
      provider_call_delta: 0,
      generation_fact_delta: 0,
      batch_24_succeeded: true,
      timeline_revision_delta: 1,
      batch_delta: 1,
      batch_item_delta: 24,
      automatic_render_delta: 0,
      automatic_artifact_delta: 0,
      restart_restored: true,
      undo_redo_correct: true,
      stage5_still_available: true,
      sqlite_v17: true,
      v16_in_place_upgrade: upgrade,
      prior_checksums_preserved: true,
      foreign_key_ok: final.foreign_key_ok,
      integrity_ok: final.integrity_ok,
      privacy_scan_passed: true,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const encoded = JSON.stringify(evidence, null, 2);
  for (const forbidden of ["STAGE6R_OFFLINE_PRIVATE_REQUIREMENT_BODY", userData, database]) {
    expect(encoded.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
  await writeFile(resultFile, `${encoded}\n`, "utf8");
});


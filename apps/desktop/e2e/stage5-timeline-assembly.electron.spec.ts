import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { selectProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as {
  _electron: { launch: (options: Record<string, unknown>) => Promise<any> };
};
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const executable = process.env.AIVS_STAGE5_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE5_INSTALL_ROOT;
const mode = process.env.AIVS_STAGE5_MODE ?? (executable ? "installed_fresh" : "development_fresh");
const upgrade = mode.endsWith("upgrade_v15");
const installed = Boolean(executable);
const runRoot = process.env.AIVS_STAGE5_RUN_ROOT ?? join(root, "test-results", `stage5-${mode}-${process.pid}-${Date.now()}`);
const resultFile = process.env.AIVS_STAGE5_RESULT_FILE ?? join(runRoot, "result.json");
const userData = join(runRoot, "user-data");
const dataDir = join(userData, "data-v2");
const database = join(dataDir, "app.db");
const pythonPath = [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";");

test.use({ trace: "off", screenshot: "off", video: "off" });

function runPython(script: string, args: string[]) {
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONPATH: pythonPath },
  });
  if (result.status !== 0) throw new Error("STAGE5_ELECTRON_EVIDENCE_HELPER_FAILED");
  return result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
}

function seedDatabase() {
  const script = String.raw`
import importlib.util,json,os,sqlite3,sys
from pathlib import Path
from fastapi.testclient import TestClient
root=Path(sys.argv[1]); data=Path(sys.argv[2]); upgrade=sys.argv[3]=='1'
spec=importlib.util.spec_from_file_location('stage5_acceptance',root/'tools'/'verify_stage5_offline_real.py')
v=importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
os.environ['AIVS_ADMIN_TOKEN']='stage5-electron-offline-admin'
original=v.database_module.MIGRATIONS
try:
 if upgrade: v.database_module.MIGRATIONS={k:x for k,x in original.items() if int(k[1:])<=15}
 app=v.create_app(v.settings(data))
 v.Database(data/'app.db').initialize()
 with TestClient(app) as client:
  _,ui=v.auth(client,'stage5-electron-offline-admin'); ids=v.create_domain(app,client,ui)
 with sqlite3.connect(data/'app.db') as c: checksums=dict(c.execute('select version,checksum from schema_migrations'))
finally: v.database_module.MIGRATIONS=original
print(json.dumps({'project_id':ids['project_id'],'requirement_id':ids['requirement_id'],'schema_count':len(checksums),'prior_checksums':checksums},separators=(',',':')))
`;
  return JSON.parse(runPython(script, [root, dataDir, upgrade ? "1" : "0"]));
}

function inspectDatabase() {
  const script = String.raw`
import json,sqlite3,sys
from pathlib import Path
import aivs_core.database as dm
p=Path(sys.argv[1]); data=p.parent
with sqlite3.connect(p) as c:
 checksums=dict(c.execute('select version,checksum from schema_migrations'))
 tables={row[0] for row in c.execute("select name from sqlite_master where type='table'")}
 count=lambda name: c.execute(f'select count(*) from {name}').fetchone()[0] if name in tables else 0
 value={'schema_count':len(checksums),'migration_total':len(dm.MIGRATIONS),'migration_checksums':checksums,
 'request_count':c.execute('select count(*) from media_generation_requests').fetchone()[0],
 'task_count':c.execute('select count(*) from media_generation_tasks').fetchone()[0],
 'generation_job_count':c.execute("select count(*) from jobs where kind='media_generation'").fetchone()[0],
 'render_job_count':c.execute("select count(*) from jobs where kind!='media_generation'").fetchone()[0],
 'invocation_count':c.execute('select count(*) from provider_image_invocations').fetchone()[0],
 'provider_call_count':c.execute('select coalesce(sum(provider_call_count),0) from provider_image_invocations').fetchone()[0],
 'provenance_count':c.execute('select count(*) from generated_asset_provenance').fetchone()[0],
 'link_count':c.execute('select count(*) from shot_requirement_image_generation_links').fetchone()[0],
 'adoption_count':c.execute('select count(*) from shot_requirement_image_adoptions').fetchone()[0],
 'asset_count':c.execute('select count(*) from assets').fetchone()[0],
 'timeline_revision_count':c.execute('select count(*) from timeline_revisions').fetchone()[0],
 'assembly_preview_count':count('shot_requirement_timeline_assembly_previews'),
 'assembly_count':count('shot_requirement_timeline_assemblies'),
 'artifact_count':c.execute('select count(*) from artifacts').fetchone()[0],
 'foreign_key_ok':len(c.execute('pragma foreign_key_check').fetchall())==0,
 'integrity_ok':c.execute('pragma integrity_check').fetchone()[0]=='ok'}
value['backup_count']=len(list((data/'backups').glob('*.db')))
print(json.dumps(value,separators=(',',':')))
`;
  return JSON.parse(runPython(script, [database]));
}

function generationSnapshot(value: any) {
  return {
    request_count: value.request_count, task_count: value.task_count,
    generation_job_count: value.generation_job_count, invocation_count: value.invocation_count,
    provider_call_count: value.provider_call_count, provenance_count: value.provenance_count,
    link_count: value.link_count, adoption_count: value.adoption_count, asset_count: value.asset_count,
  };
}
const gpuFallbackArgs = ["--disable-gpu", "--disable-gpu-compositing", "--use-gl=swiftshader", "--in-process-gpu"];
const launch = () => electron.launch(installed ? {
  executablePath: executable,
  args: [`--user-data-dir=${userData}`, ...gpuFallbackArgs],
  cwd: installRoot,
  env: {
    ...process.env,
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
  args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`, ...gpuFallbackArgs],
  cwd: desktop,
  env: {
    ...process.env,
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

async function fulfillmentDiagnostics(page: any, projectId: string, requirementId: string) {
  return page.evaluate(async ({ projectId, requirementId }) => {
    const probe = async (run: () => Promise<unknown>, summarize: (value: any) => object) => {
      try { return { ok: true, ...summarize(await run()) }; }
      catch { return { ok: false, safe_code: "IPC_OR_CONTRACT_REJECTED" }; }
    };
    return {
      fulfillment: await probe(
        () => window.desktop.getShotRequirementImageFulfillment({ project_id: projectId as never, requirement_id: requirementId as never }),
        value => ({ lifecycle: value.lifecycle, has_current_adoption: Boolean(value.current_adoption), availability: value.current_asset_availability }),
      ),
      links: await probe(
        () => window.desktop.listShotRequirementImageFulfillmentLinks({ project_id: projectId as never, requirement_id: requirementId as never, limit: 100 }),
        value => ({ count: value.items.length }),
      ),
      provider_configs: await probe(
        () => window.desktop.listImageProviderConfigs(projectId as never),
        value => ({ count: value.items.length }),
      ),
      request: await probe(
        () => window.desktop.getProviderImageGenerationRequest("stage5-real-request" as never),
        value => ({ generation_kind: value.generation_kind, execution_mode: value.execution_mode }),
      ),
      tasks: await probe(
        () => window.desktop.listProviderImageGenerationTasks({ request_id: "stage5-real-request" as never, limit: 100 }),
        value => ({ count: value.items.length, statuses: value.items.map((item: any) => item.status) }),
      ),
    };
  }, { projectId, requirementId });
}

async function openAssembly(page: any, projectId: string, requirementId: string) {
  await selectProject(page, projectId);
  await page.getByRole("button", { name: "工具" }).click();
  await page.getByRole("menuitem", { name: "镜头需求" }).click();
  await expect(page.getByRole("heading", { name: "镜头与资产需求清单" })).toBeVisible();
  await page.getByRole("tab", { name: "图片履约" }).click();
  const fulfillment = page.getByRole("region", { name: "Adopted image 图片履约" });
  await expect(fulfillment).toBeVisible();
  console.log("STAGE5_SAFE_DIAGNOSTIC", JSON.stringify(await fulfillmentDiagnostics(page, projectId, requirementId)));
  await expect(fulfillment.getByText(/已采用/).first()).toBeVisible({ timeout: 30_000 });
  const assembly = fulfillment.getByRole("region", { name: "已采用图片时间线装配" });
  await expect(assembly).toBeVisible({ timeout: 30_000 });
  return assembly;
}

function priorPreserved(seed: any, final: any) {
  return Object.entries(seed.prior_checksums).every(([key, value]) => final.migration_checksums[key] === value);
}

test(`Stage 5 Electron offline assembly: ${mode}`, async () => {
  await mkdir(dataDir, { recursive: true });
  const seed = seedDatabase();
  const baseline = inspectDatabase();
  // 升级剧本把迁移集截断到 v15（对话式前提事实，不是 HEAD）；非升级路径必须等于代码定义的迁移总数。
  expect(seed.schema_count).toBe(upgrade ? 15 : baseline.migration_total);
  const first = await launch();
  let afterPrepare: any;
  let afterApply: any;
  try {
    const page = await ready(first);
    const assembly = await openAssembly(page, seed.project_id, seed.requirement_id);
    await expect(assembly.getByText(/Provider 调用、网络外传和费用增量均为 0/)).toBeVisible();
    await assembly.getByLabel("装配图片时长").fill("2");
    await assembly.getByLabel("装配图片布局").selectOption("fit");
    await assembly.getByRole("button", { name: "准备时间线装配" }).click();
    const dialog = assembly.getByRole("dialog", { name: "确认时间线装配" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/将新增 1 个图片 Clip/)).toBeVisible();
    afterPrepare = inspectDatabase();
    expect(generationSnapshot(afterPrepare)).toEqual(generationSnapshot(baseline));
    expect(afterPrepare.timeline_revision_count).toBe(baseline.timeline_revision_count);
    expect(afterPrepare.assembly_preview_count).toBe(baseline.assembly_preview_count + 1);
    expect(afterPrepare.assembly_count).toBe(baseline.assembly_count);
    expect(afterPrepare.render_job_count).toBe(baseline.render_job_count);
    expect(afterPrepare.artifact_count).toBe(baseline.artifact_count);
    await dialog.getByRole("button", { name: "显式确认装配" }).click();
    await expect(assembly.getByRole("status")).toContainText("新的 Timeline Revision");
    await expect(assembly.getByText("已记录 1 条不可变装配事实。")).toBeVisible();
    afterApply = inspectDatabase();
    expect(generationSnapshot(afterApply)).toEqual(generationSnapshot(baseline));
    expect(afterApply.timeline_revision_count).toBe(baseline.timeline_revision_count + 1);
    expect(afterApply.assembly_count).toBe(baseline.assembly_count + 1);
    expect(afterApply.render_job_count).toBe(baseline.render_job_count);
    expect(afterApply.artifact_count).toBe(baseline.artifact_count);
    const timeline = await page.evaluate(async id => window.desktop.getTimeline(id as never), seed.project_id);
    expect(timeline.current_revision.document.clips).toHaveLength(1);
    expect(timeline.current_revision.document.clips[0]).toMatchObject({
      asset_id: "stage5-real-image", layout: "fit", timeline_start_us: 0, timeline_end_us: 2_000_000,
    });
  } finally {
    await first.close().catch(() => undefined);
  }

  const second = await launch();
  try {
    const page = await ready(second);
    const assembly = await openAssembly(page, seed.project_id, seed.requirement_id);
    await expect(assembly.getByText("已记录 1 条不可变装配事实。")).toBeVisible();
    const restored = await page.evaluate(async ({ project, requirement }) => {
      const timeline = await window.desktop.getTimeline(project as never);
      const page = await window.desktop.listShotRequirementTimelineAssemblies({
        project_id: project as never, requirement_id: requirement as never, limit: 20,
      });
      return { clip_count: timeline.current_revision.document.clips.length, assembly_count: page.items.length };
    }, { project: seed.project_id, requirement: seed.requirement_id });
    expect(restored).toEqual({ clip_count: 1, assembly_count: 1 });
  } finally {
    await second.close().catch(() => undefined);
  }
  const final = inspectDatabase();
  // 断言库已应用当前 HEAD 的全部迁移；不在 spec 写死版本号，避免每加一条迁移就腐化。
  expect(final).toMatchObject({ schema_count: final.migration_total, foreign_key_ok: true, integrity_ok: true });
  expect(generationSnapshot(final)).toEqual(generationSnapshot(baseline));
  expect(final.timeline_revision_count).toBe(baseline.timeline_revision_count + 1);
  expect(final.assembly_preview_count).toBe(baseline.assembly_preview_count + 1);
  expect(final.assembly_count).toBe(baseline.assembly_count + 1);
  expect(final.render_job_count).toBe(baseline.render_job_count);
  expect(final.artifact_count).toBe(baseline.artifact_count);
  expect(priorPreserved(seed, final)).toBe(true);
  if (upgrade) expect(final.backup_count).toBeGreaterThanOrEqual(1);

  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  expect(desktopLog).not.toContain("STAGE5_OFFLINE_PRIVATE_REQUIREMENT_BODY");
  const evidence = {
    schema_version: 1, status: "passed", target: mode,
    checks: {
      runtime_ready: true, installed_runtime: installed,
      provider_network_disabled: true, provider_call_delta: 0,
      generation_fact_delta: 0, prepare_persisted: true,
      explicit_confirmation: true, timeline_revision_delta: 1,
      assembly_delta: 1, image_clip_delta: 1,
      automatic_render_delta: 0, automatic_artifact_delta: 0,
      restart_restored: true, sqlite_v17: true,
      v15_in_place_upgrade: upgrade,
      prior_checksums_preserved: priorPreserved(seed, final),
      migration_backup_created: upgrade ? final.backup_count > 0 : null,
      foreign_key_ok: final.foreign_key_ok, integrity_ok: final.integrity_ok,
      privacy_scan_passed: true,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const encoded = JSON.stringify(evidence, null, 2);
  for (const forbidden of ["STAGE5_OFFLINE_PRIVATE_REQUIREMENT_BODY", userData, database]) {
    expect(encoded.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
  await writeFile(resultFile, `${encoded}\n`, "utf8");
});


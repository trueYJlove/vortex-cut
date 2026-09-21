import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openProjectManagement, selectProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const desktop = resolve(here, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const executable = process.env.AIVS_STAGE4D_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE4D_INSTALL_ROOT;
const mode = process.env.AIVS_STAGE4D_MODE ?? (executable ? "installed_fresh" : "development");
const runRoot = process.env.AIVS_STAGE4D_RUN_ROOT ?? join(root, "test-results", `stage4d-real-${process.pid}-${Date.now()}`);
const resultFile = process.env.AIVS_STAGE4D_RESULT_FILE ?? join(runRoot, "result.json");
const userData = join(runRoot, "user-data");
const database = join(userData, "data-v2", "app.db");
const installed = Boolean(executable);
const pythonPath = [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";");
const credential = process.env.AIVS_REAL_PROVIDER_API_KEY ?? "";
const priorEstimatedUsd = 0.55;
const estimatedUsdPerNewDispatch = 0.15;
const providerPriceCny = 0.10;
const hardStopUsd = 2;
const recoveryOnly = process.env.AIVS_STAGE4D_RECOVERY_ONLY === "true";
const successRecoveryOnly = process.env.AIVS_STAGE4D_SUCCESS_RECOVERY_ONLY === "true";
const offlineAcceptance = process.env.AIVS_STAGE4D_OFFLINE_ACCEPTANCE === "true";
const providerNetworkEnabled = !recoveryOnly && !successRecoveryOnly && !offlineAcceptance;

// Prompt and credential must not enter Playwright artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

function assertBudgetBeforeCall(completedCalls: number): void {
  const nextTotal = priorEstimatedUsd + (completedCalls + 1) * estimatedUsdPerNewDispatch;
  if (nextTotal > hardStopUsd) throw new Error("STAGE4D_USD_2_HARD_STOP");
}

const launch = () => electron.launch(installed ? {
  executablePath: executable,
  args: [`--user-data-dir=${userData}`],
  cwd: installRoot,
  env: {
    ...process.env,
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: providerNetworkEnabled ? "true" : undefined,
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_RESOURCES_PATH: undefined,
    AIVS_SIDECAR_EXECUTABLE: undefined,
    AIVS_SIDECAR_EXECUTABLE_ARGS: undefined,
    PYTHONPATH: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined,
  },
} : {
  args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`],
  cwd: desktop,
  env: {
    ...process.env,
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: providerNetworkEnabled ? "true" : undefined,
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_RESOURCES_PATH: resources,
    AIVS_SIDECAR_EXECUTABLE: python,
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
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

async function openWorkbench(page: any) {
  await page.getByRole("button", { name: "工具" }).click();
  await page.getByRole("menuitem", { name: "真实图片生成" }).click();
  await expect(page.getByRole("heading", { name: "真实图片生成（受控）" })).toBeVisible();
  await expect(page.getByText(/一次确认对应每个 Task 最多一次调用/)).toBeVisible();
}

function inspectDatabase() {
  const script = String.raw`
import hashlib,json,os,sqlite3,sys
from pathlib import Path
from urllib.parse import unquote,urlparse
p=Path(sys.argv[1]); c=sqlite3.connect(p); c.row_factory=sqlite3.Row
one=lambda sql: c.execute(sql).fetchone()[0]
row=c.execute("select a.kind,a.storage_mode,a.availability,a.size_bytes,l.uri,t.status,t.output_asset_id,t.output_sha256,i.provider_call_count,i.provider_may_have_processed,i.estimated_cost,i.estimated_cost_currency,i.price_tier,p.provider_kind,p.adapter_id,p.model,i.validated_format,i.validated_width,i.validated_height,i.validated_size_bytes,i.output_sha256 as invocation_sha,p.output_sha256 as provenance_sha from media_generation_tasks t join media_generation_requests r on r.id=t.request_id join provider_image_invocations i on i.task_id=t.id join generated_asset_provenance p on p.task_id=t.id join assets a on a.id=t.output_asset_id join asset_locations l on l.asset_id=a.id where r.execution_mode='provider_image_v1'").fetchone()
parsed=urlparse(row['uri']); value=unquote(parsed.path)
if os.name=='nt' and len(value)>=3 and value[0]=='/' and value[2]==':': value=value[1:]
path=Path(value)
result={
 "schema_v14":one("select count(*) from schema_migrations where version='v14'")==1,
 "schema_count":one("select count(*) from schema_migrations"),
 "request_count":one("select count(*) from media_generation_requests where execution_mode='provider_image_v1'"),
 "task_count":one("select count(*) from media_generation_tasks t join media_generation_requests r on r.id=t.request_id where r.execution_mode='provider_image_v1'"),
 "invocation_count":one("select count(*) from provider_image_invocations"),
 "provenance_count":one("select count(*) from generated_asset_provenance"),
 "timeline_revision_count":one("select count(*) from timeline_revisions"),
 "foreign_key_ok":len(c.execute("pragma foreign_key_check").fetchall())==0,
 "integrity_ok":c.execute("pragma integrity_check").fetchone()[0]=="ok",
 "asset_kind":row['kind'],"storage_mode":row['storage_mode'],"availability":row['availability'],
 "task_status":row['status'],"provider_call_count":row['provider_call_count'],
 "provider_may_have_processed":bool(row['provider_may_have_processed']),
 "estimated_cost":row['estimated_cost'],"estimated_cost_currency":row['estimated_cost_currency'],"price_tier":row['price_tier'],
 "provider_kind":row['provider_kind'],"adapter_id":row['adapter_id'],"model":row['model'],"format":row['validated_format'],
 "width":row['validated_width'],"height":row['validated_height'],
 "size_bytes":row['validated_size_bytes'],
 "asset_file_exists":path.is_file(),
 "asset_size_matches":path.is_file() and path.stat().st_size==row['validated_size_bytes']==row['size_bytes'],
 "asset_hash_matches":path.is_file() and 'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()==row['output_sha256']==row['invocation_sha']==row['provenance_sha'],
}
print(json.dumps(result,separators=(',',':')))
`;
  const checked = spawnSync(python, ["-c", script, database], { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONPATH: pythonPath } });
  if (checked.status !== 0) throw new Error("STAGE4D_DATABASE_INSPECTION_FAILED");
  return JSON.parse(checked.stdout.trim());
}

function assertRendererSafe(value: unknown, forbidden: string[]) {
  const text = JSON.stringify(value).toLowerCase();
  for (const item of forbidden.filter(Boolean)) expect(text).not.toContain(item.toLowerCase());
  for (const key of ["absolute_path", "local_path", "provider_payload", "raw_response", "authorization", "api_key", "secret", "traceback", "stderr", "command"]) expect(text).not.toContain(`\"${key}\"`);
}

function runEvidencePython(script: string, args: string[]) {
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: pythonPath },
  });
  if (result.status !== 0) throw new Error("STAGE4D_OFFLINE_EVIDENCE_HELPER_FAILED");
  return result.stdout.trim();
}

async function seedV13Database() {
  await mkdir(dirname(database), { recursive: true });
  const script = String.raw`
import json,sqlite3,sys
from pathlib import Path
import aivs_core.database as dm
p=Path(sys.argv[1]); full=dm.MIGRATIONS
dm.MIGRATIONS={k:v for k,v in full.items() if int(k[1:])<=13}
dm.Database(p).initialize()
with sqlite3.connect(p) as c:
 c.executescript("""
 INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at)
 VALUES ('stage4d_legacy_project','Stage 4D Legacy Upgrade','active','{}',NULL,'legacy-root','legacy-root','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 INSERT INTO media_generation_requests VALUES
 ('stage4d_legacy_request','stage4d_legacy_project','image','provider_image_v1','sha256:legacy-prompt','[]','{}','sha256:legacy-request','2026-01-01T00:00:00.000Z');
 INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at)
 VALUES ('stage4d_legacy_job','stage4d_legacy_project','media_generation','media_generation','failed','failed',1,'{}',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,error_code,error_message,created_at,updated_at,finished_at)
 VALUES ('stage4d_legacy_task','stage4d_legacy_request','stage4d_legacy_job',1,'failed','failed','PROVIDER_TIMEOUT','Provider 请求超时','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 INSERT INTO image_provider_configs VALUES
 ('stage4d_legacy_config','stage4d_legacy_project','openai_images','openai_images_generations_v1','image_text_to_image','1','Historical OpenAI','gpt-image-1',1,0.25,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 INSERT INTO provider_image_request_profiles VALUES
 ('stage4d_legacy_request','stage4d_legacy_config','openai_images','openai_images_generations_v1','image_text_to_image','1','gpt-image-1','openai_images_generations','1024x1024','png','sha256:legacy-profile','sha256:legacy-payload','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 INSERT INTO provider_image_invocations VALUES
 ('stage4d_legacy_invocation','stage4d_legacy_task','stage4d_legacy_config','failed',1,1,NULL,NULL,0.25,NULL,NULL,NULL,NULL,NULL,NULL,'PROVIDER_TIMEOUT','Provider 请求超时',0,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 """)
print(json.dumps({"schema_count":13,"legacy_project_count":1,"legacy_request_count":1,"legacy_task_count":1,"legacy_invocation_count":1},separators=(",",":")))
`;
  return JSON.parse(runEvidencePython(script, [database]));
}

function inspectOfflineDatabase() {
  const script = String.raw`
import hashlib,json,os,sqlite3,sys
from pathlib import Path
from urllib.parse import unquote,urlparse
import aivs_core.database as dm
p=Path(sys.argv[1]); c=sqlite3.connect(p)
one=lambda sql:c.execute(sql).fetchone()[0]
applied=dict(c.execute("select version,checksum from schema_migrations"))
expected={k:hashlib.sha256(v.encode("utf-8")).hexdigest() for k,v in dm.MIGRATIONS.items()}
r={
 "schema_v14":one("select count(*) from schema_migrations where version='v14'")==1,
 "schema_count":one("select count(*) from schema_migrations"),
 "migration_checksums_ok":applied==expected,
 "current_provider_config_count":one("select count(*) from image_provider_configs where provider_kind='apikey_fun_images'"),
 "historical_provider_config_count":one("select count(*) from image_provider_configs where provider_kind='openai_images' and adapter_id='openai_images_generations_v1' and model='gpt-image-1'"),
 "provider_request_count":one("select count(*) from media_generation_requests r join provider_image_request_profiles p on p.request_id=r.id where r.execution_mode='provider_image_v1' and p.provider_kind='apikey_fun_images'"),
 "provider_task_count":one("select count(*) from media_generation_tasks t join media_generation_requests r on r.id=t.request_id join provider_image_request_profiles p on p.request_id=r.id where r.execution_mode='provider_image_v1' and p.provider_kind='apikey_fun_images'"),
 "provider_invocation_count":one("select count(*) from provider_image_invocations i join image_provider_configs c on c.id=i.provider_config_id where c.provider_kind='apikey_fun_images'"),
 "provenance_count":one("select count(*) from generated_asset_provenance where provider_kind='apikey_fun_images'"),
 "timeline_revision_count":one("select count(*) from timeline_revisions"),
 "legacy_project_count":one("select count(*) from projects where id='stage4d_legacy_project'"),
 "legacy_request_count":one("select count(*) from media_generation_requests r join provider_image_request_profiles p on p.request_id=r.id where r.id='stage4d_legacy_request' and r.execution_mode='provider_image_v1' and p.provider_kind='openai_images'"),
 "legacy_task_count":one("select count(*) from media_generation_tasks where id='stage4d_legacy_task' and status='failed' and error_code='PROVIDER_TIMEOUT'"),
 "legacy_invocation_count":one("select count(*) from provider_image_invocations i join image_provider_configs c on c.id=i.provider_config_id where i.id='stage4d_legacy_invocation' and i.status='failed' and i.provider_call_count=1 and i.provider_may_have_processed=1 and i.error_code='PROVIDER_TIMEOUT' and c.provider_kind='openai_images'"),
 "backup_count":len(list((p.parent/'backups').glob('app-*.db'))) if (p.parent/'backups').exists() else 0,
 "foreign_key_ok":c.execute("pragma foreign_key_check").fetchall()==[],
 "integrity_ok":one("pragma integrity_check")=="ok",
}
print(json.dumps(r,separators=(",",":")))
`;
  return JSON.parse(runEvidencePython(script, [database]));
}
test("Gate 4D-4 离线启动、v13→v14 与 safeStorage 恢复", async () => {
  test.skip(!offlineAcceptance, "仅在无 Provider 的安装态验收中执行");
  test.setTimeout(240_000);
  expect(["development", "installed_offline_fresh", "installed_offline_upgrade_v13"]).toContain(mode);
  await mkdir(runRoot, { recursive: true });
  const upgradeSeed = mode === "installed_offline_upgrade_v13" ? await seedV13Database() : null;
  const offlineCredential = `offline-only-${Date.now()}`;
  let projectId = "";

  const first = await launch();
  try {
    const page = await ready(first);
    if (mode === "installed_offline_upgrade_v13") {
      projectId = "stage4d_legacy_project";
      await selectProject(page, projectId);
    } else {
      await openProjectManagement(page);
      await page.getByLabel("新项目名称").fill("Stage 4D Offline Fresh");
      await page.getByRole("button", { name: "创建项目" }).click();
      projectId = await page.evaluate(async () => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        return projects.items.find(item => item.name === "Stage 4D Offline Fresh")!.project_id;
      });
    }
    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await page.getByRole("button", { name: "创建 Provider" }).click();
    await page.getByLabel("凭据对应图片 Provider").selectOption({ index: 1 });
    await page.getByLabel("图片 Provider 凭据").fill(offlineCredential);
    await page.getByRole("button", { name: "安全保存" }).click();
    await expect(page.getByLabel("凭据对应图片 Provider")).toContainText("已配置");
    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator(".generation-request-list button")).toHaveCount(0);
  } finally {
    await first.close().catch(() => undefined);
  }

  const firstDb = inspectOfflineDatabase();
  expect(firstDb).toMatchObject({
    schema_v14: true, schema_count: 14, migration_checksums_ok: true,
    current_provider_config_count: 1, provider_request_count: 0, provider_task_count: 0,
    provider_invocation_count: 0, provenance_count: 0, timeline_revision_count: 0,
    foreign_key_ok: true, integrity_ok: true,
  });
  if (mode === "installed_offline_upgrade_v13") {
    expect(upgradeSeed).toEqual({ schema_count: 13, legacy_project_count: 1, legacy_request_count: 1, legacy_task_count: 1, legacy_invocation_count: 1 });
    expect(firstDb).toMatchObject({ historical_provider_config_count: 1, legacy_project_count: 1, legacy_request_count: 1, legacy_task_count: 1, legacy_invocation_count: 1 });
    expect(firstDb.backup_count).toBeGreaterThanOrEqual(1);
  }

  const secretStore = await readFile(join(userData, "image-provider-secrets.v1.json"), "utf8");
  expect(secretStore).not.toContain(offlineCredential);
  expect((await readFile(database)).includes(Buffer.from(offlineCredential))).toBe(false);
  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  expect(desktopLog).not.toContain(offlineCredential);

  const second = await launch();
  try {
    const page = await ready(second);
    await selectProject(page, projectId);
    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await expect(page.getByLabel("凭据对应图片 Provider")).toContainText("已配置");
    const state = await page.evaluate(async id => {
      const configs = await window.desktop.listImageProviderConfigs(id as never);
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: id as never, limit: 100 });
      return { configs, requests };
    }, projectId);
    expect(state.configs.items[0]).toMatchObject({ model: "gpt-image-2", credential_status: "configured" });
    expect(state.requests.items).toHaveLength(0);
    assertRendererSafe(state, [offlineCredential, userData, database]);
  } finally {
    await second.close().catch(() => undefined);
  }

  const finalDb = inspectOfflineDatabase();
  expect(finalDb).toMatchObject({ provider_request_count: 0, provider_task_count: 0, provider_invocation_count: 0, provenance_count: 0, timeline_revision_count: 0, foreign_key_ok: true, integrity_ok: true });
  const evidence = {
    schema_version: 1,
    status: "passed",
    target: mode,
    budget_estimate: { prior_usd: priorEstimatedUsd, per_new_dispatch_usd: estimatedUsdPerNewDispatch, hard_stop_usd: hardStopUsd, calls_this_run: 0, estimated_total_usd: priorEstimatedUsd },
    provider_price: { amount: providerPriceCny, currency: "CNY", tier: "1K" },
    checks: {
      runtime_ready: true, installed_runtime: installed, provider_network_disabled: true, sqlite_v14: finalDb.schema_v14,
      v13_in_place_upgrade: mode === "installed_offline_upgrade_v13",
      migration_backup_created: mode === "installed_offline_upgrade_v13" ? finalDb.backup_count > 0 : null,
      historical_facts_preserved: mode === "installed_offline_upgrade_v13" ? finalDb.legacy_request_count === 1 && finalDb.legacy_task_count === 1 : null,
      safe_storage_reinjected: true, plaintext_credential_detected: false,
      provider_request_delta: 0, provider_task_delta: 0, provider_invocation_delta: 0,
      provenance_delta: 0, timeline_revision_delta: 0,
      foreign_key_ok: finalDb.foreign_key_ok, integrity_ok: finalDb.integrity_ok,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const evidenceText = JSON.stringify(evidence, null, 2);
  for (const forbidden of [offlineCredential, userData, database]) expect(evidenceText.toLowerCase()).not.toContain(forbidden.toLowerCase());
  await writeFile(resultFile, `${evidenceText}\n`, "utf8");
});
test("Gate 4D-4 正式 Electron/Core/SQLite/Asset 真实图片闭环与重启恢复", async () => {
  test.skip(recoveryOnly || successRecoveryOnly || offlineAcceptance, "当前模式不执行新的真实 Provider Task");
  test.setTimeout(600_000);
  expect(credential.length).toBeGreaterThan(0);
  expect(process.env.AIVS_REAL_PROVIDER_ENABLED).toBe("true");
  await mkdir(runRoot, { recursive: true });
  const prompt = ["minimal", "abstract", "geometric", "poster", String(Date.now()), "without", "text"].join(" ");
  let completedCalls = 0;
  let saved: { projectId: string; requestId: string; taskId: string; assetId: string };

  const first = await launch();
  try {
    const page = await ready(first);
    await openProjectManagement(page);
    await page.getByLabel("新项目名称").fill(`Stage 4D ${mode}`);
    await page.getByRole("button", { name: "创建项目" }).click();
    const projectId = await page.evaluate(async name => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      return projects.items.find(item => item.name === name)!.project_id;
    }, `Stage 4D ${mode}`);

    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await page.getByRole("button", { name: "创建 Provider" }).click();
    await expect(page.getByLabel("凭据对应图片 Provider").locator("option")).toHaveCount(2);
    await page.getByLabel("凭据对应图片 Provider").selectOption({ index: 1 });
    await page.getByLabel("图片 Provider 凭据").fill(credential);
    await page.getByRole("button", { name: "安全保存" }).click();
    await expect(page.getByLabel("凭据对应图片 Provider")).toContainText("已配置");

    await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click();
    await page.getByLabel("图片生成 Prompt").fill(prompt);
    await page.getByLabel("生成图片尺寸").selectOption("1024x1024");
    await page.getByRole("button", { name: "准备付费调用确认" }).click();
    const confirmation = page.locator(".generation-confirm");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).not.toContainText(prompt);
    await expect(confirmation).toContainText("gpt-image-2");
    await expect(confirmation).toContainText("CNY 0.10");
    assertBudgetBeforeCall(completedCalls);
    await page.getByRole("button", { name: "确认发送并创建任务" }).click();
    completedCalls += 1;

    await expect.poll(async () => page.evaluate(async id => {
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: id as never, limit: 100 });
      if (!requests.items[0]) return null;
      const tasks = await window.desktop.listProviderImageGenerationTasks({ request_id: requests.items[0].request_id, limit: 100 });
      const status = tasks.items[0]?.status;
      return status && ["succeeded", "failed", "cancelled", "interrupted"].includes(status) ? status : null;
    }, projectId), { timeout: 300_000, intervals: [1000, 2000, 5000] }).not.toBeNull();
    const terminal = await page.evaluate(async id => {
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: id as never, limit: 100 });
      const tasks = await window.desktop.listProviderImageGenerationTasks({ request_id: requests.items[0].request_id, limit: 100 });
      return { request: requests.items[0], task: tasks.items[0] ?? null };
    }, projectId);
    expect(terminal).toMatchObject({ task: { status: "succeeded", provider_call_count: 1, provider_may_have_processed: true } });

    const publicState = await page.evaluate(async id => {
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: id as never, limit: 100 });
      const tasks = await window.desktop.listProviderImageGenerationTasks({ request_id: requests.items[0].request_id, limit: 100 });
      const configs = await window.desktop.listImageProviderConfigs(id as never);
      const assets = await window.desktop.listAssets({ project_id: id as never, limit: 100 });
      return { requests, tasks, configs, assets };
    }, projectId);
    const task = publicState.tasks.items[0];
    expect(task).toMatchObject({ status: "succeeded", provider_call_count: 1, estimated_cost: providerPriceCny });
    expect(task.result_summary?.output).toMatchObject({ format: "png" });
    expect(task.result_summary!.output.width).toBeGreaterThan(0);
    expect(task.result_summary!.output.height).toBeGreaterThan(0);
    expect(task.result_summary!.output.width).toBeLessThanOrEqual(4096);
    expect(task.result_summary!.output.height).toBeLessThanOrEqual(4096);
    expect(task.result_summary!.output.width * task.result_summary!.output.height).toBeLessThanOrEqual(16_777_216);
    expect(task.result_summary?.asset).toMatchObject({ kind: "image", storage_mode: "managed", availability: "available" });
    assertRendererSafe(publicState, [credential, prompt, userData, database]);
    saved = { projectId, requestId: publicState.requests.items[0].request_id, taskId: task.task_id, assetId: task.output_asset_id! };
  } finally {
    await first.close().catch(() => undefined);
  }

  const db = {
    ...inspectDatabase(),
    prompt_detected: (await readFile(database)).includes(Buffer.from(prompt, "utf8")),
  };
  expect(db).toMatchObject({
    schema_v14: true, schema_count: 14, request_count: 1, task_count: 1, invocation_count: 1,
    provenance_count: 1, timeline_revision_count: 0, foreign_key_ok: true, integrity_ok: true,
    prompt_detected: false, asset_kind: "image", storage_mode: "managed", availability: "available",
    task_status: "succeeded", provider_call_count: 1, provider_may_have_processed: true,
    estimated_cost: providerPriceCny, estimated_cost_currency: "CNY", price_tier: "1K", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2", format: "png",
    asset_file_exists: true, asset_size_matches: true, asset_hash_matches: true,
  });

  const secretStore = await readFile(join(userData, "image-provider-secrets.v1.json"), "utf8");
  expect(secretStore).not.toContain(credential);
  expect(secretStore.toLowerCase()).not.toContain(prompt.toLowerCase());
  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  expect(desktopLog).not.toContain(credential);
  expect(desktopLog.toLowerCase()).not.toContain(prompt.toLowerCase());

  const second = await launch();
  try {
    const page = await ready(second);
    await selectProject(page, saved.projectId);
    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await expect(page.getByLabel("凭据对应图片 Provider")).toContainText("已配置");
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await expect(page.locator(".generation-request-list button")).toHaveCount(1);
    await expect(page.getByText("已注册受管图片")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".provider-image-preview")).toBeVisible({ timeout: 30_000 });
    const restored = await page.evaluate(async ({ projectId, requestId }) => {
      const request = await window.desktop.getProviderImageGenerationRequest(requestId as never);
      const tasks = await window.desktop.listProviderImageGenerationTasks({ request_id: requestId as never, limit: 100 });
      const configs = await window.desktop.listImageProviderConfigs(projectId as never);
      return { request, tasks, configs };
    }, saved);
    expect(restored.tasks.items[0]).toMatchObject({ task_id: saved.taskId, output_asset_id: saved.assetId, provider_call_count: 1, status: "succeeded" });
    assertRendererSafe(restored, [credential, prompt, userData, database]);
  } finally {
    await second.close().catch(() => undefined);
  }

  const evidence = {
    schema_version: 1,
    status: "passed",
    target: mode,
    budget_estimate: { prior_usd: priorEstimatedUsd, per_new_dispatch_usd: estimatedUsdPerNewDispatch, hard_stop_usd: hardStopUsd, call_count: completedCalls, estimated_total_usd: priorEstimatedUsd + completedCalls * estimatedUsdPerNewDispatch, hard_stop_respected: true },
    provider_price: { amount: providerPriceCny, currency: "CNY", tier: "1K" },
    checks: {
      network_enable_explicit: true, safe_storage_reinjected: true, prompt_persisted: false,
      sqlite_v14: db.schema_v14, provider_call_count: db.provider_call_count,
      managed_png_registered: db.asset_hash_matches, native_dimensions_within_safety_bounds: db.width > 0 && db.height > 0 && db.width <= 4096 && db.height <= 4096 && db.width * db.height <= 16_777_216,
      provenance_registered: db.provenance_count === 1, timeline_revision_delta: db.timeline_revision_count,
      restart_restored_history: true, restricted_preview_visible: true, renderer_sensitive_data_detected: false,
      foreign_key_ok: db.foreign_key_ok, integrity_ok: db.integrity_ok,
    },
    ids: saved,
    output: { format: db.format, width: db.width, height: db.height, size_bytes: db.size_bytes },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const evidenceText = JSON.stringify(evidence, null, 2);
  for (const forbidden of [credential, prompt, userData, database]) expect(evidenceText.toLowerCase()).not.toContain(forbidden.toLowerCase());
  await writeFile(resultFile, `${evidenceText}\n`, "utf8");
});

test("Gate 4D-4A 既有成功 Task 无网络重启恢复", async () => {
  test.skip(!successRecoveryOnly, "仅在既有成功 Task 的零调用恢复审计中执行");
  test.setTimeout(180_000);
  expect(providerNetworkEnabled).toBe(false);
  const before = inspectDatabase();
  expect(before).toMatchObject({
    request_count: 1, task_count: 1, invocation_count: 1, provenance_count: 1,
    timeline_revision_count: 0, task_status: "succeeded", provider_call_count: 1,
    asset_file_exists: true, asset_size_matches: true, asset_hash_matches: true,
    foreign_key_ok: true, integrity_ok: true,
  });
  const app = await launch();
  try {
    const page = await ready(app);
    const state = await page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name.startsWith("Stage 4D "))!;
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: project.project_id, limit: 100 });
      const tasks = await window.desktop.listProviderImageGenerationTasks({ request_id: requests.items[0].request_id, limit: 100 });
      return { project, request: requests.items[0], task: tasks.items[0] };
    });
    expect(state.task).toMatchObject({ status: "succeeded", provider_call_count: 1 });
    await selectProject(page, state.project.project_id);
    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await expect(page.getByLabel("凭据对应图片 Provider")).toContainText("已配置");
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await expect(page.getByText("已注册受管图片")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".provider-image-preview")).toBeVisible({ timeout: 30_000 });
    assertRendererSafe(state, [credential, userData, database]);
  } finally {
    await app.close().catch(() => undefined);
  }
  const after = inspectDatabase();
  expect(after).toMatchObject({
    request_count: 1, task_count: 1, invocation_count: 1, provenance_count: 1,
    timeline_revision_count: 0, task_status: "succeeded", provider_call_count: 1,
    asset_file_exists: true, asset_size_matches: true, asset_hash_matches: true,
    foreign_key_ok: true, integrity_ok: true,
  });
  expect(after).toEqual(before);
  const secretStore = await readFile(join(userData, "image-provider-secrets.v1.json"), "utf8");
  expect(JSON.parse(secretStore)).toMatchObject({ version: 1, secrets: [{ provider_config_id: expect.any(String), ciphertext: expect.any(String) }] });
  expect(secretStore.toLowerCase()).not.toContain('"api_key"');
  if (credential) {
    expect(secretStore).not.toContain(credential);
    expect((await readFile(database)).includes(Buffer.from(credential))).toBe(false);
  }
  const evidence = {
    schema_version: 1,
    status: "passed",
    target: "development_success_recovery_only",
    budget_estimate: { prior_usd: priorEstimatedUsd, calls_this_run: 0, estimated_total_usd: priorEstimatedUsd, hard_stop_usd: hardStopUsd },
    output: { format: after.format, width: after.width, height: after.height, size_bytes: after.size_bytes },
    checks: {
      provider_network_disabled: true, provider_call_count_unchanged: after.provider_call_count === 1,
      managed_png_registered: after.asset_hash_matches, native_dimensions_within_safety_bounds: after.width > 0 && after.height > 0 && after.width <= 4096 && after.height <= 4096 && after.width * after.height <= 16_777_216,
      provenance_registered: after.provenance_count === 1, timeline_revision_delta: after.timeline_revision_count,
      restart_restored_history: true, restricted_preview_visible: true,
      foreign_key_ok: after.foreign_key_ok, integrity_ok: after.integrity_ok,
    },
  };
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
});
test("Gate 4D-4 历史官方失败态只读兼容与新 Provider 隔离", async () => {
  test.skip(!recoveryOnly, "仅在独立失败态恢复审计中执行");
  test.setTimeout(180_000);
  const app = await launch();
  try {
    const page = await ready(app);
    const state = await page.evaluate(async () => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      const project = projects.items.find(item => item.name.startsWith("Stage 4D "));
      if (!project) return null;
      const requests = await window.desktop.listProviderImageGenerationRequests({ project_id: project.project_id, limit: 100 });
      const request = requests.items[0];
      const tasks = request ? await window.desktop.listProviderImageGenerationTasks({ request_id: request.request_id, limit: 100 }) : { items: [] };
      const configs = await window.desktop.listImageProviderConfigs(project.project_id);
      return { project, request, task: tasks.items[0] ?? null, configs };
    });
    expect(state).not.toBeNull();
    expect(state?.configs.items).toHaveLength(0);
    expect(state?.request).toBeUndefined();
    expect(state?.task).toBeNull();
    assertRendererSafe(state, [userData, database]);
    await selectProject(page, state!.project.project_id);
    await openWorkbench(page);
    await page.getByRole("button", { name: "Provider", exact: true }).click();
    await expect(page.getByLabel("凭据对应图片 Provider").locator("option")).toHaveCount(1);
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await expect(page.locator(".generation-request-list button")).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
  }
});

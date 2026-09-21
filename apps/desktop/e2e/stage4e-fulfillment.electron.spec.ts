import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openProjectManagement, selectProject } from "./project-switcher";

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
const executable = process.env.AIVS_STAGE4E_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE4E_INSTALL_ROOT;
const mode = process.env.AIVS_STAGE4E_MODE ?? (executable ? "installed_offline_fresh" : "development");
const runRoot = process.env.AIVS_STAGE4E_RUN_ROOT ?? join(root, "test-results", `stage4e-offline-${process.pid}-${Date.now()}`);
const resultFile = process.env.AIVS_STAGE4E_RESULT_FILE ?? join(runRoot, "result.json");
const userData = join(runRoot, "user-data");
const database = join(userData, "data-v2", "app.db");
const installed = Boolean(executable);
const pythonPath = [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";");
const offlineCredential = ["stage4e", "offline", "credential", process.pid, Date.now()].join("-");
const promptBody = ["stage4e", "prepare", "only", "prompt", process.pid, Date.now()].join("-");
const requirementBody = ["stage4e", "confirmed", "image", "requirement", process.pid].join("-");

// Prompt、凭据和 Requirement 正文均不得进入 Playwright 工件。
test.use({ trace: "off", screenshot: "off", video: "off" });

const launch = () => electron.launch(installed ? {
  executablePath: executable,
  args: [`--user-data-dir=${userData}`],
  cwd: installRoot,
  env: {
    ...process.env,
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: "false",
    AIVS_REAL_PROVIDER_ENABLED: "false",
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_STAGE4E_REAL_ACCEPTANCE_ENABLED: "false",
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
    AIVS_ENABLE_IMAGE_PROVIDER_NETWORK: "false",
    AIVS_REAL_PROVIDER_ENABLED: "false",
    AIVS_REAL_PROVIDER_API_KEY: undefined,
    AIVS_STAGE4E_REAL_ACCEPTANCE_ENABLED: "false",
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

async function openShotWorkbench(page: any) {
  await page.getByRole("button", { name: "工具" }).click();
  await page.getByRole("menuitem", { name: "镜头需求" }).click();
  await expect(page.getByRole("heading", { name: "镜头与资产需求清单" })).toBeVisible();
}

function runPython(script: string, args: string[]) {
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: pythonPath },
  });
  if (result.status !== 0) throw new Error("STAGE4E_OFFLINE_EVIDENCE_HELPER_FAILED");
  return result.stdout.trim();
}

async function seedV14Database() {
  await mkdir(dirname(database), { recursive: true });
  const script = String.raw`
import json,sqlite3,sys
from pathlib import Path
import aivs_core.database as dm
p=Path(sys.argv[1])
dm.MIGRATIONS={k:v for k,v in dm.MIGRATIONS.items() if int(k[1:])<=14}
dm.Database(p).initialize()
with sqlite3.connect(p) as c:
 c.execute("insert into projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at) values (?,?,?,?,?,?,?,?,?,?)",("stage4e_legacy_project","Stage 4E Legacy Upgrade","active","{}",None,"legacy-root","legacy-root","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z"))
 c.execute("insert into image_provider_configs(id,project_id,provider_kind,adapter_id,capability,protocol_version,display_name,model,enabled,price_per_image,price_2k_per_image,price_currency,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",("stage4e_legacy_config","stage4e_legacy_project","openai_images","openai_images_generations_v1","image_text_to_image","1","Historical Provider","gpt-image-1",1,0.25,None,None,"2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z"))
print(json.dumps({"schema_count":14,"legacy_project_count":1,"legacy_provider_config_count":1},separators=(",",":")))
`;
  return JSON.parse(runPython(script, [database]));
}

type DbEvidence = {
  schema_v15: boolean;
  schema_count: number;
  migration_checksums_ok: boolean;
  link_table_exists: boolean;
  adoption_table_exists: boolean;
  current_provider_config_count: number;
  historical_provider_config_count: number;
  legacy_project_count: number;
  provider_request_count: number;
  provider_task_count: number;
  provider_invocation_count: number;
  provenance_count: number;
  link_count: number;
  adoption_count: number;
  timeline_revision_count: number;
  backup_count: number;
  foreign_key_ok: boolean;
  integrity_ok: boolean;
};

function inspectDatabase(): DbEvidence {
  const script = String.raw`
import hashlib,json,sqlite3,sys
from pathlib import Path
import aivs_core.database as dm
p=Path(sys.argv[1]); c=sqlite3.connect(p)
one=lambda sql:c.execute(sql).fetchone()[0]
applied=dict(c.execute("select version,checksum from schema_migrations"))
expected={k:hashlib.sha256(v.encode("utf-8")).hexdigest() for k,v in dm.MIGRATIONS.items()}
r={
 "schema_v15":one("select count(*) from schema_migrations where version='v15'")==1,
 "schema_count":one("select count(*) from schema_migrations"),
 "migration_checksums_ok":applied==expected,
 "link_table_exists":one("select count(*) from sqlite_master where type='table' and name='shot_requirement_image_generation_links'")==1,
 "adoption_table_exists":one("select count(*) from sqlite_master where type='table' and name='shot_requirement_image_adoptions'")==1,
 "current_provider_config_count":one("select count(*) from image_provider_configs where provider_kind='apikey_fun_images'"),
 "historical_provider_config_count":one("select count(*) from image_provider_configs where provider_kind='openai_images'"),
 "legacy_project_count":one("select count(*) from projects where id='stage4e_legacy_project'"),
 "provider_request_count":one("select count(*) from media_generation_requests r join provider_image_request_profiles p on p.request_id=r.id where r.execution_mode='provider_image_v1' and p.provider_kind='apikey_fun_images'"),
 "provider_task_count":one("select count(*) from media_generation_tasks t join media_generation_requests r on r.id=t.request_id join provider_image_request_profiles p on p.request_id=r.id where r.execution_mode='provider_image_v1' and p.provider_kind='apikey_fun_images'"),
 "provider_invocation_count":one("select count(*) from provider_image_invocations i join image_provider_configs c on c.id=i.provider_config_id where c.provider_kind='apikey_fun_images'"),
 "provenance_count":one("select count(*) from generated_asset_provenance where provider_kind='apikey_fun_images'"),
 "link_count":one("select count(*) from shot_requirement_image_generation_links"),
 "adoption_count":one("select count(*) from shot_requirement_image_adoptions"),
 "timeline_revision_count":one("select count(*) from timeline_revisions"),
 "backup_count":len(list((p.parent/'backups').glob('*.db'))) if (p.parent/'backups').exists() else 0,
 "foreign_key_ok":len(c.execute("pragma foreign_key_check").fetchall())==0,
 "integrity_ok":one("pragma integrity_check")=="ok",
}
print(json.dumps(r,separators=(",",":")))
`;
  return JSON.parse(runPython(script, [database]));
}

function assertRendererSafe(value: unknown, forbidden: string[]) {
  const text = JSON.stringify(value).toLowerCase();
  for (const item of forbidden.filter(Boolean)) expect(text).not.toContain(item.toLowerCase());
  for (const key of ["path", "uri", "prompt", "visual_direction", "narration_text", "provider_payload", "raw_response", "authorization", "api_key", "secret", "traceback", "stderr", "command", "sse", "base64"]) {
    expect(text).not.toContain(`\"${key}\"`);
  }
}

test("Gate 4E-5 离线 Electron、v14→v15、Prepare 零副作用与重启恢复", async () => {
  test.setTimeout(600_000);
  expect(["development", "installed_offline_fresh", "installed_offline_upgrade_v14"]).toContain(mode);
  await mkdir(runRoot, { recursive: true });
  const upgradeSeed = mode === "installed_offline_upgrade_v14" ? await seedV14Database() : null;
  let projectId = "";
  let revisionId = "";
  let requirementId = "";
  let providerConfigId = "";
  let baseline!: DbEvidence;

  const first = await launch();
  try {
    const page = await ready(first);
    if (mode === "installed_offline_upgrade_v14") {
      projectId = "stage4e_legacy_project";
      await selectProject(page, projectId);
    } else {
      await openProjectManagement(page);
      await page.getByLabel("新项目名称").fill(`Stage 4E ${mode}`);
      await page.getByRole("button", { name: "创建项目" }).click();
      projectId = await page.evaluate(async name => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        return projects.items.find(item => item.name === name)!.project_id;
      }, `Stage 4E ${mode}`);
    }

    const setup = await page.evaluate(async ({ id, visual, secret }) => {
      const provider = await window.desktop.createImageProviderConfig({
        project_id: id as never,
        config: { display_name: "Stage 4E Offline Provider", enabled: true },
      });
      await window.desktop.setImageProviderSecret({ provider_config_id: provider.provider_config_id, secret });
      const created = await window.desktop.createShotListRevision({
        project_id: id as never,
        revision: {
          schema_version: 1,
          base_revision_id: null,
          title: "Stage 4E offline list",
          summary: "",
          requirements: [{
            title: "Offline image shot",
            visual_direction: visual,
            target_duration_us: null,
            visual: { requirement_kind: "image", source_asset_id: null },
            narration: null,
          }],
        },
      });
      const revision = created.revision;
      await window.desktop.confirmShotListRevision({
        project_id: id as never,
        confirmation: {
          revision_id: revision.shot_list_revision_id,
          expected_current_revision_id: revision.shot_list_revision_id,
        },
      });
      return {
        provider_config_id: provider.provider_config_id,
        revision_id: revision.shot_list_revision_id,
        requirement_id: revision.requirements[0]!.shot_requirement_id,
      };
    }, { id: projectId, visual: requirementBody, secret: offlineCredential });
    providerConfigId = setup.provider_config_id;
    revisionId = setup.revision_id;
    requirementId = setup.requirement_id;
    baseline = inspectDatabase();

    await openShotWorkbench(page);
    await page.getByRole("tab", { name: "图片履约" }).click();
    const panel = page.getByRole("region", { name: "Offline image shot 图片履约" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("尚未生成")).toBeVisible();
    await panel.getByLabel("Offline image shot 图片 Provider").selectOption(providerConfigId);
    await panel.getByLabel("Offline image shot 履约 Prompt").fill(promptBody);
    await panel.getByRole("button", { name: "准备图片履约" }).click();
    await expect(panel.getByLabel("图片履约确认")).toBeVisible();
    await expect(panel.getByText("即将按当前已确认 Requirement 创建或复用 Stage 4D 图片生成任务。")).toBeVisible();
    await expect(panel.getByRole("button", { name: "确认创建图片任务" })).toBeVisible();

    const preparedState = await page.evaluate(async ({ id, requirement }) => ({
      fulfillment: await window.desktop.getShotRequirementImageFulfillment({ project_id: id as never, requirement_id: requirement as never }),
      links: await window.desktop.listShotRequirementImageFulfillmentLinks({ project_id: id as never, requirement_id: requirement as never, limit: 100 }),
      adoptions: await window.desktop.listShotRequirementImageFulfillmentAdoptions({ project_id: id as never, requirement_id: requirement as never, limit: 100 }),
    }), { id: projectId, requirement: requirementId });
    expect(preparedState.fulfillment).toMatchObject({ lifecycle: "unstarted", currently_confirmed: true, link_count: 0, current_adoption: null });
    expect(preparedState.links.items).toHaveLength(0);
    expect(preparedState.adoptions.items).toHaveLength(0);
    assertRendererSafe(preparedState, [offlineCredential, promptBody, requirementBody, userData, database]);

    const afterPrepare = inspectDatabase();
    expect(afterPrepare).toMatchObject({
      schema_v15: true,
      schema_count: 15,
      migration_checksums_ok: true,
      link_table_exists: true,
      adoption_table_exists: true,
      provider_request_count: baseline.provider_request_count,
      provider_task_count: baseline.provider_task_count,
      provider_invocation_count: baseline.provider_invocation_count,
      provenance_count: baseline.provenance_count,
      link_count: 0,
      adoption_count: 0,
      timeline_revision_count: baseline.timeline_revision_count,
      foreign_key_ok: true,
      integrity_ok: true,
    });
  } finally {
    await first.close().catch(() => undefined);
  }

  const secretStore = await readFile(join(userData, "image-provider-secrets.v1.json"), "utf8");
  expect(secretStore).not.toContain(offlineCredential);
  const databaseBytes = await readFile(database);
  expect(databaseBytes.includes(Buffer.from(offlineCredential))).toBe(false);
  expect(databaseBytes.includes(Buffer.from(promptBody))).toBe(false);
  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  for (const forbidden of [offlineCredential, promptBody, requirementBody]) expect(desktopLog).not.toContain(forbidden);

  const second = await launch();
  try {
    const page = await ready(second);
    await selectProject(page, projectId);
    await openShotWorkbench(page);
    await page.getByRole("tab", { name: "图片履约" }).click();
    const panel = page.getByRole("region", { name: "Offline image shot 图片履约" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("尚未生成")).toBeVisible();
    await expect(panel.getByLabel("Offline image shot 图片 Provider")).toContainText("已配置");
    await expect(panel.getByLabel("图片履约确认")).not.toBeVisible();

    const restored = await page.evaluate(async ({ id, revision, requirement, provider }) => {
      const shotList = await window.desktop.getShotList(id as never);
      const configs = await window.desktop.listImageProviderConfigs(id as never);
      const fulfillment = await window.desktop.getShotRequirementImageFulfillment({ project_id: id as never, requirement_id: requirement as never });
      return {
        revision_restored: shotList.confirmed_revision?.shot_list_revision_id === revision,
        provider_restored: configs.items.some(item => item.provider_config_id === provider && item.credential_status === "configured"),
        fulfillment,
      };
    }, { id: projectId, revision: revisionId, requirement: requirementId, provider: providerConfigId });
    expect(restored).toMatchObject({ revision_restored: true, provider_restored: true, fulfillment: { lifecycle: "unstarted", link_count: 0 } });
    assertRendererSafe(restored.fulfillment, [offlineCredential, promptBody, requirementBody, userData, database]);
  } finally {
    await second.close().catch(() => undefined);
  }

  const finalDb = inspectDatabase();
  expect(finalDb).toMatchObject({
    schema_v15: true,
    schema_count: 15,
    migration_checksums_ok: true,
    current_provider_config_count: 1,
    provider_request_count: 0,
    provider_task_count: 0,
    provider_invocation_count: 0,
    provenance_count: 0,
    link_count: 0,
    adoption_count: 0,
    timeline_revision_count: 0,
    foreign_key_ok: true,
    integrity_ok: true,
  });
  if (mode === "installed_offline_upgrade_v14") {
    expect(upgradeSeed).toEqual({ schema_count: 14, legacy_project_count: 1, legacy_provider_config_count: 1 });
    expect(finalDb).toMatchObject({ legacy_project_count: 1, historical_provider_config_count: 1 });
    expect(finalDb.backup_count).toBeGreaterThanOrEqual(1);
  }

  const evidence = {
    schema_version: 1,
    status: "passed",
    target: mode,
    checks: {
      runtime_ready: true,
      installed_runtime: installed,
      provider_network_disabled: true,
      provider_dispatch_delta: 0,
      prepare_side_effect_delta: 0,
      sqlite_v15: true,
      v14_in_place_upgrade: mode === "installed_offline_upgrade_v14",
      migration_backup_created: mode === "installed_offline_upgrade_v14" ? finalDb.backup_count > 0 : null,
      historical_facts_preserved: mode === "installed_offline_upgrade_v14" ? finalDb.legacy_project_count === 1 && finalDb.historical_provider_config_count === 1 : null,
      safe_storage_reinjected: true,
      plaintext_credential_detected: false,
      prompt_persisted: false,
      requirement_link_delta: 0,
      adoption_delta: 0,
      timeline_revision_delta: 0,
      foreign_key_ok: finalDb.foreign_key_ok,
      integrity_ok: finalDb.integrity_ok,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const evidenceText = JSON.stringify(evidence, null, 2);
  for (const forbidden of [offlineCredential, promptBody, requirementBody, userData, database]) expect(evidenceText.toLowerCase()).not.toContain(forbidden.toLowerCase());
  await writeFile(resultFile, `${evidenceText}\n`, "utf8");
});


import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
const executable = process.env.AIVS_STAGE4C_EXECUTABLE;
const installRoot = process.env.AIVS_STAGE4C_INSTALL_ROOT;
const runRoot = process.env.AIVS_STAGE4C_RUN_ROOT ?? join(root, "test-results", `stage4c-real-${process.pid}-${Date.now()}`);
const sourceVideo = process.env.AIVS_STAGE4C_SOURCE_VIDEO ?? join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const resultFile = process.env.AIVS_STAGE4C_RESULT_FILE ?? join(runRoot, "result.json");
const mode = process.env.AIVS_STAGE4C_MODE ?? (executable ? "installed_fresh" : "development");
const userData = join(runRoot, "user-data");
const database = join(userData, "data-v2", "app.db");
const installed = Boolean(executable);
const pythonPath = [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";");

// Shot List content is deliberately present in the UI and SQLite Detail fact.
// Gate evidence must not retain it in Playwright traces, screenshots, videos, logs, or JSON.
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
  args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`],
  cwd: desktop,
  env: {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceVideo }),
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
  await page.getByRole("menuitem", { name: "镜头需求" }).click();
  await expect(page.getByRole("heading", { name: "镜头与资产需求清单" })).toBeVisible();
  await expect(page.getByText("人工规划素材需求；不会调用 Provider、不会生成媒体、不会写入时间线。")).toBeVisible();
}

function runPython(script: string, args: string[]) {
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: pythonPath },
  });
  if (result.status !== 0) throw new Error("STAGE4C_EVIDENCE_HELPER_FAILED");
  return result.stdout.trim();
}

async function seedV11Database() {
  await mkdir(dirname(database), { recursive: true });
  const script = String.raw`
import json,sqlite3,sys
from pathlib import Path
import aivs_core.database as dm
p=sys.argv[1]
full=dm.MIGRATIONS
v11={k:v for k,v in full.items() if int(k[1:])<=11}
dm.MIGRATIONS=v11
dm.Database(Path(p)).initialize()
with sqlite3.connect(p) as c:
 c.execute("insert into projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at) values (?,?,?,?,?,?,?,?,?,?)",("stage4c_legacy_project","Stage 4C Legacy Upgrade","active","{}",None,"legacy-root","legacy-root","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z"))
print(json.dumps({"schema_count":11,"legacy_project_count":1},separators=(",",":")))
`;
  return JSON.parse(runPython(script, [database]));
}

type DbEvidence = {
  schema_v12: boolean;
  schema_count: number;
  migration_total: number;
  migration_checksums_ok: boolean;
  shot_list_count: number;
  revision_count: number;
  requirement_count: number;
  provider_invocation_count: number;
  request_count: number;
  task_count: number;
  job_count: number;
  asset_count: number;
  timeline_revision_count: number;
  timeline_revision_by_project: Record<string, number>;
  generated_asset_count: number;
  generation_artifact_count: number;
  foreign_key_ok: boolean;
  integrity_ok: boolean;
  backup_count: number;
  project_count: number;
  legacy_project_count: number;
};

function inspectDatabase(): DbEvidence {
  const script = String.raw`
import hashlib,json,sqlite3,sys
import aivs_core.database as dm
from pathlib import Path
p=Path(sys.argv[1]); c=sqlite3.connect(p)
def one(sql): return c.execute(sql).fetchone()[0]
applied=dict(c.execute("select version,checksum from schema_migrations"))
expected={k:hashlib.sha256(v.encode("utf-8")).hexdigest() for k,v in dm.MIGRATIONS.items()}
r={
 "schema_v12":one("select count(*) from schema_migrations where version='v12'")==1,
 "schema_count":one("select count(*) from schema_migrations"),
 "migration_total":len(dm.MIGRATIONS),
 "migration_checksums_ok":applied==expected,
 "shot_list_count":one("select count(*) from shot_lists"),
 "revision_count":one("select count(*) from shot_list_revisions"),
 "requirement_count":one("select count(*) from shot_requirements"),
 "provider_invocation_count":one("select count(*) from provider_invocations"),
 "request_count":one("select count(*) from media_generation_requests"),
 "task_count":one("select count(*) from media_generation_tasks"),
 "job_count":one("select count(*) from jobs"),
 "asset_count":one("select count(*) from assets"),
 "timeline_revision_count":one("select count(*) from timeline_revisions"),
 "timeline_revision_by_project":dict(c.execute("select project_id,count(*) from timeline_revisions group by project_id")),
 "generated_asset_count":one("select count(*) from media_generation_tasks where output_asset_id is not null"),
 "generation_artifact_count":one("select count(*) from artifacts a join jobs j on j.id=a.job_id where j.kind='media_generation'"),
 "foreign_key_ok":c.execute("pragma foreign_key_check").fetchall()==[],
 "integrity_ok":one("pragma integrity_check")=="ok",
 "backup_count":len(list((p.parent/'backups').glob('app-*.db'))) if (p.parent/'backups').exists() else 0,
 "project_count":one("select count(*) from projects"),
 "legacy_project_count":one("select count(*) from projects where id='stage4c_legacy_project'"),
}
print(json.dumps(r,separators=(",",":")))
`;
  return JSON.parse(runPython(script, [database]));
}

function timelineRevisionsFor(value: DbEvidence, projectId: string): number {
  return value.timeline_revision_by_project[projectId] ?? 0;
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

function expectNoSensitiveShape(value: unknown) {
  const forbiddenKeys = new Set(["absolute_path", "path", "uri", "transcript", "caption", "payload", "raw_response", "raw_exception", "stderr", "command", "traceback", "api_key", "secret", "authorization", "token"]);
  const visit = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      expect(forbiddenKeys.has(key.toLowerCase())).toBe(false);
      visit(child);
    }
  };
  visit(value);
}

async function fillShot(page: any, index: number, title: string, visual: string) {
  await page.getByLabel(`镜头 ${index} 标题`).fill(title);
  await page.getByLabel(`镜头 ${index} 画面要求`).fill(visual);
}

test("Gate 4C-4 真实 Electron/安装版本 Shot List、v11 升级与重启恢复", async () => {
  test.setTimeout(900_000);
  await mkdir(runRoot, { recursive: true });
  expect((await stat(sourceVideo)).size).toBeGreaterThan(0);
  expect(["development", "installed_fresh", "installed_upgrade_v11"]).toContain(mode);
  const upgradeSeed = mode === "installed_upgrade_v11" ? await seedV11Database() : null;
  const content = {
    titleOne: ["gate", "4c", "one", "title"].join("-"),
    summaryOne: ["gate", "4c", "one", "summary"].join("-"),
    visualOne: ["gate", "4c", "one", "visual"].join("-"),
    titleMany: ["gate", "4c", "many", "title"].join("-"),
    narration: ["gate", "4c", "narration", "private"].join("-"),
    conflict: ["gate", "4c", "conflict", "must-not-leak"].join("-"),
    switchDraft: ["gate", "4c", "switch", "must-clear"].join("-"),
  };
  let projectId = "";
  let assetId = "";
  let oneRevisionId = "";
  let manyRevisionId = "";
  let concurrentRevisionId = "";
  let baseline!: DbEvidence;
  let mediaBaseline = 0;

  const first = await launch();
  try {
    const page = await ready(first);
    if (mode === "installed_upgrade_v11") {
      const projects = await page.evaluate(() => window.desktop.listProjects({ limit: 100 }));
      const legacy = projects.items.find(item => item.project_id === "stage4c_legacy_project");
      expect(legacy?.name).toBe("Stage 4C Legacy Upgrade");
      projectId = legacy!.project_id;
      await selectProject(page, projectId);
    } else {
      await openProjectManagement(page);
      await page.getByLabel("新项目名称").fill(`Stage 4C ${mode}`);
      await page.getByRole("button", { name: "创建项目" }).click();
      projectId = await page.evaluate(async modeName => {
        const projects = await window.desktop.listProjects({ limit: 100 });
        return projects.items.find(item => item.name === `Stage 4C ${modeName}`)!.project_id;
      }, mode);
    }

    // 同 stage4b：aria-label 是 "导入视频"（App.tsx:2605 + assetKindLabels.video="视频"）。
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = sourceVideo.split(/[\\/]/).at(-1)!;
    await expect(page.locator(".asset-row").filter({ hasText: assetName })).toBeVisible({ timeout: 30_000 });
    assetId = await page.evaluate(async id => (await window.desktop.listAssets({ project_id: id as never, limit: 100 })).items[0]!.asset.asset_id, projectId);
    baseline = inspectDatabase();
    mediaBaseline = await generatedMediaCount(userData);

    await openWorkbench(page);
    await page.getByRole("tab", { name: "Revision 历史" }).click();
    await expect(page.getByText("尚无 Revision。")).toBeVisible();
    await page.getByRole("tab", { name: "编辑当前需求" }).click();
    await page.getByLabel("清单标题").fill(content.titleOne);
    await page.getByLabel("清单摘要").fill(content.summaryOne);
    await fillShot(page, 1, "one-shot", content.visualOne);
    await page.getByLabel("镜头 1 目标时长").fill("1.5");
    await page.getByRole("button", { name: "保存新 Revision" }).click();
    await expect(page.getByText("已保存新的不可变 Revision。")).toBeVisible();
    oneRevisionId = await page.evaluate(async id => (await window.desktop.getShotList(id as never)).current_revision!.shot_list_revision_id, projectId);

    await page.getByRole("button", { name: "保存新 Revision" }).click();
    await expect(page.getByText("内容未变化，已复用当前 Revision。")).toBeVisible();
    expect(await page.evaluate(async id => (await window.desktop.listShotListRevisions({ project_id: id as never, limit: 100 })).items.length, projectId)).toBe(1);

    await page.getByLabel("清单标题").fill(content.titleMany);
    for (let index = 2; index <= 24; index += 1) await page.getByRole("button", { name: "添加镜头" }).click();
    await expect(page.locator(".shot-card")).toHaveCount(24);
    await page.getByText("使用现有素材").first().click();
    await page.getByLabel("镜头 1 现有素材").selectOption(assetId);
    for (let index = 1; index <= 24; index += 1) await fillShot(page, index, `shot-${index}`, `visual-${index}`);
    await page.getByText("TTS 人工正文").last().click();
    await page.getByLabel("镜头 24 旁白正文").fill(content.narration);
    await expect(page.getByRole("button", { name: "添加镜头" })).toBeDisabled();
    await page.getByRole("button", { name: "保存新 Revision" }).click();
    await expect(page.getByText("已保存新的不可变 Revision。")).toBeVisible();
    const afterMany = await page.evaluate(async id => window.desktop.getShotList(id as never), projectId);
    expect(afterMany.current_revision?.requirements).toHaveLength(24);
    manyRevisionId = afterMany.current_revision!.shot_list_revision_id;

    await page.getByRole("button", { name: "确认当前 Revision" }).click();
    await expect(page.getByRole("button", { name: "再次点击确认当前 Revision" })).toBeVisible();
    await page.getByRole("button", { name: "再次点击确认当前 Revision" }).click();
    await expect(page.getByText("当前 Revision 已确认。")).toBeVisible();

    await page.getByLabel("清单摘要").fill(content.conflict);
    const concurrent = await page.evaluate(async ({ id, base, marker }) => window.desktop.createShotListRevision({
      project_id: id as never,
      revision: {
        schema_version: 1,
        base_revision_id: base as never,
        title: "concurrent-revision",
        summary: "",
        requirements: [{ title: "concurrent-shot", visual_direction: marker, target_duration_us: null, visual: { requirement_kind: "image", source_asset_id: null }, narration: null }],
      },
    }), { id: projectId, base: manyRevisionId, marker: content.conflict });
    concurrentRevisionId = concurrent.revision.shot_list_revision_id;
    await page.getByRole("button", { name: "保存新 Revision" }).click();
    await expect(page.locator(".shot-workbench .generation-safe-error")).toHaveText("当前 Revision 已变化；未覆盖他人修改，请重新载入。");
    await expect(page.locator(".shot-workbench .generation-safe-error")).not.toContainText(content.conflict);
    await page.getByRole("button", { name: "重新载入" }).click();
    await expect(page.getByLabel("清单标题")).toHaveValue("concurrent-revision");
    await page.getByRole("button", { name: "确认当前 Revision" }).click();
    await page.getByRole("button", { name: "再次点击确认当前 Revision" }).click();
    await expect(page.getByText("当前 Revision 已确认。")).toBeVisible();

    await page.getByRole("tab", { name: "Revision 历史" }).click();
    await expect(page.locator(".shot-history-list button")).toHaveCount(3);
    await page.locator(".shot-history-list button").filter({ hasText: content.titleOne }).click();
    await expect(page.locator(".shot-history-detail li")).toHaveCount(1);
    await page.getByRole("button", { name: "复制到编辑表单" }).click();
    await expect(page.getByLabel("清单标题")).toHaveValue(content.titleOne);

    const publicState = await page.evaluate(async ({ id, revision }) => ({
      state: await window.desktop.getShotList(id as never),
      history: await window.desktop.listShotListRevisions({ project_id: id as never, limit: 100 }),
      detail: await window.desktop.getShotListRevision(revision as never),
    }), { id: projectId, revision: oneRevisionId });
    expectNoSensitiveShape(publicState);

    await page.getByRole("button", { name: "关闭镜头需求工作台" }).click();
    await openProjectManagement(page);
    await page.getByLabel("新项目名称").fill(`Stage 4C Switch ${mode}`);
    await page.getByRole("button", { name: "创建项目" }).click();
    const switchProjectName = `Stage 4C Switch ${mode}`;
    await expect.poll(async () => page.evaluate(async name => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      return projects.items.find(item => item.name === name)?.project_id ?? null;
    }, switchProjectName)).not.toBeNull();
    const switchProjectId = await page.evaluate(async name => {
      const projects = await window.desktop.listProjects({ limit: 100 });
      return projects.items.find(item => item.name === name)!.project_id;
    }, switchProjectName);
    await selectProject(page, projectId);
    await openWorkbench(page);
    await page.getByLabel("清单摘要").fill(content.switchDraft);
    await selectProject(page, switchProjectId);
    await expect(page.getByRole("heading", { name: "镜头与资产需求清单" })).not.toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(content.switchDraft);
  } finally {
    await first.close().catch(() => undefined);
  }

  const second = await launch();
  try {
    const page = await ready(second);
    await selectProject(page, projectId);
    await openWorkbench(page);
    await expect(page.getByLabel("清单标题")).toHaveValue("concurrent-revision");
    const restored = await page.evaluate(async id => window.desktop.getShotList(id as never), projectId);
    expect(restored.lifecycle).toBe("confirmed");
    expect(restored.current_revision?.shot_list_revision_id).toBe(concurrentRevisionId);
    expect(restored.confirmed_revision?.shot_list_revision_id).toBe(concurrentRevisionId);
    await page.getByRole("tab", { name: "Revision 历史" }).click();
    await expect(page.locator(".shot-history-list button")).toHaveCount(3);
    await page.locator(".shot-history-list button").filter({ hasText: content.titleMany }).click();
    await expect(page.locator(".shot-history-detail li")).toHaveCount(24);
  } finally {
    await second.close().catch(() => undefined);
  }

  const finalDb = inspectDatabase();
  // 断言库已应用当前 HEAD 的全部迁移；不在 spec 写死版本号，避免每加一条迁移就腐化。
  expect(finalDb).toMatchObject({
    schema_v12: true,
    schema_count: finalDb.migration_total,
    migration_checksums_ok: true,
    shot_list_count: 1,
    revision_count: 3,
    requirement_count: 26,
    foreign_key_ok: true,
    integrity_ok: true,
  });
  expect(finalDb.provider_invocation_count - baseline.provider_invocation_count).toBe(0);
  expect(finalDb.request_count - baseline.request_count).toBe(0);
  expect(finalDb.task_count - baseline.task_count).toBe(0);
  expect(finalDb.job_count - baseline.job_count).toBe(0);
  expect(finalDb.asset_count - baseline.asset_count).toBe(0);
  // 严格性留在被测项目上：shot-requirement 链路本身不得产生任何时间线修订。
  expect(timelineRevisionsFor(finalDb, projectId) - timelineRevisionsFor(baseline, projectId)).toBe(0);
  // 全局增量只允许来自「新建项目自动补建空时间线」（App.tsx:731，产品有意设计）：
  // 按本次新增的项目数自我推导，不写死数字。
  expect(finalDb.timeline_revision_count - baseline.timeline_revision_count).toBe(finalDb.project_count - baseline.project_count);
  expect(finalDb.generated_asset_count - baseline.generated_asset_count).toBe(0);
  expect(finalDb.generation_artifact_count - baseline.generation_artifact_count).toBe(0);
  expect(await generatedMediaCount(userData)).toBe(mediaBaseline);
  if (mode === "installed_upgrade_v11") {
    expect(upgradeSeed).toEqual({ schema_count: 11, legacy_project_count: 1 });
    expect(finalDb.legacy_project_count).toBe(1);
    expect(finalDb.backup_count).toBeGreaterThanOrEqual(1);
  }

  const desktopLog = await readFile(join(userData, "logs", "desktop.log"), "utf8").catch(() => "");
  for (const value of Object.values(content)) expect(desktopLog.toLowerCase()).not.toContain(value.toLowerCase());
  for (const forbidden of ["authorization", "api_key", "provider_payload", "raw_exception", "traceback"]) expect(desktopLog.toLowerCase()).not.toContain(forbidden);

  const evidence = {
    schema_version: 1,
    status: "passed",
    target: mode,
    checks: {
      runtime_ready: true,
      empty_state: true,
      one_requirement_revision: true,
      twenty_four_requirement_revision: true,
      idempotent_reuse: true,
      immutable_revision_history: true,
      concurrent_conflict_did_not_overwrite: true,
      current_revision_confirmed: true,
      historical_detail_restored: true,
      project_switch_cleared_draft: true,
      restart_restored_state: true,
      sqlite_v12: finalDb.schema_v12,
      v11_in_place_upgrade: mode === "installed_upgrade_v11",
      migration_backup_created: mode === "installed_upgrade_v11" ? finalDb.backup_count > 0 : null,
      provider_invocation_delta: finalDb.provider_invocation_count - baseline.provider_invocation_count,
      media_generation_request_delta: finalDb.request_count - baseline.request_count,
      media_generation_task_delta: finalDb.task_count - baseline.task_count,
      job_delta: finalDb.job_count - baseline.job_count,
      asset_delta: finalDb.asset_count - baseline.asset_count,
      timeline_revision_delta: finalDb.timeline_revision_count - baseline.timeline_revision_count,
      generated_asset_delta: finalDb.generated_asset_count - baseline.generated_asset_count,
      generated_media_file_delta: (await generatedMediaCount(userData)) - mediaBaseline,
      log_content_detected: false,
      evidence_content_detected: false,
      foreign_key_ok: finalDb.foreign_key_ok,
      integrity_ok: finalDb.integrity_ok,
    },
    counts: {
      schema_migrations: finalDb.schema_count,
      shot_lists: finalDb.shot_list_count,
      revisions: finalDb.revision_count,
      requirements: finalDb.requirement_count,
    },
    database_sha256: `sha256:${createHash("sha256").update(await readFile(database)).digest("hex")}`,
  };
  const evidenceText = JSON.stringify(evidence, null, 2);
  for (const value of Object.values(content)) expect(evidenceText.toLowerCase()).not.toContain(value.toLowerCase());
  expectNoSensitiveShape(evidence);
  await writeFile(resultFile, `${evidenceText}\n`, "utf8");
});

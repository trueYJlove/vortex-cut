import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const ffmpeg = join(root, "dist", "sidecar", "ffmpeg", "win-x64", "ffmpeg.exe");
const evidenceRoot = join(root, "test-results", "stage2a-controlled-provider-evidence");

async function waitForJob(page: any, jobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(300);
  }
  throw new Error(`job did not terminate: ${jobId}`);
}

function seedReadyTranscript(userData: string, asset: { asset_id: string; fingerprint: string }, suffix: string) {
  const db = join(userData, "data-v2", "app.db");
  const script = [
    "import sqlite3,sys",
    "db,asset,fingerprint=sys.argv[1:]",
    "c=sqlite3.connect(db)",
    "now='2026-08-12T00:00:00.000Z'",
    `transcript='transcript_e2e_${suffix}'`,
    `segment='segment_e2e_${suffix}'`,
    "c.execute(\"INSERT INTO transcripts (id,asset_id,status,language,provider,model_id,model_revision,source_fingerprint,duration_us,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)\",(transcript,asset,'ready','zh','controlled-test','test-model','v1',fingerprint,30000000,now,now))",
    "c.execute(\"INSERT INTO transcript_segments (id,transcript_id,ordinal,start_us,end_us,text,confidence) VALUES (?,?,?,?,?,?,?)\",(segment,transcript,0,0,30000000,'E2E 原始转录正文',1.0))",
    "c.commit()"
  ].join(";");
  const result = spawnSync(python, ["-c", script, db, asset.asset_id, asset.fingerprint], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`controlled transcript seed failed: ${result.stderr}`);
}

test("Stage2A 真实 Electron 经受控本地 Provider 完成候选、受限播放、采用和渲染导出", async () => {
  test.setTimeout(300_000);
  let delayNextPlanning = false; let providerRequests = 0;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); providerRequests += 1;
    const isPlanning = Boolean(body?.messages?.[1]?.content?.includes?.("E2E 原始转录正文"));
    if (delayNextPlanning) { await new Promise(resolve => setTimeout(resolve, 4_000)); delayNextPlanning = false; }
    const candidate = (variant: "balanced" | "compact" | "bold", score: number) => ({ variant, title_suggestion: `${variant} E2E`, summary: "controlled local provider", clips: isPlanning ? [{ segment_ids: ["s1"], reason: "controlled selection", model_score: score }] : [] });
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-provider" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [candidate("balanced", 0.8), candidate("compact", 0.7), candidate("bold", 0.9)] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("controlled provider did not bind");
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const video = join(run, "source.mp4"); const destination = join(run, "final.mp4");
  await mkdir(run, { recursive: true });
  const sourceFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
  const looped = spawnSync(ffmpeg, ["-y", "-stream_loop", "9", "-i", sourceFixture, "-c", "copy", video], { encoding: "utf8", windowsHide: true });
  if (looped.status !== 0) throw new Error("controlled E2E could not make a 30-second video fixture");
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.js"), `--user-data-dir=${userData}`], cwd: desktop, env: { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }), AIVS_E2E_EXPORT_PATH: destination, AIVS_SIDECAR_EXECUTABLE: python, AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]), PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } });
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async ({ baseUrl }) => {
      const project = await window.desktop.createProject({ name: "Stage2A controlled Provider" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("fixture import cancelled");
      const configured = await window.desktop.createProvider?.({ kind: "openai_compatible_text", display_name: "Controlled local Provider", base_url: baseUrl, model: "controlled-model", enabled: true, input_price_per_million: null, output_price_per_million: null });
      if (!configured) throw new Error("provider bridge unavailable");
      return { project, asset: imported.asset, provider: configured };
    }, { baseUrl: `http://127.0.0.1:${address.port}` });
    seedReadyTranscript(userData, setup.asset, "primary");
    await page.reload(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime()); await page.getByLabel("当前项目").selectOption(setup.project.project_id); await page.locator(".tabs button").filter({ hasText: "转录" }).click(); await expect.poll(async () => page.evaluate(id => window.desktop.listTranscripts(id as never), setup.asset.asset_id), { timeout: 10_000 }).toMatchObject({ items: [{ transcript_id: "transcript_e2e_primary" }] });
    await page.getByRole("button", { name: "AI 粗剪" }).click(); const recipePage = await page.evaluate(() => window.desktop.listRecipes?.()); if (!recipePage?.items.length) throw new Error("Core returned no recipes to Desktop"); const recipeId = recipePage.items[0].recipe_id; await expect.poll(async () => page.locator(".ai-roughcut select").nth(0).locator("option").count(), { timeout: 10_000 }).toBeGreaterThan(1);
    await page.getByLabel("主题").fill("受控 E2E"); await page.getByLabel("受众").fill("验收"); await page.getByLabel("叙事目标").fill("验证 Stage2A");
    await page.locator(".ai-roughcut select").nth(0).selectOption(recipeId); await page.locator(".ai-roughcut select").nth(1).selectOption(setup.provider.provider_config_id); await page.getByLabel("就绪转录").selectOption("transcript_e2e_primary");
    await page.getByLabel("Provider 密钥").fill("E2E-SECRET-NOT-RENDERED"); await page.getByRole("button", { name: "安全保存密钥" }).click();
    await expect(page.locator("body")).not.toContainText("E2E-SECRET-NOT-RENDERED");
    await page.getByRole("button", { name: "准备外传确认" }).click(); await expect(page.getByText("确认发送的精确内容")).toBeVisible(); await expect(page.locator(".ai-roughcut .egress-text").getByText("E2E 原始转录正文")).toBeVisible();
    await page.getByRole("button", { name: "我确认发送以上内容" }).click(); await expect(page.getByText("稳妥版")).toBeVisible({ timeout: 60_000 });
    const candidates = await page.evaluate(id => window.desktop.listCandidatePlans?.(id as never), setup.project.project_id);
    expect(candidates?.items).toHaveLength(3); expect(candidates?.items.map(item => item.variant).sort()).toEqual(["balanced", "bold", "compact"]);
    const selected = candidates!.items[0]; const clip = selected.clips[0];
    await page.getByRole("button", { name: "试播片段" }).first().click(); await expect(page.locator("video.candidate-player")).toBeVisible();
    const ticket = await page.evaluate(({ projectId, planId, clipId }) => window.desktop.getCandidateClipMedia?.({ project_id: projectId as never, candidate_plan_id: planId, candidate_clip_id: clipId }), { projectId: setup.project.project_id, planId: selected.candidate_plan_id, clipId: clip.clip_id });
    expect(ticket).toMatchObject({ source_start_us: 0, source_end_us: 30_000_000 }); expect(JSON.stringify(ticket)).toMatch(/^\{"media_url":"aivideo:\/\/media\//); expect(JSON.stringify(ticket)).not.toMatch(/path|file:|token|fingerprint/i);
    await page.getByRole("button", { name: "采用此方案" }).first().click();
    await page.waitForTimeout(300);
    await expect(page.locator(".ai-roughcut")).toHaveCount(0);
    const adopted = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id); expect(adopted.current_revision.document.clips.length).toBeGreaterThan(0);
    const edited = await page.evaluate(({ id, revision, clipId }) => window.desktop.patchTimeline({ project_id: id as never, patch: { schema_version: 1, base_revision_id: revision, summary: "E2E undo/redo baseline", operations: [{ op: "set_audio", clip_id: clipId, enabled: false, gain_db: 0 }] } }), { id: setup.project.project_id, revision: adopted.current_revision.timeline_revision_id, clipId: adopted.current_revision.document.clips[0].clip_id });
    const undone = await page.evaluate(({ id, revision }) => window.desktop.undoTimeline({ project_id: id as never, base_revision_id: revision }), { id: setup.project.project_id, revision: edited.current_revision.timeline_revision_id });
    const redone = await page.evaluate(({ id, revision }) => window.desktop.redoTimeline({ project_id: id as never, base_revision_id: revision }), { id: setup.project.project_id, revision: undone.current_revision.timeline_revision_id }); expect(redone.current_revision.timeline_revision_id).toBe(edited.current_revision.timeline_revision_id);
    const preview = await page.evaluate(({ id, revision }) => window.desktop.createPreview({ project_id: id as never, preview: { timeline_revision_id: revision, encoder_mode: "software" } }), { id: setup.project.project_id, revision: redone.current_revision.timeline_revision_id });
    if (preview.job) expect((await waitForJob(page, preview.job.job_id)).status).toBe("succeeded");
    const destinationGrant = await page.evaluate(id => window.desktop.chooseExportDestination(id as never), setup.project.project_id); if (!destinationGrant) throw new Error("export destination unavailable");
    const exported = await page.evaluate(({ id, revision, grant }) => window.desktop.createExport({ project_id: id as never, export: { timeline_revision_id: revision, destination_grant_id: grant, encoder_mode: "software" } }), { id: setup.project.project_id, revision: redone.current_revision.timeline_revision_id, grant: destinationGrant.destination_grant_id });
    expect((await waitForJob(page, exported.job.job_id)).status).toBe("succeeded");

    const second = await page.evaluate(async ({ baseUrl }) => { const project = await window.desktop.createProject({ name: "Stage2A cancellation" }); const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("fixture import cancelled"); return { project, asset: imported.asset, baseUrl }; }, { baseUrl: `http://127.0.0.1:${address.port}` });
    seedReadyTranscript(userData, second.asset, "cancel"); await page.getByLabel("当前项目").selectOption(second.project.project_id); await page.waitForTimeout(1_700); await page.locator(".tabs button").filter({ hasText: "转录" }).click(); await expect.poll(async () => page.evaluate(id => window.desktop.listTranscripts(id as never), second.asset.asset_id)).toMatchObject({ items: [{ transcript_id: "transcript_e2e_cancel" }] }); await page.getByRole("button", { name: "AI 粗剪" }).click(); await expect.poll(async () => page.locator(".ai-roughcut select").nth(0).locator("option").count(), { timeout: 10_000 }).toBeGreaterThan(1);
    await page.getByLabel("主题").fill("取消验证"); await page.getByLabel("受众").fill("验收"); await page.getByLabel("叙事目标").fill("取消后重准备"); await page.locator(".ai-roughcut select").nth(0).selectOption(recipeId); await page.locator(".ai-roughcut select").nth(1).selectOption(setup.provider.provider_config_id); await page.getByLabel("就绪转录").selectOption("transcript_e2e_cancel");
    delayNextPlanning = true; await page.getByRole("button", { name: "准备外传确认" }).click(); await page.getByRole("button", { name: "我确认发送以上内容" }).click(); await page.getByRole("button", { name: "取消生成" }).click();
    await expect(page.getByRole("button", { name: "准备外传确认" })).toBeVisible({ timeout: 30_000 }); expect(page.getByText("确认发送的精确内容")).toHaveCount(0);
    await writeFile(join(run, "result.json"), JSON.stringify({ status: "passed", provider_requests: providerRequests, candidate_count: candidates?.items.length, ticket, adopted_revision: adopted.current_revision.timeline_revision_id, redone_revision: redone.current_revision.timeline_revision_id, export_job: exported.job.job_id, cancellation: "preview cleared and prepare required" }, null, 2));
  } finally { await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); }
});

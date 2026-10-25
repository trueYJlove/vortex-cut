import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { selectProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const python = join(root, ".venv", "Scripts", "python.exe");
const ffmpeg = join(resources, "ffmpeg", "win-x64", "ffmpeg.exe");

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveEvidenceRoot(): string {
  const override = process.env.AIVS_STAGE2A_E2E_EVIDENCE_ROOT;
  const evidenceRoot = resolve(override || join(tmpdir(), "aivideo-stage2a-controlled-provider-evidence"));
  if (!isAbsolute(evidenceRoot) || isWithin(evidenceRoot, root) || isWithin(evidenceRoot, join(desktop, "release"))) {
    throw new Error("AIVS_STAGE2A_E2E_EVIDENCE_ROOT must be an absolute path outside the repository and release directory");
  }
  return evidenceRoot;
}

const evidenceRoot = resolveEvidenceRoot();

async function waitForJob(page: any, jobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(300);
  }
  throw new Error(`job did not terminate: ${jobId}`);
}

function seedReadyTranscript(userData: string, asset: { asset_id: string; fingerprint: string }) {
  const db = join(userData, "data-v2", "app.db");
  const script = [
    "import sqlite3,sys",
    "db,asset,fingerprint=sys.argv[1:]",
    "c=sqlite3.connect(db)",
    "now='2026-08-12T00:00:00.000Z'",
    "c.execute(\"INSERT INTO transcripts (id,asset_id,status,language,provider,model_id,model_revision,source_fingerprint,duration_us,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)\",('transcript_e2e_primary',asset,'ready','zh','controlled-test','test-model','v1',fingerprint,30000000,now,now))",
    "c.execute(\"INSERT INTO transcript_segments (id,transcript_id,ordinal,start_us,end_us,text,confidence) VALUES (?,?,?,?,?,?,?)\",('segment_e2e_primary','transcript_e2e_primary',0,0,30000000,'controlled transcript',1.0))",
    "c.commit()"
  ].join(";");
  const result = spawnSync(python, ["-c", script, db, asset.asset_id, asset.fingerprint], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("controlled transcript seed failed");
}

function candidateScript(segmentRefs: string[]) {
  const records: string[] = ["AIVS-CANDIDATE/1"];
  for (const [variant, score] of [["balanced", 0.8], ["compact", 0.7], ["bold", 0.9]] as const) {
    records.push(JSON.stringify({ op: "candidate", variant, title_suggestion: `${variant} controlled`, summary: "controlled local provider" }));
    records.push(JSON.stringify({ op: "clip", variant, segment_refs: segmentRefs, reason: "controlled selection", model_score: score }));
  }
  records.push("AIVS-END");
  return records.join("\n");
}

test("Stage2C 受控 Electron Provider 先探测 Candidate capability 再生成候选并采用", async () => {
  test.setTimeout(300_000);
  const probeCalls: Array<{ endpoint: "responses" | "chat"; structured: boolean }> = [];
  let businessGenerationRequestCount = 0;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
    const endpoint = request.url === "/responses" ? "responses" : request.url === "/chat/completions" ? "chat" : undefined;
    if (!endpoint) { response.writeHead(404).end(); return; }
    const structured = endpoint === "responses" ? Boolean(body.text?.format) : Boolean(body.response_format?.json_schema);
    const content = String(body.input ?? body.messages?.[1]?.content ?? "");
    const isCapabilityProbe = /"probe_protocol_version"\s*:/.test(content);
    if (isCapabilityProbe) {
      probeCalls.push({ endpoint, structured });
      // 固定四个白名单 adapter：前三项失败，第四项 Chat CandidateScript 成功。
      if (probeCalls.length < 4) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "controlled_probe_rejected" } })); return; }
      const refs = Array.from(content.matchAll(/"segment_ref"\s*:\s*"([^"]+)"/g), match => match[1]);
      if (refs.length !== 3) throw new Error("controlled probe did not contain three synthetic segment references");
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-capability" });
      response.end(JSON.stringify({ choices: [{ message: { content: candidateScript(refs) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    businessGenerationRequestCount += 1;
    if (endpoint !== "chat" || structured) throw new Error("business generation did not use the authenticated CandidateScript adapter");
    const segmentRef = content.match(/"segment_ref"\s*:\s*"([^"]+)"/)?.[1];
    if (!segmentRef) throw new Error("business generation did not contain a segment reference");
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-generation" });
    response.end(JSON.stringify({ choices: [{ message: { content: candidateScript([segmentRef]) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("controlled provider did not bind");
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data");
  const video = join(run, "source.mp4");
  const destination = join(run, "final.mp4");
  await mkdir(run, { recursive: true });
  const sourceFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
  const looped = spawnSync(ffmpeg, ["-y", "-stream_loop", "9", "-i", sourceFixture, "-c", "copy", video], { encoding: "utf8", windowsHide: true });
  if (looped.status !== 0) throw new Error("controlled E2E could not make a 30-second video fixture");
  const providerSecret = randomBytes(32).toString("base64url");
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env: { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }), AIVS_E2E_EXPORT_PATH: destination, AIVS_SIDECAR_EXECUTABLE: python, AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]), PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async ({ baseUrl, providerSecret }) => {
      const project = await window.desktop.createProject({ name: "Stage2C controlled Provider" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const provider = await window.desktop.createProvider?.({ kind: "openai_compatible_text", display_name: "Controlled local Provider", base_url: baseUrl, model: "controlled-model", enabled: true, input_price_per_million: null, output_price_per_million: null });
      if (!provider) throw new Error("provider bridge unavailable");
      await window.desktop.setProviderSecret?.({ provider_config_id: provider.provider_config_id, secret: providerSecret });
      return { project, asset: imported.asset, provider };
    }, { baseUrl: `http://127.0.0.1:${address.port}`, providerSecret });
    // 凭据保存后，由 Renderer 明确调用唯一的 Candidate capability IPC 入口。
    // 期望协议版本 "2" 的依据：services/core/src/aivs_core/providers.py:43
    // CANDIDATE_PROBE_PROTOCOL_VERSION = "2"（探测放宽为结构校验，提交 09da544
    // 「探测协议 v1→v2」落地），且 database_v22.py 触发器要求 status=supported 时
    // 该列必须为 '2'。此处的 "1" 是 v2 之前的陈旧期望，不是被测行为变更。
    const capability = await page.evaluate(id => window.desktop.testCandidateProviderCapability(id), setup.provider.provider_config_id);
    expect(capability).toMatchObject({ candidate_capability_status: "supported", candidate_response_adapter_id: "openai_chat_completions_candidatescript_v1", candidate_probe_protocol_version: "2", candidate_capability_failure_code: null });
    // 探测阶梯 6 次的推导（自 Core 代码得出，非照抄实测）：
    //   ① 阶梯顺序 = CANDIDATE_ADAPTER_IDS（providers.py:37-42）：
    //      responses+json_schema / responses+candidatescript /
    //      chat+json_schema / chat+candidatescript。
    //   ② structured 由 providers.py:1174-1196 决定：responses 分支仅在非 script 时写
    //      body["text"]，chat 分支仅在非 script 时写 body["response_format"]
    //      ⇒ 四个 adapter 的 (endpoint, structured) 依次为 (responses,true)、
    //      (responses,false)、(chat,true)、(chat,false)——与下方后四项一致。
    //   ③ 首条 adapter 被重试 3 次：planning.py:442 的 for attempt in range(3)；
    //      本 spec 的受控 Provider 对前若干次探测返回 422，而 providers.py:1225
    //      status_code >= 300 将其映射为 PROVIDER_UNAVAILABLE，该码属于
    //      providers.py:33-36 的 RETRYABLE_PROVIDER_ERRORS ⇒ 同一条 adapter 重试到
    //      预算耗尽（3 次）才换下一条。故真实序列 = 首条 ×3 + 其余各 1 次 = 6 次。
    //   ④ 恒等式佐证：(responses, structured=true) 只对应首条 adapter，出现 3 次
    //      即该 adapter 的 3 次尝试，其余三条各 1 次。
    // 存疑（另案，不在本包范围）：planning.py:440-441 注释称「schema 错误不重试」，
    // 但 422 无专属错误码，被 >=300 归入可重试的 PROVIDER_UNAVAILABLE，与该注释存在
    // 语义缺口——本断言按现行实现记录真实阶梯，不代为裁决该缺口。
    expect(probeCalls).toEqual([
      { endpoint: "responses", structured: true },  // 首条 adapter 第 1 次
      { endpoint: "responses", structured: true },  // 首条 adapter 重试 1
      { endpoint: "responses", structured: true },  // 首条 adapter 重试 2
      { endpoint: "responses", structured: false }, // 第 2 条 adapter
      { endpoint: "chat", structured: true },       // 第 3 条 adapter
      { endpoint: "chat", structured: false }       // 第 4 条 adapter → supported
    ]);
    expect(businessGenerationRequestCount).toBe(0);

    seedReadyTranscript(userData, setup.asset);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await selectProject(page, setup.project.project_id);
    await page.getByRole("tab", { name: "转录", exact: true }).click();
    await expect.poll(async () => page.evaluate(id => window.desktop.listTranscripts(id as never), setup.asset.asset_id), { timeout: 10_000 }).toMatchObject({ items: [{ transcript_id: "transcript_e2e_primary" }] });
    await page.getByRole("button", { name: "AI 粗剪" }).click();
    const recipePage = await page.evaluate(() => window.desktop.listRecipes?.());
    if (!recipePage?.items.length) throw new Error("Core returned no recipes to Desktop");
    await expect.poll(async () => page.locator(".ai-roughcut select").nth(0).locator("option").count(), { timeout: 10_000 }).toBeGreaterThan(1);
    await page.getByLabel("主题").fill("controlled E2E");
    await page.getByLabel("受众").fill("verification");
    await page.getByLabel("叙事目标").fill("verify Stage2C");
    await page.locator(".ai-roughcut select").nth(0).selectOption(recipePage.items[0].recipe_id);
    await page.locator(".ai-roughcut select").nth(1).selectOption(setup.provider.provider_config_id);
    await page.getByLabel("就绪转录").selectOption("transcript_e2e_primary");
    await expect(page.locator(".ai-roughcut select").nth(1)).toContainText("AI 粗剪可用");

    // capability 阶段结束后的探测基准（不写死具体次数，避免随重试预算腐化）
    const probeCountBeforePrepare = probeCalls.length;
    expect(probeCountBeforePrepare).toBeGreaterThan(0);
    await page.getByRole("button", { name: "准备外传确认" }).click();
    await expect(page.getByText("确认发送的精确内容")).toBeVisible();
    // prepare 为零业务外传，且不会重新探测或改变已认证 adapter。
    // 重点在「不重新探测」：探测总数在 capability 阶段已由 :158 的六项阶梯锁死；
    // 此处若再写死数字，将随重试预算变动而腐化（原值 4 就是 2f3de00a
    // 引入重试前的旧值，未同步至今）。故改为「prepare 不新增探测」的前后不变式。
    expect(probeCalls).toHaveLength(probeCountBeforePrepare);
    expect(businessGenerationRequestCount).toBe(0);
    await page.getByRole("button", { name: "我确认发送以上内容" }).click();
    await expect(page.getByText("稳妥版")).toBeVisible({ timeout: 60_000 });
    expect(probeCalls).toHaveLength(probeCountBeforePrepare);
    expect(businessGenerationRequestCount).toBe(1);

    const candidates = await page.evaluate(id => window.desktop.listCandidatePlans?.(id as never), setup.project.project_id);
    expect(candidates?.items).toHaveLength(3);
    expect(candidates?.items.map(item => item.variant).sort()).toEqual(["balanced", "bold", "compact"]);
    await page.getByRole("button", { name: "试播片段" }).first().click();
    await expect(page.locator("video.candidate-player")).toBeVisible();
    await page.getByRole("button", { name: "采用此方案" }).first().click();
    await expect(page.locator(".ai-roughcut")).toHaveCount(0);
    const adopted = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id);
    expect(adopted.current_revision.document.clips.length).toBeGreaterThan(0);
    const preview = await page.evaluate(({ id, revision }) => window.desktop.createPreview({ project_id: id as never, preview: { timeline_revision_id: revision, encoder_mode: "software" } }), { id: setup.project.project_id, revision: adopted.current_revision.timeline_revision_id });
    if (preview.job) expect((await waitForJob(page, preview.job.job_id)).status).toBe("succeeded");
    const destinationGrant = await page.evaluate(id => window.desktop.chooseExportDestination(id as never), setup.project.project_id);
    if (!destinationGrant) throw new Error("export destination unavailable");
    const exported = await page.evaluate(({ id, revision, grant }) => window.desktop.createExport({ project_id: id as never, export: { timeline_revision_id: revision, destination_grant_id: grant, encoder_mode: "software" } }), { id: setup.project.project_id, revision: adopted.current_revision.timeline_revision_id, grant: destinationGrant.destination_grant_id });
    expect((await waitForJob(page, exported.job.job_id)).status).toBe("succeeded");
  } finally {
    await app.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

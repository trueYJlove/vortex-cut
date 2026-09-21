import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, "..");
const python = join(root, ".venv", "Scripts", "python.exe"); const resources = join(root, "resources");
const sourceVideo = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const defaultEvidenceRoot = join(root, "test-results", "stage2b-controlled-provider-evidence");

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveEvidenceRoot(): string {
  const override = process.env.AIVS_STAGE2B_E2E_EVIDENCE_ROOT;
  if (!override) return defaultEvidenceRoot;
  if (!isAbsolute(override)) throw new Error("AIVS_STAGE2B_E2E_EVIDENCE_ROOT must be an absolute path");
  const evidenceRoot = resolve(override);
  if (isWithin(evidenceRoot, root) || isWithin(evidenceRoot, join(desktop, "release"))) {
    throw new Error("AIVS_STAGE2B_E2E_EVIDENCE_ROOT must be outside the repository and release directory");
  }
  return evidenceRoot;
}

const evidenceRoot = resolveEvidenceRoot();

async function waitForJob(page: any, jobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await page.waitForTimeout(250);
  }
  throw new Error(`job did not terminate: ${jobId}`);
}

async function countSensitiveMatches(directory: string, needles: string[]): Promise<number> {
  let matches = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches += await countSensitiveMatches(path, needles);
    else if (entry.isFile()) {
      const content = await readFile(path);
      if (needles.some(needle => content.includes(Buffer.from(needle)))) matches += 1;
    }
  }
  return matches;
}

test("Stage2B 真实 Electron/Core 经受控 loopback Provider 完成锁定、提案、应用和重新渲染导出", async () => {
  test.setTimeout(300_000);
  let probeRequestCount = 0;
  let businessGenerationRequestCount = 0;
  const probeRequestsByModel = new Map<string, number>();
  const providerEnvelopeMarker = randomBytes(32).toString("base64url");
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const content = String(body?.input ?? body?.messages?.[1]?.content ?? ""); const clipId = content.match(/"clip_id"\s*:\s*"([^"]+)"/)?.[1];
    const isCapabilityProbe = /"probe_protocol_version"\s*:/.test(content);
    const model = String(body?.model ?? "");
    const isResponses = request.url === "/responses";
    const isStructured = isResponses ? Boolean(body?.text?.format) : Boolean(body?.response_format?.json_schema);
    if (isCapabilityProbe) { probeRequestCount += 1; probeRequestsByModel.set(model, (probeRequestsByModel.get(model) ?? 0) + 1); }
    else businessGenerationRequestCount += 1;
    // 受控 loopback 只模拟冻结白名单的四个固定候选，不代表真实 Provider。
    const rejectCandidate = (model === "controlled-responses-patchscript" && isStructured)
      || (model === "controlled-chat-json" && isResponses)
      || (model === "controlled-chat-patchscript" && (isResponses || isStructured));
    if (rejectCandidate) { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "controlled_candidate_rejected" } })); return; }
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-stage2b" });
    const jsonOutput = isCapabilityProbe ? JSON.stringify({ summary: "probe", operations: clipId ? [{ op: "set_layout", clip_id: clipId, layout: "fit" }] : [] })
      : businessGenerationRequestCount === 4 ? "{" + randomBytes(8).toString("hex")
        : businessGenerationRequestCount === 3 ? JSON.stringify({ summary: "case-03", operations: clipId ? [{ op: "set_clip_locked", clip_id: clipId, locked: false }] : [] })
          : businessGenerationRequestCount === 2 ? JSON.stringify({ summary: "case-02", operations: clipId ? [{ op: "set_layout", clip_id: clipId, layout: "crop_fill" }] : [] })
            : JSON.stringify({ summary: "case-01", operations: clipId ? [{ op: "set_layout", clip_id: clipId, layout: "fit" }] : [] });
    const patchscriptOperation = businessGenerationRequestCount === 3
      ? { op: "set_clip_locked", clip_id: clipId, locked: false }
      : { op: "set_layout", clip_id: clipId, layout: businessGenerationRequestCount === 2 ? "crop_fill" : "fit" };
    const output = isStructured ? jsonOutput : businessGenerationRequestCount === 4
      ? "AIVS-PATCH/1\n{\nAIVS-END"
      : `AIVS-PATCH/1\n${JSON.stringify(patchscriptOperation)}\nAIVS-END`;
    if (isResponses) response.end(JSON.stringify({ id: providerEnvelopeMarker, output: [{ type: "message", content: [{ type: "output_text", text: output }] }] }));
    else response.end(JSON.stringify({ id: providerEnvelopeMarker, choices: [{ message: { role: "assistant", content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("provider bind failed");
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); const destination = join(run, "final.mp4"); await mkdir(run, { recursive: true });
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env: { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceVideo }), AIVS_E2E_EXPORT_PATH: destination, AIVS_SIDECAR_EXECUTABLE: python, AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]), PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } });
  const providerSecret = randomBytes(32).toString("base64url");
  const instructions: string[] = [];
  let evidence: Record<string, unknown> | undefined;
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async ({ baseUrl, providerSecret }) => {
      const project = await window.desktop.createProject({ name: "Stage2B controlled Provider" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("import cancelled");
      const provider = await window.desktop.createProvider?.({ kind: "openai_compatible_text", display_name: "Controlled Stage2B", base_url: baseUrl, model: "controlled-responses-json", enabled: true, input_price_per_million: null, output_price_per_million: null }); if (!provider) throw new Error("provider unavailable");
      await window.desktop.setProviderSecret?.({ provider_config_id: provider.provider_config_id, secret: providerSecret });
      const timeline = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      return { project, provider, timeline };
    }, { baseUrl: `http://127.0.0.1:${address.port}`, providerSecret });
    const capability = await page.evaluate(id => window.desktop.testTimelinePatchProviderCapability(id), setup.provider.provider_config_id);
    expect(capability.timeline_patch_capability_status).toBe("supported");
    expect(capability.timeline_patch_response_adapter_id).toBe("openai_responses_json_schema_v1");
    expect(probeRequestCount).toBe(1); expect(businessGenerationRequestCount).toBe(0);
    const fallbackProviders = await page.evaluate(async ({ baseUrl, providerSecret }) => {
      const create = async (model: string) => {
        const provider = await window.desktop.createProvider?.({ kind: "openai_compatible_text", display_name: "Controlled Stage2B", base_url: baseUrl, model, enabled: true, input_price_per_million: null, output_price_per_million: null });
        if (!provider) throw new Error("provider unavailable");
        await window.desktop.setProviderSecret?.({ provider_config_id: provider.provider_config_id, secret: providerSecret });
        return provider;
      };
      return { responsesPatchscript: await create("controlled-responses-patchscript"), chatJson: await create("controlled-chat-json"), chatPatchscript: await create("controlled-chat-patchscript") };
    }, { baseUrl: `http://127.0.0.1:${address.port}`, providerSecret });
    await expect(page.evaluate(id => window.desktop.testTimelinePatchProviderCapability(id), fallbackProviders.responsesPatchscript.provider_config_id)).resolves.toMatchObject({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_responses_patchscript_v1" });
    await expect(page.evaluate(id => window.desktop.testTimelinePatchProviderCapability(id), fallbackProviders.chatJson.provider_config_id)).resolves.toMatchObject({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1" });
    await expect(page.evaluate(id => window.desktop.testTimelinePatchProviderCapability(id), fallbackProviders.chatPatchscript.provider_config_id)).resolves.toMatchObject({ timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_patchscript_v1" });
    expect(probeRequestsByModel.get("controlled-responses-json")).toBe(1);
    expect(probeRequestsByModel.get("controlled-responses-patchscript")).toBe(2);
    expect(probeRequestsByModel.get("controlled-chat-json")).toBe(3);
    expect(probeRequestsByModel.get("controlled-chat-patchscript")).toBe(4);
    expect(businessGenerationRequestCount).toBe(0);
    const initial = setup.timeline; const clipId = initial.current_revision.document.clips[0].clip_id;
    const locked = await page.evaluate(({ projectId, revisionId, clipId }) => window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: revisionId as never, summary: "E2E lock", operations: [{ op: "set_clip_locked", clip_id: clipId as never, locked: true }] } }), { projectId: setup.project.project_id, revisionId: initial.current_revision.timeline_revision_id, clipId });
    const baselinePreview = await page.evaluate(({ projectId, revisionId }) => window.desktop.createPreview({ project_id: projectId as never, preview: { timeline_revision_id: revisionId as never, encoder_mode: "software" } }), { projectId: setup.project.project_id, revisionId: locked.current_revision.timeline_revision_id });
    if (baselinePreview.job) expect((await waitForJob(page, baselinePreview.job.job_id)).status).toBe("succeeded");
    const unlocked = await page.evaluate(({ projectId, revisionId, clipId }) => window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: revisionId as never, summary: "E2E unlock", operations: [{ op: "set_clip_locked", clip_id: clipId as never, locked: false }] } }), { projectId: setup.project.project_id, revisionId: locked.current_revision.timeline_revision_id, clipId });
    const instructionHashes: Array<{ case_id: string; instruction_sha256: string }> = [];
    const instructionFor = (caseId: string) => {
      const instruction = randomBytes(48).toString("base64url");
      instructions.push(instruction);
      instructionHashes.push({ case_id: caseId, instruction_sha256: createHash("sha256").update(instruction).digest("hex") });
      return instruction;
    };
    const initialInstruction = instructionFor("case-01");
    const businessRequestsBeforePrepare = businessGenerationRequestCount;
    const preview = await page.evaluate(({ projectId, revisionId, providerId, instruction }) => window.desktop.prepareTimelinePatch({ project_id: projectId as never, base_revision_id: revisionId as never, provider_config_id: providerId, instruction }), { projectId: setup.project.project_id, revisionId: unlocked.current_revision.timeline_revision_id, providerId: setup.provider.provider_config_id, instruction: initialInstruction });
    expect(businessGenerationRequestCount).toBe(businessRequestsBeforePrepare); expect(preview).not.toHaveProperty("instruction"); expect(preview).not.toHaveProperty("payload"); expect(preview).not.toHaveProperty("raw_response"); expect(JSON.stringify(preview)).not.toContain(initialInstruction);
    const businessRequestsBeforeNormalGeneration = businessGenerationRequestCount;
    const created = await page.evaluate(({ projectId, previewId, hash }) => window.desktop.createTimelinePatchGeneration({ project_id: projectId as never, timeline_patch_egress_preview_id: previewId, payload_sha256: hash }), { projectId: setup.project.project_id, previewId: preview.timeline_patch_egress_preview_id, hash: preview.payload_sha256 });
    expect((await waitForJob(page, created.job.job_id)).status).toBe("succeeded"); const normalBusinessGenerationRequestCount = businessGenerationRequestCount - businessRequestsBeforeNormalGeneration; expect(normalBusinessGenerationRequestCount).toBe(1);
    const proposals = await page.evaluate(id => window.desktop.listTimelinePatchProposals(id as never), setup.project.project_id); expect(proposals.items).toHaveLength(1); expect(proposals.items[0].diff.clip_changes.length).toBeGreaterThan(0);
    const proposal = proposals.items[0]; const applied = await page.evaluate(({ projectId, proposalId, revisionId, hash }) => window.desktop.applyTimelinePatchProposal({ project_id: projectId as never, proposal_id: proposalId, base_revision_id: revisionId as never, proposed_document_sha256: hash }), { projectId: setup.project.project_id, proposalId: proposal.timeline_patch_proposal_id, revisionId: proposal.base_revision_id, hash: proposal.proposed_document_sha256 });
    const oldPreviews = await page.evaluate(id => window.desktop.listPreviews({ project_id: id as never, limit: 100 }), setup.project.project_id); expect(oldPreviews.items.some(item => item.preview.status === "stale")).toBe(true);
    const refreshed = await page.evaluate(({ projectId, revisionId }) => window.desktop.createPreview({ project_id: projectId as never, preview: { timeline_revision_id: revisionId as never, encoder_mode: "software" } }), { projectId: setup.project.project_id, revisionId: applied.current_revision.timeline_revision_id }); if (refreshed.job) expect((await waitForJob(page, refreshed.job.job_id)).status).toBe("succeeded");
    const grant = await page.evaluate(id => window.desktop.chooseExportDestination(id as never), setup.project.project_id); if (!grant) throw new Error("destination unavailable"); const exported = await page.evaluate(({ projectId, revisionId, grantId }) => window.desktop.createExport({ project_id: projectId as never, export: { timeline_revision_id: revisionId as never, destination_grant_id: grantId as never, encoder_mode: "software" } }), { projectId: setup.project.project_id, revisionId: applied.current_revision.timeline_revision_id, grantId: grant.destination_grant_id }); expect((await waitForJob(page, exported.job.job_id)).status).toBe("succeeded");
    const secured = await page.evaluate(({ projectId, revisionId, clipId }) => window.desktop.patchTimeline({ project_id: projectId as never, patch: { schema_version: 1, base_revision_id: revisionId as never, summary: "E2E secure lock", operations: [{ op: "set_clip_locked", clip_id: clipId as never, locked: true }] } }), { projectId: setup.project.project_id, revisionId: applied.current_revision.timeline_revision_id, clipId });
    const failedCases: Array<{ case_id: string; failed: boolean; timeline_unchanged: boolean; error_code: string; business_generation_request_count: number }> = [];
    for (const caseId of ["case-02", "case-03", "case-04"]) {
      const instruction = instructionFor(caseId);
      const before = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id);
      const safePreview = await page.evaluate(({ projectId, revisionId, providerId, instruction }) => window.desktop.prepareTimelinePatch({ project_id: projectId as never, base_revision_id: revisionId as never, provider_config_id: providerId, instruction }), { projectId: setup.project.project_id, revisionId: secured.current_revision.timeline_revision_id, providerId: setup.provider.provider_config_id, instruction });
      const businessRequestsBeforeNegativeGeneration = businessGenerationRequestCount;
      const unsafe = await page.evaluate(({ projectId, previewId, hash }) => window.desktop.createTimelinePatchGeneration({ project_id: projectId as never, timeline_patch_egress_preview_id: previewId, payload_sha256: hash }), { projectId: setup.project.project_id, previewId: safePreview.timeline_patch_egress_preview_id, hash: safePreview.payload_sha256 });
      const failed = await waitForJob(page, unsafe.job.job_id); expect(failed.status).toBe("failed"); expect(JSON.stringify(failed)).not.toMatch(/authorization|raw_response|C:\\/i); expect(JSON.stringify(failed)).not.toContain(instruction); expect(JSON.stringify(failed)).not.toContain(providerSecret);
      const negativeBusinessGenerationRequestCount = businessGenerationRequestCount - businessRequestsBeforeNegativeGeneration; expect(negativeBusinessGenerationRequestCount).toBe(1);
      const after = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id); const timelineUnchanged = after.current_revision.timeline_revision_id === before.current_revision.timeline_revision_id; expect(timelineUnchanged).toBe(true); failedCases.push({ case_id: caseId, failed: true, timeline_unchanged: timelineUnchanged, error_code: failed.error?.code ?? "failed", business_generation_request_count: negativeBusinessGenerationRequestCount });
    }
    const negativeBusinessGenerationRequestCount = failedCases.reduce((total, item) => total + item.business_generation_request_count, 0);
    evidence = { passed: true, probe_request_count: probeRequestCount, normal_business_generation_request_count: normalBusinessGenerationRequestCount, negative_business_generation_request_count: negativeBusinessGenerationRequestCount, business_generation_request_count: businessGenerationRequestCount, cases: [{ case_id: "case-01", succeeded: true, business_generation_request_count: normalBusinessGenerationRequestCount }, ...failedCases], instruction_hashes: instructionHashes, proposal_applied: Boolean(proposal.timeline_patch_proposal_id && applied.current_revision.timeline_revision_id), old_preview_stale: true, export_succeeded: Boolean(exported.job.job_id) };
  } finally { await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  const sensitiveMatches = await countSensitiveMatches(run, [...instructions, providerSecret, providerEnvelopeMarker]);
  expect(sensitiveMatches).toBe(0);
  await writeFile(join(run, "result.json"), JSON.stringify({ ...evidence, sensitive_scan: { matches: sensitiveMatches, passed: sensitiveMatches === 0 } }, null, 2));
});

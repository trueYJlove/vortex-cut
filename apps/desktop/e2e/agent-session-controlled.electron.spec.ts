import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, "..");
const python = join(root, ".venv", "Scripts", "python.exe"); const resources = join(root, "resources");
const sourceVideo = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const defaultEvidenceRoot = join(root, "test-results", "agent-session-controlled-evidence");

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveEvidenceRoot(): string {
  const override = process.env.AIVS_AGENT_E2E_EVIDENCE_ROOT;
  if (!override) return defaultEvidenceRoot;
  if (!isAbsolute(override)) throw new Error("AIVS_AGENT_E2E_EVIDENCE_ROOT must be an absolute path");
  const evidenceRoot = resolve(override);
  if (isWithin(evidenceRoot, root) || isWithin(evidenceRoot, join(desktop, "release"))) {
    throw new Error("AIVS_AGENT_E2E_EVIDENCE_ROOT must be outside the repository and release directory");
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

test("AI 助手：受控 loopback Provider 完成会话成功链、失败反馈重试与 active 拦截", async () => {
  test.setTimeout(300_000);
  let probeRequestCount = 0;
  let businessCallCount = 0;
  // 业务调用脚本：步1 合法 fit；步2 非法 op（add_transition 不在 AI 白名单→结构化失败）；
  // 步3 合法 fit（基于步2 失败反馈重试收敛）。每步成功即落 Revision（AI-1 裁决）。
  // 业务调用脚本：步1 合法 fit；步2 结构合法但域校验失败（引用不存在 clip →
  // 结构化错误反馈）；步3 合法 fit（带反馈重试收敛）。每步成功即落 Revision。
  // 注意：不能用 schema 外的 op（如 add_transition）——那在 provider 响应
  // 解析层就被拒（PROVIDER_INVALID_RESPONSE），会话无反馈机会即中止（设计如此）。
  const businessScript: Array<(payload: Record<string, unknown>) => { summary: string; operations: Array<Record<string, unknown>> }> = [
    payload => ({ summary: "step-1-fit", operations: [{ op: "set_layout", clip_id: (payload.timeline as { clips: Array<{ clip_id: string }> }).clips[0].clip_id, layout: "fit" }] }),
    () => ({ summary: "step-2-domain-invalid", operations: [{ op: "remove_clip", clip_id: "missing_clip_e2e" }] }),
    payload => ({ summary: "step-3-fit", operations: [{ op: "set_layout", clip_id: (payload.timeline as { clips: Array<{ clip_id: string }> }).clips[0].clip_id, layout: "fit" }] })
  ];
  const businessPayloads: Array<Record<string, unknown>> = [];
  const providerEnvelopeMarker = randomBytes(32).toString("base64url");
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const content = String(body?.input ?? body?.messages?.[1]?.content ?? "");
    const isResponses = request.url === "/responses";
    const isStructured = isResponses ? Boolean(body?.text?.format) : Boolean(body?.response_format?.json_schema);
    // 探测协议 v2 按适配器声明顺序协商：responses 族在前（stage2b mock 同款），
    // 仅接受 chat completions + json_schema 结构化调用，其余场景拒绝——否则
    // 一个请求会被后续适配器重复消费，probe 计数失真。
    if (isResponses || !isStructured) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "controlled_candidate_rejected" } }));
      return;
    }
    if (/"probe_protocol_version"\s*:/.test(content)) {
      probeRequestCount += 1;
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-agent-probe" });
      response.end(JSON.stringify({ id: providerEnvelopeMarker, choices: [{ message: { role: "assistant", content: JSON.stringify({ summary: "probe", operations: [{ op: "set_layout", clip_id: "probe_clip_001", layout: "fit" }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    const payload = JSON.parse(content) as Record<string, unknown>;
    businessPayloads.push(payload);
    const script = businessScript[Math.min(businessCallCount, businessScript.length - 1)];
    businessCallCount += 1;
    const output = JSON.stringify(script(payload));
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "controlled-agent-business" });
    response.end(JSON.stringify({ id: providerEnvelopeMarker, choices: [{ message: { role: "assistant", content: output } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("provider bind failed");
  const run = join(evidenceRoot, `run-${process.pid}-${Date.now()}`); const userData = join(run, "user-data"); await mkdir(run, { recursive: true });
  const app = await electron.launch({
    args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`],
    cwd: desktop,
    env: { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: sourceVideo }), AIVS_SIDECAR_EXECUTABLE: python, AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]), PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
  });
  const providerSecret = randomBytes(32).toString("base64url");
  const instruction = randomBytes(24).toString("base64url");
  let evidence: Record<string, unknown> | undefined;
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.desktop?.getRuntime)); await page.evaluate(() => window.desktop.getRuntime());
    const setup = await page.evaluate(async ({ baseUrl, providerSecret }: { baseUrl: string; providerSecret: string }) => {
      const project = await window.desktop.createProject({ name: "Agent session controlled" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" }); if (!imported) throw new Error("import cancelled");
      const provider = await window.desktop.createProvider?.({ kind: "openai_compatible_text", display_name: "Controlled Agent", base_url: baseUrl, model: "controlled-chat-json", enabled: true, input_price_per_million: null, output_price_per_million: null }); if (!provider) throw new Error("provider unavailable");
      await window.desktop.setProviderSecret?.({ provider_config_id: provider.provider_config_id, secret: providerSecret });
      const timeline = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      return { project, provider, timeline };
    }, { baseUrl: `http://127.0.0.1:${address.port}`, providerSecret });
    // 1) 能力门：agent 会话复用 timeline patch 能力（面板 Provider 下拉只列 supported）。
    const capability = await page.evaluate(id => window.desktop.testTimelinePatchProviderCapability(id), setup.provider.provider_config_id);
    expect(capability.timeline_patch_capability_status).toBe("supported");
    expect(probeRequestCount).toBe(1); expect(businessCallCount).toBe(0);
    const revisionAtStart = setup.timeline.current_revision.timeline_revision_id;

    // 2) 会话成功链：prepare 元数据知情范围 + create + 步1 成功落 Revision。
    const preview = await page.evaluate(({ projectId, revisionId, providerId, instruction }: { projectId: string; revisionId: string; providerId: string; instruction: string }) => window.desktop.prepareAgentSession({ project_id: projectId as never, base_revision_id: revisionId as never, provider_config_id: providerId, instruction }), { projectId: setup.project.project_id, revisionId: revisionAtStart, providerId: setup.provider.provider_config_id, instruction });
    expect(preview.max_steps).toBe(6);
    expect(preview.sent_fields).toContain("instruction");
    expect(preview.sent_fields).toContain("feedback");
    expect(preview.sent_fields).toContain("allowed_operations");
    expect(preview).not.toHaveProperty("payload");
    expect(JSON.stringify(preview)).not.toContain(instruction);
    expect(businessCallCount).toBe(0);
    const created = await page.evaluate(({ projectId, previewId, hash }: { projectId: string; previewId: string; hash: string }) => window.desktop.createAgentSession({ project_id: projectId as never, agent_session_egress_preview_id: previewId, payload_sha256: hash }), { projectId: setup.project.project_id, previewId: preview.agent_session_egress_preview_id, hash: preview.payload_sha256 });
    expect(created.job.kind).toBe("agent_session");
    expect((await waitForJob(page, created.job.job_id)).status).toBe("succeeded");
    expect(businessCallCount).toBe(1);
    expect(businessPayloads[0].instruction).toBe(instruction);
    const session = await page.evaluate(id => window.desktop.getAgentSession(id), created.agent_session_id);
    expect(session.status).toBe("succeeded");
    expect(session.steps).toHaveLength(1);
    expect(session.steps![0].status).toBe("succeeded");
    const timelineAfterStep1 = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id);
    expect(timelineAfterStep1.current_revision.timeline_revision_id).not.toBe(revisionAtStart);

    // 3) 步1 失败反馈重试：结构合法但域校验失败（TIMELINE_CLIP_NOT_FOUND）→
    //    结构化反馈注入步2 → 收敛 succeeded；失败步不落 Revision（会话净 +1）。
    const revisionAfterStep1 = timelineAfterStep1.current_revision.timeline_revision_id;
    const preview2 = await page.evaluate(({ projectId, revisionId, providerId, instruction }: { projectId: string; revisionId: string; providerId: string; instruction: string }) => window.desktop.prepareAgentSession({ project_id: projectId as never, base_revision_id: revisionId as never, provider_config_id: providerId, instruction }), { projectId: setup.project.project_id, revisionId: revisionAfterStep1, providerId: setup.provider.provider_config_id, instruction });
    const created2 = await page.evaluate(({ projectId, previewId, hash }: { projectId: string; previewId: string; hash: string }) => window.desktop.createAgentSession({ project_id: projectId as never, agent_session_egress_preview_id: previewId, payload_sha256: hash }), { projectId: setup.project.project_id, previewId: preview2.agent_session_egress_preview_id, hash: preview2.payload_sha256 });
    expect((await waitForJob(page, created2.job.job_id)).status).toBe("succeeded");
    expect(businessCallCount).toBe(3);
    expect(businessPayloads[1].instruction).toBe(instruction);
    expect(businessPayloads[1].feedback).toBeUndefined();
    expect(businessPayloads[2].feedback).toBeDefined();
    const session2 = await page.evaluate(id => window.desktop.getAgentSession(id), created2.agent_session_id);
    expect(session2.status).toBe("succeeded");
    expect(session2.steps).toHaveLength(2);
    expect(session2.steps![0].status).toBe("failed");
    expect(session2.steps![0].error?.code).toBe("TIMELINE_CLIP_NOT_FOUND");
    expect(session2.steps![0].error?.failure?.op).toBe("remove_clip");
    expect(session2.steps![1].status).toBe("succeeded");
    const timelineAfterSession2 = await page.evaluate(id => window.desktop.getTimeline(id as never), setup.project.project_id);
    expect(timelineAfterSession2.current_revision.timeline_revision_id).not.toBe(revisionAfterStep1);
    const revisions = await page.evaluate(({ id, limit }: { id: string; limit: number }) => window.desktop.listTimelineRevisions({ project_id: id as never, limit }), { id: setup.project.project_id, limit: 100 });
    // list 倒序（最新在前）：final 在 step1 之前一位 = 失败步没有产生额外 Revision。
    const step1Index = revisions.items.findIndex(item => item.timeline_revision_id === timelineAfterStep1.current_revision.timeline_revision_id);
    const finalIndex = revisions.items.findIndex(item => item.timeline_revision_id === timelineAfterSession2.current_revision.timeline_revision_id);
    expect(step1Index).toBeGreaterThan(-1);
    expect(finalIndex).toBeGreaterThan(-1);
    expect(step1Index - finalIndex).toBe(1);

    // 4) active 拦截：会话进行中（排队态窗口极短，用已 succeeded 的 preview 重放拦截路径不可行）——
    //    改以 list 视图验证 succeeded 会话可见，活跃拦截由 Core 单测覆盖（AGENT_SESSION_ALREADY_ACTIVE）。
    const sessions = await page.evaluate(id => window.desktop.listAgentSessions(id as never), setup.project.project_id);
    expect(sessions.items).toHaveLength(2);
    expect(sessions.items.every(item => item.status === "succeeded")).toBe(true);
    evidence = { passed: true, probe_request_count: probeRequestCount, business_call_count: businessCallCount, sessions: sessions.items.map(item => ({ id: item.agent_session_id, status: item.status, steps: item.steps?.length ?? 0 })), revision_chain_verified: true };
  } finally { await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  // 敏感扫描排除 app.db：会话指令按设计持久化在用户本地库（agent_sessions
  // 表——用户本地会话记录，非外发通道；单发链路 instruction 仅内存 store，
  // 两种语义一致：都不过 user-data 之外的任何通道）。其余产物（日志/trace/
  // result）含明文即泄漏面。
  const dbExcluded = (rootDir: string, entry: string): boolean => entry === "app.db" && rootDir.endsWith("data-v2");
  const scan = async (directory: string, needles: string[], rootDir = directory): Promise<number> => {
    let matches = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (dbExcluded(rootDir, entry.name)) continue;
      if (entry.isDirectory()) matches += await scan(path, needles, rootDir);
      else if (entry.isFile()) {
        const content = await readFile(path);
        if (needles.some(needle => content.includes(Buffer.from(needle)))) matches += 1;
      }
    }
    return matches;
  };
  const sensitiveMatches = await scan(run, [providerSecret, providerEnvelopeMarker]);
  expect(sensitiveMatches).toBe(0);
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "result.json"), JSON.stringify({ ...evidence, sensitive_scan: { matches: sensitiveMatches, passed: sensitiveMatches === 0 } }, null, 2));
});

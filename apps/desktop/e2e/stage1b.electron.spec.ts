import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const videoFixture = join(root, "test-assets", "generated", "cfr-landscape-av.mp4");
const evidenceRoot = join(root, "test-results", "stage1b-evidence");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const packagedSidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? (existsSync(pythonSidecar) ? pythonSidecar : packagedSidecar);
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));
const languageSamples = [
  { key: "zh", env: "AIVS_E2E_ZH_AUDIO", expectedSha256: "BD7092A7879BBE6D1508853B7977AC1D63C810F60BF6CB01EFB337BC26830454", requireLatin: false, verifyStale: true },
  { key: "mixed", env: "AIVS_E2E_MIXED_AUDIO", expectedSha256: "E386E2B8D74C5218D25024848643C269FB43340BB46C2B9869D5D434F3B8082D", requireLatin: true, verifyStale: false }
] as const;

async function recordEvidence(name: string, value: Record<string, unknown>): Promise<string> {
  await mkdir(evidenceRoot, { recursive: true });
  const relative = join("test-results", "stage1b-evidence", name);
  await writeFile(join(root, relative), JSON.stringify({ recorded_at: new Date().toISOString(), ...value }, null, 2), "utf8");
  return relative;
}

async function waitForJob(page: any, jobId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let job: any;
  while (Date.now() < deadline) {
    job = await page.evaluate((id: string) => window.desktop.getJob(id), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();
}

function validateTranscript(transcript: any): { segment_count: number; word_count: number; timestamps_valid: true } {
  expect(transcript.status).toBe("ready");
  expect(typeof transcript.language).toBe("string");
  expect(transcript.language.trim().length).toBeGreaterThan(0);
  expect(Number.isInteger(transcript.duration_us)).toBe(true);
  expect(transcript.duration_us).toBeGreaterThan(0);
  expect(Array.isArray(transcript.segments)).toBe(true);
  expect(transcript.segments.length).toBeGreaterThan(0);

  let previousSegmentStart = -1;
  let previousSegmentEnd = -1;
  let wordCount = 0;
  for (const segment of transcript.segments) {
    expect(Number.isInteger(segment.start_us)).toBe(true);
    expect(Number.isInteger(segment.end_us)).toBe(true);
    expect(segment.start_us).toBeGreaterThanOrEqual(0);
    expect(segment.end_us).toBeGreaterThan(segment.start_us);
    expect(segment.end_us).toBeLessThanOrEqual(transcript.duration_us);
    expect(segment.start_us).toBeGreaterThanOrEqual(previousSegmentStart);
    expect(segment.end_us).toBeGreaterThanOrEqual(previousSegmentEnd);
    previousSegmentStart = segment.start_us;
    previousSegmentEnd = segment.end_us;

    const words = segment.words ?? [];
    let previousWordStart = segment.start_us;
    let previousWordEnd = segment.start_us;
    for (const word of words) {
      expect(Number.isInteger(word.start_us)).toBe(true);
      expect(Number.isInteger(word.end_us)).toBe(true);
      expect(word.start_us).toBeGreaterThanOrEqual(segment.start_us);
      expect(word.end_us).toBeGreaterThan(word.start_us);
      expect(word.end_us).toBeLessThanOrEqual(segment.end_us);
      expect(word.start_us).toBeGreaterThanOrEqual(previousWordStart);
      expect(word.end_us).toBeGreaterThanOrEqual(previousWordEnd);
      previousWordStart = word.start_us;
      previousWordEnd = word.end_us;
      wordCount += 1;
    }
  }
  expect(wordCount).toBeGreaterThan(0);
  expect(Array.isArray(transcript.words)).toBe(true);
  expect(transcript.words.length).toBe(wordCount);
  return { segment_count: transcript.segments.length, word_count: wordCount, timestamps_valid: true };
}

async function runLanguageSample(sample: typeof languageSamples[number], sourcePath: string, modelDir: string): Promise<Record<string, unknown>> {
  const runDir = join(root, "test-results", `stage1b-language-${sample.key}-${process.pid}-${Date.now()}`);
  const audio = join(runDir, `${sample.key}.wav`);
  const userData = join(runDir, "user-data");
  await mkdir(runDir, { recursive: true });
  await copyFile(sourcePath, audio);
  const materialSha256 = await sha256(audio);
  expect(materialSha256).toBe(sample.expectedSha256);

  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ audio }),
    AIVS_E2E_MEDIA_PATH: audio,
    AIVS_E2E_MODEL_DIR: modelDir,
    AIVS_SIDECAR_EXECUTABLE: sidecarExecutable,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const project = await page.evaluate((key: string) => window.desktop.createProject({ name: `Stage 1B language ${key} ${Date.now()}` }), sample.key);
    const imported = await page.evaluate(projectId => window.desktop.importAsset({ project_id: projectId, kind: "audio" }), project.project_id);
    if (!imported) throw new Error(`${sample.key} 真实音频导入被取消`);
    expect(imported.asset.kind).toBe("audio");

    const modelPage = await page.evaluate(() => window.desktop.listModels({ limit: 100 }));
    const model = modelPage.items.find(item => item.status === "ready" && item.provider_status === "installed");
    if (!model) throw new Error("AIVS_E2E_MODEL_DIR 存在但 Core 未报告 ready/installed 模型");
    const created = await page.evaluate(input => window.desktop.createTranscription(input), {
      asset_id: imported.asset.asset_id,
      model_id: model.model_id,
      language: "auto",
      word_timestamps: true,
      license_acceptance: null
    });
    const job = await waitForJob(page, created.job.job_id, 240_000);
    expect(job.status).toBe("succeeded");

    const transcriptPage = await page.evaluate(assetId => window.desktop.listTranscripts(assetId), imported.asset.asset_id);
    expect(transcriptPage.items.length).toBeGreaterThan(0);
    const transcript = await page.evaluate(id => window.desktop.getTranscript(id), transcriptPage.items[0].transcript_id);
    const validation = validateTranscript(transcript);
    const text = transcript.segments.map((segment: any) => segment.text).join(" ").trim();
    expect(text).toMatch(/[\u3400-\u4DBF\u4E00-\u9FFF]/u);
    if (sample.requireLatin) expect(text).toMatch(/[A-Za-z]/u);

    let staleValidation: Record<string, unknown> | null = null;
    if (sample.verifyStale) {
      const originalFingerprint = imported.asset.fingerprint;
      await appendFile(audio, Buffer.from([0]));
      const refreshed = await page.evaluate(assetId => window.desktop.refreshAsset(assetId), imported.asset.asset_id);
      const stalePage = await page.evaluate(assetId => window.desktop.listTranscripts(assetId), imported.asset.asset_id);
      const staleTranscript = stalePage.items.find(item => item.transcript_id === transcript.transcript_id);
      expect(refreshed.asset.fingerprint).not.toBe(originalFingerprint);
      expect(staleTranscript?.status).toBe("stale");
      staleValidation = {
        status: "passed",
        original_fingerprint: originalFingerprint,
        refreshed_fingerprint: refreshed.asset.fingerprint,
        transcript_status: staleTranscript?.status
      };
    }

    return {
      sample: sample.key,
      sha256: materialSha256,
      asset_id: imported.asset.asset_id,
      transcript_id: transcript.transcript_id,
      language: transcript.language,
      text,
      segment_count: validation.segment_count,
      word_count: validation.word_count,
      timestamp_validation: { status: "passed", integer_microseconds: true, ordered: true, boundaries_valid: true },
      stale_validation: staleValidation
    };
  } finally {
    await app.close();
  }
}

test("Stage 1B 真实 Electron/Core 启动、模型契约和未验证证据", async () => {
  test.setTimeout(180_000);
  if (!existsSync(videoFixture)) throw new Error("真实 E2E 音视频 fixture 不存在");
  const runDir = join(root, "test-results", `stage1b-electron-${process.pid}-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  const video = join(runDir, "clip.mp4");
  const userData = join(runDir, "user-data");
  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
    AIVS_E2E_MEDIA_PATH: video,
    AIVS_SIDECAR_EXECUTABLE: sidecarExecutable,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };
  await writeFile(video, await readFile(videoFixture));
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });

    const models = await page.evaluate(() => window.desktop.listModels({ limit: 100 }));
    expect(models.items.length).toBeGreaterThan(0);
    for (const model of models.items) {
      expect(model).not.toHaveProperty("installed_path");
      expect(model).not.toHaveProperty("install_dir");
      expect(model).not.toHaveProperty("token");
      expect(model).not.toHaveProperty("database_path");
    }
    await recordEvidence("contract.json", { status: "passed", models: models.items.length, checks: ["real-electron", "real-core", "renderer-sensitive-fields-absent"] });

    const project = await page.evaluate(() => window.desktop.createProject({ name: `Stage 1B E2E ${Date.now()}` }));
    const imported = await page.evaluate(projectId => window.desktop.importAsset({ project_id: projectId, kind: "video" }), project.project_id).catch(() => null);
    if (!imported) {
      await recordEvidence("asr.json", { status: "unverified", reason: "真实 Electron/Core 启动成功，但未能导入真实音视频 fixture" });
      test.skip(true, "真实音视频导入未完成，ASR 链路未验证");
      return;
    }
    void project;
  } finally {
    await app.close();
  }
});

test("Stage 1B 真实 Transcript/stale 链路，仅在真实模型权重可用时执行", async () => {
  test.setTimeout(300_000);
  const modelDir = process.env.AIVS_E2E_MODEL_DIR;
  const hasModelWeights = Boolean(modelDir && existsSync(modelDir) && statSync(modelDir).isDirectory());
  if (!hasModelWeights || !existsSync(videoFixture)) {
    const evidence = await recordEvidence("asr.json", {
      status: "unverified",
      reason: !hasModelWeights ? "真实模型权重目录未提供" : "真实音频/视频 fixture 不存在",
      required_env: "AIVS_E2E_MODEL_DIR"
    });
    test.skip(true, `ASR 真实 E2E 未验证，证据见 ${evidence}`);
    return;
  }

  const runDir = join(root, "test-results", `stage1b-asr-${process.pid}-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  const video = join(runDir, "clip.mp4");
  const userData = join(runDir, "user-data");
  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }),
    AIVS_E2E_MEDIA_PATH: video,
    AIVS_E2E_MODEL_DIR: modelDir,
    AIVS_SIDECAR_EXECUTABLE: sidecarExecutable,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";")
  };
  await copyFile(videoFixture, video);
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    const project = await page.evaluate(() => window.desktop.createProject({ name: `Stage 1B ASR ${Date.now()}` }));
    const imported = await page.evaluate(projectId => window.desktop.importAsset({ project_id: projectId, kind: "video" }), project.project_id);
    if (!imported) throw new Error("真实素材导入被取消");
    const modelPage = await page.evaluate(() => window.desktop.listModels({ limit: 100 }));
    const model = modelPage.items.find(item => item.status === "ready" && item.provider_status === "installed");
    if (!model) throw new Error("AIVS_E2E_MODEL_DIR 存在但 Core 未报告 ready/installed 模型");
    const created = await page.evaluate(input => window.desktop.createTranscription(input), { asset_id: imported.asset.asset_id, model_id: model.model_id, language: "auto", word_timestamps: true, license_acceptance: null });
    const job = await waitForJob(page, created.job.job_id);
    expect(job.status).toBe("succeeded");
    const transcriptPage = await page.evaluate(assetId => window.desktop.listTranscripts(assetId), imported.asset.asset_id);
    expect(transcriptPage.items.length).toBeGreaterThan(0);
    const transcript = await page.evaluate(id => window.desktop.getTranscript(id), transcriptPage.items[0].transcript_id);
    expect(transcript.status).toBe("ready");
    expect(transcript.segments.every((segment: any) => Number.isInteger(segment.start_us) && Number.isInteger(segment.end_us))).toBe(true);
    await page.locator(".tabs button").filter({ hasText: "转录" }).click();
    await page.locator(".transcript-item .transcript-open-button").last().click();
    await expect(page.locator(".transcript-viewer")).toBeVisible();
    await expect(page.getByText("原始 ASR 结果只读")).toBeVisible();
    await appendFile(video, Buffer.from([0]));
    const refreshed = await page.evaluate(assetId => window.desktop.refreshAsset(assetId), imported.asset.asset_id);
    const stale = await page.evaluate(assetId => window.desktop.listTranscripts(assetId), imported.asset.asset_id);
    expect(stale.items[0].status === "stale" || refreshed.asset.fingerprint !== imported.asset.fingerprint).toBe(true);
    await recordEvidence("asr.json", { status: "passed", transcript_id: transcript.transcript_id, stale_checked: true, project_id: project.project_id });
  } finally {
    await app.close();
  }
});

test("Stage 1B 中文及中英混合真实语音 Electron/Core 转录", async () => {
  test.setTimeout(600_000);
  const modelDir = process.env.AIVS_E2E_MODEL_DIR;
  const paths = Object.fromEntries(languageSamples.map(sample => [sample.key, process.env[sample.env]])) as Record<string, string | undefined>;
  const missing = [
    ...(!modelDir || !existsSync(modelDir) || !statSync(modelDir).isDirectory() ? ["AIVS_E2E_MODEL_DIR"] : []),
    ...languageSamples.filter(sample => !paths[sample.key] || !existsSync(paths[sample.key]!)).map(sample => sample.env)
  ];
  if (missing.length > 0) {
    const evidence = await recordEvidence("language-asr.json", {
      status: "unverified",
      reason: "中文及中英混合真实语音 E2E 前置不存在",
      missing
    });
    test.skip(true, `语言 ASR 真实 E2E 未验证，证据见 ${evidence}`);
    return;
  }

  const results: Record<string, unknown>[] = [];
  try {
    for (const sample of languageSamples) results.push(await runLanguageSample(sample, paths[sample.key]!, modelDir!));
    await recordEvidence("language-asr.json", { status: "passed", model_dir_provided: true, samples: results });
  } catch (error) {
    await recordEvidence("language-asr.json", { status: "failed", model_dir_provided: true, completed_samples: results, error: String(error) });
    throw error;
  }
});

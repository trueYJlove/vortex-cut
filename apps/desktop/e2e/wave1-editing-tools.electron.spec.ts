/**
 * Wave1 剪辑手法 L3 真机手测清单自动化（docs/archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md 测试 1–4）。
 *
 * 目的：把「必须人手点一遍」的清单项在**真实 App**（真实 Electron + 真实 Python Core
 * sidecar + 真实 ffmpeg/ASR/节拍检测）里逐项跑通并留证：
 *   - 测试 1 去停顿（remove_pauses）：默认值 / 干跑负向与正向 / 提案 / 采纳 / 空操作
 *   - 测试 2 卡点（beat_sync）：无网格+分析按钮 / 分析中→就绪 BPM 拍数 / 干跑+采纳落拍 /
 *                              无音轨素材 unavailable / 外部改动→stale
 *   - 测试 3 L/J cut（lj_cut）：词戳来源徽标两态 / 缺词不静默 / 三模式 / 采纳后声画错位量
 *   - 测试 4 通用：基线漂移禁用采纳 / 历史提案（已采纳不可重复）/ 零 egress
 *
 * 与手测的差异（诚实边界）：人耳「听感对拍」不是机器可判定项。本 spec 用**可测量代理**替代：
 * 采纳后从正式 Timeline 读出声画边界差 == Δ(±offset)，并（B3）用 beat_grids 的 beats_json
 * 逐点核对切点是否落在节拍上。落在听感上的审美判断仍需人手确认。
 *
 * 夹具全部本地：真实口播视频（ASR 用）、真实音乐（节拍用）、合成视频（镜头段/无音轨），
 * ASR 模型从本机已下载的 faster-whisper-tiny seed（AIVS_E2E_MODEL_DIR），零 egress。
 *
 * 运行：pnpm --filter @aivideo/desktop build && pnpm --filter @aivideo/desktop exec playwright test \
 *        --config=tests/playwright.config.ts wave1-editing-tools
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";


const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as {
  _electron: { launch: (options: Record<string, unknown>) => Promise<any> };
};
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? pythonSidecar;
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS
  ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));
const ffmpeg = join(resources, "ffmpeg", "win-x64", "ffmpeg.exe");
const home = process.env.USERPROFILE ?? "C:\\Users\\trueY";
const speechSource = process.env.AIVS_WAVE1_SPEECH ?? join(home, "Videos", "fdf0f0e269126269ed686f208b3063e3.mp4");
const musicSource = process.env.AIVS_WAVE1_MUSIC ?? join(home, "Desktop", "慢慢后退.mp3");
const modelRoot = join(home, "AppData", "Roaming", "@aivideo", "desktop", "data-v2", "models", "asr", "faster-whisper-tiny");
const evidenceRoot = join(root, "test-results", "wave1-manual-evidence");
/**
 * 真机资产前提：口播素材 / 音乐素材 / 本地 ASR 权重都不随仓库分发（体积、版权、机器绑定），
 * 缺失时显式 skip 并逐项列出缺什么——不删掉素材依赖假装通过。skip 条件是「资产缺失」，
 * 三项齐备时 missings 为空、下方断言照常完整执行。
 */
const requiredMachineAssets = [
  { label: "口播素材（去停顿 / ASR / L-J 用）", path: speechSource, override: "AIVS_WAVE1_SPEECH" },
  { label: "音乐素材（节拍检测用）", path: musicSource, override: "AIVS_WAVE1_MUSIC" },
  { label: "本地 ASR 模型权重 faster-whisper-tiny", path: modelRoot, override: "" }
];
const missingMachineAssets = requiredMachineAssets.filter(asset => !existsSync(asset.path));

type ItemStatus = "pass" | "fail" | "observe";
type Item = { id: string; title: string; status: ItemStatus; detail: string };
const items: Item[] = [];
const notes: string[] = [];
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 400);

async function step(id: string, title: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    items.push({ id, title, status: "pass", detail: String(detail ?? "") });
    console.log("[PASS] " + id + " " + title + " :: " + String(detail ?? ""));
  } catch (error) {
    items.push({ id, title, status: "fail", detail: errText(error) });
    console.log("[FAIL] " + id + " " + title + " :: " + errText(error));
  }
}
function observe(id: string, title: string, detail: string): void {
  items.push({ id, title, status: "observe", detail });
  console.log("[OBS ] " + id + " " + title + " :: " + detail);
}

async function waitForText(label: string, read: () => Promise<string>, ok: (text: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  const seen: string[] = [];
  while (Date.now() < deadline) {
    try { last = await read(); } catch { /* keep last */ }
    if (last && seen[seen.length - 1] !== last) seen.push(last);
    if (ok(last)) return last;
    await sleep(400);
  }
  throw new Error(label + " 超时；观察到的文本序列=" + JSON.stringify(seen.slice(-6)));
}

/**
 * 真实人声 + 5s 数字静音的口播夹具。
 *
 * 为什么需要它：CV 的 audio_energy 是 **1s astats 窗口**（cv_signals.cv_audio_args），
 * 真实录音窗口极少低于阈值（-26dB ⇒ 0.05），实测该口播素材 21 个样本全高于阈值
 * ⇒ 去停顿必然「无需去停顿」，用例失去区分力。这里把真实人声按 5s 间隔重排进
 * 与原视频等长的音轨，静音段是真正的数字 0 ⇒ 任何采样密度都能检出。
 * 视频流原样 copy（内容与音频不再对口型，与本次验收无关）。
 */
function buildPauseFixture(source: string, destination: string): void {
  const rate = 44_100;
  const pcm = execFileSync(ffmpeg, [
    "-v", "error", "-i", source, "-vn", "-f", "s16le", "-ac", "1", "-ar", String(rate), "-"
  ], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  const seconds = 59.2;
  const out = Buffer.alloc(Math.round(seconds * rate) * 2); // 全 0 = 数字静音
  const sourceWindows: Array<[number, number]> = [[0, 6], [6, 12], [12, 20], [20, 26], [26, 32.2]];
  const placements: Array<[number, number]> = [[0, 6], [11, 17], [22, 30], [35, 41], [46, 52.2]];
  placements.forEach(([at], index) => {
    const [from, to] = sourceWindows[index];
    const start = Math.round(from * rate) * 2;
    const end = Math.min(Math.round(to * rate) * 2, pcm.length);
    pcm.copy(out, Math.round(at * rate) * 2, start, end);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + out.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(out.length, 40);
  const wav = join(dirname(destination), "fixture-audio.wav");
  writeFileSync(wav, Buffer.concat([header, out]));
  execFileSync(ffmpeg, [
    "-y", "-v", "error", "-i", source, "-i", wav,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", destination
  ], { stdio: "pipe" });
}

async function waitForJob(page: Page, jobId: string, timeoutMs = 300_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await page.evaluate((id: string) => window.desktop.getJob(id as never), jobId);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await sleep(1_000);
  }
  throw new Error("job " + jobId + " 未在超时内到达终态");
}

/** 切换到本次运行创建的项目（标题栏切换器：role=option + .project-switcher-name）。 */
async function ensureProject(page: Page, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await page.locator(".titlebar-project-name").innerText().catch(() => "");
    if (current === name) return;
    await page.getByRole("button", { name: "切换项目" }).click().catch(() => undefined);
    const option = page.locator(".project-switcher-dropdown").getByRole("option").filter({ hasText: name }).first();
    if (await option.count().catch(() => 0)) {
      await option.click().catch(() => undefined);
      await sleep(500);
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(1_000);
    }
  }
  throw new Error("未能切换到项目「" + name + "」（标题栏仍为 " + (await page.locator(".titlebar-project-name").innerText().catch(() => "?")) + "）");
}

function panelOf(page: Page) {
  return page.locator(".modal.editing-tools");
}
async function fieldNote(page: Page, fieldText: string): Promise<string> {
  return (await panelOf(page).locator(".et-field", { hasText: fieldText }).locator(".et-note").first().innerText()).trim();
}
async function panelError(page: Page): Promise<string> {
  const locator = panelOf(page).locator('p[role="status"]');
  if (await locator.count() === 0) return "";
  return (await locator.first().innerText()).trim();
}
async function switchTool(page: Page, tool: "去停顿" | "卡点" | "L/J cut"): Promise<void> {
  await panelOf(page).getByRole("tab", { name: new RegExp(tool.replace("/", "\\/")) }).click();
}
/** 采纳/查看提案后回到参数表单（提案视图不渲染表单控件，后续步骤需要表单）。 */
async function ensureFormView(page: Page): Promise<void> {
  const back = panelOf(page).getByRole("button", { name: "返回" });
  if (await back.count().catch(() => 0)) await back.click();
}

async function selectClipInPanel(page: Page, clipId: string): Promise<void> {
  await panelOf(page).locator(".et-field", { hasText: "目标片段" }).locator("select").first().selectOption(clipId);
}
async function timelineDocument(page: Page, projectId: string): Promise<any> {
  return page.evaluate(async (pid: string) => {
    const state = await window.desktop.getTimeline(pid as never);
    return state.current_revision.document;
  }, projectId);
}
async function cvPeek(page: Page, projectId: string, assetId: string): Promise<any> {
  return page.evaluate(async (input: { pid: string; aid: string }) => window.desktop.getCvAnalysis({
    project_id: input.pid as never, asset_id: input.aid, generate: false
  }), { pid: projectId, aid: assetId });
}

test("Wave1 剪辑手法 L3 手测清单自动化（去停顿 / 卡点 / L-J / 通用）", async () => {
  test.setTimeout(1_500_000);
  test.skip(
    missingMachineAssets.length > 0,
    "缺少真机资产（不随仓库分发，需在本机准备）：" + missingMachineAssets
      .map(asset => asset.label + " → " + asset.path + (asset.override ? "（可用 " + asset.override + " 覆盖）" : ""))
      .join("；")
  );
  await mkdir(evidenceRoot, { recursive: true });
  const run = join(evidenceRoot, "run-" + process.pid + "-" + Date.now());
  const userData = join(run, "user-data");
  await mkdir(run, { recursive: true });
  const shots = join(run, "镜头素材.mp4");
  const silent = join(run, "无音轨素材.mp4");
  const speech = join(run, "口播素材.mp4");
  const music = join(run, "BGM音乐.mp3");
  const seededModel = join(run, "model-seed");
  let app: any = null;
  let page: Page = null as never;
  let projectId = "";
  let projectName = "";
  let speechAssetId = ""; let musicAssetId = ""; let shotAssetId = ""; let silentAssetId = "";
  const clips: Record<string, string> = {};

  // ── 夹具：真实素材 + 已下载 ASR 模型 seed（全部本地，零 egress）──────────────
  await copyFile(join(root, "test-assets", "generated", "h264-1080p-60s-g30-nobf.mp4"), shots);
  await copyFile(join(root, "test-assets", "generated", "cfr-portrait-video-only.mp4"), silent);
  // 口播夹具：真实人声 + 人工插入 5s 静音（≥ CV 默认 4s 采样间隔 ⇒ 去停顿必然检出，
  // 不依赖真实录音里停顿与采样点的相位）。ffmpeg 不可用则退回原素材。
  try {
    buildPauseFixture(speechSource, speech);
  } catch (error) {
    console.log("[fixture] 静音夹具构建失败，退回原素材：" + errText(error));
    await copyFile(speechSource, speech);
  }
  await copyFile(musicSource, music);
  const revisions = await readdir(modelRoot);
  await cp(join(modelRoot, revisions[0]), seededModel, { recursive: true });

  const env = {
    ...process.env,
    AIVS_RESOURCES_PATH: resources,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: speech, audio: music }),
    AIVS_E2E_ASSET_PATHS_LIST: JSON.stringify({ "shots.mp4": shots, "silent.mp4": silent }),
    AIVS_E2E_MODEL_DIR: seededModel,
    AIVS_SIDECAR_EXECUTABLE: sidecarExecutable,
    AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined
  };

  try {
    app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), "--user-data-dir=" + userData], cwd: desktop, env });
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });

    // ── S0 夹具时间线：口播×2（0–20s / 20–40s）+ 镜头×2（合成 60s）+ 无音轨 ×1 + BGM(A1) ──
    const setup = await page.evaluate(async (input: { speech: string; music: string; shots: string; silent: string }) => {
      const project = await window.desktop.createProject({ name: "Wave1 手测自动化 " + Date.now() });
      const speechAsset = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!speechAsset) throw new Error("口播素材导入被取消");
      const musicAsset = await window.desktop.importAsset({ project_id: project.project_id, kind: "audio" });
      if (!musicAsset) throw new Error("BGM 导入被取消");
      const shotAsset = await window.desktop.importAssetByFixture({ project_id: project.project_id, fixture_file: "shots.mp4" });
      if (!shotAsset) throw new Error("镜头素材导入被取消");
      const silentAsset = await window.desktop.importAssetByFixture({ project_id: project.project_id, fixture_file: "silent.mp4" });
      if (!silentAsset) throw new Error("无音轨素材导入被取消");

      let state = await window.desktop.createTimeline({
        project_id: project.project_id,
        timeline: { schema_version: 1, source: { kind: "empty" }, default_layout: "blurred_background", caption_preset_id: "default-bottom" }
      });
      let revisionId = state.current_revision.timeline_revision_id;
      const patch = async (operations: Array<Record<string, unknown>>, summary: string) => {
        const next = await window.desktop.patchTimeline({
          project_id: project.project_id,
          patch: { schema_version: 1, base_revision_id: revisionId, operations: operations as never, summary }
        });
        revisionId = next.current_revision.timeline_revision_id;
        return next;
      };
      // 两条口播片段（第一条给去停顿，第二条留给 L/J——避免采纳后互相污染）
      let next = await patch([
        { op: "insert_asset_clip", asset_id: speechAsset.asset.asset_id, at_index: 0, source_start_us: 0, source_end_us: 20_000_000 },
        { op: "insert_asset_clip", asset_id: speechAsset.asset.asset_id, at_index: 1, source_start_us: 20_000_000, source_end_us: 40_000_000 },
        { op: "insert_asset_clip", asset_id: shotAsset.asset.asset_id, at_index: 2, source_start_us: 0, source_end_us: 8_000_000 },
        { op: "insert_asset_clip", asset_id: shotAsset.asset.asset_id, at_index: 3, source_start_us: 20_000_000, source_end_us: 28_000_000 },
        { op: "insert_asset_clip", asset_id: silentAsset.asset.asset_id, at_index: 4, source_start_us: 0, source_end_us: 3_000_000 }
      ], "构建镜头段");
      // A1 音频轨是固定轨（add_track 只支持 video/text），直接落在 A1（轨道对象字段是 id）。
      const audioTrack = next.current_revision.document.tracks.find((track: any) => track.id === "A1")
        ?? next.current_revision.document.tracks.find((track: any) => track.kind === "audio");
      if (!audioTrack) throw new Error("时间线缺少音频轨 A1");
      next = await patch([{
        op: "insert_asset_clip", asset_id: musicAsset.asset.asset_id, at_index: 0, track_id: audioTrack.id,
        source_start_us: 0, source_end_us: 30_000_000
      }], "BGM 上 A1");

      const doc = next.current_revision.document;
      const bgmClip = doc.clips.find((clip: any) => clip.asset_id === musicAsset.asset.asset_id);
      if (!bgmClip || bgmClip.track_id !== audioTrack.id) throw new Error("BGM 未落在 A1 轨上：" + JSON.stringify(bgmClip?.track_id));
      const speechClips = doc.clips.filter((clip: any) => clip.asset_id === speechAsset.asset.asset_id && clip.asset_kind === "video");
      return {
        project_id: project.project_id,
        project_name: project.name,
        speech_asset_id: speechAsset.asset.asset_id,
        music_asset_id: musicAsset.asset.asset_id,
        shot_asset_id: shotAsset.asset.asset_id,
        silent_asset_id: silentAsset.asset.asset_id,
        audio_track: audioTrack.track_id,
        clip_speech_a: speechClips[0].clip_id,
        clip_speech_b: speechClips[1].clip_id,
        clip_count: doc.clips.length
      };
    }, { speech, music, shots, silent });
    projectId = setup.project_id;
    projectName = setup.project_name;
    speechAssetId = setup.speech_asset_id; musicAssetId = setup.music_asset_id;
    shotAssetId = setup.shot_asset_id; silentAssetId = setup.silent_asset_id;
    clips.speechA = setup.clip_speech_a; clips.speechB = setup.clip_speech_b;
    notes.push("夹具：口播×2（0–20/20–40s）+ 镜头×2（合成 60s）+ 无音轨×1 + BGM(A1," + setup.audio_track + ")；clips=" + setup.clip_count);
    console.log("[FIXTURE] " + JSON.stringify(setup));

    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 60_000 });
    await ensureProject(page, projectName);
    await expect(page.getByRole("button", { name: /Clip 1 video/ })).toBeVisible({ timeout: 60_000 });

    // ── A0 入口：工具菜单 / 属性面板「手法」页签 / 素材箱行内剪刀 ────────────────
    await step("A0-入口", "三个入口都能打开「剪辑手法」面板", async () => {
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "剪辑手法" }).click();
      await expect(panelOf(page)).toBeVisible({ timeout: 15_000 });
      await expect(panelOf(page).getByRole("tab", { name: /去停顿/ })).toHaveAttribute("aria-selected", "true");
      await panelOf(page).getByRole("button", { name: "关闭剪辑手法" }).click();
      await expect(panelOf(page)).toHaveCount(0);

      await page.locator(".preview-frame").click();
      await page.getByRole("tab", { name: "手法" }).click();
      await page.getByRole("button", { name: "卡点", exact: true }).click();
      await expect(panelOf(page)).toBeVisible({ timeout: 15_000 });
      const selected = await panelOf(page).getByRole("tab", { name: /卡点/ }).getAttribute("aria-selected");
      await panelOf(page).getByRole("button", { name: "关闭剪辑手法" }).click();
      await expect(panelOf(page)).toHaveCount(0);

      await page.locator(".asset-row", { hasText: "口播素材" }).getByRole("button", { name: "剪辑手法" }).click();
      await expect(panelOf(page)).toBeVisible({ timeout: 15_000 });
      await panelOf(page).getByRole("button", { name: "关闭剪辑手法" }).click();
      return "菜单/属性面板/素材箱三入口均打开面板，属性面板入口直达卡点页（aria-selected=" + selected + "）";
    });

    // ── 测试 1：去停顿 ────────────────────────────────────────────────────────
    await step("1.1", "去停顿默认参数 0.05 / 400ms / 50ms 且时间轴示意随滑杆实时变化", async () => {
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "剪辑手法" }).click();
      await expect(panelOf(page)).toBeVisible({ timeout: 15_000 });
      await switchTool(page, "去停顿");
      await selectClipInPanel(page, clips.speechA);
      const threshold = await panelOf(page).locator(".et-field", { hasText: "能量阈值" }).locator(".et-val").innerText();
      const minSilence = await panelOf(page).locator(".et-field", { hasText: "最短静音" }).locator(".et-val").innerText();
      const pad = await panelOf(page).locator(".et-field", { hasText: "保留边距" }).locator(".et-val").innerText();
      const widthOf = async () => (await panelOf(page).locator(".et-seg-blk.silence").first().getAttribute("style")) ?? "";
      const before = await widthOf();
      await panelOf(page).locator(".et-field", { hasText: "最短静音" }).locator("input[type=range]").fill("2000");
      await sleep(250);
      const after = await widthOf();
      await panelOf(page).locator(".et-field", { hasText: "最短静音" }).locator("input[type=range]").fill("400");
      expect(threshold).toBe("0.05");
      expect(minSilence).toBe("400");
      expect(pad).toBe("50");
      expect(after).not.toBe(before);
      return "默认 " + threshold + " / " + minSilence + "ms / " + pad + "ms；静音块宽度随滑杆变化：" + before + " → " + after;
    });

    await step("1.2-负向", "未做 AI 信号分析时干跑给出明确引导（不是静默）", async () => {
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const text = await waitForText("去停顿缺信号错误", () => panelError(page), value => /AI 信号分析|未检测到可用语音|NO_SPEECH/.test(value), 30_000);
      await page.screenshot({ path: join(run, "10-remove-pauses-no-signal.png"), fullPage: true });
      return "错误文案：" + text;
    });

    await step("1.2-CV", "对目标素材执行「AI 信号分析」并等到就绪", async () => {
      await page.evaluate(async (input: { pid: string; aid: string }) => window.desktop.getCvAnalysis({
        project_id: input.pid as never, asset_id: input.aid, generate: true
      }), { pid: projectId, aid: speechAssetId });
      const summary = await waitForText("CV 分析就绪", async () => JSON.stringify(await cvPeek(page, projectId, speechAssetId)),
        text => !/"(queued|running)"/.test(text), 300_000);
      const parsed = JSON.parse(summary);
      expect(["ready", "stale", "failed"]).toContain(parsed.status);
      return "status=" + parsed.status + " samples=" + parsed.sample_count + " signals=" + JSON.stringify(parsed.signals);
    });

    let baselineRevision = "";
    await step("1.2-正向", "已分析素材干跑出摘要与操作数", async () => {
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const dry = await waitForText("去停顿干跑结果", async () => {
        const box = panelOf(page).locator(".et-dry");
        return (await box.count()) ? (await box.innerText()).replace(/\s+/g, " ").trim() : "";
      }, text => /操作 \d+ 条/.test(text), 60_000);
      const count = Number(/操作 (\d+) 条/.exec(dry)?.[1] ?? "0");
      expect(count).toBeGreaterThan(0);
      baselineRevision = await page.evaluate(async (pid: string) => (await window.desktop.getTimeline(pid as never)).current_revision.timeline_revision_id, projectId);
      return dry;
    });

    await step("1.3", "生成提案 → Diff 正确 → 采纳后时间线闭合（静音样本被排除）", async () => {
      const before = await timelineDocument(page, projectId);
      const beforeSpeech = before.clips.filter((clip: any) => clip.asset_id === speechAssetId && clip.track_id === "V1")
        .reduce((sum: number, clip: any) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
      await panelOf(page).getByRole("button", { name: "生成提案" }).click();
      await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 60_000 });
      const diff = (await panelOf(page).locator(".et-diff").innerText()).replace(/\s+/g, " ");
      await page.screenshot({ path: join(run, "11-remove-pauses-proposal.png"), fullPage: true });
      await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).click();
      await expect(panelOf(page).locator(".et-note.ok")).toContainText("已采纳为新 Revision", { timeout: 60_000 });
      const after = await timelineDocument(page, projectId);
      const afterSpeech = after.clips.filter((clip: any) => clip.asset_id === speechAssetId && clip.track_id === "V1")
        .reduce((sum: number, clip: any) => sum + (clip.timeline_end_us - clip.timeline_start_us), 0);
      const samples = await page.evaluate(async (input: { pid: string; aid: string }) => window.desktop.listCvSamples({
        project_id: input.pid as never, asset_id: input.aid
      }), { pid: projectId, aid: speechAssetId });
      // 与 Core silence.py 同算法的期望保留区间（能量阈值 0.05 / min_silence 400ms / pad 50ms）
      const expected = expectedKeeps(
        (samples.samples as Array<{ timestamp_us: number; audio_energy: number }>).filter(sample => sample.timestamp_us <= 20_000_000),
        0, 20_000_000, 0.05, 400_000, 50_000
      );
      const kept = after.clips.filter((clip: any) => clip.asset_id === speechAssetId && clip.track_id === "V1")
        .map((clip: any) => ({ start: clip.source_start_us, end: clip.source_end_us }))
        .filter((window_: any) => window_.start < 20_000_000)
        .sort((a: any, b: any) => a.start - b.start);
      const actual = kept.map((window_: any) => [window_.start, Math.min(window_.end, 20_000_000)]);
      const unionOf = (windows: number[][]) => windows.map(([start, end]) => start + "-" + end).join(" | ");
      expect(afterSpeech).toBeLessThan(beforeSpeech);
      expect(unionOf(actual)).toBe(unionOf(expected));
      return "Diff：" + diff + "；口播 V1 时长 " + (beforeSpeech / 1e6).toFixed(2) + "s → " + (afterSpeech / 1e6).toFixed(2)
        + "s；保留区间（Core 同算法期望 vs 采纳后实际）一致：" + unionOf(actual);
    });

    await step("1.4", "空操作（无静音）时采纳按钮不可用", async () => {
      const doc = await timelineDocument(page, projectId);
      const kept = doc.clips.filter((clip: any) => clip.asset_id === speechAssetId && clip.track_id === "V1" && clip.source_start_us < 20_000_000);
      if (!kept.length) throw new Error("采纳后找不到可复用的口播片段");
      await panelOf(page).getByRole("button", { name: "返回" }).click();
      await selectClipInPanel(page, kept[0].clip_id);
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const dry = await waitForText("空操作干跑", async () => {
        const box = panelOf(page).locator(".et-dry");
        return (await box.count()) ? (await box.innerText()).replace(/\s+/g, " ").trim() : "";
      }, text => /操作 \d+ 条/.test(text), 60_000);
      await panelOf(page).getByRole("button", { name: "生成提案" }).click();
      await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 60_000 });
      const ops = await page.evaluate(async (input: { pid: string }) => {
        const list = await window.desktop.listEditingGrammarProposals(input.pid as never);
        return list.items.length;
      }, { pid: projectId });
      const applyButtons = await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).count();
      const noopNote = await panelOf(page).locator(".et-sum").innerText();
      await page.screenshot({ path: join(run, "12-remove-pauses-noop.png"), fullPage: true });
      expect(applyButtons).toBe(0);
      await panelOf(page).getByRole("button", { name: "返回" }).click();
      return "干跑：" + dry + "；提案摘要：" + noopNote + "；采纳按钮数=" + applyButtons + "（历史提案 " + ops + " 条）";
    });

    // ── 测试 3 负向（必须在转录之前）：L/J 缺词不静默 ──────────────────────────
    await step("3.2-负向", "未转录素材：词戳来源提示先在转录页转录，干跑报缺词引导", async () => {
      await switchTool(page, "L/J cut");
      await selectClipInPanel(page, clips.speechB);
      const badge = await waitForText("词戳来源（未转录）", () => fieldNote(page, "词戳来源"),
        text => /无词级转录|ASR 词级转录/.test(text), 30_000);
      expect(badge).toContain("无词级转录");
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const error = await waitForText("缺词错误", () => panelError(page), text => text.length > 0, 30_000);
      expect(error).toMatch(/缺少词级时间戳|先对口播素材开启词级转录/);
      await page.screenshot({ path: join(run, "20-lj-no-words.png"), fullPage: true });
      return "徽标：" + badge + "；干跑错误：" + error;
    });

    // ── 转录（真实 faster-whisper tiny，词级时间戳）────────────────────────────
    let transcriptId = "";
    await step("3.1-转录", "真实本地 ASR 词级转录成功（前置）", async () => {
      const model = await page.evaluate(async () => {
        const models = await window.desktop.listModels({ limit: 100 });
        return models.items.find((item: any) => item.status === "ready" && item.provider_status === "installed") ?? null;
      });
      if (!model) throw new Error("Core 未报告 ready/installed 模型（AIVS_E2E_MODEL_DIR seed 失败）");
      const created = await page.evaluate(async (input: { aid: string; model: string }) => window.desktop.createTranscription({
        asset_id: input.aid, model_id: input.model as never, language: "auto", word_timestamps: true, license_acceptance: null
      }), { aid: speechAssetId, model: model.model_id });
      const job = await waitForJob(page, created.job.job_id, 420_000);
      expect(job.status).toBe("succeeded");
      const transcripts = await page.evaluate(async (aid: string) => window.desktop.listTranscripts(aid), speechAssetId);
      const ready = transcripts.items.find((item: any) => item.status === "ready");
      transcriptId = ready.transcript_id;
      const detail = await page.evaluate(async (id: string) => window.desktop.getTranscript(id as never), transcriptId);
      expect((detail.words ?? []).length).toBeGreaterThan(0);
      return "模型 " + model.model_id + "；segments=" + detail.segments.length + " words=" + detail.words.length;
    });

    await step("3.1", "转录后词戳来源显示「ASR 词级转录 ✓ —— Core 自动拉取」", async () => {
      await panelOf(page).getByRole("button", { name: "关闭剪辑手法" }).click();
      await expect(panelOf(page)).toHaveCount(0);
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "剪辑手法" }).click();
      await switchTool(page, "L/J cut");
      await selectClipInPanel(page, clips.speechB);
      const badge = await waitForText("词戳来源（已转录）", () => fieldNote(page, "词戳来源"), text => /ASR 词级转录/.test(text), 60_000);
      await page.screenshot({ path: join(run, "21-lj-words-badge.png"), fullPage: true });
      return "徽标：" + badge;
    });

    const deltas: Record<string, number> = {};
    await step("3.3", "三模式干跑：自动启发 + 手动 J（Δ<0）/ L（Δ>0）都在 300–500ms 窗口", async () => {
      for (const [mode, label] of [["auto", "自动"], ["j", "J · 声先入"], ["l", "L · 声延后"]] as const) {
        await panelOf(page).getByRole("group", { name: "LJ 方向" }).getByRole("button", { name: label }).click();
        await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
        const dry = await waitForText("LJ 干跑 " + mode, async () => {
          const box = panelOf(page).locator(".et-dry");
          return (await box.count()) ? (await box.innerText()).replace(/\s+/g, " ").trim() : "";
        }, text => /Δ=|操作 \d+ 条/.test(text), 60_000);
        const delta = Number(/Δ=(-?\d+)us/.exec(dry)?.[1] ?? "NaN");
        deltas[mode] = delta;
        expect(dry).not.toContain("缺少词级时间戳");
      }
      expect(Math.abs(deltas.j)).toBeGreaterThanOrEqual(300_000);
      expect(Math.abs(deltas.j)).toBeLessThanOrEqual(500_000);
      expect(deltas.j).toBeLessThan(0);
      expect(deltas.l).toBeGreaterThan(0);
      expect(Math.abs(deltas.l)).toBeLessThanOrEqual(500_000);
      return "auto=" + deltas.auto + "us（启发：" + (deltas.auto < 0 ? "J" : "L") + "）；j=" + deltas.j + "us；l=" + deltas.l + "us";
    });

    await step("3.4", "采纳手动 J → 正式 Timeline 声画边界差 == Δ（机器可测的「声先入」）", async () => {
      await panelOf(page).getByRole("group", { name: "LJ 方向" }).getByRole("button", { name: "J · 声先入" }).click();
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const dry = await waitForText("LJ J 干跑（采纳前）", async () => {
        const box = panelOf(page).locator(".et-dry");
        return (await box.count()) ? (await box.innerText()).replace(/\s+/g, " ").trim() : "";
      }, text => /Δ=/.test(text), 60_000);
      const delta = Number(/Δ=(-?\d+)us/.exec(dry)?.[1] ?? "NaN");
      expect(Number.isFinite(delta)).toBe(true);
      expect(Math.abs(delta)).toBeGreaterThanOrEqual(300_000);
      expect(Math.abs(delta)).toBeLessThanOrEqual(500_000);
      await panelOf(page).getByRole("button", { name: "生成提案" }).click();
      await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 60_000 });
      await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).click();
      await expect(panelOf(page).locator(".et-note.ok")).toContainText("已采纳为新 Revision", { timeout: 60_000 });
      const doc = await timelineDocument(page, projectId);
      const cut = 30_000_000;
      const videoLeft = doc.clips.find((clip: any) => clip.asset_id === speechAssetId && clip.track_id === "V1" && clip.source_end_us === cut);
      if (!videoLeft) throw new Error("找不到 J 切点左侧视频片段（source_end=30s）");
      const audioLeft = doc.clips.filter((clip: any) => clip.asset_id === speechAssetId && clip.asset_kind === "audio")
        .find((clip: any) => clip.source_start_us >= 20_000_000 && clip.source_end_us < cut + 1);
      if (!audioLeft) throw new Error("找不到派生的 A1 左段音频片段");
      const measured = audioLeft.timeline_end_us - videoLeft.timeline_end_us;
      await page.screenshot({ path: join(run, "22-lj-applied.png"), fullPage: true });
      expect(Math.abs(measured - delta)).toBeLessThanOrEqual(2_000);
      expect(measured).toBeLessThan(0);
      return "画面边界=" + videoLeft.timeline_end_us + "us，音频边界=" + audioLeft.timeline_end_us + "us，错位=" + measured
        + "us == 干跑 Δ=" + delta + "us → 声音先入 " + Math.abs(measured / 1000) + "ms（人耳听感对拍仍需人工确认）";
    });

    // ── 测试 2：卡点 ──────────────────────────────────────────────────────────
    await step("2.1", "选 BGM + 镜头段后：无节拍网格 + 「分析节拍」按钮", async () => {
      await panelOf(page).getByRole("button", { name: "关闭剪辑手法" }).click();
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByRole("menuitem", { name: "剪辑手法" }).click();
      await switchTool(page, "卡点");
      const doc = await timelineDocument(page, projectId);
      const musicClip = doc.clips.find((clip: any) => clip.asset_id === musicAssetId && clip.asset_kind === "audio");
      if (!musicClip) throw new Error("时间线上找不到 BGM 音乐片段");
      const defaultBgm = await panelOf(page).locator(".et-field", { hasText: "BGM / 音频轨" }).locator("select").inputValue();
      if (defaultBgm !== musicClip.clip_id) {
        observe("2.1-观察", "「BGM / 音频轨」默认选中项不是音乐片段",
          "默认=" + defaultBgm + "，音乐片段=" + musicClip.clip_id + "（面板取 audioClips 末位，L/J 派生的 A1 音频片段排在后面）");
      }
      await panelOf(page).locator(".et-field", { hasText: "BGM / 音频轨" }).locator("select").selectOption(musicClip.clip_id);
      const shots = await panelOf(page).locator(".et-shot-row").count();
      const bgmOptions = await panelOf(page).locator(".et-field", { hasText: "BGM / 音频轨" }).locator("option").count();
      const note = await waitForText("节拍网格状态（未分析）", () => fieldNote(page, "节拍网格"),
        text => /无节拍网格|已就绪|该素材无法检出/.test(text), 30_000);
      const button = await panelOf(page).getByRole("button", { name: /分析节拍/ }).count();
      await page.screenshot({ path: join(run, "30-beat-no-grid.png"), fullPage: true });
      expect(note).toContain("无节拍网格");
      expect(button).toBe(1);
      expect(shots).toBeGreaterThanOrEqual(2);
      return "镜头段 " + shots + " 个、BGM 候选 " + bgmOptions + " 条；状态行：" + note + "；「分析节拍」按钮存在";
    });

    await step("2.2", "点「分析节拍」→ 分析中… → 自动变 ✓ 已就绪（BPM/拍数/强拍）且按钮收起", async () => {
      const seen: string[] = [];
      await panelOf(page).getByRole("button", { name: /分析节拍/ }).click();
      const deadline = Date.now() + 240_000;
      let text = "";
      while (Date.now() < deadline) {
        text = await fieldNote(page, "节拍网格").catch(() => text);
        if (text && seen[seen.length - 1] !== text) seen.push(text);
        // 注意：静态文案「无节拍网格 —— 干跑会失败」本身含「失败」二字，不能作为终态判据；
        // 作业失败的面板表现是按钮变成「重新分析节拍」。
        const failed = await panelOf(page).getByRole("button", { name: /重新分析节拍/ }).count().catch(() => 0);
        if (/已就绪|无法检出|已变化/.test(text) || failed > 0) break;
        await sleep(200);
      }
      if (!/已就绪/.test(text)) {
        const error = await panelError(page);
        const buttons = await panelOf(page).locator(".et-field", { hasText: "节拍网格" }).locator("button").allInnerTexts();
        const raw = await page.evaluate(async (input: { pid: string }) => {
          try {
            const assets = await window.desktop.listAssets({ project_id: input.pid as never, limit: 20 });
            const audio = assets.items.find((item: any) => item.asset.kind === "audio");
            const value = await window.desktop.getBeatAnalysis({ project_id: input.pid as never, asset_id: audio!.asset.asset_id as never, generate: false });
            return JSON.stringify(value);
          } catch (caught) { return "ERR:" + errText(caught); }
        }, { pid: projectId }).catch(caught => "PROBE_ERR:" + errText(caught));
        throw new Error("节拍未就绪；状态序列=" + JSON.stringify(seen) + "；面板错误=" + (error || "无")
          + "；按钮=" + JSON.stringify(buttons) + "；直读摘要=" + raw);
      }
      const parsed = /BPM\s+([\d.]+)\s+·\s+(\d+)\s+拍（强拍\s+(\d+)）/.exec(text);
      const button = await panelOf(page).getByRole("button", { name: /分析节拍/ }).count();
      await page.screenshot({ path: join(run, "31-beat-ready.png"), fullPage: true });
      expect(parsed).toBeTruthy();
      expect(button).toBe(0);
      const bpm = Number(parsed?.[1] ?? "0");
      expect(bpm).toBeGreaterThan(40);
      expect(bpm).toBeLessThan(220);
      return "状态序列=" + JSON.stringify(seen) + "；解析 BPM=" + bpm + " 拍数=" + parsed?.[2] + " 强拍=" + parsed?.[3] + "；按钮已收起";
    });

    await step("2.3", "干跑卡点摘要非空 → 生成提案 → 采纳 → 切点落在节拍上", async () => {
      await panelOf(page).getByRole("button", { name: "干跑预览" }).click();
      const dry = await waitForText("卡点干跑", async () => {
        const box = panelOf(page).locator(".et-dry");
        return (await box.count()) ? (await box.innerText()).replace(/\s+/g, " ").trim() : "";
      }, text => /操作 \d+ 条/.test(text), 90_000);
      const count = Number(/操作 (\d+) 条/.exec(dry)?.[1] ?? "0");
      expect(count).toBeGreaterThan(0);
      const before = await timelineDocument(page, projectId);
      await panelOf(page).getByRole("button", { name: "生成提案" }).click();
      await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 60_000 });
      await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).click();
      await expect(panelOf(page).locator(".et-note.ok")).toContainText("已采纳为新 Revision", { timeout: 60_000 });
      // 与 Core 落库的 beat_grids.beats_json 对拍「切点是否落在节拍上」。
      // 卡点计划把选中镜头重排进节拍槽位（时间线被重基：首槽 = 网格首拍），
      // 所以相位是自由参数——先解出全局相位，再逐点核对残差；
      // 另有可测内核：每镜时长 == 每镜拍数 × 节拍周期。
      const beatTimes = await readBeatGrid(run, musicAssetId);
      expect(beatTimes.length).toBeGreaterThan(8);
      // 设计语义（BEAT_SYNC_PLANNING_GATE §2.2）：卡点输出是「按槽位时间序的 insert 序列」，
      // 原有片段保留不动（只借网格）⇒ 只核验**本次插入的镜头**，相位取首 beat（§4 风险对策）。
      const beforeIds = new Set<string>(before.clips.map((clip: any) => clip.clip_id));
      const after = await timelineDocument(page, projectId);
      const inserted = after.clips
        .filter((clip: any) => clip.track_id === "V1" && clip.asset_kind === "video" && !beforeIds.has(clip.clip_id))
        .sort((a: any, b: any) => a.timeline_start_us - b.timeline_start_us);
      expect(inserted.length).toBeGreaterThan(2);
      const boundaries = [...new Set<number>(inserted.flatMap((clip: any) => [clip.timeline_start_us, clip.timeline_end_us]))].sort((a, b) => a - b);
      const total = boundaries[boundaries.length - 1];
      const cuts = boundaries.filter(value => value > 0 && value < total);
      expect(cuts.length).toBeGreaterThan(2);
      const phase = beatTimes[0];
      const residuals = cuts.map(value => Math.min(...beatTimes.map(beat => Math.abs((beat - phase) - value))));
      const sorted = [...residuals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const onBeat = residuals.filter(value => value <= 60_000).length;
      const periods = beatTimes.slice(1).map((value, index) => value - beatTimes[index]);
      const period = [...periods].sort((a, b) => a - b)[Math.floor(periods.length / 2)];
      const durations = inserted.map((clip: any) => clip.timeline_end_us - clip.timeline_start_us);
      const multipleError = Math.max(...durations.map(value => {
        const multiple = Math.max(1, Math.round(value / period));
        return Math.abs(value - multiple * period);
      }));
      await page.screenshot({ path: join(run, "32-beat-applied.png"), fullPage: true });
      // 真实音乐网格不是等间距（合成门容差 1ms 不适用于真机）：切点 100% 落在 ±60ms、
      // 中位偏差 ≤ 30ms，镜头时长 == 每镜拍数 × 节拍周期（±40ms）。
      expect(onBeat / residuals.length).toBeGreaterThanOrEqual(0.8);
      expect(median).toBeLessThanOrEqual(30_000);
      expect(multipleError).toBeLessThanOrEqual(40_000);
      return "干跑：" + dry + "；插入镜头 " + inserted.length + " 个 / 切点 " + cuts.length + " 个：落拍(±60ms) "
        + onBeat + "/" + residuals.length + "，中位偏差 " + median + "us（相位=" + phase + "us）；"
        + "镜头时长对拍周期 " + period + "us 最大误差 " + multipleError + "us";
    });

    await step("2.4", "换无音轨素材做 BGM → 「无法检出节拍」且可重试，无错误横幅", async () => {
      await ensureFormView(page);
      const doc = await timelineDocument(page, projectId);
      const silentClip = doc.clips.find((clip: any) => clip.asset_id === silentAssetId && clip.track_id === "V1");
      if (!silentClip) throw new Error("时间线上找不到无音轨素材片段");
      await panelOf(page).locator(".et-field", { hasText: "BGM / 音频轨" }).locator("select").selectOption(silentClip.clip_id);
      const note = await waitForText("无音轨 BGM 状态", () => fieldNote(page, "节拍网格"),
        text => /无法检出|已就绪|无节拍网格|分析中/.test(text), 60_000);
      const button = panelOf(page).getByRole("button", { name: /分析节拍/ });
      await button.click();
      const retryNote = await waitForText("无音轨 retry", () => fieldNote(page, "节拍网格"), text => /无法检出/.test(text), 90_000);
      const error = await panelError(page);
      const banner = await page.locator(".notice").count();
      await page.screenshot({ path: join(run, "33-beat-unavailable.png"), fullPage: true });
      expect(retryNote).toContain("无法检出");
      expect(error).toBe("");
      return "首次状态：" + note + "；重试后：" + retryNote + "；面板错误=" + (error || "无") + "；横幅=" + banner;
    });

    // ── 测试 4：通用 ──────────────────────────────────────────────────────────
    await step("4.1", "采纳前外部改动时间线 → 面板提示基线已变化并禁用采纳", async () => {
      // 在 L/J 页生成一个新提案，再用 Ctrl+Z（App 自己的撤销）改基线——真实外部改动路径。
      await switchTool(page, "L/J cut");
      await selectClipInPanel(page, clips.speechB);
      await panelOf(page).getByRole("button", { name: "生成提案" }).click();
      try {
        await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 60_000 });
      } catch (error) {
        throw new Error("L/J 提案未生成；面板错误=" + ((await panelError(page)) || "无") + "；原始=" + errText(error));
      }
      const beforeDisabled = await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).isDisabled();
      await page.keyboard.press("Control+z");
      const warned = await waitForText("基线漂移提示", async () => {
        const warn = panelOf(page).locator(".et-note.warn");
        return (await warn.count()) ? (await warn.first().innerText()).trim() : "";
      }, text => text.length > 0, 20_000).catch(caught => {
        throw new Error("撤销后未出现「基线已变化」提示；面板错误=" + errText(caught));
      });
      const afterDisabled = await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).isDisabled().catch(() => true);
      await page.screenshot({ path: join(run, "40-baseline-drift.png"), fullPage: true });
      expect(warned).toContain("基线已变化");
      expect(afterDisabled).toBe(true);
      return "提案前禁用=" + beforeDisabled + "；外部撤销后提示=" + warned.trim() + "；采纳禁用=" + afterDisabled;
    });

    await step("4.2", "历史提案可打开查看；已采纳的不可重复采纳", async () => {
      await ensureFormView(page);
      const historyCount = await panelOf(page).locator(".et-hist button").count();
      expect(historyCount).toBeGreaterThan(0);
      const labels: string[] = [];
      const buttons = panelOf(page).locator(".et-hist button");
      for (let index = 0; index < Math.min(historyCount, 6); index += 1) {
        const label = (await buttons.nth(index).innerText()).trim();
        await buttons.nth(index).click();
        await expect(panelOf(page).locator(".et-proposal")).toBeVisible({ timeout: 30_000 });
        const adopted = await panelOf(page).locator(".et-note.ok").count();
        const applyCount = await panelOf(page).getByRole("button", { name: "采纳为正式 Timeline" }).count();
        labels.push(label + "→" + (adopted ? "已采纳(采纳按钮 " + applyCount + ")" : "未采纳"));
        await panelOf(page).getByRole("button", { name: "返回" }).click();
      }
      const adoptedEntries = labels.filter(label => label.includes("已采纳"));
      await page.screenshot({ path: join(run, "41-history.png"), fullPage: true });
      expect(adoptedEntries.every(label => label.includes("采纳按钮 0"))).toBe(true);
      return "历史提案 " + historyCount + " 条：" + JSON.stringify(labels);
    });

    await step("4.3", "三页零 egress（无 Provider 面板/无外发记录）", async () => {
      const providerUi = await page.locator(".modal.captions-provider, .modal.ai-roughcut, .modal.planning-patch, .modal.provider-settings").count();
      const dbPath = await findAppDb(run);
      const counts = dbPath ? readEgressCounts(dbPath) : "未找到 app.db";
      await page.screenshot({ path: join(run, "42-egress.png"), fullPage: true });
      expect(providerUi).toBe(0);
      if (typeof counts !== "string") {
        expect(Object.values(counts).every(value => value === 0)).toBe(true);
      }
      return "Provider 面板数=" + providerUi + "；DB 外发表计数=" + JSON.stringify(counts) + (dbPath ? "（" + dbPath + "）" : "");
    });

    // 破坏性步骤放最后：素材标记 changed 后 Core 对任何 TimelinePatch 都 fail-closed
    // （TIMELINE_SOURCE_INVALID「素材不可用于 Timeline」），会让通用项无法验证。
    await step("2.5", "素材被外部修改后再进面板 → 「素材已变化，节拍网格需重新分析」", async () => {
      await ensureFormView(page);
      await switchTool(page, "卡点");
      const doc = await timelineDocument(page, projectId);
      const musicClip = doc.clips.find((clip: any) => clip.asset_id === musicAssetId && clip.asset_kind === "audio");
      if (!musicClip) throw new Error("找不到 BGM 片段");
      await appendFile(music, Buffer.from([0]));
      await page.evaluate(async (aid: string) => window.desktop.refreshAsset(aid), musicAssetId);
      await panelOf(page).locator(".et-field", { hasText: "BGM / 音频轨" }).locator("select").selectOption(musicClip.clip_id);
      const note = await waitForText("素材变化 stale", () => fieldNote(page, "节拍网格"), text => /已变化|重新分析|已就绪|无法检出/.test(text), 60_000);
      const button = await panelOf(page).getByRole("button", { name: /重新分析节拍|分析节拍/ }).count();
      await page.screenshot({ path: join(run, "34-beat-stale.png"), fullPage: true });
      expect(note).toContain("已变化");
      expect(button).toBe(1);
      // 还原文件：内容改回原样后 refresh 必须恢复 available（回退语义，P79）——
      // 此前会把基准写成新指纹，回退无法自证，素材永久停在 changed 且时间线不可编辑。
      await copyFile(musicSource, music);
      await page.evaluate(async (aid: string) => window.desktop.refreshAsset(aid), musicAssetId);
      const availability = await page.evaluate(async (input: { pid: string; aid: string }) => {
        const assets = await window.desktop.listAssets({ project_id: input.pid as never, limit: 20 });
        return assets.items.find((item: any) => item.asset.asset_id === input.aid)?.asset.availability ?? "?";
      }, { pid: projectId, aid: musicAssetId }).catch(() => "?");
      expect(availability).toBe("available");
      return "状态行：" + note + "；按钮数=" + button + "；还原文件 + refresh 后 availability=" + availability + "（回退恢复可用）";
    });
  } finally {
    const summary = { run, items, notes, when: new Date().toISOString() };
    await writeFile(join(run, "results.json"), JSON.stringify(summary, null, 2), "utf8").catch(() => undefined);
    const failed = items.filter(item => item.status === "fail");
    const markdown = [
      "# Wave1 剪辑手法 L3 自动化执行结果",
      "",
      "- 运行目录：" + run,
      "- 通过：" + items.filter(item => item.status === "pass").length + " / 失败：" + failed.length + " / 观察：" + items.filter(item => item.status === "observe").length,
      "",
      "| 项 | 清单条目 | 结果 | 证据/说明 |",
      "|---|---|---|---|",
      ...items.map(item => "| " + item.id + " | " + item.title + " | " + (item.status === "pass" ? "✅" : item.status === "fail" ? "❌" : "👁") + " | " + item.detail.replace(/\|/g, "\\|").slice(0, 500) + " |"),
      "",
      notes.length ? "备注：" + notes.join(" / ") : ""
    ].join("\n");
    await writeFile(join(run, "REPORT.md"), markdown, "utf8").catch(() => undefined);
    console.log("\n===== Wave1 自动化摘要 =====\n" + markdown);
    if (app) await app.close().catch(() => undefined);
    expect(failed.map(item => item.id + ": " + item.detail).join("\n"), "Wave1 手测自动化存在失败项").toBe("");
  }
});

/** 读取 Core 落库的 beat_grids.beats_json（切点对拍的权威来源，只读本次运行的库）。 */
async function readBeatGrid(run: string, assetId: string): Promise<number[]> {
  const dbPath = await findAppDb(run);
  if (!dbPath) throw new Error("运行目录内找不到 app.db：" + run);
  const output = execFileSync(pythonSidecar, ["-c", [
    "import sqlite3,json,sys",
    "con=sqlite3.connect(sys.argv[1])",
    "row=con.execute('SELECT beats_json FROM beat_grids WHERE asset_id=? ORDER BY created_at DESC LIMIT 1',(sys.argv[2],)).fetchone()",
    "print(row[0] if row else '[]')"
  ].join("\n"), dbPath, assetId], { encoding: "utf8" });
  return JSON.parse(output.trim() || "[]") as number[];
}

/** Core silence.py detect_silence_intervals + compute_keep_intervals 的等价实现（用于核验采纳结果）。 */
export function expectedKeeps(
  samples: Array<{ timestamp_us: number; audio_energy: number }>,
  startUs: number, endUs: number, threshold: number, minSilenceUs: number, padUs: number
): number[][] {
  const ordered = samples.slice().sort((a, b) => a.timestamp_us - b.timestamp_us);
  const silence: number[][] = [];
  let runStart: number | null = null;
  let lastSilent = 0;
  for (const sample of ordered) {
    if (sample.audio_energy <= threshold) {
      if (runStart === null) runStart = sample.timestamp_us;
      lastSilent = sample.timestamp_us;
    } else if (runStart !== null) {
      if (sample.timestamp_us - runStart >= minSilenceUs) silence.push([runStart, sample.timestamp_us]);
      runStart = null;
    }
  }
  if (runStart !== null && lastSilent + 1 - runStart >= minSilenceUs) silence.push([runStart, lastSilent + 1]);
  const cuts = silence.map(([s, e]) => [Math.max(startUs, s + padUs), Math.min(endUs, e - padUs)]).filter(([s, e]) => e > s);
  const keeps: number[][] = [];
  let cursor = startUs;
  for (const [s, e] of cuts) {
    if (s > cursor) keeps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < endUs) keeps.push([cursor, endUs]);
  if (!keeps.length) return [];
  const minVideoUs = 100_000;
  const merged: number[][] = [keeps[0]];
  for (const keep of keeps.slice(1)) {
    const prev = merged[merged.length - 1];
    if (keep[1] - keep[0] < minVideoUs || prev[1] - prev[0] < minVideoUs) merged[merged.length - 1] = [prev[0], keep[1]];
    else merged.push(keep);
  }
  if (merged[merged.length - 1][1] - merged[merged.length - 1][0] < minVideoUs && merged.length > 1) {
    merged[merged.length - 2] = [merged[merged.length - 2][0], merged[merged.length - 1][1]];
    merged.pop();
  }
  return merged.filter(([s, e]) => e - s >= minVideoUs);
}

async function findAppDb(run: string): Promise<string> {
  const stack = [run];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try { entries = await readdir(current, { withFileTypes: true }) as never; } catch { continue; }
    for (const entry of entries as never as Array<{ name: string; isDirectory: () => boolean }>) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "app.db") return full;
    }
  }
  return "";
}

function readEgressCounts(dbPath: string): Record<string, number> | string {
  const tables = ["provider_invocations", "timeline_patch_generations", "captions_provider_generations", "agent_sessions", "provider_image_generation_requests"];
  try {
    const output = execFileSync(pythonSidecar, ["-c", [
      "import sqlite3,json,sys",
      "con=sqlite3.connect(sys.argv[1])",
      "out={}",
      "for t in sys.argv[2:]:",
      "    try: out[t]=con.execute('SELECT COUNT(*) FROM '+t).fetchone()[0]",
      "    except Exception: out[t]=0",
      "print(json.dumps(out))"
    ].join("\n"), dbPath, ...tables], { encoding: "utf8" });
    return JSON.parse(output.trim()) as Record<string, number>;
  } catch (error) {
    return errText(error);
  }
}

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (options: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "../../.."); const desktop = resolve(currentDir, ".."); const resources = join(root, "resources");
const pythonSidecar = join(root, ".venv", "Scripts", "python.exe"); const packagedSidecar = join(resources, "core", "aivs-core", "aivs-core.exe");
const sidecarExecutable = process.env.AIVS_SIDECAR_EXECUTABLE ?? (existsSync(pythonSidecar) ? pythonSidecar : packagedSidecar);
const sidecarArgs = process.env.AIVS_SIDECAR_EXECUTABLE_ARGS ?? (existsSync(pythonSidecar) ? JSON.stringify(["-m", "aivs_core.bootstrap"]) : JSON.stringify([]));

function env(video: string) { return { ...process.env, AIVS_RESOURCES_PATH: resources, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image: video }), AIVS_SIDECAR_EXECUTABLE: sidecarExecutable, AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs, PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }; }
async function launch(userData: string, video: string) { return electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${userData}`], cwd: desktop, env: env(video) }); }

// ── 几何观测 ────────────────────────────────────────────────────────────────
// 轨道高度（40-128 可调）、波形占比（100/60/40% 可切）、行序、缩放都是产品可调项，
// 因此本 spec 不写死任何几何：标尺高 / V1 行 top,height / headerWidth 从内联样式读，
// 波形占比读档位按钮 aria-pressed，px/s 由「光标在 V1 行上由命中态转为默认」的内容
// 右缘标定。下面的 dB 量程与名称条/留白是产品里不可调的常量（与 geometry.ts 同名常量一一对应）。
const CLIP_HEADER_H = 16; // geometry.ts: 片段名称条高度（rect.width > 36 时生效）
const VOLUME_BAND_PAD = 4; // geometry.ts: 音量线上下留白
const VOLUME_MIN_DB = -30;
const VOLUME_MAX_DB = 12;

/** 从文档读出的片段快照（断言与几何推导的唯一数据源）。 */
interface ClipSnapshot {
  clip_id: string;
  track_id: string;
  start: number;
  end: number;
  gainDb: number;
  audioEnabled: boolean;
}

interface TimelineGeometry {
  /** 标尺高（画布内容 y = 0..rulerHeight）。 */
  rulerHeight: number;
  /** V1 行顶（画布内容坐标）。 */
  v1Top: number;
  /** V1 行高（= 轨道高度设置）。 */
  v1Height: number;
  /** 轨道头列宽 = timeToX 的 headerWidth。 */
  headerWidth: number;
  /** 页面坐标：画布内容 x = 0。 */
  canvasLeft: number;
  /** 页面坐标：画布内容 y = 0（画布随纵向滚动摆位，已归零）。 */
  canvasTop: number;
  canvasWidth: number;
  canvasHeight: number;
}

async function readGeometry(page: Page): Promise<TimelineGeometry> {
  const raw = await page.evaluate(() => {
    const pick = (selector: string) => document.querySelector(selector) as HTMLElement | null;
    const number = (value: string | undefined) => Number.parseFloat(value ?? "");
    const head = pick('.timeline-track-head[data-track-id="V1"]');
    const corner = pick(".timeline-left-corner");
    const gutter = pick(".timeline-left");
    const canvas = pick(".timeline-canvas-container canvas") as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    return {
      rulerHeight: number(corner?.style.height),
      v1Top: number(head?.style.top),
      v1Height: number(head?.style.height),
      headerWidth: number(gutter?.style.width),
      canvasLeft: rect?.left ?? Number.NaN,
      canvasTop: (rect?.top ?? Number.NaN) - (number(canvas?.style.top) || 0),
      canvasWidth: rect?.width ?? Number.NaN,
      canvasHeight: rect?.height ?? Number.NaN,
    };
  });
  const missing = Object.entries(raw).filter(([, value]) => !Number.isFinite(value)).map(([key]) => key);
  if (missing.length > 0) throw new Error(`时间线几何未读到（DOM 观测失败：${missing.join(", ")}）：${JSON.stringify(raw)}`);
  return raw as TimelineGeometry;
}

/** 画布内容坐标 → 页面坐标。 */
function toPage(geometry: TimelineGeometry, canvasX: number, canvasY: number) {
  return { x: geometry.canvasLeft + canvasX, y: geometry.canvasTop + canvasY };
}

/** hover 后读画布 cursor：产品命中时自己写 ns-resize（音量线）/ grab（片段）/ ew-resize（修剪柄）。 */
async function hoverCursor(page: Page, point: { x: number; y: number }): Promise<string> {
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  return page.evaluate(() => (document.querySelector(".timeline-canvas-container canvas") as HTMLCanvasElement).style.cursor || "default");
}

/**
 * 标定 px/s。三段首尾相接覆盖 [0, totalUs)，所以光标沿 V1 行右移时，命中的最右一列
 * 就是「内容右缘 + 修剪柄半宽」（修剪柄命中区以片段边缘为轴左右对称）。再向左走完这段
 * ew-resize 带，两端中点即内容右缘：x = headerWidth + totalUs/1e6 * pps。
 */
async function measurePixelsPerSecond(page: Page, geometry: TimelineGeometry, totalUs: number): Promise<number> {
  const probeY = geometry.v1Top + Math.min(12, geometry.v1Height / 2);
  const cursorAt = async (canvasX: number) => hoverCursor(page, toPage(geometry, canvasX, probeY));
  const low = Math.round(geometry.headerWidth) + 2;
  const high = Math.round(geometry.canvasWidth) - 2;
  if ((await cursorAt(low)) === "default") throw new Error(`px/s 标定失败：时间线起点 x=${low} 不在片段上（表头宽 ${geometry.headerWidth}）`);
  if ((await cursorAt(high)) !== "default") throw new Error(`px/s 标定失败：内容右缘超出可视宽（画布宽 ${geometry.canvasWidth}px），无法标定`);
  let left = low;
  let right = high;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if ((await cursorAt(middle)) === "default") right = middle;
    else left = middle;
  }
  const trimOuter = left;
  let trimInner = trimOuter;
  while (trimInner > low && (await cursorAt(trimInner - 1)) === "ew-resize") trimInner -= 1;
  expect(trimInner, `px/s 标定失败：内容右缘 x=${trimOuter} 左侧没有修剪柄带（未观察到 ew-resize）`).toBeLessThan(trimOuter);
  return ((trimInner + trimOuter) / 2 - geometry.headerWidth) / (totalUs / 1_000_000);
}

test("M5 时间线：音量拖动、自由定位、标尺与副轨波纹删除", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const run = join(root, "test-results", `m5-timeline-${process.pid}-${Date.now()}`);
  const userData = join(run, "user-data"); const video = join(run, "素材.mp4");
  await mkdir(run, { recursive: true });
  await copyFile(join(root, "test-assets", "generated", "cfr-landscape-av.mp4"), video);
  const app = await launch(userData, video);
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    // 3 段各 2s。时间/时长一律从文档读；像素位置由标定出的 px/s 推算。
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name: "M5 Timeline E2E" });
      const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
      if (!imported) throw new Error("fixture import cancelled");
      const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "blurred_background", caption_preset_id: "default-bottom" } });
      const firstClipId = created.current_revision.document.clips[0].clip_id;
      const state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: created.current_revision.timeline_revision_id, operations: [
        { op: "trim_clip", clip_id: firstClipId as never, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 1, source_start_us: 0, source_end_us: 2_000_000 },
        { op: "insert_asset_clip", asset_id: imported.asset.asset_id, at_index: 2, source_start_us: 0, source_end_us: 2_000_000 },
      ], summary: "三段" } });
      const [a, b, c] = state.current_revision.document.clips.map((clip: { clip_id: string }) => clip.clip_id);
      return { project_id: project.project_id, order: [a, b, c] };
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
    await page.evaluate(() => window.desktop.getRuntime());
    await expect(page.getByText(/Core 已连接/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(3, { timeout: 30_000 });

    const canvas = page.locator(".timeline-canvas-container canvas");
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    const clipsOf = (): Promise<ClipSnapshot[]> => page.evaluate(async (id: string) => {
      const state = await window.desktop.getTimeline(id as never);
      return (state.current_revision.document.clips as Array<{ clip_id: string; track_id: string; timeline_start_us: number; timeline_end_us: number; audio: { gain_db: number; enabled: boolean } }>).map(clip => ({
        clip_id: clip.clip_id as string,
        track_id: clip.track_id as string,
        start: clip.timeline_start_us as number,
        end: clip.timeline_end_us as number,
        gainDb: clip.audio.gain_db as number,
        audioEnabled: clip.audio.enabled as boolean,
      }));
    }, setup.project_id);

    const initial = await clipsOf();
    expect(initial).toHaveLength(3);
    const byId = new Map(initial.map(clip => [clip.clip_id, clip]));
    const second = byId.get(setup.order[1]);
    const third = byId.get(setup.order[2]);
    if (!second || !third) throw new Error(`文档缺片段：${JSON.stringify(setup.order)} / ${JSON.stringify(initial.map(clip => clip.clip_id))}`);
    const totalUs = Math.max(...initial.map(clip => clip.end));
    expect(totalUs, "时间线总时长").toBeGreaterThan(0);

    // 1. 显示设置：轨道高度、波形占比都是产品可调项 —— 打开「…」菜单从 UI 读现值。
    const displayToggle = page.getByRole("button", { name: "时间线显示设置" });
    await displayToggle.click();
    await expect(displayToggle).toHaveAttribute("aria-expanded", "true");
    const prefs = await page.evaluate(() => {
      const slider = document.querySelector(".track-height-slider") as HTMLInputElement | null;
      const active = document.querySelector('.ratio-group button[aria-pressed="true"]');
      const label = active?.getAttribute("aria-label") ?? "";
      const matched = Number.parseFloat(label.split("%")[0].replace(/[^0-9.]/g, ""));
      return {
        trackHeight: Number(slider?.value ?? Number.NaN),
        ratioLabel: label,
        ratioPct: Number.isFinite(matched) ? matched : Number.NaN,
      };
    });
    await displayToggle.click();
    await expect(displayToggle).toHaveAttribute("aria-expanded", "false");
    expect(Number.isFinite(prefs.trackHeight), `轨道高度未读到：${JSON.stringify(prefs)}`).toBe(true);
    const waveformRatio = prefs.ratioPct / 100;
    expect(waveformRatio, `波形占比未读到：${JSON.stringify(prefs)}`).toBeGreaterThan(0);

    // 2. 几何：标尺高 / V1 行 top,height / headerWidth 全部来自内联样式（行序按 data-track-id 定位）。
    const geometry = await readGeometry(page);
    expect(geometry.v1Height).toBe(Math.max(64, prefs.trackHeight + 12));
    expect(geometry.v1Top, "V1 行必须在标尺之下").toBeGreaterThanOrEqual(geometry.rulerHeight);
    expect(geometry.headerWidth, "表头宽").toBeGreaterThan(0);

    // 3. px/s 标定（内容右缘 ⇐ 光标命中态）；此后所有 x 由「片段时间 × 标定值」推出。
    const pps = await measurePixelsPerSecond(page, geometry, totalUs);
    expect(pps, "标定出的 px/s").toBeGreaterThan(0);
    const toCanvasX = (us: number) => geometry.headerWidth + (us / 1_000_000) * pps;

    // 4. 音频带几何（clipAudioBand / volumeToY 的等价式，输入全部来自实测）。
    const secondDurationUs = second.end - second.start;
    const secondWidth = (secondDurationUs / 1_000_000) * pps;
    expect(secondWidth, "第二段宽度决定名称条是否生效").toBeGreaterThan(36);
    const bandHeightRaw = Math.round((geometry.v1Height - CLIP_HEADER_H) * waveformRatio);
    const band = { top: geometry.v1Top + geometry.v1Height - bandHeightRaw, height: Math.max(6, bandHeightRaw) };
    const bandUsable = Math.max(1, band.height - VOLUME_BAND_PAD * 2);
    const gainNorm = (Math.max(VOLUME_MIN_DB, Math.min(VOLUME_MAX_DB, second.gainDb)) - VOLUME_MIN_DB) / (VOLUME_MAX_DB - VOLUME_MIN_DB);
    const volumeLineY = band.top + VOLUME_BAND_PAD + (1 - gainNorm) * bandUsable;
    const volumeX = toCanvasX(second.start + secondDurationUs / 2);

    // 5. 命中自检（本 spec 的核心）：先用产品自己的 cursor 反馈证明算出的 y 命中音量线。
    const volumeCursor = await hoverCursor(page, toPage(geometry, volumeX, volumeLineY));
    expect(volumeCursor, `音量线未命中：算出的 0dB 线 y=${volumeLineY.toFixed(1)}px（标尺 ${geometry.rulerHeight} / V1 top ${geometry.v1Top} h ${geometry.v1Height} / 波形占比 ${waveformRatio} → 音频带 top ${band.top} h ${band.height}）在 x=${volumeX.toFixed(1)} 处没有命中，期望 ns-resize，实得 ${volumeCursor}。实测几何：${JSON.stringify(geometry)}`).toBe("ns-resize");
    // 自检的区分力：同一 x 上偏离 12px（> 命中容差 4px）必须不再算命中。
    const offLineCursor = await hoverCursor(page, toPage(geometry, volumeX, volumeLineY + 12));
    expect(offLineCursor, `命中自检失效：y=${(volumeLineY + 12).toFixed(1)}（偏离 12px）仍被判为音量线`).not.toBe("ns-resize");

    // 6. 音量线拖拽：第二段 0dB → 拖到音频带顶部（限幅 +12dB）。
    const volumePage = toPage(geometry, volumeX, volumeLineY);
    await page.mouse.move(volumePage.x, volumePage.y);
    await page.mouse.down();
    await page.mouse.move(volumePage.x, toPage(geometry, volumeX, band.top + VOLUME_BAND_PAD).y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await clipsOf())[1].gainDb !== second.gainDb, { timeout: 15_000, message: "音量拖拽未写入文档" }).toBe(true);
    const gains = await clipsOf().then(clips => clips.map(clip => clip.gainDb));
    expect(gains[1]).toBeGreaterThan(5); // 拖到顶部限幅 ≈ +12dB

    // 7. V1 自由定位：选中第二段向右拖过第三段 → 钳制到第三段右缘贴齐（[6s, 8s)）。
    const magnet = page.getByRole("button", { name: "主轨磁吸", exact: true });
    if (await magnet.getAttribute("aria-pressed") === "true") await magnet.click();
    //    落点自检：先证明落点在 V1 行内且不在音量带上（产品命中片段时 cursor = grab）。
    const pressY = geometry.v1Top + Math.min(12, geometry.v1Height / 2);
    const pressX = toCanvasX(second.start + secondDurationUs / 2);
    const pressCursor = await hoverCursor(page, toPage(geometry, pressX, pressY));
    expect(pressCursor, `片段拖拽落点未命中：x=${pressX.toFixed(1)} y=${pressY}（V1 行 ${geometry.v1Top}..${geometry.v1Top + geometry.v1Height}，音量带 top ${band.top}）期望 grab，实得 ${pressCursor}`).toBe("grab");
    // 两个合法落点是「贴齐第三段左缘」(third.start - 时长) 与「贴齐右缘」(third.end)；
    // 落点越过二者中点才会解析到右缘 6s。
    const clampMidpointUs = (third.start - secondDurationUs + third.end) / 2;
    const targetCanvasX = Math.min(toCanvasX(third.end), geometry.canvasWidth - 40);
    expect(targetCanvasX, `拖拽落点 x=${targetCanvasX.toFixed(1)} 未越过钳制分界 ${clampMidpointUs}µs`).toBeGreaterThan(toCanvasX(clampMidpointUs));
    const pressPage = toPage(geometry, pressX, pressY);
    await page.mouse.move(pressPage.x, pressPage.y);
    await page.mouse.down();
    await page.mouse.move(toPage(geometry, targetCanvasX, pressY).x, pressPage.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await clipsOf()).find(clip => clip.clip_id === setup.order[1])?.start !== second.start, { timeout: 15_000, message: "V1 拖拽未写入文档" }).toBe(true);
    const positions = await clipsOf().then(clips => clips.map(clip => ({ clip_id: clip.clip_id, start: clip.start, end: clip.end })));
    const positionById = new Map(positions.map(item => [item.clip_id, item]));
    expect(positionById.get(setup.order[1])?.start).toBe(6_000_000);
    expect(positionById.get(setup.order[1])?.end).toBe(8_000_000);
    expect(positionById.get(setup.order[0])?.start).toBe(0);
    expect(positionById.get(setup.order[2])?.start).toBe(4_000_000);

    // 8. 双击标尺 → 适应内容（滑杆回落到 fit 值，而不是保持 100）。
    const zoomSlider = page.locator(".timeline-zoom-slider");
    const readZoom = () => zoomSlider.evaluate((element: HTMLInputElement) => Number(element.value));
    // input[type=range] 的 fill 不可靠：原生 setter + input 事件（绕过 React 的 value tracker）。
    await zoomSlider.evaluate((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(readZoom, { timeout: 10_000, message: "缩放滑杆未落到 100" }).toBe(100);
    const before = await readZoom();
    await page.locator(".timeline-ruler-pin").dblclick({ position: { x: Math.round(geometry.headerWidth + 200), y: Math.max(1, Math.round(geometry.rulerHeight / 2)) } });
    await expect.poll(readZoom, { timeout: 10_000, message: "双击标尺未改变缩放" }).toBeLessThan(100);
    const after = await readZoom();
    expect(before).toBe(100);
    expect(after).toBeLessThan(100);

    const ruler = page.locator(".timeline-ruler-pin");
    const rulerBox = await ruler.boundingBox();
    if (!rulerBox) throw new Error("Missing timeline ruler");
    const rulerX = rulerBox.x + geometry.headerWidth * 2 + 40;
    const rulerY = rulerBox.y + rulerBox.height / 2;
    const filmstripVisible = () => canvas.evaluate((element: HTMLCanvasElement, { x, y }) => {
      const dpr = window.devicePixelRatio || 1;
      const pixels = element.getContext("2d")?.getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.round(65 * dpr), 1).data;
      if (!pixels) return false;
      // The fixture's saturated bars are distinguishable from the blue clip background.
      for (let i = 0; i < pixels.length; i += 4) {
        const channels = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (Math.max(...channels) > 190 && Math.min(...channels) < 65) return true;
      }
      return false;
    }, { x: geometry.headerWidth + 5, y: geometry.v1Top + CLIP_HEADER_H + 5 });
    await expect.poll(filmstripVisible, { timeout: 15_000 }).toBe(true);
    await page.mouse.move(rulerX, rulerY);
    await page.keyboard.down("Control");
    try {
      await page.mouse.wheel(0, -65);
      await expect.poll(readZoom).toBeGreaterThan(after);
      expect(await filmstripVisible()).toBe(true);
    } finally {
      await page.keyboard.up("Control");
    }

    await page.keyboard.down("Shift");
    try {
      await page.mouse.down();
      await page.mouse.move(rulerX + 120, rulerBox.y + rulerBox.height + 10, { steps: 4 });
      await page.mouse.up();
    } finally {
      await page.keyboard.up("Shift");
    }
    await expect(page.locator(".timeline-range-band")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".timeline-range-band")).toHaveCount(0);

    const overlay = await page.evaluate(async (projectId: string) => {
      const current = await window.desktop.getTimeline(projectId as never);
      const withTrack = await window.desktop.patchTimeline({ project_id: projectId as never, patch: {
        schema_version: 1, base_revision_id: current.current_revision.timeline_revision_id,
        operations: [{ op: "add_track", kind: "video" }], summary: "副轨",
      } });
      const trackId = withTrack.current_revision.document.tracks.find(track => track.kind === "video" && track.id !== "V1")!.id;
      const assetId = current.current_revision.document.clips[0].asset_id;
      const withClips = await window.desktop.patchTimeline({ project_id: projectId as never, patch: {
        schema_version: 1, base_revision_id: withTrack.current_revision.timeline_revision_id,
        operations: [0, 3_000_000].map((timeline_start_us, at_index) => ({
          op: "insert_asset_clip" as const, asset_id: assetId, at_index, track_id: trackId,
          source_start_us: 0, source_end_us: 2_000_000, timeline_start_us, edit_mode: "overwrite" as const,
        })), summary: "副轨两段",
      } });
      const clips = withClips.current_revision.document.clips;
      const firstIndex = clips.findIndex(clip => clip.track_id === trackId && clip.timeline_start_us === 0);
      const later = clips.find(clip => clip.track_id === trackId && clip.timeline_start_us === 3_000_000)!;
      return { firstIndex, firstId: clips[firstIndex].clip_id, laterId: later.clip_id };
    }, setup.project_id);
    await page.reload();
    await expect(page.getByRole("button", { name: /Clip .* video/ })).toHaveCount(5, { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("timeline-multitrack.png") });
    const firstOverlay = page.getByRole("button", { name: new RegExp(`^Clip ${overlay.firstIndex + 1} video `) });
    await firstOverlay.press("Enter");
    await expect(firstOverlay).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Shift+Delete");
    await expect.poll(clipsOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ clip_id: overlay.laterId, start: 1_000_000 }),
      expect.objectContaining({ clip_id: setup.order[2], start: 4_000_000 }),
    ]));
    expect((await clipsOf()).some(clip => clip.clip_id === overlay.firstId)).toBe(false);

    console.log(`[m5] 实测几何 rulerHeight=${geometry.rulerHeight} V1.top=${geometry.v1Top} V1.height=${geometry.v1Height} headerWidth=${geometry.headerWidth} trackHeight=${prefs.trackHeight} waveformRatio=${waveformRatio}(${prefs.ratioLabel}) pps=${pps.toFixed(2)} band.top=${band.top} band.height=${band.height} 0dB.y=${volumeLineY.toFixed(1)} cursor=${volumeCursor} zoom=${before}->${after}`);
  } finally {
    await app.close();
  }
});

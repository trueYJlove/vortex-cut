import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { expect, test, type Page, type ElectronApplication } from "@playwright/test";
import type { DesktopApi as PreloadDesktopApi } from "../electron/preload/index.js";
import type { TimelinePatchOperation } from "../../../packages/contracts/src/index.js";
import { sanitizeErrorDetail } from "../electron/main/logging.js";
import { expectCurrentProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const { _electron: electron } = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// E2E runs outside the app tsconfig; playwright transpiles without typechecking.
// This declaration mirrors src/env.d.ts so the file also passes a standalone tsc.
// importAssetByFixture is the new benchmark channel (preload/main added in this change).
declare global {
  interface Window {
    desktop: Omit<PreloadDesktopApi, "importAssetByFixture"> & {
      importAssetByFixture(input: { project_id: string; fixture_file: string }): Promise<{ grant: unknown; asset: { asset_id: string; media_info: { duration_us: number } | null }; media_url: string | null; } | null>;
    };
  }
}

interface FixtureEntry { file: string; sha256: string; duration_s: number; audio?: string }
interface ScenarioFixture {
  file?: string; sha256?: string; duration_s: number; size: string; fps: number;
  recipe: string; files?: FixtureEntry[];
}

/** What a scene assembly reports back to the result sample. */
interface ExtraScope {
  scope: string;
  unavailable?: string[];
  extra?: Record<string, unknown>;
}

/**
 * One measured scene assembly. `inPage` runs serialized INSIDE the editor page
 * (playwright page.evaluate): it imports its fixture files via
 * window.desktop.importAssetByFixture, builds the timeline and returns scene
 * extras. It must be fully self-contained — playwright serializes the function
 * source, so module-scope helpers/closures are NOT available in the page.
 */
interface SceneRecipe {
  scenario: string;
  label: string;
  /** Media files that must exist in the fixture manifest. */
  media: string[];
  /** True when the recipe imports the full distinct media family. */
  distinct?: boolean;
  inPage(fixtureFiles: string[]): unknown;
  scope: string;
  unavailable?: string[];
  /**
   * Node-side hook invoked once per run right before the playback measurement
   * loop (F06: start an export while playing). Must return plain-serializable
   * extras merged into scene_extra; never throw after side effects without
   * recording them — failures here invalidate the run.
   */
  startBackground?(page: Page): Promise<Record<string, unknown>>;
  /** Node-side hook invoked after the playback loop; observes task drain. */
  finishBackground?(page: Page): Promise<Record<string, unknown>>;
  /**
   * C20c A/B：revision 切换相位（置于播放相位之后，前序负载保持与
   * G0/c20t 基线可比）。text-edit = 播放头移位 + 默认文本按钮（字幕编辑，
   * 输入不变 → v2 换装路径；无字幕场景适用）；undo-redo = Ctrl+Z/Ctrl+Y
   * 服务端 revision 导航（字幕铺满场景适用——F02/F04/F02P）。省略 = 该场景
   * 不跑 revision 相位。
   */
  revisionPhase?: "text-edit" | "undo-redo";
}

const assembleF01 = async (files: string[]): Promise<object> => {
  const project = await window.desktop.createProject({ name: "B00 F01" });
  const imported = await window.desktop.importAssetByFixture({ project_id: project.project_id, fixture_file: files[0] });
  if (!imported) throw new Error("Fixture import cancelled");
  await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "full_asset", asset_id: imported.asset.asset_id as never }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  return {};
};

const assembleF02 = async (files: string[]): Promise<object> => {
  // 项目名由测试体注入（B00 F02）——F02P 复用本装配，不能硬编码
  // "B00 F02"，否则 expectCurrentProject("B00 F02P") 断言失败（B11-D1 首次
  // E2E 实跑暴露；缺省值保持 F02 单独可读）。
  const projectName = (window as { __benchProjectName?: string }).__benchProjectName ?? "B00 F02";
  // 段外残差分段(D11 后继):时间线装配链各段耗时——只加 performance.now()
  // 记账,不改任何调用序列。
  const t0 = performance.now();
  const project = await window.desktop.createProject({ name: projectName });
  const tCreateProject = performance.now();
  const imported = await window.desktop.importAssetByFixture({ project_id: project.project_id, fixture_file: files[0] });
  if (!imported) throw new Error("Fixture import cancelled");
  const tImport = performance.now();
  const api = window.desktop;
  const created = await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "empty" }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  const tCreateTimeline = performance.now();
  let revisionId = created.current_revision.timeline_revision_id;
  const segmentUs = 1_000_000;
  const total = 900;
  const patchBatchMs: number[] = [];
  for (let start = 0; start < total; start += 100) {
    const batchT0 = performance.now();
    const operations: TimelinePatchOperation[] = [];
    for (let index = 0; index < 100; index++) {
      const sourceStart = (start + index) * segmentUs;
      operations.push({ op: "insert_asset_clip", asset_id: imported.asset.asset_id as never, at_index: start + index,
        source_start_us: sourceStart, source_end_us: sourceStart + segmentUs });
    }
    const patched = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
      base_revision_id: revisionId, operations, summary: `F02 segments ${start}-${start + 99}` } });
    revisionId = patched.current_revision.timeline_revision_id;
    patchBatchMs.push(performance.now() - batchT0);
  }
  // 900 x 1s captions aligned with segments; import validates >=0.2s and no overlap.
  const entries = Array.from({ length: total }, (_, index) => ({
    start_us: index * segmentUs, end_us: (index + 1) * segmentUs, text: `F02 caption ${index + 1}`,
  }));
  const tPatchesDone = performance.now();
  await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: revisionId,
    operations: [{ op: "import_captions", entries, preset_id: "default-bottom", replace_existing: true }],
    summary: "F02 captions 900" } });
  const tCaptions = performance.now();
  return { segments: total, captions: total,
    assemble_timings: {
      create_project_ms: Math.round(tCreateProject - t0),
      import_fixture_ms: Math.round(tImport - tCreateProject),
      create_timeline_ms: Math.round(tCreateTimeline - tImport),
      patch_batches_total_ms: Math.round(tPatchesDone - tCreateTimeline),
      patch_batch_ms: patchBatchMs.map(v => Math.round(v)),
      captions_patch_ms: Math.round(tCaptions - tPatchesDone),
      in_page_total_ms: Math.round(tCaptions - t0),
    } };
};

const assembleF04 = async (files: string[]): Promise<object> => {
  const project = await window.desktop.createProject({ name: "B00 F04" });
  const api = window.desktop;
  const assets = [];
  for (const file of files) {
    const imported = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: file });
    if (!imported) throw new Error(`Fixture import cancelled: ${file}`);
    assets.push(imported.asset.asset_id);
  }
  const created = await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "empty" }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  let revisionId = created.current_revision.timeline_revision_id;
  const overlayTracks = ["V2", "V3", "V4"];
  const windowUs = 1_000_000;
  // Timeline shape: 24 x 2s spine slots (V1) = 48s; each overlay track (V2-V4)
  // carries 24 x 1s clips covering 0-24s, all three live simultaneously (4 layers).
  // 48 distinct assets stay within Core list_assets' default 50-item page (see
  // make_fixtures note — editor loads only the first page after reload).
  const slots = 24;
  const spineOps: TimelinePatchOperation[] = [];
  for (let slot = 0; slot < slots; slot++) {
    spineOps.push({ op: "insert_asset_clip", asset_id: assets[slot % assets.length] as never, at_index: slot,
      source_start_us: 0, source_end_us: 2_000_000, track_id: "V1" });
  }
  const spine = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: spineOps, summary: "F04 spine 50x2s" } });
  revisionId = spine.current_revision.timeline_revision_id;
  const trackOps: TimelinePatchOperation[] = overlayTracks.map(track => ({ op: "add_track", kind: "video" as const }));
  const tracked = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: trackOps, summary: "F04 overlay tracks V2-V4" } });
  revisionId = tracked.current_revision.timeline_revision_id;
  const overlayClipsAll: Array<{ clip_id: string; track_id: string; timeline_start_us: number }> = [];
  const transformByTrack: Record<string, { x: number; y: number; scale: number }> = {
    V2: { x: 0.25, y: 0.25, scale: 0.3 }, V3: { x: 0.75, y: 0.25, scale: 0.3 }, V4: { x: 0.5, y: 0.75, scale: 0.3 },
  };
  // Each overlay track carries 50 x 1s clips appended contiguously (0-50s), so
  // V2+V3+V4 are all live simultaneously over the spine (4 visual layers) and
  // same-track overlap never occurs — no position ops needed. PiP placement is
  // expressed by static transforms. One patch carries at most 100 ops.
  let overlayCount = 0;
  for (let lane = 0; lane < overlayTracks.length; lane++) {
    const track = overlayTracks[lane];
    const batch: TimelinePatchOperation[] = [];
    for (let slot = 0; slot < slots; slot++) {
      const order = slot * overlayTracks.length + lane;
      batch.push({ op: "insert_asset_clip", asset_id: assets[(order + 1) % assets.length] as never, at_index: slot,
        source_start_us: 0, source_end_us: windowUs, track_id: track });
      overlayCount++;
    }
    const inserted = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
      base_revision_id: revisionId, operations: batch, summary: `F04 overlay ${track} inserts` } });
    revisionId = inserted.current_revision.timeline_revision_id;
    const trackClips = inserted.current_revision.document.clips.filter(clip => clip.track_id === track);
    if (trackClips.length !== slots) throw new Error(`F04 overlay ${track} insert mismatch: ${trackClips.length} != ${slots}`);
    overlayClipsAll.push(...trackClips);
    const transformBatch: TimelinePatchOperation[] = trackClips.map(clip =>
      ({ op: "set_clip_transform", clip_id: clip.clip_id as never, transform: transformByTrack[track] }));
    for (let offset = 0; offset < transformBatch.length; offset += 100) {
      const positioned = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
        base_revision_id: revisionId, operations: transformBatch.slice(offset, offset + 100), summary: `F04 ${track} transforms` } });
      revisionId = positioned.current_revision.timeline_revision_id;
    }
  }
  if (overlayCount !== slots * overlayTracks.length) throw new Error(`F04 overlay count mismatch: ${overlayCount}`);
  // 12 captions over the 48s spine, 4s apart (>=0.2s, no overlap).
  const captionEntries = Array.from({ length: 12 }, (_, index) => ({
    start_us: index * 4_000_000, end_us: index * 4_000_000 + 3_000_000, text: `F04 caption ${index + 1}`,
  }));
  await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: revisionId,
    operations: [{ op: "import_captions", entries: captionEntries, preset_id: "default-bottom", replace_existing: true }],
    summary: "F04 captions 12" } });
  return { assets: assets.length, spine_clips: slots, overlay_clips: overlayCount, captions: 12, visual_layers: 4 };
};

const assembleF07 = async (files: string[]): Promise<object> => {
  const avFile = files.find(name => name === "F07.mp4") ?? files[0];
  const silentFile = files.find(name => name.endsWith("-mute.mp4")) ?? files[files.length - 1];
  const project = await window.desktop.createProject({ name: "B00 F07" });
  const api = window.desktop;
  const av = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: avFile });
  const silent = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: silentFile });
  if (!av || !silent) throw new Error("Fixture import cancelled");
  const created = await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "empty" }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  let revisionId = created.current_revision.timeline_revision_id;
  // 12s source split into 4 x 3s segments (covers the whole source exactly);
  // timeline order 4x/2x/1x/0.5x (fast first, keeps the playhead moving for the
  // ready-check; full matrix still covers 0.25x..4x playback rates).
  const segUs = 3_000_000;
  const speeds = [4000, 2000, 1000, 500];
  const insertOps: TimelinePatchOperation[] = speeds.map((speed, index) => ({ op: "insert_asset_clip",
    asset_id: av.asset.asset_id as never, at_index: index, source_start_us: index * segUs,
    source_end_us: (index + 1) * segUs, speed_milli: speed, track_id: "V1" }));
  const inserted = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: insertOps, summary: "F07 speed matrix 0.5/1/2/4x" } });
  revisionId = inserted.current_revision.timeline_revision_id;
  const v1Clips = inserted.current_revision.document.clips.filter(clip => clip.track_id === "V1")
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  if (v1Clips.length !== speeds.length) throw new Error("F07 speed matrix incomplete");
  // Video-only fixture segment appended after the matrix (no audio stream at all).
  const silentOp = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: [{ op: "insert_asset_clip", asset_id: silent.asset.asset_id as never,
      at_index: v1Clips.length, source_start_us: 0, source_end_us: 2_000_000, track_id: "V1" }], summary: "F07 video-only segment" } });
  revisionId = silentOp.current_revision.timeline_revision_id;
  // Mute (then unmute) the 2x segment — the audio-toggle dimension of F07.
  const muteOp = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: [
      { op: "set_audio", clip_id: v1Clips[2].clip_id as never, enabled: false, gain_db: 0 },
      { op: "set_audio", clip_id: v1Clips[2].clip_id as never, enabled: true, gain_db: 0 },
    ], summary: "F07 mute/unmute 2x segment" } });
  revisionId = muteOp.current_revision.timeline_revision_id;
  // Known limitation (registered in the report): same-source double-position mix
  // cannot be assembled through the patch contract — video-kind assets are
  // rejected on A1 (audio track takes pure-audio assets only) and cross-track
  // overlap stalls the preview playhead. Measured workload = speed matrix +
  // video-only segment + audio toggle.
  return { speed_clips: speeds.length, video_only_clips: 1, audio_toggled: 1 };
};

/**
 * F03: 60-minute source, timeline uses only head/middle/tail 10s windows
 * (30s total). Deep-seek scenario — with B12 Range demux the tail window must
 * read only the target GOP area, not the whole file (probe/hash still read it;
 * the playback-side byte accounting is registered as unavailable here).
 */
const assembleF03 = async (files: string[]): Promise<object> => {
  const project = await window.desktop.createProject({ name: "B00 F03" });
  const api = window.desktop;
  const imported = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: files[0] });
  if (!imported) throw new Error("Fixture import cancelled");
  const durationUs = imported.asset.media_info?.duration_us ?? 0;
  if (durationUs < 3_600_000_000) throw new Error(`F03 source shorter than 60min: ${durationUs}`);
  const windowUs = 10_000_000;
  const created = await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "empty" }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  let revisionId = created.current_revision.timeline_revision_id;
  const windows = [0, Math.round(durationUs / 2) - windowUs / 2, durationUs - windowUs];
  const ops: TimelinePatchOperation[] = windows.map((sourceStart, index) => ({ op: "insert_asset_clip",
    asset_id: imported.asset.asset_id as never, at_index: index, source_start_us: sourceStart,
    source_end_us: sourceStart + windowUs, track_id: "V1" }));
  const patched = await api.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1,
    base_revision_id: revisionId, operations: ops, summary: "F03 head/middle/tail 10s windows" } });
  const clips = patched.current_revision.document.clips;
  if (clips.length !== 3) throw new Error(`F03 window count mismatch: ${clips.length}`);
  return { source_duration_s: Math.round(durationUs / 1_000_000), windows_s: windows.map(us => Math.round(us / 1_000_000)), clips: 3 };
};

/** F05: 4K/60fps long-GOP source as a full-asset timeline (format ceiling probe). */
const assembleF05 = async (files: string[]): Promise<object> => {
  const project = await window.desktop.createProject({ name: "B00 F05" });
  const api = window.desktop;
  const imported = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: files[0] });
  if (!imported) throw new Error("Fixture import cancelled");
  await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "full_asset", asset_id: imported.asset.asset_id as never }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  return { size: "3840x2160", fps: 60 };
};

/**
 * F06: full-asset playback while a final export runs in the background
 * (competition scenario). startBackground issues the export via the E2E
 * destination grant (AIVS_E2E_EXPORT_PATH); the measured playback window is
 * the competition workload. finishBackground polls the job to a terminal state
 * (bounded) and reports it — export outcome is recorded, not asserted.
 */
const assembleF06 = async (files: string[]): Promise<object> => {
  const project = await window.desktop.createProject({ name: "B00 F06" });
  const api = window.desktop;
  const imported = await api.importAssetByFixture({ project_id: project.project_id, fixture_file: files[0] });
  if (!imported) throw new Error("Fixture import cancelled");
  await api.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
    source: { kind: "full_asset", asset_id: imported.asset.asset_id as never }, default_layout: "fit", caption_preset_id: "default-bottom" } });
  // Persist for the Node-side start/finish hooks (page state survives until reload;
  // hooks read it after the post-reload assembly? No — hooks run pre-reload, this
  // assignment happens during assembly, so it is available. After reload the page
  // context is gone, hence startBackground runs BEFORE page.reload() ordering... it
  // runs after reload in the run loop; re-set it there via getTimeline? Simplest:
  // startBackground looks the project up by name through listProjects.
  return {};
};

const startBackgroundF06 = async (page: Page): Promise<Record<string, unknown>> => {
  const started = await page.evaluate(async () => {
    const api = window.desktop;
    const projects = await api.listProjects({ limit: 100 });
    const current = projects.items.find(item => item.name === "B00 F06");
    if (!current) throw new Error("F06 export: project not found");
    const destination = await api.chooseExportDestination(current.project_id);
    if (!destination) throw new Error("F06 export: destination grant cancelled");
    const created = await api.createExport({ project_id: current.project_id, export: { destination_grant_id: destination.destination_grant_id } });
    return { job_id: created.job.job_id, export_status_at_start: created.job.status };
  });
  return { export_started_at: Date.now(), ...started };
};

const finishBackgroundF06 = async (page: Page): Promise<Record<string, unknown>> => {
  const drained = await page.evaluate(async () => {
    const api = window.desktop;
    const projects = await api.listProjects({ limit: 100 });
    const current = projects.items.find(item => item.name === "B00 F06");
    if (!current) return { export_status: "no-project" };
    const exports = await api.listExports({ project_id: current.project_id, limit: 1 });
    const record = exports.items[0];
    if (!record) return { export_status: "no-export-record" };
    return { export_status: record.export_record.status, export_size_bytes: record.export_record.size_bytes };
  }).catch(error => ({ export_status: "poll-failed", error_type: error instanceof Error ? error.name : "unknown" }));
  return { export_finished_at: Date.now(), ...drained };
};

const RECIPES: Record<string, SceneRecipe> = {
  "F01": { scenario: "F01", label: "F01/basic-cfr", media: ["F01.mp4"], inPage: assembleF01,
    revisionPhase: "text-edit",
    scope: "complete App, source CFR, no PiP/captions; app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (text-edit)" },
  "F02": { scenario: "F02", label: "F02/900s-900splices-900captions", media: ["F02.mp4"], inPage: assembleF02,
    revisionPhase: "undo-redo",
    scope: "complete App, 900x1s same-source segments + 900 captions (IR at 27000-frame cap); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (undo-redo)" },
  // B11-D1 spike：320x180 代理解码输入（夹具级替换，不动 source-resolver
  // 默认策略）——检验解码驻留平台随帧字节的缩放。默认不跑（AIVS_PERF_
  // SCENARIOS 显式选入），装配复用 F02（同 900 段/字幕，仅媒体分辨率不同）。
  "F02P": { scenario: "F02P", label: "F02P/320x180-proxy-decode-900s", media: ["F02P.mp4"], inPage: assembleF02,
    revisionPhase: "undo-redo",
    scope: "complete App, same F02 assembly over a 320x180 proxy decode input (B11-D1 residency scaling spike); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (undo-redo)" },
  "F04": { scenario: "F04", label: "F04/48-assets-4-layers", media: [], distinct: true, inPage: assembleF04,
    revisionPhase: "undo-redo",
    scope: "complete App, 48 assets/4 visual layers (V1 spine + V2-V4 simultaneous PiP transforms) + 12 captions; 48 kept within list_assets default page (pagination gap registered); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (undo-redo)" },
  "F07": { scenario: "F07", label: "F07/speed-matrix-overlap", media: ["F07.mp4", "F07-mute.mp4"], inPage: assembleF07,
    revisionPhase: "text-edit",
    scope: "complete App, speed matrix 0.5x/1x/2x/4x + video-only segment + mute/unmute toggle; dual-position mix NOT assembled (product constraints, B00-B report §5); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (text-edit)" },
  "F03": { scenario: "F03", label: "F03/60min-deep-seek", media: ["F03.mp4"], inPage: assembleF03,
    revisionPhase: "text-edit",
    scope: "complete App, 60min source, head/middle/tail 10s windows (deep seek); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (text-edit)",
    unavailable: ["playback-side bytes-read accounting (B12 range metrics surface pending)"] },
  "F05": { scenario: "F05", label: "F05/4k60-full-asset", media: ["F05.mp4"], inPage: assembleF05,
    revisionPhase: "text-edit",
    scope: "complete App, 4K/60fps source full-asset timeline (format ceiling probe); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (text-edit)",
    unavailable: ["proxy generation on unsupported decode (format accepted by WebCodecs in this build)",
      "seek events (observed defect: 4K60 seek path records 0 events; decode fails silently)"] },
  "F06": { scenario: "F06", label: "F06/playback-with-export", media: ["F01.mp4"], inPage: assembleF06,
    startBackground: startBackgroundF06, finishBackground: finishBackgroundF06,
    revisionPhase: "text-edit",
    scope: "complete App, full-asset playback while a final export runs (competition workload); app cold launch + warm seeks; OS cache uncontrolled; +revision-switch phase (text-edit)" },
};

test.skip(process.env.AIVS_PERF_RUN !== "1", "Explicit benchmark entry only; not an ordinary E2E load");
for (const [sceneKey, recipe] of Object.entries(RECIPES)) {
  test(`B00 complete editor ${recipe.label} (not standalone probe)`, async () => {
    // 场景选择器（缺省 = 全跑，G0 冻结面不变；B11-D1 spike 场景 F02P 必须
    // 显式选入，避免全量基线轮被拉长）。同时供 T1/T2 A/B 轮按场景选跑。
    // 环境变量双名兼容：runner 设 AIVS_PERF_SCENES（a087ced 起），直连
    // playwright 的 spike 轮设 AIVS_PERF_SCENARIOS（B11-D 备忘录 §2）——
    // 此前两名错位，守卫从未生效，选择全靠 -g 正则（C20c 冒烟发现）。
    const onlyScenarios = process.env.AIVS_PERF_SCENES ?? process.env.AIVS_PERF_SCENARIOS;
    if (onlyScenarios && !onlyScenarios.split(",").map(s => s.trim()).includes(recipe.scenario)) {
      test.skip(true, `scenario not selected (AIVS_PERF_SCENES=${onlyScenarios})`);
    }
    const output = process.env.AIVS_PERF_RESULT!;
    const fixtures = process.env.AIVS_PERF_FIXTURES!;
    const manifest = JSON.parse(await readFile(join(fixtures, "manifest.json"), "utf8"));
    // F06 reuses the F01 media family; the runner validated that fallback.
    // Every other scenario must match its own fixture exactly — a silent
    // F01 fallback would corrupt measurement (F02P must not run 640x360 media).
    const fixture: ScenarioFixture = manifest.fixtures[recipe.scenario]
      ?? (recipe.scenario === "F06" ? manifest.fixtures.F01 : undefined);
    if (!fixture) throw new Error(`Fixture missing for scenario ${recipe.scenario}`);
    const seedBase = Number(process.env.AIVS_PERF_SEED ?? 20260908);
    const mediaFiles: FixtureEntry[] = fixture.files
      ?? [{ file: fixture.file!, sha256: fixture.sha256!, duration_s: fixture.duration_s }];
    for (const entry of mediaFiles) {
      const mediaPath = join(fixtures, entry.file);
      const digest = createHash("sha256").update(await readFile(mediaPath)).digest("hex");
      if (digest !== entry.sha256) throw new Error(`Fixture SHA mismatch: ${entry.file}`);
    }
    if (recipe.media.length && recipe.media.some(name => !mediaFiles.some(entry => entry.file === name))) {
      throw new Error(`Fixture manifest lacks required media for ${recipe.scenario}: ${recipe.media.join(",")}`);
    }
    const runs = Number(process.env.AIVS_PERF_RUNS ?? 5);
    const seeks = Number(process.env.AIVS_PERF_SEEKS ?? 100);
    const seconds = Number(process.env.AIVS_PERF_PLAY_SECONDS ?? 300);
    // 拖拽补测相位与 seek 相位同形状（100×(拖动~120ms+300ms)≈+45s/run），
    // 计入超时预算（seeks*10 → seeks*10 + 45 折入 150 余量）。
    test.setTimeout(((2 * runs + 1) * (seconds + seeks * 10 + 200) + 900) * 1000);
    const results: unknown[] = [];
    const config = JSON.parse(await readFile(join(output, "run-config.json"), "utf8"));
    // Separate launches permit opt-in diagnostics overhead A/B. First run is warmup only.
    for (let runIndex = -1; runIndex < runs; runIndex++) {
      for (const enabled of runIndex < 0 ? [true] : [false, true]) {
        const runDir = join(output, recipe.scenario, `${runIndex < 0 ? "warmup" : `run-${runIndex}`}-${enabled ? "on" : "off"}`);
        await mkdir(runDir, { recursive: true });
        const app = await launchEditor(mediaFiles, fixtures, runDir);
        let sample: unknown;
        let setupRecoveryCount = 0;
        try {
          const page = await app.firstWindow();
          await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
          await page.evaluate(() => window.desktop.getRuntime());
          await page.waitForFunction(() => Boolean((window as any).__editorPerf));
          await page.evaluate(on => (window as any).__editorPerf.configure(on), enabled);
          const started = Date.now();
          await page.evaluate(name => { (window as { __benchProjectName?: string }).__benchProjectName = name; }, `B00 ${recipe.scenario}`);
          const extra = await page.evaluate(recipe.inPage, mediaFiles.map(entry => entry.file));
          // D11 后继(段外残差分段测量):ready_ms 中装配四段(manifest/parse/
          // inject/window)之外的部分此前未分段(独立验收 §6.2)。inPage 返回
          // 的时间线分段(createProject/importAsset/createTimeline/patch 累计/
          // captions)与 node 侧后续相位耗时合并进 scene_extra——只加测量,
          // 不改任何装配动作序列与轮询语义,历史形状兼容(extra 键新增)。
          const assembleTimings = (extra && typeof extra === "object" && "assemble_timings" in (extra as Record<string, unknown>))
            ? (extra as Record<string, unknown>).assemble_timings : null;
          const tProject = Date.now();
          await expectCurrentProject(page, `B00 ${recipe.scenario}`);
          const tStatusPoll = Date.now();
          // Baseline bug: media tickets can race project loading (amplified by
          // F04's asset count — assets beyond list_assets' default page lose tickets).
          // Recovery = explicit refresh-assets (re-issues tickets) + retry-synthetic,
          // every attempt counted in setup_recovery_count, never a clean start.
          // 装配竞态恢复（2026-09-13 升级登记 3/60 启动）："预览状态 synthetic
          // 但 canvas 不可见/不存在" 的已知脆点此前无恢复路径——canvas 可见性
          // 超时且状态仍为 synthetic 时 page.reload 重建装配再试（≤2 次，计入
          // setup_recovery_count——分析时剔除该 run 的 ready 绝对值）；与既有
          // 票据竞态恢复（计数披露）同型。超限或状态非 synthetic → 按原样
          // 响亮失败（恢复分支的机会性验证：bounded + 失败即抛，最坏情形 =
          // 原行为；真实竞态现场的恢复经计数可审计）。
          const synthStatus = async () =>
            (await page.getByLabel("预览状态", { exact: true }).textContent()) === "合成预览";
          let canvasReady = false;
          let tStatusSettled = 0; let tCanvasVisible = 0;
          for (let setupAttempt = 0; setupAttempt < 3 && !canvasReady; setupAttempt++) {
            if (setupAttempt > 0) setupRecoveryCount++;
            await page.reload();
            await page.waitForFunction(() => Boolean((window as any).__editorPerf));
            await page.evaluate(on => (window as any).__editorPerf.configure(on), enabled);
            await expectCurrentProject(page, `B00 ${recipe.scenario}`);
            await expect.poll(async () => {
              if (await page.getByRole("button", { name: "重试合成预览", exact: true }).isVisible()) return "fallback";
              return (await page.getByLabel("预览状态", { exact: true }).textContent()) === "合成预览" ? "ready" : "loading";
            }, { timeout: 60000 }).not.toBe("loading");
            for (let attempt = 0; attempt < 3; attempt++) {
              const retry = page.getByRole("button", { name: "重试合成预览", exact: true });
              if (!(await retry.isVisible())) break;
              setupRecoveryCount++;
              const refreshButton = page.getByRole("button", { name: "刷新素材库" });
              if (await refreshButton.isEnabled().catch(() => false)) await refreshButton.click();
              await page.waitForTimeout(1000);
              await retry.click();
              await expect.poll(async () => {
                if (await page.getByRole("button", { name: "重试合成预览", exact: true }).isVisible()) return "fallback";
                return (await page.getByLabel("预览状态", { exact: true }).textContent()) === "合成预览" ? "ready" : "loading";
              }, { timeout: 60000 }).not.toBe("loading");
            }
            try {
              await expect(page.locator(".synthetic-canvas")).toBeVisible({ timeout: 60000 });
              canvasReady = true;
            } catch (error) {
              if (setupAttempt >= 2 || !(await synthStatus())) throw error;
            }
          }
          await expect(page.getByLabel("预览状态", { exact: true })).toHaveText("合成预览", { timeout: 60000 });
          tStatusSettled = Date.now();
          // Require an advancing ready preview, not merely an allocated canvas.
          await page.getByRole("button", { name: "播放", exact: true }).click();
          await expect.poll(async () => Number(await page.getByRole("slider", { name: "时间线播放头" }).getAttribute("aria-valuenow")), { timeout: 30000 }).toBeGreaterThan(500000);
          tCanvasVisible = Date.now();
          await page.getByRole("button", { name: "暂停", exact: true }).click();
          const readyMs = Date.now() - started;
          // D11-① R3 驻留预警采集:预警在 PreviewSession.create 时按 IR 帧数
          // 计算(不依赖实际解码量),经 lastError → .synthetic-metrics 面板
          // 渲染。之后 decode 失败可覆盖 lastError 通道——null=未渲染(无预警
          // 或被覆盖),如实留样,不视为运行失败(响亮失败边界不变)。
          const residencyWarning = await page.evaluate(() => {
            const text = document.querySelector(".synthetic-metrics")?.textContent ?? "";
            return text.includes("长素材解码驻留预警") ? text : null;
          });
          // C20-T2 A/B 采数:reset() 清空事件流,ready 分段(manifest/parse/
          // window/inject)在本次重载后装配期间记录,必须先于 reset 捕获。
          // v1 路径不产生 ready_* 事件,样本中该字段为空集;off 通道同样为空。
          const readySegments = await page.evaluate(() => {
            const snapshot = (window as any).__editorPerf.snapshot();
            return {
              counts: snapshot.counts,
              durations: snapshot.durations,
              events: snapshot.events.filter((event: { kind: string }) => event.kind.startsWith("ready_")),
            };
          });
          await page.evaluate(() => (window as any).__editorPerf.reset());
          const seekActions: number[] = [];
          const slider = page.getByRole("slider", { name: "时间线播放头" });
          const box = await slider.boundingBox(); if (!box) throw new Error("No timeline slider");
          let seed = seedBase;
          for (let i = 0; i < seeks; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const at = Date.now();
            await slider.click({ position: { x: 1 + (seed / 2**32) * (box.width - 2), y: box.height / 2 } });
            // Fixed interval is part of the workload, NOT a measured frame presentation time.
            await page.waitForTimeout(300);
            seekActions.push(Date.now() - at);
          }
          const seekMetrics = await page.evaluate(() => (window as any).__editorPerf.snapshot());
          await page.evaluate(() => (window as any).__editorPerf.reset());
          // 矩阵"拖动/缩放输入至下一次绘制提交"补测相位（2026-09-15）：
          // 真实 pointer 事件序列拖拽进度条（pointerdown → 拖动 pointermove
          // ×3 → pointerup 落定），产品探针记 drag_to_submit（seek 入口 →
          // 结果帧 compose 提交，与 submitted 同口径）。与 seek 相位同负载
          // 形状（100 次操作 + 固定间隔）；时间线缩放（Ctrl+wheel）只落
          // timeline 层不触发合成预览路径，登记为 unavailable 维度。
          const dragActions: number[] = [];
          let dragSeed = (seedBase ^ 0x5eed) >>> 0;
          for (let i = 0; i < seeks; i++) {
            dragSeed = (Math.imul(dragSeed, 1664525) + 1013904223) >>> 0;
            const at = Date.now();
            const x0 = 1 + (dragSeed / 2**32) * (box.width - 2);
            await page.mouse.move(box.x + x0, box.y + box.height / 2);
            await page.mouse.down();
            let x = x0;
            for (let step = 0; step < 3; step++) {
              dragSeed = (Math.imul(dragSeed, 1664525) + 1013904223) >>> 0;
              x = Math.max(1, Math.min(box.width - 2, x + ((dragSeed / 2**32) - 0.5) * 120));
              await page.mouse.move(box.x + x, box.y + box.height / 2, { steps: 2 });
              await page.waitForTimeout(30);
            }
            await page.mouse.up();
            await page.waitForTimeout(300);
            dragActions.push(Date.now() - at);
          }
          const dragMetrics = await page.evaluate(() => (window as any).__editorPerf.snapshot());
          await page.evaluate(() => (window as any).__editorPerf.reset());
          // Scene-specific background workload (F06) starts before the measured
          // playback loop and is drained afterwards; extras merge into scene_extra.
          let backgroundExtra: Record<string, unknown> = {};
          if (recipe.startBackground) backgroundExtra = await recipe.startBackground(page);
          const processSamples: unknown[] = [];
          const stopAt = Date.now() + (runIndex < 0 ? Math.min(seconds, 5) : seconds) * 1000;
          while (Date.now() < stopAt) {
            const play = page.getByRole("button", { name: "播放", exact: true });
            if (await play.isVisible()) await play.click();
            await page.waitForTimeout(1000);
            processSamples.push(await app.evaluate(({ app: mainApp }) => mainApp.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, cpu: item.cpu, memory: item.memory }))));
          }
          const pause = page.getByRole("button", { name: "暂停", exact: true });
          if (await pause.isVisible()) await pause.click();
          const playbackMetrics = await page.evaluate(() => (window as any).__editorPerf.snapshot());
          if (recipe.finishBackground) {
            try { backgroundExtra = { ...backgroundExtra, ...(await recipe.finishBackground(page)) }; }
            catch { backgroundExtra = { ...backgroundExtra, background_finish: "failed" }; }
          }
          // C20c A/B：revision 切换相位（置于播放相位之后——前序相位负载保持
          // 与 G0/c20t 基线可比，不被编辑污染）。每个转换：revision 基线读取 →
          // perf reset → 动作（默认文本按钮 / Ctrl+Z / Ctrl+Y，window 级监听
          // 无需焦点）→ 轮询 revision id 前进（比预览状态轮询硬——loading 窗口
          // 太短会错过造成假通过）→ 轮询回到"合成预览"（fallback 也算失败——
          // 换装路径回归必须响亮失败）→ 300ms 收敛（refineAfterDrag 去抖）→
          // 快照。v2 记 ready_manifest/parse + window_fetch + seek(refine)；
          // v1 走 replaceIr 同路径（事件流为空，wall_ms 即 v1 就地换表基线）。
          const revisionTransitions: Array<Record<string, unknown>> = [];
          const revisionCount = Number(process.env.AIVS_PERF_REVISIONS ?? 6);
          if (recipe.revisionPhase) {
            const projectId = await page.evaluate(async (name) => {
              const projects = await window.desktop.listProjects({ limit: 100 });
              const current = projects.items.find(item => item.name === name);
              if (!current) throw new Error(`revision phase: project not found: ${name}`);
              return current.project_id;
            }, `B00 ${recipe.scenario}`);
            // 探针必须读 getTimeline 的 current_revision（HEAD 指针）——
            // listTimelineRevisions 是历史列表（创建序），undo/redo 只移动
            // HEAD 不新增 revision，列表首项永不变（冒烟 c20c-smoke-f01-01
            // warmup-on 失败现场 + Core DB 双 revision 实证）。
            const revisionIdOf = () => page.evaluate(async (pid) =>
              (await window.desktop.getTimeline(pid as never)).current_revision.timeline_revision_id, projectId);
            const slider = page.getByRole("slider", { name: "时间线播放头" });
            const box = await slider.boundingBox(); if (!box) throw new Error("No timeline slider");
            const durationUs = Number(await slider.getAttribute("aria-valuemax") ?? 0);
            for (let i = 0; revisionTransitions.length < revisionCount && Date.now() - started < 900000; i++) {
              const steps: Array<{ action: string; prepare?: () => Promise<void>; run: () => Promise<void> }> = [];
              if (recipe.revisionPhase === "text-edit") {
                // 字幕加在播放头处（3s）：位置轮换避开已存在条目，且夹紧到
                // 距末尾 3.5s 以内（add_caption 时长校验的防御）。播放头移位
                // 属 prepare（不进测量窗）。
                const fraction = Math.min(0.2 + 0.25 * (i % 3),
                  durationUs > 0 ? Math.max(0.05, (durationUs - 3_500_000) / durationUs) : 0.2);
                steps.push({ action: "add-default-text",
                  prepare: async () => {
                    await slider.click({ position: { x: Math.max(1, box.width * fraction), y: box.height / 2 } });
                    await page.waitForTimeout(400); // 播放头外部 seek + 250ms 精修收敛
                  },
                  run: () => page.getByRole("button", { name: "默认文本", exact: true }).click() });
                steps.push({ action: "undo", run: () => page.keyboard.press("Control+z") });
              } else {
                steps.push({ action: i % 2 === 0 ? "undo" : "redo", run: () => page.keyboard.press(i % 2 === 0 ? "Control+z" : "Control+y") });
              }
              for (const step of steps) {
                if (revisionTransitions.length >= revisionCount) break;
                await step.prepare?.();
                const before = await revisionIdOf();
                await page.evaluate(() => (window as any).__editorPerf.reset());
                const at = Date.now();
                await step.run();
                await expect.poll(revisionIdOf, { timeout: 30000 }).not.toBe(before);
                await page.waitForTimeout(500); // 预览 effect 启动（状态可能短暂 loading）
                await expect.poll(async () => page.getByLabel("预览状态", { exact: true }).textContent(),
                  { timeout: 30000 }).toBe("合成预览");
                await page.waitForTimeout(300); // refineAfterDrag 250ms 去抖收敛
                const snapshot = await page.evaluate(() => (window as any).__editorPerf.snapshot());
                revisionTransitions.push({
                  action: step.action,
                  wall_ms: Date.now() - at,
                  result: "ready",
                  counts: snapshot.counts,
                  durations: snapshot.durations,
                  ready_events: (snapshot.events as Array<{ kind: string }>).filter(event => event.kind.startsWith("ready_")),
                  window_fetch_events: (snapshot.events as Array<{ kind: string }>).filter(event => event.kind === "window_fetch"),
                });
              }
            }
          }
          expect(seekMetrics.enabled).toBe(enabled);
          expect(playbackMetrics.enabled).toBe(enabled);
          if (enabled) {
            // F05 observed behavior (2026-09-11): 4K60 seek events are 0 in the
            // complete App (decode path fails silently; registered as a product
            // defect in the B00-B report). The seek count is recorded as-is for
            // that scenario instead of failing the run.
            if (recipe.scenario !== "F05") expect(seekMetrics.counts.seek ?? 0).toBeGreaterThan(0);
            expect(playbackMetrics.counts.submitted ?? 0).toBeGreaterThan(0);
            // C20c A/B：revision 相位必须全部转换到合成预览就绪（换装/重建
            // 路径回归在此响亮失败——不静默记 unavailable）。
            if (recipe.revisionPhase) {
              expect(revisionTransitions).toHaveLength(revisionCount);
              for (const transition of revisionTransitions) expect(transition.result).toBe("ready");
            }
          } else {
            expect(seekMetrics.events).toHaveLength(0);
            expect(playbackMetrics.events).toHaveLength(0);
          }
          const environment = await app.evaluate(async ({ app: mainApp, screen }) => ({ versions: process.versions, platform: process.platform, arch: process.arch, gpu: await mainApp.getGPUInfo("basic"), refresh_hz: screen.getPrimaryDisplay().displayFrequency }));
          Object.assign(environment, { cpu_model: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), os_release: release() });
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent }));
            sample = { schema_version: 2, scenario: recipe.label, run: runIndex, enabled, ready_ms: readyMs, ready_segments: readySegments, setup_recovery_count: setupRecoveryCount,
            residency_warning: residencyWarning,
            workload: { seeks, seed: seedBase, build_mode: "production-diagnostics", code_fingerprint: config.code_fingerprint, revisions: recipe.revisionPhase ? revisionCount : 0 },
            revision_transitions: revisionTransitions,
            seek_action_wall_ms_including_300ms_wait: seekActions, seek: seekMetrics, playback: playbackMetrics, process_samples: processSamples,
            drag_action_wall_ms_including_300ms_wait: dragActions, drag: dragMetrics,
            environment, viewport, fixture_sha256: mediaFiles[0].sha256, fixture_files: mediaFiles.map(entry => ({ file: entry.file, sha256: entry.sha256 })),
            // playback_seconds is the configured value for ALL samples including
            // warmup, whose actual playback is min(seconds, 5)s (pipeline check
            // only). Compare playback counts only across run>=0 samples.
            playback_seconds: seconds,
            playback_seconds_actual: runIndex < 0 ? Math.min(seconds, 5) : seconds,
            scope: recipe.scope, scene_extra: { ...(extra as Record<string, unknown>), ...backgroundExtra,
              // 段外残差分段(D11 后继):node 侧相位耗时 + inPage 时间线分段。
              // 装配段(ready_manifest/parse/inject/window)在 ready_segments;
              // 本表覆盖其余全部链路,ready_ms = 各段之和(严格串行时)。
              ready_phases_outside: {
                t0_to_inpage_end_ms: extra === undefined ? null : Math.max(0, tProject - started),
                project_assert_ms: tStatusPoll - tProject,
                reload_and_status_settle_ms: tStatusSettled - tStatusPoll,
                playhead_start_ms: tCanvasVisible - tStatusSettled,
                total_ready_ms: readyMs,
                ...(assembleTimings ? { in_page: assembleTimings } : {}),
              } },
            unavailable: ["actual presentation", "React commits in non-profiling production React", "audio underrun", "video-frame lifetime", "GPU actual VRAM", "Core RSS", "30–60min memory", "timeline-zoom drag (canvas-only path; drag phase covers playhead scrub)", ...(recipe.unavailable ?? [])] };
          // Screenshot outside timing region; no readback in measured playback.
          // 取证动作,不在测量窗;timeout 显式 10s + 失败不弃样本——F02 分段轮
          // warmup 出现过 screenshot 30s 默认超时整轮失败(样本数据已完整写入
          // result.json 之前 throw,丢失 run-0..2)。纯取证不应有否决权。
          await page.screenshot({ path: join(runDir, "editor.png"), timeout: 10_000 })
            .catch(error => { (sample as Record<string, unknown>).screenshot_failed = String(error).slice(0, 120); });
        } catch (error) {
          // Persist sanitized detail only: redact() strips media tickets/URIs/paths
          // before anything hits disk (S1, PERFORMANCE_C20T_B11D Planning Gate).
          const detail = sanitizeErrorDetail(error);
          await writeFile(join(runDir, "failure.json"), JSON.stringify({ schema_version: 1, scenario: recipe.scenario, run: runIndex, enabled,
            status: "invalid-incomplete", error_type: detail.name, error_message: detail.message, error_stack: detail.stack,
            setup_recovery_count: setupRecoveryCount }, null, 2));
          throw error;
        } finally {
          try { await app.close(); } finally {
          if (sample) { await writeFile(join(runDir, "result.json"), JSON.stringify(sample, null, 2)); results.push(sample); }
          await writeFile(join(output, `results-${recipe.scenario}.json`), JSON.stringify(results, null, 2));
          }
        }
      }
    }
  });
}

/** Launch the built editor with the scenario media exposed as a name→path fixture map. */
async function launchEditor(mediaFiles: FixtureEntry[], fixturesDir: string, runDir: string): Promise<ElectronApplication> {
  const assetMap: Record<string, string> = {};
  for (const entry of mediaFiles) assetMap[entry.file] = join(fixturesDir, entry.file);
  // F06 export destination: per-run scratch file under the runner's exports dir.
  const exportDir = process.env.AIVS_PERF_EXPORT_DIR;
  let exportPath: string | undefined;
  if (exportDir) {
    mkdirSync(exportDir, { recursive: true });
    // Use only the run directory's own name (e.g. "warmup-on") for the file —
    // the full runDir path contains separators that would create phantom
    // subdirectories and make Core reject the destination parent. The runDir
    // itself is per-scenario (output/<Fxx>/<run>-<on|off>), so the file name is
    // unique across scenes running in one invocation.
    exportPath = join(exportDir, `export-${basename(dirname(runDir))}-${basename(runDir)}.mp4`);
  }
  return electron.launch({ args: [join(root, "apps/desktop/out/main/index.cjs"), `--user-data-dir=${join(runDir, "user-data")}`],
    cwd: join(root, "apps/desktop"), env: { ...process.env,
      AIVS_RESOURCES_PATH: join(root, "resources"), AIVS_E2E_ASSET_PATHS_LIST: JSON.stringify(assetMap),
      ...(exportPath ? { AIVS_E2E_EXPORT_PATH: exportPath } : {}),
      AIVS_SIDECAR_EXECUTABLE: join(root, ".venv/Scripts/python.exe"),
      AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
      AIVS_PERF_METRICS: "0", AIVS_PERF_OUTPUT: join(runDir, "core.json"),
      PYTHONPATH: join(root, "services/core/src"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
    } });
}

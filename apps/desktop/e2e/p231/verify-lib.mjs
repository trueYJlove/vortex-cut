#!/usr/bin/env node
/** P231 real-Electron verification library. No new dependencies. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync as readBinarySync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '../../../..');
export const desktop = resolve(root, 'apps', 'desktop');
const rendererAssets = join(desktop, 'out', 'renderer', 'assets');
export const runDir = resolve(process.env.P231_RUN_DIR || join(root, '.tmp', 'p231-verify-v2'));
export const userData = join(runDir, 'user-data');
export const evidencePath = join(runDir, 'evidence.json');
export const pixelsPath = join(runDir, 'pixel-samples.json');
export const readyTimeoutMs = Number(process.env.P231_READY_TIMEOUT_MS || 120000);
const resources = join(root, 'resources');
const pythonSidecar = join(root, '.venv', 'Scripts', 'python.exe');
const sidecarArgs = JSON.stringify(['-m', 'aivs_core.bootstrap']);
const video = join(root, 'test-assets', 'generated', 'cfr-landscape-av.mp4');
const image = join(root, 'test-assets', 'generated', 'poster.png');
// Core is the source of truth: services/core/src/aivs_core/rendering/ir.py:50 declares IR_PROJECTOR_VERSION.
// Read it at preflight time so a later projector bump cannot make this harness reject a fresh build.
const IR_SOURCE = join(root, 'services', 'core', 'src', 'aivs_core', 'rendering', 'ir.py');
export const EXPECTED_PROJECTOR_VERSION = (() => {
  const source = readFileSync(IR_SOURCE, 'utf8');
  const match = source.match(/^IR_PROJECTOR_VERSION\s*=\s*(\d+)\s*$/m);
  assert(match, 'IR_PROJECTOR_VERSION assignment missing from ' + IR_SOURCE);
  return Number(match[1]);
})();
// v6 was the first P231 layers contract; the stale-bundle diagnosis still cites it.
export const V6_LAYERS_VERSION = 6;
export const V6_VERSION = EXPECTED_PROJECTOR_VERSION;
export const EXPECTED_PROJECTOR_SOURCE = IR_SOURCE;
export const fixture = { video, image, V1: 'full_asset video', V2: 'image at_index 0, duration 3s, scale 0.7', V1_transform: { x: 0.5, y: 0.5, scale: 0.7, rotate: 0, opacity: 1 } };
export const POSTER_EXPECTED_RGBA = pngPixel(readFileSync(image), 320, 180);

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function env() { return {
  ...process.env,
  AIVS_RESOURCES_PATH: process.env.AIVS_RESOURCES_PATH || resources,
  AIVS_E2E_ASSET_PATHS: JSON.stringify({ video, image }),
  AIVS_SIDECAR_EXECUTABLE: pythonSidecar,
  AIVS_SIDECAR_EXECUTABLE_ARGS: sidecarArgs,
  PYTHONPATH: [join(root, 'services', 'core', 'src')].join(';'),
  ELECTRON_RUN_AS_NODE: undefined,
  NODE_OPTIONS: undefined,
}; }
function git(args) { return execFileSync('git', args, { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
async function inspectRenderer() {
  const names = (await readdir(rendererAssets)).filter(name => name.endsWith('.js')).sort();
  assert(names.length > 0, 'renderer assets directory has no .js files: ' + rendererAssets);
  const bundles = [];
  for (const name of names) {
    const path = join(rendererAssets, name);
    const [info, source] = await Promise.all([stat(path), readFile(path, 'utf8')]);
    const digest = createHash('sha256').update(source).digest('hex');
    const hasLayersPath = /\bframe\s*\.\s*layers\b|\.\s*layers\s*\!?=\s*(?:undefined|null)/.test(source);
    bundles.push({ filename: name, path, mtime: info.mtime.toISOString(), mtime_ms: info.mtimeMs, bytes: info.size, sha256: digest, has_frame_layers: hasLayersPath, projector_version: /projector_version/.test(source) ? 'token-present' : null });
  }
  return { bundles, v6: bundles.some(entry => entry.has_frame_layers), v6_bundles: bundles.filter(entry => entry.has_frame_layers).map(entry => entry.filename) };
}
export async function preflight() {
  const docs = join(root, 'docs');
  assert(!resolve(process.env.P231_RUN_DIR || '').startsWith(docs), 'P231_RUN_DIR must not point at docs evidence');
  await mkdir(runDir, { recursive: true });
  const previousMtime = await stat(runDir).then(info => info.mtimeMs).catch(() => 0);
  const bundle = await inspectRenderer();
  let commitSha = null; let commitError = null;
  try { commitSha = git(['rev-parse', 'HEAD']); } catch (error) { commitError = String(error.message || error); }
  assert(commitSha && /^[0-9a-f]{40}$/i.test(commitSha), 'could not read commit SHA: ' + commitError);
  const htmlPath = join(desktop, 'out', 'renderer', 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const entryMatch = html.match(/src="\.\/assets\/([^"]+\.js)"/);
  assert(entryMatch, 'renderer entry script not found in ' + htmlPath);
  const entryName = basename(entryMatch[1]);
  const entry = bundle.bundles.find(item => item.filename === entryName);
  assert(entry, 'renderer entry ' + entryName + ' missing from ' + rendererAssets);
  const result = { at: new Date().toISOString(), commit_sha: commitSha, expected_projector_version: EXPECTED_PROJECTOR_VERSION, expected_projector_source: EXPECTED_PROJECTOR_SOURCE, renderer_dir: rendererAssets, entry_bundle: entryName, entry: { filename: entry.filename, mtime: entry.mtime, mtime_ms: entry.mtime_ms, sha256: entry.sha256, bytes: entry.bytes }, bundles: bundle.bundles, v6_layers_path_found: bundle.v6, v6_bundles: bundle.v6_bundles, run_dir: runDir, run_dir_preexisting_mtime_ms: previousMtime, ready_timeout_ms: readyTimeoutMs };
  await writeJson(join(runDir, 'preflight.json'), result);
  await writeFile(join(runDir, 'bundle-fingerprints.txt'), bundle.bundles.map(item => item.filename + '\t' + item.mtime + '\t' + item.bytes + '\t' + item.sha256 + '\tframe.layers=' + item.has_frame_layers).join('\n') + '\n', 'utf8');
  if (!bundle.v6) {
    const diagnosis = [
      'STALE RENDERER: no built renderer asset contains the P231 layers path (frame.layers; first introduced by v' + V6_LAYERS_VERSION + ').',
      'Entry bundle: ' + entry.filename + ' (mtime ' + entry.mtime + ', sha256 ' + entry.sha256 + ').',
      'Bundles scanned: ' + bundle.bundles.length + '; old overlays-only consumers are not sufficient.',
      'Core source declares IR_PROJECTOR_VERSION = ' + EXPECTED_PROJECTOR_VERSION + ', but the renderer must be rebuilt for these consumers.',
      'Action: lead must rebuild the Electron renderer (and main/preload if their build is stale), then rerun this script. This harness does not rebuild.',
      'Diagnosis evidence: ' + join(runDir, 'preflight.json'),
    ].join('\n');
    await writeFile(join(runDir, 'STALE_RENDERER.txt'), diagnosis + '\n', 'utf8');
    throw new Error(diagnosis);
  }
  return { ...result, entry };
}
export async function prepareRunDir(preflightResult) {
  await rm(userData, { recursive: true, force: true });
  for (const name of ['workspace.png', 'preview.png', 'timeline.png', 'evidence.json', 'pixel-samples.json', 'pixel-samples-primary.json', 'pixel-samples-negative-control.json', 'pixel-samples-primary.json', 'pixel-samples-negative-control.json', 'negative-control.png', 'primary-canvas.png', 'blank-frame.png', 'blank-frame-pixels.json', 'STALE_RENDERER.txt', 'dom-snapshot.html', 'dom-snapshot-primary.html', 'dom-snapshot-negative-control.html', 'run-error.txt']) await rm(join(runDir, name), { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  for (const path of [join(desktop, 'out', 'main', 'index.cjs'), pythonSidecar, video, image]) await access(path);
  preflightResult.run_dir_reset_at = new Date().toISOString();
  preflightResult.user_data = userData;
  await writeJson(join(runDir, 'preflight.json'), preflightResult);
}
export function electronApi() {
  const playwright = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test'))] }));
  const electron = playwright._electron;
  assert(electron && electron.launch, 'playwright._electron.launch is unavailable');
  return electron;
}
export async function desktopReady(page, label) {
  await page.waitForFunction(() => Boolean(window.desktop && window.desktop.getRuntime), null, { timeout: 40000 });
  await page.evaluate(() => window.desktop.getRuntime());
  await page.waitForSelector('text=Core 已连接', { timeout: 40000 });
  assert(await page.locator('text=Core 已连接').count() > 0, label + ': Core connection text absent');
}
export async function waitSyntheticReady(page, label) {
  const canvas = page.locator('.synthetic-preview canvas.synthetic-canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: readyTimeoutMs });
  await page.waitForFunction(() => {
    const rootNode = document.querySelector('.synthetic-preview');
    if (!rootNode) return false;
    const canvasNode = rootNode.querySelector('canvas.synthetic-canvas');
    if (!canvasNode) return false;
    const rect = canvasNode.getBoundingClientRect();
    const style = getComputedStyle(canvasNode);
    const loading = rootNode.querySelector('.synthetic-loading');
    const loadingText = (loading && loading.textContent || '').trim();
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && getComputedStyle(canvasNode.parentElement).display !== 'none' && loadingText.length === 0;
  }, null, { timeout: readyTimeoutMs });
  const boundingBox = await canvas.boundingBox();
  assert(boundingBox && boundingBox.width > 2 && boundingBox.height > 2, label + ': canvas boundingBox is not visible: ' + JSON.stringify(boundingBox));
  assert(await page.locator('.synthetic-note').count() === 0, label + ': synthetic preview fell back to interactive mode');
  return { canvas, boundingBox };
}
export function modeFromDom(dom) {
  if (!dom.synthetic_preview_outer_html) return 'unknown';
  if (/合成预览/.test(dom.preview_status_text || '')) return 'synthetic';
  if (/交互预览/.test(dom.preview_status_text || '')) return 'interactive';
  if (/权威预览/.test(dom.preview_status_text || '')) return 'authoritative';
  return 'synthetic';
}
export async function domEvidence(page, ready) {
  return page.evaluate(readyBox => {
    const rootNode = document.querySelector('.synthetic-preview');
    const canvas = rootNode ? rootNode.querySelector('canvas.synthetic-canvas') : null;
    const loading = rootNode ? rootNode.querySelector('.synthetic-loading') : null;
    const status = Array.from(document.querySelectorAll("[aria-label='预览状态']")).map(el => (el.textContent || '').trim());
    const rect = canvas ? canvas.getBoundingClientRect() : null;
    return { at: new Date().toISOString(), load_status: loading ? 'not-ready' : 'ready', preview_mode: rootNode ? 'synthetic' : 'unknown', synthetic_preview_outer_html: rootNode ? rootNode.outerHTML : null, canvas_outer_html: canvas ? canvas.outerHTML : null, loading_text: loading ? (loading.textContent || '').trim() : '', loading_outer_html: loading ? loading.outerHTML : null, preview_status_text: status.join(' | '), boundingBox: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null, locator_boundingBox: readyBox, canvas_css_width: canvas ? getComputedStyle(canvas).width : null, canvas_css_height: canvas ? getComputedStyle(canvas).height : null, canvas_client_width: canvas ? canvas.clientWidth : null, canvas_client_height: canvas ? canvas.clientHeight : null, canvas_backing_width: canvas ? canvas.width : null, canvas_backing_height: canvas ? canvas.height : null, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, theme: document.documentElement.dataset.theme || null, selected_project_name: (document.querySelector('.titlebar-project-name') || {}).textContent || null, preview_canvas_outer_html: (document.querySelector('.preview-canvas') || {}).outerHTML || null };
  }, ready.boundingBox);
}
export async function selectProject(page, projectId, projectName) {
  await page.getByRole('button', { name: '切换项目' }).click();
  const listbox = page.getByRole('listbox', { name: '选择项目' });
  await listbox.getByRole('option').filter({ has: page.getByText(projectName, { exact: true }) }).click();
  await page.waitForFunction(name => ((document.querySelector('.titlebar-project-name') || {}).textContent || '').trim() === name, projectName, { timeout: 30000 });
  assert(await page.evaluate(id => window.desktop.getProject(id).then(project => project.name), projectId) === projectName, 'project ' + projectId + ' name mismatch');
}
export async function createVariant(page, name, reverseInsertion) {
  return page.evaluate(async ({ name, reverseInsertion }) => {
    // 画布固定 16:9（1080×1920 的竖版默认会让「原始=16:9」的探针推导
    // 与 UI 黑框不一致；固定横版使 project.canvas → ratio 推导唯一）。
    const project = await window.desktop.createProject({ name, canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 } });
    const vid = await window.desktop.importAsset({ project_id: project.project_id, kind: 'video' });
    const img = await window.desktop.importAsset({ project_id: project.project_id, kind: 'image' });
    if (!vid || !img) throw new Error('import cancelled');
    const created = await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1, source: { kind: 'full_asset', asset_id: vid.asset.asset_id }, default_layout: 'blurred_background', caption_preset_id: 'default-bottom' } });
    const base = created.current_revision.timeline_revision_id;
    const v1Clip = created.current_revision.document.clips[0].clip_id;
    let state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: base, operations: [
      { op: 'add_track', kind: 'video' },
      { op: 'insert_asset_clip', asset_id: img.asset.asset_id, at_index: 0, track_id: 'V2', duration_us: 3000000, layout: 'fit' },
      { op: 'set_clip_transform', clip_id: v1Clip, transform: { x: 0.5, y: 0.5, scale: 0.7, rotate: 0, opacity: 1 } },
    ], summary: 'p231-' + name } });
    const v2Clip = state.current_revision.document.clips.find(clip => clip.track_id === 'V2');
    if (!v2Clip) throw new Error('V2 clip missing after patch');
    const postOperations = [];
    if (reverseInsertion) postOperations.push({ op: 'move_clip', clip_id: v2Clip.clip_id, to_index: 0 });
    postOperations.push({ op: 'set_clip_transform', clip_id: v2Clip.clip_id, transform: { x: 0.5, y: 0.5, scale: 0.7, rotate: 0, opacity: 1 } });
    state = await window.desktop.patchTimeline({ project_id: project.project_id, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations: postOperations, summary: 'p231-' + name + '-post' } });
    return { project_id: project.project_id, name, v1_clip_id: v1Clip, video_asset_id: vid.asset.asset_id, image_asset_id: img.asset.asset_id, reverseInsertion, clip_ids: state.current_revision.document.clips.map(clip => ({ clip_id: clip.clip_id, track_id: clip.track_id })) };
  }, { name, reverseInsertion });
}

export async function snapshotIr(page, projectId, sampleFrame, blankFrame, outputRatio) {
  return page.evaluate(async ({ projectId, sampleFrame, blankFrame, outputRatio }) => {
    // 与 UI 同参：不传 output_ratio 时 Core 默认 "169"，探针会读到与 UI
    // 实际画幅不一致的画布（黑框 9:16 vs IR 16:9 的假分叉）。ratio 参数
    // 由调用方从 project.canvas 推导，与渲染端同一语义。
    const ratio = outputRatio || '169';
    const manifest = await window.desktop.getPreviewIrV2Manifest({ project_id: projectId, output_ratio: ratio });
    const timeline = await window.desktop.getTimeline(projectId);
    const trackOrder = (timeline.current_revision.document.tracks || []).map((track, index) => ({ id: track.id, index }));
    const sampleWindow = await window.desktop.getPreviewIrV2Window({ project_id: projectId, start_frame: sampleFrame, frame_count: 1, output_ratio: ratio });
    const blankWindow = await window.desktop.getPreviewIrV2Window({ project_id: projectId, start_frame: blankFrame, frame_count: 1, output_ratio: ratio });
    if (manifest.manifest_id !== sampleWindow.manifest_id || manifest.manifest_id !== blankWindow.manifest_id) throw new Error('manifest/window identity mismatch');
    const sample = sampleWindow.frames[0] || null;
    const blank = blankWindow.frames[0] || null;
    const clips = (manifest.segments || []).map(segment => ({ clip_id: segment.clip_id, track_id: segment.track_id, track_index: (trackOrder.find(track => track.id === segment.track_id) || {}).index ?? null, timeline_start_us: segment.timeline_start_us, timeline_end_us: segment.timeline_end_us, input_id: segment.input_id, transform: segment.transform || null }));
    const layerSummary = frame => Array.isArray(frame && frame.layers) ? frame.layers.map(layer => ({ clip_id: layer.clip_id, input_id: layer.input_id, box: layer.box, rotation_deg: layer.rotation_deg, alpha: layer.alpha, layout: layer.layout || null })) : null;
    return { schema: manifest.schema, 'projector_version': manifest.projector_version, manifest_id: manifest.manifest_id, timeline_revision_id: manifest.timeline_revision_id, total_frames: manifest.total_frames, fps_num: manifest.fps_num, fps_den: manifest.fps_den, canvas: { width: manifest.canvas && manifest.canvas.width, height: manifest.canvas && manifest.canvas.height, background: manifest.canvas && manifest.canvas.background, duration_frames: manifest.canvas && manifest.canvas.duration_frames }, inputs: (manifest.inputs || []).map(input => ({ input_id: input.input_id, asset_id: input.asset_id, asset_kind: input.asset_kind, geometry: input.geometry || null })), track_order: trackOrder, clips, frame_sample: { n: sample ? sample.n : null, t_us: sample ? sample.t_us : null, layers_length: Array.isArray(sample && sample.layers) ? sample.layers.length : null, layers: layerSummary(sample), main_kind: sample && sample.main ? sample.main.kind : null, overlays_length: Array.isArray(sample && sample.overlays) ? sample.overlays.length : null }, blank_frame: { n: blank ? blank.n : null, t_us: blank ? blank.t_us : null, layers_length: Array.isArray(blank && blank.layers) ? blank.layers.length : null, layers: layerSummary(blank), main_kind: blank && blank.main ? blank.main.kind : null, overlays_length: Array.isArray(blank && blank.overlays) ? blank.overlays.length : null }, sample_window: { start_frame: sampleWindow.start_frame, frame_count: sampleWindow.frame_count }, blank_window: { start_frame: blankWindow.start_frame, frame_count: blankWindow.frame_count } };
  }, { projectId, sampleFrame, blankFrame });
}
export function assertIr(ir, label) {
  assert(Number(ir.projector_version) === EXPECTED_PROJECTOR_VERSION, label + ': IR projector_version ' + ir.projector_version + ', expected v' + EXPECTED_PROJECTOR_VERSION + ' from ' + EXPECTED_PROJECTOR_SOURCE);
  assert(ir.frame_sample.layers_length === 2, label + ': sample frame layers.length ' + ir.frame_sample.layers_length + ', expected 2');
  assert(Array.isArray(ir.frame_sample.layers) && ir.frame_sample.layers.every(layer => layer.box), label + ': sample frame layers lack boxes');
  assert(Array.isArray(ir.blank_frame.layers) || ir.blank_frame.layers_length === null, label + ': blank frame layers field malformed');
  const v2 = ir.clips.find(clip => clip.track_id === 'V2');
  const v1 = ir.clips.find(clip => clip.track_id === 'V1');
  assert(v2 && v1 && Number(v2.track_index) < Number(v1.track_index), label + ': V2/V1 track order is wrong: ' + JSON.stringify(ir.clips));
  const bottom = ir.frame_sample.layers[0];
  const top = ir.frame_sample.layers[ir.frame_sample.layers.length - 1];
  assert(top.clip_id === v2.clip_id, label + ': expected V2 as the last-painted top layer, got ' + top.clip_id);
  assert(bottom.clip_id !== top.clip_id, label + ': the two visual layers collapsed into one');

  return { top, bottom, v1, v2 };
}
export function pngPixel(png, x, y) {
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature invalid');
  let offset = 8; let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; const idat = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; assert(data[12] === 0, 'interlaced PNG unsupported'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert(width > 0 && height > 0 && bitDepth === 8 && (colorType === 2 || colorType === 6), 'PNG must be 8-bit RGB/RGBA: ' + JSON.stringify({ width, height, bitDepth, colorType }));
  const channels = colorType === 6 ? 4 : 3; const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels; const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); };
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]; const start = row * (stride + 1) + 1;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[start + i]; const left = i >= channels ? out[row * stride + i - channels] : 0;
      const up = row > 0 ? out[(row - 1) * stride + i] : 0; const upLeft = row > 0 && i >= channels ? out[(row - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left; else if (filter === 2) predictor = up; else if (filter === 3) predictor = (left + up) >> 1; else if (filter === 4) predictor = paeth(left, up, upLeft); else assert(filter === 0, 'PNG filter unsupported: ' + filter);
      out[row * stride + i] = (value + predictor) & 255;
    }
  }
  const px = Math.min(width - 1, Math.max(0, Math.round(x))); const py = Math.min(height - 1, Math.max(0, Math.round(y)));
  const at = py * stride + px * channels; return [out[at], out[at + 1], out[at + 2], channels === 4 ? out[at + 3] : 255];
}

function pngSize(png) {
  assert(png.length > 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature invalid');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'PNG IHDR missing');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function sampleCanvasPixels(page, ir, points, context = {}) {
  const canvasWidth = Number(ir.canvas.width);
  const canvasHeight = Number(ir.canvas.height);
  assert(canvasWidth > 0 && canvasHeight > 0, 'IR canvas dimensions invalid: ' + JSON.stringify(ir.canvas));
  const readGeometry = () => page.evaluate(() => {
    const canvas = document.querySelector('.synthetic-preview canvas.synthetic-canvas');
    if (!canvas) throw new Error('synthetic canvas missing for pixel sampling');
    const preview = document.querySelector('.preview-canvas');
    const previewRect = preview ? preview.getBoundingClientRect() : null;
    return {
      cw: canvas.width, ch: canvas.height,
      cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
      previewCssWidth: previewRect ? previewRect.width : null,
      previewCssHeight: previewRect ? previewRect.height : null,
      dpr: window.devicePixelRatio || 1,
    };
  });
  const deadline = Date.now() + Math.min(15000, readyTimeoutMs);
  let geometry = null;
  let png = null;
  let info = null;
  let ratioX = 0;
  let ratioY = 0;
  let stabilityAttempts = 0;
  const geometryTrace = [];
  while (Date.now() < deadline) {
    geometry = await readGeometry();
    png = await page.locator('.synthetic-preview canvas.synthetic-canvas').screenshot();
    info = pngSize(png);
    ratioX = info.width / geometry.cw;
    ratioY = info.height / geometry.ch;
    stabilityAttempts += 1;
    if (geometryTrace.length < 6) geometryTrace.push({ cw: geometry.cw, ch: geometry.ch, screenshot: [info.width, info.height], ratioX, ratioY });
    if (Number.isFinite(ratioX) && Number.isFinite(ratioY)
      && geometry.cw > 2 && geometry.ch > 2
      && ratioX >= 0.95 && ratioX <= 1.05 && ratioY >= 0.95 && ratioY <= 1.05) break;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
  }
  assert(geometry && info && geometry.cssWidth > 0 && geometry.cssHeight > 0,
    'synthetic canvas geometry invalid: ' + JSON.stringify({ geometry, trace: geometryTrace }));
  assert(ratioX >= 0.95 && ratioX <= 1.05 && ratioY >= 0.95 && ratioY <= 1.05,
    'screenshot/backing geometry never stabilized: ' + JSON.stringify({ geometry, info, ratioX, ratioY, stabilityAttempts, trace: geometryTrace }));
  const backingToScreenshotX = ratioX;
  const backingToScreenshotY = ratioY;
  const backingScale = Math.min(geometry.cw / canvasWidth, geometry.ch / canvasHeight, 2048 / Math.max(canvasWidth, canvasHeight));
  const fitX = (geometry.cw - canvasWidth * backingScale) / 2;
  const fitY = (geometry.ch - canvasHeight * backingScale) / 2;
  const coordinateTransform = {
    method: 'IR canvas -> backing via PreviewSession.resize fit, then backing -> screenshot via measured PNG/backing ratio',
    ir_canvas: { width: canvasWidth, height: canvasHeight },
    source_canvas_backing: { width: geometry.cw, height: geometry.ch },
    source_canvas_css: { width: geometry.cssWidth, height: geometry.cssHeight },
    preview_canvas_css: { width: geometry.previewCssWidth, height: geometry.previewCssHeight },
    preview_css_ratio: geometry.previewCssWidth && geometry.previewCssHeight ? geometry.previewCssWidth / geometry.previewCssHeight : null,
    ir_canvas_ratio: canvasWidth / canvasHeight,
    decoded_bitmap: { width: info.width, height: info.height },
    fit: { x: fitX, y: fitY, scale: backingScale },
    letterbox: { x: fitX, y: fitY, content_width: canvasWidth * backingScale, content_height: canvasHeight * backingScale },
    scale: {
      ir_to_backing_x: backingScale, ir_to_backing_y: backingScale,
      backing_to_screenshot_x: backingToScreenshotX, backing_to_screenshot_y: backingToScreenshotY,
      css_to_screenshot_x: info.width / geometry.cssWidth,
      css_to_screenshot_y: info.height / geometry.cssHeight,
      device_pixel_ratio: geometry.dpr,
    },
    geometry_stability: { attempts: stabilityAttempts, ratioX, ratioY, trace: geometryTrace },
  };
  return {
    at: new Date().toISOString(),
    variant: context.variant || null,
    scenario: context.scenario || context.variant || null,
    method: 'Playwright locator screenshot decoded with Node zlib PNG decoder',
    coordinate_basis: context.coordinate_basis || 'IR layer box coordinates mapped through preview fit/letterbox',
    decision_basis: context.decision_basis || 'RGBA comparison against source poster / expected black gap',
    source_poster_rgba: POSTER_EXPECTED_RGBA,
    coordinate_transform: coordinateTransform,
    samples: points.map(point => {
      const backingX = fitX + point.x * backingScale;
      const backingY = fitY + point.y * backingScale;
      const screenshotX = backingX * backingToScreenshotX;
      const screenshotY = backingY * backingToScreenshotY;
      return {
        ...point,
        ir_x: point.x, ir_y: point.y,
        backing_x: backingX, backing_y: backingY,
        screenshot_x: screenshotX, screenshot_y: screenshotY,
        pixel_x: screenshotX, pixel_y: screenshotY,
        coordinate_basis: point.coordinate_basis || context.coordinate_basis || 'IR point mapped through preview fit/letterbox',
        decision_basis: point.decision_basis || context.decision_basis || 'RGBA criterion',
        rgba: pngPixel(png, screenshotX, screenshotY),
      };
    }),
  };
}
export function assertLayeringPixels(pixels, label) {
  const inside = pixels.samples.find(sample => sample.name === 'inside_v2_box');
  const outside = pixels.samples.find(sample => sample.name === 'outside_v2_box');
  assert(inside && outside, label + ': pixel sample set incomplete');
  const expected = POSTER_EXPECTED_RGBA;
  const colorDistance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const insidePosterDistance = colorDistance(inside.rgba, expected);
  const outsidePosterDistance = colorDistance(outside.rgba, expected);
  const insideOutsideDistance = colorDistance(inside.rgba, outside.rgba);
  assert(insidePosterDistance <= 40, label + ': inside V2 box RGBA is not close to source poster: ' + JSON.stringify({ inside: inside.rgba, expected, distance: insidePosterDistance }));
  assert(outsidePosterDistance > 60, label + ': outside V2 box RGBA is too close to source poster: ' + JSON.stringify({ outside: outside.rgba, expected, distance: outsidePosterDistance }));
  assert(insideOutsideDistance > 60, label + ': inside/outside V2 samples are too similar to prove layering: ' + JSON.stringify({ inside: inside.rgba, outside: outside.rgba, distance: insideOutsideDistance }));
  return {
    coordinate_basis: pixels.coordinate_basis,
    decision_basis: 'inside V2 center must be within RGB distance 40 of source poster; outside point must differ by >60; inside/outside must differ by >60',
    source_poster_rgba: expected,
    observed_v2_rgba: inside.rgba,
    outside_v2_rgba: outside.rgba,
    inside_poster_distance: insidePosterDistance,
    outside_poster_distance: outsidePosterDistance,
    inside_outside_color_distance: insideOutsideDistance,
    layering_proven: true,
  };
}

export function layeringPoints(ir, layerOrder) {
  const v2 = ir.clips.find(clip => clip.track_id === 'V2');
  assert(v2, 'V2 clip missing from IR clips: ' + JSON.stringify(ir.clips));
  const v2Layer = ir.frame_sample.layers.find(layer => layer.clip_id === v2.clip_id);
  const v1Layer = ir.frame_sample.layers.find(layer => layer.clip_id === layerOrder.v1.clip_id);
  assert(v2Layer && v2Layer.box, 'V2 layer box missing from frame_sample.layers: ' + JSON.stringify({ v2, layers: ir.frame_sample.layers }));
  assert(v1Layer && v1Layer.box, 'V1 layer box missing from frame_sample.layers: ' + JSON.stringify({ v1: layerOrder.v1, layers: ir.frame_sample.layers }));
  const v2Box = v2Layer.box;
  const v1Box = v1Layer.box;
  const centerX = v2Box.x + v2Box.w / 2;
  const centerY = v2Box.y + v2Box.h / 2;
  const outsideX = v1Box.x < v2Box.x - 4 ? (v1Box.x + v2Box.x) / 2 : Math.max(1, v2Box.x - Math.max(8, Math.round(v2Box.w * 0.08)));
  const outsideY = v1Box.y <= centerY && centerY < v1Box.y + v1Box.h ? centerY : v1Box.y + v1Box.h / 2;
  const outsideInV1Box = outsideX >= v1Box.x && outsideX < v1Box.x + v1Box.w && outsideY >= v1Box.y && outsideY < v1Box.y + v1Box.h;
  assert(outsideX < v2Box.x || outsideX >= v2Box.x + v2Box.w || outsideY < v2Box.y || outsideY >= v2Box.y + v2Box.h, 'outside point is inside V2 box');
  if (!outsideInV1Box) assert(v1Layer.layout === 'blurred_background', 'outside point is not inside V1 video: ' + JSON.stringify({ outsideX, outsideY, v1Box, v1Layer }));
  const outsideBasis = outsideInV1Box
    ? 'inside V1 layer box and outside V2 layer box'
    : 'inside V1 blurred_background full-canvas underlay and outside V2 layer box';
  const geometry = { v2_clip_id: v2.clip_id, v1_clip_id: layerOrder.v1.clip_id, v2_box: v2Box, v1_box: v1Box, outside_basis: outsideBasis };
  return [
    { name: 'inside_v2_box', x: centerX, y: centerY, expected: 'source-poster-color', coordinate_basis: 'center of V2 clip layer box from frame_sample.layers: ' + JSON.stringify(v2Box), decision_basis: 'must match source poster RGBA within distance 40', ...geometry },
    { name: 'outside_v2_box', x: outsideX, y: outsideY, expected: 'not-source-poster-color', coordinate_basis: outsideBasis + '; V1 box=' + JSON.stringify(v1Box) + '; V2 box=' + JSON.stringify(v2Box), decision_basis: 'must not match source poster RGBA and must differ from inside V2 sample', ...geometry },
    { name: 'corner', x: 2, y: 2, expected: 'background-reference', coordinate_basis: 'IR near-origin corner mapped through preview fit/letterbox', decision_basis: 'reference only; not used for pass/fail', ...geometry },
  ];
}

export async function captureVariant(page, variant, label, screenshots, preflightResult) {
  const ready = await waitSyntheticReady(page, label);
  const dom = await domEvidence(page, ready);
  const previewMode = dom.preview_mode;
  assert(previewMode === 'synthetic' && dom.load_status === 'ready', label + ': previewMode ' + previewMode + ', load.status ' + dom.load_status);
  // 与 UI 同一比例语义（「原始」=16:9）：探针画布必须等于渲染画布。
  const projectRatio = await page.evaluate(projectId => {
    const c = (document.querySelector('.preview-frame') || {}).className || '';
    return /ratio-916/.test(c) ? '916' : /ratio-11/.test(c) ? '11' : /ratio-43/.test(c) ? '43' : /ratio-34/.test(c) ? '34' : '169';
  }, variant.project_id);
  const ir = await snapshotIr(page, variant.project_id, 0, 0, projectRatio);
  const layerOrder = assertIr(ir, label);
  const points = layeringPoints(ir, layerOrder);
  const sampleContext = {
    variant: label,
    scenario: label,
    coordinate_basis: 'V2 clip layer box from frame_sample.layers; IR -> backing fit/letterbox -> screenshot/backing scale',
    decision_basis: 'V2 center close to source poster; outside point outside V2 box but within V1 video',
  };
  const pixels = await sampleCanvasPixels(page, ir, points, sampleContext);
  const pixelPath = join(runDir, 'pixel-samples-' + label + '.json');
  await writeJson(pixelPath, pixels);
  const pixelVerdict = assertLayeringPixels(pixels, label);
  await writeJson(pixelPath, { ...pixels, decision_basis: pixelVerdict.decision_basis, decision: pixelVerdict });
  const canvasInfo = await page.evaluate(() => {
    const canvas = document.querySelector('.synthetic-preview canvas.synthetic-canvas');
    return canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight, outerHTML: canvas.outerHTML } : null;
  });
  assert(canvasInfo && canvasInfo.width > 2 && canvasInfo.height > 2, label + ': synthetic canvas backing store not ready');
  if (screenshots) {
    await page.screenshot({ path: join(runDir, 'workspace.png') });
    await page.locator('.synthetic-preview').screenshot({ path: join(runDir, 'preview.png'), timeout: 15000 });
    await page.locator('.timeline-canvas-container canvas').first().screenshot({ path: join(runDir, 'timeline.png'), timeout: 15000 });
    await page.locator('.synthetic-preview canvas.synthetic-canvas').screenshot({ path: join(runDir, 'primary-canvas.png'), timeout: 15000 });
  }
  await writeFile(join(runDir, 'dom-snapshot-' + label + '.html'), '<!doctype html><meta charset="utf-8"><title>' + label + ' DOM</title><pre>' + (dom.synthetic_preview_outer_html || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>\n', 'utf8');
  return { label, project_id: variant.project_id, project_name: variant.name, ready: true, previewMode, dom_snapshot_path: join(runDir, 'dom-snapshot-' + label + '.html'), dom, canvas: canvasInfo, load: { status: dom.load_status, status_source: '.synthetic-loading absent + visible .synthetic-preview canvas.synthetic-canvas', loading_text: dom.loading_text }, boundingBox: ready.boundingBox, ir, layer_order: { last_painted_clip_id: layerOrder.top.clip_id, first_painted_clip_id: layerOrder.bottom.clip_id, v2_clip_id: layerOrder.v2.clip_id, v1_clip_id: layerOrder.v1.clip_id, v2_track_index: layerOrder.v2.track_index, v1_track_index: layerOrder.v1.track_index }, pixel_samples_path: pixelPath, pixel_summary: pixelVerdict, screenshots: screenshots ? ['workspace.png', 'preview.png', 'timeline.png', 'primary-canvas.png'] : [], commit_sha: preflightResult.commit_sha, bundle_id: { filename: preflightResult.entry.filename, sha256: preflightResult.entry.sha256, mtime: preflightResult.entry.mtime } };
}

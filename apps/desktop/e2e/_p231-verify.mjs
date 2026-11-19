#!/usr/bin/env node
/** P231 real-Electron verification: fail fast on stale renderer or unfinished preview. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXPECTED_PROJECTOR_VERSION, EXPECTED_PROJECTOR_SOURCE, assert, captureVariant, createVariant, desktop, desktopReady, domEvidence, electronApi, env, evidencePath, fixture, modeFromDom, preflight, prepareRunDir, readyTimeoutMs, runDir, sampleCanvasPixels, selectProject, snapshotIr, userData, waitSyntheticReady, writeJson } from './p231/verify-lib.mjs';

async function readPlayhead(page) {
  return page.evaluate(() => {
    const slider = document.querySelector('[aria-label="时间线播放头"]');
    if (!slider) throw new Error('timeline playhead slider missing from DOM');
    const now = Number(slider.getAttribute('aria-valuenow'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    return { now, max, timecode: ((document.querySelector('.pg-bubble') || {}).textContent || '').trim() };
  });
}

async function raf(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
}

async function readPlayheadAfter(page, previous, label) {
  const deadline = Date.now() + 3000;
  let state = await readPlayhead(page);
  while (Date.now() < deadline) {
    state = await readPlayhead(page);
    if (state.now >= 0 && state.now !== previous) return state;
    await raf(page);
  }
  throw new Error(label + ': playhead did not change from ' + previous + ': ' + JSON.stringify(state));
}

async function dragRuler(page, box, fromX, toX, y, previous, label) {
  const clamp = x => Math.max(box.x + 2, Math.min(box.x + box.width - 2, x));
  const a = clamp(fromX); const b = clamp(toX);
  await page.mouse.move(a, y);
  await page.mouse.down();
  await page.mouse.move(b, y);
  await page.mouse.up();
  const state = await readPlayheadAfter(page, previous, label);
  return { x: b, state };
}

async function seekToGap(page) {
  const targetUs = 4_000_000;
  const initial = await readPlayhead(page);
  assert(Number.isFinite(initial.max) && initial.max > targetUs,
    'timeline slider maximum does not cover the 4s blank gap: ' + JSON.stringify(initial));
  const ruler = page.locator('canvas.timeline-ruler-pin').first();
  await ruler.waitFor({ state: 'visible', timeout: 30000 });
  const box = await ruler.boundingBox();
  assert(box && box.width > 300 && box.height > 0, 'timeline ruler has no usable box: ' + JSON.stringify(box));
  const y = box.y + Math.min(box.height / 2, box.height - 1);
  const first = await dragRuler(page, box, box.x + 218, box.x + 278, y, initial.now, 'first ruler calibration probe');
  const second = await dragRuler(page, box, first.x, box.x + 398, y, first.state.now, 'second ruler calibration probe');
  const slopeUsPerPx = (second.state.now - first.state.now) / (second.x - first.x);
  assert(Number.isFinite(slopeUsPerPx) && slopeUsPerPx > 0,
    'ruler calibration slope invalid: ' + JSON.stringify({ first, second, slopeUsPerPx }));
  const observations = [{ first, second, slopeUsPerPx }];
  let anchor = second;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = anchor.x + (targetUs - anchor.state.now) / slopeUsPerPx;
    const landed = await dragRuler(page, box, anchor.x, candidate, y, anchor.state.now, 'target ruler seek attempt ' + (attempt + 1));
    const inGap = landed.state.now > 3_000_000 && landed.state.now < 5_000_000;
    observations.push({ attempt: attempt + 1, candidate, landed });
    if (inGap) return { ...landed.state, targetUs, method: 'two-point-calibrated .timeline-ruler-pin mousedown/mousemove/mouseup + aria-valuenow read-back', slopeUsPerPx, observations, rulerBox: box };
    anchor = landed;
    await raf(page);
  }
  throw new Error('timeline seek did not land in the 3-5s blank gap: ' + JSON.stringify({ initial, observations, targetUs }));
}

async function waitForBlackPixels(page, ir, timeoutMs) {
  const points = [{
    name: 'inside_v2_box',
    x: Number(ir.canvas.width) / 2,
    y: Number(ir.canvas.height) / 2,
    expected: 'black',
    coordinate_basis: 'IR canvas center mapped through preview fit/letterbox to backing/screenshot',
    decision_basis: 'blank gap center must be black (all RGB channels < 24)',
  }];
  const context = {
    variant: 'blank-frame',
    scenario: 'blank-frame',
    coordinate_basis: 'IR canvas center mapped through preview fit/letterbox to backing/screenshot',
    decision_basis: 'blank gap center must be black (all RGB channels < 24)',
  };
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sampleCanvasPixels(page, ir, points, context);
    const rgba = last.samples[0].rgba;
    if (rgba[0] < 24 && rgba[1] < 24 && rgba[2] < 24) return last;
    await raf(page);
  }
  throw new Error('blank gap did not render black within ' + timeoutMs + 'ms; last center ' + JSON.stringify(last && last.samples[0].rgba));
}

async function main() {
  assert(Number.isFinite(readyTimeoutMs) && readyTimeoutMs >= 1000, 'P231_READY_TIMEOUT_MS must be >= 1000');
  const bundle = await preflight();
  await prepareRunDir(bundle);
  const electron = electronApi();
  let app;
  try {
    app = await electron.launch({ args: [join(desktop, 'out', 'main', 'index.cjs'), '--user-data-dir=' + userData], cwd: desktop, env: env() });
    const page = await app.firstWindow();
    await desktopReady(page, 'initial');
    const primary = await createVariant(page, 'P231 Verify v2', false);
    const negative = await createVariant(page, 'P231 Verify v2 Negative Control', true);
    const blank = await createVariant(page, 'P231 Verify v2 Blank', false);
    const blankPatch = await page.evaluate(async ({ projectId, videoAssetId }) => {
      const state = await window.desktop.getTimeline(projectId);
      const v1 = state.current_revision.document.clips.find(clip => clip.asset_id === videoAssetId);
      if (!v1) throw new Error('blank variant V1 clip missing');
      const next = await window.desktop.patchTimeline({ project_id: projectId, patch: { schema_version: 1, base_revision_id: state.current_revision.timeline_revision_id, operations: [{ op: 'position_clip', clip_id: v1.clip_id, timeline_start_us: 5000000 }], summary: 'p231-blank-gap' } });
      return { timeline_revision_id: next.current_revision.timeline_revision_id, v1_clip_id: v1.clip_id, v1_start_us: 5000000 };
    }, { projectId: blank.project_id, videoAssetId: blank.video_asset_id });
    blank.blank = blankPatch;

    // Blank/black-gap variant: created last, so even without an explicit project
    // switch the reload selects it; seek the playhead into its real 3-5s gap.
    await page.reload();
    await desktopReady(page, 'blank-reload');
    await selectProject(page, blank.project_id, blank.name);
    const blankReady = await waitSyntheticReady(page, 'blank-frame');
    const blankDom = await domEvidence(page, blankReady);
    const blankRatio = await page.evaluate(() => {
      const c = (document.querySelector('.preview-frame') || {}).className || '';
      return /ratio-916/.test(c) ? '916' : /ratio-11/.test(c) ? '11' : /ratio-43/.test(c) ? '43' : /ratio-34/.test(c) ? '34' : '169';
    });
    const blankProbe = await snapshotIr(page, blank.project_id, 0, 0, blankRatio);
    assert(Number(blankProbe.fps_num) > 0 && Number(blankProbe.fps_den) > 0, 'blank IR fps invalid');
    const gapFrame = Math.floor(4_000_000 * Number(blankProbe.fps_num) / (1_000_000 * Number(blankProbe.fps_den)));
    assert(gapFrame > 0 && gapFrame < blankProbe.total_frames, 'blank gap frame out of range: ' + gapFrame);
    const playheadState = await seekToGap(page);
    const playheadUs = playheadState.now;
    const blankIr = await snapshotIr(page, blank.project_id, gapFrame, gapFrame, blankRatio);
    assert(Number(blankIr.projector_version) === EXPECTED_PROJECTOR_VERSION, 'blank variant IR projector_version ' + blankIr.projector_version + ', expected v' + EXPECTED_PROJECTOR_VERSION);
    assert(blankIr.blank_frame.layers_length === 0 && blankIr.blank_frame.main_kind === 'black', 'blank variant frame ' + gapFrame + ' is not a black gap: ' + JSON.stringify(blankIr.blank_frame));
    const blankPixels = await waitForBlackPixels(page, blankIr, Math.min(30000, readyTimeoutMs));
    const blackSample = blankPixels.samples.find(sample => sample.name === 'inside_v2_box');
    assert(blackSample.rgba[0] < 24 && blackSample.rgba[1] < 24 && blackSample.rgba[2] < 24, 'blank frame center is not black: ' + JSON.stringify(blackSample.rgba));
    const blankDomAfterSeek = await domEvidence(page, blankReady);
    await page.locator('.synthetic-preview canvas.synthetic-canvas').screenshot({ path: join(runDir, 'blank-frame.png'), timeout: 15000 });
    await writeJson(join(runDir, 'blank-frame-pixels.json'), {
      ...blankPixels,
      scenario: 'blank-frame',
      decision_basis: 'blank gap center RGBA must be black: R<24, G<24, B<24',
      decision: { criterion: 'max RGB < 24', center_rgba: blackSample.rgba, passed: true },
    });

    await selectProject(page, primary.project_id, primary.name);
    const primaryEvidence = await captureVariant(page, primary, 'primary', true, bundle);
    await selectProject(page, negative.project_id, negative.name);
    const negativeEvidence = await captureVariant(page, negative, 'negative-control', false, bundle);
    await page.locator('.synthetic-preview canvas.synthetic-canvas').screenshot({ path: join(runDir, 'negative-control.png'), timeout: 15000 });
    assert(JSON.stringify(primary.clip_ids.map(clip => clip.track_id)) !== JSON.stringify(negative.clip_ids.map(clip => clip.track_id)), 'negative control did not reverse mixed clip insertion order');
    assert(primaryEvidence.ir.frame_sample.layers.length === negativeEvidence.ir.frame_sample.layers.length, 'negative control changed layer count instead of only insertion order');
    const negativeZOrderIndependent = negativeEvidence.layer_order.last_painted_clip_id === negativeEvidence.layer_order.v2_clip_id;
    assert(negativeZOrderIndependent, 'negative control failed: V2 did not remain the last-painted top layer');
    const beforeAfter = {
      before: { phase: 'preflight', description: 'commit and renderer bundle fingerprints before Electron launch; stale renderer exits nonzero', preflight_path: join(runDir, 'preflight.json'), commit_sha: bundle.commit_sha, bundle_id: bundle.entry, layers_path_found: bundle.v6_layers_path_found },
      after: { phase: 'ready', description: 'visible synthetic preview, DOM, current Core projector version, IR layers and pixel samples after reload', dom_snapshot_path: primaryEvidence.dom_snapshot_path, dom_outer_html: primaryEvidence.dom.synthetic_preview_outer_html, boundingBox: primaryEvidence.boundingBox, previewMode: primaryEvidence.previewMode, load_status: primaryEvidence.load.status, projector_version: primaryEvidence.ir.projector_version, layers_length: primaryEvidence.ir.frame_sample.layers_length, pixel_samples_path: primaryEvidence.pixel_samples_path, viewport: primaryEvidence.dom.viewport, theme: primaryEvidence.dom.theme, screenshots: primaryEvidence.screenshots },
      scenario: { fixture, viewport: primaryEvidence.dom.viewport, theme: primaryEvidence.dom.theme, negative_control_viewport: negativeEvidence.dom.viewport, blank_frame_viewport: blankDom.viewport },
    };
    const evidence = {
      at: new Date().toISOString(), ready: true, verdict: 'pass', schema: 'p231-verify-v2/1', before_after: beforeAfter,
      commit_sha: bundle.commit_sha, expected_projector_version: EXPECTED_PROJECTOR_VERSION, expected_projector_source: EXPECTED_PROJECTOR_SOURCE, bundle: bundle.entry, bundles: bundle.bundles,
      v6_layers_path_found: bundle.v6_layers_path_found, v6_bundles: bundle.v6_bundles,
      run_dir: runDir, user_data: userData, fixture, ready: primaryEvidence.ready && negativeEvidence.ready && blankDom.load_status === 'ready',
      clip_order: { primary: primary.clip_ids, negative_control: negative.clip_ids },
      primary: primaryEvidence,
      negative_control: { ...negativeEvidence, description: 'Reverse clip insertion order (V2 moved to mixed-clips index 0); V2 remains above V1 in track order.', clip_insertion_order_reversed: true, expected: 'V2 red poster remains last-painted/top despite reversed clips insertion order', observed_top_clip_id: negativeEvidence.layer_order.last_painted_clip_id, z_order_independent_of_insertion_order: negativeZOrderIndependent },
      blank_frame: { project_id: blank.project_id, project_name: blank.name, description: 'V1 video positioned at 5s; the sampled frame near 4s is a black gap.', position_patch: blankPatch, playhead: playheadState, playhead_us: playheadUs, gap_frame: gapFrame, ir: blankIr, load: { status: blankDomAfterSeek.load_status, loading_text: blankDomAfterSeek.loading_text }, previewMode: blankDomAfterSeek.preview_mode, dom: blankDomAfterSeek, boundingBox: blankReady.boundingBox, pixels_path: join(runDir, 'blank-frame-pixels.json'), center_rgba: blackSample.rgba, screenshot: 'blank-frame.png' },
      pixel_samples: { primary: primaryEvidence.pixel_samples_path, negative_control: negativeEvidence.pixel_samples_path, blank_frame: join(runDir, 'blank-frame-pixels.json') },
      screenshots: { workspace: 'workspace.png', preview: 'preview.png', timeline: 'timeline.png', primary_canvas: 'primary-canvas.png', negative_control: 'negative-control.png', blank_frame: 'blank-frame.png' },
    };
    await writeJson(evidencePath, evidence);
    console.log('P231 VERIFY PASS: ' + evidencePath);
  } finally { if (app) await app.close(); }
}
main().catch(async error => {
  const message = String(error && (error.stack || error.message) || error);
  await mkdir(runDir, { recursive: true }).catch(() => undefined);
  await writeFile(join(runDir, 'run-error.txt'), message + '\n', 'utf8').catch(() => undefined);
  console.error(message);
  process.exit(1);
});

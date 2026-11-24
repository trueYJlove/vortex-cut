import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(here, '../../evidence/p235-openfilm-timeline-parity-2026-11-24');
const manifest = JSON.parse(await readFile(path.join(evidenceDir, 'capture.json'), 'utf8'));
const fixture = manifest.fixture;
const masks = fixture.componentMasks;
if (!masks) throw new Error('fixture.json must declare componentMasks before pixel comparison');

const openUiState = manifest.captures.openfilm.metrics.actualUiState;
const vortexUiState = manifest.captures.vortex.metrics.actualUiState;
const uiStateIsComplete = state => state && Object.values(state).every(value => value !== null && value !== undefined);
const stateParity = uiStateIsComplete(openUiState) && uiStateIsComplete(vortexUiState)
  && JSON.stringify(openUiState) === JSON.stringify(vortexUiState)
  && JSON.stringify(manifest.captures.openfilm.metrics.toolbarState) === JSON.stringify(manifest.captures.vortex.metrics.toolbarState);

const timeline = fixture.timelineRegion;
const dimensions = { width: timeline.width, height: timeline.height };
const textRects = ['openfilm', 'vortex'].flatMap(side => manifest.captures[side].metrics.textRects ?? []);
const textMasks = textRects.map(rect => ({
  x: rect.x - 1,
  y: rect.y - 1,
  width: rect.width + 2,
  height: rect.height + 2,
}));
const regions = [];
const addRegion = (region) => regions.push({ thresholdPercent: masks.acceptance.structuralPercent, ...region });

addRegion({ name: 'toolbar', x: masks.toolbar.x, y: masks.toolbar.y, width: masks.toolbar.width, height: masks.toolbar.height, component: 'toolbar' });
addRegion({ name: 'ruler', x: masks.ruler.x, y: masks.ruler.y, width: masks.ruler.width, height: masks.ruler.height, component: 'ruler' });

for (const track of masks.tracks) {
  addRegion({
    name: `${track.id} track head`, x: masks.trackHeadX, y: track.y,
    width: masks.trackHeadWidth, height: track.height, component: 'track-head',
  });
  addRegion({
    name: `${track.id} cover rail`, x: masks.coverRailX, y: track.y,
    width: masks.coverRailWidth, height: track.height, component: 'cover-rail',
  });
  addRegion({
    name: `${track.id} lane background`, x: masks.contentX, y: track.y,
    width: dimensions.width - masks.contentX, height: track.height,
    component: 'lane-background', maskType: 'background-with-cutouts', trackId: track.id,
  });
}

const getClip = (side, clipId) => manifest.captures[side].metrics.clips.find(item => item.id === clipId);
const normalizedClip = (side, clip) => {
  const actual = getClip(side, clip.id);
  if (!actual || !Number.isFinite(actual.x) || !Number.isFinite(actual.y)) return null;
  return {
    x: actual.x - timeline.x,
    y: actual.y - timeline.y,
    width: actual.width,
    height: actual.height,
  };
};
for (const clip of fixture.clips) {
  const openClip = normalizedClip('openfilm', clip);
  const vortexClip = normalizedClip('vortex', clip);
  if (!openClip || !vortexClip) {
    regions.push({ name: `${clip.id} geometry missing`, x: 0, y: 0, width: 1, height: 1, component: 'clip-geometry', thresholdPercent: 100, maskType: 'empty' });
    continue;
  }
  // Use the OpenFilm fixture rect as the canonical origin. Geometry deltas are
  // reported independently, rather than letting a union hide an edge offset.
  const rect = openClip;
  const border = masks.clip.borderPx;
  const cornerRadius = Math.max(0, masks.clip.radiusPx ?? 0);
  const innerX = rect.x + border;
  const innerWidth = Math.max(0, rect.width - border * 2);
  const titleHeight = Math.min(masks.clip.titlePx, Math.max(0, rect.height - border * 2));
  const waveformHeight = clip.kind === 'audio'
    ? Math.max(0, rect.height - border * 2 - masks.clip.audioTitlePx)
    : Math.min(masks.clip.videoWaveformPx, Math.max(0, rect.height - border * 2 - titleHeight));
  const pictureHeight = clip.kind === 'video'
    ? Math.max(0, rect.height - border * 2 - titleHeight - waveformHeight)
    : 0;

  // OpenFilm's unselected clip has no drawn border; this mask measures its
  // rounded outer edge (fill/background transition), including corner AA.
  const edgeReach = border + 1;
  addRegion({
    name: `${clip.id} perimeter`,
    x: rect.x - edgeReach,
    y: rect.y - edgeReach,
    width: rect.width + edgeReach * 2,
    height: rect.height + edgeReach * 2,
    component: 'clip-perimeter',
    maskType: 'rounded-perimeter',
    shapeRect: rect,
    radiusPx: cornerRadius,
    edgeTolerancePx: border,
  });
  addRegion({
    name: `${clip.id} title strip`, x: innerX, y: rect.y + border,
    width: innerWidth, height: Math.max(0, titleHeight - border), component: 'clip-title',
  });
  if (pictureHeight > 0) {
    addRegion({
      name: `${clip.id} picture strip`, x: innerX, y: rect.y + border + titleHeight,
      width: innerWidth, height: pictureHeight, component: 'filmstrip',
      thresholdPercent: masks.acceptance.picturePercent,
    });
  }
  if (waveformHeight > 0) {
    addRegion({
      name: `${clip.id} waveform`, x: innerX,
      y: rect.y + border + titleHeight + pictureHeight,
      width: innerWidth, height: waveformHeight, component: 'waveform',
      thresholdPercent: masks.acceptance.waveformPercent,
    });
  }
}

const playheadX = masks.contentX + masks.playhead.timeUs / 1_000_000 * fixture.pixelsPerSecond;
regions.push({
  // Sample the opaque center pixel. The half-pixel antialias fringe blends the line with each application's
  // underlying thumbnail/waveform and cannot isolate the playhead color itself.
  name: 'playhead line', x: Math.floor(playheadX),
  y: masks.playhead.y, width: masks.playhead.width, height: masks.playhead.height,
  component: 'playhead', thresholdPercent: masks.acceptance.structuralPercent,
});
for (const marker of masks.markers) {
  const x = masks.contentX + marker.timeUs / 1_000_000 * fixture.pixelsPerSecond;
  regions.push({ name: `${marker.id} marker`, x: x - marker.width / 2, y: marker.y, width: marker.width, height: marker.height, component: 'marker', thresholdPercent: masks.acceptance.structuralPercent });
}

const openfilm = await readFile(path.join(evidenceDir, 'openfilm.png'));
const vortex = await readFile(path.join(evidenceDir, 'vortex.png'));
const openfilmTextBackground = await readFile(path.join(evidenceDir, 'openfilm-text-background.png'));
const vortexTextBackground = await readFile(path.join(evidenceDir, 'vortex-text-background.png'));
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: dimensions, deviceScaleFactor: 1 });
await page.setContent('<canvas id="openfilm"></canvas><canvas id="vortex"></canvas><canvas id="openfilm-bg"></canvas><canvas id="vortex-bg"></canvas><canvas id="diff"></canvas>');
const result = await page.evaluate(async ({ openfilmPng, vortexPng, openfilmTextBackgroundPng, vortexTextBackgroundPng, regions, width, height, textMasks, textRects }) => {
  const load = async (id, encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.getElementById(id);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return { canvas, pixels: context.getImageData(0, 0, width, height).data };
  };
  const a = await load('openfilm', openfilmPng);
  const b = await load('vortex', vortexPng);
  const aBackground = await load('openfilm-bg', openfilmTextBackgroundPng);
  const bBackground = await load('vortex-bg', vortexTextBackgroundPng);
  const diffCanvas = document.getElementById('diff');
  diffCanvas.width = width;
  diffCanvas.height = height;
  const diffContext = diffCanvas.getContext('2d');
  const diffData = diffContext.createImageData(width, height);
  for (let i = 0; i < a.pixels.length; i += 4) {
    diffData.data[i] = Math.min(255, Math.abs(a.pixels[i] - b.pixels[i]) * 4);
    diffData.data[i + 1] = Math.min(255, Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) * 4);
    diffData.data[i + 2] = Math.min(255, Math.abs(a.pixels[i + 2] - b.pixels[i + 2]) * 4);
    diffData.data[i + 3] = 255;
  }
  diffContext.putImageData(diffData, 0, 0);

  const inRect = (x, y, rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const roundedRectDistance = (x, y, rect, radius) => {
    const qx = Math.abs(x - (rect.x + rect.width / 2)) - (rect.width / 2 - radius);
    const qy = Math.abs(y - (rect.y + rect.height / 2)) - (rect.height / 2 - radius);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  };
  const textAt = (x, y) => textMasks.some(mask => inRect(x, y, mask));
  const clipRects = ['openfilm', 'vortex'].flatMap(side => textRects[side].clips.filter(Boolean));
  const insideClip = (x, y, trackId = null) => clipRects.some(rect => (!trackId || rect.trackId === trackId) && inRect(x, y, rect));
  const summarize = (region, { threshold = 3, maskText = true } = {}) => {
    let samples = 0;
    let excludedTextPixels = 0;
    let excludedClipPixels = 0;
    let pass = 0;
    let absolute = 0;
    let max = 0;
    const perimeterMismatchLocations = [];
    const perimeterSides = Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, { pixels: 0, pass: 0, maxChannelDifference: 0 }]));
    const perimeterCorners = Object.fromEntries(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map(corner => [corner, { pixels: 0, pass: 0, maxChannelDifference: 0 }]));
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const right = Math.min(width, Math.ceil(region.x + region.width));
    const bottom = Math.min(height, Math.ceil(region.y + region.height));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (region.maskType === 'empty') continue;
        if (region.maskType === 'rounded-perimeter' &&
            Math.abs(roundedRectDistance(x + 0.5, y + 0.5, region.shapeRect, region.radiusPx)) > region.edgeTolerancePx) continue;
        if (maskText && textAt(x, y)) { excludedTextPixels += 1; continue; }
        if (region.maskType === 'background-with-cutouts' && insideClip(x, y, region.trackId)) { excludedClipPixels += 1; continue; }
        const offset = (y * width + x) * 4;
        const dr = Math.abs(a.pixels[offset] - b.pixels[offset]);
        const dg = Math.abs(a.pixels[offset + 1] - b.pixels[offset + 1]);
        const db = Math.abs(a.pixels[offset + 2] - b.pixels[offset + 2]);
        samples += 1;
        const within = dr <= threshold && dg <= threshold && db <= threshold;
        if (within) pass += 1;
        if (region.maskType === 'rounded-perimeter' && !within) perimeterMismatchLocations.push({
          x, y, openfilm: [a.pixels[offset], a.pixels[offset + 1], a.pixels[offset + 2]],
          vortex: [b.pixels[offset], b.pixels[offset + 1], b.pixels[offset + 2]],
          difference: [dr, dg, db],
        });
        if (region.maskType === 'rounded-perimeter') {
          const px = x + 0.5;
          const py = y + 0.5;
          const rect = region.shapeRect;
          const cornerReach = region.radiusPx + region.edgeTolerancePx;
          const corner = px < rect.x + cornerReach && py < rect.y + cornerReach ? 'topLeft'
            : px >= rect.x + rect.width - cornerReach && py < rect.y + cornerReach ? 'topRight'
              : px < rect.x + cornerReach && py >= rect.y + rect.height - cornerReach ? 'bottomLeft'
                : px >= rect.x + rect.width - cornerReach && py >= rect.y + rect.height - cornerReach ? 'bottomRight' : null;
          if (corner) {
            perimeterCorners[corner].pixels += 1;
            if (within) perimeterCorners[corner].pass += 1;
            perimeterCorners[corner].maxChannelDifference = Math.max(perimeterCorners[corner].maxChannelDifference, dr, dg, db);
          } else {
          const edge = [
            { side: 'top', distance: Math.abs(py - region.shapeRect.y) },
            { side: 'right', distance: Math.abs(region.shapeRect.x + region.shapeRect.width - px) },
            { side: 'bottom', distance: Math.abs(region.shapeRect.y + region.shapeRect.height - py) },
            { side: 'left', distance: Math.abs(px - region.shapeRect.x) },
          ].sort((left, right) => left.distance - right.distance)[0].side;
          perimeterSides[edge].pixels += 1;
          if (within) perimeterSides[edge].pass += 1;
          perimeterSides[edge].maxChannelDifference = Math.max(perimeterSides[edge].maxChannelDifference, dr, dg, db);
          }
        }
        absolute += dr + dg + db;
        max = Math.max(max, dr, dg, db);
      }
    }
    return {
      ...region,
      pixels: samples,
      rgbChannelsWithinThresholdPercent: samples ? pass / samples * 100 : 0,
      meanAbsoluteChannelDifference: samples ? absolute / (samples * 3) : 0,
      maxChannelDifference: max,
      rgbTolerancePerChannel: threshold,
      ...(region.maskType === 'rounded-perimeter' ? {
        perimeterMismatchLocations,
        perimeterSides: Object.fromEntries(Object.entries(perimeterSides).map(([side, value]) => [side, {
          pixels: value.pixels,
          rgbChannelsWithinThresholdPercent: value.pixels ? value.pass / value.pixels * 100 : 100,
          maxChannelDifference: value.maxChannelDifference,
        }])),
        perimeterCorners: Object.fromEntries(Object.entries(perimeterCorners).map(([corner, value]) => [corner, {
          pixels: value.pixels,
          rgbChannelsWithinThresholdPercent: value.pixels ? value.pass / value.pixels * 100 : 100,
          maxChannelDifference: value.maxChannelDifference,
        }]))
      } : {}),
      excludedTextPixels,
      excludedClipPixels,
    };
  };

  const keys = (side) => {
    const counts = new Map();
    return textRects[side].items.map(item => {
      const base = `${item.clipId ?? ''}\u0000${item.text}`;
      const index = counts.get(base) ?? 0;
      counts.set(base, index + 1);
      return { ...item, key: `${base}\u0000${index}` };
    });
  };
  const openText = keys('openfilm');
  const vortexText = keys('vortex');
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  const parseColor = color => {
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = color;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
    return [r, g, b, alpha / 255];
  };
  const glyphCoverage = (visible, background, foreground, offset) => {
    let projection = 0;
    let contrastSquared = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const contrast = foreground[channel] - background[offset + channel];
      projection += (visible[offset + channel] - background[offset + channel]) * contrast;
      contrastSquared += contrast * contrast;
    }
    return contrastSquared > 0 ? Math.max(0, Math.min(1, projection / contrastSquared)) : 0;
  };
  const vortexByKey = new Map(vortexText.map(item => [item.key, item]));
  const openByKey = new Map(openText.map(item => [item.key, item]));
  const textMetrics = [];
  for (const openItem of openText) {
    const vortexItem = vortexByKey.get(openItem.key);
    if (!vortexItem) {
      textMetrics.push({ key: openItem.key, text: openItem.text, clipId: openItem.clipId, passed: false, reason: 'missing from Vortex' });
      continue;
    }
    const boxA = openItem.lineBox ?? openItem;
    const boxB = vortexItem.lineBox ?? vortexItem;
    const geometryErrors = Object.fromEntries(['x', 'y', 'width', 'height'].map(field => [field, Math.abs(boxA[field] - boxB[field])]));
    const ink = union(boxA, boxB, 1);
    const foregroundA = parseColor(openItem.color);
    const foregroundB = parseColor(vortexItem.color);
    let glyphPixels = 0;
    let glyphPass = 0;
    let coverageDifferenceSum = 0;
    let coverageDifferenceMax = 0;
    let backgroundSamples = 0;
    let backgroundPass = 0;
    let backgroundDifferenceSum = 0;
    let glyphMaskUnion = 0;
    let glyphMaskIntersection = 0;
    const glyphMaskMismatchLocations = [];
    for (let y = Math.max(0, Math.floor(ink.y)); y < Math.min(height, Math.ceil(ink.y + ink.height)); y += 1) {
      for (let x = Math.max(0, Math.floor(ink.x)); x < Math.min(width, Math.ceil(ink.x + ink.width)); x += 1) {
        const offset = (y * width + x) * 4;
        const backgroundDifference = [0, 1, 2].map(channel => Math.abs(aBackground.pixels[offset + channel] - bBackground.pixels[offset + channel]));
        backgroundSamples += 1;
        if (backgroundDifference.every(difference => difference <= 3)) backgroundPass += 1;
        backgroundDifferenceSum += backgroundDifference.reduce((sum, difference) => sum + difference, 0);
        const coverageA = glyphCoverage(a.pixels, aBackground.pixels, foregroundA, offset);
        const coverageB = glyphCoverage(b.pixels, bBackground.pixels, foregroundB, offset);
        const isGlyphA = coverageA * 255 > 2;
        const isGlyphB = coverageB * 255 > 2;
        const inShapeA = coverageA >= 0.25;
        const inShapeB = coverageB >= 0.25;
        if (inShapeA !== inShapeB) glyphMaskMismatchLocations.push({ x, y, openfilmCoverage: coverageA, vortexCoverage: coverageB });
        if (inShapeA || inShapeB) glyphMaskUnion += 1;
        if (inShapeA && inShapeB) glyphMaskIntersection += 1;
        if (!isGlyphA && !isGlyphB) continue;
        glyphPixels += 1;
        const coverageDifference = Math.abs(coverageA - coverageB) * 255;
        coverageDifferenceSum += coverageDifference;
        coverageDifferenceMax = Math.max(coverageDifferenceMax, coverageDifference);
        const close = coverageDifference <= 8;
        if (close) glyphPass += 1;
      }
    }
    const styleErrors = {
      fontFamily: openItem.fontFamily !== vortexItem.fontFamily,
      fontSizePx: Math.abs(Number.parseFloat(openItem.fontSize) - Number.parseFloat(vortexItem.fontSize)),
      fontWeight: openItem.fontWeight !== vortexItem.fontWeight,
      fontFeatureSettings: openItem.fontFeatureSettings !== vortexItem.fontFeatureSettings,
      webkitFontSmoothing: openItem.webkitFontSmoothing !== vortexItem.webkitFontSmoothing,
      fontSynthesis: openItem.fontSynthesis !== vortexItem.fontSynthesis,
      fontKerning: openItem.fontKerning !== vortexItem.fontKerning,
      fontOpticalSizing: openItem.fontOpticalSizing !== vortexItem.fontOpticalSizing,
      fontVariationSettings: openItem.fontVariationSettings !== vortexItem.fontVariationSettings,
      fontStretch: openItem.fontStretch !== vortexItem.fontStretch,
      fontVariantLigatures: openItem.fontVariantLigatures !== vortexItem.fontVariantLigatures,
      fontVariantNumeric: openItem.fontVariantNumeric !== vortexItem.fontVariantNumeric,
      textRendering: openItem.textRendering !== vortexItem.textRendering,
      color: foregroundA.some((value, index) => Math.abs(value - (foregroundB[index] ?? 0)) > (index === 3 ? 0.01 : 1)),
      lineHeightPx: Math.abs(Number.parseFloat(openItem.lineHeight) - Number.parseFloat(vortexItem.lineHeight)),
      letterSpacingPx: Math.abs(Number.parseFloat(openItem.letterSpacing) - Number.parseFloat(vortexItem.letterSpacing)),
    };
    const stylePassed = !styleErrors.fontFamily && !styleErrors.fontWeight && !styleErrors.fontFeatureSettings &&
      !styleErrors.webkitFontSmoothing && !styleErrors.fontSynthesis && !styleErrors.fontKerning &&
      !styleErrors.fontOpticalSizing && !styleErrors.fontVariationSettings && !styleErrors.fontStretch &&
      !styleErrors.fontVariantLigatures && !styleErrors.fontVariantNumeric && !styleErrors.textRendering && !styleErrors.color &&
      styleErrors.fontSizePx <= 0.2 && styleErrors.lineHeightPx <= 0.2 && styleErrors.letterSpacingPx <= 0.2;
    const geometryPassed = Object.values(geometryErrors).every(error => error <= 1);
    const glyphPercent = glyphPixels ? glyphPass / glyphPixels * 100 : 0;
    const glyphShapeIouPercent = glyphMaskUnion ? glyphMaskIntersection / glyphMaskUnion * 100 : 0;
    const glyphShapePassed = glyphMaskUnion > 0 && glyphShapeIouPercent >= 95;
    textMetrics.push({
      key: openItem.key,
      text: openItem.text,
      clipId: openItem.clipId,
      fontFamily: openItem.fontFamily,
      fontSize: openItem.fontSize,
      fontWeight: openItem.fontWeight,
      geometryErrors,
      styleErrors,
      glyphPixels,
      glyphWithin8Percent: glyphPercent,
      glyphMeanAbsoluteCoverageDifference: glyphPixels ? coverageDifferenceSum / glyphPixels : null,
      glyphMaxAbsoluteCoverageDifference: glyphPixels ? coverageDifferenceMax : null,
      glyphMaskMismatchLocations,
      textBackgroundRgbWithin3Percent: backgroundSamples ? backgroundPass / backgroundSamples * 100 : null,
      textBackgroundMeanAbsoluteChannelDifference: backgroundSamples ? backgroundDifferenceSum / (backgroundSamples * 3) : null,
      glyphCoverageDiagnosticOnly: true,
      glyphMaskThreshold: 0.25,
      glyphShapeIouPercent,
      glyphShapeThresholdPercent: 95,
      glyphShapePassed,
      geometryPassed,
      stylePassed,
      layoutPassed: geometryPassed && stylePassed,
      passed: geometryPassed && stylePassed && glyphShapePassed,
    });
  }
  for (const vortexItem of vortexText) if (!openByKey.has(vortexItem.key)) {
    textMetrics.push({ key: vortexItem.key, text: vortexItem.text, clipId: vortexItem.clipId, passed: false, reason: 'missing from OpenFilm' });
  }

  const acceptanceRegions = regions.map(region => summarize(region));
  const diagnostics = [summarize({ name: 'full timeline diagnostic only', x: 0, y: 0, width, height, component: 'diagnostic' })];
  const cropCanvases = acceptanceRegions.map(region => {
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.ceil(region.width));
    crop.height = Math.max(1, Math.ceil(region.height) * 3);
    const context = crop.getContext('2d');
    context.drawImage(a.canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    context.drawImage(b.canvas, region.x, region.y, region.width, region.height, 0, region.height, region.width, region.height);
    context.drawImage(diffCanvas, region.x, region.y, region.width, region.height, 0, region.height * 2, region.width, region.height);
    return { name: region.name, png: crop.toDataURL('image/png').split(',')[1] };
  });
  const diffPng = diffCanvas.toDataURL('image/png').split(',')[1];
  function union(left, right, padding = 0) {
    const x = Math.min(left.x, right.x) - padding;
    const y = Math.min(left.y, right.y) - padding;
    return {
      x: Math.max(0, x), y: Math.max(0, y),
      width: Math.max(left.x + left.width, right.x + right.width) - x + padding,
      height: Math.max(left.y + left.height, right.y + right.height) - y + padding,
    };
  }
  return { acceptanceRegions, diagnostics, textMetrics, crops: cropCanvases, diffPng };
}, {
  openfilmPng: openfilm.toString('base64'),
  vortexPng: vortex.toString('base64'),
  openfilmTextBackgroundPng: openfilmTextBackground.toString('base64'),
  vortexTextBackgroundPng: vortexTextBackground.toString('base64'),
  regions,
  ...dimensions,
  textMasks,
  textRects: {
    openfilm: {
      items: manifest.captures.openfilm.metrics.textRects ?? [],
      clips: fixture.clips.map(clip => ({ ...normalizedClip('openfilm', clip), trackId: clip.trackId })),
    },
    vortex: {
      items: manifest.captures.vortex.metrics.textRects ?? [],
      clips: fixture.clips.map(clip => ({ ...normalizedClip('vortex', clip), trackId: clip.trackId })),
    },
  },
});

const geometryChecks = [];
const compareRect = (name, left, right, fields = ['x', 'y', 'width', 'height']) => {
  if (!left || !right) {
    geometryChecks.push({ name, passed: false, reason: 'missing geometry' });
    return;
  }
  const errors = Object.fromEntries(fields.map(field => [field, Math.abs(left[field] - right[field])]));
  geometryChecks.push({ name, errors, passed: Object.values(errors).every(error => error <= 1) });
};
for (const name of ['toolbar', 'ruler']) compareRect(name,
  manifest.captures.openfilm.metrics[name], manifest.captures.vortex.metrics[name]);
const openRulerTicks = manifest.captures.openfilm.metrics.rulerTicks ?? [];
const vortexRulerTicks = manifest.captures.vortex.metrics.rulerTicks ?? [];
const rulerTickPairs = openRulerTicks.map((tick, index) => [tick, vortexRulerTicks[index]]);
const rulerTickErrors = rulerTickPairs.flatMap(([openTick, vortexTick]) => vortexTick
  ? [{
    x: Math.abs(openTick.x - vortexTick.x),
    y: Math.abs(openTick.y - vortexTick.y),
    height: Math.abs(openTick.height - vortexTick.height),
    labelMismatch: openTick.label !== vortexTick.label,
  }]
  : [{ x: Infinity, y: Infinity, height: Infinity, labelMismatch: true }]);
const rulerTickSummary = {
  openfilmCount: openRulerTicks.length,
  vortexCount: vortexRulerTicks.length,
  maxXError: Math.max(0, ...rulerTickErrors.map(error => error.x)),
  maxYError: Math.max(0, ...rulerTickErrors.map(error => error.y)),
  maxHeightError: Math.max(0, ...rulerTickErrors.map(error => error.height)),
  labelMismatches: rulerTickErrors.filter(error => error.labelMismatch).length + Math.max(0, vortexRulerTicks.length - openRulerTicks.length),
};
geometryChecks.push({
  name: 'ruler ticks',
  errors: rulerTickSummary,
  passed: rulerTickSummary.openfilmCount > 0
    && rulerTickSummary.openfilmCount === rulerTickSummary.vortexCount
    && rulerTickSummary.maxXError <= 1
    && rulerTickSummary.maxYError <= 1
    && rulerTickSummary.maxHeightError <= 1
    && rulerTickSummary.labelMismatches === 0,
});
for (const track of masks.tracks) {
  const openHead = manifest.captures.openfilm.metrics.heads.find(item => item.id === track.id);
  const vortexHead = manifest.captures.vortex.metrics.heads.find(item => item.id === track.id);
  compareRect(`${track.id} track head`, openHead, vortexHead);
}
for (const marker of masks.markers) {
  const openMarker = manifest.captures.openfilm.metrics.markerRects.find(item => item.id === marker.id);
  const vortexMarker = manifest.captures.vortex.metrics.markerRects.find(item => item.id === marker.id);
  compareRect(`${marker.id} marker glyph`, openMarker, vortexMarker);
}
for (const clip of fixture.clips) compareRect(`${clip.id} clip`, normalizedClip('openfilm', clip), normalizedClip('vortex', clip));

const totalMissing = result.textMetrics.filter(item => !item.passed);
const componentResults = result.acceptanceRegions.map(region => ({
  name: region.name,
  component: region.component,
  thresholdPercent: region.thresholdPercent,
  actualPercent: region.rgbChannelsWithinThresholdPercent,
  passed: region.rgbChannelsWithinThresholdPercent >= region.thresholdPercent,
}));
const coverage = {
  toolbar: componentResults.some(item => item.component === 'toolbar'),
  ruler: componentResults.some(item => item.component === 'ruler'),
  perTrackHeads: masks.tracks.every(track => componentResults.some(item => item.name === `${track.id} track head`)),
  perTrackCoverRails: masks.tracks.every(track => componentResults.some(item => item.name === `${track.id} cover rail`)),
  laneBackgroundsExcludeClipBodies: result.acceptanceRegions.filter(region => region.component === 'lane-background').every(region => region.excludedClipPixels > 0),
  clipTitles: fixture.clips.every(clip => componentResults.some(item => item.name === `${clip.id} title strip`)),
  clipPerimeters: fixture.clips.every(clip => componentResults.some(item => item.name === `${clip.id} perimeter`)),
  perFilmstrip: fixture.clips.filter(clip => clip.kind === 'video').every(clip => componentResults.some(item => item.name === `${clip.id} picture strip`)),
  perWaveform: fixture.clips.every(clip => componentResults.some(item => item.name === `${clip.id} waveform`)),
  playhead: componentResults.some(item => item.name === 'playhead line'),
  markers: masks.markers.length > 0,
  perText: result.textMetrics.length > 0 && result.textMetrics.every(item => item.passed),
  nativeCapture: false,
  stateParity,
};
const coverageComplete = Object.values(coverage).every(Boolean);
const report = {
  generatedAt: new Date().toISOString(),
  input: ['openfilm.png', 'vortex.png'],
  method: 'Fixture-manifest component masks; same-size RGB comparison in Chromium; channel difference image amplified ×4. Text rectangles are excluded from raw component regions and checked separately for CSS style/line-box geometry plus thresholded glyph-silhouette IoU from paired transparent-text screenshots. Pixelwise glyph coverage delta is diagnostic only because alpha compositing varies with the underlying render path.',
  acceptance: 'Per-component P235 thresholds apply only to the controlled Chromium fixture. Full visual acceptance requires complete component coverage, matching fixture states, native captures, and all thresholds passing.',
  componentMasks: 'tools/openfilm-timeline-parity/fixture.json:componentMasks',
  geometryChecks,
  coverage,
  coverageComplete,
  stateParity,
  textMetrics: result.textMetrics,
  textSummary: { count: result.textMetrics.length, passed: result.textMetrics.filter(item => item.passed).length, failed: totalMissing.length },
  regions: result.acceptanceRegions,
  diagnostics: result.diagnostics,
};
const fixturePixelsPassed = stateParity && componentResults.every(item => item.passed) && totalMissing.length === 0 && geometryChecks.every(check => check.passed);
report.fixtureVisualAcceptance = {
  status: fixturePixelsPassed && coverageComplete ? 'passed' : 'failed',
  fixturePixelsPassed,
  coverageComplete,
  note: 'A failed region is a rejection of this fixture only. No fixture threshold result establishes feature, native Electron, Core revision/undo, or performance parity.',
  regions: componentResults,
};

const diffDir = path.join(evidenceDir, 'region-diffs');
await mkdir(diffDir, { recursive: true });
for (const crop of result.crops) {
  const filename = `${crop.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.png`;
  await writeFile(path.join(diffDir, filename), Buffer.from(crop.png, 'base64'));
}
await writeFile(path.join(evidenceDir, 'diff-amplified.png'), Buffer.from(result.diffPng, 'base64'));
manifest.pixelComparison = {
  status: report.fixtureVisualAcceptance.status === 'passed' ? 'fixture-thresholds-passed' : 'fixture-thresholds-failed',
  rgbTolerancePerChannel: 3,
  regionCount: componentResults.length,
  failedRegions: componentResults.filter(item => !item.passed).map(({ name, thresholdPercent, actualPercent }) => ({ name, thresholdPercent, actualPercent })),
  textMetrics: report.textSummary,
  geometryChecks,
  coverage,
  note: report.fixtureVisualAcceptance.note,
};
await writeFile(path.join(evidenceDir, 'capture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(evidenceDir, 'raw-pixel-comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
process.stdout.write(`${JSON.stringify({
  output: path.join(evidenceDir, 'raw-pixel-comparison.json'),
  regionCount: componentResults.length,
  failedRegions: componentResults.filter(item => !item.passed).map(({ name, thresholdPercent, actualPercent }) => ({ name, thresholdPercent, actualPercent: Number(actualPercent.toFixed(2)) })),
  textSummary: report.textSummary,
  coverage: report.coverage,
  fixtureVisualAcceptance: report.fixtureVisualAcceptance.status,
}, null, 2)}\n`);

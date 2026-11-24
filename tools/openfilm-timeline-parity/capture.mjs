import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.join(here, 'fixture.json'), 'utf8'));
const maxClipEndUs = Math.max(0, ...fixture.clips.map(clip => clip.endUs));
if (fixture.durationUs !== maxClipEndUs) {
  throw new Error(`Fixture project duration (${fixture.durationUs}µs) must match the longest timeline clip (${maxClipEndUs}µs)`);
}
const outputDir = path.resolve(here, '../../evidence/p235-openfilm-timeline-parity-2026-11-24');
const buildDir = path.resolve(here, '../../.codex-tmp/openfilm-timeline-parity-dist');
await mkdir(outputDir, { recursive: true });
const assertNear = (actual, expected, label, tolerance = 1) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ±${tolerance}, got ${actual}`);
};

// Always capture the current source. Reusing an old dist silently made screenshots
// ignore source edits, so resolve the exact Vite package imported by vite.config.mjs
// and rebuild before opening either side of the paired fixture.
const repoRoot = path.resolve(here, '../..');
const viteConfigPath = path.join(here, 'vite.config.mjs');
const viteConfigSource = await readFile(viteConfigPath, 'utf8');
const viteEntry = viteConfigSource.match(/from ['"]([^'"]+\/vite\/dist\/node\/index\.js)['"]/)?.[1];
if (!viteEntry) throw new Error('Cannot find the Vite entry imported by vite.config.mjs');
const viteCli = path.resolve(path.dirname(viteEntry), '../../bin/vite.js');
const sourceBuild = spawnSync(process.execPath, [viteCli, 'build', '--config', viteConfigPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (sourceBuild.error || sourceBuild.status !== 0) {
  throw new Error(`Current-source fixture build failed: ${sourceBuild.error?.message ?? sourceBuild.stderr ?? sourceBuild.status}`);
}
process.stdout.write(sourceBuild.stdout);

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'],
});

const captures = {};
for (const [name, route, sliderSelector] of [
  ['openfilm', '/', 'input.tl-zoom'],
  ['vortex', '/vortex.html', 'input.timeline-zoom-slider'],
]) {
  const page = await browser.newPage({
    viewport: { width: fixture.viewport.width, height: fixture.viewport.height },
    deviceScaleFactor: fixture.viewport.deviceScaleFactor,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const pageErrors = [];
  const requests = [];
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/prefs')) return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      if (url.endsWith('/api/library')) return Promise.resolve(new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
      return nativeFetch(input, init);
    };
    window.__timelineCanvasText = [];
    window.__timelineWorkerEvents = [];
    window.__timelineCanvasDraws = [];
    window.__timelineRoundRects = [];
    window.__p235ModifierEvents = [];
    window.__p235ListenerRuns = [];
    window.__p235OpenFilmDragProbe = [];
    window.__p235PlanCalls = [];
    window.__p235PlanPhases = [];
    window.__p235VortexMoveModes = [];
    window.__p235VortexMovePlans = [];
    window.__p235TrackModifiers = false;
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    const wrappedListeners = new WeakMap();
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this !== window || typeof listener !== 'function' || !['keydown', 'keyup'].includes(type)) {
        return nativeAddEventListener.call(this, type, listener, options);
      }
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const key = `${type}:${capture}`;
      const byType = wrappedListeners.get(listener) ?? new Map();
      if (byType.has(key)) return nativeAddEventListener.call(this, type, byType.get(key), options);
      const wrapped = function (event) {
        if (window.__p235TrackModifiers) window.__p235ListenerRuns.push({ type, key: event.key ?? null, capture, handler: String(listener).slice(0, 180) });
        return listener.call(this, event);
      };
      byType.set(key, wrapped);
      wrappedListeners.set(listener, byType);
      return nativeAddEventListener.call(this, type, wrapped, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const wrapped = typeof listener === 'function' ? wrappedListeners.get(listener)?.get(`${type}:${capture}`) : undefined;
      return nativeRemoveEventListener.call(this, type, wrapped ?? listener, options);
    };
    for (const type of ['keydown', 'keyup', 'pointermove', 'pointerup']) window.addEventListener(type, event => {
      if (!window.__p235TrackModifiers) return;
      window.__p235ModifierEvents.push({ type, key: event.key ?? null, altKey: event.altKey, isTrusted: event.isTrusted, x: event.clientX ?? null, y: event.clientY ?? null });
    }, true);
    const NativeWorker = window.Worker;
    class FixtureWorker {
      listeners = new Map();
      stopped = false;
      addEventListener(type, listener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
      removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
      terminate() { this.stopped = true; }
      dispatch(type, data) {
        if (this.stopped) return;
        if (type === 'message') window.__timelineWorkerEvents.push({ type: data.type, id: data.id ?? null, message: data.message ?? null, timeUs: data.timeUs ?? null });
        const event = type === 'message' ? new MessageEvent(type, { data }) : new ErrorEvent(type, { message: data.message ?? '' });
        for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
      }
      postMessage(message) {
        if (message?.type === 'init') {
          queueMicrotask(() => this.dispatch('message', { type: 'ready', width: 320, height: 180, durationUs: 21_000_000, sampleCount: 315, hardware: 'fixture-frame-map' }));
          return;
        }
        if (message?.type === 'decode-at') {
          const frames = window.__timelineFrameUrls ?? [];
          const frameTimes = window.__timelineFrameTimes ?? frames.map((_, index) => index * 2);
          const requestedSec = message.timeUs / 1_000_000;
          const index = frameTimes.reduce((best, seconds, candidate) =>
            Math.abs(seconds - requestedSec) <= Math.abs(frameTimes[best] - requestedSec) ? candidate : best, 0);
          const image = new Image();
          image.onload = () => createImageBitmap(image).then(bitmap => this.dispatch('message', {
            type: 'bitmap', id: message.id, timeUs: message.timeUs, bitmap, width: bitmap.width, height: bitmap.height,
          }));
          image.onerror = () => this.dispatch('message', { type: 'error', id: message.id, message: `fixture frame ${index} failed to load` });
          image.src = frames[index];
        }
      }
    }
    window.Worker = new Proxy(NativeWorker, { construct: (_target, args) => new FixtureWorker(args[0]) });
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      const renderedText = String(text);
      if (this.canvas.width > 500 && this.canvas.height > 100) {
        const metrics = this.measureText(renderedText);
        const bounds = this.canvas.getBoundingClientRect();
        const transform = this.getTransform();
        const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 10);
        window.__timelineCanvasText.push({
          text: renderedText,
          font: this.font,
          baseline: this.textBaseline,
          align: this.textAlign,
          x: x * transform.a + y * transform.c + transform.e,
          y: x * transform.b + y * transform.d + transform.f,
          width: metrics.width,
          height: fontSize,
          actualAscent: metrics.actualBoundingBoxAscent,
          actualDescent: metrics.actualBoundingBoxDescent,
          letterSpacing: this.letterSpacing ?? null,
          fontKerning: this.fontKerning ?? null,
          canvas: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, backingWidth: this.canvas.width, backingHeight: this.canvas.height },
        });
      } else if (this.canvas.height <= 32 && y <= 18) {
        window.__timelineCanvasText.push({ text: renderedText, x, y, font: this.font, canvasWidth: this.canvas.width, canvasHeight: this.canvas.height });
      }
      return originalFillText.call(this, text, x, y, ...rest);
    };
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (this.canvas.width > 500 && this.canvas.height > 100) {
        window.__timelineCanvasDraws.push({ x: args.at(-4) ?? args[0], y: args.at(-3) ?? args[1], width: args.at(-2) ?? null, height: args.at(-1) ?? null, source: source?.constructor?.name ?? typeof source });
      }
      return originalDrawImage.call(this, source, ...args);
    };
    const originalRoundRect = CanvasRenderingContext2D.prototype.roundRect;
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, width, height, ...rest) {
      if (this.canvas.width > 500 && this.canvas.height > 100 && width > 40 && height > 20) {
        const rect = this.canvas.getBoundingClientRect();
        window.__timelineRoundRects.push({
          x, y, width, height,
          canvasWidth: this.canvas.width,
          canvasHeight: this.canvas.height,
          transform: (() => { const matrix = this.getTransform(); return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }; })(),
          css: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      }
      return originalRoundRect.call(this, x, y, width, height, ...rest);
    };
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), range: request.headers().range ?? null }));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => pageErrors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  const pageFile = route === '/' ? 'index.html' : 'vortex.html';
  const pageUrl = pathToFileURL(path.join(buildDir, pageFile)).href;
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const rootSelector = name === 'openfilm' ? '[data-timeline]' : '.timeline-pane';
  const rootPresent = await page.locator(rootSelector).count();
  if (!rootPresent) {
    const debug = await page.evaluate(() => ({ title: document.title, html: document.body.innerHTML.slice(0, 4000) }));
    throw new Error(`${name} did not render: ${JSON.stringify({ debug, pageErrors })}`);
  }
  await page.waitForSelector(sliderSelector, { state: 'attached', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);

  const before = await page.evaluate(({ name, sliderSelector, fixture }) => {
    const slider = document.querySelector(sliderSelector);
    const root = name === 'openfilm' ? document.querySelector('[data-timeline]') : document.querySelector('.timeline-pane');
    const scroller = name === 'openfilm'
      ? document.querySelector('.tl-scroll')
      : document.querySelector('.timeline-scroll');
    const body = name === 'openfilm'
      ? root?.querySelector(':scope > div:nth-child(2)')
      : document.querySelector('.timeline-body');
    const canvas = [...document.querySelectorAll('canvas')].map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: el.className?.baseVal ?? el.className, x: r.x, y: r.y, width: r.width, height: r.height };
    });
    return {
      sliderFound: Boolean(slider),
      sliderValue: slider?.value,
      timelineFont: {
        family: getComputedStyle(root ?? document.body).fontFamily,
        interVariableReady: document.fonts.check('11px "Inter Variable"'),
      },
      scrollerWidth: scroller?.clientWidth ?? null,
      bodyWidth: body?.clientWidth ?? null,
      root: root ? { x: root.getBoundingClientRect().x, y: root.getBoundingClientRect().y, width: root.clientWidth, height: root.clientHeight } : null,
      canvas,
      openfilmBlocks: name === 'openfilm' ? [...document.querySelectorAll('[data-block-id]')].map(el => ({ id: el.getAttribute('data-block-id'), r: (() => { const x = el.getBoundingClientRect(); return { x: x.x, y: x.y, width: x.width, height: x.height }; })(), ancestors: (() => { const result = []; let parent = el; for (let i = 0; parent && i < 5; i += 1, parent = parent.parentElement) { const r = parent.getBoundingClientRect(); result.push({ tag: parent.tagName, className: typeof parent.className === 'string' ? parent.className : '', y: r.y, height: r.height, top: parent.style.top, paddingTop: parent.style.paddingTop, dataZoomLayer: parent.getAttribute('data-zoom-layer') }); } return result; })() })) : [],
      openfilmClipText: name === 'openfilm' ? [...document.querySelectorAll('[data-block-id]')].flatMap(block => [...block.querySelectorAll('span')]
        .filter(span => [...span.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
        .map(span => { const r = span.getBoundingClientRect(); return { clipId: block.getAttribute('data-block-id'), text: span.textContent?.trim() ?? '', x: r.x - fixture.timelineRegion.x, y: r.y - fixture.timelineRegion.y, width: r.width, height: r.height }; })) : [],
      openfilmScroller: name === 'openfilm' ? (() => { const el = document.querySelector('.tl-scroll'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollLeft: el.scrollLeft }; })() : null,
      vortexHeads: name === 'vortex' ? [...document.querySelectorAll('.timeline-track-head')].map(el => ({ id: el.getAttribute('data-track-id'), r: (() => { const x = el.getBoundingClientRect(); return { x: x.x, y: x.y, width: x.width, height: x.height }; })() })) : [],
      viewport: fixture.viewport,
    };
  }, { name, sliderSelector, fixture });

  const readPps = () => page.evaluate(({ name }) => {
    if (name === 'openfilm') {
      return window.__openfilmView?.pxPerMs ? window.__openfilmView.pxPerMs * 1000 : null;
    }
    const canvas = document.querySelector('canvas[aria-label="时间线画布"]');
    const pps = Number(canvas?.getAttribute('data-timeline-pps'));
    return Number.isFinite(pps) && pps > 0 ? pps : null;
  }, { name });
  const setPpsTarget = async targetPps => {
    const totalMs = maxClipEndUs / 1000;
    const timeWidthPx = fixture.timelineRegion.width
      - fixture.componentMasks.trackHeadWidth
      - fixture.componentMasks.coverRailWidth;
    const minZoom = totalMs / Math.max(totalMs * 4, 30_000);
    const maxZoom = Math.max(minZoom, totalMs / 1000);
    const zoom = totalMs * targetPps / (timeWidthPx * 1000);
    if (!(zoom >= minZoom && zoom <= maxZoom)) {
      throw new Error(`${name} requested ${targetPps}px/s is outside the fixture zoom bounds`);
    }
    const sliderPosition = Math.log(zoom / minZoom) / Math.log(maxZoom / minZoom);
    await page.locator(sliderSelector).evaluate((slider, value) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('Could not set the zoom slider value');
      slider.step = 'any';
      setValue.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, sliderPosition);
    await page.waitForFunction(({ name, targetPps }) => {
      const measured = name === 'openfilm'
        ? (window.__openfilmView?.pxPerMs ?? 0) * 1000
        : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps') ?? 0);
      return Number.isFinite(measured) && measured > 0 && Math.abs(measured - targetPps) <= 0.0005;
    }, { name, targetPps }, { timeout: 5000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return readPps();
  };
  await page.waitForFunction(name => name === 'openfilm'
    ? Boolean(window.__openfilmView?.pxPerMs)
    : Boolean(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps')), name);
  const targetPps = fixture.pixelsPerSecond;
  let measuredPps = await setPpsTarget(targetPps);
  const boundedTargetPps = targetPps;
  const exactPpsError = measuredPps - boundedTargetPps;
  await page.evaluate((name) => {
    const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
    if (scroller) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    const root = document.querySelector('[data-timeline]');
    root?.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, name);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  measuredPps = await readPps();
  const settledPpsError = measuredPps - boundedTargetPps;
  // The comparison metadata and screenshots must describe the same visible
  // state. Blur the zoom input and dismiss its tooltip before collecting text
  // rectangles; otherwise a focus-only tooltip is masked as visible text even
  // though the screenshots are taken after blur.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(2128, 70);
  await page.waitForTimeout(120);

  const metrics = await page.evaluate(({ name, fixture, targetPps, boundedTargetPps, measuredPps, exactPpsError, settledPpsError }) => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const toolbarSelector = name === 'openfilm' ? '[data-timeline] > div:first-child' : '.timeline-toolbar';
    const toolbar = rect(toolbarSelector);
    const toolbarStyle = getComputedStyle(document.querySelector(toolbarSelector));
    const toolbarControls = [...document.querySelectorAll(`${toolbarSelector} button`)].map((button) => {
      const r = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const iconRect = button.querySelector('svg')?.getBoundingClientRect();
      return {
        label: button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '',
        x: r.x - fixture.timelineRegion.x,
        y: r.y - fixture.timelineRegion.y,
        width: r.width,
        height: r.height,
        disabled: (button.getAttribute('aria-disabled') ?? String(button.disabled)) === 'true',
        pressed: button.getAttribute('aria-pressed') === 'true' || button.getAttribute('aria-expanded') === 'true',
        className: typeof button.className === 'string' ? button.className : '',
        icon: button.querySelector('svg')?.getAttribute('data-lucide') ?? button.querySelector('svg')?.getAttribute('aria-label') ?? button.querySelector('svg')?.getAttribute('class') ?? null,
        computed: {
          color: style.color,
          background: style.backgroundColor,
          opacity: style.opacity,
          borderRadius: style.borderRadius,
          iconWidth: iconRect?.width ?? null,
          iconHeight: iconRect?.height ?? null,
        },
      };
    });
    const ruler = name === 'openfilm'
      ? (() => { const scroller = document.querySelector('[data-timeline] .tl-scroll'); const el = scroller?.parentElement?.parentElement?.firstElementChild; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()
      : (() => {
        const canvas = rect('.timeline-ruler-pin');
        const head = rect('.timeline-left');
        return canvas && head ? { ...canvas, x: canvas.x + head.width, width: canvas.width - head.width } : null;
      })();
    const rulerTickSelector = name === 'openfilm'
      ? '[data-timeline] [role="slider"] [data-zoom-keep]'
      : '.timeline-ruler-tick-layer > span';
    const rulerTicks = [...document.querySelectorAll(rulerTickSelector)].map((tick) => {
      const r = tick.getBoundingClientRect();
      const style = getComputedStyle(tick);
      return {
        label: tick.textContent?.trim() ?? '',
        x: r.x - fixture.timelineRegion.x,
        y: r.y - fixture.timelineRegion.y,
        width: r.width,
        height: r.height,
        major: Boolean(tick.textContent?.trim()),
        borderColor: style.borderLeftColor,
        color: style.color,
        fontSize: style.fontSize,
        letterSpacing: style.letterSpacing,
      };
    });
    const heads = name === 'openfilm'
      ? [...document.querySelectorAll('[data-lane-type]')].map((el, index) => ({ id: fixture.tracks[index]?.id ?? '', ...(() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() }))
      : [...document.querySelectorAll('.timeline-track-head')].map((el) => ({ id: el.getAttribute('data-track-id'), ...(() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() }));
    const trackControls = (name === 'openfilm' ? [...document.querySelectorAll('[data-lane-type]')] : [...document.querySelectorAll('.timeline-track-head')]).map((head, index) => {
      const headRect = head.getBoundingClientRect();
      const id = name === 'openfilm' ? fixture.tracks[index]?.id ?? '' : head.getAttribute('data-track-id') ?? '';
      const headStyle = getComputedStyle(head);
      return {
        id,
        background: headStyle.backgroundColor,
        controls: [...head.querySelectorAll('button')].map(button => {
          const r = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const svg = button.querySelector('svg');
          const icon = svg?.getBoundingClientRect();
          return {
            label: button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '',
            x: r.x - headRect.x,
            y: r.y - headRect.y,
            width: r.width,
            height: r.height,
            background: style.backgroundColor,
            color: style.color,
            icon: icon ? { width: icon.width, height: icon.height } : null,
          };
        }),
      };
    });
    const clips = name === 'openfilm'
      ? [...document.querySelectorAll('[data-block-id]')].map((el) => ({ id: el.getAttribute('data-block-id'), ...(() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() }))
      : fixture.clips.map((clip) => {
        const rowY = clip.trackId === 'V3' ? 70 : clip.trackId === 'V2' ? 124 : clip.trackId === 'V1' ? 178 : 248;
        const expectedX = 51 + clip.startUs / 1_000_000 * targetPps;
        const candidates = (window.__timelineRoundRects ?? []).filter(item => item.canvasWidth === 1998 && Math.abs(item.y - rowY) < 2 && Math.abs(item.x - expectedX) < 40 && item.width > 40);
        const item = candidates.at(-1);
        const canvasRect = rect('canvas:not(.timeline-ruler-pin)');
        return { id: clip.id, x: item && canvasRect ? canvasRect.x + item.x : null, y: item && canvasRect ? canvasRect.y + item.y : null, width: item?.width ?? null, height: item?.height ?? null };
      });
    const clipTextRects = name === 'openfilm'
      ? [...document.querySelectorAll('[data-block-id]')].flatMap(block => [...block.querySelectorAll('span')]
        .filter(span => [...span.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
        .map(span => { const r = span.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(span); const ink = range.getBoundingClientRect(); const style = getComputedStyle(span); const ancestors = []; for (let el = span; el && ancestors.length < 6; el = el.parentElement) { const computed = getComputedStyle(el); ancestors.push({ tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', opacity: computed.opacity, transform: computed.transform, filter: computed.filter, fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontWeight: computed.fontWeight, fontVariationSettings: computed.fontVariationSettings, fontOpticalSizing: computed.fontOpticalSizing, fontFeatureSettings: computed.fontFeatureSettings, letterSpacing: computed.letterSpacing, lineHeight: computed.lineHeight }); } return { clipId: block.getAttribute('data-block-id'), text: span.textContent?.trim() ?? '', x: ink.x - fixture.timelineRegion.x, y: ink.y - fixture.timelineRegion.y, width: ink.width, height: ink.height, lineBox: { x: r.x - fixture.timelineRegion.x, y: r.y - fixture.timelineRegion.y, width: r.width, height: r.height }, font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, color: style.color, fontFeatureSettings: style.fontFeatureSettings, webkitFontSmoothing: style.webkitFontSmoothing, ancestors }; }))
      : [...document.querySelectorAll('[data-timeline-clip-label]')].flatMap(label => [...label.querySelectorAll('[data-label-text]')]
        .map(span => { const r = span.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(span); const ink = range.getBoundingClientRect(); const style = getComputedStyle(span); const ancestors = []; for (let el = span; el && ancestors.length < 6; el = el.parentElement) { const computed = getComputedStyle(el); ancestors.push({ tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', opacity: computed.opacity, transform: computed.transform, filter: computed.filter, fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontWeight: computed.fontWeight, fontVariationSettings: computed.fontVariationSettings, fontOpticalSizing: computed.fontOpticalSizing, fontFeatureSettings: computed.fontFeatureSettings, letterSpacing: computed.letterSpacing, lineHeight: computed.lineHeight }); } return { clipId: label.getAttribute('data-timeline-clip-label'), text: span.textContent?.trim() ?? '', x: ink.x - fixture.timelineRegion.x, y: ink.y - fixture.timelineRegion.y, width: ink.width, height: ink.height, lineBox: { x: r.x - fixture.timelineRegion.x, y: r.y - fixture.timelineRegion.y, width: r.width, height: r.height }, font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, color: style.color, fontFeatureSettings: style.fontFeatureSettings, webkitFontSmoothing: style.webkitFontSmoothing, ancestors }; }));
    const textRects = [];
    const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      const node = textWalker.currentNode;
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const ink = range.getBoundingClientRect();
      if (ink.width <= 0 || ink.height <= 0 || ink.right <= fixture.timelineRegion.x || ink.left >= fixture.timelineRegion.x + fixture.timelineRegion.width || ink.bottom <= fixture.timelineRegion.y || ink.top >= fixture.timelineRegion.y + fixture.timelineRegion.height) continue;
      const clip = parent.closest('[data-block-id], [data-timeline-clip-label]');
      textRects.push({
        text,
        clipId: clip?.getAttribute('data-block-id') ?? clip?.getAttribute('data-timeline-clip-label') ?? null,
        x: ink.x - fixture.timelineRegion.x,
        y: ink.y - fixture.timelineRegion.y,
        width: ink.width,
        height: ink.height,
        font: style.font,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        color: style.color,
        fontFeatureSettings: style.fontFeatureSettings,
        webkitFontSmoothing: style.webkitFontSmoothing,
        fontSynthesis: style.fontSynthesis,
        fontKerning: style.fontKerning,
        fontOpticalSizing: style.fontOpticalSizing,
        fontVariationSettings: style.fontVariationSettings,
        fontStretch: style.fontStretch,
        fontVariantLigatures: style.fontVariantLigatures,
        fontVariantNumeric: style.fontVariantNumeric,
        textRendering: style.textRendering,
        renderingStyle: Object.fromEntries([
          'display', 'position', 'font-style', 'font-size-adjust', 'font-variant-caps',
          'text-align', 'text-indent', 'text-transform', 'white-space', 'text-overflow',
          'word-break', 'direction', 'unicode-bidi', 'writing-mode', 'text-orientation',
          '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
        ].map(property => [property, style.getPropertyValue(property)])),
        paintContext: (() => {
          const properties = ['display', 'position', 'alignItems', 'justifyContent', 'verticalAlign', 'lineHeight', 'overflow', 'textAlign', 'whiteSpace', 'fontSize', 'fontWeight', 'letterSpacing', 'color', '-webkit-text-fill-color', 'transform', 'translate', 'scale', 'opacity', 'filter', 'mixBlendMode', 'textShadow', 'fontVariationSettings', 'fontFeatureSettings', 'fontOpticalSizing', 'fontKerning', 'fontStretch', 'fontSynthesis', 'fontVariantLigatures', 'fontVariantNumeric', 'textRendering', 'textTransform', 'wordSpacing', 'textSizeAdjust', 'zoom', 'isolation', 'contain', 'willChange'];
          const chain = [];
          let element = parent;
          for (let depth = 0; element && depth < 14; depth += 1, element = element.parentElement) {
            const ancestorStyle = getComputedStyle(element);
            chain.push({
              tag: element.tagName,
              className: typeof element.className === 'string' ? element.className : '',
              properties: Object.fromEntries(properties.map(property => [property, ancestorStyle[property]])),
            });
          }
          return chain;
        })(),
      });
    }
    const toolbarState = {};
    const coverElement = document.querySelector(name === 'openfilm' ? '[data-cover-tile]' : '.timeline-cover-entry');
    const coverStyle = coverElement ? getComputedStyle(coverElement) : null;
    const coverRect = coverElement?.getBoundingClientRect();
    const addControlState = (key, predicate) => {
      const control = toolbarControls.find((item) => predicate(item.label));
      if (control) toolbarState[key] = { disabled: control.disabled, pressed: control.pressed };
    };
    addControlState('undo', label => /^撤销/.test(label));
    addControlState('redo', label => /^重做/.test(label));
    addControlState('marker', label => /^添加标记/.test(label));
    addControlState('split', label => /^分割 \(Ctrl|^拆分片段/.test(label));
    addControlState('range', label => /^时间区域|^时间区间/.test(label));
    addControlState('snapping', label => /^吸附|^磁吸吸附/.test(label));
    addControlState('mainTrackMagnet', label => /^主轨磁吸/.test(label));
    addControlState('linkage', label => /^联动/.test(label));
    addControlState('zoomOut', label => /^缩小/.test(label));
    addControlState('zoomIn', label => /^放大/.test(label));
    const selectedClipIds = name === 'openfilm'
      ? [...document.querySelectorAll('[data-block-id]:has([data-block-frame])')].map(el => el.getAttribute('data-block-id')).filter(Boolean).sort()
      : [...document.querySelectorAll('.timeline-a11y-clips [data-clip-id][aria-pressed="true"]')].map(el => el.getAttribute('data-clip-id')).filter(Boolean).sort();
    const markerCount = document.querySelectorAll(name === 'openfilm'
      ? '[data-marker], [data-clip-marker]'
      : '[data-marker], [data-clip-marker]').length;
    const markerRects = [...document.querySelectorAll('[data-marker]')].map((element) => {
      const glyph = element.querySelector('svg');
      const path = glyph?.querySelector('path');
      const r = glyph?.getBoundingClientRect();
      return r ? {
        id: element.getAttribute('data-marker'),
        x: r.x - fixture.timelineRegion.x,
        y: r.y - fixture.timelineRegion.y,
        width: r.width,
        height: r.height,
        color: path?.getAttribute('fill') ?? null,
      } : null;
    }).filter(Boolean).sort((a, b) => a.x - b.x);
    const modeSelect = document.querySelector('[data-timeline-mode-picker] select');
    const activeTool = modeSelect?.value ?? (document.querySelector('.tl-blade') ? 'split' : 'select');
    const actualUiState = {
      selectedClipIds,
      markerCount,
      activeTool,
      canUndo: toolbarState.undo ? !toolbarState.undo.disabled : null,
      canRedo: toolbarState.redo ? !toolbarState.redo.disabled : null,
      snappingEnabled: toolbarState.snapping?.pressed ?? null,
      mainTrackMagnet: toolbarState.mainTrackMagnet?.pressed ?? null,
      linkageEnabled: toolbarState.linkage?.pressed ?? null,
    };
    return {
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      toolbar,
      toolbarStyle: { background: toolbarStyle.backgroundColor, color: toolbarStyle.color, borderBottom: toolbarStyle.borderBottom },
      toolbarControls,
      toolbarState,
      markerRects,
      coverTile: coverElement && coverStyle && coverRect ? {
        x: coverRect.x - fixture.timelineRegion.x,
        y: coverRect.y - fixture.timelineRegion.y,
        width: coverRect.width,
        height: coverRect.height,
        background: coverStyle.backgroundColor,
        color: coverStyle.color,
        border: coverStyle.border,
        borderRadius: coverStyle.borderRadius,
        fontSize: coverStyle.fontSize,
        fontFamily: coverStyle.fontFamily,
      } : null,
      actualUiState,
      ruler,
      rulerTicks,
      heads,
      trackControls,
      contentCanvas: name === 'vortex' ? rect('canvas:not(.timeline-ruler-pin)') : null,
      clips,
      clipTextRects,
      textRects,
      fontRuntime: {
        status: document.fonts.status,
        faces: [...document.fonts].map(face => ({ family: face.family, status: face.status, weight: face.weight, style: face.style })),
        fontResources: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /\.(woff2?|ttf|otf)(\?|$)/i.test(url)).map(url => new URL(url).pathname),
      },
      measuredPps,
      targetPps,
      boundedTargetPps,
      exactPpsError,
      settledPpsError,
      slider: document.querySelector(name === 'openfilm' ? 'input.tl-zoom' : 'input.timeline-zoom-slider')?.value ?? null,
      canvases: [...document.querySelectorAll('canvas')].map((el) => {
        const r = el.getBoundingClientRect();
        return { className: typeof el.className === 'string' ? el.className : el.className.baseVal, x: r.x, y: r.y, width: r.width, height: r.height, backingWidth: el.width, backingHeight: el.height };
      }),
      vortexThemeVars: name === 'vortex' ? (() => {
        const shell = document.querySelector('.editor-shell');
        const pane = document.querySelector('.timeline-pane');
        const toolbar = document.querySelector('.timeline-toolbar');
        const cs = getComputedStyle(shell);
        const paneStyle = getComputedStyle(pane);
        return {
          htmlTheme: document.documentElement.getAttribute('data-theme'),
          tokens: Object.fromEntries(['--bg-panel', '--tl-panel', '--tl-gap', '--tl-canvas-bg', '--tl-grid-line', '--tl-grid-line-strong', '--tl-track-head-bg'].map(key => [key, paneStyle.getPropertyValue(key).trim() || cs.getPropertyValue(key).trim()])),
          paneBackground: paneStyle.backgroundColor,
          toolbarBackground: getComputedStyle(toolbar).backgroundColor,
        };
      })() : null,
      rulerPixels: name === 'vortex' ? (() => { const canvas = document.querySelector('canvas.timeline-ruler-pin'); if (!canvas) return null; const ctx = canvas.getContext('2d'); if (!ctx) return null; return [[0, 10], [100, 10], [183, 10], [200, 10], [300, 10], [1000, 10]].map(([x, y]) => ({ x, rgba: [...ctx.getImageData(x, y, 1, 1).data] })); })() : null,
      canvasText: (window.__timelineCanvasText ?? []).slice(-200),
      openfilmView: name === 'openfilm' ? window.__openfilmView ?? null : null,
      workerEvents: name === 'vortex' ? window.__timelineWorkerEvents ?? [] : null,
      canvasDraws: name === 'vortex' ? window.__timelineCanvasDraws ?? [] : null,
      roundRects: name === 'vortex' ? window.__timelineRoundRects ?? [] : null,
    };
  }, { name, fixture, targetPps, boundedTargetPps, measuredPps, exactPpsError, settledPpsError });
  const screenshot = path.join(outputDir, `${name}.png`);
  const fullScreenshot = path.join(outputDir, `${name}-full.png`);
  const textBackgroundScreenshot = path.join(outputDir, `${name}-text-background.png`);
  const screenshotOptions = { clip: { x: fixture.timelineRegion.x, y: fixture.timelineRegion.y, width: fixture.timelineRegion.width, height: fixture.timelineRegion.height } };
  await page.screenshot({ path: fullScreenshot });
  await page.screenshot({ path: screenshot, ...screenshotOptions });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.dataset.p235TextMask = '';
    style.textContent = '.p235-text-mask-target { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }';
    document.head.appendChild(style);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || !node.parentElement) continue;
      const parent = node.parentElement;
      const computed = getComputedStyle(parent);
      if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity) === 0) continue;
      parent.classList.add('p235-text-mask-target');
    }
  });
  await page.screenshot({ path: textBackgroundScreenshot, ...screenshotOptions });
  await page.evaluate(() => {
    document.querySelectorAll('.p235-text-mask-target').forEach(element => element.classList.remove('p235-text-mask-target'));
    document.querySelector('[data-p235-text-mask]')?.remove();
  });
  await page.waitForTimeout(40);
  await page.getByRole('button', { name: /^添加标记/ }).click();
  const markerAddState = await page.waitForFunction(() => {
    const markerElements = [...document.querySelectorAll('[data-marker]')];
    if (markerElements.length !== 2) return false;
    return markerElements.map((element) => {
      const glyph = element.querySelector('svg');
      const path = glyph?.querySelector('path');
      const r = glyph?.getBoundingClientRect();
      return r ? {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        color: path?.getAttribute('fill') ?? null,
      } : null;
    }).filter(Boolean).sort((a, b) => a.x - b.x);
  }, { timeout: 3000 }).then(handle => handle.jsonValue());
  if (markerAddState.length !== 2) throw new Error(`${name} add-marker action did not create exactly one marker`);
  const markerAddScreenshot = path.join(outputDir, `${name}-marker-added.png`);
  await page.screenshot({ path: markerAddScreenshot, ...screenshotOptions });
  const scrollSelector = name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll';
  const scrollBaselinePps = metrics.measuredPps;
  const scrollTestPps = await setPpsTarget(fixture.pinPixelsPerSecond);
  const pinTargetPps = fixture.pinPixelsPerSecond;
  if (!Number.isFinite(scrollTestPps) || Math.abs(scrollTestPps - pinTargetPps) > 0.0005) {
    throw new Error(`${name} pinned-title zoom scale mismatch: expected ${pinTargetPps}px/s, got ${scrollTestPps}px/s`);
  }
  const scrollAmount = Math.round(scrollTestPps * 2 + fixture.componentMasks.coverRailWidth + 20);
  const wheelTarget = { x: fixture.componentMasks.trackHeadWidth + 120, y: fixture.timelineRegion.y + 120 };
  await page.evaluate(() => {
    window.__p235WheelEvents = [];
    document.addEventListener('wheel', event => window.__p235WheelEvents.push({
      isTrusted: event.isTrusted,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    }), true);
  });
  const verticalScrollRange = await page.locator(scrollSelector).evaluate((scroller, name) => {
    const spacer = document.createElement('div');
    spacer.dataset.p235VerticalScrollExtent = '';
    Object.assign(spacer.style, { position: 'absolute', left: '0', top: '1200px', width: '1px', height: '1px', visibility: 'hidden', pointerEvents: 'none' });
    scroller.appendChild(spacer);
    scroller.scrollTop = 0;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    if (maxScrollTop < 80) throw new Error(`${name} temporary vertical range is too small: ${maxScrollTop}px`);
    return maxScrollTop;
  }, name);
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.move(wheelTarget.x, wheelTarget.y);
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
  }
  await page.mouse.move(wheelTarget.x, wheelTarget.y);
  await page.mouse.wheel(5, 40);
  await page.waitForTimeout(60);
  const scrollStateNow = () => page.evaluate(name => {
    const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
    return {
      x: name === 'openfilm'
        ? scroller?.scrollLeft ?? 0
        : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-scroll-x') ?? 0),
      y: scroller?.scrollTop ?? 0,
    };
  }, name);
  const diagonalScroll = await scrollStateNow();
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
    await page.locator(scrollSelector).evaluate(scroller => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
  }
  const headWheelTarget = { x: fixture.componentMasks.trackHeadWidth - 24, y: wheelTarget.y };
  await page.mouse.move(headWheelTarget.x, headWheelTarget.y);
  await page.mouse.wheel(5, 40);
  await page.waitForTimeout(60);
  const headWheelScroll = await scrollStateNow();
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
    await page.locator(scrollSelector).evaluate(scroller => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
  }
  const rulerWheelTarget = { x: wheelTarget.x, y: fixture.timelineRegion.y + 40 };
  await page.mouse.move(rulerWheelTarget.x, rulerWheelTarget.y);
  await page.mouse.wheel(5, 40);
  await page.waitForTimeout(60);
  const rulerWheelScroll = await scrollStateNow();
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
    await page.locator(scrollSelector).evaluate(scroller => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
  }
  await page.mouse.move(wheelTarget.x, wheelTarget.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(60);
  await page.keyboard.up('Alt');
  const altVerticalScroll = await scrollStateNow();
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      scroller.querySelector('[data-p235-vertical-scroll-extent]')?.remove();
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollTop = 0;
      scroller.querySelector('[data-p235-vertical-scroll-extent]')?.remove();
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }
  // Probe the source's title-pin threshold on either side. At 40 px/s the
  // first clip label reaches the sticky boundary at 2s * pps + cover rail.
  const pinThresholdPx = scrollTestPps * 2 + fixture.componentMasks.coverRailWidth;
  const pinBoundarySample = async (deltaPx) => {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, deltaPx);
    await page.waitForTimeout(50);
    await page.keyboard.up('Shift');
    return page.evaluate(({ name, region }) => {
      const label = name === 'openfilm'
        ? [...(document.querySelector('[data-block-id="v3-a"] [data-pin]')?.children ?? [])].find(child => child.textContent?.trim() === 'blue-court.mp4')
        : document.querySelector('[data-timeline-clip-label="v3-a"] .timeline-clip-label-name');
      const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
      const range = document.createRange();
      if (!label) return null;
      range.selectNodeContents(label);
      const r = range.getBoundingClientRect();
      const pin = name === 'openfilm' ? label.parentElement : label.closest('[data-label-pin]');
      return {
        scrollX: name === 'openfilm' ? scroller?.scrollLeft ?? 0 : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-scroll-x') ?? 0),
        labelX: r.x - region.x,
        translate: pin ? getComputedStyle(pin).translate : 'none',
      };
    }, { name, region: fixture.timelineRegion });
  };
  const pinBeforeThreshold = await pinBoundarySample(Math.floor(pinThresholdPx) - 1);
  const pinAfterThreshold = await pinBoundarySample(2);
  if (!pinBeforeThreshold || !pinAfterThreshold) throw new Error(`${name} could not measure pinned-title threshold`);
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => { scroller.scrollLeft = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
  }
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, scrollAmount);
  await page.waitForTimeout(180);
  await page.keyboard.up('Shift');
  const pinnedTitle = await page.evaluate(({ name, region }) => {
    const openFilmPin = document.querySelector('[data-block-id="v3-a"] [data-pin]');
    const element = name === 'openfilm'
      ? [...(openFilmPin?.children ?? [])].find(child => child.textContent?.trim() === 'blue-court.mp4')
      : document.querySelector('[data-timeline-clip-label="v3-a"] .timeline-clip-label-name');
    if (!element) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
    const scrollX = name === 'openfilm'
      ? scroller?.scrollLeft ?? 0
      : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-scroll-x') ?? 0);
    const pin = name === 'openfilm' ? element.parentElement : element.closest('[data-label-pin]');
    const pps = name === 'openfilm'
      ? (window.__openfilmView?.pxPerMs ?? 0) * 1000
      : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps') ?? 0);
    return {
      x: rect.x - region.x,
      y: rect.y - region.y,
      scrollX,
      pps,
      pinTranslate: pin ? getComputedStyle(pin).translate : 'none',
      wheelEvents: window.__p235WheelEvents ?? [],
    };
  }, { name, region: fixture.timelineRegion });
  pinnedTitle.diagonalScrollX = diagonalScroll.x;
  pinnedTitle.diagonalScrollTop = diagonalScroll.y;
  pinnedTitle.trackHeadWheelScrollX = headWheelScroll.x;
  pinnedTitle.rulerWheelScrollX = rulerWheelScroll.x;
  pinnedTitle.altVerticalScrollX = altVerticalScroll.x;
  pinnedTitle.altVerticalScrollTop = altVerticalScroll.y;
  pinnedTitle.verticalScrollRange = verticalScrollRange;
  pinnedTitle.requestedScrollX = scrollAmount;
  pinnedTitle.pinThresholdPx = pinnedTitle.pps * 2 + fixture.componentMasks.coverRailWidth;
  pinnedTitle.boundary = { before: pinBeforeThreshold, after: pinAfterThreshold };
  const scrollScreenshot = path.join(outputDir, `${name}-scroll-pin.png`);
  await page.screenshot({ path: scrollScreenshot, ...screenshotOptions });
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate((scroller, amount) => {
      scroller.scrollLeft = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, scrollAmount);
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
  }
  await setPpsTarget(scrollBaselinePps);
  if (name === 'openfilm') {
    await page.locator(scrollSelector).evaluate(scroller => {
      scroller.scrollLeft = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  } else {
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(60);
    await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(180);
  const dragStart = name === 'openfilm'
    ? await page.locator('[data-block-id="v3-a"]').boundingBox()
    : await page.locator('canvas[aria-label="时间线画布"]').boundingBox();
  if (!dragStart) throw new Error(`${name} has no drag surface`);
  const pointerStart = name === 'openfilm'
    ? { x: dragStart.x + 40, y: dragStart.y + 32 }
    : { x: 279, y: fixture.timelineRegion.y + 135.5 };
  const pointerTarget = { x: 720, y: fixture.timelineRegion.y + 183 };
  await page.mouse.move(pointerStart.x, pointerStart.y);
  await page.mouse.down();
  await page.mouse.move(pointerStart.x + 10, pointerStart.y + 10, { steps: 2 });
  await page.mouse.move(pointerTarget.x, pointerTarget.y, { steps: 10 });
  await page.waitForTimeout(180);
  const dragPreviewScreenshot = path.join(outputDir, `${name}-drag-preview.png`);
  const fullDragPreviewScreenshot = path.join(outputDir, `${name}-drag-preview-full.png`);
  await page.screenshot({ path: fullDragPreviewScreenshot });
  await page.screenshot({ path: dragPreviewScreenshot, ...screenshotOptions });
  const previewState = await page.evaluate((name) => name === 'openfilm'
    ? [...document.querySelectorAll('[data-block-id]')].map(el => ({ id: el.getAttribute('data-block-id'), r: (() => { const x = el.getBoundingClientRect(); return { x: x.x, y: x.y, width: x.width, height: x.height }; })() }))
    : {
      canvases: [...document.querySelectorAll('canvas')].map(el => ({ className: el.className, width: el.width, height: el.height })),
      clipDraws: (window.__timelineRoundRects ?? [])
        .filter(item => item.canvasWidth === 1998 && item.height === 51 && item.y > 90 && item.y < 150)
        .slice(-30)
        .map(({ x, y, width, height }) => ({ x, y, width, height })),
    }, name);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragOps = await page.evaluate((name) => name === 'openfilm'
    ? (window.__openfilmDragOps ?? [])
    : (window.__vortexDragOps ?? []), name);
  const committedState = await page.evaluate((name) => name === 'openfilm'
    ? [...document.querySelectorAll('[data-block-id]')]
      .filter(el => el.getAttribute('data-block-id') === 'v3-a')
      .map(el => { const r = el.getBoundingClientRect(); return { id: 'v3-a', x: r.x, y: r.y, width: r.width, height: r.height }; })
    : (window.__timelineRoundRects ?? [])
      .filter(item => item.canvasWidth === 1998 && item.height === 51 && item.width > 240 && item.width < 270 && item.y > 100 && item.y < 150)
      .slice(-8)
      .map(({ x, y, width, height }) => ({ x, y, width, height })), name);
  const dragResultScreenshot = path.join(outputDir, `${name}-drag-result.png`);
  const fullDragResultScreenshot = path.join(outputDir, `${name}-drag-result-full.png`);
  await page.screenshot({ path: fullDragResultScreenshot });
  await page.screenshot({ path: dragResultScreenshot, ...screenshotOptions });

  // OpenFilm's ⌥ move is an Insert gesture: lift the source out (closing its
  // source gap), make room at the target point, and push later target clips.
  // Reload so both products run this against the same untouched fixture.
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.waitForSelector(sliderSelector, { state: 'attached', timeout: 30000 });
  await page.waitForFunction(name => name === 'openfilm'
    ? Boolean(window.__openfilmView?.pxPerMs)
    : Boolean(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps')), name);
  await setPpsTarget(fixture.pixelsPerSecond);
  await page.evaluate((name) => {
    const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
    if (scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); }
  }, name);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.evaluate(() => { window.__p235TrackModifiers = true; });
  const insertStartRect = name === 'openfilm'
    ? await page.locator('[data-block-id="v3-a"]').boundingBox()
    : await page.locator('canvas[aria-label="时间线画布"]').boundingBox();
  if (!insertStartRect) throw new Error(`${name} has no source clip for Insert drag`);
  const insertStart = name === 'openfilm'
    ? { x: insertStartRect.x + 40, y: insertStartRect.y + 32 }
    : { x: 279, y: fixture.timelineRegion.y + 135.5 };
  // Place the pointer in the V2 gap at 20s; the source clip's grab offset is
  // preserved, so both planners resolve the same frame-aligned insert point.
  const insertTarget = { x: fixture.timelineRegion.x + fixture.componentMasks.contentX + 20 * fixture.pixelsPerSecond, y: fixture.timelineRegion.y + 183 };
  await page.mouse.move(insertStart.x, insertStart.y);
  await page.mouse.down();
  await page.mouse.move(insertStart.x + 10, insertStart.y + 10, { steps: 2 });
  await page.mouse.move(insertTarget.x, insertTarget.y, { steps: 10 });
  await page.waitForTimeout(80);
  await page.keyboard.down('Alt');
  // Nudge one physical pixel after the keydown so both products receive a
  // trusted pointermove with Alt set; OpenFilm also handles keydown directly.
  await page.mouse.move(insertTarget.x + 1, insertTarget.y, { steps: 1 });
  await page.waitForTimeout(180);
  const insertPreviewScreenshot = path.join(outputDir, `${name}-alt-insert-preview.png`);
  const fullInsertPreviewScreenshot = path.join(outputDir, `${name}-alt-insert-preview-full.png`);
  await page.screenshot({ path: fullInsertPreviewScreenshot });
  await page.screenshot({ path: insertPreviewScreenshot, ...screenshotOptions });
  const insertPreview = await page.evaluate((name) => name === 'openfilm'
    ? [...document.querySelectorAll('[data-block-id]')].map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-block-id'), x: r.x, y: r.y, width: r.width, height: r.height };
    })
    : (window.__timelineRoundRects ?? [])
      .filter(item => item.canvasWidth === 1998 && item.height === 51 && item.y > 90 && item.y < 150)
      .slice(-30)
      .map(({ x, y, width, height }) => ({ x, y, width, height })), name);
  const insertHit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? { tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', blockId: el.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null, activeElement: document.activeElement?.tagName ?? null } : null;
  }, insertTarget);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
  const insertOps = await page.evaluate(name => name === 'openfilm' ? (window.__openfilmDragOps ?? []) : (window.__vortexDragOps ?? []), name);
  const insertState = await page.evaluate(name => {
    if (name === 'openfilm') return (window.__openfilmTracks ?? []).flatMap(track => track.blocks.map(block => ({
      id: block.id, trackId: track.lane, startUs: Math.round(block.startMs * 1000), endUs: Math.round(block.endMs * 1000),
    })));
    return (window.__vortexDocument?.clips ?? []).map(clip => ({
      id: clip.clip_id, trackId: clip.track_id, startUs: clip.timeline_start_us, endUs: clip.timeline_end_us,
    }));
  }, name);
  const modifierEvents = await page.evaluate(() => window.__p235ModifierEvents ?? []);
  const insertResultScreenshot = path.join(outputDir, `${name}-alt-insert-result.png`);
  const fullInsertResultScreenshot = path.join(outputDir, `${name}-alt-insert-result-full.png`);
  await page.screenshot({ path: fullInsertResultScreenshot });
  await page.screenshot({ path: insertResultScreenshot, ...screenshotOptions });
  const keyListenerRuns = await page.evaluate(() => window.__p235ListenerRuns ?? []);
  const dragDecisionProbe = await page.evaluate(() => window.__p235OpenFilmDragProbe ?? []);
  const planCalls = await page.evaluate(() => window.__p235PlanCalls ?? []);
  const planPhases = await page.evaluate(() => window.__p235PlanPhases ?? []);
  const readDurationScaleState = () => page.evaluate(name => {
    const pps = name === 'openfilm'
      ? (window.__openfilmView?.pxPerMs ?? 0) * 1000
      : Number(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps') ?? 0);
    const clips = name === 'openfilm'
      ? (window.__openfilmTracks ?? []).flatMap(track => track.blocks.map(block => ({
        id: block.id, startUs: Math.round(block.startMs * 1000), endUs: Math.round(block.endMs * 1000),
      })))
      : (window.__vortexDocument?.clips ?? []).map(clip => ({
        id: clip.clip_id, startUs: clip.timeline_start_us, endUs: clip.timeline_end_us,
      }));
    return { pps, durationUs: Math.max(0, ...clips.map(clip => clip.endUs)), clips };
  }, name);
  const durationScaleBefore = await readDurationScaleState();
  const scaleProbeTrack = fixture.componentMasks.tracks.find(track => track.id === 'V3');
  if (!scaleProbeTrack) throw new Error(`${name} has no V3 row for duration-scale drag`);
  const scaleProbeStart = {
    x: fixture.timelineRegion.x + fixture.componentMasks.contentX + 26 * durationScaleBefore.pps + 40,
    y: fixture.timelineRegion.y + scaleProbeTrack.y + 32.5,
  };
  const scaleProbeTarget = {
    x: fixture.timelineRegion.x + fixture.componentMasks.contentX + 60 * durationScaleBefore.pps + 40,
    y: scaleProbeStart.y,
  };
  await page.mouse.move(scaleProbeStart.x, scaleProbeStart.y);
  await page.mouse.down();
  await page.mouse.move(scaleProbeStart.x + 10, scaleProbeStart.y + 10, { steps: 2 });
  await page.mouse.move(scaleProbeTarget.x, scaleProbeTarget.y, { steps: 10 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const durationScaleAfter = await readDurationScaleState();
  const extendedClip = durationScaleAfter.clips.find(clip => clip.id === 'v3-b');
  const durationScaleProbe = {
    before: { pps: durationScaleBefore.pps, durationUs: durationScaleBefore.durationUs },
    after: { pps: durationScaleAfter.pps, durationUs: durationScaleAfter.durationUs },
    movedClipStartUs: extendedClip?.startUs ?? null,
    targetStartUs: 60_000_000,
  };
  assert.ok(durationScaleAfter.durationUs > durationScaleBefore.durationUs, `${name} drag extends the timeline duration`);
  assert.ok(Math.abs(durationScaleAfter.pps - durationScaleBefore.pps) <= 0.001,
    `${name} keeps px/s after extending the timeline: ${durationScaleBefore.pps} -> ${durationScaleAfter.pps}`);
  const durationScaleClipStartToleranceUs = 1_000_000 / durationScaleBefore.pps;
  assert.ok(extendedClip && Math.abs(extendedClip.startUs - durationScaleProbe.targetStartUs) <= durationScaleClipStartToleranceUs,
    `${name} duration-scale drag lands v3-b within 1px of 60s (got ${extendedClip?.startUs ?? 'missing'})`);

  // Exercise both directions of OpenFilm's modifier-driven Place ↔ Insert
  // mode switch. This starts from the same fixture on each side and commits
  // with Alt released, so an Insert preview must roll back before commit.
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.waitForSelector(sliderSelector, { state: 'attached', timeout: 30000 });
  await page.waitForFunction(name => name === 'openfilm'
    ? Boolean(window.__openfilmView?.pxPerMs)
    : Boolean(document.querySelector('canvas[aria-label="时间线画布"]')?.getAttribute('data-timeline-pps')), name);
  await setPpsTarget(fixture.pixelsPerSecond);
  await page.evaluate(name => {
    const scroller = document.querySelector(name === 'openfilm' ? '.tl-scroll' : '.timeline-scroll');
    if (scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.__p235TrackModifiers = true;
  }, name);
  // Make v2-b a clip in the main-track gap for this gesture-only fixture. It
  // is then a true downstream Insert follower rather than an OpenFilm rider
  // that correctly follows V1 footage back to its original position.
  await page.evaluate(name => {
    if (name === 'openfilm') {
      window.__openfilmSetTracks?.(current => current.map(track => ({
        ...track,
        blocks: track.blocks.map(block => block.id === 'v1-b' ? { ...block, startMs: 44_000, endMs: 52_000 } : block),
      })));
    } else {
      window.__vortexSetDocument?.(current => ({
        ...current,
        clips: current.clips.map(clip => clip.clip_id === 'v1-b'
          ? { ...clip, timeline_start_us: 44_000_000, timeline_end_us: 52_000_000 }
          : clip),
      }));
    }
  }, name);
  await page.waitForTimeout(120);
  if (name === 'vortex') {
    await page.waitForSelector('[data-timeline-filmstrip-clip="v3-a"]', { state: 'attached', timeout: 30000 });
  }
  const switchStartRect = name === 'openfilm'
    ? await page.locator('[data-block-id="v3-a"]').boundingBox()
    : await page.locator('canvas[aria-label="时间线画布"]').boundingBox();
  if (!switchStartRect) throw new Error(`${name} has no source clip for modifier-switch drag`);
  const switchStart = name === 'openfilm'
    ? { x: switchStartRect.x + 40, y: switchStartRect.y + 32 }
    : { x: 279, y: fixture.timelineRegion.y + 135.5 };
  const switchSourceStartUs = fixture.clips.find(clip => clip.id === 'v3-a')?.startUs;
  if (!Number.isFinite(switchSourceStartUs)) throw new Error('Modifier-switch fixture is missing v3-a start time');
  const switchTarget = {
    x: switchStart.x + ((30_000_000 - switchSourceStartUs) / 1_000_000) * fixture.pixelsPerSecond,
    y: fixture.timelineRegion.y + 183,
  };
  const readSwitchPreview = () => page.evaluate(({ name, fixture }) => {
    if (name === 'openfilm') {
      const rectOf = id => {
        const element = document.querySelector(`[data-block-id="${id}"]`);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const insertPoint = document.querySelector('[data-insert-point]');
      const insertRect = insertPoint?.getBoundingClientRect();
      return {
        source: rectOf('v3-a'),
        targetFollower: rectOf('v2-b'),
        insertPoint: insertRect ? { x: insertRect.x, y: insertRect.y, width: insertRect.width, height: insertRect.height } : null,
      };
    }
    const plan = (window.__p235VortexMovePlans ?? []).at(-1);
    const follower = plan?.placements?.find(item => item.clipId === 'v2-b');
    const startUs = follower?.startUs ?? 43_000_000;
    const rectOf = id => {
      const element = document.querySelector(`[data-timeline-clip-label="${id}"]`);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const sourceStrip = document.querySelector('[data-timeline-filmstrip-clip="v3-a"]');
    const stripRect = sourceStrip?.getBoundingClientRect();
    const insertPoint = document.querySelector('[data-timeline-insert-point]');
    const insertRect = insertPoint?.getBoundingClientRect();
    return {
      source: rectOf('v3-a'),
      targetFollower: { ...rectOf('v2-b'), startUs },
      insertPoint: insertRect ? { x: insertRect.x, y: insertRect.y, width: insertRect.width, height: insertRect.height } : null,
      filmstrip: sourceStrip && stripRect ? {
        x: stripRect.x, y: stripRect.y, width: stripRect.width, height: stripRect.height,
        cellCount: sourceStrip.querySelectorAll('[data-timeline-filmstrip-cell]').length,
        hitAtCenter: document.elementFromPoint(stripRect.x + stripRect.width / 2, stripRect.y + stripRect.height / 2)?.tagName ?? null,
      } : null,
      filmstripLayers: [...document.querySelectorAll('[data-timeline-filmstrip-overlay]')].map(element => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        clips: [...element.querySelectorAll('[data-timeline-filmstrip-clip]')].map(clip => clip.getAttribute('data-timeline-filmstrip-clip')),
      })),
      filmstripDebug: window.__p235Filmstrip ?? null,
    };
  }, { name, fixture });
  await page.mouse.move(switchStart.x, switchStart.y);
  await page.mouse.down();
  await page.mouse.move(switchStart.x + 10, switchStart.y + 10, { steps: 2 });
  await page.mouse.move(switchTarget.x, switchTarget.y, { steps: 10 });
  await page.waitForTimeout(100);
  const switchPlacePreview = await readSwitchPreview();
  await page.keyboard.down('Alt');
  await page.mouse.move(switchTarget.x + 1, switchTarget.y, { steps: 1 });
  await page.waitForTimeout(120);
  const switchInsertPreview = await readSwitchPreview();
  const switchInsertPreviewScreenshot = path.join(outputDir, `${name}-modifier-insert-preview.png`);
  await page.screenshot({ path: switchInsertPreviewScreenshot, ...screenshotOptions });
  await page.keyboard.up('Alt');
  await page.mouse.move(switchTarget.x + 2, switchTarget.y, { steps: 1 });
  await page.waitForTimeout(120);
  const switchReturnedPlacePreview = await readSwitchPreview();
  const switchReturnedPlaceScreenshot = path.join(outputDir, `${name}-modifier-place-preview.png`);
  await page.screenshot({ path: switchReturnedPlaceScreenshot, ...screenshotOptions });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const modifierSwitchState = await page.evaluate(name => {
    const clips = name === 'openfilm'
      ? (window.__openfilmTracks ?? []).flatMap(track => track.blocks.map(block => ({
        id: block.id, trackId: track.lane, startUs: Math.round(block.startMs * 1000), endUs: Math.round(block.endMs * 1000),
      })))
      : (window.__vortexDocument?.clips ?? []).map(clip => ({
        id: clip.clip_id, trackId: clip.track_id, startUs: clip.timeline_start_us, endUs: clip.timeline_end_us,
      }));
    return {
      clips,
      modes: name === 'openfilm' ? (window.__p235OpenFilmDragProbe ?? []).map(item => item.editMode) : (window.__p235VortexMoveModes ?? []).map(item => item.mode),
      decisionProbe: name === 'openfilm' ? window.__p235OpenFilmDragProbe ?? [] : window.__p235VortexMoveModes ?? [],
      planCalls: name === 'openfilm' ? window.__p235PlanCalls ?? [] : window.__p235VortexMovePlans ?? [],
      planPhases: name === 'openfilm' ? window.__p235PlanPhases ?? [] : [],
      ops: name === 'openfilm' ? (window.__openfilmDragOps ?? []).at(-1)?.ops ?? [] : (window.__vortexDragOps ?? []).at(-1)?.ops ?? [],
    };
  }, name);
  const sourceAfterSwitch = modifierSwitchState.clips.find(clip => clip.id === 'v3-a');
  const followerAfterSwitch = modifierSwitchState.clips.find(clip => clip.id === 'v2-b');
  assert.ok(sourceAfterSwitch && followerAfterSwitch, `${name} retains source and V2 follower after dynamic modifier drag`);
  assert.ok(modifierSwitchState.modes.includes('insert') && modifierSwitchState.modes.at(-1) === 'place',
    `${name} changes Place → Insert → Place before pointerup: ${modifierSwitchState.modes.join(',')}`);
  assertNear(followerAfterSwitch.startUs, 43_000_000, `${name} commits Place after releasing Alt`, 0);
  assert.ok(sourceAfterSwitch.startUs >= 29_000_000 && sourceAfterSwitch.startUs <= 31_000_000,
    `${name} commits source into the clear V2 gap: ${sourceAfterSwitch.startUs}`);
  const modifierSwitch = {
    start: switchStart,
    target: switchTarget,
    placePreview: switchPlacePreview,
    insertPreview: switchInsertPreview,
    returnedPlacePreview: switchReturnedPlacePreview,
    insertPreviewScreenshot: switchInsertPreviewScreenshot,
    returnedPlaceScreenshot: switchReturnedPlaceScreenshot,
    state: modifierSwitchState,
    followerUnshiftedOnReturn: followerAfterSwitch.startUs === 43_000_000,
  };
  captures[name] = { screenshot, fullScreenshot, textBackgroundScreenshot, markerAddScreenshot, markerAddState, scrollScreenshot, pinnedTitle, dragPreviewScreenshot, fullDragPreviewScreenshot, dragResultScreenshot, fullDragResultScreenshot, insertPreviewScreenshot, fullInsertPreviewScreenshot, insertResultScreenshot, fullInsertResultScreenshot, pageErrors, requests, initial: before, metrics, drag: { start: pointerStart, target: pointerTarget, previewState, committedState, ops: dragOps }, altInsert: { start: insertStart, target: insertTarget, targetHit: insertHit, previewState: insertPreview, committedState: insertState, ops: insertOps, modifierEvents, keyListenerRuns, dragDecisionProbe, planCalls, planPhases }, durationScaleProbe, modifierSwitch };
  await page.close();
}

await writeFile(path.join(outputDir, 'capture-raw.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), fixture, captures }, null, 2)}\n`, 'utf8');
const assertRgbNear = (actual, expected, label, tolerance = 3) => {
  const channels = value => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  const actualRgb = channels(actual);
  const expectedRgb = channels(expected);
  assert.equal(actualRgb.length, 3, `${label}: invalid actual RGB ${actual}`);
  assert.equal(expectedRgb.length, 3, `${label}: invalid reference RGB ${expected}`);
  for (let index = 0; index < 3; index += 1) assertNear(actualRgb[index], expectedRgb[index], `${label} channel ${index}`, tolerance);
};
const openfilmCapture = captures.openfilm;
const vortexCapture = captures.vortex;
assert.equal(openfilmCapture.pageErrors.length + vortexCapture.pageErrors.length, 0, 'paired capture has no page errors');
assertNear(openfilmCapture.metrics.measuredPps, fixture.pixelsPerSecond, 'OpenFilm baseline zoom scale', 0.0005);
assertNear(vortexCapture.metrics.measuredPps, fixture.pixelsPerSecond, 'Vortex baseline zoom scale', 0.0005);
assertNear(vortexCapture.metrics.measuredPps, openfilmCapture.metrics.measuredPps, 'paired zoom scale', 0.001);
assertNear(vortexCapture.durationScaleProbe.movedClipStartUs, openfilmCapture.durationScaleProbe.movedClipStartUs,
  'paired duration-scale drag clip start', 1_000_000 / fixture.pixelsPerSecond);
for (const field of ['x', 'y', 'width', 'height']) {
  assertNear(vortexCapture.metrics.toolbar[field], openfilmCapture.metrics.toolbar[field], `toolbar ${field}`);
  assertNear(vortexCapture.metrics.ruler[field], openfilmCapture.metrics.ruler[field], `ruler ${field}`);
}
assert.equal(vortexCapture.metrics.heads.length, openfilmCapture.metrics.heads.length, 'both products render the same track headers');
for (const openHead of openfilmCapture.metrics.heads) {
  const vortexHead = vortexCapture.metrics.heads.find((head) => head.id === openHead.id);
  assert.ok(vortexHead, `Vortex track ${openHead.id} is present`);
  for (const field of ['x', 'y', 'width', 'height']) assertNear(vortexHead[field], openHead[field], `${openHead.id} head ${field}`);
}
for (const openHead of openfilmCapture.metrics.trackControls) {
  const vortexHead = vortexCapture.metrics.trackControls.find((head) => head.id === openHead.id);
  assert.ok(vortexHead, `Vortex ${openHead.id} controls are present`);
  assertRgbNear(vortexHead.background, openHead.background, `${openHead.id} track-head fill`);
  assert.equal(vortexHead.controls.length, openHead.controls.length, `${openHead.id} track control count`);
  for (let index = 0; index < openHead.controls.length; index += 1) {
    const openControl = openHead.controls[index];
    const vortexControl = vortexHead.controls[index];
    for (const field of ['x', 'y', 'width', 'height']) assertNear(vortexControl[field], openControl[field], `${openHead.id} control ${index} ${field}`);
    assertRgbNear(vortexControl.color, openControl.color, `${openHead.id} control ${index} color`);
    if (vortexControl.icon && openControl.icon) {
      assertNear(vortexControl.icon.width, openControl.icon.width, `${openHead.id} control ${index} icon width`);
      assertNear(vortexControl.icon.height, openControl.icon.height, `${openHead.id} control ${index} icon height`);
    }
  }
}
for (const openClip of openfilmCapture.metrics.clips) {
  const vortexClip = vortexCapture.metrics.clips.find((clip) => clip.id === openClip.id);
  assert.ok(vortexClip, `Vortex clip ${openClip.id} is present`);
  for (const field of ['x', 'y', 'width', 'height']) assertNear(vortexClip[field], openClip[field], `${openClip.id} ${field}`);
}
const openPreview = openfilmCapture.drag.previewState.find((clip) => clip.id === 'v3-a')?.r;
const vortexPreview = vortexCapture.drag.previewState.clipDraws.at(-1);
assert.ok(openPreview && vortexPreview, 'both products expose the dragged clip preview');
assertNear(vortexPreview.x + vortexCapture.metrics.contentCanvas.x, openPreview.x, 'drag preview x');
assertNear(vortexPreview.y + vortexCapture.metrics.contentCanvas.y, openPreview.y, 'drag preview y');
assertNear(vortexPreview.width, openPreview.width, 'drag preview width');
const openCommitted = openfilmCapture.drag.committedState.find((clip) => clip.id === 'v3-a');
const vortexCommitted = vortexCapture.drag.committedState.at(-1);
assert.ok(openCommitted && vortexCommitted, 'both products expose the committed clip position');
assertNear(vortexCommitted.x + vortexCapture.metrics.contentCanvas.x, openCommitted.x, 'committed clip x');
assertNear(vortexCommitted.y + vortexCapture.metrics.contentCanvas.y, openCommitted.y, 'committed clip y');
assertNear(vortexCapture.pinnedTitle.scrollX, openfilmCapture.pinnedTitle.scrollX, 'scroll-pinned horizontal offset', 0.25);
assertNear(vortexCapture.pinnedTitle.x, openfilmCapture.pinnedTitle.x, 'scroll-pinned title x', 0.25);
assertNear(vortexCapture.pinnedTitle.y, openfilmCapture.pinnedTitle.y, 'scroll-pinned title y', 0.25);
assertNear(vortexCapture.pinnedTitle.pps, openfilmCapture.pinnedTitle.pps, 'scroll-pinned zoom scale', 0.001);
for (const [name, capture] of Object.entries({ openfilm: openfilmCapture, vortex: vortexCapture })) {
  assert.ok(capture.pinnedTitle.scrollX >= capture.pinnedTitle.pinThresholdPx - 1, `${name} Shift+wheel must scroll far enough to pin the first clip title`);
  assert.ok(capture.pinnedTitle.pps >= 35, `${name} pinned-title capture must use a zoom level that exercises pinning`);
  const threshold = capture.pinnedTitle.pinThresholdPx;
  assertNear(capture.pinnedTitle.boundary.before.scrollX, Math.floor(threshold) - 1, `${name} pre-threshold scroll`, 1);
  assertNear(capture.pinnedTitle.boundary.after.scrollX, Math.floor(threshold) + 1, `${name} post-threshold scroll`, 1);
  assert.ok(capture.pinnedTitle.boundary.before.labelX > fixture.componentMasks.trackHeadWidth + 6, `${name} title remains unpinned below the pin threshold`);
  assertNear(capture.pinnedTitle.boundary.after.labelX, fixture.componentMasks.trackHeadWidth + 6, `${name} title pins at the threshold`, 1);
  assertNear(capture.pinnedTitle.x, fixture.componentMasks.trackHeadWidth + 6, `${name} pinned title left edge`, 1);
  assertNear(capture.pinnedTitle.diagonalScrollX, 5, `${name} diagonal trackpad deltaX scroll`, 1);
  assertNear(capture.pinnedTitle.diagonalScrollTop, 40, `${name} diagonal trackpad deltaY scroll`, 1);
  assertNear(capture.pinnedTitle.trackHeadWheelScrollX, 0, `${name} track-head wheel does not pan horizontally`, 1);
  assertNear(capture.pinnedTitle.rulerWheelScrollX, 0, `${name} ruler wheel does not pan horizontally`, 1);
  assertNear(capture.pinnedTitle.altVerticalScrollX, 0, `${name} Alt+vertical wheel does not pan horizontally`, 1);
  assertNear(capture.pinnedTitle.altVerticalScrollTop, 40, `${name} Alt+vertical wheel scrolls rows`, 1);
  assert.ok(capture.pinnedTitle.wheelEvents.some(event => event.isTrusted && event.deltaX === 5 && event.deltaY === 40 && !event.shiftKey), `${name} diagonal pan uses trusted browser wheel input`);
  assert.ok(capture.pinnedTitle.wheelEvents.some(event => event.isTrusted && event.clientX === fixture.componentMasks.trackHeadWidth - 24 && event.deltaX === 5 && event.deltaY === 40 && !event.shiftKey), `${name} track-head input is sampled outside the content region`);
  assert.ok(capture.pinnedTitle.wheelEvents.some(event => event.isTrusted && event.clientY === fixture.timelineRegion.y + 40 && event.deltaX === 5 && event.deltaY === 40 && !event.shiftKey), `${name} ruler input is sampled outside the scroll body`);
  assert.ok(capture.pinnedTitle.wheelEvents.some(event => event.isTrusted && event.altKey && event.deltaX === 0 && event.deltaY === 40), `${name} Alt+vertical test reaches the handler with Alt held`);
  assert.ok(capture.pinnedTitle.wheelEvents.some(event => event.isTrusted && event.shiftKey && event.deltaY >= capture.pinnedTitle.requestedScrollX - 1), `${name} Shift+wheel pan uses trusted browser wheel input`);
}
const vortexMove = vortexCapture.drag.ops.flatMap((entry) => entry.ops ?? []).find((operation) => operation.op === 'position_clips');
assert.ok(vortexMove && vortexMove.placements.length === 1 && vortexMove.placements[0].timeline_start_us === 18_000_000, 'Vortex commits the snapped drag result in one position patch');
const openInsertById = new Map(openfilmCapture.altInsert.committedState.map(clip => [clip.id, clip]));
const vortexInsertById = new Map(vortexCapture.altInsert.committedState.map(clip => [clip.id, clip]));
assert.equal(openInsertById.size, fixture.clips.length, 'OpenFilm commits every fixture clip after Alt Insert');
assert.equal(vortexInsertById.size, fixture.clips.length, 'Vortex commits every fixture clip after Alt Insert');
for (const clip of fixture.clips) {
  const openPosition = openInsertById.get(clip.id);
  const vortexPosition = vortexInsertById.get(clip.id);
  assert.ok(openPosition && vortexPosition, `both products retain clip ${clip.id} after Alt Insert`);
  assert.equal(vortexPosition.trackId, openPosition.trackId, `${clip.id} Alt Insert destination track`);
  assertNear(vortexPosition.startUs, openPosition.startUs, `${clip.id} Alt Insert final start`, 0);
}
const compactModes = modes => modes.reduce((result, mode) => {
  if (result.at(-1) !== mode) result.push(mode);
  return result;
}, []);
for (const [name, capture] of Object.entries({ openfilm: openfilmCapture, vortex: vortexCapture })) {
  const modes = compactModes(capture.modifierSwitch.state.modes);
  assert.deepEqual(modes, ['place', 'insert', 'place'], `${name} modifier switch mode sequence`);
  const initialX = capture.modifierSwitch.placePreview.targetFollower?.x;
  const insertX = capture.modifierSwitch.insertPreview.targetFollower?.x;
  const returnedX = capture.modifierSwitch.returnedPlacePreview.targetFollower?.x;
  assert.ok(Number.isFinite(initialX) && Number.isFinite(insertX) && Number.isFinite(returnedX),
    `${name} exposes target follower geometry for Place/Insert/Place previews`);
  assertNear(insertX - initialX, 9 * fixture.pixelsPerSecond, `${name} Insert preview opens room for the moving clip`, 2);
  assertNear(returnedX, initialX, `${name} Alt release restores Place preview`, 1);
}
const openSwitch = openfilmCapture.modifierSwitch;
const vortexSwitch = vortexCapture.modifierSwitch;
for (const phase of ['placePreview', 'insertPreview', 'returnedPlacePreview']) {
  for (const region of ['source', 'targetFollower']) {
    const openRect = openSwitch[phase][region];
    const vortexRect = vortexSwitch[phase][region];
    assert.ok(openRect && vortexRect, `${phase} ${region} is rendered by both products`);
    for (const field of ['x', 'y', 'width', 'height']) {
      assertNear(vortexRect[field], openRect[field], `paired ${phase} ${region} ${field}`, 1);
    }
  }
}
for (const field of ['x', 'y', 'width', 'height']) {
  assert.ok(openSwitch.insertPreview.insertPoint && vortexSwitch.insertPreview.insertPoint,
    'both products render an Insert landing point during the modifier preview');
  assertNear(vortexSwitch.insertPreview.insertPoint[field], openSwitch.insertPreview.insertPoint[field],
    `paired Insert landing point ${field}`, 1);
}
assertNear(vortexSwitch.insertPreview.targetFollower.x - vortexSwitch.placePreview.targetFollower.x,
  openSwitch.insertPreview.targetFollower.x - openSwitch.placePreview.targetFollower.x,
  'paired dynamic Insert preview displacement', 1);
assertNear(vortexSwitch.state.clips.find(clip => clip.id === 'v3-a')?.startUs,
  openSwitch.state.clips.find(clip => clip.id === 'v3-a')?.startUs,
  'paired dynamic modifier committed start', 1_000_000 / fixture.pixelsPerSecond);
assert.equal(vortexSwitch.state.clips.find(clip => clip.id === 'v2-b')?.startUs, 43_000_000,
  'Vortex does not retain Insert ripple after Alt release');
assert.equal(openSwitch.state.clips.find(clip => clip.id === 'v2-b')?.startUs, 43_000_000,
  'OpenFilm does not retain Insert ripple after Alt release');
for (const [name, capture] of Object.entries({ openfilm: openfilmCapture, vortex: vortexCapture })) {
  assert.equal(capture.metrics.markerRects.length, 1, `${name} initial fixture includes one visible timeline marker`);
  assert.equal(capture.markerAddState.length, 2, `${name} toolbar adds a marker at the playhead`);
  assert.equal(capture.markerAddState[1].color, '#4c8dff');
  const frame = Math.round((fixture.playheadUs * fixture.fps.num) / (1_000_000 * fixture.fps.den));
  const frameTimeUs = Math.round((frame * 1_000_000 * fixture.fps.den) / fixture.fps.num);
  const expectedMarkerCenterX = fixture.timelineRegion.x + fixture.componentMasks.contentX
    + (frameTimeUs / 1_000_000) * fixture.pixelsPerSecond;
  const markerCenterX = capture.markerAddState[1].x + capture.markerAddState[1].width / 2;
  if (Math.abs(markerCenterX - expectedMarkerCenterX) > 1) {
    throw new Error(`${name} new marker is not snapped to the same frame: ${markerCenterX} vs ${expectedMarkerCenterX}`);
  }
}

await browser.close();
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceBuild: { command: 'vite build --config tools/openfilm-timeline-parity/vite.config.mjs', status: sourceBuild.status },
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  fixture,
  geometryChecks: {
    passed: true,
    altInsertFinalPositionToleranceUs: 0,
    altInsertClipCount: fixture.clips.length,
    zoomScaleTolerancePxPerSecond: 0.001,
    clipGeometryTolerancePx: 1,
    pinnedTitlePositionTolerancePx: 0.25,
    pinnedScrollPositionTolerancePx: 0.25,
    pinnedZoomScaleTolerancePxPerSecond: 0.001,
    dragPreviewGeometryTolerancePx: 1,
    committedGeometryTolerancePx: 1,
    durationGrowthPpsTolerancePxPerSecond: 0.001,
    durationScaleClipStartTolerancePx: 1,
    dynamicModifierSwitchDisplacementTolerancePx: 1,
    dynamicModifierCommitTolerancePx: 1,
  },
  pixelComparison: { status: 'pending-region-comparison', note: 'compare-png.mjs evaluates per-region pixel thresholds and writes the result here; a fixture result does not establish full P235 parity.' },
  note: 'Controlled paired capture uses the same 2130×1120 viewport and fixed 2130×380 timeline region, with identical synthetic local video/audio, seeded waveform and extracted filmstrip frames. Both pages load the actual OpenFilm Inter Variable font file from the local checkout; the OpenFilm capture confirms the face is ready. The Vortex filmstrip worker is stubbed at the worker boundary because Chrome cannot read the local app’s HTTP endpoint here, so this capture does not measure real thumbnail decoding or request scheduling. Playwright browser input exercises trusted diagonal deltaX, Alt+vertical, and Shift+wheel paths; it captures the initial 28px/s view, a simple cross-track move, Alt Insert, dynamic Place→Insert→Place with Alt released before commit, and a V3 move from 26s to 60s that extends project duration while requiring px/s to stay fixed. Geometry checks cover toolbar, ruler, track heads, clips, zoom, pinned-title boundary and those move paths; they do not establish full UI, interaction, Core revision/undo, native Electron or performance parity. Per-region screenshot thresholds are evaluated separately and must pass before any fixture-level visual pass is reported.',
  captures,
};
await writeFile(path.join(outputDir, 'capture.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  outputDir,
  geometryChecks: manifest.geometryChecks,
  altInsertFinalPositions: Object.fromEntries([...vortexInsertById].map(([id, item]) => [id, {
    trackId: item.trackId,
    startUs: item.startUs,
    openfilmStartUs: openInsertById.get(id)?.startUs ?? null,
  }])),
  pixelComparison: manifest.pixelComparison,
  pageErrors: {
    openfilm: openfilmCapture.pageErrors.length,
    vortex: vortexCapture.pageErrors.length,
  },
  measuredPps: {
    openfilm: openfilmCapture.metrics.measuredPps,
    vortex: vortexCapture.metrics.measuredPps,
  },
  drag: {
    openfilm: { start: openfilmCapture.drag.start, target: openfilmCapture.drag.target },
    vortex: { start: vortexCapture.drag.start, target: vortexCapture.drag.target },
    committedTimelineStartUs: vortexMove.placements[0].timeline_start_us,
  },
  durationScale: Object.fromEntries(Object.entries(captures).map(([name, capture]) => [name, capture.durationScaleProbe])),
  scrollPinnedTitle: {
    openfilm: openfilmCapture.pinnedTitle,
    vortex: vortexCapture.pinnedTitle,
    xTolerancePx: 0.25,
    yTolerancePx: 0.25,
  },
  screenshots: Object.fromEntries(Object.entries(captures).map(([name, capture]) => [name, {
    initial: capture.screenshot,
    scrollPin: capture.scrollScreenshot,
    dragPreview: capture.dragPreviewScreenshot,
    dragResult: capture.dragResultScreenshot,
  }])),
}, null, 2)}\n`);

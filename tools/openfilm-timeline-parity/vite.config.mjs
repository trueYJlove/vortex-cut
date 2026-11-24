import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tailwind from 'C:/DataFolder/codes/AI-Vidio/apps/desktop/node_modules/@tailwindcss/vite/dist/index.mjs';
import { defineConfig } from 'C:/DataFolder/codes/AI-Vidio/node_modules/.pnpm/vite@7.3.6_@types+node@22.2_9f9a4aad21a7fa42af2702589da2339e/node_modules/vite/dist/node/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const openfilm = 'C:/DataFolder/codes/openfilm/packages/openfilm';
const vortex = 'C:/DataFolder/codes/AI-Vidio';
const output = 'C:/DataFolder/codes/AI-Vidio/.codex-tmp/openfilm-timeline-parity-dist';
const reactRoot = `${vortex}/apps/desktop/node_modules/react`;
const reactDomRoot = `${vortex}/apps/desktop/node_modules/react-dom`;
const addParitySources = {
  name: 'openfilm-timeline-parity-tailwind-sources',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/globals.css') && !id.endsWith('/styles.css') && !id.endsWith('/tailwind.css')) return null;
    return `${code}\n@source "${openfilm}/studio/ui/src";\n@source "${vortex}/apps/desktop/src";\n`;
  },
};
const probeOpenFilmDragDecision = {
  name: 'openfilm-timeline-parity-drag-decision-probe',
  enforce: 'pre',
  transform(code, id) {
    const normalizedId = id.replaceAll('\\', '/');
    if (normalizedId.endsWith('/apps/desktop/src/app/timeline/TimelineCanvas.tsx')) {
      const modeLine = 'const moveMode = active.copyOnStart ? "place" : event.altKey ? "insert" : "place";';
      if (!code.includes(modeLine)) throw new Error('Vortex modifier mode probe could not find the move-mode decision');
      let instrumented = code.replace(modeLine, `${modeLine}\n          if (window.__p235TrackModifiers) window.__p235VortexMoveModes.push({ mode: moveMode, copyOnStart: active.copyOnStart, altKey: Boolean(event.altKey) });`);
      const planLine = 'const dragPlan = planAt(targetStartUs);';
      if (!instrumented.includes(planLine)) throw new Error('Vortex modifier mode probe could not find the computed drag plan');
      instrumented = instrumented.replace(planLine, `${planLine}\n          if (window.__p235TrackModifiers) window.__p235VortexMovePlans.push({ mode: moveMode, targetStartUs, dropHit, operations: dragPlan?.operations ?? [], placements: dragPlan?.placements ?? [], reason: dragPlan?.reason ?? null });`);
      const filmstripMarker = '  const clipLabelRects = useMemo(() => {';
      if (!instrumented.includes(filmstripMarker)) throw new Error('Vortex filmstrip probe could not find the label layout');
      instrumented = instrumented.replace(filmstripMarker, `  if (window.__p235TrackModifiers) { const sourceRect = filmstripClipRects.find(rect => rect.clip.clip_id === 'v3-a'); const prefix = sourceRect ? filmstripCachePrefix(sourceRect.clip) : null; window.__p235Filmstrip = { source: sourceRect ? { x: sourceRect.x, y: sourceRect.y, width: sourceRect.width, kind: sourceRect.clip.asset_kind, durationUs: sourceRect.clip.timeline_end_us - sourceRect.clip.timeline_start_us, prefix } : null, sourceCacheKeys: prefix ? [...thumbnailCache.current.keys()].filter(key => key.startsWith(prefix)) : [], groupIds: filmstripOverlayGroups.map(group => ({ id: group.clipId, cells: group.cells.length, x: group.x, y: group.y })), sourceSprite: sourceRect ? spriteStoreRef.current.has(sourceRect.clip.asset_id) : false }; }\n${filmstripMarker}`);
      return instrumented;
    }
    if (normalizedId.endsWith('/lib/timeline-edit.ts')) {
      const closingLine = '  const shifts = closing ? closeSpans(d, closing) : [];';
      if (!code.includes(closingLine)) throw new Error('OpenFilm insert close probe could not find the shift calculation');
      let instrumented = code.replace(closingLine, `${closingLine}\n  if (window.__p235TrackModifiers) window.__p235PlanPhases.push({ phase: 'close', closing: closing ? [...closing.entries()] : null, shifts: shifts.map(shift => ({ point: shift.point, byTrack: [...shift.byTrack.entries()] })), tracks: d.tracks.map(track => ({ index: track.index, clips: track.clips.map(clip => ({ id: clip.id, startMs: clip.startMs, endMs: clip.endMs })) })) });`);
      const insertLine = '    rippleAt(d, roomAt, durMs, f.tracks, undefined, f.bound);';
      if (!instrumented.includes(insertLine)) throw new Error('OpenFilm insert ripple probe could not find the ripple calculation');
      instrumented = instrumented.replace(insertLine, `${insertLine}\n    if (window.__p235TrackModifiers) window.__p235PlanPhases.push({ phase: 'insert-ripple', point, at, roomAt, durMs, insertOn, dests, follow: f, tracks: d.tracks.map(track => ({ index: track.index, clips: track.clips.map(clip => ({ id: clip.id, startMs: clip.startMs, endMs: clip.endMs })) })) });`);
      const planResultLine = '  const plan = planOf(d);\n  return { ...plan, landMs };';
      if (!instrumented.includes(planResultLine)) throw new Error('OpenFilm final plan probe could not find the planOf result');
      instrumented = instrumented.replace(planResultLine, `  const plan = planOf(d);\n  if (window.__p235TrackModifiers) window.__p235PlanPhases.push({ phase: 'final-plan', operations: plan.ops, placed: [...plan.placed.entries()], tracks: d.tracks.map(track => ({ index: track.index, clips: track.clips.map(clip => ({ id: clip.id, startMs: clip.startMs, endMs: clip.endMs })) })) });\n  return { ...plan, landMs };`);
      return instrumented;
    }
    if (!normalizedId.endsWith('/components/useBlockDrag.ts')) return null;
    const decision = "const editMode: MoveMode = insertAtMs != null ? 'insert' : copy || explicit ? 'place' : moveEditMode(altNow);";
    if (!code.includes(decision)) throw new Error('OpenFilm drag decision probe could not find the pinned decision site');
    const withDecision = code.replace(decision, `${decision}\n      if (window.__p235TrackModifiers) window.__p235OpenFilmDragProbe.push({ altNow, editMode, copy, explicit, hoveredId: hovered?.block.id ?? null, hoveredZone: hovered?.zone ?? null, lane: hit.lane, band, onTrack: Boolean(onTrack), insertAtMs: insertAtMs ?? null, drop: drop.action });`);
    const planCall = ': planMove(m, {';
    if (!withDecision.includes(planCall)) throw new Error('OpenFilm drag planner call probe could not find planMove');
    const withPlanProbe = withDecision.replace(planCall, ': p235ProbePlanMove(planMove, m, {');
    const functionMarker = 'export function useBlockDrag(opts: {';
    if (!withPlanProbe.includes(functionMarker)) throw new Error('OpenFilm drag planner probe could not find hook declaration');
    const helper = `function p235ProbePlanMove(plan, model, spec) {\n  const result = plan(model, spec);\n  if (window.__p235TrackModifiers) window.__p235PlanCalls.push({ mode: spec.mode, ids: spec.ids, to: [...(spec.to?.entries?.() ?? [])], pointerMs: spec.pointerMs, insertAtMs: spec.insertAtMs ?? null, magnet: spec.magnet, linkage: spec.linkage, model: model.map(track => ({ index: track.index, role: track.role, clips: track.clips.map(clip => ({ id: clip.id, startMs: clip.startMs, endMs: clip.endMs })) })), operations: result?.ops ?? null, placed: result ? [...result.placed.entries()] : null });\n  return result;\n}\n\n`;
    const withHelper = withPlanProbe.replace(functionMarker, `${helper}${functionMarker}`);
    const planAssignment = '      lastPlan = plan;';
    if (!withHelper.includes(planAssignment)) throw new Error('OpenFilm drag plan probe could not find the plan assignment');
    const planAssignmentIndex = withHelper.lastIndexOf(planAssignment);
    return withHelper.slice(0, planAssignmentIndex) + `${planAssignment}\n      if (window.__p235TrackModifiers && window.__p235OpenFilmDragProbe.length) Object.assign(window.__p235OpenFilmDragProbe.at(-1), { plannedOps: plan?.ops ?? null, placed: plan ? [...plan.placed.entries()] : null });` + withHelper.slice(planAssignmentIndex + planAssignment.length);
  },
};

export default defineConfig({
  root: here,
  base: './',
  cacheDir: `${vortex}/.codex-tmp/openfilm-timeline-parity-vite-cache`,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  plugins: [addParitySources, probeOpenFilmDragDecision, tailwind()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${openfilm}/studio/ui/src/` },
      { find: /^@fontsource-variable\/inter$/, replacement: `${openfilm}/node_modules/@fontsource-variable/inter/index.css` },
      { find: /^tailwindcss$/, replacement: `${vortex}/apps/desktop/node_modules/tailwindcss` },
      { find: /^lucide-react$/, replacement: `${vortex}/apps/desktop/node_modules/lucide-react/dist/cjs/lucide-react.js` },
      { find: /^react$/, replacement: `${reactRoot}/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${reactRoot}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${reactRoot}/jsx-dev-runtime.js` },
      { find: /^react-dom\/client$/, replacement: `${reactDomRoot}/client.js` },
      { find: /^react-dom$/, replacement: `${reactDomRoot}/index.js` },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 43179,
    strictPort: true,
    fs: { allow: [here, vortex, openfilm] },
  },
  build: {
    outDir: output,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: path.resolve(here, 'index.html'),
        vortex: path.resolve(here, 'vortex.html'),
      },
    },
  },
});

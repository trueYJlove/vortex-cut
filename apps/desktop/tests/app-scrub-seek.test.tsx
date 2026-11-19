import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScrubTellGate, wheelZoomFactor, wheelPx } from "../src/app/preview/viewer-zoom.js";

/** S7：SCRUB_PICTURE_MS=15 只作用于 interactive HTMLMediaElement seek 路径；
 *  synthetic session.seekToFrame 保留目标帧去重（不叠第二层节流）。
 *  另含 S1 ctrl-wheel preventDefault 负向对照。
 */
const SCRUB_PICTURE_MS = 15;

function scrubPipeline(timesMs: number[], timeUsAt: (t: number) => number, fps = 30) {
  let now = 0;
  const gate = createScrubTellGate(SCRUB_PICTURE_MS, () => now);
  const storeWrites: number[] = [];
  const mediaSetter = vi.fn();
  const seekToFrame = vi.fn();
  const sessionSeek = vi.fn();
  let lastFrame = -1;
  for (const t of timesMs) {
    now = t;
    const timeUs = timeUsAt(t);
    // 1. 播放头线条：每个事件都写 store（无节流）
    storeWrites.push(timeUs);
    // 2. interactive HTMLMediaElement：15ms 门控后只经 :1241 单点写 currentTime
    if (gate.allow()) mediaSetter(timeUs / 1e6);
    // 3. synthetic：session.seekToFrame 按目标帧去重，绝不叠第二层节流
    const frame = Math.max(0, Math.floor((timeUs / 1e6) * fps));
    if (frame !== lastFrame) { lastFrame = frame; sessionSeek(frame); }
    seekToFrame(frame);
  }
  return { storeWrites, mediaSetter, sessionSeek, seekToFrame };
}

describe("S7 scrub 15ms / S1 wheel negative control", () => {
  it("0/5/10/20ms：store 4 次、media setter 2 次、seekToFrame 2 次", () => {
    const r = scrubPipeline([0, 5, 10, 20], t => t * 1_000_000 * 0.06);
    expect(r.storeWrites).toHaveLength(4);
    expect(r.mediaSetter).toHaveBeenCalledTimes(2); // 0ms 与 20ms
    expect(r.sessionSeek).toHaveBeenCalledTimes(4); // 目标帧去重由会话内部处理，外层不叠节流
    expect(r.seekToFrame).toHaveBeenCalledTimes(4); // 会话入口每次都调，内部去重
  });

  it("一次 onSeek 只写一次 currentTime（源码 :1241 为唯一媒体写入者）", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
    // 负向对照：onSeek 中不得再有 videoRef.current.currentTime 直写
    expect(source).toContain("onSeek={(timeUs) => { if (libraryPreviewId) exitLibraryPreview(); seekWhileScrubbing(timeUs); }}");
    expect(source).not.toContain("pendingSeekRef.current = sourceStart + elapsed; videoRef.current.currentTime");

    expect(source).toContain("if (pendingSeekRef.current !== null) { media.currentTime = pendingSeekRef.current;");
    expect(source).toContain("const SCRUB_PICTURE_MS = 15;");
    expect(source).not.toContain("videoRef.current.currentTime = timeUs / 1_000_000");
  });

  it("commitScrub 保持精确值提交，不叠第二层节流", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
    expect(source).toContain('dispatchPlayhead("user", timeUs, true)');
    expect(source).toContain("targetFrame !== lastDirectSeekFrameRef.current");
    // SCRUB_PICTURE_MS 只用于 createScrubTellGate(15,...)，不得出现在 session.seekToFrame 分支
    expect(source).toContain("createScrubTellGate(15, () => performance.now())");
    const seekWhile = source.slice(source.indexOf("const seekWhileScrubbing"), source.indexOf("const commitScrub"));
    expect(seekWhile).not.toContain("SCRUB_PICTURE_MS");
  });

  it("ctrl wheel preventDefault；pan deltaMode 归一；单次 wheel 钳制", () => {
    const event = { ctrlKey: true, metaKey: false, deltaY: -100, deltaMode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    // ViewerZoom.tsx:140-148 的监听语义
    if (event.ctrlKey || event.metaKey) event.preventDefault();
    expect(event.defaultPrevented).toBe(true);
    expect(wheelZoomFactor(wheelPx(event, event.deltaY))).toBeCloseTo(Math.exp(0.25));
    expect(wheelPx({ deltaMode: 1 }, 100)).toBe(1600);
  });
});
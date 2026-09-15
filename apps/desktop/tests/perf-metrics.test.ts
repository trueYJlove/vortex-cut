import { describe, expect, it } from "vitest";
import { PerfRecorder, installEditorDiagnostics } from "../src/app/preview/perf-metrics.js";
describe("bounded editor diagnostics", () => {
  it("is disabled by default and retains no events", () => {
    const recorder = new PerfRecorder(2); recorder.record("compose");
    expect(recorder.snapshot()).toMatchObject({ events: [], counts: {}, overwritten: 0 });
  });
  it("wraps chronologically while preserving cumulative counters", () => {
    const recorder = new PerfRecorder(2); recorder.enabled = true;
    for (let i = 0; i < 5; i++) recorder.record("compose", 0, 1, i);
    expect(recorder.snapshot().events.map(e => e.request)).toEqual([3, 4]);
    expect(recorder.snapshot()).toMatchObject({ counts: { compose: 5 }, overwritten: 3 });
    recorder.reset(); expect(recorder.snapshot().events).toEqual([]);
  });
  it("keeps request/epoch/input correlation without strings or media payloads", () => {
    const recorder = new PerfRecorder(); recorder.enabled = true;
    recorder.record("decode", 12, 2, 3, 4, 5, 6);
    expect(recorder.snapshot().events[0]).toMatchObject({ session: 2, request: 3, epoch: 4, frame: 5, input: 6, duration: 12 });
  });
  it("preserves full-run duration totals without exposing mutable state", () => {
    const recorder = new PerfRecorder(1); recorder.enabled = true;
    recorder.record("decode", 4); recorder.record("decode", 8);
    const snapshot = recorder.snapshot();
    expect(snapshot.durations.decode).toEqual({ total_ms: 12, max_ms: 8 });
    snapshot.durations.decode!.total_ms = 0;
    expect(recorder.snapshot().durations.decode!.total_ms).toBe(12);
    const generation = recorder.generation;
    recorder.reset();
    expect(recorder.generation).toBe(generation + 1);
    expect(recorder.snapshot().durations).toEqual({});
  });
  it("rejects unbounded capacities and leaves ordinary builds unexposed", () => {
    expect(() => new PerfRecorder(0)).toThrow(); expect(() => new PerfRecorder(1e9)).toThrow();
    installEditorDiagnostics(); expect((window as any).__editorPerf).toBeUndefined();
  });
  it("records drag_to_submit like other duration kinds (2026-09-15 matrix row)", () => {
    const recorder = new PerfRecorder(); recorder.enabled = true;
    recorder.record("drag_to_submit", 37.5, 1, 0, 7, 42);
    expect(recorder.snapshot().events[0]).toMatchObject({ kind: "drag_to_submit", duration: 37.5, epoch: 7, frame: 42 });
    expect(recorder.snapshot().durations.drag_to_submit).toEqual({ total_ms: 37.5, max_ms: 37.5 });
  });
});

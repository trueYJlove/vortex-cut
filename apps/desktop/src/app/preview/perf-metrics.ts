/** Opt-in diagnostics for the complete editor. No media identifiers or payloads. */
export type PerfKind = "compose" | "submitted" | "decode" | "upload" | "seek" | "reanchor" | "session_open" | "session_close" | "long_task" | "react_commit" | "timeline_draw" | "window_fetch" | "residency" | "ready_manifest" | "ready_parse" | "ready_window" | "ready_inject";
export interface PerfEvent { kind: PerfKind; at: number; duration: number; session: number; request: number; epoch: number; frame: number; input: number }
/** B13-R 驻留遥测：两 worker 生命周期计数的最新快照（时长型 PerfEvent 装不下
 *  结构化数据，独立字段随 snapshot() 输出；仅 residency 事件时间线进 events）。 */
export interface ResidencySnapshot {
  at: number;
  decode: { decoded: number; posted: number; cached: number; closed: number; live: number; cacheBytes: number; cacheSize: number };
  compositor: { framesIn: number; framesClosed: number; framesLive: number; uploadsOk: number; uploadsErr: number; closedOnErr: number; uploadMode: string; textureBytes: number };
}
export class PerfRecorder {
  enabled = false;
  generation = 0;
  private events: PerfEvent[] = [];
  private cursor = 0;
  private counts: Partial<Record<PerfKind, number>> = {};
  private total = 0;
  private durations: Partial<Record<PerfKind, { total_ms: number; max_ms: number }>> = {};
  /** B13-R：最近一次驻留快照（会话侧从 worker ack 聚合后写入）。 */
  residency: ResidencySnapshot | null = null;
  constructor(readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new Error("invalid event capacity");
  }
  record(kind: PerfKind, duration = 0, session = 0, request = 0, epoch = 0, frame = -1, input = -1): void {
    if (!this.enabled) return;
    const event = { kind, at: performance.now(), duration, session, request, epoch, frame, input };
    this.events[this.cursor] = event;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.total++;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    const aggregate = this.durations[kind] ??= { total_ms: 0, max_ms: 0 };
    aggregate.total_ms += duration;
    aggregate.max_ms = Math.max(aggregate.max_ms, duration);
  }
  reset(): void { this.generation++; this.events = []; this.cursor = 0; this.total = 0; this.counts = {}; this.durations = {}; this.residency = null; }
  snapshot() {
    const events = this.events.length < this.capacity ? [...this.events] : [...this.events.slice(this.cursor), ...this.events.slice(0, this.cursor)];
    return { schema_version: 1, enabled: this.enabled, capacity: this.capacity, overwritten: Math.max(0, this.total - this.capacity), counts: { ...this.counts }, durations: Object.fromEntries(Object.entries(this.durations).map(([kind, value]) => [kind, { ...value }])), events, residency: this.residency,
      timing_semantics: "submitted = worker GL commands returned, NOT GPU completion or presentation" };
  }
}
export const editorPerf = new PerfRecorder();
let nextSession = 0;
export const allocatePerfSession = (): number => ++nextSession;
export function installEditorDiagnostics(): () => void {
  // Build-time gate: normal release builds cannot enable this endpoint.
  if (import.meta.env.VITE_AIVS_PERF !== "1") return () => undefined;
  const host = window as unknown as { __editorPerf?: { configure(enabled: boolean): void; reset(): void; snapshot(): ReturnType<PerfRecorder["snapshot"]> } };
  let observer: PerformanceObserver | undefined;
  host.__editorPerf = {
    configure(enabled) {
      if (editorPerf.enabled !== (enabled === true)) editorPerf.reset();
      editorPerf.enabled = enabled === true;
      observer?.disconnect(); observer = undefined;
      if (editorPerf.enabled && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) editorPerf.record("long_task", entry.duration); });
        observer.observe({ entryTypes: ["longtask"] });
      }
    },
    reset: () => editorPerf.reset(), snapshot: () => editorPerf.snapshot(),
  };
  return () => { observer?.disconnect(); editorPerf.enabled = false; delete host.__editorPerf; };
}

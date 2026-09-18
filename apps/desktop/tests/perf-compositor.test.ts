import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositorWorkerClient } from "../src/app/preview/compositor-worker.js";
import { editorPerf } from "../src/app/preview/perf-metrics.js";
class FakeWorker extends EventTarget {
  static last: FakeWorker;
  messages: any[] = [];
  terminate = vi.fn();
  constructor() { super(); FakeWorker.last = this; }
  postMessage(message: any) {
    this.messages.push(message);
    if (message.type === "init") queueMicrotask(() => this.reply({ type: "ready", adapter: "test", vendor: "test" }));
  }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
async function create() {
  vi.stubGlobal("Worker", FakeWorker);
  const canvas = document.createElement("canvas");
  Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
  return CompositorWorkerClient.create(canvas, { inputs: [], ringDepth: 3, canvasWidth: 16, canvasHeight: 16, captionStyles: {}, captionOverrideStyles: {} });
}
afterEach(() => { editorPerf.enabled = false; editorPerf.reset(); vi.unstubAllGlobals(); });
describe("diagnostic compose acknowledgement boundary", () => {
  it("sends no extra sequence/ack request when disabled", async () => {
    const client = await create();
    client.compose([]);
    expect(FakeWorker.last.messages.at(-1)).toEqual({ type: "compose", payload: { cmds: [] } });
    client.terminate();
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("correlates acknowledgements once and ignores old measurement generations", async () => {
    const client = await create(); editorPerf.enabled = true; client.perfSession = 7;
    client.compose([], 3, 9);
    const seq = FakeWorker.last.messages.at(-1).seq;
    FakeWorker.last.reply({ type: "submitted", seq });
    FakeWorker.last.reply({ type: "submitted", seq });
    expect(editorPerf.snapshot().counts.submitted).toBe(1);
    expect(editorPerf.snapshot().events.at(-1)).toMatchObject({ session: 7, epoch: 3, frame: 9, request: seq });
    client.compose([], 3, 10);
    const stale = FakeWorker.last.messages.at(-1).seq;
    editorPerf.reset();
    FakeWorker.last.reply({ type: "submitted", seq: stale });
    expect(editorPerf.snapshot().events).toEqual([]);
    client.terminate();
  });
  it("bounds unacknowledged submissions and discards them on dispose", async () => {
    const client = await create(); editorPerf.enabled = true;
    for (let frame = 0; frame < 600; frame++) client.compose([], 0, frame);
    for (const message of FakeWorker.last.messages) if (message.type === "compose") FakeWorker.last.reply({ type: "submitted", seq: message.seq });
    expect(editorPerf.snapshot().counts).toMatchObject({ compose: 600, submitted: 512 });
    client.compose([]); const seq = FakeWorker.last.messages.at(-1).seq;
    client.terminate(); FakeWorker.last.reply({ type: "submitted", seq });
    expect(editorPerf.snapshot().counts.submitted).toBe(512);
  });
});

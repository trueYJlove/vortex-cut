/** B13 compositor Worker 协议回归：registerInput/releaseInput ack 链、
 *  generation 作废旧代上传（帧关闭防泄漏）、字节记账响应携带。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositorWorkerClient } from "../src/app/preview/compositor-worker.js";

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
  return CompositorWorkerClient.create(canvas, { inputs: [], ringDepth: 8, canvasWidth: 16, canvasHeight: 16, captionStyles: {} });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("B13 registerInput/releaseInput 协议", () => {
  it("registerInput 发送协议消息并 resolve 于 inputRegistered ack", async () => {
    const client = await create();
    const acked = client.registerInput("in_a", 2, { width: 640, height: 360 }, 5, true);
    const message = FakeWorker.last.messages.at(-1);
    expect(message).toMatchObject({ type: "registerInput", inputId: "in_a", generation: 2, ringDepth: 5, shadow: true });
    FakeWorker.last.reply({ type: "inputRegistered", seq: message.seq, textureBytes: 12345 });
    await expect(acked).resolves.toMatchObject({ textureBytes: 12345 });
    client.terminate();
  });

  it("releaseInput 发送协议消息并 resolve 于 inputReleased ack", async () => {
    const client = await create();
    const acked = client.releaseInput("in_a", 2);
    const message = FakeWorker.last.messages.at(-1);
    expect(message).toMatchObject({ type: "releaseInput", inputId: "in_a", generation: 2 });
    FakeWorker.last.reply({ type: "inputReleased", seq: message.seq, textureBytes: 0 });
    await expect(acked).resolves.toMatchObject({ textureBytes: 0 });
    client.terminate();
  });

  it("registerInput 携带 generation 递增语义（调用方驱动）", async () => {
    const client = await create();
    const ack1 = client.registerInput("in_a", 1, { width: 640, height: 360 }, 8, false);
    expect(FakeWorker.last.messages.at(-1).generation).toBe(1);
    const ack2 = client.registerInput("in_a", 2, { width: 640, height: 360 }, 5, false);
    expect(FakeWorker.last.messages.at(-1).generation).toBe(2);
    expect(FakeWorker.last.messages.at(-1).ringDepth).toBe(5);
    client.terminate();
    // terminate 拒绝全部在途 ack——显式消费锁语义，不留 unhandled rejection。
    await expect(ack1).rejects.toThrow("compositor worker disposed");
    await expect(ack2).rejects.toThrow("compositor worker disposed");
  });

  it("disposed 后 registerInput 拒绝", async () => {
    const client = await create();
    client.terminate();
    await expect(client.registerInput("in_a", 1, { width: 16, height: 9 }, 8, false))
      .rejects.toThrow("compositor worker disposed");
    await expect(client.releaseInput("in_a", 1))
      .rejects.toThrow("compositor worker disposed");
  });
});

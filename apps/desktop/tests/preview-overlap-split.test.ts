/** GAP-CROSS-TRACK-OVERLAP 桌面侧验收（2026-09-15 缺陷批 W4）：投影层把
 *  同素材跨轨重叠段拆分为复制输入（I0 / I0~1）后，会话为两个 input 各建
 *  rig/worker（ticket 按 asset_id 解析同一票据）——双位置消费不再共享环池、
 *  frameReady 可满足、compose 推进（旧实现：共享环深 8，两消费位置相距 >8
 *  互相淘汰槽位 → 播放头停滞）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";
import type { Ir } from "../src/app/preview/ir.js";

/** 同素材 V1 主轨 + V2 浮层重叠（投影 W4 拆分后的 IR 形状：I0 + I0~1）。 */
function overlappedIr(): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  ir.inputs.push({ ...ir.inputs[0]!, input_id: "in_1~1" }); // 复制输入（同 asset）
  ir.segments.push({ ...ir.segments[0]!, clip_id: "clip_2", track_id: "V2", input_id: "in_1~1" });
  // 浮层消费位置与主轨拉开（源窗口 2s 之后——旧实现两位置相距 60 帧 > 环深 8）
  const overlay = ir.segments[1]!;
  overlay.source_start_us = 2_000_000;
  overlay.source_end_us = 5_000_000;
  for (const frame of ir.frames) {
    frame.overlays = frame.overlays ?? [];
    frame.overlays.push({
      clip_id: "clip_2", input_id: "in_1~1",
      src_n: Math.min(60 + frame.n, 89), src_t_us: 0,
      box: { x: 100, y: 100, w: 320, h: 568 }, rotation_deg: 0, alpha: 1,
    });
  }
  return ir;
}

beforeEach(() => {
  ScriptedWorker.instances = [];
  installWorkers();
  stubOffscreenCanvas();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("W4 GAP-CROSS-TRACK-OVERLAP：拆分输入双 rig 会话", () => {
  it("两个 input 各建 decode worker（同 asset 同票据），seek 全量精修可就绪", async () => {
    const container = document.createElement("div");
    const session = await PreviewSession.create(container, overlappedIr(), new Map([["asset_video", "aivideo://media/one"]]));
    // compositor(0) + in_1(1) + in_1~1(2)：复制输入得到独立 worker
    expect(ScriptedWorker.instances.length).toBe(3);
    const decodeMain = ScriptedWorker.instances[1]!;
    const decodeDup = ScriptedWorker.instances[2]!;
    // 双 worker 收到的 init 票据相同（同 asset_id → 同 ticket）
    const ticketOf = (worker: ScriptedWorker) => worker.messages.find(m => m.type === "init")?.url;
    expect(ticketOf(decodeMain)).toBe("aivideo://media/one");
    expect(ticketOf(decodeDup)).toBe("aivideo://media/one");

    // 全 worker 正常回帧/ack 后 seek：目标帧主轨 + 浮层全部输入就绪 → compose
    for (const worker of [decodeMain, decodeDup]) {
      const originalPost = worker.postMessage.bind(worker);
      worker.postMessage = (message: any) => {
        if (message.type === "decode") queueMicrotask(() => worker.reply({ type: "frame", id: message.id, frame: { close: () => undefined } }));
        else originalPost(message);
      };
    }
    const compositor = ScriptedWorker.instances[0]!;
    const originalPost = compositor.postMessage.bind(compositor);
    compositor.postMessage = (message: any) => {
      if (message.type === "upload") queueMicrotask(() => compositor.reply({ type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }));
      else originalPost(message);
    };
    const result = await session.seekToFrame(30);
    expect(result).toBe(30);
    // compose 已下发（帧就绪判定通过——旧实现此处永假）
    const composed = compositor.messages.filter(m => m.type === "compose");
    expect(composed.length).toBeGreaterThanOrEqual(1);
    expect(session.metrics().last_error).toBeNull();
    session.dispose();
  });
});

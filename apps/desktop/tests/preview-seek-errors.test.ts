/** DEFECT-4K60-SEEK 错误传播验收（2026-09-15 缺陷批 W1）：
 *  seek 解码/上传失败必须落定为 lastError + 返回 -1，不再向上抛
 *  （旧实现 Promise.all rejection 无人接 → unhandled rejection，装配期
 *  seek 失败还会把整个预览打成 error）。三形态：decode reject、
 *  compositor upload reject、upload ack 永不回（15s 超时兜底）。
 *  桩与 preview-lifecycle.test.tsx 同模式（ScriptedWorker 控制行为）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";
import type { Ir } from "../src/app/preview/ir.js";

const TICKETS = new Map([["asset_video", "aivideo://media/one"]]);

function freshIr(): Ir {
  return JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
}

/** 会话装配（worker 全 ready）+ 返回会话与 decode/compositor 桩实例。 */
async function readySession(): Promise<{ session: PreviewSession; decode: ScriptedWorker; compositor: ScriptedWorker }> {
  const container = document.createElement("div");
  const session = await PreviewSession.create(container, freshIr(), TICKETS);
  // worker 创建顺序：compositor(0) → decode(1)
  return { session, compositor: ScriptedWorker.instances[0]!, decode: ScriptedWorker.instances[1]! };
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

describe("W1 DEFECT-4K60-SEEK：seek 失败落定不外抛", () => {
  it("decode 错误回执：seekToFrame 返回 -1、lastError 记录、不 reject", async () => {
    const { session, decode } = await readySession();
    // 会话建成后把 decode 桩改为"回 error"（id 回执路径）
    const originalPost = decode.postMessage.bind(decode);
    decode.postMessage = (message: any) => {
      if (message.type === "decode") queueMicrotask(() => decode.reply({ type: "error", id: message.id, message: "decode failed 4k" }));
      else originalPost(message);
    };
    const result = await session.seekToFrame(10);
    expect(result).toBe(-1);
    expect(session.metrics().last_error).toContain("seek 解码失败");
    expect(session.metrics().last_error).toContain("decode failed 4k");
    session.dispose();
  });

  it("compositor uploadError 回执：seekToFrame 返回 -1、lastError 记录", async () => {
    const { session, compositor } = await readySession();
    // decode 正常回帧（构造最小 VideoFrame 桩），upload 回 uploadError
    decodeRepliesFrame(compositor);
    const originalPost = compositor.postMessage.bind(compositor);
    compositor.postMessage = (message: any) => {
      if (message.type === "upload") queueMicrotask(() => compositor.reply({ type: "uploadError", seq: message.seq, message: "gl upload failed" }));
      else originalPost(message);
    };
    const result = await session.seekToFrame(10);
    expect(result).toBe(-1);
    expect(session.metrics().last_error).toContain("gl upload failed");
    session.dispose();
  });

  it("upload ack 永不回（挂起形态）：15s 超时兜底后 seek 落定", async () => {
    const { session, compositor } = await readySession();
    decodeRepliesFrame(compositor);
    // upload 请求一律吞掉（worker 存活但 ack 不回——登记的"事件不齐"形态）
    const originalPost = compositor.postMessage.bind(compositor);
    compositor.postMessage = (message: any) => {
      if (message.type !== "upload") originalPost(message);
    };
    vi.useFakeTimers();
    try {
      const seeking = session.seekToFrame(10);
      const settled = await vi.advanceTimersByTimeAsync(15_100).then(() => seeking);
      expect(settled).toBe(-1);
      expect(session.metrics().last_error).toContain("upload timeout");
    } finally {
      vi.useRealTimers();
    }
    session.dispose();
  });

  it("回归：正常 seek 不写错误、返回目标帧号", async () => {
    const { session, compositor } = await readySession();
    decodeAndUploadReplies(compositor);
    const result = await session.seekToFrame(10);
    expect(result).toBe(10);
    expect(session.metrics().last_error).toBeNull();
    session.dispose();
  });

  it("回归：被更新的 seek 取代（epoch 失配）→ -1、不写错误", async () => {
    const { session, compositor } = await readySession();
    decodeAndUploadReplies(compositor);
    const first = session.seekToFrame(10);
    const second = session.seekToFrame(20);
    expect(await first).toBe(-1);
    expect(await second).toBe(20);
    expect(session.metrics().last_error).toBeNull();
    session.dispose();
  });
});

/** decode 桩回最小 VideoFrame（upload 请求可发生）。 */
function decodeRepliesFrame(compositor: ScriptedWorker): void {
  // decode worker 是第 1 个实例；compositor(0) 转发 upload。此处给 decode 桩
  // 装"回帧"行为（会话建成后 postMessage 已绑定 this，直接改原型方法外覆写）。
  const decode = ScriptedWorker.instances[1]!;
  const originalPost = decode.postMessage.bind(decode);
  decode.postMessage = (message: any) => {
    if (message.type === "decode") queueMicrotask(() => decode.reply({ type: "frame", id: message.id, frame: fakeFrame() }));
    else originalPost(message);
  };
  void compositor;
}

/** decode 回帧 + compositor 回 uploaded ack（正常路径全通）。 */
function decodeAndUploadReplies(compositor: ScriptedWorker): void {
  decodeRepliesFrame(compositor);
  const originalPost = compositor.postMessage.bind(compositor);
  compositor.postMessage = (message: any) => {
    if (message.type === "upload") queueMicrotask(() => compositor.reply({ type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }));
    else originalPost(message);
  };
}

/** jsdom 无 VideoFrame：最小结构桩（close 被调用即可）。 */
function fakeFrame(): unknown {
  return { close: () => undefined, timestamp: 0, duration: 0, codedWidth: 2, codedHeight: 2 };
}

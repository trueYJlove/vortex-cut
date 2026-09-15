/** DEFECT-4K60-SESSION-HANG 装配看门狗验收（2026-09-15 缺陷批 W2）：
 *  create 链 45s 总期限（15s 握手只覆盖 worker init 单跳，IPC/fetch/
 *  addModule 等阶段此前无看门狗——4K 首次装配挂起 >4min 无提示）。
 *  超时 → dispose 已拉起的 worker + 类型化错误；正常路径不误杀。
 *  测试注入短期限（CREATE_DEADLINE_MS 可写静态）+ 假定时器快进。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";
import type { Ir } from "../src/app/preview/ir.js";

const TICKETS = new Map([["asset_video", "aivideo://media/one"]]);

function freshIr(): Ir {
  return JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
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

describe("W2 DEFECT-4K60-SESSION-HANG：装配看门狗", () => {
  it("装配阶段挂起（sourceResolver 永不落定）→ 期限内落定错误 + worker 清场", async () => {
    // 注入短期限（真实 45s 测试不可等）；挂起源 = sourceResolver.resolve
    const previous = PreviewSession.CREATE_DEADLINE_MS;
    PreviewSession.CREATE_DEADLINE_MS = 500;
    const hangResolver = {
      resolve: () => new Promise<never>(() => undefined), // 永不落定
      cache: undefined, deps: [], projectId: "p_hang", invalidate: () => undefined,
    } as unknown as import("../src/app/preview/source-resolver.js").PreviewSourceResolver;
    vi.useFakeTimers();
    try {
      const container = document.createElement("div");
      const creating = PreviewSession.create(container, freshIr(), TICKETS, undefined, undefined, hangResolver);
      const assertion = expect(creating).rejects.toThrow("装配超时");
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      // 会话已 dispose：无泄漏 worker、无残留 canvas
      expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
      expect(container.querySelector("canvas")).toBeNull();
    } finally {
      PreviewSession.CREATE_DEADLINE_MS = previous;
      vi.useRealTimers();
    }
  });

  it("decode worker init 失败回发 error（不再吞 rejection）：真实错误直达客户端", async () => {
    // init 失败现在回 {type:"error", id:null} → 客户端 onMessage data.type==="error"
    // && id===undefined 分支：pending 非空时 terminate。握手路径由 workerReady
    // 的 read 抛出（error 消息在 ready 前）→ 拒绝并终止。
    const { DecodeWorker } = await import("../src/app/preview/decode-worker.js");
    // 直接驱动 ScriptedWorker：init 后回 error（模拟 init() 内部失败回发）
    class InitFailWorker extends ScriptedWorker {
      postMessage(message: any) {
        this.messages.push(message);
        if (message.type === "init") queueMicrotask(() => this.reply({ type: "error", message: "HttpRangeSource create failed: net::ERR" }));
      }
    }
    vi.stubGlobal("Worker", InitFailWorker);
    await expect(DecodeWorker.create("aivideo://media/one")).rejects.toThrow("HttpRangeSource create failed: net::ERR");
    expect(ScriptedWorker.instances.every(worker => worker.terminated)).toBe(true);
  });

  it("回归：正常装配不误杀（短期限内完成）", async () => {
    const previous = PreviewSession.CREATE_DEADLINE_MS;
    PreviewSession.CREATE_DEADLINE_MS = 10_000;
    try {
      const container = document.createElement("div");
      const session = await PreviewSession.create(container, freshIr(), TICKETS);
      expect(container.querySelector("canvas")).not.toBeNull();
      expect(session.isPlaying).toBe(false); // 会话存活可用（未误杀）
      session.dispose();
    } finally {
      PreviewSession.CREATE_DEADLINE_MS = previous;
    }
  });
});

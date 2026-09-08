/** A02 音频源缓存（session 作用域）：同素材多 clip 的 fetch/decodeAudioData
 *  single-flight + 并发上限 + 有限预热 + 失败重试门。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN A02）：
 * - 缓存 key = asset_id + input binding generation + AudioContext.sampleRate；
 *   不用临时票据字符串当稳定内容标识（票据 TTL 内 URL 可变但内容不变）。
 * - 首次调用同步登记 pending Promise，之后才 await fetch/decode；同 key 请求
 *   返回同 Promise，finally 只清理同 generation 条目。
 * - 初始并发上限 2（fetch+decode 计一次在途）；排队任务在同 key ready 后直接
 *   命中缓存（不占并发位）。
 * - failed 状态保留：每 tick 不重试，仅显式 retry() 或票据刷新后重试。
 * - decodeAudioData 无法可靠中止：abort 只挡住"结果安装"，不承诺取消底层
 *   解码；解码完成前并发位不归还（防止"取消后新任务"突破上限）。
 * - 缓存 AudioBuffer 可被多个 clip 读取；transfer 给 worklet 由消费方自行
 *   slice 副本（ensureWorkletNode 已按此语义），缓存本体不 transfer。
 * - 会话 dispose → abort 在途 fetch、拒绝排队、条目清空；共享已 ready 的
 *   buffer 引用只做登记归还（第一轮不跨 session 复用）。 */
import { throwIfAborted } from "./worker-lifecycle.js";

export interface AudioSourceEntry {
  state: "queued" | "loading" | "ready" | "error";
  promise: Promise<AudioBuffer>;
  controller: AbortController;
  buffer: AudioBuffer | null;
  decodedBytes: number;
  /** 引用计数（clip 级消费者 + 预热位）。0 且不再预热时才允许 abort。 */
  users: Set<string>;
  generation: number;
}

/** 并发上限与预热窗口常量（初始工程值；G0 冻结后可调）。 */
const MAX_CONCURRENT = 2;

interface LoadTask {
  key: string;
  entry: AudioSourceEntry;
  ticket: string;
  /** 唤醒排队等待者（门已让位）。 */
  resolve: () => void;
}

export class AudioSourceCache {
  private readonly entries = new Map<string, AudioSourceEntry>();
  private readonly queue: LoadTask[] = [];
  private inFlight = 0;
  private disposed = false;
  /** 失败条目的重试门：false 期间同 key 只命中 error 状态，不重发。 */
  private readonly retryable = new Set<string>();

  constructor(
    private readonly decode: (data: ArrayBuffer, signal: AbortSignal) => Promise<AudioBuffer>,
    private readonly fetchBytes: (ticket: string, signal: AbortSignal) => Promise<ArrayBuffer>,
    private readonly lifetime: AbortSignal,
    private readonly generation = 0,
  ) {
    this.lifetime.addEventListener("abort", () => this.dispose(), { once: true });
  }

  /** 条目快照（诊断/测试断言用）。 */
  snapshot(): Array<{ key: string; state: AudioSourceEntry["state"]; users: number; decodedBytes: number }> {
    return [...this.entries].map(([key, entry]) => ({ key, state: entry.state, users: entry.users.size, decodedBytes: entry.decodedBytes }));
  }

  get inflightCount(): number {
    return this.inFlight;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** 同步登记/获取条目：同 key 返回同一 Promise（single-flight）。
   *  失败条目在 retry() 前只返回既有 rejected Promise（不重发网络请求）。 */
  acquire(key: string, ticket: string, user: string, signal?: AbortSignal): Promise<AudioBuffer> {
    throwIfAborted(signal);
    if (this.disposed) throw new DOMException("audio cache disposed", "AbortError");
    let entry = this.entries.get(key);
    if (!entry || (entry.state === "error" && this.retryable.has(key))) {
      if (entry) entry.controller.abort();
      entry = {
        state: "queued",
        // 占位 promise：真实 promise 在下一行同步替换（load 为 async 函数，
        // 首个 await 前的同步段不会观察到此占位；用 resolved noop 防 unhandledrejection）
        promise: Promise.resolve(null as never),
        controller: new AbortController(),
        buffer: null,
        decodedBytes: 0,
        users: new Set(),
        generation: this.generation,
      };
      // 追随会话 lifetime：dispose 后在途 fetch 立即失败
      const lifetimeAbort = () => entry!.controller.abort();
      this.lifetime.addEventListener("abort", lifetimeAbort, { once: true });
      entry.promise = this.load(entry, ticket, lifetimeAbort).finally(() => {
        this.lifetime.removeEventListener("abort", lifetimeAbort);
      });
      this.entries.set(key, entry);
    }
    entry.users.add(user);
    return entry.promise;
  }

  /** 消费者离场：最后一个用户离开且条目非 ready → abort 在途/清理。 */
  release(key: string, user: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.users.delete(user);
    if (entry.users.size === 0 && entry.state !== "ready") entry.controller.abort();
  }

  /** 显式重试门：打开后下一次 acquire 重建失败条目（重新 fetch/decode）。 */
  retry(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.state === "error") this.retryable.add(key);
  }

  private async load(entry: AudioSourceEntry, ticket: string, lifetimeAbort: () => void): Promise<AudioBuffer> {
    try {
      if (entry.controller.signal.aborted) throw new DOMException("audio load aborted", "AbortError");
      entry.state = "loading";
      await this.pumpGate(entry, ticket);
      if (entry.buffer) {
        entry.state = "ready";
        entry.decodedBytes = entry.buffer.length * entry.buffer.numberOfChannels * 4;
        return entry.buffer;
      }
      throw new Error("audio load produced no buffer");
    } catch (error) {
      entry.state = "error";
      entry.buffer = null;
      throw error;
    } finally {
      this.lifetime.removeEventListener("abort", lifetimeAbort);
    }
  }

  /** 并发门：fetch+decode 全程占一个并发位；满员时排队等待 drain 唤醒。 */
  private async pumpGate(entry: AudioSourceEntry, ticket: string): Promise<void> {
    if (this.inFlight >= MAX_CONCURRENT) {
      const task: LoadTask = { key: "", entry, ticket, resolve: () => undefined };
      await new Promise<void>(resolve => {
        task.resolve = resolve;
        this.queue.push(task);
      });
      // 排队被唤醒后条目可能已 ready（同 key 前驱完成）或已作废
      if (entry.controller.signal.aborted) throw new DOMException("audio load aborted", "AbortError");
      if (entry.state === "ready" && entry.buffer) return;
    }
    this.inFlight += 1;
    try {
      const data = await this.fetchBytes(ticket, entry.controller.signal);
      throwIfAborted(entry.controller.signal);
      // decodeAudioData 无法中止：完成前并发位不归还（防"取消后新任务"超限）
      const buffer = await this.decode(data, entry.controller.signal);
      entry.buffer = buffer;
    } finally {
      this.inFlight -= 1;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    // 被唤醒者从 resolve 到回到 pumpGate 占位需跨一个微任务——同步循环重查
    // inFlight 会误判"仍有空位"再唤醒一人（唤醒者尚未占位）。改为一次性
    // 只放行与空位数相等的队头任务：唤醒即视为已预留该并发位。
    let slots = MAX_CONCURRENT - this.inFlight;
    while (slots > 0 && this.queue.length > 0) {
      this.queue.shift()!.resolve();
      slots -= 1;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, entry] of this.entries) entry.controller.abort();
    for (const task of this.queue.splice(0)) task.resolve();
    this.entries.clear();
  }
}

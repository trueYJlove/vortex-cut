/** App 级请求调度（A08）：setInterval 轮询改「上次请求结束后再 setTimeout」。

 *  - 同 endpoint（键）single-flight：在途期间的新请求合并共享同一次结果；
 *    成功且内容未变不写大 state（由调用方用浅比较决定是否 setState）。
 *  - 任务退避：无活跃任务/窗口后台时降低轮询频率（默认 6s），恢复前台或
 *    出现活跃任务时恢复快频（默认 1.5s）；前后台切换恢复一次立即刷新。
 *  - 模型列表只在「模型事件」时刷新（低频兜底由调用方决定，默认不参与快频）。
 *
 *  单位与回调均同步；不持有 React 状态——所有结果经 onResult 回调上抛，
 *  调用方决定是否 setState（避免每轮深比较大对象）。
 */
export interface PollEndpoint<T> {
  /** 端点身份键（single-flight 合并粒度）。 */
  key: string;
  /** 请求执行器（应自身可容错；异常经 onError 上抛后按失败退避）。 */
  fetch: () => Promise<T>;
  /** 结果到达：返回 false = 内容未变，不写 state（调用方做浅比较）。 */
  apply: (value: T) => boolean;
  /** 是否参与本轮调度（false = 本轮跳过，例如模型列表只在事件时刷新）。 */
  enabled?: () => boolean;
}

export interface RequestSchedulerOptions {
  /** 快频间隔（活跃任务/前台，ms）。 */
  activeIntervalMs?: number;
  /** 慢频间隔（无任务/后台，ms）。 */
  idleIntervalMs?: number;
  /** 失败后退避倍率（连续失败时间隔 × 此值，封顶 idleIntervalMs）。 */
  failureBackoffMultiplier?: number;
  /** 失败退避封顶（ms，默认 = idleIntervalMs）。 */
  failureBackoffCapMs?: number;
  /** 活跃判定（如存在 running/queued 任务）。 */
  hasActiveWork?: () => boolean;
  /** 后台判定（默认 document.hidden）。 */
  isHidden?: () => boolean;
  /** setTimeout/rAF 句柄类型（jsdom 兼容 number）。 */
}

interface Inflight<T> {
  promise: Promise<T | symbol>;
}

/** 调度器实例：每个 App（编辑器实例）一个；dispose 后不再排程。 */
export class RequestScheduler {
  private readonly activeIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly backoffMultiplier: number;
  private readonly backoffCapMs: number;
  private readonly hasActiveWork: () => boolean;
  private readonly isHidden: () => boolean;

  private endpoints: PollEndpoint<unknown>[] = [];
  private inflight = new Map<string, Inflight<unknown>>();
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private running = false;
  /** 成功/失败计数（测试断言与诊断）。 */
  readonly stats = { cycles: 0, skippedUnchanged: 0, failures: 0, merged: 0 };

  constructor(options: RequestSchedulerOptions = {}) {
    this.activeIntervalMs = options.activeIntervalMs ?? 1500;
    this.idleIntervalMs = options.idleIntervalMs ?? 6000;
    this.backoffMultiplier = options.failureBackoffMultiplier ?? 2;
    this.backoffCapMs = options.failureBackoffCapMs ?? this.idleIntervalMs;
    this.hasActiveWork = options.hasActiveWork ?? (() => false);
    this.isHidden = options.isHidden ?? (() =>
      typeof document !== "undefined" ? document.hidden : false);
  }

  /** 注册（或替换）端点；同一 key 后注册覆盖前注册。 */
  register<T>(endpoint: PollEndpoint<T>): void {
    const index = this.endpoints.findIndex(item => item.key === endpoint.key);
    if (index >= 0) this.endpoints[index] = endpoint as PollEndpoint<unknown>;
    else this.endpoints.push(endpoint as PollEndpoint<unknown>);
  }

  /** 启动调度（幂等：已启动时仅刷新一轮）。 */
  start(): void {
    if (this.disposed) return;
    if (this.timer !== null) return;
    void this.runCycle();
  }

  /** 立即跑一轮（前后台恢复/事件驱动刷新入口）。 */
  refresh(): void {
    if (this.disposed) return;
    void this.runCycle();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inflight.clear();
  }

  /** 下一轮间隔（测试可见）：活跃/前台 → 快频；失败退避单调上升。 */
  nextIntervalMs(): number {
    const base = this.hasActiveWork() || !this.isHidden()
      ? this.activeIntervalMs
      : this.idleIntervalMs;
    if (this.consecutiveFailures === 0) return base;
    const backoff = base * Math.pow(this.backoffMultiplier, Math.min(this.consecutiveFailures, 6));
    return Math.min(backoff, this.backoffCapMs);
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = this.nextIntervalMs();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, delay);
  }

  private async runCycle(): Promise<void> {
    // 结束后再排程：上一轮未结束时不叠加（running 守卫 + refresh 语义）。
    if (this.running || this.disposed) {
      this.scheduleNext();
      return;
    }
    this.running = true;
    try {
      const active = this.endpoints.filter(item => item.enabled?.() !== false);
      await Promise.all(active.map(endpoint => this.runEndpoint(endpoint)));
      this.stats.cycles += 1;
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private async runEndpoint(endpoint: PollEndpoint<unknown>): Promise<void> {
    const existing = this.inflight.get(endpoint.key);
    if (existing) {
      // single-flight：同键在途 → 合并等待（不重复发起）。
      this.stats.merged += 1;
      await existing.promise;
      return;
    }
    const promise = (async (): Promise<unknown | symbol> => {
      try {
        const value = await endpoint.fetch();
        if (this.disposed) return FAILED;
        if (!endpoint.apply(value)) this.stats.skippedUnchanged += 1;
        this.consecutiveFailures = 0;
        return value;
      } catch {
        this.consecutiveFailures += 1;
        this.stats.failures += 1;
        return FAILED;
      } finally {
        this.inflight.delete(endpoint.key);
      }
    })();
    this.inflight.set(endpoint.key, { promise } as Inflight<unknown>);
    await promise;
  }
}

/** 在途请求失败的哨兵值（区分于正常返回 undefined）。 */
const FAILED = Symbol("request-failed");

/**
 * 队列的两种哨兵。必须是模块级 `const`（推断为 unique symbol），否则
 * `T | symbol` 无法用 `===` 收窄——调用方就拿不到 T 的属性。
 * - SKIPPED：代次过期（切项目），旧结果本就该丢；
 * - FAILED：本次执行失败（网络/IPC/业务错误），数据"未知"而非"为空"。
 */
const TASK_SKIPPED: unique symbol = Symbol("task-skipped");
const TASK_FAILED: unique symbol = Symbol("task-failed");

/**
 * 并发受限的任务队列（A08：转录/缩略图加载共用）。
 * - 顺序 FIFO，最大并发 maxConcurrent；
 * - generation 作废：push 时捕获代次，执行前若代次已过期则跳过（返回
 *   Skipped 标记，调用方不 setState）；
 * - dispose：清空队列（在途任务自然完成，结果被代次拦截）。
 */
export class BoundedTaskQueue<T> {
  readonly skipped: typeof TASK_SKIPPED = TASK_SKIPPED;
  /** 任务**执行失败**。与 skipped 分开：skipped 表示代次过期（旧结果本就该
   *  丢），failed 表示这次没拿到数据（调用方应保留上一次的已知值，而不是把
   *  它当成"该素材没有数据"）。 */
  readonly failed: typeof TASK_FAILED = TASK_FAILED;
  private queue: Array<{
    generation: number;
    task: () => Promise<T>;
    resolve: (value: T | typeof TASK_SKIPPED | typeof TASK_FAILED) => void;
  }> = [];
  private activeCount = 0;
  private disposed = false;

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
  }

  /** 当前代次：外部事件（切项目）递增后，旧任务执行前被作废。 */
  generation = 0;

  push(task: () => Promise<T>): Promise<T | typeof TASK_SKIPPED | typeof TASK_FAILED> {
    if (this.disposed) return Promise.resolve(this.skipped);
    const generation = this.generation;
    return new Promise(resolve => {
      this.queue.push({ generation, task, resolve });
      void this.drain();
    });
  }

  /** 代次推进：队列中旧代次任务与在途任务的结果将被作废。 */
  advanceGeneration(): void {
    this.generation += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1; // 在途任务完成时按代次拦截（结果作废）
    const pending = this.queue.splice(0);
    for (const item of pending) item.resolve(this.skipped);
  }

  private async drain(): Promise<void> {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0 && !this.disposed) {
      const item = this.queue.shift()!;
      if (item.generation !== this.generation) {
        item.resolve(this.skipped);
        continue;
      }
      this.activeCount += 1;
      // task() 恒应返回 Promise；测试在任务排队期间 restoreAllMocks 会让迟到
      // 的 mock 调用返回 undefined——按跳过处理，不让队列挂起或抛未接 rejection。
      // task() 也可能**同步抛出**（例如 IPC 桥未就绪、参数校验失败）。旧实现
      // 把它留在 try 之外：异常逃出 drain()（void 调用 → 未处理 rejection），
      // 且 item.resolve 永不执行 → 该 Promise 永久挂起、activeCount 永不复位。
      // 症状是"素材列出来了，转录摘要却永远是空"（2026-10-08 用户现场：lwd
      // 项目两条 ready 转录，UI 显示"尚未生成转录"）。
      let result: Promise<T> | undefined;
      try {
        result = item.task() as Promise<T> | undefined;
      } catch {
        this.activeCount -= 1;
        item.resolve(this.failed);
        void this.drain();
        continue;
      }
      if (!result || typeof result.then !== "function") {
        this.activeCount -= 1;
        item.resolve(this.failed);
        void this.drain();
        continue;
      }
      void result.then(value => {
        this.activeCount -= 1;
        item.resolve(item.generation === this.generation ? value : this.skipped);
        void this.drain();
      }).catch(() => {
        this.activeCount -= 1;
        item.resolve(this.failed);
        void this.drain();
      });
    }
    // dispose 后剩余任务已 resolve；正常路径下空队列自然停。
  }
}

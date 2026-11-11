/** 播放头轻量状态存储（A06）：预览每帧高频写入（rAF/30fps），React 10Hz 订阅。
 *  每个编辑器实例一个 store（TimelinePanel / App 各持引用），不是全局单例；
 *  useSyncExternalStore 的 getSnapshot 必须返回缓存的同一 primitive 值，
 *  时间未变化时不触发任何订阅通知。
 *  时间语义单位与时间线文档一致：微秒。
 *
 *  2026-11-10（对齐 OpenFilm 的 PlaybackClock.line）：新增**直线**表示法。
 *  原实现只有离散值 timeUs：播放期间必须每帧 set() 一次，每次都要走
 *  "微任务合并 + 通知全部订阅者"。OpenFilm 的做法是播放时只广播一条直线
 *  (时间点 t, 页面时钟 at, 速率 rate)，消费方各自按 anchorTime 外推——
 *  整段播放**零通知**，只有 seek/暂停才换线。
 *  两者并存：line 为 null 时退化为离散值（旧行为，全部既有调用点不变）。 */
export type PlayheadSource = "playback" | "user" | "external";

export interface PlayheadCommand {
  source: PlayheadSource;
  timeUs: number;
}

/** 一条播放直线：页面时钟 at（performance.now 毫秒）时刻处于 t（微秒），
 *  之后按 rate（微秒/毫秒 = 1000×倍速）线性推进。 */
export interface PlayheadLine {
  /** 直线起点的时间（µs）。 */
  tUs: number;
  /** 直线起点的页面时钟（performance.now() 毫秒）。 */
  atMs: number;
  /** 推进速率（µs / ms）。1.0 倍速 = 1000。 */
  rate: number;
}

/** 直线在 now（performance.now 毫秒）处的取值；at 之前的时刻钳在 t。 */
export function lineTimeUs(line: PlayheadLine, nowMs: number): number {
  return line.tUs + Math.max(0, nowMs - line.atMs) * line.rate;
}

export interface PlayheadStore {
  /** 当前播放头时间（µs）。React 渲染期读取——必须返回稳定 primitive。 */
  getSnapshot(): number;
  /** 订阅变更（useSyncExternalStore 协议）。返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /** 写入接口：内部与请求方持有的镜像不一致时才入队微任务合并通知。 */
  set(timeUs: number): void;
  /** 命令写入：带来源与递增请求 ID——请求方可比较「响应 epoch >= 请求 ID」
   *  判定该响应是否仍代表自己最新一次 seek 意图（旧响应不再回写 UI）。 */
  dispatch(command: PlayheadCommand): void;
  /** 只读时间（不进 React 协议，交互回调里取最新值用）。 */
  get(): number;
  /** 最新已派发命令（含 source 与请求 ID）。 */
  getLastCommand(): PlayheadCommand & { requestId: number };
  /** 请求 ID 单调递增计数（测试断言「用户命令作废旧回传」用）。 */
  getRequestId(): number;
  /** 当前播放直线；null = 静止（时间为离散值，由 set/dispatch 决定）。 */
  getLine(): PlayheadLine | null;
  /** 开始按直线推进（播放）：广播一次，之后消费方自行外推。 */
  startLine(line: PlayheadLine): void;
  /** 结束直线（暂停/seek）：清空并保留此刻时间。 */
  stopLine(nowMs?: number): void;
}

export function createPlayheadStore(): PlayheadStore {
  let timeUs = 0;
  let requestId = 0;
  let line: PlayheadLine | null = null;
  let lastCommand: PlayheadCommand & { requestId: number } = {
    source: "external",
    timeUs: 0,
    requestId: 0,
  };
  /** React（useSyncExternalStore）注册的监听器。 */
  const listeners = new Set<() => void>();
  /** 合并通知：一帧内多次 set 只派发一次。 */
  let notifyQueued = false;
  const notifyListeners = () => {
    notifyQueued = false;
    for (const listener of [...listeners]) listener();
  };
  const scheduleNotify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    void Promise.resolve().then(notifyListeners);
  };

  const store: PlayheadStore = {
    getSnapshot: () => timeUs,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      if (!Number.isFinite(next) || next === timeUs) return;
      timeUs = Math.max(0, next);
      scheduleNotify();
    },
    dispatch(command) {
      requestId += 1;
      lastCommand = { ...command, requestId };
      store.set(command.timeUs);
    },
    get: () => (line ? Math.max(0, lineTimeUs(line, performance.now())) : timeUs),
    getLastCommand: () => lastCommand,
    getRequestId: () => requestId,
    getLine: () => line,
    startLine(next) {
      line = next;
      timeUs = Math.max(0, lineTimeUs(next, performance.now()));
      // 只广播这一次：之后由消费方按直线外推，不再逐帧通知。
      scheduleNotify();
    },
    stopLine(nowMs) {
      if (!line) return;
      timeUs = Math.max(0, lineTimeUs(line, nowMs ?? performance.now()));
      line = null;
      scheduleNotify();
    },
  };
  return store;
}

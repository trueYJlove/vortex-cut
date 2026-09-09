/** 播放头轻量状态存储（A06）：预览每帧高频写入（rAF/30fps），React 10Hz 订阅。
 *  每个编辑器实例一个 store（TimelinePanel / App 各持引用），不是全局单例；
 *  useSyncExternalStore 的 getSnapshot 必须返回缓存的同一 primitive 值，
 *  时间未变化时不触发任何订阅通知。
 *  时间语义单位与时间线文档一致：微秒。 */
export type PlayheadSource = "playback" | "user" | "external";

export interface PlayheadCommand {
  source: PlayheadSource;
  timeUs: number;
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
}

export function createPlayheadStore(): PlayheadStore {
  let timeUs = 0;
  let requestId = 0;
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
    get: () => timeUs,
    getLastCommand: () => lastCommand,
    getRequestId: () => requestId,
  };
  return store;
}

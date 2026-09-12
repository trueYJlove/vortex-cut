/** Shared creation handshake. The caller owns terminating the worker on rejection. */
export const PREVIEW_INIT_TIMEOUT_MS = 15_000;
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Preview creation aborted", "AbortError");
}
export function workerReady<T>(worker: Worker, read: (data: any) => T | undefined,
                               send: () => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      worker.removeEventListener("messageerror", messageError);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (reason: unknown) => { cleanup(); reject(reason); };
    const message = (event: MessageEvent) => {
      try { const result = read(event.data); if (result !== undefined) { cleanup(); resolve(result); } }
      catch (reason) { fail(reason); }
    };
    const error = (event: ErrorEvent) => fail(new Error(event.message || "preview worker error"));
    const messageError = () => fail(new Error("preview worker message error"));
    const abort = () => fail(new DOMException("Preview creation aborted", "AbortError"));
    try {
      throwIfAborted(signal);
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.addEventListener("messageerror", messageError);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new Error("preview worker init timeout")), PREVIEW_INIT_TIMEOUT_MS);
      send();
    } catch (reason) { fail(reason); }
  });
}

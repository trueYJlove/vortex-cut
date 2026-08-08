import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "../src/lib/core-client.js";
import type { JobId } from "@aivideo/contracts";

function response(body: unknown, ok = true): Response { return { ok, status: ok ? 200 : 500, json: async () => body } as Response; }

describe("CoreClient", () => {
  it("uses ui_token in HTTP and authenticate as the first WebSocket message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ job_id: "job_1", type: "proxy", status: "queued", stage: "queued", progress: 0 }));
    const socket = { send: vi.fn(), close: vi.fn(), onopen: undefined, onmessage: undefined, onerror: undefined, onclose: undefined } as unknown as WebSocket;
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl, webSocketFactory: () => socket });
    await client.getJob("job_1" as JobId);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer ui-secret" } });
    client.subscribe("job_1" as JobId, vi.fn());
    socket.onopen?.(new Event("open"));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", token: "ui-secret" }));
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("ui-secret");
  });
  it("falls back to polling after WebSocket failure and stops on unsubscribe", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response({ job_id: "job_1", type: "proxy", status: "running", stage: "encode", progress: 0.5 }));
    const socket = { send: vi.fn(), close: vi.fn(), onopen: undefined, onmessage: undefined, onerror: undefined, onclose: undefined } as unknown as WebSocket;
    const listener = vi.fn();
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl, webSocketFactory: () => socket, pollIntervalMs: 10 });
    const unsubscribe = client.subscribe("job_1" as JobId, listener);
    socket.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(10);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    expect(socket.close).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

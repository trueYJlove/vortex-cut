import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "../src/lib/core-client.js";
import { CoreApiError, normalizeJob } from "../src/lib/core-client.js";
import type { JobId, ProjectId } from "@aivideo/contracts";

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response { return { ok, status, json: async () => body } as Response; }

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
  it("covers Stage 1A project, asset and paged job endpoints", async () => {
    const project = { project_id: "project_1", name: "Demo", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", last_opened_at: "2026-08-09T00:00:00.000Z" };
    const asset = { asset_id: "asset_1", project_id: "project_1", kind: "text", storage_mode: "external", display_name: "notes.txt", fingerprint: "sha256:1", size_bytes: 3, modified_at: "2026-08-09T00:00:00.000Z", availability: "available", media_info: { format_name: "txt", duration_us: 0 }, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z" };
    const job = { job_id: "job_1", project_id: "project_1", kind: "asset_probe", status: "queued", stage: "queued", progress: 0, attempt: 1, input: { asset_id: "asset_1" }, error: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", started_at: null, finished_at: null };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ items: [project], next_cursor: null }))
      .mockResolvedValueOnce(response(project))
      .mockResolvedValueOnce(response({ items: [asset], next_cursor: null }))
      .mockResolvedValueOnce(response({ items: [job], next_cursor: null }));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.listProjects()).resolves.toMatchObject({ items: [{ project_id: "project_1" }] });
    await expect(client.getProject("project_1" as ProjectId)).resolves.toMatchObject({ name: "Demo" });
    await expect(client.listAssets("project_1" as ProjectId)).resolves.toMatchObject({ items: [{ asset_id: "asset_1" }] });
    await expect(client.listJobs("project_1" as ProjectId)).resolves.toMatchObject({ items: [{ kind: "asset_probe" }] });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "http://127.0.0.1:4000/api/v1/projects",
      "http://127.0.0.1:4000/api/v1/projects/project_1",
      "http://127.0.0.1:4000/api/v1/projects/project_1/assets",
      "http://127.0.0.1:4000/api/v1/projects/project_1/jobs"
    ]);
  });
  it("normalizes legacy jobs without exposing paths", () => {
    const job = normalizeJob({ job_id: "job_1", type: "proxy", status: "queued", stage: "queued", progress: 0, input: { media_id: "media_1", path: "C:\\private\\clip.mp4" } });
    expect(job.kind).toBe("proxy");
    expect(job.input).not.toHaveProperty("path");
  });
  it("maps the frozen error envelope and HTTP statuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: "PROJECT_ARCHIVED", message: "archived", trace_id: "trace_1" } }, false, 409));
    const client = new CoreClient({ baseUrl: "http://127.0.0.1:4000", uiToken: "ui-secret", fetchImpl });
    await expect(client.getProject("project_1" as ProjectId)).rejects.toMatchObject({ status: 409, code: "PROJECT_ARCHIVED", traceId: "trace_1" });
  });
});

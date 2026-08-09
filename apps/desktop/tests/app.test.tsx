import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { App } from "../src/app/App.js";
import type { DesktopApi } from "../electron/preload/index.js";

const project = { project_id: "project_1" as never, name: "Demo", status: "active" as const, canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", last_opened_at: "2026-08-09T00:00:00.000Z" };
const asset = { asset_id: "asset_1" as never, project_id: "project_1" as never, kind: "text" as const, storage_mode: "external" as const, display_name: "notes.txt", fingerprint: "sha256:1", size_bytes: 8, modified_at: "2026-08-09T00:00:00.000Z", availability: "available" as const, media_info: { format_name: "txt", duration_us: 0 }, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z" };
const job = { job_id: "job_1" as never, project_id: "project_1" as never, kind: "asset_probe" as const, status: "interrupted" as const, stage: "failed", progress: 0, attempt: 1, input: { asset_id: "asset_1" as never }, error: { code: "JOB_INTERRUPTED", message: "interrupted" }, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", started_at: null, finished_at: "2026-08-09T00:00:00.000Z" };

function desktopApi(): DesktopApi {
  return {
    getRuntime: vi.fn().mockResolvedValue({ protocol_version: 1, status: "ready" }),
    chooseMedia: vi.fn(), probeMedia: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [project], next_cursor: null }),
    createProject: vi.fn().mockResolvedValue({ ...project, project_id: "project_2" as never, name: "New" }),
    getProject: vi.fn().mockResolvedValue(project),
    renameProject: vi.fn().mockResolvedValue({ ...project, name: "Renamed" }),
    archiveProject: vi.fn().mockResolvedValue({ ...project, status: "archived" }),
    reopenProject: vi.fn().mockResolvedValue(project),
    listAssets: vi.fn().mockResolvedValue({ items: [{ asset, media_url: "aivideo://asset/asset_1" }], next_cursor: null }),
    importAsset: vi.fn().mockResolvedValue({ grant: { grant_id: "grant_1", display_name: "clip.mp4", size_bytes: 10, modified_at: "2026-08-09T00:00:00.000Z", expires_at: "2026-08-09T01:00:00.000Z" }, asset, media_url: "aivideo://asset/asset_1" }),
    refreshAsset: vi.fn().mockResolvedValue({ asset, media_url: "aivideo://asset/asset_1" }),
    relocateAsset: vi.fn().mockResolvedValue({ grant: {}, asset, media_url: "aivideo://asset/asset_1" }),
    listJobs: vi.fn().mockResolvedValue({ items: [job], next_cursor: null }),
    createJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn().mockResolvedValue({ ...job, status: "cancelled" }),
    openArtifact: vi.fn(), openArtifactFolder: vi.fn(), subscribeJob: vi.fn().mockReturnValue(() => undefined), diagnostics: vi.fn()
  } as DesktopApi;
}

describe("Stage 1A workspace", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("renders project, asset and recovery state without sensitive fields", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "素材工作区" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Demo" })).toBeVisible();
    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(await screen.findByText("检测到可恢复任务")).toBeVisible();
    expect(document.body.textContent).not.toContain("C:\\");
    expect(document.body.textContent).not.toContain("ui-secret");
    expect(document.body.textContent).not.toContain("database");
  });

  it("supports rename, archive and typed import through preload methods", async () => {
    const api = desktopApi();
    window.desktop = api;
    render(<App />);
    await screen.findByRole("heading", { name: "Demo" });
    fireEvent.change(screen.getByLabelText("重命名项目"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith({ project_id: "project_1", name: "Renamed" }));
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith("project_1"));
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    await waitFor(() => expect(api.reopenProject).toHaveBeenCalledWith("project_1"));
    fireEvent.click(screen.getByRole("button", { name: "导入video" }));
    await waitFor(() => expect(api.importAsset).toHaveBeenCalledWith({ project_id: "project_1", kind: "video" }));
  });
});

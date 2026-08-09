import { describe, expect, it } from "vitest";
import { isApiErrorResponse, isFileGrant, isJobStatus, isProject, isSidecarReady, parseSidecarReadyLine } from "@aivideo/contracts";

describe("Stage 0 contract", () => {
  it("accepts exactly the AIVS_READY payload", () => {
    expect(parseSidecarReadyLine('AIVS_READY {"protocol_version":1,"port":43123,"pid":99,"build_version":"0.0.1"}')).toEqual({ protocol_version: 1, port: 43123, pid: 99, build_version: "0.0.1" });
    expect(isSidecarReady({ protocol_version: 2, port: 43123, pid: 99, build_version: "0.0.1" })).toBe(false);
  });
  it("keeps the task state vocabulary closed", () => {
    expect(isJobStatus("interrupted")).toBe(true);
    expect(isJobStatus("retry_wait")).toBe(false);
  });
  it("validates Stage 1A DTOs and the frozen error envelope", () => {
    expect(isFileGrant({ grant_id: "grant_1", display_name: "clip.mp4", size_bytes: 12, modified_at: "2026-08-09T00:00:00.000Z", expires_at: "2026-08-09T01:00:00.000Z" })).toBe(true);
    expect(isFileGrant({ grant_id: "grant_1", display_name: "clip.mp4", size_bytes: 12, modified_at: "2026-08-09T00:00:00.000Z" })).toBe(false);
    expect(isProject({ project_id: "project_1", name: "Demo", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", last_opened_at: "2026-08-09T00:00:00.000Z" })).toBe(true);
    expect(isApiErrorResponse({ error: { code: "PROJECT_NOT_FOUND", message: "missing", trace_id: "trace_1" } })).toBe(true);
    expect(isApiErrorResponse({ error: { code: "PROJECT_NOT_FOUND", message: "missing" } })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isApiErrorResponse, isFileGrant, isInternalModelManifest, isJobStatus, isModelDetail, isProject, isSidecarReady, isTranscript, parseSidecarReadyLine } from "@aivideo/contracts";

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
  it("separates internal manifests from renderer model details", () => {
    const hash = "a".repeat(64);
    expect(isInternalModelManifest({
      model_id: "model_1", provider: "faster-whisper", revision: "rev_1", display_name: "Tiny", purpose: "ASR",
      download_url: "https://example.test/model", trusted_source_id: "trusted", size_bytes: 10, installed_size_bytes: 10,
      sha256: hash, license: { id: "mit", name: "MIT", url: null, attribution: null, acceptance_required: false },
      supported_languages: ["auto", "zh", "en"], supports_word_timestamps: true, runtime_version: "1.0",
      runtime_requirements: {}, files: [{ path: "model.bin", size_bytes: 10, sha256: hash }], installed_path: "C:\\private\\model",
      created_at: "2026-08-10T00:00:00.000Z"
    })).toBe(true);
    expect(isModelDetail({
      model_id: "model_1", display_name: "Tiny", purpose: "ASR", provider: "faster-whisper", revision: "rev_1",
      supported_languages: ["auto", "zh", "en"], supports_word_timestamps: true, runtime_version: "1.0",
      model_size_bytes: 10, installed_size_bytes: 10, model_sha256: hash,
      license: { id: "mit", name: "MIT", url: null, attribution: null, acceptance_required: false },
      source: { kind: "trusted_manifest", display_name: "trusted", host: "example.test", url: "https://example.test/model" },
      requires_network: true, local_only: true, status: "unavailable", provider_status: "unavailable", progress: null,
      required_disk_bytes: 12, runtime_requirements: {}, files: [{ relative_path: "model.bin", size_bytes: 10, sha256: hash }],
      available_disk_bytes: 100
    })).toBe(true);
    expect(isModelDetail({ installed_path: "C:\\private\\model" })).toBe(false);
  });
  it("rejects invalid transcript ranges and accepts ordered read-only transcript DTOs", () => {
    const transcript = {
      transcript_id: "transcript_1", asset_id: "asset_1", status: "ready", language: "zh", provider: "faster-whisper",
      model_id: "model_1", model_revision: "rev_1", source_media_fingerprint: "sha256:abc", duration_us: 2_000_000,
      segments: [{ segment_id: "segment_1", ordinal: 0, start_us: 0, end_us: 1_000_000, text: "你好", confidence: 1,
        words: [{ word_id: "word_1", segment_id: "segment_1", ordinal: 0, start_us: 0, end_us: 500_000, text: "你", confidence: 1 }] }],
      words: null, created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z"
    };
    expect(isTranscript(transcript)).toBe(true);
    expect(isTranscript({ ...transcript, segments: [{ ...transcript.segments[0], end_us: 3_000_000 }] })).toBe(false);
  });
});

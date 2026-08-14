import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, ERROR_CODES, isApiErrorResponse, isAuthoritativePreview, isCaptionPresetId, isCandidateGeneration, isCandidateResponseAdapterId, isDestinationGrant, isExportCreateInput, isExportRecord, isFileGrant, isInternalModelManifest, isJobKind, isJobStatus, isModelDetail, isPreviewCreateResponse, isProject, isProviderCapabilityTestResult, isProviderConfig, isRecipe, isRenderArtifact, isSidecarReady, isTimelineCreateInput, isTimelineDiff, isTimelineDocument, isTimelineLayout, isTimelinePatch, isTimelinePatchCapabilityTestResponse, isTimelinePatchEgressPreview, isTimelinePatchGeneration, isTimelinePatchOperation, isTimelinePatchPrepareRequest, isTimelinePatchProposal, isTimelineState, isTranscript, parseSidecarReadyLine } from "@aivideo/contracts";

const now = "2026-08-11T00:00:00.000Z";

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
  it("freezes Stage 1C enums, error codes and every patch operation", () => {
    expect(CONTRACT_VERSION).toBe("stage2c-v1"); expect(isTimelineLayout("crop_fill")).toBe(true); expect(isTimelineLayout("smart_crop")).toBe(false); expect(isCaptionPresetId("high-contrast")).toBe(true); expect(isJobKind("authoritative_preview")).toBe(true); expect(isJobKind("timeline_patch_generation")).toBe(true); expect(ERROR_CODES).toContain("TIMELINE_CONFLICT"); expect(ERROR_CODES).toContain("TIMELINE_PATCH_PROPOSAL_CONFLICT"); expect(ERROR_CODES).toContain("CANDIDATE_PROVIDER_UNTESTED");
    const operations = [
      { op: "insert_asset_clip", asset_id: "asset_1", at_index: 0, duration_us: 3_000_000 },
      { op: "insert_transcript_segments", transcript_id: "transcript_1", segment_ids: ["segment_1"], at_index: 0, padding_before_us: 0, padding_after_us: 300_000, create_captions: true },
      { op: "remove_clip", clip_id: "clip_1" }, { op: "move_clip", clip_id: "clip_1", to_index: 0 }, { op: "trim_clip", clip_id: "clip_1", source_start_us: 0, source_end_us: 100_000 }, { op: "split_clip", clip_id: "clip_1", source_time_us: 100_000 }, { op: "set_layout", clip_id: "clip_1", layout: "fit" }, { op: "set_audio", clip_id: "clip_1", enabled: false, gain_db: -3 }, { op: "set_image_duration", clip_id: "clip_1", duration_us: 500_000 }, { op: "add_caption", start_us: 0, end_us: 200_000, text: "字幕", preset_id: "default-bottom", source_clip_id: null }, { op: "remove_caption", caption_id: "caption_1" }, { op: "update_caption", caption_id: "caption_1", text: "修改" }, { op: "set_caption_timing", caption_id: "caption_1", start_us: 0, end_us: 200_000 }, { op: "set_caption_preset", caption_id: "caption_1", preset_id: "game-safe-bottom" }
    ];
    expect(operations.every(isTimelinePatchOperation)).toBe(true);
    expect(isTimelinePatch({ schema_version: 1, base_revision_id: "revision_1", operations, summary: "完整编辑" })).toBe(true);
    expect(isTimelinePatchOperation({ op: "insert_asset_clip", asset_id: "asset_1", to_index: 0 })).toBe(false);
    expect(isTimelinePatchOperation({ ...operations[1], padding_after_us: 300_001 })).toBe(false);
  });
  it("严格接收 Core Stage2A 公开 DTO 并拒绝多余或敏感字段", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const recipe = { schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "规则", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1_500_000 }, document_sha256: hash };
    const provider = { provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "unavailable", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "untested", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: null, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: null, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, created_at: now, updated_at: now };
    const generation = { candidate_generation_id: "generation_1", project_id: "project_1", status: "interrupted", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    expect(isRecipe(recipe)).toBe(true); expect(isProviderConfig(provider)).toBe(true); expect(isCandidateGeneration(generation)).toBe(true);
    expect(isRecipe({ ...recipe, prompt: "secret" })).toBe(false); expect(isProviderConfig({ ...provider, api_key: "secret" })).toBe(false); expect(isCandidateGeneration({ ...generation, stale: true })).toBe(false);
    const supported = { ...provider, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: now, timeline_patch_capability_probe_sha256: `sha256:${"b".repeat(64)}` };
    const { provider_config_id: _providerConfigId, created_at: _createdAt, updated_at: _updatedAt, credential_status: _credentialStatus, kind: _kind, display_name: _displayName, base_url: _baseUrl, model: _model, enabled: _enabled, input_price_per_million: _inputPrice, output_price_per_million: _outputPrice, candidate_capability_status: _candidateStatus, candidate_response_adapter_id: _candidateAdapter, candidate_probe_protocol_version: _candidateProtocol, candidate_capability_tested_at: _candidateTestedAt, candidate_capability_failure_code: _candidateFailure, candidate_capability_probe_sha256: _candidateHash, ...capabilityTest } = supported;
    expect(isProviderConfig(supported)).toBe(true);
    for (const adapter of ["openai_responses_json_schema_v1", "openai_responses_patchscript_v1", "openai_chat_completions_json_schema_v1", "openai_chat_completions_patchscript_v1"]) expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: adapter })).toBe(true);
    expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: null })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: "dynamic_adapter" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "v1" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "2" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: null })).toBe(false); expect(isTimelinePatchCapabilityTestResponse(capabilityTest)).toBe(true); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, timeline_patch_response_adapter_id: "openai_responses_patchscript_v1" })).toBe(true); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, timeline_patch_probe_protocol_version: "v1" })).toBe(false); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, extra: true })).toBe(false); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, raw_response: "body" })).toBe(false);
    const candidateSupported = { candidate_capability_status: "supported", candidate_response_adapter_id: "openai_responses_candidatescript_v1", candidate_probe_protocol_version: "1", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"c".repeat(64)}` };
    expect(isProviderConfig({ ...provider, ...candidateSupported })).toBe(true); expect(isProviderCapabilityTestResult(candidateSupported)).toBe(true);
    for (const adapter of ["openai_responses_json_schema_v1", "openai_responses_candidatescript_v1", "openai_chat_completions_json_schema_v1", "openai_chat_completions_candidatescript_v1"]) expect(isCandidateResponseAdapterId(adapter)).toBe(true);
    expect(isProviderConfig({ ...provider, ...candidateSupported, candidate_response_adapter_id: "openai_responses_patchscript_v1" })).toBe(false); expect(isProviderConfig({ ...provider, ...candidateSupported, candidate_capability_failure_code: "PROVIDER_FAILED" })).toBe(false); expect(isProviderConfig({ ...provider, candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: `sha256:${"d".repeat(64)}` })).toBe(true); expect(isProviderConfig({ ...provider, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null })).toBe(false); expect(isProviderCapabilityTestResult({ ...candidateSupported, raw_response: "body" })).toBe(false); expect(isProviderCapabilityTestResult({ ...candidateSupported, response: "body" })).toBe(false);
  });
  it("validates Timeline create/state DTOs and rejects renderer-sensitive fields", () => {
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }], clips: [{ clip_id: "clip_1", track_id: "V1", order_index: 0, asset_id: "asset_1", asset_kind: "video", source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } }], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
    expect(isTimelineDocument(document)).toBe(true);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "V1", kind: "visual", locked: true }, { id: "C1", kind: "caption", locked: false }] })).toBe(false);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: true }] })).toBe(false);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }] })).toBe(true);
    expect(isTimelineDocument({ ...document, locked_elements: ["clip_1"] })).toBe(true);
    expect(isTimelineDocument({ ...document, locked_elements: ["clip_1", "clip_1"] })).toBe(false);
    expect(isTimelineDocument({ ...document, locked_elements: ["missing_clip"] })).toBe(false);
    expect(isTimelineCreateInput({ schema_version: 1, source: { kind: "transcript_selection", transcript_id: "transcript_1", segment_ids: ["segment_1"], padding_before_us: 0, padding_after_us: 0, create_captions: true }, default_layout: "fit", caption_preset_id: "default-bottom" })).toBe(true);
    const revision = { timeline_revision_id: "revision_1", project_id: "project_1", parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: "2026-08-11T00:00:00.000Z", schema_version: 1, document };
    expect(isTimelineState({ project_id: "project_1", current_revision: revision, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(true);
    expect(isTimelineState({ project_id: "project_1", current_revision: { ...revision, path: "C:\\private\\timeline.json" }, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(false);
  });
  it("validates Stage2B egress metadata, generation, proposal and diff without body leakage", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const diff = { schema_version: 1, project_id: "project_1", base_revision_id: "revision_1", target_revision_id: null, base_document_sha256: hash, target_document_sha256: hash, summary: { clip_changes: 1, caption_changes: 0, lock_changes: 0 }, duration_delta_us: -1000, clip_changes: [{ type: "trimmed", clip_id: "clip_1" }], caption_changes: [], lock_changes: [], indirect_locked_timing_shifts: [] };
    const preview = { timeline_patch_egress_preview_id: "preview_1", provider: { display_name: "Provider", origin: "https://provider.test", model: "model" }, prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", sent_fields: ["instruction", "timeline"], payload_sha256: hash, character_count: 10, estimated_tokens: 3, clip_count: 1, caption_count: 0, locked_count: 0, expires_at: now };
    const generation = { timeline_patch_generation_id: "generation_1", project_id: "project_1", base_revision_id: "revision_1", base_document_sha256: hash, status: "succeeded", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    const patch = { schema_version: 1, base_revision_id: "revision_1", operations: [{ op: "trim_clip", clip_id: "clip_1", source_start_us: 0, source_end_us: 900_000 }], summary: "trim" };
    const proposal = { schema_version: 1, timeline_patch_proposal_id: "proposal_1", timeline_patch_generation_id: "generation_1", project_id: "project_1", base_revision_id: "revision_1", base_document_sha256: hash, provider_config_id: "provider_1", provider_display_name: "Provider", model: "model", prompt_template_version: "timeline-patch-v1", output_schema_version: "timeline-patch-output-v1", patch, patch_sha256: hash, proposed_document_sha256: hash, diff, created_at: now, applied_revision_id: null, generation_status: "succeeded" };
    expect(isTimelinePatchOperation({ op: "set_clip_locked", clip_id: "clip_1", locked: true })).toBe(true);
    expect(isTimelinePatchPrepareRequest({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "中".repeat(4000) })).toBe(true);
    expect(isTimelinePatchPrepareRequest({ base_revision_id: "revision_1", provider_config_id: "provider_1", instruction: "中".repeat(4001) })).toBe(false);
    expect(isTimelinePatchEgressPreview(preview)).toBe(true); expect(isTimelinePatchGeneration(generation)).toBe(true); expect(isTimelineDiff(diff)).toBe(true); expect(isTimelinePatchProposal(proposal)).toBe(true);
    expect(isTimelinePatchEgressPreview({ ...preview, instruction: "正文" })).toBe(false); expect(isTimelinePatchProposal({ ...proposal, raw_response: "body" })).toBe(false);
  });
  it("validates frozen Render DTOs and rejects paths, URIs and tokens", () => {
    const hash = "a".repeat(64); const mediaInfo = { duration_us: 1_000_000, format_name: "mp4", video: { codec: "h264", width: 1080, height: 1920, pixel_format: "yuv420p", fps_num: 30, fps_den: 1 }, audio: { codec: "aac", sample_rate: 48_000, channels: 2 } };
    const preview = { render_artifact_id: "render_1", project_id: "project_1", timeline_revision_id: "revision_1", kind: "authoritative_preview", status: "ready", content_fingerprint: hash, profile_id: "preview-portrait-v1", display_name: "preview.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "libx264", fallback_reason: null, created_at: now };
    const exportRecord = { export_record_id: "export_1", project_id: "project_1", timeline_revision_id: "revision_1", render_artifact_id: "render_2", status: "succeeded", profile_id: "export-portrait-v1", destination_display_name: "video.mp4", size_bytes: 10, sha256: hash, media_info: mediaInfo, encoder: "h264_nvenc", fallback_reason: null, created_at: now };
    const queuedJob = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "authoritative_preview", status: "queued", stage: "queued", progress: 0, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
    expect(isAuthoritativePreview(preview)).toBe(true); expect(isRenderArtifact(preview)).toBe(true); expect(isExportRecord(exportRecord)).toBe(true);
    expect(isDestinationGrant({ destination_grant_id: "destination_1", display_name: "video.mp4", extension: ".mp4", overwrite_authorized: false, expires_at: now })).toBe(true);
    expect(isPreviewCreateResponse({ job: null, preview, reused: true })).toBe(true); expect(isPreviewCreateResponse({ job: queuedJob, preview: null, reused: false })).toBe(true);
    expect(isExportCreateInput({ timeline_revision_id: "revision_1", destination_grant_id: "destination_1", encoder_mode: "software" })).toBe(true);
    expect(isAuthoritativePreview({ ...preview, path: "C:\\private\\preview.mp4" })).toBe(false); expect(isRenderArtifact({ ...preview, uri: "file:///private.mp4" })).toBe(false); expect(isExportRecord({ ...exportRecord, admin_token: "secret" })).toBe(false);
  });
});

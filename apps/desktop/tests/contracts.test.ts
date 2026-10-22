import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, ERROR_CODES, isApiErrorResponse, isAuthoritativePreview, isCaptionPresetId, isCandidateGeneration, isCandidateResponseAdapterId, isDestinationGrant, isDirectoryGrant, isExportBatchCreateInput, isExportCreateInput, isExportRecord, isFileGrant, isInternalModelManifest, isJobKind, isJobStatus, isModelDetail, isPlatformPreset, isPreviewCreateResponse, isProject, isProviderCapabilityTestResult, isProviderConfig, isRecipe, isRenderArtifact, isRenditionPreviewCreateInput, isRenditionReframePreviewCreateInput, isRenditionReframeSnapshotSummary, isReframeExportBatchCreateInput, isReframeExportBatchRetryInput, isSidecarReady, isTimelineCreateInput, isTimelineDiff, isTimelineDocument, isTimelineLayout, isTimelinePatch, isTimelinePatchCapabilityTestResponse, isTimelinePatchEgressPreview, isTimelinePatchGeneration, isTimelinePatchOperation, isTimelinePatchPrepareRequest, isTimelinePatchProposal, isTimelineState, isTranscript, parseSidecarReadyLine, isMediaGenerationPrepareInput, isMediaGenerationCreateInput, isMediaGenerationPreparedRequest, isMediaGenerationRequest, isMediaGenerationTask, isMediaGenerationCreateResponse, isShotListRevisionCreateInput, isShotListRevisionSummary, isShotListRevisionDetail, isShotListState, isImageProviderConfigSummary,
  isProviderImageGenerationPrepareInput,
  isProviderImageGenerationPreparedPreview,
  isProviderImageGenerationRequest,
  isProviderImageGenerationTask,
  isAngleGroup,
  parseAngleGroup,
  parseAngleSyncResponse,
  isAgentSessionEgressPreview,
  isAgentSessionCreateResponse,
  isAgentSessionUpdatedEvent,
  isCvAnalysisSummary,
  parseAgentSession,
  parseCvAnalysisSummary,
  isDecodeCapabilityRow,
  isDecodeCapabilityTable,
  parseDecodeCapabilityTable
} from "@aivideo/contracts";

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
    expect(CONTRACT_VERSION).toBe("stage6r-v1"); expect(isTimelineLayout("crop_fill")).toBe(true); expect(isTimelineLayout("smart_crop")).toBe(false); expect(isCaptionPresetId("high-contrast")).toBe(true); expect(isJobKind("authoritative_preview")).toBe(true); expect(isJobKind("timeline_patch_generation")).toBe(true); expect(ERROR_CODES).toContain("TIMELINE_CONFLICT"); expect(ERROR_CODES).toContain("TIMELINE_PATCH_PROPOSAL_CONFLICT"); expect(ERROR_CODES).toContain("CANDIDATE_PROVIDER_UNTESTED"); expect(ERROR_CODES).toContain("EXPORT_DIRECTORY_GRANT_EXPIRED");
    const operations = [
      { op: "insert_asset_clip", asset_id: "asset_1", at_index: 0, duration_us: 3_000_000 },
      { op: "insert_transcript_segments", transcript_id: "transcript_1", segment_ids: ["segment_1"], at_index: 0, padding_before_us: 0, padding_after_us: 300_000, create_captions: true },
      { op: "remove_clip", clip_id: "clip_1" }, { op: "move_clip", clip_id: "clip_1", to_index: 0 }, { op: "trim_clip", clip_id: "clip_1", source_start_us: 0, source_end_us: 100_000 }, { op: "split_clip", clip_id: "clip_1", source_time_us: 100_000 }, { op: "set_layout", clip_id: "clip_1", layout: "fit" }, { op: "set_audio", clip_id: "clip_1", enabled: false, gain_db: -3 }, { op: "set_image_duration", clip_id: "clip_1", duration_us: 500_000 }, { op: "add_caption", start_us: 0, end_us: 200_000, text: "字幕", preset_id: "default-bottom", source_clip_id: null }, { op: "remove_caption", caption_id: "caption_1" }, { op: "update_caption", caption_id: "caption_1", text: "修改" }, { op: "set_caption_timing", caption_id: "caption_1", start_us: 0, end_us: 200_000 }, { op: "set_caption_preset", caption_id: "caption_1", preset_id: "game-safe-bottom" },
      { op: "position_clip", clip_id: "clip_1", timeline_start_us: 1_000_000, track_id: "V2" },
      { op: "add_track", kind: "video" }, { op: "remove_track", track_id: "V2" }, { op: "move_track", track_id: "V2", to_index: 0 }, { op: "set_track_flags", track_id: "V2", muted: true, solo: false }
    ];
    expect(operations.every(isTimelinePatchOperation)).toBe(true);
    expect(isTimelinePatch({ schema_version: 1, base_revision_id: "revision_1", operations, summary: "完整编辑" })).toBe(true);
    expect(isTimelinePatchOperation({ op: "insert_asset_clip", asset_id: "asset_1", to_index: 0 })).toBe(false);
    expect(isTimelinePatchOperation({ ...operations[1], padding_after_us: 300_001 })).toBe(false);
    expect(isTimelinePatchOperation({ op: "add_track", kind: "audio" })).toBe(false);
    expect(isTimelinePatchOperation({ op: "set_track_flags", track_id: "V2" })).toBe(false);
    expect(isTimelinePatchOperation({ op: "set_track_flags", track_id: "V2", hidden: "yes" })).toBe(false);
  });
  it("严格校验 Stage3A 预设、目录授权与批次输入", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(isPlatformPreset({ schema_version: 1, platform_preset_id: "generic", display_name: "通用", preset_version: 1, allowed_rendition_ids: ["portrait-9x16-v1", "landscape-16x9-v1"], default_rendition_id: "portrait-9x16-v1", filename_tag: "generic", document_sha256: hash })).toBe(true);
    expect(isPlatformPreset({ schema_version: 1, platform_preset_id: "generic", display_name: "通用", preset_version: 1, allowed_rendition_ids: ["portrait-9x16-v1"], default_rendition_id: "portrait-9x16-v1", filename_tag: "generic", document_sha256: hash, path: "C:\\private" })).toBe(false);
    expect(isDirectoryGrant({ directory_grant_id: "directory_1", display_name: "导出", expires_at: now })).toBe(true);
    expect(isDirectoryGrant({ directory_grant_id: "directory_1", display_name: "导出", expires_at: now, path: "C:\\private" })).toBe(false);
    expect(isRenditionPreviewCreateInput({ timeline_revision_id: "revision_1", platform_preset_id: "douyin", rendition_preset_id: "landscape-16x9-v1", layout_policy: "fit_all" })).toBe(true);
    expect(isExportBatchCreateInput({ timeline_revision_id: "revision_1", directory_grant_id: "directory_1", items: [{ rendition_snapshot_id: "rendition_snapshot_1", preview_artifact_id: "artifact_1" }] })).toBe(true);
    expect(isExportBatchCreateInput({ timeline_revision_id: "revision_1", directory_grant_id: "directory_1", items: [] })).toBe(false);
    expect(isExportBatchCreateInput({ timeline_revision_id: "revision_1", directory_grant_id: "directory_1", items: Array.from({ length: 9 }, (_, index) => ({ rendition_snapshot_id: `rendition_snapshot_${index}`, preview_artifact_id: `artifact_${index}` })) })).toBe(false);
  });
  it("严格接收 Core Stage2A 公开 DTO 并拒绝多余或敏感字段", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const recipe = { schema_version: 1, recipe_id: "balanced-narrative-v1", name: "Balanced", summary: "规则", rules: { selection: "keyword", pace: "balanced", max_gap_us: 1_500_000 }, document_sha256: hash };
    const provider = { provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "Provider", base_url: "https://provider.test", model: "model", enabled: true, credential_status: "unavailable", input_price_per_million: null, output_price_per_million: null, timeline_patch_capability_status: "untested", timeline_patch_response_adapter_id: null, timeline_patch_probe_protocol_version: null, timeline_patch_capability_tested_at: null, timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: null, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: null, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null, captions_provider_capability_status: "untested", captions_provider_response_adapter_id: null, captions_provider_probe_protocol_version: null, captions_provider_capability_tested_at: null, captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: null, created_at: now, updated_at: now };
    const generation = { candidate_generation_id: "generation_1", project_id: "project_1", status: "interrupted", payload_sha256: hash, created_at: now, updated_at: now, finished_at: now };
    expect(isRecipe(recipe)).toBe(true); expect(isProviderConfig(provider)).toBe(true); expect(isCandidateGeneration(generation)).toBe(true);
    expect(isRecipe({ ...recipe, prompt: "secret" })).toBe(false); expect(isProviderConfig({ ...provider, api_key: "secret" })).toBe(false); expect(isCandidateGeneration({ ...generation, stale: true })).toBe(false);
    const supported = { ...provider, timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "openai_chat_completions_json_schema_v1", timeline_patch_probe_protocol_version: "2", timeline_patch_capability_tested_at: now, timeline_patch_capability_probe_sha256: `sha256:${"b".repeat(64)}` };
    const { provider_config_id: _providerConfigId, created_at: _createdAt, updated_at: _updatedAt, credential_status: _credentialStatus, kind: _kind, display_name: _displayName, base_url: _baseUrl, model: _model, enabled: _enabled, input_price_per_million: _inputPrice, output_price_per_million: _outputPrice, candidate_capability_status: _candidateStatus, candidate_response_adapter_id: _candidateAdapter, candidate_probe_protocol_version: _candidateProtocol, candidate_capability_tested_at: _candidateTestedAt, candidate_capability_failure_code: _candidateFailure, candidate_capability_probe_sha256: _candidateHash, captions_provider_capability_status: _captionsStatus, captions_provider_response_adapter_id: _captionsAdapter, captions_provider_probe_protocol_version: _captionsProtocol, captions_provider_capability_tested_at: _captionsTestedAt, captions_provider_capability_failure_code: _captionsFailure, captions_provider_capability_probe_sha256: _captionsHash, ...capabilityTest } = supported;
    expect(isProviderConfig(supported)).toBe(true);
    for (const adapter of ["openai_responses_json_schema_v1", "openai_responses_patchscript_v1", "openai_chat_completions_json_schema_v1", "openai_chat_completions_patchscript_v1"]) expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: adapter })).toBe(true);
    expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: null })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_response_adapter_id: "dynamic_adapter" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "v1" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "2" })).toBe(true); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: "" })).toBe(false); expect(isProviderConfig({ ...supported, timeline_patch_probe_protocol_version: null })).toBe(false); expect(isTimelinePatchCapabilityTestResponse(capabilityTest)).toBe(true); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, timeline_patch_response_adapter_id: "openai_responses_patchscript_v1" })).toBe(true); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, timeline_patch_probe_protocol_version: "v1" })).toBe(false); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, extra: true })).toBe(false); expect(isTimelinePatchCapabilityTestResponse({ ...capabilityTest, raw_response: "body" })).toBe(false);
    const candidateSupported = { candidate_capability_status: "supported", candidate_response_adapter_id: "openai_responses_candidatescript_v1", candidate_probe_protocol_version: "2", candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: `sha256:${"c".repeat(64)}` };
    expect(isProviderConfig({ ...provider, ...candidateSupported })).toBe(true); expect(isProviderCapabilityTestResult(candidateSupported)).toBe(true);
    for (const adapter of ["openai_responses_json_schema_v1", "openai_responses_candidatescript_v1", "openai_chat_completions_json_schema_v1", "openai_chat_completions_candidatescript_v1"]) expect(isCandidateResponseAdapterId(adapter)).toBe(true);
    expect(isProviderConfig({ ...provider, ...candidateSupported, candidate_response_adapter_id: "openai_responses_patchscript_v1" })).toBe(false); expect(isProviderConfig({ ...provider, ...candidateSupported, candidate_capability_failure_code: "PROVIDER_FAILED" })).toBe(false); expect(isProviderConfig({ ...provider, candidate_capability_status: "unsupported", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: "PROVIDER_FAILED", candidate_capability_probe_sha256: `sha256:${"d".repeat(64)}` })).toBe(true); expect(isProviderConfig({ ...provider, candidate_capability_status: "untested", candidate_response_adapter_id: null, candidate_probe_protocol_version: null, candidate_capability_tested_at: now, candidate_capability_failure_code: null, candidate_capability_probe_sha256: null })).toBe(false); expect(isProviderCapabilityTestResult({ ...candidateSupported, raw_response: "body" })).toBe(false); expect(isProviderCapabilityTestResult({ ...candidateSupported, response: "body" })).toBe(false);
  });
  it("validates Timeline create/state DTOs and rejects renderer-sensitive fields", () => {
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }], clips: [{ clip_id: "clip_1", track_id: "V1", order_index: 0, asset_id: "asset_1", asset_kind: "video", source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000, layout: "fit", audio: { enabled: true, gain_db: 0 } }], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
    expect(isTimelineDocument(document)).toBe(true);
    // 旧 2/3 轨形状、非规范顺序、错误 kind 与未知轨道均拒绝。
    expect(isTimelineDocument({ ...document, tracks: [{ id: "V1", kind: "visual", locked: false }, { id: "C1", kind: "caption", locked: false }] })).toBe(false);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }] })).toBe(false);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "X1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }] })).toBe(false);
    expect(isTimelineDocument({ ...document, tracks: [{ id: "T1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }] })).toBe(false);
    // 覆盖视频轨（动态区域）+ 同轨片段允许空隙/禁止重叠。
    const overlayTracks = [{ id: "V2", kind: "video", locked: false, hidden: false, muted: false, solo: false }, ...document.tracks];
    expect(isTimelineDocument({ ...document, tracks: overlayTracks })).toBe(true);
    expect(isTimelineDocument({ ...document, clips: [{ ...document.clips[0], timeline_start_us: 2_000_000, timeline_end_us: 3_000_000 }] })).toBe(true);
    expect(isTimelineDocument({ ...document, tracks: overlayTracks, clips: [...document.clips, { ...document.clips[0], clip_id: "clip_2", track_id: "V2", timeline_start_us: 0, timeline_end_us: 2_000_000 }, { ...document.clips[0], clip_id: "clip_3", track_id: "V2", timeline_start_us: 1_000_000, timeline_end_us: 2_500_000 }] })).toBe(false);
    expect(isTimelineDocument({ ...document, locked_elements: ["clip_1"] })).toBe(true);
    expect(isTimelineDocument({ ...document, locked_elements: ["clip_1", "clip_1"] })).toBe(false);
    expect(isTimelineDocument({ ...document, locked_elements: ["missing_clip"] })).toBe(false);
    expect(isTimelineCreateInput({ schema_version: 1, source: { kind: "transcript_selection", transcript_id: "transcript_1", segment_ids: ["segment_1"], padding_before_us: 0, padding_after_us: 0, create_captions: true }, default_layout: "fit", caption_preset_id: "default-bottom" })).toBe(true);
    const revision = { timeline_revision_id: "revision_1", project_id: "project_1", parent_revision_id: null, document_sha256: "a".repeat(64), summary: "创建", created_by: "user", created_at: "2026-08-11T00:00:00.000Z", schema_version: 1, document };
    expect(isTimelineState({ project_id: "project_1", current_revision: revision, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(true);
    expect(isTimelineState({ project_id: "project_1", current_revision: { ...revision, path: "C:\\private\\timeline.json" }, draft: null, can_undo: false, can_redo: false, current_preview: null })).toBe(false);
  });
  it("accepts optional audio fade fields and keeps old documents valid (backward compatible)", () => {
    const clipOf = (audio: Record<string, unknown>) => ({ clip_id: "clip_1", track_id: "V1", order_index: 0, asset_id: "asset_1", asset_kind: "video", source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000, layout: "fit", audio });
    const oldAudio = { enabled: true, gain_db: 0 };
    const document = { schema_version: 1, project_id: "project_1", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" }, tracks: [{ id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false }, { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false }, { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false }], clips: [clipOf(oldAudio)], captions: [], provenance: { created_by: "user", source_transcript_ids: [] } };
    // 老文档（无 fade 键）仍然合法 —— 新字段是纯增量，不是新必填项。
    expect(isTimelineDocument(document)).toBe(true);
    expect(Object.keys(oldAudio)).toEqual(["enabled", "gain_db"]);
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_in_us: 500_000, fade_out_us: 250_000 })] })).toBe(true);
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_in_us: 0, fade_out_us: 0 })] })).toBe(true);
    // 非法值拒绝：负数 / 非整数 / 非数字 / 未知键。
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_in_us: -1 })] })).toBe(false);
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_out_us: 1.5 })] })).toBe(false);
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_in_us: "500000" })] })).toBe(false);
    expect(isTimelineDocument({ ...document, clips: [clipOf({ enabled: true, gain_db: 0, fade_secs: 1 })] })).toBe(false);
    // set_audio op：不带 fade 的旧形态不变；带 fade 合法；非法拒绝。
    expect(isTimelinePatchOperation({ op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0 })).toBe(true);
    expect(isTimelinePatchOperation({ op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0, fade_in_us: 500_000 })).toBe(true);
    expect(isTimelinePatchOperation({ op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0, fade_in_us: 500_000, fade_out_us: 0 })).toBe(true);
    expect(isTimelinePatchOperation({ op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0, fade_in_us: -5 })).toBe(false);
    expect(isTimelinePatchOperation({ op: "set_audio", clip_id: "clip_1", enabled: true, gain_db: 0, fade_out_us: 2.5 })).toBe(false);
  });
  it("validates Stage2B egress metadata, generation, proposal and diff without body leakage", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const diff = { schema_version: 1, project_id: "project_1", base_revision_id: "revision_1", target_revision_id: null, base_document_sha256: hash, target_document_sha256: hash, summary: { clip_changes: 1, caption_changes: 0, lock_changes: 0, transition_changes: 0 }, duration_delta_us: -1000, clip_changes: [{ type: "trimmed", clip_id: "clip_1" }], caption_changes: [], lock_changes: [], indirect_locked_timing_shifts: [], transition_changes: [] };
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
describe("Stage 3B reframe contracts", () => {
  const hash = "a".repeat(64);
  const adjustment = { clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "center" } as const;

  it("retains the Stage 3B strict non-center 3x3 guards under stage4d-v1", () => {
    expect(CONTRACT_VERSION).toBe("stage6r-v1");
    expect(ERROR_CODES).toContain("REFRAME_PREVIEW_REQUIRED");
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [adjustment] })).toBe(true);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ ...adjustment, horizontal_anchor: "center", vertical_anchor: "center" }] })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ ...adjustment, horizontal_anchor: "LEFT" }] })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [] })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: Array.from({ length: 501 }, (_, index) => ({ ...adjustment, clip_id: `clip_${index}` })) })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [adjustment, adjustment] })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [{ ...adjustment, path: "private.mp4" }] })).toBe(false);
    expect(isRenditionReframePreviewCreateInput({ base_rendition_snapshot_id: "rendition_snapshot_1", adjustments: [adjustment], timeline_revision_id: "revision_1" })).toBe(false);
  });

  it("keeps the public reframe snapshot summary redacted", () => {
    const summary = {
      rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", project_id: "project_1", timeline_revision_id: "revision_1",
      base_rendition_snapshot_id: "rendition_snapshot_1", base_snapshot_sha256: hash, platform_preset_id: "douyin",
      rendition_preset_id: "portrait-9x16-v1", adjustment_count: 1, reframe_snapshot_sha256: hash,
      warnings: ["STATIC_REFRAME_APPLIED"], created_at: now
    };
    expect(isRenditionReframeSnapshotSummary(summary)).toBe(true);
    expect(isRenditionReframeSnapshotSummary({ ...summary, adjustments: [adjustment] })).toBe(false);
    expect(isRenditionReframeSnapshotSummary({ ...summary, transcript: "private body" })).toBe(false);
  });

  it("validates independent reframe batch and retry inputs", () => {
    const item = { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", preview_artifact_id: "artifact_1" };
    expect(isReframeExportBatchCreateInput({ directory_grant_id: "directory_1", items: [item] })).toBe(true);
    expect(isReframeExportBatchCreateInput({ timeline_revision_id: "revision_1", directory_grant_id: "directory_1", items: [item] })).toBe(false);
    expect(isReframeExportBatchCreateInput({ directory_grant_id: "directory_1", items: [item, item] })).toBe(false);
    expect(isReframeExportBatchCreateInput({ directory_grant_id: "directory_1", items: Array.from({ length: 9 }, (_, index) => ({ rendition_reframe_snapshot_id: `rendition_reframe_snapshot_${index}`, preview_artifact_id: `artifact_${index}` })) })).toBe(false);
    expect(isReframeExportBatchRetryInput({ directory_grant_id: "directory_2", reframe_export_batch_item_ids: ["reframe_export_batch_item_1"] })).toBe(true);
    expect(isReframeExportBatchRetryInput({ directory_grant_id: "directory_2", reframe_export_batch_item_ids: ["export_batch_item_1"] })).toBe(false);
  });

  it("does not widen frozen Stage 3A guards", () => {
    expect(isRenditionPreviewCreateInput({ timeline_revision_id: "revision_1", platform_preset_id: "douyin", rendition_preset_id: "portrait-9x16-v1", layout_policy: "crop_fill_all", adjustments: [adjustment] })).toBe(false);
    expect(isExportBatchCreateInput({ directory_grant_id: "directory_1", items: [{ rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", preview_artifact_id: "artifact_1" }] })).toBe(false);
  });
});


describe("Stage 4A media generation contract", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const prepared = {
    schema_version: 1 as const, project_id: "project_1", generation_kind: "image" as const,
    execution_mode: "simulation_only" as const, prompt_sha256: hash, input_refs: ["asset_1"],
    parameters: { width: 1024, height: 1024, style_preset_id: "photo", seed: 7 }, request_sha256: hash
  };
  const request = { request_id: "generation_request_1", ...prepared, schema_version: undefined, created_at: now } as Record<string, unknown>;
  delete request.schema_version;
  const task = {
    task_id: "generation_task_1", request_id: "generation_request_1", job_id: "job_1", attempt: 1,
    status: "queued", stage: "queued", retry_of_task_id: null, output_asset_id: null, output_sha256: null,
    result_summary: null, error: null, created_at: now, updated_at: now, finished_at: null
  };

  it("保持版本不变并扩展独立 JobKind 与错误码", () => {
    expect(CONTRACT_VERSION).toBe("stage6r-v1");
    expect(isJobKind("media_generation")).toBe(true);
    expect(ERROR_CODES).toEqual(expect.arrayContaining([
      "GENERATION_REQUEST_INVALID", "GENERATION_KIND_UNSUPPORTED", "GENERATION_INPUT_CHANGED",
      "GENERATION_HASH_MISMATCH", "GENERATION_OUTPUT_INVALID", "GENERATION_INTERRUPTED",
      "GENERATION_RETRY_NOT_ALLOWED", "GENERATION_TASK_NOT_FOUND"
    ]));
  });

  it("只接受 image/TTS 白名单命令且命令 Prompt 仅作为瞬时输入", () => {
    expect(isMediaGenerationPrepareInput({ generation_kind: "image", prompt: "sentinel prompt", input_refs: ["asset_1"], parameters: { width: 64, height: 4096 } })).toBe(true);
    expect(isMediaGenerationPrepareInput({ generation_kind: "tts", prompt: "测试语音", input_refs: ["asset_1"], parameters: { voice_preset_id: "voice_1", language: "zh-CN", speed_milli: 1000 } })).toBe(true);
    expect(isMediaGenerationCreateInput({ generation_kind: "image", prompt: "p", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024 }, request_sha256: hash })).toBe(true);
    expect(isMediaGenerationPrepareInput({ generation_kind: "video", prompt: "p", input_refs: ["asset_1"], parameters: {} })).toBe(false);
    expect(isMediaGenerationPrepareInput({ generation_kind: "image", prompt: "p", input_refs: ["asset_1"], parameters: { width: 63, height: 1024 } })).toBe(false);
    expect(isMediaGenerationPrepareInput({ generation_kind: "tts", prompt: "p", input_refs: ["asset_1"], parameters: { voice_preset_id: "voice_1", language: "fr-FR", speed_milli: 1000 } })).toBe(false);
    expect(isMediaGenerationPrepareInput({ generation_kind: "image", prompt: "p", input_refs: ["asset_1"], parameters: { width: 1024, height: 1024, absolute_path: "private" } })).toBe(false);
  });

  it("验证 Prepared/Request/Task/CreateResponse 并拒绝响应敏感字段", () => {
    expect(isMediaGenerationPreparedRequest(prepared)).toBe(true);
    expect(isMediaGenerationRequest(request)).toBe(true);
    expect(isMediaGenerationTask(task)).toBe(true);
    expect(isMediaGenerationCreateResponse({ request, task, reused: false })).toBe(true);
    for (const forbidden of ["prompt", "absolute_path", "transcript", "caption", "payload", "stderr", "command", "traceback"]) {
      expect(isMediaGenerationRequest({ ...request, [forbidden]: "sentinel" })).toBe(false);
    }
    expect(isMediaGenerationTask({ ...task, result_summary: { execution_mode: "simulation_only", outcome: "validated_without_media", provider_call_count: 1 } })).toBe(false);
    expect(isMediaGenerationTask({ ...task, status: "succeeded", stage: "completed", finished_at: now, result_summary: { execution_mode: "simulation_only", outcome: "validated_without_media", provider_call_count: 0 } })).toBe(true);
  });
});


describe("Stage 4C shot requirement contract", () => {
  const hash = `sha256:${"b".repeat(64)}`;
  const imageRequirement = { title: "镜头一", visual_direction: "固定机位", target_duration_us: 3_000_000, visual: { requirement_kind: "image", source_asset_id: null }, narration: null };
  const mediaRequirement = { title: "镜头二", visual_direction: "沿用现有画面", target_duration_us: null, visual: { requirement_kind: "existing_media", source_asset_id: "asset_1" }, narration: { requirement_kind: "tts", text: "人工旁白正文" } };
  const input = { schema_version: 1, base_revision_id: null, title: "镜头清单", summary: "人工摘要", requirements: [imageRequirement, mediaRequirement] };
  const summary = { schema_version: 1, shot_list_revision_id: "revision_1", shot_list_id: "shot_list_1", project_id: "project_1", parent_revision_id: null, title: "镜头清单", requirement_count: 2, document_sha256: hash, created_at: now };
  const detail = { ...summary, summary: "人工摘要", requirements: [
    { shot_requirement_id: "requirement_1", shot_list_revision_id: "revision_1", ordinal: 0, ...imageRequirement },
    { shot_requirement_id: "requirement_2", shot_list_revision_id: "revision_1", ordinal: 1, ...mediaRequirement },
  ] };

  it("升级为 stage4d-v1 并接受 1–24 条严格组合", () => {
    expect(CONTRACT_VERSION).toBe("stage6r-v1");
    expect(isShotListRevisionCreateInput(input)).toBe(true);
    expect(isShotListRevisionCreateInput({ ...input, requirements: Array.from({ length: 24 }, (_, index) => ({ ...imageRequirement, title: `镜头${index + 1}` })) })).toBe(true);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [] })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: Array.from({ length: 25 }, () => imageRequirement) })).toBe(false);
  });

  it("拒绝 unknown/sensitive keys 和 visual/narration 非法组合", () => {
    expect(isShotListRevisionCreateInput({ ...input, extra: true })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [{ ...imageRequirement, payload: "private" }] })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [{ ...imageRequirement, visual: { requirement_kind: "image", source_asset_id: "asset_1" } }] })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [{ ...mediaRequirement, visual: { requirement_kind: "existing_media", source_asset_id: null } }] })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [{ ...imageRequirement, narration: { requirement_kind: "tts", text: "" } }] })).toBe(false);
    expect(isShotListRevisionCreateInput({ ...input, requirements: [{ ...imageRequirement, target_duration_us: 99_999 }] })).toBe(false);
  });

  it("Summary 不含正文，Detail 允许所属正文但拒绝路径/Provider 字段", () => {
    expect(isShotListRevisionSummary(summary)).toBe(true);
    expect(isShotListRevisionSummary({ ...summary, summary: "forbidden" })).toBe(false);
    expect(isShotListRevisionDetail(detail)).toBe(true);
    for (const forbidden of ["path", "uri", "provider", "payload", "raw_exception"]) {
      expect(isShotListRevisionDetail({ ...detail, [forbidden]: "private" })).toBe(false);
    }
    expect(isShotListState({ shot_list_id: null, project_id: "project_1", lifecycle: "empty", current_revision: null, confirmed_revision: null })).toBe(true);
    expect(isShotListState({ shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "drafted", current_revision: detail, confirmed_revision: null })).toBe(true);
    expect(isShotListState({ shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "drafted", current_revision: { ...detail, shot_list_revision_id: "revision_2", parent_revision_id: "revision_1", requirements: detail.requirements.map(item => ({ ...item, shot_list_revision_id: "revision_2" })) }, confirmed_revision: summary })).toBe(true);
    expect(isShotListState({ shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "confirmed", current_revision: detail, confirmed_revision: summary })).toBe(true);
    expect(isShotListState({ shot_list_id: "shot_list_1", project_id: "project_1", lifecycle: "confirmed", current_revision: { ...detail, shot_list_revision_id: "revision_2", parent_revision_id: "revision_1", requirements: detail.requirements.map(item => ({ ...item, shot_list_revision_id: "revision_2" })) }, confirmed_revision: summary })).toBe(false);
  });
});



describe("Stage 4D provider image contracts", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const now = "2026-08-19T00:00:00.000Z";
  it("accepts exact frozen DTOs and rejects sensitive or unknown keys", () => {
    expect(isProviderImageGenerationPrepareInput({ provider_config_id: "config_1", prompt: "private form only", size: "1024x1024" })).toBe(true);
    expect(isProviderImageGenerationPrepareInput({ provider_config_id: "config_1", prompt: "p", size: "512x512" })).toBe(false);
    const provider = { provider_config_id: "config_1", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" };
    const prepared = { preview_id: "preview_1", project_id: "project_1", execution_mode: "provider_image_v1", prompt_sha256: hash, payload_sha256: hash, size: "1024x1024", output_format: "png", image_count: 1, provider, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now };
    expect(isProviderImageGenerationPreparedPreview(prepared)).toBe(true);
    expect(isProviderImageGenerationPreparedPreview({ ...prepared, prompt: "leak" })).toBe(false);
    expect(isProviderImageGenerationPreparedPreview({ ...prepared, provider: { ...provider, raw_response: "leak" } })).toBe(false);
  });
  it("keeps provider image records separate from simulation DTOs", () => {
    const request = { request_id: "request_1", project_id: "project_1", generation_kind: "image", execution_mode: "provider_image_v1", prompt_sha256: hash, parameters: { size: "1024x1024" }, request_sha256: hash, created_at: now };
    const task = { task_id: "task_1", request_id: "request_1", job_id: "job_1", attempt: 1, status: "failed", stage: "failed", retry_of_task_id: null, provider_call_count: 0, provider_may_have_processed: false, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", output_asset_id: null, output_sha256: null, result_summary: null, error: { code: "IMAGE_PROVIDER_CALL_DISABLED", message: "当前环境未启用真实图片调用" }, created_at: now, updated_at: now, finished_at: now };
    expect(isProviderImageGenerationRequest(request)).toBe(true);
    expect(isProviderImageGenerationTask(task)).toBe(true);
    expect(isProviderImageGenerationTask({ ...task, absolute_path: "C:/private.png" })).toBe(false);
    expect(isImageProviderConfigSummary({ provider_config_id: "config_1", project_id: "project_1", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", capability: "image_text_to_image", protocol_version: "1", display_name: "Images", model: "gpt-image-2", enabled: true, price_per_image: 0.1, price_2k_per_image: 0.15, price_currency: "CNY", credential_status: "missing", created_at: now, updated_at: now })).toBe(true);
  });
});

describe("DESK-6 agent session + CV analysis contracts", () => {
  const hash = `sha256:${"f".repeat(64)}`;
  const job = { job_id: "job_1", project_id: "project_1", asset_id: null, kind: "agent_session", status: "running", stage: "calling_provider", progress: 0.5, attempt: 1, model_id: null, model_revision: null, input_fingerprint: null, input: {}, error: null, created_at: now, updated_at: now, started_at: null, finished_at: null };
  const preview = {
    agent_session_egress_preview_id: "agent_preview_1",
    provider: { display_name: "DeepSeek", origin: "https://api.test/v1", model: "deepseek-chat" },
    prompt_template_version: "agent-session-v1", output_schema_version: "agent-session-output-v1",
    sent_fields: ["instruction", "timeline", "multi_step_feedback"], payload_sha256: hash,
    character_count: 120, estimated_tokens: 40, clip_count: 2, caption_count: 1, locked_count: 0,
    max_steps: 6, token_budget: 200000, expires_at: now
  };
  it("accepts the session egress preview and rejects sensitive leaks", () => {
    expect(isAgentSessionEgressPreview(preview)).toBe(true);
    expect(isAgentSessionEgressPreview({ ...preview, payload: { instruction: "leak" } })).toBe(false);
    expect(isAgentSessionEgressPreview({ ...preview, token_budget: -1 })).toBe(false);
  });
  it("accepts the create response only for agent_session jobs", () => {
    expect(isAgentSessionCreateResponse({ agent_session_id: "agent_session_1", job })).toBe(true);
    expect(isAgentSessionCreateResponse({ agent_session_id: "agent_session_1", job: { ...job, kind: "timeline_patch_generation" } })).toBe(false);
  });
  it("parses get_session shapes with step details", () => {
    const session = {
      agent_session_id: "agent_session_1", project_id: "project_1", base_revision_id: "timeline_revision_1",
      instruction: "剪短并加字幕", max_steps: 6, status: "succeeded", payload_sha256: hash,
      created_at: now, updated_at: now, finished_at: now,
      steps: [{ ordinal: 1, status: "succeeded", stage: "persisting_step", summary: "ok", error: null, duration_ms: 1200, created_at: now }]
    };
    expect(parseAgentSession(session)).toEqual(session);
    expect(() => parseAgentSession({ ...session, status: "exploded" })).toThrow();
    expect(() => parseAgentSession({ ...session, extra: 1 })).toThrow();
  });
  it("validates the agent_session.updated event envelope", () => {
    expect(isAgentSessionUpdatedEvent({ type: "agent_session.updated", payload: { agent_session_id: "agent_session_1", status: "running", progress: 0.5, step: 2 } })).toBe(true);
    expect(isAgentSessionUpdatedEvent({ type: "job.updated", payload: { agent_session_id: "agent_session_1", status: "running", progress: 0.5 } })).toBe(false);
    expect(isAgentSessionUpdatedEvent({ type: "agent_session.updated", payload: { agent_session_id: "agent_session_1", status: "paused", progress: 0.5 } })).toBe(false);
    expect(isAgentSessionUpdatedEvent({ type: "agent_session.updated" })).toBe(false);
  });
  it("validates the CV analysis summary (nullable counters, closed status set)", () => {
    const summary = { analysis_id: "cv_analysis_1", status: "ready", job_id: "job_1", algorithm_version: "v21", sample_count: 24, scene_cut_count: 5, signals: ["scene_cut", "motion_energy"] };
    expect(isCvAnalysisSummary(summary)).toBe(true);
    expect(isCvAnalysisSummary({ ...summary, status: null, analysis_id: null, job_id: null, sample_count: null, scene_cut_count: null })).toBe(true);
    expect(isCvAnalysisSummary({ ...summary, status: "done" })).toBe(false);
    expect(isCvAnalysisSummary({ ...summary, signals: "scene_cut" })).toBe(false);
    expect(parseCvAnalysisSummary(summary)).toEqual(summary);
  });
});

describe("W2.1 机位同步契约", () => {
  const angle = {
    asset_id: "asset_1", is_reference: false, status: "ready" as const, reason: null,
    offset_us: 687000, confidence: 0.93, source: "auto" as const, stale: false,
    recorded_at: "2026-10-10T00:00:00.000Z"
  };
  const group = {
    group_id: "angle_group_1", project_id: "project_1", name: "双机位",
    reference_asset_id: "asset_ref", algorithm_version: "1",
    angles: [{ ...angle, asset_id: "asset_ref", is_reference: true, offset_us: 0 }, angle],
    created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z"
  };

  it("接受合法机位组，并拒绝版本号类型漂移（P74 教训：契约要 string，Core 出 int 时必须红）", () => {
    expect(isAngleGroup(group)).toBe(true);
    expect(isAngleGroup({ ...group, algorithm_version: 1 })).toBe(false);
    expect(isAngleGroup({ ...group, angles: [] })).toBe(false);
    expect(isAngleGroup({ ...group, angles: [{ ...angle, status: "done" }] })).toBe(false);
    expect(parseAngleGroup(group)).toEqual(group);
  });

  it("缺键即拒绝（JS 侧是 undefined；这是 P74/beat 那一类漂移的运行时锁）", () => {
    const { confidence, ...incomplete } = angle;
    void confidence;
    expect(isAngleGroup({ ...group, angles: [incomplete] })).toBe(false);
  });

  it("同步响应允许 job_id 为 null（幂等短路）", () => {
    expect(parseAngleSyncResponse({ job_id: null, group })).toBeTruthy();
    expect(parseAngleSyncResponse({ job_id: "job_1", group })).toBeTruthy();
    expect(() => parseAngleSyncResponse({ job_id: null, group: { ...group, group_id: "" } })).toThrow();
  });

  it("JobKind 白名单包含 angle_sync", () => {
    expect(isJobKind("angle_sync")).toBe(true);
  });
});

describe("H1 decode capability contracts", () => {
  const row = {
    codec: "hevc" as const,
    webcodecs_supported: true,
    webcodecs_mode: "no-preference" as const,
    ffmpeg_supported: true,
    preferred: "webcodecs" as const,
  };
  it("locks DecodeCapabilityRow / Table shape", () => {
    expect(isDecodeCapabilityRow(row)).toBe(true);
    expect(isDecodeCapabilityRow({ ...row, codec: "vp09" })).toBe(false);
    expect(isDecodeCapabilityRow({ ...row, webcodecs_mode: "prefer-software" })).toBe(false);
    expect(isDecodeCapabilityRow({ ...row, preferred: "gpu" })).toBe(false);
    expect(isDecodeCapabilityTable({ rows: [row], probed_at: now })).toBe(true);
    expect(isDecodeCapabilityTable({ rows: [row], probed_at: "not-a-time" })).toBe(false);
    expect(isDecodeCapabilityTable({ rows: [row], probed_at: now, extra: 1 })).toBe(false);
    expect(parseDecodeCapabilityTable({ rows: [row], probed_at: now })).toEqual({ rows: [row], probed_at: now });
    expect(() => parseDecodeCapabilityTable({ rows: [], probed_at: now, path: "/secret" })).toThrow();
  });
});

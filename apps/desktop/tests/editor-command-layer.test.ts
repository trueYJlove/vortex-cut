import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, TimelineCaption, TimelineClip, TimelineDocument, TimelineState } from "@aivideo/contracts";
import { createPlayheadStore } from "../src/app/timeline/playhead-store.js";
import {
  allCommandDefinitions,
  commandRegistryMap,
  createEditorCommandDispatcher,
  editorCommands,
  isPlainJsonSerializable,
  listMcpToolDescriptors,
  mcpCandidateCommands,
  type ClipboardClipSnapshot,
  type CommandRuntimeContext,
} from "../src/app/editorCommands.js";

const now = "2026-11-26T00:00:00.000Z";

function makeProject(id = "project_1"): Project {
  return {
    project_id: id as Project["project_id"],
    name: "测试项目",
    status: "active",
    canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 },
    root_dir_name: "Demo",
    current_timeline_revision_id: "rev_1",
    created_at: now,
    updated_at: now,
    last_opened_at: now,
  };
}

function makeClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    clip_id: "clip_1" as TimelineClip["clip_id"],
    track_id: "V1",
    order_index: 0,
    asset_id: "asset_video" as TimelineClip["asset_id"],
    asset_kind: "video",
    source_start_us: 0,
    source_end_us: 6_000_000,
    timeline_start_us: 0,
    timeline_end_us: 6_000_000,
    layout: "fit",
    audio: { enabled: true, gain_db: 0 },
    ...overrides,
  };
}

function makeCaption(overrides: Partial<TimelineCaption> = {}): TimelineCaption {
  return {
    caption_id: "caption_1" as TimelineCaption["caption_id"],
    track_id: "C1",
    source_clip_id: null,
    start_us: 0,
    end_us: 2_000_000,
    text: "测试字幕",
    preset_id: "default-bottom",
    origin: "user",
    edited: true,
    source_segment_ids: [],
    ...overrides,
  };
}

function makeTimelineState(docOverrides: Partial<TimelineDocument> = {}, stateOverrides: Partial<TimelineState> = {}): TimelineState {
  const projectId = "project_1" as Project["project_id"];
  const doc: TimelineDocument = {
    schema_version: 1,
    project_id: projectId,
    canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1, background_color: "#000000" },
    tracks: [
      { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
      { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
      { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
    ],
    clips: [makeClip()],
    captions: [makeCaption()],
    provenance: { created_by: "user", source_transcript_ids: [] },
    ...docOverrides,
  };
  return {
    project_id: projectId,
    current_revision: {
      timeline_revision_id: "rev_1" as TimelineState["current_revision"]["timeline_revision_id"],
      project_id: projectId,
      parent_revision_id: null,
      document_sha256: "a".repeat(64),
      summary: "初始状态",
      created_by: "user",
      created_at: now,
      schema_version: 1,
      document: doc,
    },
    draft: null,
    can_undo: true,
    can_redo: true,
    current_preview: null,
    active_transitions: [],
    ...stateOverrides,
  };
}

function makeContext(overrides: Partial<CommandRuntimeContext> = {}): CommandRuntimeContext {
  const timeline = overrides.timeline ?? makeTimelineState();
  const working = overrides.working ?? timeline?.current_revision.document;
  const playheadStore = overrides.playheadStore ?? (() => {
    const store = createPlayheadStore();
    store.set(2_000_000);
    return store;
  })();
  const trackById = overrides.trackById ?? new Map((working?.tracks ?? []).map(t => [t.id, t]));
  const project = "project" in overrides ? overrides.project : makeProject();
  return {
    project,
    isCurrentProject: id => project?.project_id === id,
    timeline,
    working,
    selectedClips: working?.clips.slice(0, 1) ?? [],
    selectedCaption: undefined,
    trackById,
    visualClips: working?.clips ?? [],
    previewAssetMediaUrl: "aivideo://media/test",
    playhead: playheadStore.get(),
    playheadStore,
    clipboardClips: [],
    setClipboardClips: vi.fn(),
    areClipboardAssetsInsertable: () => true,
    undoRedoInFlightRef: { current: false },
    acceptState: vi.fn(),
    clearPendingDraft: vi.fn(),
    setSaveState: vi.fn(),
    handleConflict: vi.fn().mockResolvedValue(undefined),
    showNotice: vi.fn(),
    togglePlayback: vi.fn(),
    exitLibraryPreview: vi.fn(),
    seekFromUser: vi.fn(),
    seekWhileScrubbing: vi.fn(),
    renderDisabledReason: undefined,
    generatePreview: vi.fn().mockResolvedValue({
      ok: true,
      command: "preview.generate",
      data: { reused: false, previewId: "prev_1", jobId: "job_prev_1" },
    }),
    createExport: vi.fn().mockResolvedValue({
      ok: true,
      command: "export.create",
      data: { jobId: "job_exp_1", exportRecordId: "exp_1" },
    }),
    openRenderPanel: vi.fn(),
    openAi: vi.fn().mockResolvedValue(undefined),
    openPatch: vi.fn().mockResolvedValue(undefined),
    openProjectManager: vi.fn(),
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    resetLayout: vi.fn(),
    openShortcuts: vi.fn(),
    openRevisionCompare: vi.fn().mockResolvedValue(undefined),
    openShotRequirements: vi.fn(),
    openGeneration: vi.fn(),
    openImageGeneration: vi.fn(),
    openCommandSearch: vi.fn(),
    ...overrides,
  };
}

describe("Editor Command Layer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    (window as unknown as { desktop: Record<string, unknown> }).desktop = {
      patchTimeline: vi.fn().mockResolvedValue(makeTimelineState({}, {
        current_revision: {
          ...makeTimelineState().current_revision,
          timeline_revision_id: "rev_2" as never,
        },
      })),
      createTimeline: vi.fn().mockResolvedValue(makeTimelineState()),
      undoTimeline: vi.fn().mockResolvedValue(makeTimelineState({}, {
        current_revision: {
          ...makeTimelineState().current_revision,
          timeline_revision_id: "rev_0" as never,
        },
      })),
      redoTimeline: vi.fn().mockResolvedValue(makeTimelineState({}, {
        current_revision: {
          ...makeTimelineState().current_revision,
          timeline_revision_id: "rev_2" as never,
        },
      })),
    };
  });

  it("exposes unique IDs, valid JSON schemas, and MCP tool descriptors", () => {
    const ids = allCommandDefinitions.map(cmd => cmd.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cmd of allCommandDefinitions) {
      expect(commandRegistryMap.get(cmd.id)).toBe(cmd);
      expect(cmd.inputSchema.type).toBe("object");
      expect(cmd.description.trim().length).toBeGreaterThan(0);
    }

    const mcpTools = listMcpToolDescriptors();
    expect(mcpTools.length).toBe(mcpCandidateCommands.length);
    expect(mcpTools.map(tool => tool.commandId)).toEqual(
      expect.arrayContaining([
        "timeline.patch",
        "timeline.create",
        "timeline.undo",
        "timeline.redo",
        "timeline.split",
        "timeline.copy",
        "timeline.cut",
        "timeline.paste",
        "timeline.delete",
        "timeline.addCaption",
        "timeline.importCaptions",
        "playback.seek",
        "playback.stepFrames",
        "preview.generate",
        "export.create",
      ]),
    );
    for (const tool of mcpTools) {
      expect(tool.name).toMatch(/^vortex_[a-zA-Z0-9_]+$/);
      expect(tool.inputSchema.type).toBe("object");
    }

    // UI registry preserves compatibility with menu/command palette entries
    expect(editorCommands.length).toBeGreaterThanOrEqual(23);
  });

  it("rejects non-JSON-serializable payloads (DOM nodes, functions, Events, NaN)", async () => {
    const ctx = makeContext();
    const dispatcher = createEditorCommandDispatcher(() => ctx);

    expect(isPlainJsonSerializable({ a: 1, b: [true, "x", null] })).toBe(true);
    expect(isPlainJsonSerializable({ fn: () => {} })).toBe(false);
    expect(isPlainJsonSerializable({ badNum: Number.NaN })).toBe(false);
    expect(isPlainJsonSerializable({ node: document.createElement("div") })).toBe(false);
    expect(isPlainJsonSerializable({ evt: new Event("click") })).toBe(false);

    const domRes = await dispatcher.dispatch("timeline.patch", {
      operations: [],
      summary: "bad",
      node: document.createElement("button"),
    } as unknown as Record<string, unknown>);
    expect(domRes).toEqual({
      ok: false,
      command: "timeline.patch",
      code: "INVALID_PAYLOAD",
      message: expect.any(String),
    });

    const fnRes = await dispatcher.dispatch("playback.seek", {
      timeUs: 1000,
      callback: () => {},
    } as unknown as Record<string, unknown>);
    expect(fnRes.ok).toBe(false);
    if (!fnRes.ok) expect(fnRes.code).toBe("INVALID_PAYLOAD");
  });

  it("handles timeline.patch success, conflict (409), and mid-flight project switch cancellation", async () => {
    const ctx = makeContext();
    const dispatcher = createEditorCommandDispatcher(() => ctx);

    const okRes = await dispatcher.dispatch<{ revisionId: string; operationCount: number }>("timeline.patch", {
      operations: [{ op: "remove_caption", caption_id: "caption_1" }],
      summary: "删除字幕",
    });
    expect(okRes).toEqual({
      ok: true,
      command: "timeline.patch",
      data: { revisionId: "rev_2", operationCount: 1 },
    });
    expect(ctx.clearPendingDraft).toHaveBeenCalledTimes(1);
    expect(ctx.acceptState).toHaveBeenCalledTimes(1);
    expect(ctx.setSaveState).toHaveBeenLastCalledWith("已保存");

    // Empty operations -> INVALID_PAYLOAD
    const invalidRes = await dispatcher.dispatch("timeline.patch", {
      operations: [],
      summary: "",
    });
    expect(invalidRes.ok).toBe(false);
    if (!invalidRes.ok) expect(invalidRes.code).toBe("INVALID_PAYLOAD");

    // Conflict handling
    (window.desktop.patchTimeline as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("409 TIMELINE_CONFLICT"));
    const conflictRes = await dispatcher.dispatch("timeline.patch", {
      operations: [{ op: "remove_caption", caption_id: "caption_1" }],
      summary: "冲突操作",
    });
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) {
      expect(conflictRes.code).toBe("CONFLICT");
      expect(conflictRes.retryable).toBe(true);
    }
    expect(ctx.handleConflict).toHaveBeenCalledTimes(1);

    // Mid-flight project switch -> CANCELLED, no acceptState
    const switchedCtx = makeContext({ isCurrentProject: () => false });
    const switchedDispatcher = createEditorCommandDispatcher(() => switchedCtx);
    const cancelRes = await switchedDispatcher.dispatch("timeline.patch", {
      operations: [{ op: "remove_caption", caption_id: "caption_1" }],
      summary: "切换取消",
    });
    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) expect(cancelRes.code).toBe("CANCELLED");
    expect(switchedCtx.acceptState).not.toHaveBeenCalled();
  });

  it("supports timeline.create and undo/redo in-flight protection", async () => {
    const createdState = makeTimelineState();
    (window.desktop.createTimeline as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdState);

    const noTimelineCtx = makeContext({ timeline: undefined, working: undefined, selectedClips: [], visualClips: [] });
    const dispatcher = createEditorCommandDispatcher(() => noTimelineCtx);
    const createRes = await dispatcher.dispatch<{ projectId: string; revisionId: string; timelineState: TimelineState }>(
      "timeline.create",
      { source: { kind: "empty" } },
    );
    expect(createRes).toEqual({
      ok: true,
      command: "timeline.create",
      data: { projectId: "project_1", revisionId: "rev_1", timelineState: createdState },
    });
    expect(noTimelineCtx.acceptState).toHaveBeenCalledWith(createdState);

    const undoCtx = makeContext();
    const undoDispatcher = createEditorCommandDispatcher(() => undoCtx);
    const undoRes = await undoDispatcher.dispatch<{ revisionId: string }>("timeline.undo", {});
    expect(undoRes).toEqual({ ok: true, command: "timeline.undo", data: { revisionId: "rev_0" } });

    const redoRes = await undoDispatcher.dispatch<{ revisionId: string }>("timeline.redo", {});
    expect(redoRes).toEqual({ ok: true, command: "timeline.redo", data: { revisionId: "rev_2" } });

    // Double-press guard when disabledReason passes but ref is true
    let release!: () => void;
    (window.desktop.undoTimeline as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<TimelineState>(resolve => {
        release = () => resolve(createdState);
      }),
    );
    const firstPending = undoDispatcher.dispatch("timeline.undo", {});
    const secondImmediate = await undoDispatcher.dispatch("timeline.undo", {});
    expect(secondImmediate.ok).toBe(false);
    if (!secondImmediate.ok) expect(secondImmediate.code).toBe("IN_FLIGHT");
    release();
    await firstPending;
  });

  it("routes split, copy, cut, paste, and delete (standard + ripple) with structured checks", async () => {
    const clipboard: ClipboardClipSnapshot[] = [];
    const ctx = makeContext({
      clipboardClips: clipboard,
      setClipboardClips: next => {
        clipboard.splice(0, clipboard.length, ...next);
      },
    });
    const dispatcher = createEditorCommandDispatcher(() => ctx);

    // split at playhead 2_000_000
    const splitRes = await dispatcher.dispatch<{ revisionId: string; operationCount: number }>("timeline.split", {});
    expect(splitRes.ok).toBe(true);
    expect(window.desktop.patchTimeline).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        summary: "在播放头处拆分",
        operations: [expect.objectContaining({ op: "split_clip", clip_id: "clip_1", source_time_us: 2_000_000 })],
      }),
    }));

    // copy then paste
    const copyRes = await dispatcher.dispatch<{ count: number }>("timeline.copy", {});
    expect(copyRes).toEqual({
      ok: true,
      command: "timeline.copy",
      data: expect.objectContaining({ count: 1 }),
    });
    expect(clipboard).toHaveLength(1);

    const pasteRes = await dispatcher.dispatch<{ count: number; atIndex: number }>("timeline.paste", { timeUs: 0 });
    expect(pasteRes).toEqual({
      ok: true,
      command: "timeline.paste",
      data: { count: 1, atIndex: 1, revisionId: "rev_2" },
    });

    // empty clipboard paste disabled
    clipboard.length = 0;
    const disabledPaste = await dispatcher.dispatch("timeline.paste", {});
    expect(disabledPaste.ok).toBe(false);
    if (!disabledPaste.ok) expect(disabledPaste.code).toBe("COMMAND_DISABLED");

    // cut rejects linked clip
    const linkedDoc = makeTimelineState({
      clips: [makeClip({ link_group_id: "link_1" as TimelineClip["link_group_id"] })],
    });
    const linkedCtx = makeContext({ timeline: linkedDoc, working: linkedDoc.current_revision.document });
    const linkedDispatcher = createEditorCommandDispatcher(() => linkedCtx);
    const linkedCutRes = await linkedDispatcher.dispatch("timeline.cut", {});
    expect(linkedCutRes.ok).toBe(false);
    if (!linkedCutRes.ok) expect(linkedCutRes.code).toBe("LINKED_CLIP_UNSUPPORTED");

    // standard delete + ripple delete
    const delRes = await dispatcher.dispatch<{ deletedCount: number; mode: string; revisionId?: string }>("timeline.delete", { mode: "standard" });
    expect(delRes.ok).toBe(true);
    if (delRes.ok) {
      expect(delRes.command).toBe("timeline.delete");
      expect(delRes.data.mode).toBe("standard");
      expect(delRes.data.deletedCount).toBeGreaterThanOrEqual(1);
      expect(delRes.data.revisionId).toBe("rev_2");
    }

    const rippleRes = await dispatcher.dispatch<{ deletedCount: number; mode: string; revisionId?: string }>("timeline.delete", { mode: "ripple" });
    expect(rippleRes.ok).toBe(true);
    if (rippleRes.ok) {
      expect(rippleRes.command).toBe("timeline.delete");
      expect(rippleRes.data.mode).toBe("ripple");
      expect(rippleRes.data.deletedCount).toBeGreaterThanOrEqual(1);
      expect(rippleRes.data.revisionId).toBe("rev_2");
    }
  });

  it("handles addCaption validation, importCaptions, playback seek/stepFrames, and render commands", async () => {
    const ctx = makeContext();
    const dispatcher = createEditorCommandDispatcher(() => ctx);

    const badCaption = await dispatcher.dispatch("timeline.addCaption", { startUs: 2_000_000, endUs: 1_000_000 });
    expect(badCaption.ok).toBe(false);
    if (!badCaption.ok) expect(badCaption.code).toBe("INVALID_PAYLOAD");

    const okCaption = await dispatcher.dispatch<{ startUs: number; endUs: number }>("timeline.addCaption", {
      startUs: 500_000,
      endUs: 1_500_000,
      text: "自定义字幕",
    });
    expect(okCaption).toEqual({
      ok: true,
      command: "timeline.addCaption",
      data: { revisionId: "rev_2", startUs: 500_000, endUs: 1_500_000 },
    });

    const importRes = await dispatcher.dispatch<{ count: number }>("timeline.importCaptions", {
      fileName: "demo.srt",
      entries: [{ start_us: 0, end_us: 1_000_000, text: "第一行" }],
    });
    expect(importRes).toEqual({
      ok: true,
      command: "timeline.importCaptions",
      data: { revisionId: "rev_2", count: 1 },
    });

    // Seek clamping & commit flag
    const seekCommit = await dispatcher.dispatch<{ timeUs: number; committed: boolean }>("playback.seek", {
      timeUs: 99_000_000,
    });
    expect(seekCommit).toEqual({ ok: true, command: "playback.seek", data: { timeUs: 6_000_000, committed: true } });
    expect(ctx.seekFromUser).toHaveBeenCalledWith(6_000_000);

    const seekScrub = await dispatcher.dispatch<{ timeUs: number; committed: boolean }>("playback.seek", {
      timeUs: 1_000_000,
      commit: false,
    });
    expect(seekScrub).toEqual({ ok: true, command: "playback.seek", data: { timeUs: 1_000_000, committed: false } });
    expect(ctx.seekWhileScrubbing).toHaveBeenCalledWith(1_000_000);

    // Step frames (+1 frame @ 30fps = 33_333 us from 2_000_000)
    const stepRes = await dispatcher.dispatch<{ timeUs: number; frames: number }>("playback.stepFrames", { frames: 1 });
    expect(stepRes).toEqual({
      ok: true,
      command: "playback.stepFrames",
      data: { timeUs: 2_033_333, frames: 1 },
    });

    // Render commands pass structured options & enforce renderDisabledReason
    const prevRes = await dispatcher.dispatch("preview.generate", { encoderMode: "software", outputRatio: "916" });
    expect(prevRes.ok).toBe(true);
    expect(ctx.generatePreview).toHaveBeenCalledWith({ encoderMode: "software", outputRatio: "916" });

    const expRes = await dispatcher.dispatch("export.create", { destinationGrantId: "grant_1", quality: "high" });
    expect(expRes.ok).toBe(true);
    expect(ctx.createExport).toHaveBeenCalledWith({ destinationGrantId: "grant_1", quality: "high" });

    const blockedCtx = makeContext({ renderDisabledReason: "空时间线不可导出" });
    const blockedDispatcher = createEditorCommandDispatcher(() => blockedCtx);
    const blockedExp = await blockedDispatcher.dispatch("export.create", {});
    expect(blockedExp).toEqual({
      ok: false,
      command: "export.create",
      code: "COMMAND_DISABLED",
      message: "空时间线不可导出",
    });
  });
});

import type { TimelineClip, TimelinePatchOperation, TimelineState } from "@aivideo/contracts";
import { duration } from "../appHelpers.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";
import { removeLinkedClips } from "../timeline/linked-clips.js";
import { planMagneticDelete, planRippleDelete, readTimelineBehaviorPrefs } from "../timeline/magnetic-plan.js";
import { splitSelectionAt } from "../timeline/split-point.js";
import type {
  ClipboardClipSnapshot,
  CommandDefinition,
  CommandResult,
  CommandRuntimeContext,
  TimelineAddCaptionPayload,
  TimelineCopyPayload,
  TimelineCreatePayload,
  TimelineCutPayload,
  TimelineDeletePayload,
  TimelineImportCaptionsPayload,
  TimelinePatchPayload,
  TimelinePastePayload,
  TimelineRevisionStepPayload,
  TimelineSplitPayload,
} from "./types.js";

function fail(
  command: string,
  code: Extract<CommandResult, { ok: false }>["code"],
  message: string,
  retryable = false,
): CommandResult<never> {
  return { ok: false, command, code, message, ...(retryable ? { retryable: true } : {}) };
}

function resolveTargetClips(ctx: CommandRuntimeContext, clipIds?: string[]): TimelineClip[] {
  if (!Array.isArray(clipIds) || clipIds.length === 0) return ctx.selectedClips;
  const idSet = new Set(clipIds);
  return (ctx.working?.clips ?? []).filter(clip => idSet.has(clip.clip_id));
}

function isTimelineConflictError(error: unknown): boolean {
  const text = errorCode(error);
  return text.includes("TIMELINE_CONFLICT") || text.includes("TIMELINE_DRAFT_CONFLICT") || text.includes("409");
}

export async function executeTimelinePatch(
  ctx: CommandRuntimeContext,
  payload: TimelinePatchPayload,
): Promise<CommandResult<{ revisionId: string; operationCount: number }>> {
  const command = "timeline.patch";
  if (!ctx.project) return fail(command, "PROJECT_REQUIRED", "需要项目");
  const base = ctx.timeline;
  if (!base && !payload.baseRevisionId) return fail(command, "TIMELINE_REQUIRED", "需要时间线");
  if (!Array.isArray(payload.operations) || payload.operations.length === 0 || !payload.summary?.trim()) {
    return fail(command, "INVALID_PAYLOAD", "缺少有效的时间线修改操作或摘要");
  }

  const projectId = ctx.project.project_id;
  const baseRevisionId = (payload.baseRevisionId ?? base!.current_revision.timeline_revision_id) as NonNullable<typeof base>["current_revision"]["timeline_revision_id"];
  ctx.setSaveState("保存中");
  try {
    const next = await window.desktop.patchTimeline({
      project_id: projectId,
      patch: {
        schema_version: 1,
        base_revision_id: baseRevisionId,
        operations: payload.operations,
        summary: payload.summary,
      },
    });
    if (!ctx.isCurrentProject(projectId)) {
      return fail(command, "CANCELLED", "项目已切换");
    }
    ctx.clearPendingDraft();
    ctx.acceptState(next);
    ctx.setSaveState("已保存");
    return {
      ok: true,
      command,
      data: {
        revisionId: next.current_revision.timeline_revision_id,
        operationCount: payload.operations.length,
      },
    };
  } catch (error) {
    if (ctx.isCurrentProject(projectId)) {
      await ctx.handleConflict(error);
    }
    const isConflict = isTimelineConflictError(error);
    return fail(
      command,
      isConflict ? "CONFLICT" : "EXECUTION_FAILED",
      safeErrorMessage(error, isConflict ? "时间线版本冲突，已刷新" : "时间线修改失败"),
      isConflict,
    );
  }
}

export const timelinePatchCommand: CommandDefinition<TimelinePatchPayload, { revisionId: string; operationCount: number }> = {
  id: "timeline.patch",
  label: "应用时间线修改",
  description: "以结构化 TimelinePatchOperation 数组原子提交时间线修改并生成新 Revision。",
  scopes: ["timeline"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "符合 Core TimelinePatchOperation 契约的原子操作列表（1–100 条）",
        items: { type: "object", description: "单个 TimelinePatchOperation 对象（含 op 与对应参数）" },
      },
      summary: { type: "string", description: "变更摘要，写入 Revision 历史" },
      baseRevisionId: { type: "string", description: "可选基线 Revision ID，缺省使用当前时间线 Revision" },
    },
    required: ["operations", "summary"],
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.project && ctx.timeline ? undefined : "需要项目和时间线"),
  execute: executeTimelinePatch,
};

export const timelineCreateCommand: CommandDefinition<TimelineCreatePayload, { projectId: string; revisionId: string; timelineState: TimelineState }> = {
  id: "timeline.create",
  label: "创建空时间线",
  description: "为当前项目创建初始时间线（默认空时间线，也可传入整素材/转录选段源）。",
  scopes: ["global"],
  group: "时间线",
  shortcut: "Ctrl+N",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "object",
        description: "可选创建时间线数据源，默认 { kind: 'empty' }",
      },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.project ? (ctx.timeline ? "时间线已存在" : undefined) : "需要项目"),
  async execute(ctx, payload) {
    if (!ctx.project) return fail("timeline.create", "PROJECT_REQUIRED", "需要项目");
    const projectId = ctx.project.project_id;
    ctx.setSaveState("保存中");
    try {
      const created = await window.desktop.createTimeline({
        project_id: projectId,
        timeline: {
          schema_version: 1,
          source: payload?.source ?? { kind: "empty" },
          default_layout: "blurred_background",
          caption_preset_id: "default-bottom",
        },
      });
      if (!ctx.isCurrentProject(projectId)) {
        return fail("timeline.create", "CANCELLED", "项目已切换");
      }
      ctx.acceptState(created);
      return {
        ok: true,
        command: "timeline.create",
        data: {
          projectId,
          revisionId: created.current_revision.timeline_revision_id,
          timelineState: created,
        },
      };
    } catch (error) {
      if (ctx.isCurrentProject(projectId)) await ctx.handleConflict(error);
      return fail("timeline.create", "EXECUTION_FAILED", safeErrorMessage(error, "创建时间线失败"));
    }
  },
};

async function executeUndoRedo(
  ctx: CommandRuntimeContext,
  kind: "undo" | "redo",
  payload?: TimelineRevisionStepPayload,
): Promise<CommandResult<{ revisionId: string }>> {
  const command = kind === "undo" ? "timeline.undo" : "timeline.redo";
  if (ctx.undoRedoInFlightRef.current) return fail(command, "IN_FLIGHT", "撤销/重做正在执行中", true);
  if (!ctx.project) return fail(command, "PROJECT_REQUIRED", "需要项目");
  if (!ctx.timeline) return fail(command, "TIMELINE_REQUIRED", "需要时间线");
  const projectId = ctx.project.project_id;
  const baseRevisionId = (payload?.baseRevisionId ?? ctx.timeline.current_revision.timeline_revision_id) as typeof ctx.timeline.current_revision.timeline_revision_id;
  ctx.undoRedoInFlightRef.current = true;
  ctx.setSaveState("保存中");
  try {
    const next = await window.desktop[kind === "undo" ? "undoTimeline" : "redoTimeline"]({
      project_id: projectId,
      base_revision_id: baseRevisionId,
    });
    if (!ctx.isCurrentProject(projectId)) {
      return fail(command, "CANCELLED", "项目已切换");
    }
    ctx.acceptState(next);
    return { ok: true, command, data: { revisionId: next.current_revision.timeline_revision_id } };
  } catch (error) {
    if (ctx.isCurrentProject(projectId)) await ctx.handleConflict(error);
    const isConflict = isTimelineConflictError(error);
    const fallback = isConflict
      ? (kind === "undo" ? "时间线版本冲突，撤销失败" : "时间线版本冲突，重做失败")
      : (kind === "undo" ? "撤销失败" : "重做失败");
    return fail(
      command,
      isConflict ? "CONFLICT" : "EXECUTION_FAILED",
      safeErrorMessage(error, fallback),
      isConflict,
    );
  } finally {
    ctx.undoRedoInFlightRef.current = false;
  }
}

export const timelineUndoCommand: CommandDefinition<TimelineRevisionStepPayload, { revisionId: string }> = {
  id: "timeline.undo",
  label: "撤销",
  description: "基于服务端 Revision 回退上一步已提交的时间线操作。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+Z",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      baseRevisionId: { type: "string", description: "可选基线 Revision ID，缺省读取当前 Revision" },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.timeline?.can_undo ? undefined : "没有可撤销的操作"),
  execute: (ctx, payload) => executeUndoRedo(ctx, "undo", payload),
};

export const timelineRedoCommand: CommandDefinition<TimelineRevisionStepPayload, { revisionId: string }> = {
  id: "timeline.redo",
  label: "重做",
  description: "基于服务端 Revision 重做下一步时间线操作。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+Shift+Z / Ctrl+Y",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      baseRevisionId: { type: "string", description: "可选基线 Revision ID，缺省读取当前 Revision" },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.timeline?.can_redo ? undefined : "没有可重做的操作"),
  execute: (ctx, payload) => executeUndoRedo(ctx, "redo", payload),
};

export const timelineSplitCommand: CommandDefinition<TimelineSplitPayload, { revisionId: string; operationCount: number }> = {
  id: "timeline.split",
  label: "拆分所选片段",
  description: "在指定时间或当前播放头处将所选视频片段拆分为两段。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+B",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      clipIds: { type: "array", description: "待拆分片段 ID 列表，缺省使用当前选区", items: { type: "string", description: "片段 ID" } },
      timeUs: { type: "integer", description: "拆分时间点（微秒），缺省使用当前播放头" },
    },
    additionalProperties: false,
  },
  disabledReason: (ctx, payload) => {
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    if (!targetClips.length) return "请先选择时间线片段";
    const timeUs = typeof payload?.timeUs === "number" && Number.isFinite(payload.timeUs)
      ? payload.timeUs
      : ctx.playheadStore.get();
    return splitSelectionAt(targetClips, timeUs, ctx.working).length
      ? undefined
      : "请把播放头移到可拆分的选中视频片段内";
  },
  async execute(ctx, payload) {
    if (!ctx.project || !ctx.timeline) {
      return fail("timeline.split", ctx.project ? "TIMELINE_REQUIRED" : "PROJECT_REQUIRED", "需要项目和时间线");
    }
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    const timeUs = typeof payload?.timeUs === "number" ? payload.timeUs : ctx.playheadStore.get();
    const operations = splitSelectionAt(targetClips, timeUs, ctx.working);
    if (!operations.length) {
      return fail("timeline.split", "COMMAND_DISABLED", "请把播放头移到可拆分的选中视频片段内");
    }
    const res = await executeTimelinePatch(ctx, { operations, summary: "在播放头处拆分" });
    if (!res.ok) return { ...res, command: "timeline.split" };
    return { ok: true, command: "timeline.split", data: res.data };
  },
};

function snapshotVisualClips(ctx: CommandRuntimeContext, clips: TimelineClip[]): ClipboardClipSnapshot[] {
  return clips
    .filter(item => (item.asset_kind === "video" || item.asset_kind === "image") && ctx.trackById.get(item.track_id)?.kind === "video")
    .map(item => ({
      asset_id: item.asset_id,
      asset_kind: item.asset_kind as "video" | "image",
      source_start_us: item.source_start_us,
      source_end_us: item.source_end_us,
      speed_milli: item.speed_milli ?? 1000,
      reverse_playback: item.reverse_playback ?? false,
      layout: item.layout,
    }));
}

export const timelineCopyCommand: CommandDefinition<TimelineCopyPayload, { count: number; items: ClipboardClipSnapshot[] }> = {
  id: "timeline.copy",
  label: "复制所选片段",
  description: "将所选视觉轨片段快照复制到应用内剪贴板。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+C",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      clipIds: { type: "array", description: "待复制片段 ID 列表，缺省使用当前选区", items: { type: "string", description: "片段 ID" } },
    },
    additionalProperties: false,
  },
  disabledReason: (ctx, payload) => {
    if (!ctx.timeline) return "需要时间线";
    if (resolveTargetClips(ctx, payload?.clipIds).length === 0) return "请先选择要复制的片段";
    return undefined;
  },
  execute(ctx, payload) {
    if (!ctx.timeline) return fail("timeline.copy", "TIMELINE_REQUIRED", "需要时间线");
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    if (!targetClips.length) return fail("timeline.copy", "SELECTION_EMPTY", "请先选择要复制的片段");
    const snapshot = snapshotVisualClips(ctx, targetClips);
    ctx.setClipboardClips(snapshot);
    if (snapshot.length) ctx.showNotice(`已复制 ${snapshot.length} 个片段（应用内剪贴板）。`, "info");
    return { ok: true, command: "timeline.copy", data: { count: snapshot.length, items: snapshot } };
  },
};

export const timelineCutCommand: CommandDefinition<TimelineCutPayload, { count: number; deletedOperations: number; revisionId?: string }> = {
  id: "timeline.cut",
  label: "剪切所选片段",
  description: "复制非链接/非锁定视觉轨片段并从时间线移除。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+X",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      clipIds: { type: "array", description: "待剪切片段 ID 列表，缺省使用当前选区", items: { type: "string", description: "片段 ID" } },
    },
    additionalProperties: false,
  },
  disabledReason: (ctx, payload) => {
    if (!ctx.timeline) return "需要时间线";
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    if (targetClips.length === 0 && !ctx.selectedCaption) return "请先选择要剪切的片段";
    return undefined;
  },
  async execute(ctx, payload) {
    if (!ctx.timeline) return fail("timeline.cut", "TIMELINE_REQUIRED", "需要时间线");
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    if (targetClips.length === 0 && !ctx.selectedCaption) {
      return fail("timeline.cut", "SELECTION_EMPTY", "请先选择要剪切的片段");
    }
    if (targetClips.some(item => item.link_group_id)) {
      ctx.showNotice("链接片段暂不支持剪切粘贴，请先取消链接。", "info");
      return fail("timeline.cut", "LINKED_CLIP_UNSUPPORTED", "链接片段暂不支持剪切粘贴，请先取消链接。");
    }
    const unlockedVisual = targetClips.filter(
      item => (item.asset_kind === "video" || item.asset_kind === "image")
        && ctx.trackById.get(item.track_id)?.kind === "video"
        && !ctx.working?.locked_elements?.includes(item.clip_id),
    );
    const snapshot = snapshotVisualClips(ctx, unlockedVisual);
    const prefs = readTimelineBehaviorPrefs();
    const cutPlan = prefs.mainTrackMagnet && ctx.working && targetClips.some(clip => clip.track_id === "V1")
      ? planMagneticDelete(ctx.working, targetClips, prefs.linkageEnabled)
      : { operations: removeLinkedClips(targetClips, ctx.working) };
    const deletable = cutPlan.operations;
    if (!deletable.length) {
      if (cutPlan.reason) ctx.showNotice(cutPlan.reason, "info");
      return fail("timeline.cut", "CLIP_LOCKED", cutPlan.reason ?? "所选片段无法剪切");
    }
    ctx.setClipboardClips(snapshot);
    const res = await executeTimelinePatch(ctx, {
      operations: deletable,
      summary: prefs.mainTrackMagnet ? "主轨磁吸剪切" : "剪切片段",
    });
    if (!res.ok) return { ...res, command: "timeline.cut" };
    ctx.showNotice(`已剪切 ${deletable.length} 组片段（Ctrl+V 粘贴）。`);
    return {
      ok: true,
      command: "timeline.cut",
      data: { count: snapshot.length, deletedOperations: deletable.length, revisionId: res.data.revisionId },
    };
  },
};

export const timelinePasteCommand: CommandDefinition<TimelinePastePayload, { count: number; atIndex: number; revisionId: string }> = {
  id: "timeline.paste",
  label: "粘贴片段",
  description: "将应用内剪贴板中的片段粘贴到指定时间或播放头位置。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Ctrl+V",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      timeUs: { type: "integer", description: "粘贴时间位置（微秒），缺省使用当前播放头" },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => {
    if (!ctx.clipboardClips.length) return "剪贴板为空，请先复制片段";
    if (!ctx.project || !ctx.timeline) return "需要项目和时间线";
    return ctx.areClipboardAssetsInsertable(ctx.clipboardClips) ? undefined : "部分素材不可用或类型不支持粘贴";
  },
  async execute(ctx, payload) {
    if (!ctx.clipboardClips.length) return fail("timeline.paste", "EMPTY_CLIPBOARD", "剪贴板为空，请先复制片段");
    if (!ctx.project || !ctx.timeline) return fail("timeline.paste", "TIMELINE_REQUIRED", "需要项目和时间线");
    if (!ctx.areClipboardAssetsInsertable(ctx.clipboardClips)) {
      return fail("timeline.paste", "ASSET_UNAVAILABLE", "部分素材不可用或类型不支持粘贴");
    }
    if (payload?.timeUs !== undefined && (typeof payload.timeUs !== "number" || !Number.isFinite(payload.timeUs) || payload.timeUs < 0)) {
      return fail("timeline.paste", "INVALID_PAYLOAD", "timeUs 必须为非负有限数值");
    }
    const targetUs = payload?.timeUs ?? ctx.playheadStore.get();
    const atHead = ctx.visualClips.findIndex(c => targetUs >= c.timeline_start_us && targetUs < c.timeline_end_us);
    const pasteIndex = atHead >= 0
      ? atHead + 1
      : Math.min(ctx.visualClips.filter(c => c.timeline_end_us <= targetUs).length, ctx.visualClips.length);
    let cursor = pasteIndex;
    const operations: TimelinePatchOperation[] = ctx.clipboardClips.map(snapshot => ({
      op: "insert_asset_clip",
      asset_id: snapshot.asset_id,
      at_index: cursor++,
      ...(snapshot.asset_kind === "image"
        ? { duration_us: 3_000_000 }
        : {
            source_start_us: snapshot.source_start_us ?? undefined,
            source_end_us: snapshot.source_end_us ?? undefined,
            speed_milli: snapshot.speed_milli !== 1000 ? snapshot.speed_milli : undefined,
            reverse_playback: snapshot.reverse_playback || undefined,
          }),
    }));
    const res = await executeTimelinePatch(ctx, { operations, summary: "粘贴片段" });
    if (!res.ok) return { ...res, command: "timeline.paste" };
    ctx.showNotice("已粘贴到播放头位置。", "success");
    return {
      ok: true,
      command: "timeline.paste",
      data: { count: operations.length, atIndex: pasteIndex, revisionId: res.data.revisionId },
    };
  },
};

export const timelineDeleteCommand: CommandDefinition<TimelineDeletePayload, { deletedCount: number; mode: "standard" | "ripple"; revisionId?: string }> = {
  id: "timeline.delete",
  label: "删除所选对象",
  description: "删除所选时间线片段（支持标准/主轨磁吸或波纹删除）或字幕。",
  scopes: ["timeline"],
  group: "编辑",
  shortcut: "Delete / Backspace",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      clipIds: { type: "array", description: "待删除片段 ID 列表，缺省使用当前选区", items: { type: "string", description: "片段 ID" } },
      captionId: { type: "string", description: "待删除字幕 ID，缺省使用当前选定字幕" },
      mode: { type: "string", description: "删除模式：standard 或 ripple（波纹删除）", enum: ["standard", "ripple"] },
    },
    additionalProperties: false,
  },
  disabledReason: (ctx, payload) => {
    if (!ctx.timeline) return "需要时间线";
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);
    const targetCaptionId = payload?.captionId ?? ctx.selectedCaption?.caption_id;
    if (targetClips.length === 0 && !targetCaptionId) return "请先选择要删除的对象";
    return undefined;
  },
  async execute(ctx, payload) {
    if (!ctx.timeline) return fail("timeline.delete", "TIMELINE_REQUIRED", "需要时间线");
    const mode = payload?.mode ?? "standard";
    const targetCaptionId = (payload?.captionId ?? ctx.selectedCaption?.caption_id) as NonNullable<typeof ctx.selectedCaption>["caption_id"] | undefined;
    const targetClips = resolveTargetClips(ctx, payload?.clipIds);

    if (mode === "ripple") {
      if (!ctx.working) return fail("timeline.delete", "TIMELINE_REQUIRED", "需要时间线");
      const plan = planRippleDelete(ctx.working, targetClips, readTimelineBehaviorPrefs().linkageEnabled);
      if (!plan.operations.length) {
        if (plan.reason) ctx.showNotice(plan.reason, "info");
        return fail("timeline.delete", "CLIP_LOCKED", plan.reason ?? "没有可波纹删除的对象");
      }
      const res = await executeTimelinePatch(ctx, { operations: plan.operations, summary: "波纹删除" });
      if (!res.ok) return { ...res, command: "timeline.delete" };
      return {
        ok: true,
        command: "timeline.delete",
        data: { deletedCount: plan.operations.length, mode: "ripple", revisionId: res.data.revisionId },
      };
    }

    if (targetCaptionId && (!payload?.clipIds || payload.clipIds.length === 0)) {
      const res = await executeTimelinePatch(ctx, {
        operations: [{ op: "remove_caption", caption_id: targetCaptionId }],
        summary: "删除字幕",
      });
      if (!res.ok) return { ...res, command: "timeline.delete" };
      return { ok: true, command: "timeline.delete", data: { deletedCount: 1, mode: "standard", revisionId: res.data.revisionId } };
    }

    if (targetClips.length > 0) {
      const prefs = readTimelineBehaviorPrefs();
      const plan = prefs.mainTrackMagnet && ctx.working && targetClips.some(clip => clip.track_id === "V1")
        ? planMagneticDelete(ctx.working, targetClips, prefs.linkageEnabled)
        : { operations: removeLinkedClips(targetClips, ctx.working) };
      if (!plan.operations.length) {
        if (plan.reason) ctx.showNotice(plan.reason, "info");
        return fail("timeline.delete", "CLIP_LOCKED", plan.reason ?? "没有可删除的对象");
      }
      const res = await executeTimelinePatch(ctx, {
        operations: plan.operations,
        summary: prefs.mainTrackMagnet ? "主轨磁吸删除" : "删除片段",
      });
      if (!res.ok) return { ...res, command: "timeline.delete" };
      return {
        ok: true,
        command: "timeline.delete",
        data: { deletedCount: plan.operations.length, mode: "standard", revisionId: res.data.revisionId },
      };
    }

    return fail("timeline.delete", "SELECTION_EMPTY", "请先选择要删除的对象");
  },
};

export const timelineAddCaptionCommand: CommandDefinition<TimelineAddCaptionPayload, { revisionId: string; startUs: number; endUs: number }> = {
  id: "timeline.addCaption",
  label: "添加字幕",
  description: "在指定区间（默认当前播放头起 3 秒）添加一条手工字幕。",
  scopes: ["caption", "timeline"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      startUs: { type: "integer", description: "起始时间（微秒），缺省为当前播放头" },
      endUs: { type: "integer", description: "结束时间（微秒），缺省为 startUs + 3_000_000" },
      text: { type: "string", description: "字幕正文，默认「默认文本」" },
      presetId: { type: "string", description: "字幕样式预设 ID，默认 default-bottom" },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.project && ctx.timeline ? undefined : "需要项目和时间线"),
  async execute(ctx, payload) {
    if (!ctx.project) return fail("timeline.addCaption", "PROJECT_REQUIRED", "需要项目");
    if (!ctx.timeline) return fail("timeline.addCaption", "TIMELINE_REQUIRED", "需要时间线");
    if (
      (payload?.startUs !== undefined && (typeof payload.startUs !== "number" || !Number.isFinite(payload.startUs)))
      || (payload?.endUs !== undefined && (typeof payload.endUs !== "number" || !Number.isFinite(payload.endUs)))
    ) {
      return fail("timeline.addCaption", "INVALID_PAYLOAD", "字幕时间参数无效");
    }
    const startUs = Math.max(0, Math.round(payload?.startUs ?? ctx.playheadStore.get()));
    const endUs = Math.round(payload?.endUs ?? startUs + 3_000_000);
    if (endUs <= startUs) {
      return fail("timeline.addCaption", "INVALID_PAYLOAD", "字幕结束时间必须大于开始时间");
    }
    const text = payload?.text ?? "默认文本";
    const presetId = payload?.presetId ?? "default-bottom";
    const res = await executeTimelinePatch(ctx, {
      operations: [{ op: "add_caption", start_us: startUs, end_us: endUs, text, preset_id: presetId, source_clip_id: null }],
      summary: text === "默认文本" ? "添加默认文本" : "添加字幕",
    });
    if (!res.ok) return { ...res, command: "timeline.addCaption" };
    return { ok: true, command: "timeline.addCaption", data: { revisionId: res.data.revisionId, startUs, endUs } };
  },
};

export const timelineImportCaptionsCommand: CommandDefinition<TimelineImportCaptionsPayload, { revisionId: string; count: number }> = {
  id: "timeline.importCaptions",
  label: "导入字幕条目",
  description: "批量写入解析后的时间轴字幕条目。",
  scopes: ["caption", "timeline"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      fileName: { type: "string", description: "源字幕文件名" },
      entries: {
        type: "array",
        description: "字幕条目数组（含 start_us、end_us、text）",
        items: { type: "object", description: "{ start_us, end_us, text }" },
      },
      presetId: { type: "string", description: "字幕样式预设 ID" },
      replaceExisting: { type: "boolean", description: "是否替换现有手工字幕" },
    },
    required: ["fileName", "entries"],
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.project && ctx.timeline ? undefined : "需要项目和时间线"),
  async execute(ctx, payload) {
    if (!ctx.project) return fail("timeline.importCaptions", "PROJECT_REQUIRED", "需要项目");
    if (!ctx.timeline) return fail("timeline.importCaptions", "TIMELINE_REQUIRED", "需要时间线");
    if (typeof payload?.fileName !== "string" || !payload.fileName.trim()) {
      return fail("timeline.importCaptions", "INVALID_PAYLOAD", "字幕文件名无效");
    }
    if (!Array.isArray(payload?.entries)) {
      return fail("timeline.importCaptions", "INVALID_PAYLOAD", "字幕条目格式无效");
    }
    const hasInvalidEntry = payload.entries.some(
      entry =>
        !entry
        || typeof entry !== "object"
        || Array.isArray(entry)
        || typeof entry.start_us !== "number"
        || !Number.isFinite(entry.start_us)
        || typeof entry.end_us !== "number"
        || !Number.isFinite(entry.end_us)
        || entry.end_us <= entry.start_us
        || typeof entry.text !== "string",
    );
    if (hasInvalidEntry) {
      return fail("timeline.importCaptions", "INVALID_PAYLOAD", "字幕条目字段无效");
    }
    const replaceExisting = payload.replaceExisting ?? (ctx.working?.captions ?? []).some(caption => caption.origin === "user");
    const res = await executeTimelinePatch(ctx, {
      operations: [{
        op: "import_captions",
        entries: payload.entries,
        preset_id: payload.presetId ?? "default-bottom",
        replace_existing: replaceExisting,
      }],
      summary: `导入字幕 ${payload.fileName}（${payload.entries.length} 条）`,
    });
    if (!res.ok) return { ...res, command: "timeline.importCaptions" };
    return { ok: true, command: "timeline.importCaptions", data: { revisionId: res.data.revisionId, count: payload.entries.length } };
  },
};

export const timelineDurationLimit = duration;

export const timelineCommands = [
  timelinePatchCommand,
  timelineCreateCommand,
  timelineUndoCommand,
  timelineRedoCommand,
  timelineSplitCommand,
  timelineCopyCommand,
  timelineCutCommand,
  timelinePasteCommand,
  timelineDeleteCommand,
  timelineAddCaptionCommand,
  timelineImportCaptionsCommand,
] as const;

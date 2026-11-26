import { duration } from "../appHelpers.js";
import type {
  CommandDefinition,
  CommandResult,
  PlaybackSeekPayload,
  PlaybackStepFramesPayload,
} from "./types.js";

export const playPauseCommand: CommandDefinition<Record<string, never>, { toggled: true }> = {
  id: "play.pause",
  label: "播放/暂停",
  description: "切换当前预览或素材箱试播的播放/暂停状态。",
  scopes: ["timeline"],
  group: "时间线",
  shortcut: "空格",
  mcpExpose: false,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.previewAssetMediaUrl ? undefined : "需要预览素材"),
  execute(ctx) {
    ctx.togglePlayback();
    return { ok: true, command: "play.pause", data: { toggled: true } };
  },
};

export const playbackSeekCommand: CommandDefinition<PlaybackSeekPayload, { timeUs: number; committed: boolean }> = {
  id: "playback.seek",
  label: "定位播放头",
  description: "将播放头定位到指定的整数微秒位置（非负数）。",
  scopes: ["timeline"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      timeUs: { type: "integer", description: "目标时间线位置（微秒，>= 0）" },
      commit: { type: "boolean", description: "是否精确提交（默认 true）" },
    },
    required: ["timeUs"],
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.timeline ? undefined : "需要时间线"),
  execute(ctx, payload): CommandResult<{ timeUs: number; committed: boolean }> {
    if (!ctx.timeline) {
      return { ok: false, command: "playback.seek", code: "TIMELINE_REQUIRED", message: "需要时间线" };
    }
    if (typeof payload?.timeUs !== "number" || !Number.isFinite(payload.timeUs) || payload.timeUs < 0) {
      return { ok: false, command: "playback.seek", code: "INVALID_PAYLOAD", message: "timeUs 必须为非负有限数值" };
    }
    const maxUs = duration(ctx.working);
    const clamped = maxUs > 0 ? Math.min(maxUs, Math.round(payload.timeUs)) : Math.round(payload.timeUs);
    const commit = payload.commit !== false;
    ctx.exitLibraryPreview();
    if (commit) ctx.seekFromUser(clamped);
    else ctx.seekWhileScrubbing(clamped);
    return { ok: true, command: "playback.seek", data: { timeUs: clamped, committed: commit } };
  },
};

export const playbackStepFramesCommand: CommandDefinition<PlaybackStepFramesPayload, { timeUs: number; frames: number }> = {
  id: "playback.stepFrames",
  label: "逐帧步进播放头",
  description: "按项目画布帧率向前或向后步进指定帧数。",
  scopes: ["timeline"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      frames: { type: "integer", description: "步进帧数（正数前进、负数后退）" },
    },
    required: ["frames"],
    additionalProperties: false,
  },
  disabledReason: ctx => (ctx.working ? undefined : "需要时间线"),
  execute(ctx, payload): CommandResult<{ timeUs: number; frames: number }> {
    if (!ctx.working) {
      return { ok: false, command: "playback.stepFrames", code: "TIMELINE_REQUIRED", message: "需要时间线" };
    }
    if (typeof payload?.frames !== "number" || !Number.isFinite(payload.frames)) {
      return { ok: false, command: "playback.stepFrames", code: "INVALID_PAYLOAD", message: "frames 必须为有效整数" };
    }
    const fps = ctx.working.canvas.fps_num && ctx.working.canvas.fps_den
      ? ctx.working.canvas.fps_num / ctx.working.canvas.fps_den
      : 30;
    const frameUs = Math.round(1_000_000 / fps);
    const currentUs = ctx.playheadStore.get();
    const nextUs = Math.max(0, Math.min(duration(ctx.working), currentUs + frameUs * payload.frames));
    ctx.exitLibraryPreview();
    ctx.seekFromUser(nextUs);
    return { ok: true, command: "playback.stepFrames", data: { timeUs: nextUs, frames: payload.frames } };
  },
};

export const playbackCommands = [
  playPauseCommand,
  playbackSeekCommand,
  playbackStepFramesCommand,
] as const;

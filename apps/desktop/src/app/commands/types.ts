import type {
  AssetId,
  CaptionPresetId,
  EncoderMode,
  ExportFrameRate,
  ExportQuality,
  ExportResolution,
  OutputRatio,
  Project,
  TimelineCaption,
  TimelineClip,
  TimelineCreateSource,
  TimelineDocument,
  TimelineLayout,
  TimelinePatchOperation,
  TimelineState,
} from "@aivideo/contracts";
import type { PlayheadStore } from "../timeline/playhead-store.js";
import type { NoticeTone } from "../appHelpers.js";

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly (string | number)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
};

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export type EditorCommandScope = "global" | "timeline" | "asset" | "caption" | "ai" | "export";

export type EditorCommandGroup = "项目" | "编辑" | "时间线" | "界面" | "工具" | "帮助";

export type EditorCommandErrorCode =
  | "PROJECT_REQUIRED"
  | "TIMELINE_REQUIRED"
  | "TIMELINE_ALREADY_EXISTS"
  | "SELECTION_EMPTY"
  | "CLIP_LOCKED"
  | "LINKED_CLIP_UNSUPPORTED"
  | "INVALID_PAYLOAD"
  | "EMPTY_CLIPBOARD"
  | "ASSET_UNAVAILABLE"
  | "CONFLICT"
  | "DRAFT_PRESENT"
  | "TIMELINE_EMPTY"
  | "IN_FLIGHT"
  | "CANCELLED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_DISABLED"
  | "EXECUTION_FAILED";

export type CommandResult<TData = Record<string, unknown>> =
  | { ok: true; command: string; data: TData }
  | { ok: false; command: string; code: EditorCommandErrorCode; message: string; retryable?: boolean };

export interface ClipboardClipSnapshot {
  asset_id: AssetId;
  asset_kind: "video" | "image";
  source_start_us: number | null;
  source_end_us: number | null;
  speed_milli: number;
  reverse_playback: boolean;
  layout: TimelineLayout;
}

export interface TimelinePatchPayload {
  operations: TimelinePatchOperation[];
  summary: string;
  baseRevisionId?: string;
}

export interface TimelineCreatePayload {
  source?: TimelineCreateSource;
}

export interface TimelineRevisionStepPayload {
  baseRevisionId?: string;
}

export interface TimelineSplitPayload {
  clipIds?: string[];
  timeUs?: number;
}

export interface TimelineCopyPayload {
  clipIds?: string[];
}

export interface TimelineCutPayload {
  clipIds?: string[];
}

export interface TimelinePastePayload {
  timeUs?: number;
}

export interface TimelineDeletePayload {
  clipIds?: string[];
  captionId?: string;
  mode?: "standard" | "ripple";
}

export interface TimelineAddCaptionPayload {
  startUs?: number;
  endUs?: number;
  text?: string;
  presetId?: CaptionPresetId;
}

export interface TimelineImportCaptionsPayload {
  fileName: string;
  entries: Array<{ start_us: number; end_us: number; text: string }>;
  presetId?: CaptionPresetId;
  replaceExisting?: boolean;
}

export interface PlaybackSeekPayload {
  timeUs: number;
  commit?: boolean;
}

export interface PlaybackStepFramesPayload {
  frames: number;
}

export interface PreviewGeneratePayload {
  encoderMode?: EncoderMode;
  outputRatio?: OutputRatio;
}

export interface ExportCreatePayload {
  destinationGrantId?: string;
  fileName?: string;
  quality?: ExportQuality;
  resolution?: ExportResolution;
  frameRate?: ExportFrameRate;
  encoderMode?: EncoderMode;
  outputRatio?: OutputRatio;
}

export interface CommandRuntimeContext {
  project: Project | undefined;
  isCurrentProject: (projectId: Project["project_id"]) => boolean;
  timeline: TimelineState | undefined;
  working: TimelineDocument | undefined;
  selectedClips: TimelineClip[];
  selectedCaption: TimelineCaption | undefined;
  trackById: Map<string, TimelineDocument["tracks"][number]>;
  visualClips: TimelineClip[];
  previewAssetMediaUrl: string | null | undefined;
  playhead: number;
  playheadStore: PlayheadStore;
  clipboardClips: ClipboardClipSnapshot[];
  setClipboardClips: (next: ClipboardClipSnapshot[]) => void;
  areClipboardAssetsInsertable: (snapshots: ClipboardClipSnapshot[]) => boolean;
  undoRedoInFlightRef: { current: boolean };
  acceptState: (next: TimelineState) => void;
  clearPendingDraft: () => void;
  setSaveState: (state: "已保存" | "保存中" | "保存失败" | "草稿冲突") => void;
  handleConflict: (error: unknown) => Promise<void>;
  showNotice: (text: string, tone?: NoticeTone) => void;
  togglePlayback: () => void;
  exitLibraryPreview: () => void;
  seekFromUser: (timeUs: number) => void;
  seekWhileScrubbing: (timeUs: number) => void;
  renderDisabledReason: string | undefined;
  generatePreview: (options?: PreviewGeneratePayload) => Promise<CommandResult<{ reused: boolean; previewId: string | null; jobId: string | null }>>;
  createExport: (payload: ExportCreatePayload) => Promise<CommandResult<{ jobId: string; exportRecordId: string | null }>>;
  openRenderPanel: () => void;
  openAi: () => Promise<void>;
  openPatch: () => Promise<void>;
  openProjectManager: () => void;
  refreshProjects: () => Promise<void>;
  resetLayout: () => void;
  openShortcuts: () => void;
  openRevisionCompare: () => Promise<void>;
  openShotRequirements: () => void;
  openGeneration: () => void;
  openImageGeneration: () => void;
  openCommandSearch: () => void;
}

export interface CommandDefinition<TPayload = Record<string, unknown>, TData = Record<string, unknown>> {
  id: string;
  label: string;
  description: string;
  scopes: EditorCommandScope[];
  group?: EditorCommandGroup;
  shortcut?: string;
  /** Whether this command operates purely on serializable domain data and is a candidate for MCP tool exposure. */
  mcpExpose: boolean;
  inputSchema: JsonSchemaObject;
  disabledReason?: (ctx: CommandRuntimeContext, payload?: TPayload) => string | undefined;
  execute: (ctx: CommandRuntimeContext, payload: TPayload) => Promise<CommandResult<TData>> | CommandResult<TData>;
}

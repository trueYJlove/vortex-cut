import type { EditorCommandGroup, EditorCommandScope } from "./commands/types.js";
import { allCommandDefinitions } from "./commands/registry.js";

export type { EditorCommandGroup };

export type EditorCommand = {
  id: string;
  label: string;
  shortcut?: string;
  scopes: EditorCommandScope[];
  group: EditorCommandGroup;
};

/** 命令面板注册表：与主菜单条目保持一一对应，由 commands/* 定义驱动。 */
export const editorCommands: readonly EditorCommand[] = allCommandDefinitions
  .filter((command): command is typeof command & { group: EditorCommandGroup } => Boolean(command.group))
  .map(command => ({
    id: command.id,
    label: command.label,
    ...(command.shortcut ? { shortcut: command.shortcut } : {}),
    scopes: command.scopes,
    group: command.group,
  }));

export {
  allCommandDefinitions,
  commandRegistryMap,
  createEditorCommandDispatcher,
  isPlainJsonSerializable,
  listMcpToolDescriptors,
  mcpCandidateCommands,
  type McpToolDescriptor,
} from "./commands/registry.js";
export type {
  ClipboardClipSnapshot,
  CommandDefinition,
  CommandResult,
  CommandRuntimeContext,
  EditorCommandErrorCode,
  EditorCommandScope,
  ExportCreatePayload,
  JsonSchemaObject,
  JsonSchemaProperty,
  PlaybackSeekPayload,
  PlaybackStepFramesPayload,
  PreviewGeneratePayload,
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
} from "./commands/types.js";

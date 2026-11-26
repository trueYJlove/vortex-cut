import { playbackCommands } from "./playbackCommands.js";
import { renderCommands } from "./renderCommands.js";
import { timelineCommands } from "./timelineCommands.js";
import { uiCommands } from "./uiCommands.js";
import type {
  CommandDefinition,
  CommandResult,
  CommandRuntimeContext,
  JsonSchemaObject,
} from "./types.js";

export const allCommandDefinitions: readonly CommandDefinition<any, any>[] = [
  ...timelineCommands,
  ...playbackCommands,
  ...renderCommands,
  ...uiCommands,
];

export const commandRegistryMap = new Map<string, CommandDefinition<any, any>>(
  allCommandDefinitions.map(command => [command.id, command]),
);

export const mcpCandidateCommands = allCommandDefinitions.filter(command => command.mcpExpose);

export interface McpToolDescriptor {
  name: string;
  commandId: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export function listMcpToolDescriptors(): McpToolDescriptor[] {
  return mcpCandidateCommands.map(command => ({
    name: `vortex_${command.id.replace(/\./g, "_")}`,
    commandId: command.id,
    description: command.description,
    inputSchema: command.inputSchema,
  }));
}

/** 验证入参是否为纯 JSON 可序列化对象（禁止 DOM 节点、函数或合成事件泄漏）。 */
export function isPlainJsonSerializable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || value === undefined) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (kind !== "object") return false;
  if (seen.has(value as object)) return false;
  if (typeof Node !== "undefined" && value instanceof Node) return false;
  if (typeof Event !== "undefined" && value instanceof Event) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.every(item => isPlainJsonSerializable(item, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(v => isPlainJsonSerializable(v, seen));
}

export function createEditorCommandDispatcher(getContext: () => CommandRuntimeContext) {
  const disabledReason = (id: string): string | undefined => {
    const command = commandRegistryMap.get(id);
    if (!command) return "未知命令";
    return command.disabledReason?.(getContext());
  };

  const dispatch = async <TData = Record<string, unknown>>(
    id: string,
    payload: Record<string, unknown> = {},
  ): Promise<CommandResult<TData>> => {
    const command = commandRegistryMap.get(id);
    if (!command) {
      return { ok: false, command: id, code: "COMMAND_DISABLED", message: "未知命令" };
    }
    if (!isPlainJsonSerializable(payload)) {
      return { ok: false, command: id, code: "INVALID_PAYLOAD", message: "命令入参必须是纯 JSON 可序列化数据" };
    }
    const ctx = getContext();
    const blockedReason = command.disabledReason?.(ctx);
    if (blockedReason) {
      return { ok: false, command: id, code: "COMMAND_DISABLED", message: blockedReason };
    }
    return (await command.execute(ctx, payload)) as CommandResult<TData>;
  };

  return {
    dispatch,
    disabledReason,
    listMcpTools: listMcpToolDescriptors,
  };
}

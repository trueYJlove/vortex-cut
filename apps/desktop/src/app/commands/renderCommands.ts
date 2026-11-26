import type {
  CommandDefinition,
  ExportCreatePayload,
  PreviewGeneratePayload,
} from "./types.js";

export const previewGenerateCommand: CommandDefinition<PreviewGeneratePayload, { reused: boolean; previewId: string | null; jobId: string | null }> = {
  id: "preview.generate",
  label: "生成预览",
  description: "基于当前已提交 Timeline Revision 生成权威渲染预览。",
  scopes: ["export", "global"],
  group: "时间线",
  shortcut: "Ctrl+Enter",
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      encoderMode: { type: "string", description: "可选编码器模式：auto 或 software", enum: ["auto", "software"] },
      outputRatio: { type: "string", description: "可选输出画幅比例：169 / 916 / 11 / 43 / 34 / fit", enum: ["169", "916", "11", "43", "34", "fit"] },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => ctx.renderDisabledReason,
  execute: (ctx, payload) => ctx.generatePreview(payload),
};

export const exportCreateCommand: CommandDefinition<ExportCreatePayload, { jobId: string; exportRecordId: string | null }> = {
  id: "export.create",
  label: "创建导出任务",
  description: "触发正式视频导出任务（可传已授权 destinationGrantId 或默认文件名与画质规格）。",
  scopes: ["export", "global"],
  mcpExpose: true,
  inputSchema: {
    type: "object",
    properties: {
      destinationGrantId: { type: "string", description: "可选已授权导出路径 ID（无头调用时可直接传入）" },
      fileName: { type: "string", description: "建议导出文件名（缺省按项目名称生成）" },
      quality: { type: "string", description: "导出画质档位", enum: ["standard", "high", "ultra"] },
      resolution: { type: "string", description: "短边分辨率档位", enum: ["480p", "720p", "1080p", "2k", "4k", "original"] },
      frameRate: { type: "integer", description: "导出帧率", enum: [24, 25, 30, 50, 60] },
      encoderMode: { type: "string", description: "编码器模式", enum: ["auto", "software"] },
      outputRatio: { type: "string", description: "输出画幅比例", enum: ["169", "916", "11", "43", "34", "fit"] },
    },
    additionalProperties: false,
  },
  disabledReason: ctx => ctx.renderDisabledReason,
  execute: (ctx, payload) => ctx.createExport(payload ?? {}),
};

export const renderCommands = [
  previewGenerateCommand,
  exportCreateCommand,
] as const;

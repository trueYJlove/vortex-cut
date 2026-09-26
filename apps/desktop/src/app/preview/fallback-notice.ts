/** 合成预览回退提示（用户可读文案）。
 *
 * onFallback 的 reason 是底层错误串（可能含 IPC 包装、英文码），直接上黄条
 * 观感如"软件出了故障"（PREVIEW_IR_TOO_LARGE 现场反馈）。已知错误码映射为
 * 人话 + 恢复指引；未知原因保留原始细节（诊断价值 + "no ticket"自动恢复
 * 逻辑依赖该串——App.tsx noTicket 恢复 effect 按子串匹配）。 */

export function syntheticFallbackNotice(reason: string, code: string | null): string {
  if (code === "PREVIEW_IR_TOO_LARGE") {
    return "时间线超出实时合成预览的长度上限（约 15 分钟），已回退交互预览。裁短时间线或只剪辑所需片段后即可恢复实时预览。";
  }
  if (code === "PREVIEW_IR_UNSUPPORTED") {
    return "当前时间线包含实时合成暂不支持的效果（如蒙版、抠像、倒放、图片素材等），已回退交互预览。";
  }
  if (code === "BMFF_CODEC_UNSUPPORTED") {
    return "该视频编码暂不支持实时合成预览，已回退交互预览。";
  }
  return `合成预览暂时无法启动，已回退交互预览。（${reason}）`;
}

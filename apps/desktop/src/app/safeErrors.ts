export function safeErrorMessage(error: unknown, fallback = "操作未完成，请刷新后重试。"): string {
  const messages: Record<string, string> = {
    TIMELINE_CONFLICT: "时间线已发生变化，请刷新后重试。",
    TIMELINE_DRAFT_CONFLICT: "草稿已发生变化，请刷新后重试。",
    TIMELINE_NOT_FOUND: "当前项目还没有时间线。",
    TIMELINE_PATCH_PROVIDER_UNTESTED: "该 Provider 尚未完成 AI 修改兼容性测试。",
    TIMELINE_PATCH_PROVIDER_UNSUPPORTED: "该 Provider 不支持当前 AI 修改响应格式。",
    PROVIDER_NOT_CONFIGURED: "当前 Provider 尚未配置完成。",
    PROVIDER_UNSUPPORTED: "当前 Provider 不支持此操作。",
    // 2026-10-27：网关可静默忽略 response_format（实测 200 + 自由文本）。此前该码被
    // IPC 吞成 "Core request failed"，界面只能提示「检查 Brief、凭据、转录」——把
    // 「换 Provider」误报成「用户配置错」。指错方向的文案比没有文案更糟。
    PROVIDER_CAPABILITY_UNSUPPORTED: "该 Provider 不支持所需的响应格式（可能静默忽略了结构化输出要求）。下一步：改用支持 JSON 结构化输出的 Provider 或模型后重试。",
    EGRESS_CONFIRMATION_EXPIRED: "确认已过期，请重新准备外传内容。",
    // 2026-10 真实事故：用户删掉两个素材文件后，删片段/删素材两条路全失败，
    // 却都只显示兜底文案「…请刷新后重试」——刷新永远解决不了，用户被指向
    // 一个无效动作。这三条码此前全部落到兜底分支。
    TIMELINE_SOURCE_INVALID: "时间线上有素材的本地文件已缺失或已变化，导致这次修改被拒绝。请把文件恢复到原位置（或用「刷新素材库」重新定位）后再操作。",
    ASSET_IN_USE: "该素材仍被时间线片段或生成记录引用，无法删除。请先从时间线移除相关片段后再删除。",
    ASSET_MISSING: "该素材的本地文件已缺失。请把文件恢复到原位置后刷新素材库。",
  };

  return messages[errorCode(error)] ?? fallback;
}

export function safeTaskErrorMessage(error?: unknown): string {
  return safeErrorMessage(error, "任务未完成；请检查任务状态或刷新后重试。");
}

export function errorCode(error: unknown): string {
  const raw = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : error instanceof Error
      ? error.message
      : "";
  // Electron IPC 会包装成 "Error invoking remote method '...': Error: [CODE] msg"，
  // 因此不能用 ^ 锚定；取首个 [ALL_CAPS_CODE] 作为业务码。
  const bracket = raw.match(/\[([A-Z][A-Z0-9_]{2,})\]/);
  return bracket ? bracket[1] : raw;
}

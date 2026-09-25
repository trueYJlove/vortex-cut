export function safeErrorMessage(error: unknown, fallback = "操作未完成，请刷新后重试。"): string {
  const messages: Record<string, string> = {
    TIMELINE_CONFLICT: "时间线已发生变化，请刷新后重试。",
    TIMELINE_DRAFT_CONFLICT: "草稿已发生变化，请刷新后重试。",
    TIMELINE_NOT_FOUND: "当前项目还没有时间线。",
    TIMELINE_PATCH_PROVIDER_UNTESTED: "该 Provider 尚未完成 AI 修改兼容性测试。",
    TIMELINE_PATCH_PROVIDER_UNSUPPORTED: "该 Provider 不支持当前 AI 修改响应格式。",
    PROVIDER_NOT_CONFIGURED: "当前 Provider 尚未配置完成。",
    PROVIDER_UNSUPPORTED: "当前 Provider 不支持此操作。",
    EGRESS_CONFIRMATION_EXPIRED: "确认已过期，请重新准备外传内容。",
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

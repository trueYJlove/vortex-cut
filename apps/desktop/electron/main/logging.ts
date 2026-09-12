import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:AIVS_ADMIN_TOKEN|UI_TOKEN|ADMIN_TOKEN)[= :]+[^\s,;]+/gi, "[token-redacted]")
    .replace(/([\"']?(?:token|admin_token|ui_token|authorization|access_token)[\"']?\s*[:=]\s*[\"']?)[^\"',;\s}]+/gi, "$1[redacted]")
    .replace(/([\"']?(?:text|raw_transcript|transcript_text|content|segments|words)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)/gi, "$1[content-redacted]")
    .replace(/(?:file:\/\/|https?:\/\/|wss?:\/\/|restricted-media:\/\/)[^\s\"']+/gi, "[uri-redacted]")
    .replace(/[A-Za-z]:[\\/][^\r\n\"']*/g, "[path-redacted]")
    .replace(/(?:^|[\s(])\/(?:[^\s/]+\/)+[^\s)]+/g, "$1[path-redacted]")
    .replace(/(transcript(?:_text)?\s+)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)/gi, "$1[content-redacted]");
}

/** 持久化场景（runner failure.json）的错误详情：文本一律先过 redact()
 *  再截断——解码失败消息可能携带媒体票据/绝对路径，不得原文落盘。 */
export function sanitizeErrorDetail(
  error: unknown,
  limits = { message: 600, stack: 4000 },
): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "unknown", message: "" };
  return {
    name: error.name,
    message: redact(String(error.message)).slice(0, limits.message),
    stack: error.stack ? redact(error.stack).slice(0, limits.stack) : undefined,
  };
}

export async function appendLog(logPath: string, message: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${redact(message)}\n`, "utf8");
}

export function defaultLogPath(userData: string): string {
  return join(userData, "logs", "desktop.log");
}

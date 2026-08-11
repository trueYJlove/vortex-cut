import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:AIVS_ADMIN_TOKEN|UI_TOKEN|ADMIN_TOKEN)[= :]+[^\s,;]+/gi, "[token-redacted]")
    .replace(/([\"']?(?:token|admin_token|ui_token|authorization|access_token)[\"']?\s*[:=]\s*[\"']?)[^\"',;\s}]+/gi, "$1[redacted]")
    .replace(/([\"']?(?:text|raw_transcript|transcript_text|content|segments|words)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)/gi, "$1[content-redacted]")
    .replace(/(?:file:\/\/|https?:\/\/|wss?:\/\/)[^\s\"']+/gi, "[uri-redacted]")
    .replace(/[A-Za-z]:[\\/][^\r\n\"']*/g, "[path-redacted]")
    .replace(/(?:^|[\s(])\/(?:[^\s/]+\/)+[^\s)]+/g, "$1[path-redacted]")
    .replace(/(transcript(?:_text)?\s+)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)/gi, "$1[content-redacted]");
}

export async function appendLog(logPath: string, message: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${redact(message)}\n`, "utf8");
}

export function defaultLogPath(userData: string): string {
  return join(userData, "logs", "desktop.log");
}

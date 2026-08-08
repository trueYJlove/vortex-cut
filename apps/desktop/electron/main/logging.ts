import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/AIVS_ADMIN_TOKEN[= ]+[^\s]+/gi, "AIVS_ADMIN_TOKEN=[redacted]")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[path-redacted]");
}

export async function appendLog(logPath: string, message: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${redact(message)}\n`, "utf8");
}

export function defaultLogPath(userData: string): string {
  return join(userData, "logs", "desktop.log");
}

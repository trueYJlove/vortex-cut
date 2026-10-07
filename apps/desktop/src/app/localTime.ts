/**
 * 时间显示统一入口。
 *
 * Core 落库的时间戳一律是 UTC ISO 串（形如 `2026-10-06T11:25:39.989Z`）。
 * 直接对字符串做 `slice(5, 16).replace("T", " ")` 会显示 **UTC 时间**——
 * 用户实测：本地 19:25 发生的转录在任务列表里显示成 11:25。
 * 所有面向用户的时间显示都必须经此处转本地时区。
 */

function parse(value: string): Date | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `MM-DD HH:mm`（本地时区）；无法解析时退回原始串的安全截断。 */
export function formatLocalStamp(value: string | null | undefined): string {
  if (!value) return "";
  const at = parse(value);
  if (!at) return value.slice(5, 16).replace("T", " ");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm`（本地时区）；无法解析时退回原始串的安全截断。 */
export function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const at = parse(value);
  if (!at) return value.slice(0, 16).replace("T", " ");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

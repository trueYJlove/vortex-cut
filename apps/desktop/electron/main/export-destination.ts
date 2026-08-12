import { extname } from "node:path";

export function exportFileName(projectName: string): string {
  const safe = projectName.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  return `${safe || "video"}.mp4`;
}

export function normalizeExportPath(value: string): string {
  if (extname(value).toLowerCase() === ".mp4") return value;
  return `${value}.mp4`;
}

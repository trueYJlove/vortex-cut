import { basename, isAbsolute, normalize, resolve } from "node:path";
import type { AssetKind } from "@aivideo/contracts";

export const MAX_DROPPED_FILES = 100;
export const MAX_DROPPED_FILE_BYTES = 100 * 1024 * 1024 * 1024;

export function isDroppedFileCountAllowed(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_DROPPED_FILES;
}

export function isTrustedDroppedFileInvocation(context: {
  liveMainWindow: boolean;
  senderMatchesWindow: boolean;
  senderIsMainFrame: boolean;
}): boolean {
  return context.liveMainWindow && context.senderMatchesWindow && context.senderIsMainFrame;
}

export interface DroppedFileSnapshot {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface ValidatedDroppedFile extends DroppedFileSnapshot {
  kind: AssetKind;
}

const EXTENSION_KIND: Readonly<Record<string, AssetKind>> = {
  ".mp4": "video", ".mov": "video", ".mkv": "video", ".webm": "video", ".avi": "video",
  ".wav": "audio", ".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
};

const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-matroska"]);

export function inferDroppedAssetKind(name: string, type: string): AssetKind | null {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const kind = EXTENSION_KIND[extension];
  if (!kind) return null;
  const mime = type.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (!GENERIC_MIME.has(mime)) {
    const family = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : null;
    if (family !== kind) return null;
  }
  return kind;
}

/** Validate the preload-only path snapshot against facts read by main before granting it to Core. */
export function validateDroppedFileSnapshot(
  value: unknown,
  facts: { isFile: boolean; isSymbolicLink: boolean; size: number; basename: string },
): ValidatedDroppedFile | "invalid" | "unsupported" {
  if (!value || typeof value !== "object") return "invalid";
  const item = value as Partial<DroppedFileSnapshot>;
  if (typeof item.path !== "string" || !isAbsolute(item.path) || normalize(resolve(item.path)) !== item.path ||
    typeof item.name !== "string" || !item.name || item.name !== facts.basename ||
    !Number.isSafeInteger(item.size) || item.size! < 1 || item.size! > MAX_DROPPED_FILE_BYTES || item.size !== facts.size ||
    typeof item.type !== "string" || item.type.length > 256 || !facts.isFile || facts.isSymbolicLink) return "invalid";
  const kind = inferDroppedAssetKind(item.name, item.type);
  if (!kind) return "unsupported";
  return { path: item.path, name: basename(item.path), size: item.size, type: item.type, kind };
}

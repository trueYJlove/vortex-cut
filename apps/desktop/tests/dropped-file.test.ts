import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DROPPED_FILES, MAX_DROPPED_FILE_BYTES, inferDroppedAssetKind, isDroppedFileCountAllowed, isTrustedDroppedFileInvocation, validateDroppedFileSnapshot } from "../electron/main/dropped-file.js";

describe("native dropped file validation", () => {
  const make = (name: string, type: string, size = 128) => {
    const path = resolve("dropped", name);
    return {
      path,
      name,
      size,
      type,
      facts: { isFile: true, isSymbolicLink: false, size, basename: basename(path) },
    };
  };

  it("classifies only supported media extensions and matching MIME families", () => {
    expect(inferDroppedAssetKind("shot.MOV", "video/quicktime")).toBe("video");
    expect(inferDroppedAssetKind("bed.m4a", "audio/mp4")).toBe("audio");
    expect(inferDroppedAssetKind("still.jpeg", "image/jpeg")).toBe("image");
    expect(inferDroppedAssetKind("unknown.mp4", "text/plain")).toBeNull();
    expect(inferDroppedAssetKind("notes.txt", "text/plain")).toBeNull();
  });

  it("accepts a real regular file snapshot and rejects path/name/size/type mismatches", () => {
    const valid = make("shot.mp4", "video/mp4");
    expect(validateDroppedFileSnapshot(valid, valid.facts)).toMatchObject({ kind: "video", name: "shot.mp4", size: 128 });
    expect(validateDroppedFileSnapshot({ ...valid, name: "other.mp4" }, valid.facts)).toBe("invalid");
    expect(validateDroppedFileSnapshot({ ...valid, size: 129 }, valid.facts)).toBe("invalid");
    expect(validateDroppedFileSnapshot({ ...valid, type: "image/png" }, valid.facts)).toBe("unsupported");
    expect(validateDroppedFileSnapshot(valid, { ...valid.facts, isSymbolicLink: true })).toBe("invalid");
    expect(validateDroppedFileSnapshot(valid, { ...valid.facts, isFile: false })).toBe("invalid");
  });

  it("rejects empty and oversized payloads before a file grant can be created", () => {
    const empty = make("empty.mp4", "video/mp4", 0);
    const large = make("large.mp4", "video/mp4", MAX_DROPPED_FILE_BYTES + 1);
    expect(validateDroppedFileSnapshot(empty, empty.facts)).toBe("invalid");
    expect(validateDroppedFileSnapshot(large, large.facts)).toBe("invalid");
    expect(isDroppedFileCountAllowed(1)).toBe(true);
    expect(isDroppedFileCountAllowed(MAX_DROPPED_FILES)).toBe(true);
    expect(isDroppedFileCountAllowed(0)).toBe(false);
    expect(isDroppedFileCountAllowed(MAX_DROPPED_FILES + 1)).toBe(false);
  });

  it("requires the live app window's main frame for the dropped-file IPC", () => {
    expect(isTrustedDroppedFileInvocation({ liveMainWindow: true, senderMatchesWindow: true, senderIsMainFrame: true })).toBe(true);
    expect(isTrustedDroppedFileInvocation({ liveMainWindow: false, senderMatchesWindow: true, senderIsMainFrame: true })).toBe(false);
    expect(isTrustedDroppedFileInvocation({ liveMainWindow: true, senderMatchesWindow: false, senderIsMainFrame: true })).toBe(false);
    expect(isTrustedDroppedFileInvocation({ liveMainWindow: true, senderMatchesWindow: true, senderIsMainFrame: false })).toBe(false);
  });
});

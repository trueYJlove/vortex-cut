import { describe, expect, it, vi } from "vitest";
import {
  ASSET_BATCH_DRAG, ASSET_DRAG, MAX_ASSET_DRAG_ITEMS, SYSTEM_FILE_DROP_ID,
  clearSystemFileDrop, hasAssetDrag, readAssetDrop, setActiveDraggedAssetIds, takeSystemFileDrop,
} from "../src/app/timeline/asset-drop.js";

describe("HTML5 asset DataTransfer", () => {
  it("uses transfer types only during protected dragover", () => {
    const getData = vi.fn(() => "");
    const transfer = { types: [ASSET_DRAG], getData } as unknown as DataTransfer;
    expect(hasAssetDrag(transfer)).toBe(true);
    expect(getData).not.toHaveBeenCalled();
  });

  it("reads a selected asset batch synchronously on drop, deduplicates IDs, and bounds payload size", () => {
    const batch = JSON.stringify(["asset_a", "asset_b", "asset_a"]);
    const transfer = { types: [ASSET_BATCH_DRAG], getData: (type: string) => type === ASSET_BATCH_DRAG ? batch : "" } as unknown as DataTransfer;
    expect(readAssetDrop(transfer)).toEqual(["asset_a", "asset_b"]);
    const tooMany = JSON.stringify(Array.from({ length: MAX_ASSET_DRAG_ITEMS + 1 }, (_, index) => `asset_${index}`));
    expect(readAssetDrop({ types: [ASSET_BATCH_DRAG], getData: () => tooMany } as unknown as DataTransfer)).toEqual([]);
    expect(readAssetDrop({ types: [ASSET_BATCH_DRAG], getData: () => "not json" } as unknown as DataTransfer)).toEqual([]);
  });

  it("falls back to the live selected-ID snapshot if protected drop data throws", () => {
    setActiveDraggedAssetIds(["asset_a", "asset_b"]);
    const transfer = { types: [ASSET_BATCH_DRAG], getData: () => { throw new Error("protected"); } } as unknown as DataTransfer;
    expect(readAssetDrop(transfer)).toEqual(["asset_a", "asset_b"]);
    setActiveDraggedAssetIds([]);
  });

  it("captures native File objects during drop for preload import and consumes them once", () => {
    clearSystemFileDrop();
    const file = new File(["video"], "scene.mp4", { type: "video/mp4" });
    const getData = vi.fn(() => "");
    const transfer = { types: ["Files"], files: [file], items: [], getData } as unknown as DataTransfer;
    expect(hasAssetDrag(transfer)).toBe(true);
    expect(getData).not.toHaveBeenCalled();
    expect(readAssetDrop(transfer)).toEqual([SYSTEM_FILE_DROP_ID]);
    expect(takeSystemFileDrop()).toEqual([file]);
    expect(takeSystemFileDrop()).toEqual([]);
  });

  it("ignores unrelated external text drags and safely falls back to DataTransferItem files", () => {
    expect(hasAssetDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    const file = new File(["audio"], "bed.mp3", { type: "audio/mpeg" });
    const transfer = { types: ["Files"], files: [], items: [{ kind: "file", getAsFile: () => file }] } as unknown as DataTransfer;
    expect(readAssetDrop(transfer)).toEqual([SYSTEM_FILE_DROP_ID]);
    expect(takeSystemFileDrop()).toEqual([file]);
  });
});

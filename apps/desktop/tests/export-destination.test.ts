import { describe, expect, it } from "vitest";
import { exportFileName, normalizeExportPath } from "../electron/main/export-destination.js";

describe("export destination", () => {
  it("creates an MP4-only safe suggested name", () => {
    expect(exportFileName("Demo: First/Take ")).toBe("Demo_ First_Take.mp4");
    expect(exportFileName("... ")).toBe("video.mp4");
  });

  it("preserves MP4 case-insensitively and appends the extension otherwise", () => {
    expect(normalizeExportPath("C:\\out\\video.MP4")).toBe("C:\\out\\video.MP4");
    expect(normalizeExportPath("C:\\out\\video.mov")).toBe("C:\\out\\video.mov.mp4");
  });
});

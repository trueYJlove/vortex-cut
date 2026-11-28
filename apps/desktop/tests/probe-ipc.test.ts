import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp", getAppMetrics: () => [], getGPUFeatureStatus: () => ({}), getGPUInfo: async () => ({}), quit: () => undefined },
  ipcMain: { handle: () => undefined },
  screen: { getPrimaryDisplay: () => ({ bounds: {}, workAreaSize: {}, scaleFactor: 1, displayFrequency: 60, colorDepth: 24, colorSpace: "" }) },
}));

import { resolveProbeArtifactTarget } from "../electron/main/ipc/probe-ipc.js";

describe("resolveProbeArtifactTarget", () => {
  it("resolves nested artifact paths inside evidence directory", () => {
    const evidenceDir = resolve("tmp/probe-evidence");
    expect(resolveProbeArtifactTarget(evidenceDir, "frames/f0.png")).toBe(
      resolve(evidenceDir, "frames/f0.png"),
    );
  });

  it("handles filesystem root evidenceDir cleanly without double-separator bugs", () => {
    const rootDir = resolve("/");
    expect(resolveProbeArtifactTarget(rootDir, "out.json")).toBe(resolve(rootDir, "out.json"));
  });

  it("rejects empty, dot, traversal, absolute, and sibling-prefix escape paths", () => {
    const evidenceDir = resolve("tmp/probe-evidence");
    expect(() => resolveProbeArtifactTarget(evidenceDir, "")).toThrow(/Invalid artifact path/);
    expect(() => resolveProbeArtifactTarget(evidenceDir, ".")).toThrow(/Artifact path escapes evidence dir/);
    expect(() => resolveProbeArtifactTarget(evidenceDir, "./")).toThrow(/Artifact path escapes evidence dir/);
    expect(() => resolveProbeArtifactTarget(evidenceDir, "../probe-evidence-evil/out.json")).toThrow(/Invalid artifact path/);
    expect(() => resolveProbeArtifactTarget(evidenceDir, "/etc/passwd")).toThrow(/Invalid artifact path/);
    expect(() => resolveProbeArtifactTarget(evidenceDir, "\\Windows\\System32\\x")).toThrow(/Invalid artifact path/);
  });
});

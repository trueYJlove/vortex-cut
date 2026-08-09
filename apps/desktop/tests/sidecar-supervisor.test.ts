import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarSupervisor } from "../electron/main/sidecar-supervisor.js";

describe("SidecarSupervisor", () => {
  it("starts with shell disabled and reads the file handshake", async () => {
    const runtimeDir = join(tmpdir(), `aivideo-sidecar-${Date.now()}`);
    mkdirSync(runtimeDir, { recursive: true });
    const child = Object.assign(new (require("node:events").EventEmitter)(), { stdout: undefined, stderr: undefined, pid: 321, exitCode: null, kill: vi.fn() });
    const spawnImpl = vi.fn().mockImplementation((_executable: string, args: string[]) => {
      const readyFile = args[args.indexOf("--ready-file") + 1];
      writeFileSync(readyFile, JSON.stringify({ protocol_version: 1, port: 43000, pid: 321, build_version: "0.0.1" }));
      return child;
    });
    const supervisor = new SidecarSupervisor({ executable: "aivs-core.exe", resourcesPath: "C:\\resources", dataDir: "C:\\data", runtimeDir, ffmpegPath: "C:\\ffmpeg.exe", ffprobePath: "C:\\ffprobe.exe", buildVersion: "0.0.1", adminToken: "admin-secret", spawnImpl });
    const ready = supervisor.start();
    await expect(ready).resolves.toMatchObject({ port: 43000 });
    expect(spawnImpl).toHaveBeenCalledWith("aivs-core.exe", expect.arrayContaining(["--host", "127.0.0.1", "--port", "0"]), expect.objectContaining({ shell: false, windowsHide: true, env: expect.objectContaining({ AIVS_ADMIN_TOKEN: "admin-secret" }) }));
    expect(JSON.stringify(spawnImpl.mock.calls[0][1])).not.toContain("admin-secret");
    expect(JSON.parse(readFileSync(join(runtimeDir, "ready.json"), "utf8"))).toMatchObject({ pid: 321 });
  });
});

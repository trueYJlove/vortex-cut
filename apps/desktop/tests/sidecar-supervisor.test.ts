import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarSupervisor } from "../electron/main/sidecar-supervisor.js";

describe("SidecarSupervisor", () => {
  it("starts with shell disabled and reads the file handshake", async () => {
    const runtimeDir = join(tmpdir(), `aivideo-sidecar-${Date.now()}`);
    const manifestDir = join(runtimeDir, "模型 清单");
    const launchEvidencePath = join(runtimeDir, "launch.json");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "faster-whisper-tiny.json"), "{}");
    const child = Object.assign(new (require("node:events").EventEmitter)(), { stdout: undefined, stderr: undefined, pid: 321, exitCode: null, kill: vi.fn() });
    const spawnImpl = vi.fn().mockImplementation((_executable: string, args: string[]) => {
      const readyFile = args[args.indexOf("--ready-file") + 1];
      writeFileSync(readyFile, JSON.stringify({ protocol_version: 1, port: 43000, pid: 321, build_version: "0.0.1" }));
      return child;
    });
    const supervisor = new SidecarSupervisor({ executable: "aivs-core.exe", resourcesPath: "C:\\resources", dataDir: "C:\\data", runtimeDir, ffmpegPath: "C:\\ffmpeg.exe", ffprobePath: "C:\\ffprobe.exe", manifestDir, buildVersion: "0.0.1", adminToken: "admin-secret", launchEvidencePath, spawnImpl });
    const ready = supervisor.start();
    await expect(ready).resolves.toMatchObject({ port: 43000 });
    expect(spawnImpl).toHaveBeenCalledWith("aivs-core.exe", expect.arrayContaining(["--host", "127.0.0.1", "--port", "0"]), expect.objectContaining({ shell: false, windowsHide: true, env: expect.objectContaining({ AIVS_ADMIN_TOKEN: "admin-secret" }) }));
    expect(JSON.stringify(spawnImpl.mock.calls[0][1])).not.toContain("admin-secret");
    const args = spawnImpl.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--manifest-dir") + 1]).toBe(manifestDir);
    expect(JSON.parse(readFileSync(join(runtimeDir, "ready.json"), "utf8"))).toMatchObject({ pid: 321 });
    const launchEvidence = JSON.parse(readFileSync(launchEvidencePath, "utf8"));
    expect(launchEvidence.args).toContain("--manifest-dir");
    expect(JSON.stringify(launchEvidence)).not.toContain("admin-secret");
  });

  it("passes development and packaged manifest paths as one argv value", async () => {
    for (const label of ["开发 资源", "安装包 资源"] as const) {
      const root = join(tmpdir(), `aivideo-${label}-${Date.now()}`);
      const manifestDir = join(root, "model-manifests"); const runtimeDir = join(root, "runtime");
      mkdirSync(manifestDir, { recursive: true }); writeFileSync(join(manifestDir, "model.json"), "{}");
      const child = Object.assign(new (require("node:events").EventEmitter)(), { stdout: undefined, stderr: undefined, pid: 322, exitCode: null, kill: vi.fn() });
      const spawnImpl = vi.fn().mockImplementation((_executable: string, args: string[]) => { writeFileSync(args[args.indexOf("--ready-file") + 1], JSON.stringify({ protocol_version: 1, port: 43001, pid: 322, build_version: "0.0.1" })); return child; });
      await new SidecarSupervisor({ executable: join(root, "core", "aivs-core.exe"), resourcesPath: root, dataDir: join(root, "data"), runtimeDir, ffmpegPath: join(root, "ffmpeg.exe"), ffprobePath: join(root, "ffprobe.exe"), manifestDir, buildVersion: "0.0.1", spawnImpl }).start();
      const args = spawnImpl.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--manifest-dir") + 1]).toBe(manifestDir);
    }
  });

  it("fails before spawn when the manifest path is missing or empty", async () => {
    const root = join(tmpdir(), `aivideo-missing-manifest-${Date.now()}`); const runtimeDir = join(root, "runtime"); const spawnImpl = vi.fn();
    const input = { executable: "aivs-core.exe", resourcesPath: root, dataDir: join(root, "data"), runtimeDir, ffmpegPath: join(root, "ffmpeg.exe"), ffprobePath: join(root, "ffprobe.exe"), manifestDir: join(root, "不存在 清单"), buildVersion: "0.0.1", spawnImpl };
    await expect(new SidecarSupervisor(input).start()).rejects.toThrow(/model manifest directory is invalid.*不存在 清单/);
    expect(spawnImpl).not.toHaveBeenCalled();
    mkdirSync(input.manifestDir, { recursive: true });
    await expect(new SidecarSupervisor(input).start()).rejects.toThrow(/no JSON manifest found/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

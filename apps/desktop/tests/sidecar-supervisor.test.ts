import { describe, expect, it, vi } from "vitest";
import { SidecarSupervisor } from "../electron/main/sidecar-supervisor.js";

describe("SidecarSupervisor", () => {
  it("starts with shell disabled and reads one valid READY line", async () => {
    const stdout = new (require("node:stream").PassThrough)();
    const stderr = new (require("node:stream").PassThrough)();
    const child = Object.assign(new (require("node:events").EventEmitter)(), { stdout, stderr, pid: 321, exitCode: null, kill: vi.fn() });
    const spawnImpl = vi.fn().mockReturnValue(child);
    const supervisor = new SidecarSupervisor({ executable: "aivs-core.exe", resourcesPath: "C:\\resources", dataDir: "C:\\data", runtimeDir: "C:\\runtime", ffmpegPath: "C:\\ffmpeg.exe", ffprobePath: "C:\\ffprobe.exe", buildVersion: "0.0.1", adminToken: "admin-secret", spawnImpl });
    const ready = supervisor.start();
    stdout.write('AIVS_READY {"protocol_version":1,"port":43000,"pid":321,"build_version":"0.0.1"}\n');
    await expect(ready).resolves.toMatchObject({ port: 43000 });
    expect(spawnImpl).toHaveBeenCalledWith("aivs-core.exe", expect.arrayContaining(["--host", "127.0.0.1", "--port", "0"]), expect.objectContaining({ shell: false, windowsHide: true, env: expect.objectContaining({ AIVS_ADMIN_TOKEN: "admin-secret" }) }));
    expect(JSON.stringify(spawnImpl.mock.calls[0][1])).not.toContain("admin-secret");
  });
});

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { parseSidecarReadyLine, type SidecarReady } from "@aivideo/contracts";

export interface SidecarLaunchOptions {
  executable: string;
  resourcesPath: string;
  dataDir: string;
  runtimeDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  buildVersion: string;
  adminToken?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export class SidecarStartupError extends Error {}

export class SidecarSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: SidecarReady;

  constructor(private readonly options: SidecarLaunchOptions) {}

  get process(): ChildProcessWithoutNullStreams | undefined { return this.child; }
  get endpoint(): string {
    if (!this.ready) throw new Error("Sidecar is not ready");
    return `http://127.0.0.1:${this.ready.port}`;
  }
  get sidecarReady(): SidecarReady | undefined { return this.ready; }

  async start(): Promise<SidecarReady> {
    if (this.child) throw new Error("Sidecar already started");
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const args = [
      "--host", "127.0.0.1", "--port", "0",
      "--parent-pid", String(process.pid), "--data-dir", this.options.dataDir,
      "--ffmpeg", this.options.ffmpegPath, "--ffprobe", this.options.ffprobePath,
      "--runtime-dir", this.options.runtimeDir, "--log-level", "info"
    ];
    const adminToken = this.options.adminToken ?? randomBytes(32).toString("hex");
    const child = spawnImpl(this.options.executable, args, {
      cwd: this.options.resourcesPath,
      env: { ...process.env, AIVS_ADMIN_TOKEN: adminToken },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdin?.end();
    const timeout = this.options.timeoutMs ?? 20_000;
    return new Promise<SidecarReady>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const finish = (error?: Error, value?: SidecarReady) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else if (value) resolve(value);
      };
      const timer = setTimeout(() => finish(new SidecarStartupError(`Sidecar startup timed out after ${timeout}ms`)), timeout);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("AIVS_READY ")) continue;
          try {
            const ready = parseSidecarReadyLine(line);
            if (ready.pid !== child.pid) throw new Error("Sidecar pid mismatch");
            this.ready = ready;
            finish(undefined, ready);
          } catch (error) { finish(new SidecarStartupError((error as Error).message)); }
        }
      });
      child.once("error", error => finish(new SidecarStartupError(error.message)));
      child.once("exit", (code, signal) => finish(new SidecarStartupError(`Sidecar exited before ready (${code ?? signal})`)));
    });
  }

  async stop(force = false): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (!child || child.exitCode !== null) return;
    if (force) { child.kill(); return; }
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
  }

  static packagedExecutable(resourcesPath: string): string {
    return join(resourcesPath, "core", "aivs-core", process.platform === "win32" ? "aivs-core.exe" : "aivs-core");
  }
}

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { SidecarReady } from "@aivideo/contracts";
import { appendLog } from "./logging.js";

export interface SidecarLaunchOptions {
  executable: string;
  executableArgs?: string[];
  resourcesPath: string;
  dataDir: string;
  runtimeDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  manifestDir: string;
  buildVersion: string;
  adminToken?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  logPath?: string;
  launchEvidencePath?: string;
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
    this.assertManifestDirectory();
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const readyFile = join(this.options.runtimeDir, "ready.json");
    await unlink(readyFile).catch(() => undefined);
    const args = [
      ...(this.options.executableArgs ?? []),
      "--host", "127.0.0.1", "--port", "0",
      "--parent-pid", String(process.pid), "--data-dir", this.options.dataDir,
      "--ffmpeg", this.options.ffmpegPath, "--ffprobe", this.options.ffprobePath,
      "--manifest-dir", this.options.manifestDir,
      "--runtime-dir", this.options.runtimeDir, "--ready-file", readyFile, "--log-level", "info"
    ];
    const adminToken = this.options.adminToken ?? randomBytes(32).toString("hex");
    mkdirSync(this.options.runtimeDir, { recursive: true });
    if (this.options.launchEvidencePath) {
      mkdirSync(dirname(this.options.launchEvidencePath), { recursive: true });
      writeFileSync(this.options.launchEvidencePath, `${JSON.stringify({ executable: this.options.executable, args, cwd: this.options.resourcesPath }, null, 2)}\n`, "utf8");
    }
    const child = spawnImpl(this.options.executable, args, {
      cwd: this.options.resourcesPath,
      env: { ...process.env, AIVS_ADMIN_TOKEN: adminToken, AIVS_RESOURCE_ROOT: this.options.resourcesPath },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child as unknown as ChildProcessWithoutNullStreams;
    const timeout = this.options.timeoutMs ?? 20_000;
    return new Promise<SidecarReady>((resolve, reject) => {
      let settled = false;
      let childExit: string | undefined;
      let fileTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, value?: SidecarReady) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fileTimer) clearTimeout(fileTimer);
        if (error) reject(error); else if (value) resolve(value);
      };
      const timer = setTimeout(() => finish(new SidecarStartupError((childExit ? childExit + "; " : "") + `Sidecar startup timed out after ${timeout}ms`)), timeout);
      const logCore = (stream: NodeJS.ReadableStream | null | undefined, level: string): void => {
        if (!stream || !this.options.logPath) return;
        let pending = "";
        stream.on("data", chunk => {
          pending += String(chunk);
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) void appendLog(this.options.logPath!, `[aivs-core] ${level} ${line}`);
        });
        stream.on("end", () => { if (pending.trim()) void appendLog(this.options.logPath!, `[aivs-core] ${level} ${pending}`); });
      };
      logCore(child.stdout, "stdout");
      logCore(child.stderr, "stderr");
      if (this.options.logPath) void appendLog(this.options.logPath, "[aivs-core] spawned with redacted stdio");
      child.once("error", error => { finish(new SidecarStartupError(error.message)); });
      child.once("exit", (code, signal) => {
        // PyInstaller/uvicorn may leave the serving child alive after the
        // launcher process exits. Keep polling ready.json until timeout so a
        // late but valid Core handshake is not discarded.
        childExit = `Sidecar launcher exited before ready (${code ?? signal})`;
      });
      const pollReadyFile = (): void => {
        if (settled) return;
        try {
          if (existsSync(readyFile)) {
            const ready = JSON.parse(readFileSync(readyFile, "utf8")) as SidecarReady;
            if (!Number.isInteger(ready.pid) || ready.pid <= 0) throw new Error("Invalid sidecar pid");
            if (this.options.logPath) void appendLog(this.options.logPath, `[aivs-core] ready file received ${readyFile}`);
            this.ready = ready;
            finish(undefined, ready);
            return;
          }
        } catch (error) {
          if (this.options.logPath) void appendLog(this.options.logPath, `[aivs-core] ready file check failed ${(error as Error).message}`);
        }
        fileTimer = setTimeout(pollReadyFile, 100);
      };
      fileTimer = setTimeout(pollReadyFile, 50);
    });
  }

  private assertManifestDirectory(): void {
    const manifestDir = this.options.manifestDir;
    try {
      if (!existsSync(manifestDir) || !statSync(manifestDir).isDirectory()) throw new Error("directory does not exist");
      if (!readdirSync(manifestDir, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))) throw new Error("no JSON manifest found");
    } catch (error) {
      throw new SidecarStartupError(`Sidecar model manifest directory is invalid: ${manifestDir} (${(error as Error).message})`);
    }
  }

  private async waitForHttpReady(ready: SidecarReady, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "unknown error";
    while (Date.now() < deadline) {
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest({ hostname: "127.0.0.1", port: ready.port, path: "/api/v1/health", method: "GET" }, response => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          });
          req.setTimeout(1000, () => req.destroy(new Error("health request timed out")));
          req.once("error", reject);
          req.end();
        });
        if (status === 200) return;
        lastError = `health status ${status}`;
      } catch (error) {
        lastError = (error as Error).message;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Core HTTP readiness timed out: ${lastError}`);
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

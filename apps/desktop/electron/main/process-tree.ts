import { execFile } from "node:child_process";

export function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      process.kill(pid, "SIGTERM");
      resolve();
      return;
    }
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, error => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERRORLEVEL_128") reject(error);
      else resolve();
    });
  });
}

import type { CoreHealth, RendererSession } from "@aivideo/contracts";
import { request as httpRequest } from "node:http";

export class CoreHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export class CoreAdminClient {
  constructor(private readonly baseUrl: string, private readonly adminToken: string) {}

  async ready(): Promise<void> {
    const result = await this.rawRequest("/api/v1/health");
    if (result.status < 200 || result.status >= 300) throw new CoreHttpError(result.status, `Core readiness failed: ${result.status}`);
  }

  private rawRequest(path: string, method = "GET", body?: string): Promise<{ status: number; data: string }> {
    const url = new URL(path, this.baseUrl);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers: { Authorization: `Bearer ${this.adminToken}`, ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, response => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { data += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, data }));
      });
      req.setTimeout(5_000, () => req.destroy(new Error(`Core request timed out: ${method} ${path}`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = typeof init.body === "string" ? init.body : undefined;
    const result = await this.rawRequest(path, init.method ?? (body ? "POST" : "GET"), body);
    if (result.status < 200 || result.status >= 300) throw new CoreHttpError(result.status, `Core request failed: ${result.status}`);
    return JSON.parse(result.data) as T;
  }

  health(): Promise<CoreHealth> {
    return this.request<CoreHealth>("/api/v1/internal/health");
  }

  createSession(): Promise<RendererSession> {
    return this.request<RendererSession>("/api/v1/internal/sessions", { method: "POST" });
  }

  registerFile(path: string) {
    return this.request("/api/v1/internal/file-grants", { method: "POST", body: JSON.stringify({ path }) });
  }

  resolveArtifact(artifactId: string) {
    return this.request<{ path: string }>(`/api/v1/internal/artifacts/${encodeURIComponent(artifactId)}/resolve`);
  }

  async shutdown(): Promise<void> {
    await this.request("/api/v1/internal/shutdown", { method: "POST" });
  }
}

import { isApiErrorResponse, parseDestinationGrant, parseFileGrant, type ApiError, type CoreHealth, type DestinationGrant, type FileGrant, type RendererSession } from "@aivideo/contracts";
import { request as httpRequest } from "node:http";

export class CoreHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "INTERNAL_ERROR", public readonly traceId?: string) {
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
    if (result.status < 200 || result.status >= 300) {
      let apiError: ApiError | undefined;
      try {
        const parsed: unknown = JSON.parse(result.data);
        if (isApiErrorResponse(parsed)) apiError = parsed.error;
      } catch { /* preserve the HTTP status when Core did not return JSON */ }
      throw new CoreHttpError(result.status, apiError?.message ?? `Core request failed: ${result.status}`, apiError?.code ?? statusCode(result.status), apiError?.trace_id);
    }
    return JSON.parse(result.data) as T;
  }

  health(): Promise<CoreHealth> {
    return this.request<CoreHealth>("/api/v1/internal/health");
  }

  createSession(): Promise<RendererSession> {
    return this.request<RendererSession>("/api/v1/internal/sessions", { method: "POST" });
  }

  registerFile(path: string): Promise<FileGrant> {
    return this.request<unknown>("/api/v1/internal/file-grants", { method: "POST", body: JSON.stringify({ path }) }).then(parseFileGrant);
  }

  createDestinationGrant(path: string, overwriteAuthorized: boolean): Promise<DestinationGrant> {
    return this.request<unknown>("/api/v1/internal/destination-grants", { method: "POST", body: JSON.stringify({ path, overwrite_authorized: overwriteAuthorized }) }).then(parseDestinationGrant);
  }

  resolveArtifact(artifactId: string) {
    return this.request<{ path: string }>(`/api/v1/internal/artifacts/${encodeURIComponent(artifactId)}/resolve`);
  }

  resolveAsset(assetId: string) {
    return this.request<{ path: string }>(`/api/v1/internal/assets/${encodeURIComponent(assetId)}/resolve`);
  }

  async shutdown(): Promise<void> {
    await this.request("/api/v1/internal/shutdown", { method: "POST" });
  }
}

function statusCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "INTERNAL_ERROR";
}

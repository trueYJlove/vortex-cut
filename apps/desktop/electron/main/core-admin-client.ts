import { isApiErrorResponse, parseDestinationGrant, parseDirectoryGrant, parseFileGrant, type ApiError, type CoreHealth, type DestinationGrant, type DirectoryGrant, type FileGrant, type RendererSession } from "@aivideo/contracts";
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

  createDirectoryGrant(path: string): Promise<DirectoryGrant> {
    return this.request<unknown>("/api/v1/internal/directory-grants", { method: "POST", body: JSON.stringify({ path }) }).then(parseDirectoryGrant);
  }

  resolveArtifact(artifactId: string) {
    return this.request<{ path: string }>(`/api/v1/internal/artifacts/${encodeURIComponent(artifactId)}/resolve`);
  }

  resolveAsset(assetId: string) {
    return this.request<{ path: string }>(`/api/v1/internal/assets/${encodeURIComponent(assetId)}/resolve`);
  }

  /** B10：派生媒体 Main 内部解析（admin 通道；path 只到 Main，不进 Renderer）。 */
  resolveDerivedMedia(input: { project_id: string; asset_id: string; kind: string; params: Record<string, string> }) {
    return this.request<{ cache_key: string; kind: string; status: string; path: string; size_bytes: number }>(
      `/api/v1/internal/projects/${encodeURIComponent(input.project_id)}/derived-media/resolve`,
      { method: "POST", body: JSON.stringify({ asset_id: input.asset_id, kind: input.kind, params: input.params }) },
    );
  }

  /** B11：代理文件 Main 内部解析（admin 通道；path 只到 Main，不进 Renderer）。 */
  resolvePreviewSourceMedia(input: { project_id: string; asset_id: string; profile_id: string }) {
    return this.request<{ cache_key: string; status: string; path: string; size_bytes: number }>(
      `/api/v1/internal/projects/${encodeURIComponent(input.project_id)}/assets/${encodeURIComponent(input.asset_id)}/preview-source/media`,
      { method: "POST", body: JSON.stringify({ asset_id: input.asset_id, profile_id: input.profile_id }) },
    );
  }

  /** B14：波形文件 Main 内部解析（admin 通道；参数服务端固定，无请求体）。 */
  resolveWaveformMedia(input: { project_id: string; asset_id: string }) {
    return this.request<{ cache_key: string; status: string; path: string; size_bytes: number }>(
      `/api/v1/internal/projects/${encodeURIComponent(input.project_id)}/assets/${encodeURIComponent(input.asset_id)}/waveform/media`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  /** B15：PCM 块文件 Main 内部解析（admin 通道）。 */
  resolvePcmChunkMedia(input: { project_id: string; asset_id: string; start_sample: number }) {
    return this.request<{ cache_key: string; status: string; path: string; size_bytes: number }>(
      `/api/v1/internal/projects/${encodeURIComponent(input.project_id)}/assets/${encodeURIComponent(input.asset_id)}/pcm-chunks/media`,
      { method: "POST", body: JSON.stringify({ start_sample: input.start_sample }) },
    );
  }

  /** B16b：编辑器负载心跳（admin 通道；TTL 3s——无心跳即 idle）。 */
  reportEditorLoadLease(input: { window_id: string; mode: "playing" | "scrubbing" | "idle" }) {
    return this.request<{ status: string; mode: string; ttl_s: number }>(
      "/api/v1/internal/editor-load-lease",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  setProviderSecret(providerConfigId: string, secret: string): Promise<{ provider_config_id: string; credential_status: string }> {
    return this.request(`/api/v1/internal/provider-secrets/${encodeURIComponent(providerConfigId)}`, { method: "PUT", body: JSON.stringify({ secret }) });
  }

  async deleteProviderSecret(providerConfigId: string): Promise<void> {
    await this.request(`/api/v1/internal/provider-secrets/${encodeURIComponent(providerConfigId)}`, { method: "DELETE" });
  }

  setImageProviderSecret(providerConfigId: string, secret: string): Promise<{ provider_config_id: string; credential_status: string }> {
    return this.request(`/api/v1/internal/image-provider-configs/${encodeURIComponent(providerConfigId)}/secret`, { method: "PUT", body: JSON.stringify({ secret }) });
  }

  async deleteImageProviderSecret(providerConfigId: string): Promise<void> {
    await this.request(`/api/v1/internal/image-provider-configs/${encodeURIComponent(providerConfigId)}/secret`, { method: "DELETE" });
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

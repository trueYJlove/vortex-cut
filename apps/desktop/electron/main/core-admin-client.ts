import type { CoreHealth, RendererSession } from "@aivideo/contracts";

export class CoreHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export class CoreAdminClient {
  constructor(private readonly baseUrl: string, private readonly adminToken: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    if (!response.ok) throw new CoreHttpError(response.status, `Core request failed: ${response.status}`);
    return (await response.json()) as T;
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

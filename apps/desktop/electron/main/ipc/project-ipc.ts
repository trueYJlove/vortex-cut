import type { ProjectId } from "@aivideo/contracts";
import { API_PREFIX, asId, buildQuery, type FetchWithUi, type IpcHandle } from "./shared.js";

export interface ProjectIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: FetchWithUi;
}

/** Register project CRUD and lifecycle IPC handlers. */
export function registerProjectIpc({ handle, fetchWithUi }: ProjectIpcDependencies): void {
  handle("project:list", (_event, params: { status?: string; limit?: number; cursor?: string } = {}) => fetchWithUi(`${API_PREFIX}/projects${buildQuery(params)}`));
  handle("project:create", (_event, input: { name: string; root_dir_name?: string }) => {
    if (typeof input?.name !== "string") throw new Error("Project name is required");
    return fetchWithUi(`${API_PREFIX}/projects`, { method: "POST", body: JSON.stringify(input) });
  });
  handle("project:get", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}`));
  handle("project:rename", (_event, input: { project_id: ProjectId; name: string }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}`, { method: "PATCH", body: JSON.stringify({ name: input.name }) }));
  handle("project:archive", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/archive`, { method: "POST" }));
  handle("project:reopen", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/reopen`, { method: "POST" }));
}

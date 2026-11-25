import type {
  ProjectId,
  TimelineCreateInput,
  TimelineDraftInput,
  TimelinePatch,
  TimelineRevisionId,
} from "@aivideo/contracts";
import { API_PREFIX, asId, buildQuery, rendererSafe, type FetchWithUi, type IpcHandle } from "./shared.js";

export interface TimelineIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: FetchWithUi;
}

/** Register timeline document CRUD, patch, undo/redo, draft, and revision IPC handlers. */
export function registerTimelineIpc({ handle, fetchWithUi }: TimelineIpcDependencies): void {
  handle("timeline:create", (_event, input: { project_id: ProjectId; timeline: TimelineCreateInput }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timelines`, { method: "POST", body: JSON.stringify(input.timeline) }).then(rendererSafe));
  handle("timeline:get", (_event, projectId: ProjectId) => fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/timeline`).then(rendererSafe));
  handle("timeline:patch", (_event, input: { project_id: ProjectId; patch: TimelinePatch }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/patches`, { method: "POST", body: JSON.stringify(input.patch) }).then(rendererSafe));
  handle("timeline:undo", (_event, input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/undo`, { method: "POST", body: JSON.stringify({ base_revision_id: asId(input.base_revision_id, "timeline_revision_id") }) }).then(rendererSafe));
  handle("timeline:redo", (_event, input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/redo`, { method: "POST", body: JSON.stringify({ base_revision_id: asId(input.base_revision_id, "timeline_revision_id") }) }).then(rendererSafe));
  handle("timeline:draft-save", (_event, input: { project_id: ProjectId; draft: TimelineDraftInput }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/draft`, { method: "PUT", body: JSON.stringify(input.draft) }).then(rendererSafe));
  handle("timeline:draft-delete", async (_event, projectId: ProjectId) => { await fetchWithUi(`${API_PREFIX}/projects/${asId(projectId, "project_id")}/timeline/draft`, { method: "DELETE" }); });
  handle("timeline:revisions", (_event, input: { project_id: ProjectId; limit?: number; cursor?: string }) => fetchWithUi(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/timeline/revisions${buildQuery(input, ["project_id"])}`).then(rendererSafe));
  handle("timeline:revision", (_event, revisionId: TimelineRevisionId) => fetchWithUi(`${API_PREFIX}/timeline-revisions/${asId(revisionId, "timeline_revision_id")}`).then(rendererSafe));
}

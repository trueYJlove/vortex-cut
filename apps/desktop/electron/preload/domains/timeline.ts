import { ipcRenderer } from "electron";
import type {
  ProjectId,
  TimelineCreateInput,
  TimelineDraft,
  TimelineDraftInput,
  TimelinePatch,
  TimelineRevision,
  TimelineRevisionId,
  TimelineRevisionPage,
  TimelineState,
} from "@aivideo/contracts";

export interface TimelinePreloadApi {
  createTimeline: (input: { project_id: ProjectId; timeline: TimelineCreateInput }) => Promise<TimelineState>;
  getTimeline: (projectId: ProjectId) => Promise<TimelineState>;
  patchTimeline: (input: { project_id: ProjectId; patch: TimelinePatch }) => Promise<TimelineState>;
  undoTimeline: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => Promise<TimelineState>;
  redoTimeline: (input: { project_id: ProjectId; base_revision_id: TimelineRevisionId }) => Promise<TimelineState>;
  saveTimelineDraft: (input: { project_id: ProjectId; draft: TimelineDraftInput }) => Promise<TimelineDraft>;
  deleteTimelineDraft: (projectId: ProjectId) => Promise<void>;
  listTimelineRevisions: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<TimelineRevisionPage>;
  getTimelineRevision: (revisionId: TimelineRevisionId) => Promise<TimelineRevision>;
}

export function createTimelinePreloadApi(): TimelinePreloadApi {
  return {
    createTimeline: input => ipcRenderer.invoke("timeline:create", input),
    getTimeline: projectId => ipcRenderer.invoke("timeline:get", projectId),
    patchTimeline: input => ipcRenderer.invoke("timeline:patch", input),
    undoTimeline: input => ipcRenderer.invoke("timeline:undo", input),
    redoTimeline: input => ipcRenderer.invoke("timeline:redo", input),
    saveTimelineDraft: input => ipcRenderer.invoke("timeline:draft-save", input),
    deleteTimelineDraft: projectId => ipcRenderer.invoke("timeline:draft-delete", projectId),
    listTimelineRevisions: input => ipcRenderer.invoke("timeline:revisions", input),
    getTimelineRevision: revisionId => ipcRenderer.invoke("timeline:revision", revisionId),
  };
}

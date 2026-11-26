import { ipcRenderer } from "electron";
import type {
  ImageProviderConfigCreateInput,
  ImageProviderConfigPage,
  ImageProviderConfigSummary,
  MediaGenerationCreateInput,
  MediaGenerationCreateResponse,
  MediaGenerationPrepareInput,
  MediaGenerationPreparedRequest,
  MediaGenerationRequest,
  MediaGenerationRequestId,
  MediaGenerationRequestPage,
  MediaGenerationTask,
  MediaGenerationTaskId,
  MediaGenerationTaskPage,
  ProjectId,
  ProviderImageGenerationCreateInput,
  ProviderImageGenerationCreateResponse,
  ProviderImageGenerationPrepareInput,
  ProviderImageGenerationPreparedPreview,
  ProviderImageGenerationRequest,
  ProviderImageGenerationRequestPage,
  ProviderImageGenerationRetryPrepareInput,
  ProviderImageGenerationTask,
  ProviderImageGenerationTaskPage,
  ShotListConfirmInput,
  ShotListConfirmResponse,
  ShotListRevisionCreateInput,
  ShotListRevisionCreateResponse,
  ShotListRevisionDetail,
  ShotListRevisionId,
  ShotListRevisionPage,
  ShotListState,
  ShotRequirementId,
  ShotRequirementImageAdoptInput,
  ShotRequirementImageAdoptResponse,
  ShotRequirementImageAdoptionPage,
  ShotRequirementImageFulfillmentCreateInput,
  ShotRequirementImageFulfillmentCreateResponse,
  ShotRequirementImageFulfillmentPrepareInput,
  ShotRequirementImageFulfillmentPreparedPreview,
  ShotRequirementImageFulfillmentState,
  ShotRequirementImageGenerationLinkPage,
  ShotRequirementTimelineAssembly,
  ShotRequirementTimelineAssemblyApplyInput,
  ShotRequirementTimelineAssemblyApplyResponse,
  ShotRequirementTimelineAssemblyId,
  ShotRequirementTimelineAssemblyPage,
  ShotRequirementTimelineAssemblyPrepareInput,
  ShotRequirementTimelineAssemblyPreview,
  ShotRequirementTimelineAssemblyPreviewId,
  ShotRequirementTimelineBatchAssembly,
  ShotRequirementTimelineBatchAssemblyApplyInput,
  ShotRequirementTimelineBatchAssemblyApplyResponse,
  ShotRequirementTimelineBatchAssemblyId,
  ShotRequirementTimelineBatchAssemblyItemPage,
  ShotRequirementTimelineBatchAssemblyPage,
  ShotRequirementTimelineBatchAssemblyPrepareInput,
  ShotRequirementTimelineBatchAssemblyPreview,
  ShotRequirementTimelineBatchAssemblyPreviewId,
} from "@aivideo/contracts";

export interface GenerationShotPreloadApi {
  prepareMediaGeneration: (input: { project_id: ProjectId; request: MediaGenerationPrepareInput }) => Promise<MediaGenerationPreparedRequest>;
  createMediaGeneration: (input: { project_id: ProjectId; request: MediaGenerationCreateInput }) => Promise<MediaGenerationCreateResponse>;
  listMediaGenerationRequests: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<MediaGenerationRequestPage>;
  getMediaGenerationRequest: (requestId: MediaGenerationRequestId) => Promise<MediaGenerationRequest>;
  listMediaGenerationTasks: (input: { request_id: MediaGenerationRequestId; limit?: number; cursor?: string }) => Promise<MediaGenerationTaskPage>;
  retryMediaGenerationTask: (taskId: MediaGenerationTaskId) => Promise<MediaGenerationTask>;
  cancelMediaGenerationTask: (taskId: MediaGenerationTaskId) => Promise<MediaGenerationTask>;
  listImageProviderConfigs: (projectId: ProjectId) => Promise<ImageProviderConfigPage>;
  createImageProviderConfig: (input: { project_id: ProjectId; config: ImageProviderConfigCreateInput }) => Promise<ImageProviderConfigSummary>;
  setImageProviderSecret: (input: { provider_config_id: string; secret: string }) => Promise<{ provider_config_id: string; credential_status: "configured" }>;
  deleteImageProviderSecret: (providerConfigId: string) => Promise<{ provider_config_id: string; credential_status: "missing" }>;
  prepareProviderImageGeneration: (input: { project_id: ProjectId; request: ProviderImageGenerationPrepareInput }) => Promise<ProviderImageGenerationPreparedPreview>;
  createProviderImageGeneration: (input: { project_id: ProjectId; request: ProviderImageGenerationCreateInput }) => Promise<ProviderImageGenerationCreateResponse>;
  listProviderImageGenerationRequests: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ProviderImageGenerationRequestPage>;
  getProviderImageGenerationRequest: (requestId: MediaGenerationRequestId) => Promise<ProviderImageGenerationRequest>;
  listProviderImageGenerationTasks: (input: { request_id: MediaGenerationRequestId; limit?: number; cursor?: string }) => Promise<ProviderImageGenerationTaskPage>;
  prepareProviderImageGenerationRetry: (input: { task_id: MediaGenerationTaskId; request: ProviderImageGenerationRetryPrepareInput }) => Promise<ProviderImageGenerationPreparedPreview>;
  retryProviderImageGenerationTask: (input: { task_id: MediaGenerationTaskId; request: ProviderImageGenerationCreateInput }) => Promise<ProviderImageGenerationTask>;
  cancelProviderImageGenerationTask: (taskId: MediaGenerationTaskId) => Promise<ProviderImageGenerationTask>;
  getShotList: (projectId: ProjectId) => Promise<ShotListState>;
  listShotListRevisions: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ShotListRevisionPage>;
  getShotListRevision: (revisionId: ShotListRevisionId) => Promise<ShotListRevisionDetail>;
  createShotListRevision: (input: { project_id: ProjectId; revision: ShotListRevisionCreateInput }) => Promise<ShotListRevisionCreateResponse>;
  confirmShotListRevision: (input: { project_id: ProjectId; confirmation: ShotListConfirmInput }) => Promise<ShotListConfirmResponse>;
  getShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId }) => Promise<ShotRequirementImageFulfillmentState>;
  listShotRequirementImageFulfillmentLinks: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementImageGenerationLinkPage>;
  listShotRequirementImageFulfillmentAdoptions: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementImageAdoptionPage>;
  prepareShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageFulfillmentPrepareInput }) => Promise<ShotRequirementImageFulfillmentPreparedPreview>;
  createShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageFulfillmentCreateInput }) => Promise<ShotRequirementImageFulfillmentCreateResponse>;
  adoptShotRequirementImageFulfillment: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementImageAdoptInput }) => Promise<ShotRequirementImageAdoptResponse>;
  prepareShotRequirementTimelineAssembly: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementTimelineAssemblyPrepareInput }) => Promise<ShotRequirementTimelineAssemblyPreview>;
  applyShotRequirementTimelineAssembly: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; request: ShotRequirementTimelineAssemblyApplyInput }) => Promise<ShotRequirementTimelineAssemblyApplyResponse>;
  getShotRequirementTimelineAssemblyPreview: (input: { preview_id: ShotRequirementTimelineAssemblyPreviewId }) => Promise<ShotRequirementTimelineAssemblyPreview>;
  getShotRequirementTimelineAssembly: (input: { assembly_id: ShotRequirementTimelineAssemblyId }) => Promise<ShotRequirementTimelineAssembly>;
  listShotRequirementTimelineAssemblies: (input: { project_id: ProjectId; requirement_id: ShotRequirementId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineAssemblyPage>;
  prepareShotRequirementTimelineBatchAssembly: (input: { project_id: ProjectId; request: ShotRequirementTimelineBatchAssemblyPrepareInput }) => Promise<ShotRequirementTimelineBatchAssemblyPreview>;
  applyShotRequirementTimelineBatchAssembly: (input: { project_id: ProjectId; request: ShotRequirementTimelineBatchAssemblyApplyInput }) => Promise<ShotRequirementTimelineBatchAssemblyApplyResponse>;
  getShotRequirementTimelineBatchAssemblyPreview: (input: { preview_id: ShotRequirementTimelineBatchAssemblyPreviewId }) => Promise<ShotRequirementTimelineBatchAssemblyPreview>;
  getShotRequirementTimelineBatchAssembly: (input: { batch_id: ShotRequirementTimelineBatchAssemblyId }) => Promise<ShotRequirementTimelineBatchAssembly>;
  listShotRequirementTimelineBatches: (input: { project_id: ProjectId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineBatchAssemblyPage>;
  listShotRequirementTimelineBatchAssemblyItems: (input: { batch_id: ShotRequirementTimelineBatchAssemblyId; limit?: number; cursor?: string }) => Promise<ShotRequirementTimelineBatchAssemblyItemPage>;
}

export function createGenerationShotPreloadApi(): GenerationShotPreloadApi {
  return {
    prepareMediaGeneration: input => ipcRenderer.invoke("media-generation:prepare", input),
    createMediaGeneration: input => ipcRenderer.invoke("media-generation:create", input),
    listMediaGenerationRequests: input => ipcRenderer.invoke("media-generation:list", input),
    getMediaGenerationRequest: requestId => ipcRenderer.invoke("media-generation:get", requestId),
    listMediaGenerationTasks: input => ipcRenderer.invoke("media-generation:tasks", input),
    retryMediaGenerationTask: taskId => ipcRenderer.invoke("media-generation:retry", taskId),
    cancelMediaGenerationTask: taskId => ipcRenderer.invoke("media-generation:cancel", taskId),
    listImageProviderConfigs: projectId => ipcRenderer.invoke("provider-image-config:list", { project_id: projectId }),
    createImageProviderConfig: input => ipcRenderer.invoke("provider-image-config:create", input),
    setImageProviderSecret: input => ipcRenderer.invoke("provider-image-config:set-secret", input),
    deleteImageProviderSecret: providerConfigId => ipcRenderer.invoke("provider-image-config:delete-secret", providerConfigId),
    prepareProviderImageGeneration: input => ipcRenderer.invoke("provider-image-generation:prepare", input),
    createProviderImageGeneration: input => ipcRenderer.invoke("provider-image-generation:create", input),
    listProviderImageGenerationRequests: input => ipcRenderer.invoke("provider-image-generation:list", input),
    getProviderImageGenerationRequest: requestId => ipcRenderer.invoke("provider-image-generation:get", requestId),
    listProviderImageGenerationTasks: input => ipcRenderer.invoke("provider-image-generation:tasks", input),
    prepareProviderImageGenerationRetry: input => ipcRenderer.invoke("provider-image-generation:retry-prepare", input),
    retryProviderImageGenerationTask: input => ipcRenderer.invoke("provider-image-generation:retry", input),
    cancelProviderImageGenerationTask: taskId => ipcRenderer.invoke("provider-image-generation:cancel", taskId),
    getShotList: projectId => ipcRenderer.invoke("shot-list:get", projectId),
    listShotListRevisions: input => ipcRenderer.invoke("shot-list:revisions", input),
    getShotListRevision: revisionId => ipcRenderer.invoke("shot-list:revision:get", revisionId),
    createShotListRevision: input => ipcRenderer.invoke("shot-list:revision:create", input),
    confirmShotListRevision: input => ipcRenderer.invoke("shot-list:confirm", input),
    getShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:get", input),
    listShotRequirementImageFulfillmentLinks: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:list-links", input),
    listShotRequirementImageFulfillmentAdoptions: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:list-adoptions", input),
    prepareShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:prepare", input),
    createShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:create", input),
    adoptShotRequirementImageFulfillment: input => ipcRenderer.invoke("shot-requirement-image-fulfillment:adopt", input),
    prepareShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-prepare", input),
    applyShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-apply", input),
    getShotRequirementTimelineAssemblyPreview: input => ipcRenderer.invoke("stage5:assembly-preview-get", input),
    getShotRequirementTimelineAssembly: input => ipcRenderer.invoke("stage5:assembly-get", input),
    listShotRequirementTimelineAssemblies: input => ipcRenderer.invoke("stage5:assembly-list", input),
    prepareShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-prepare", input),
    applyShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-apply", input),
    getShotRequirementTimelineBatchAssemblyPreview: input => ipcRenderer.invoke("stage6r:batch-assembly-preview-get", input),
    getShotRequirementTimelineBatchAssembly: input => ipcRenderer.invoke("stage6r:batch-assembly-get", input),
    listShotRequirementTimelineBatches: input => ipcRenderer.invoke("stage6r:batch-assembly-list", input),
    listShotRequirementTimelineBatchAssemblyItems: input => ipcRenderer.invoke("stage6r:batch-assembly-item-list", input),
  };
}

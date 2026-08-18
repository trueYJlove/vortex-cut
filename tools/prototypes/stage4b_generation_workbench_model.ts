export type GenerationKind = "image" | "tts";
export type GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type ImageParameters = { width: number; height: number; style_preset_id?: string; seed?: number };
export type TtsParameters = { voice_preset_id: string; language: "zh-CN" | "en-US"; speed_milli: number };
export type GenerationDraft =
  | { generation_kind: "image"; prompt: string; input_refs: string[]; parameters: ImageParameters }
  | { generation_kind: "tts"; prompt: string; input_refs: string[]; parameters: TtsParameters };

export type PreparedRequest = {
  schema_version: 1;
  project_id: string;
  generation_kind: GenerationKind;
  execution_mode: "simulation_only";
  prompt_sha256: string;
  input_refs: string[];
  parameters: ImageParameters | TtsParameters;
  request_sha256: string;
};

export type RequestRecord = Omit<PreparedRequest, "schema_version"> & {
  request_id: string;
  created_at: string;
};

export type TaskRecord = {
  task_id: string;
  request_id: string;
  job_id: string;
  attempt: number;
  status: GenerationStatus;
  stage: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  retry_of_task_id: string | null;
  output_asset_id: null;
  output_sha256: null;
  result_summary: null | {
    execution_mode: "simulation_only";
    outcome: "validated_without_media";
    provider_call_count: 0;
  };
  error: null | { code: string; message: string };
};

export type CreateResponse = { request: RequestRecord; task: TaskRecord; reused: boolean };
export type Page<T> = { items: T[]; next_cursor: string | null };

export interface WorkbenchDesktopApi {
  prepare(projectId: string, draft: GenerationDraft): Promise<PreparedRequest>;
  create(projectId: string, input: GenerationDraft & { request_sha256: string }): Promise<CreateResponse>;
  listRequests(projectId: string): Promise<Page<RequestRecord>>;
  listTasks(requestId: string): Promise<Page<TaskRecord>>;
  cancel(taskId: string): Promise<TaskRecord>;
  retry(taskId: string): Promise<TaskRecord>;
  subscribeJob(jobId: string, listener: () => void): () => void;
}

const TERMINAL = new Set<GenerationStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const SAFE_ERROR = "操作未完成，请刷新后重试。";

function cloneDraft(draft: GenerationDraft): GenerationDraft {
  return JSON.parse(JSON.stringify(draft)) as GenerationDraft;
}

function clonePrepared(value: PreparedRequest): PreparedRequest {
  return JSON.parse(JSON.stringify(value)) as PreparedRequest;
}

export class Stage4BWorkbenchPrototype {
  private projectId: string | null = null;
  private assetIds = new Set<string>();
  private draft: GenerationDraft | null = null;
  private draftRevision = 0;
  private prepared: { value: PreparedRequest; revision: number; draft: GenerationDraft } | null = null;
  private epoch = 0;
  private selectedRequestId: string | null = null;
  private subscriptions = new Map<string, () => void>();
  private errorMessage: string | null = null;

  requests: RequestRecord[] = [];
  tasks: TaskRecord[] = [];
  lastCreate: { request_id: string; task_id: string; reused: boolean } | null = null;

  constructor(private readonly api: WorkbenchDesktopApi) {}

  open(projectId: string, currentProjectAssetIds: string[]): void {
    this.resetTransient();
    this.projectId = projectId;
    this.assetIds = new Set(currentProjectAssetIds);
    this.epoch += 1;
  }

  close(): void {
    this.stopSubscriptions();
    this.resetTransient();
    this.projectId = null;
    this.assetIds.clear();
    this.requests = [];
    this.tasks = [];
    this.selectedRequestId = null;
    this.epoch += 1;
  }

  switchProject(projectId: string, currentProjectAssetIds: string[]): void {
    this.close();
    this.open(projectId, currentProjectAssetIds);
  }

  setDraft(draft: GenerationDraft): void {
    this.assertDraft(draft);
    this.draft = cloneDraft(draft);
    this.draftRevision += 1;
    this.prepared = null;
    this.errorMessage = null;
  }

  async prepare(): Promise<void> {
    const projectId = this.requireProject();
    const draft = this.requireDraft();
    const revision = this.draftRevision;
    const epoch = this.epoch;
    try {
      const value = await this.api.prepare(projectId, cloneDraft(draft));
      if (epoch !== this.epoch || revision !== this.draftRevision || projectId !== this.projectId) return;
      this.prepared = { value: clonePrepared(value), revision, draft: cloneDraft(draft) };
      this.errorMessage = null;
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  confirmation(): Record<string, unknown> | null {
    if (!this.prepared || this.prepared.revision !== this.draftRevision) return null;
    const value = this.prepared.value;
    return {
      generation_kind: value.generation_kind,
      execution_mode: value.execution_mode,
      prompt_character_count: this.prepared.draft.prompt.length,
      prompt_sha256: value.prompt_sha256,
      input_ref_count: value.input_refs.length,
      parameters: JSON.parse(JSON.stringify(value.parameters)),
      request_sha256: value.request_sha256,
      provider_call_count: 0,
      outcome: "will_validate_without_media",
    };
  }

  async create(): Promise<void> {
    const projectId = this.requireProject();
    if (!this.prepared || this.prepared.revision !== this.draftRevision) throw new Error("CONFIRMATION_REQUIRED");
    const epoch = this.epoch;
    const command = { ...cloneDraft(this.prepared.draft), request_sha256: this.prepared.value.request_sha256 };
    try {
      const created = await this.api.create(projectId, command);
      if (epoch !== this.epoch || projectId !== this.projectId) return;
      this.draft = null;
      this.prepared = null;
      this.draftRevision += 1;
      this.lastCreate = {
        request_id: created.request.request_id,
        task_id: created.task.task_id,
        reused: created.reused,
      };
      this.selectedRequestId = created.request.request_id;
      this.errorMessage = null;
      await this.refreshTasks(created.request.request_id, epoch);
      const current = this.tasks.find(item => item.task_id === created.task.task_id) ?? created.task;
      if (!TERMINAL.has(current.status)) {
        this.subscribe(current.job_id, created.request.request_id, epoch);
        await this.refreshTasks(created.request.request_id, epoch);
      }
    } catch {
      if (epoch === this.epoch) {
        this.prepared = null;
        this.errorMessage = SAFE_ERROR;
      }
    }
  }

  async loadHistory(): Promise<void> {
    const projectId = this.requireProject();
    const epoch = this.epoch;
    try {
      const page = await this.api.listRequests(projectId);
      if (epoch === this.epoch && projectId === this.projectId) this.requests = page.items;
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  async selectRequest(requestId: string): Promise<void> {
    const epoch = this.epoch;
    this.selectedRequestId = requestId;
    await this.refreshTasks(requestId, epoch);
  }

  async pollActive(): Promise<void> {
    if (!this.selectedRequestId || !this.tasks.some(item => !TERMINAL.has(item.status))) return;
    await this.refreshTasks(this.selectedRequestId, this.epoch);
    if (!this.tasks.some(item => !TERMINAL.has(item.status))) this.stopSubscriptions();
  }

  async cancel(taskId: string): Promise<void> {
    const target = this.tasks.find(item => item.task_id === taskId);
    if (!target || !["queued", "running"].includes(target.status)) throw new Error("CANCEL_NOT_ALLOWED");
    const epoch = this.epoch;
    try {
      await this.api.cancel(taskId);
      if (this.selectedRequestId) await this.refreshTasks(this.selectedRequestId, epoch);
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  async retry(taskId: string): Promise<void> {
    const target = this.tasks.find(item => item.task_id === taskId);
    if (!target || !["failed", "cancelled", "interrupted"].includes(target.status)) throw new Error("RETRY_NOT_ALLOWED");
    const epoch = this.epoch;
    try {
      const task = await this.api.retry(taskId);
      if (this.selectedRequestId) {
        await this.refreshTasks(this.selectedRequestId, epoch);
        if (epoch === this.epoch && !TERMINAL.has(task.status)) {
          this.subscribe(task.job_id, this.selectedRequestId, epoch);
          await this.refreshTasks(this.selectedRequestId, epoch);
        }
      }
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  safeEvidence(): Record<string, unknown> {
    return {
      project_selected: this.projectId !== null,
      prepared: this.prepared !== null,
      request_count: this.requests.length,
      task_statuses: this.tasks.map(item => item.status),
      last_create: this.lastCreate,
      provider_call_count: 0,
      media_created: false,
      asset_registered: false,
      error: this.errorMessage,
    };
  }

  private async refreshTasks(requestId: string, epoch: number): Promise<void> {
    try {
      const page = await this.api.listTasks(requestId);
      if (epoch !== this.epoch || requestId !== this.selectedRequestId) return;
      this.tasks = page.items;
      if (!this.tasks.some(item => !TERMINAL.has(item.status))) this.stopSubscriptions();
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  private subscribe(jobId: string, requestId: string, epoch: number): void {
    if (this.subscriptions.has(jobId)) return;
    const stop = this.api.subscribeJob(jobId, () => {
      if (epoch === this.epoch && requestId === this.selectedRequestId) void this.refreshTasks(requestId, epoch);
    });
    this.subscriptions.set(jobId, stop);
  }

  private stopSubscriptions(): void {
    for (const stop of this.subscriptions.values()) stop();
    this.subscriptions.clear();
  }

  private resetTransient(): void {
    this.draft = null;
    this.prepared = null;
    this.draftRevision += 1;
    this.errorMessage = null;
    this.lastCreate = null;
  }

  private requireProject(): string {
    if (!this.projectId) throw new Error("PROJECT_REQUIRED");
    return this.projectId;
  }

  private requireDraft(): GenerationDraft {
    if (!this.draft) throw new Error("DRAFT_REQUIRED");
    return cloneDraft(this.draft);
  }

  private assertDraft(draft: GenerationDraft): void {
    if (!this.projectId) throw new Error("PROJECT_REQUIRED");
    if (!draft.prompt || draft.prompt.length > 4000) throw new Error("PROMPT_INVALID");
    if (draft.input_refs.length < 1 || draft.input_refs.length > 32) throw new Error("INPUT_REFS_INVALID");
    if (new Set(draft.input_refs).size !== draft.input_refs.length) throw new Error("INPUT_REFS_INVALID");
    if (draft.input_refs.some(id => !this.assetIds.has(id))) throw new Error("CROSS_PROJECT_INPUT_REF");
  }
}

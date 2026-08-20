export type VisualKind = "image" | "existing_media";
export type FulfillmentLifecycle =
  | "unstarted"
  | "in_progress"
  | "review_required"
  | "adopted"
  | "adopted_unavailable"
  | "no_usable_output";

export type Requirement = {
  project_id: string;
  shot_list_revision_id: string;
  shot_requirement_id: string;
  visual_kind: VisualKind;
  visual_source_asset_id: string | null;
  visual_direction: string;
};

export type PreparedFulfillment = {
  preview_id: string;
  payload_sha256: string;
  shot_list_revision_id: string;
  shot_requirement_id: string;
  requirement_sha256: string;
  provider_kind: "apikey_fun_images";
  adapter_id: "apikey_fun_images_sse_v1";
  model: "gpt-image-2";
  protocol_version: "1";
  size: "1024x1024";
  price_per_image: 0.1;
  price_currency: "CNY";
  expires_at: string;
};

export type FulfillmentTask = {
  task_id: string;
  request_id: string;
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  output_asset_id: string | null;
};

export type CreateFulfillmentResponse = {
  generation_link_id: string;
  request_id: string;
  task: FulfillmentTask;
  generation_reused: boolean;
  link_reused: boolean;
};

export type Adoption = {
  adoption_id: string;
  generation_link_id: string;
  task_id: string;
  asset_id: string;
  adoption_ordinal: number;
  previous_adoption_id: string | null;
};

export type FulfillmentState = {
  project_id: string;
  shot_list_revision_id: string;
  shot_requirement_id: string;
  requirement_sha256: string;
  currently_confirmed: boolean;
  lifecycle: FulfillmentLifecycle;
  link_count: number;
  current_adoption: Adoption | null;
  current_asset_availability: "available" | "missing" | "changed" | "unsupported" | null;
};

export interface Stage4EFulfillmentApi {
  prepare(projectId: string, requirementId: string, input: {
    expected_confirmed_revision_id: string;
    provider_config_id: string;
    prompt: string;
    size: "1024x1024";
  }): Promise<PreparedFulfillment>;
  create(projectId: string, requirementId: string, input: {
    preview_id: string;
    payload_sha256: string;
    expected_confirmed_revision_id: string;
    confirmed: true;
  }): Promise<CreateFulfillmentResponse>;
  getState(projectId: string, requirementId: string): Promise<FulfillmentState>;
  adopt(projectId: string, requirementId: string, input: {
    generation_link_id: string;
    task_id: string;
    asset_id: string;
    expected_current_adoption_id: string | null;
    confirmed: true;
  }): Promise<{ adoption: Adoption; reused: boolean }>;
  subscribeJob(jobId: string, listener: () => void): () => void;
  readonly providerCalls: number;
  readonly timelineWrites: number;
  readonly previewRequests: number;
  readonly renderRequests: number;
  readonly exportRequests: number;
  readonly batchRequests: number;
}

const SAFE_ERROR = "操作未完成，请刷新后重试。";

export class Stage4ERequirementFulfillmentPrototype {
  private projectId: string | null = null;
  private revisionId: string | null = null;
  private confirmedRevisionId: string | null = null;
  private requirements = new Map<string, Requirement>();
  private selectedRequirementId: string | null = null;
  private prompt = "";
  private draftRevision = 0;
  private prepared: { value: PreparedFulfillment; draftRevision: number } | null = null;
  private epoch = 0;
  private stopJob: (() => void) | null = null;
  private pendingAdoption: { generation_link_id: string; task_id: string; asset_id: string } | null = null;
  private errorMessage: string | null = null;

  state: FulfillmentState | null = null;
  createResult: CreateFulfillmentResponse | null = null;
  lastAdoptionReused: boolean | null = null;

  constructor(private readonly api: Stage4EFulfillmentApi) {}

  open(projectId: string, revisionId: string, confirmedRevisionId: string | null, requirements: Requirement[]): void {
    this.close();
    this.projectId = projectId;
    this.revisionId = revisionId;
    this.confirmedRevisionId = confirmedRevisionId;
    this.requirements = new Map(requirements.map(item => [item.shot_requirement_id, { ...item }]));
    this.epoch += 1;
  }

  close(): void {
    this.stopJob?.();
    this.stopJob = null;
    this.projectId = null;
    this.revisionId = null;
    this.confirmedRevisionId = null;
    this.requirements.clear();
    this.selectedRequirementId = null;
    this.prompt = "";
    this.prepared = null;
    this.pendingAdoption = null;
    this.state = null;
    this.createResult = null;
    this.errorMessage = null;
    this.epoch += 1;
  }

  selectRequirement(requirementId: string): void {
    const item = this.requirements.get(requirementId);
    if (!item || item.project_id !== this.projectId || item.shot_list_revision_id !== this.revisionId) {
      throw new Error("REQUIREMENT_NOT_IN_CONTEXT");
    }
    this.stopJob?.();
    this.stopJob = null;
    this.selectedRequirementId = requirementId;
    this.prompt = item.visual_direction;
    this.draftRevision += 1;
    this.prepared = null;
    this.pendingAdoption = null;
    this.state = null;
    this.createResult = null;
    this.errorMessage = null;
    this.epoch += 1;
  }

  canGenerate(): boolean {
    const item = this.selected();
    return Boolean(item && item.shot_list_revision_id === this.confirmedRevisionId && item.visual_kind === "image" && item.visual_source_asset_id === null);
  }

  isReadOnly(): boolean {
    return !this.canGenerate();
  }

  setPrompt(value: string): void {
    if (!this.canGenerate()) throw new Error("REQUIREMENT_NOT_ELIGIBLE");
    if (!value.trim() || value.length > 4000) throw new Error("PROMPT_INVALID");
    this.prompt = value;
    this.draftRevision += 1;
    this.prepared = null;
    this.errorMessage = null;
  }

  async prepare(providerConfigId: string): Promise<void> {
    const item = this.requireEligible();
    const projectId = this.requireProject();
    const revision = this.draftRevision;
    const epoch = this.epoch;
    try {
      const value = await this.api.prepare(projectId, item.shot_requirement_id, {
        expected_confirmed_revision_id: item.shot_list_revision_id,
        provider_config_id: providerConfigId,
        prompt: this.prompt,
        size: "1024x1024",
      });
      if (epoch !== this.epoch || revision !== this.draftRevision || item.shot_requirement_id !== this.selectedRequirementId) return;
      this.prepared = { value: { ...value }, draftRevision: revision };
      this.errorMessage = null;
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  confirmation(): Record<string, unknown> | null {
    if (!this.prepared || this.prepared.draftRevision !== this.draftRevision) return null;
    const value = this.prepared.value;
    return {
      shot_list_revision_id: value.shot_list_revision_id,
      shot_requirement_id: value.shot_requirement_id,
      requirement_sha256: value.requirement_sha256,
      payload_sha256: value.payload_sha256,
      provider_kind: value.provider_kind,
      adapter_id: value.adapter_id,
      model: value.model,
      protocol_version: value.protocol_version,
      size: value.size,
      price_per_image: value.price_per_image,
      price_currency: value.price_currency,
      expires_at: value.expires_at,
    };
  }

  async create(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("CONFIRMATION_REQUIRED");
    const item = this.requireEligible();
    const prepared = this.prepared;
    if (!prepared || prepared.draftRevision !== this.draftRevision) throw new Error("PREPARE_REQUIRED");
    const projectId = this.requireProject();
    const epoch = this.epoch;
    const response = await this.api.create(projectId, item.shot_requirement_id, {
      preview_id: prepared.value.preview_id,
      payload_sha256: prepared.value.payload_sha256,
      expected_confirmed_revision_id: item.shot_list_revision_id,
      confirmed: true,
    });
    if (epoch !== this.epoch || item.shot_requirement_id !== this.selectedRequirementId) return;
    this.createResult = { ...response, task: { ...response.task } };
    this.prepared = null;
    this.errorMessage = null;
    this.watch(response.task.job_id);
    await this.refreshState();
  }

  async refreshState(): Promise<void> {
    const projectId = this.requireProject();
    const requirementId = this.requireSelectedId();
    const epoch = this.epoch;
    try {
      const value = await this.api.getState(projectId, requirementId);
      if (epoch !== this.epoch || requirementId !== this.selectedRequirementId) return;
      this.state = { ...value, current_adoption: value.current_adoption ? { ...value.current_adoption } : null };
      this.errorMessage = null;
    } catch {
      if (epoch === this.epoch) this.errorMessage = SAFE_ERROR;
    }
  }

  beginAdopt(generationLinkId: string, task: FulfillmentTask): void {
    this.requireEligible();
    if (task.status !== "succeeded" || !task.output_asset_id) throw new Error("ADOPTION_NOT_ALLOWED");
    this.pendingAdoption = { generation_link_id: generationLinkId, task_id: task.task_id, asset_id: task.output_asset_id };
  }

  adoptionConfirmation(): Record<string, unknown> | null {
    if (!this.pendingAdoption) return null;
    return {
      ...this.pendingAdoption,
      expected_current_adoption_id: this.state?.current_adoption?.adoption_id ?? null,
    };
  }

  async adopt(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("ADOPTION_CONFIRMATION_REQUIRED");
    const pending = this.pendingAdoption;
    if (!pending) throw new Error("ADOPTION_PREPARE_REQUIRED");
    const item = this.requireEligible();
    const projectId = this.requireProject();
    const epoch = this.epoch;
    try {
      const result = await this.api.adopt(projectId, item.shot_requirement_id, {
        ...pending,
        expected_current_adoption_id: this.state?.current_adoption?.adoption_id ?? null,
        confirmed: true,
      });
      if (epoch !== this.epoch || item.shot_requirement_id !== this.selectedRequirementId) return;
      this.lastAdoptionReused = result.reused;
      this.pendingAdoption = null;
      await this.refreshState();
    } catch {
      if (epoch !== this.epoch) return;
      this.pendingAdoption = null;
      this.errorMessage = SAFE_ERROR;
      await this.refreshState();
    }
  }

  safeEvidence(): Record<string, unknown> {
    return {
      project_loaded: this.projectId !== null,
      revision_id: this.revisionId,
      confirmed_revision_id: this.confirmedRevisionId,
      selected_requirement_id: this.selectedRequirementId,
      can_generate: this.canGenerate(),
      prepared: this.prepared !== null,
      creation: this.createResult ? {
        generation_link_id: this.createResult.generation_link_id,
        request_id: this.createResult.request_id,
        task_id: this.createResult.task.task_id,
        status: this.createResult.task.status,
        generation_reused: this.createResult.generation_reused,
        link_reused: this.createResult.link_reused,
      } : null,
      lifecycle: this.state?.lifecycle ?? null,
      current_adoption_id: this.state?.current_adoption?.adoption_id ?? null,
      error_message: this.errorMessage,
      provider_call_count: this.api.providerCalls,
      forbidden_side_effect_count: this.api.timelineWrites + this.api.previewRequests + this.api.renderRequests + this.api.exportRequests + this.api.batchRequests,
    };
  }

  private watch(jobId: string): void {
    this.stopJob?.();
    this.stopJob = this.api.subscribeJob(jobId, () => { void this.refreshState(); });
  }

  private selected(): Requirement | null {
    return this.selectedRequirementId ? this.requirements.get(this.selectedRequirementId) ?? null : null;
  }

  private requireEligible(): Requirement {
    const item = this.selected();
    if (!item || !this.canGenerate()) throw new Error("REQUIREMENT_NOT_ELIGIBLE");
    return item;
  }

  private requireProject(): string {
    if (!this.projectId) throw new Error("PROJECT_REQUIRED");
    return this.projectId;
  }

  private requireSelectedId(): string {
    if (!this.selectedRequirementId) throw new Error("REQUIREMENT_REQUIRED");
    return this.selectedRequirementId;
  }
}

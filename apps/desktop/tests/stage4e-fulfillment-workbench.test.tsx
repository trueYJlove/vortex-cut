import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ImageProviderConfigSummary,
  Project,
  ProviderImageGenerationRequest,
  ProviderImageGenerationTask,
  ShotListRevisionDetail,
  ShotListRevisionSummary,
  ShotListState,
  ShotRequirement,
  ShotRequirementImageAdoption,
  ShotRequirementImageFulfillmentPreparedPreview,
  ShotRequirementImageFulfillmentState,
  ShotRequirementImageGenerationLink,
} from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { ShotRequirementImageFulfillmentPanel } from "../src/app/shot-requirements/ShotRequirementImageFulfillmentPanel.js";
import { ShotRequirementWorkbench } from "../src/app/shot-requirements/ShotRequirementWorkbench.js";

const now = "2026-08-20T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const project: Project = { project_id: "project_1" as never, name: "项目一", status: "active", canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Demo", current_timeline_revision_id: null, created_at: now, updated_at: now, last_opened_at: now };
const requirement: ShotRequirement = { shot_requirement_id: "requirement_1" as never, shot_list_revision_id: "revision_1" as never, ordinal: 0, title: "海边开场", visual_direction: "蓝色时刻的安静海岸", target_duration_us: null, visual: { requirement_kind: "image", source_asset_id: null }, narration: null };
const existingRequirement: ShotRequirement = { ...requirement, shot_requirement_id: "requirement_existing" as never, title: "已有素材", visual: { requirement_kind: "existing_media", source_asset_id: "asset_existing" as never } };
const summary: ShotListRevisionSummary = { schema_version: 1, shot_list_revision_id: requirement.shot_list_revision_id, shot_list_id: "shot_list_1" as never, project_id: project.project_id, parent_revision_id: null, title: "第一版", requirement_count: 2, document_sha256: hashA, created_at: now };
const detail: ShotListRevisionDetail = { ...summary, summary: "摘要", requirements: [requirement, existingRequirement] };
const shotState: ShotListState = { shot_list_id: summary.shot_list_id, project_id: project.project_id, lifecycle: "confirmed", current_revision: detail, confirmed_revision: summary };
const provider: ImageProviderConfigSummary = { provider_config_id: "image_provider_1" as never, project_id: project.project_id, provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", capability: "image_text_to_image", protocol_version: "1", display_name: "APIKEY.FUN Images", model: "gpt-image-2", enabled: true, price_per_image: 0.1, price_2k_per_image: 0.15, price_currency: "CNY", credential_status: "configured", created_at: now, updated_at: now };
const preview: ShotRequirementImageFulfillmentPreparedPreview = { preview_id: "preview_1" as never, project_id: project.project_id, shot_list_revision_id: requirement.shot_list_revision_id, shot_requirement_id: requirement.shot_requirement_id, requirement_sha256: hashA, fulfillment_payload_sha256: hashB, execution_mode: "provider_image_v1", prompt_sha256: hashA, size: "1024x1024", output_format: "png", image_count: 1, provider: { provider_config_id: provider.provider_config_id, provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" }, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now };
const link: ShotRequirementImageGenerationLink = { link_id: "link_1" as never, project_id: project.project_id, shot_list_revision_id: requirement.shot_list_revision_id, shot_requirement_id: requirement.shot_requirement_id, request_id: "request_1" as never, requirement_sha256: hashA, created_at: now };
const request: ProviderImageGenerationRequest = { request_id: link.request_id, project_id: project.project_id, generation_kind: "image", execution_mode: "provider_image_v1", prompt_sha256: hashA, parameters: { size: "1024x1024" }, request_sha256: hashB, created_at: now };
const output = { asset_id: "asset_1" as never, display_name: "generated.png", kind: "image", storage_mode: "managed", availability: "available" } as const;
function task(status: "failed" | "succeeded" = "failed"): ProviderImageGenerationTask {
  return { task_id: "task_1" as never, request_id: request.request_id, job_id: "job_1" as never, attempt: 1, status, stage: status, retry_of_task_id: null, provider_call_count: status === "succeeded" ? 1 : 0, provider_may_have_processed: false, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", output_asset_id: status === "succeeded" ? output.asset_id : null, output_sha256: status === "succeeded" ? hashA : null, result_summary: status === "succeeded" ? { execution_mode: "provider_image_v1", provider_call_count: 1, asset: output, output: { format: "png", width: 1024, height: 1024, size_bytes: 10, sha256: hashA }, provider: { kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" }, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", provenance_id: "provenance_1" as never } : null, error: status === "failed" ? { code: "FAILED", message: "图片生成未完成" } : null, created_at: now, updated_at: now, finished_at: now };
}
const emptyFulfillment: ShotRequirementImageFulfillmentState = { project_id: project.project_id, shot_list_revision_id: requirement.shot_list_revision_id, shot_requirement_id: requirement.shot_requirement_id, requirement_sha256: hashA, currently_confirmed: true, lifecycle: "unstarted", link_count: 0, current_adoption: null, current_asset_availability: null };
const adoption: ShotRequirementImageAdoption = { adoption_id: "adoption_1" as never, project_id: project.project_id, shot_list_revision_id: requirement.shot_list_revision_id, shot_requirement_id: requirement.shot_requirement_id, generation_link_id: link.link_id, task_id: task().task_id, asset_id: output.asset_id, adoption_ordinal: 1, previous_adoption_id: null, created_at: now };

function panelApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getShotRequirementImageFulfillment: vi.fn().mockResolvedValue(emptyFulfillment),
    listShotRequirementImageFulfillmentLinks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    listShotRequirementImageFulfillmentAdoptions: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    listImageProviderConfigs: vi.fn().mockResolvedValue({ items: [provider] }),
    getProviderImageGenerationRequest: vi.fn().mockResolvedValue(request),
    listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task()], next_cursor: null }),
    prepareShotRequirementImageFulfillment: vi.fn().mockResolvedValue(preview),
    createShotRequirementImageFulfillment: vi.fn().mockResolvedValue({ link, request, task: task(), generation_reused: true, link_reused: false }),
    prepareProviderImageGenerationRetry: vi.fn(), retryProviderImageGenerationTask: vi.fn(), cancelProviderImageGenerationTask: vi.fn(),
    adoptShotRequirementImageFulfillment: vi.fn().mockResolvedValue({ adoption, reused: false }),
    getTimeline: vi.fn().mockRejectedValue(new Error("TIMELINE_NOT_FOUND")),
    listShotRequirementTimelineAssemblies: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    prepareShotRequirementTimelineAssembly: vi.fn(), applyShotRequirementTimelineAssembly: vi.fn(),
    ...overrides,
  } as unknown as DesktopApi;
}
function mountPanel(desktop = panelApi(), readOnly = false) {
  window.desktop = desktop;
  return { desktop, ...render(<ShotRequirementImageFulfillmentPanel projectId={project.project_id} revisionId={requirement.shot_list_revision_id} requirement={requirement} readOnly={readOnly} assets={[]} />) };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Stage 4E Requirement 图片履约 UI", () => {
  it("只把已确认 Revision 的真实 image Requirement 接入工作台，existing_media 不产生入口", async () => {
    const desktop = panelApi({
      getShotList: vi.fn().mockResolvedValue(shotState),
      listShotListRevisions: vi.fn().mockResolvedValue({ items: [summary], next_cursor: null }),
    });
    window.desktop = desktop;
    render(<ShotRequirementWorkbench project={project} assets={[]} onClose={vi.fn()} />);
    await screen.findByDisplayValue("第一版");
    fireEvent.click(screen.getByRole("tab", { name: "图片履约" }));
    expect(await screen.findByLabelText("海边开场 图片履约")).toBeVisible();
    expect(screen.queryByLabelText("已有素材 图片履约")).not.toBeInTheDocument();
    expect(desktop.getShotRequirementImageFulfillment).toHaveBeenCalledWith({ project_id: "project_1", requirement_id: "requirement_1" });
  });

  it("Revision 历史页提供真实 Requirement 的只读履约入口，existing_media 仍不产生入口", async () => {
    const historicalRequirement: ShotRequirement = { ...requirement, shot_requirement_id: "requirement_history" as never, shot_list_revision_id: "revision_history" as never, title: "历史图片需求" };
    const historicalExisting: ShotRequirement = { ...existingRequirement, shot_requirement_id: "requirement_history_existing" as never, shot_list_revision_id: historicalRequirement.shot_list_revision_id };
    const historicalDetail: ShotListRevisionDetail = { ...detail, shot_list_revision_id: historicalRequirement.shot_list_revision_id, title: "历史版", requirements: [historicalRequirement, historicalExisting] };
    const historicalSummary: ShotListRevisionSummary = { ...historicalDetail, requirement_count: 2 };
    const historicalState: ShotRequirementImageFulfillmentState = { ...emptyFulfillment, shot_list_revision_id: historicalRequirement.shot_list_revision_id, shot_requirement_id: historicalRequirement.shot_requirement_id, currently_confirmed: false };
    const desktop = panelApi({
      getShotList: vi.fn().mockResolvedValue(shotState),
      listShotListRevisions: vi.fn().mockResolvedValue({ items: [historicalSummary], next_cursor: null }),
      getShotListRevision: vi.fn().mockResolvedValue(historicalDetail),
      getShotRequirementImageFulfillment: vi.fn().mockResolvedValue(historicalState),
    });
    window.desktop = desktop;
    render(<ShotRequirementWorkbench project={project} assets={[]} onClose={vi.fn()} />);
    await screen.findByDisplayValue("第一版");
    fireEvent.click(screen.getByRole("tab", { name: "Revision 历史" }));
    fireEvent.click(await screen.findByRole("button", { name: /历史版/ }));
    expect(await screen.findByLabelText("历史图片需求 图片履约")).toBeVisible();
    expect(screen.getByText("历史 Revision 仅供查看，不能 Prepare、Create、Retry、Cancel 或 Adopt。")).toBeVisible();
    expect(screen.queryByLabelText("已有素材 图片履约")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "准备图片履约" })).not.toBeInTheDocument();
    await waitFor(() => expect(desktop.getShotRequirementImageFulfillment).toHaveBeenCalledWith({ project_id: project.project_id, requirement_id: historicalRequirement.shot_requirement_id }));
  });

  it("Prompt 仅进入 Prepare；Create 使用冻结 Preview 且明确展示复用结果", async () => {
    const { desktop } = mountPanel();
    const sentinel = "PROMPT_SENTINEL_STAGE4E";
    const input = await screen.findByLabelText("海边开场 履约 Prompt");
    fireEvent.change(input, { target: { value: sentinel } });
    fireEvent.click(screen.getByRole("button", { name: "准备图片履约" }));
    await screen.findByLabelText("图片履约确认");
    expect(desktop.prepareShotRequirementImageFulfillment).toHaveBeenCalledWith({ project_id: "project_1", requirement_id: "requirement_1", request: { expected_confirmed_revision_id: "revision_1", provider_config_id: "image_provider_1", prompt: sentinel } });
    expect(screen.queryByDisplayValue(sentinel)).not.toBeInTheDocument();
    expect(screen.queryByText(sentinel)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建图片任务" }));
    expect(await screen.findByText("已复用既有生成请求；已建立需求关联。")).toBeVisible();
    expect(desktop.createShotRequirementImageFulfillment).toHaveBeenCalledWith({ project_id: "project_1", requirement_id: "requirement_1", request: { preview_id: "preview_1", fulfillment_payload_sha256: hashB, expected_confirmed_revision_id: "revision_1", confirmed: true } });
    expect(JSON.stringify(vi.mocked(desktop.createShotRequirementImageFulfillment).mock.calls)).not.toContain(sentinel);
  });

  it("失败任务重试必须二次确认，Prompt 只进入 Retry Prepare", async () => {
    const retryPreview = {
      preview_id: "retry_preview_1" as never,
      project_id: project.project_id,
      execution_mode: "provider_image_v1" as const,
      prompt_sha256: hashA,
      payload_sha256: hashB,
      size: "1024x1024" as const,
      output_format: "png" as const,
      image_count: 1 as const,
      provider: { provider_config_id: provider.provider_config_id, provider_kind: "apikey_fun_images" as const, adapter_id: "apikey_fun_images_sse_v1" as const, model: "gpt-image-2" as const },
      estimated_cost: 0.1,
      estimated_cost_currency: "CNY" as const,
      price_tier: "1K" as const,
      expires_at: now,
    };
    const prepareRetry = vi.fn().mockResolvedValue(retryPreview);
    const confirmRetry = vi.fn().mockResolvedValue({ request, task: task(), reused: false });
    const desktop = panelApi({
      listShotRequirementImageFulfillmentLinks: vi.fn().mockResolvedValue({ items: [link], next_cursor: null }),
      listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task("failed")], next_cursor: null }),
      prepareProviderImageGenerationRetry: prepareRetry,
      retryProviderImageGenerationTask: confirmRetry,
    });
    mountPanel(desktop);
    const sentinel = "RETRY_PROMPT_SENTINEL_STAGE4E";
    fireEvent.change(await screen.findByLabelText("海边开场 履约 Prompt"), { target: { value: sentinel } });
    fireEvent.click(screen.getByRole("button", { name: "使用当前 Prompt 重试" }));
    expect(await screen.findByRole("dialog", { name: "确认重试图片生成" })).toBeVisible();
    expect(screen.getByText("重试会建立新 Attempt，可能再次调用 Provider 并收费。")).toBeVisible();
    expect(prepareRetry).toHaveBeenCalledWith({ task_id: "task_1", request: { prompt: sentinel } });
    expect(confirmRetry).not.toHaveBeenCalled();
    expect(screen.queryByText(sentinel)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认重试并再次调用" }));
    await waitFor(() => expect(confirmRetry).toHaveBeenCalledWith({ task_id: "task_1", request: { preview_id: "retry_preview_1", payload_sha256: hashB, confirmed: true } }));
    expect(JSON.stringify(confirmRetry.mock.calls)).not.toContain(sentinel);
  });

  it("succeeded managed image 才能采用，确认文案保证不修改 Timeline", async () => {
    const desktop = panelApi({
      listShotRequirementImageFulfillmentLinks: vi.fn().mockResolvedValue({ items: [link], next_cursor: null }),
      listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task("succeeded")], next_cursor: null }),
      getShotRequirementImageFulfillment: vi.fn().mockResolvedValue(emptyFulfillment),
    });
    mountPanel(desktop);
    const adoptButton = await screen.findByRole("button", { name: "采用此结果" });
    expect(adoptButton).toBeEnabled();
    fireEvent.click(adoptButton);
    expect(screen.getByText("不会修改 Timeline")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认采用此结果" }));
    await waitFor(() => expect(desktop.adoptShotRequirementImageFulfillment).toHaveBeenCalledWith({ project_id: "project_1", requirement_id: "requirement_1", request: { generation_link_id: "link_1", task_id: "task_1", asset_id: "asset_1", expected_current_adoption_id: null, confirmed: true } }));
  });

  it("Adopt CAS 冲突只刷新状态，不自动重发", async () => {
    const getState = vi.fn().mockResolvedValueOnce(emptyFulfillment).mockResolvedValue({ ...emptyFulfillment, lifecycle: "adopted", current_adoption: adoption, current_asset_availability: "available" });
    const adopt = vi.fn().mockRejectedValue(new Error("SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT"));
    const desktop = panelApi({ getShotRequirementImageFulfillment: getState, listShotRequirementImageFulfillmentLinks: vi.fn().mockResolvedValue({ items: [link], next_cursor: null }), listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task("succeeded")], next_cursor: null }), adoptShotRequirementImageFulfillment: adopt });
    mountPanel(desktop);
    fireEvent.click(await screen.findByRole("button", { name: "采用此结果" }));
    fireEvent.click(screen.getByRole("button", { name: "确认采用此结果" }));
    expect(await screen.findByText("当前采用项已变化，已刷新；请核对后重新操作。")).toBeVisible();
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(getState.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("历史模式只读，禁止所有写动作", async () => {
    mountPanel(panelApi(), true);
    expect(await screen.findByText("历史 Revision 仅供查看，不能 Prepare、Create、Retry、Cancel 或 Adopt。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "准备图片履约" })).not.toBeInTheDocument();
  });
});

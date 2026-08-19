import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../electron/preload/index.js";
import { ProviderImageGenerationWorkbench } from "../src/app/provider-image-generation/ProviderImageGenerationWorkbench.js";

const now = "2026-08-19T00:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const payloadHash = `sha256:${"b".repeat(64)}`;
const project = {
  project_id: "project_1", name: "Stage 4D", status: "active",
  canvas: { width: 1080, height: 1920, fps_num: 30, fps_den: 1 }, root_dir_name: "Stage4D",
  current_timeline_revision_id: null, created_at: now, updated_at: now, last_opened_at: now,
} as never;
const config = {
  provider_config_id: "image_provider_1", project_id: "project_1", provider_kind: "apikey_fun_images",
  adapter_id: "apikey_fun_images_sse_v1", capability: "image_text_to_image", protocol_version: "1",
  display_name: "APIKEY.FUN Images", model: "gpt-image-2", enabled: true, price_per_image: 0.1, price_2k_per_image: 0.15, price_currency: "CNY",
  credential_status: "configured", created_at: now, updated_at: now,
} as const;
const preview = {
  preview_id: "preview_1", project_id: "project_1", execution_mode: "provider_image_v1",
  prompt_sha256: hash, payload_sha256: payloadHash, size: "1024x1024", output_format: "png", image_count: 1,
  provider: { provider_config_id: "image_provider_1", provider_kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" },
  estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", expires_at: now,
} as const;
const request = {
  request_id: "request_1", project_id: "project_1", generation_kind: "image", execution_mode: "provider_image_v1",
  prompt_sha256: hash, parameters: { size: "1024x1024" }, request_sha256: payloadHash, created_at: now,
} as const;
function task(status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted", attempt = 1) {
  const succeeded = status === "succeeded";
  return {
    task_id: `task_${attempt}`, request_id: "request_1", job_id: `job_${attempt}`, attempt, status,
    stage: succeeded ? "completed" : status, retry_of_task_id: attempt === 1 ? null : "task_1",
    provider_call_count: (status === "queued" ? 0 : 1) as 0 | 1,
    provider_may_have_processed: status !== "queued", estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K",
    output_asset_id: succeeded ? "asset_generated" : null, output_sha256: succeeded ? hash : null,
    result_summary: succeeded ? {
      execution_mode: "provider_image_v1", provider_call_count: 1,
      asset: { asset_id: "asset_generated", display_name: "generated.png", kind: "image", storage_mode: "managed", availability: "available" },
      output: { format: "png", width: 1024, height: 1536, size_bytes: 128, sha256: hash },
      provider: { kind: "apikey_fun_images", adapter_id: "apikey_fun_images_sse_v1", model: "gpt-image-2" },
      estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K", provenance_id: "provenance_1",
    } : null,
    error: status === "failed" ? { code: "PROVIDER_FAILED", message: "图片生成未完成。" } : null,
    created_at: now, updated_at: now, finished_at: ["queued", "running"].includes(status) ? null : now,
  } as const;
}
function api(overrides: Record<string, unknown> = {}): DesktopApi {
  return {
    listImageProviderConfigs: vi.fn().mockResolvedValue({ items: [config] }),
    createImageProviderConfig: vi.fn().mockResolvedValue(config),
    setImageProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "image_provider_1", credential_status: "configured" }),
    deleteImageProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "image_provider_1", credential_status: "missing" }),
    prepareProviderImageGeneration: vi.fn().mockResolvedValue(preview),
    createProviderImageGeneration: vi.fn().mockResolvedValue({ request, task: task("queued"), reused: false }),
    listProviderImageGenerationRequests: vi.fn().mockResolvedValue({ items: [request], next_cursor: null }),
    getProviderImageGenerationRequest: vi.fn().mockResolvedValue(request),
    listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task("failed")], next_cursor: null }),
    prepareProviderImageGenerationRetry: vi.fn().mockResolvedValue(preview),
    retryProviderImageGenerationTask: vi.fn().mockResolvedValue(task("queued", 2)),
    cancelProviderImageGenerationTask: vi.fn().mockResolvedValue(task("cancelled")),
    patchTimeline: vi.fn(), createTimeline: vi.fn(), createPreview: vi.fn(), createExport: vi.fn(),
    ...overrides,
  } as unknown as DesktopApi;
}
function renderWorkbench(desktop: DesktopApi, assets: unknown[] = []) {
  window.desktop = desktop;
  return render(<ProviderImageGenerationWorkbench project={project} assets={assets as never} onClose={vi.fn()} />);
}
afterEach(() => cleanup());

describe("Stage 4D 真实图片生成工作台", () => {
  it("显式展示外传、费用、单次调用和 Provider 可能已处理边界", async () => {
    renderWorkbench(api());
    expect(screen.getByRole("dialog")).toHaveTextContent("Prompt 会发送给外部 Provider");
    expect(screen.getByRole("dialog")).toHaveTextContent("可能产生费用");
    expect(screen.getByRole("dialog")).toHaveTextContent("每个 Task 最多一次调用");
    expect(screen.getByRole("dialog")).toHaveTextContent("Provider 仍可能已处理");
    expect(await screen.findByRole("option", { name: /APIKEY.FUN Images/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "准备付费调用确认" })).toBeDisabled();
  });

  it("prepare 瞬时发送当前 Prompt，但确认页和历史不显示正文", async () => {
    const desktop = api();
    const sentinel = "PROMPT-SENTINEL-STAGE4D";
    renderWorkbench(desktop);
    await screen.findByRole("option", { name: /APIKEY.FUN Images/ });
    fireEvent.change(screen.getByLabelText("图片生成 Prompt"), { target: { value: sentinel } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备付费调用确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备付费调用确认" }));
    await screen.findByText("确认外部图片调用");
    expect(desktop.prepareProviderImageGeneration).toHaveBeenCalledWith({
      project_id: "project_1", request: { provider_config_id: "image_provider_1", prompt: sentinel, size: "1024x1024" },
    });
    expect(document.body.textContent).not.toContain(sentinel);
    expect(screen.getByText(/正文不回显；SHA-256/)).toHaveTextContent(hash);
    fireEvent.click(screen.getByRole("button", { name: "确认发送并创建任务" }));
    await screen.findByText("安全历史（不含 Prompt 正文）");
    expect(desktop.createProviderImageGeneration).toHaveBeenCalledWith({
      project_id: "project_1", request: { preview_id: "preview_1", payload_sha256: payloadHash, confirmed: true },
    });
    expect(JSON.stringify(vi.mocked(desktop.createProviderImageGeneration).mock.calls)).not.toContain(sentinel);
    expect(document.body.textContent).not.toContain(sentinel);
  });

  it("重试必须重新输入 Prompt 并经过再次收费确认", async () => {
    const desktop = api();
    renderWorkbench(desktop);
    fireEvent.click(await screen.findByRole("button", { name: "历史" }));
    await screen.findByText("Attempt 1");
    fireEvent.click(screen.getByRole("button", { name: "用当前表单 Prompt 准备重试" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("重试必须重新输入与原请求完全相同的 Prompt");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    fireEvent.change(screen.getByLabelText("图片生成 Prompt"), { target: { value: "same prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "历史" }));
    await screen.findByText("Attempt 1");
    fireEvent.click(screen.getByRole("button", { name: "用当前表单 Prompt 准备重试" }));
    expect(await screen.findByText("确认再次调用并可能再次收费")).toBeVisible();
    expect(desktop.prepareProviderImageGenerationRetry).toHaveBeenCalledWith({ task_id: "task_1", request: { prompt: "same prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "确认重试并再次调用" }));
    await screen.findByText("Attempt 2");
    expect(desktop.retryProviderImageGenerationTask).toHaveBeenCalledWith({
      task_id: "task_1", request: { preview_id: "preview_1", payload_sha256: payloadHash, confirmed: true },
    });
  });

  it("成功结果只使用既有受限 media_url，且不调用 Timeline/Preview/Export", async () => {
    const desktop = api({ listProviderImageGenerationTasks: vi.fn().mockResolvedValue({ items: [task("succeeded")], next_cursor: null }) });
    renderWorkbench(desktop, [{ asset: { asset_id: "asset_generated" }, media_url: "aivideo-media://asset/asset_generated" }]);
    fireEvent.click(await screen.findByRole("button", { name: "历史" }));
    const image = await screen.findByRole("img", { name: "generated.png" });
    expect(image).toHaveAttribute("src", "aivideo-media://asset/asset_generated");
    expect(screen.getByText(/实际尺寸 1024 × 1536/)).toBeVisible();
    expect(desktop.patchTimeline).not.toHaveBeenCalled();
    expect(desktop.createTimeline).not.toHaveBeenCalled();
    expect(desktop.createPreview).not.toHaveBeenCalled();
    expect(desktop.createExport).not.toHaveBeenCalled();
  });

  it("原始异常、绝对路径与 Prompt sentinel 不进入 DOM 或 console", async () => {
    const sentinel = "PROMPT-SENTINEL-RAW";
    const raw = `RAW_EXCEPTION C:\\Users\\private\\image.png ${sentinel}`;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const desktop = api({ prepareProviderImageGeneration: vi.fn().mockRejectedValue(new Error(raw)) });
    renderWorkbench(desktop);
    await screen.findByRole("option", { name: /APIKEY.FUN Images/ });
    fireEvent.change(screen.getByLabelText("图片生成 Prompt"), { target: { value: sentinel } });
    await waitFor(() => expect(screen.getByRole("button", { name: "准备付费调用确认" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "准备付费调用确认" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请刷新后重试。");
    expect(document.body.textContent).not.toContain("RAW_EXCEPTION");
    expect(document.body.textContent).not.toContain("C:\\Users\\private");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

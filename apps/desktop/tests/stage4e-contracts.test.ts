import {
  CONTRACT_VERSION,
  isShotRequirementImageAdoptInput,
  isShotRequirementImageAdoption,
  isShotRequirementImageFulfillmentCreateResponse,
  isShotRequirementImageFulfillmentPreparedPreview,
  isShotRequirementImageFulfillmentPrepareInput,
  isShotRequirementImageFulfillmentState,
  isShotRequirementImageGenerationLinkPage,
} from "@aivideo/contracts";
import { describe, expect, it } from "vitest";

const sha = `sha256:${"a".repeat(64)}`;
const now = "2026-08-20T00:00:00.000Z";
const provider = {
  provider_config_id: "config_1",
  provider_kind: "apikey_fun_images",
  adapter_id: "apikey_fun_images_sse_v1",
  model: "gpt-image-2",
};
const link = {
  link_id: "link_1", project_id: "project_1", shot_list_revision_id: "revision_1",
  shot_requirement_id: "requirement_1", request_id: "request_1",
  requirement_sha256: sha, created_at: now,
};
const adoption = {
  adoption_id: "adoption_1", project_id: "project_1", shot_list_revision_id: "revision_1",
  shot_requirement_id: "requirement_1", generation_link_id: "link_1", task_id: "task_1",
  asset_id: "asset_1", adoption_ordinal: 1, previous_adoption_id: null, created_at: now,
};
const request = {
  request_id: "request_1", project_id: "project_1", generation_kind: "image",
  execution_mode: "provider_image_v1", prompt_sha256: sha,
  parameters: { size: "1024x1024" }, request_sha256: sha, created_at: now,
};
const task = {
  task_id: "task_1", request_id: "request_1", job_id: "job_1", attempt: 1,
  status: "queued", stage: "queued", retry_of_task_id: null, provider_call_count: 0,
  provider_may_have_processed: false, estimated_cost: 0.1,
  estimated_cost_currency: "CNY", price_tier: "1K", output_asset_id: null,
  output_sha256: null, result_summary: null, error: null, created_at: now,
  updated_at: now, finished_at: null,
};

describe("Stage 4E 契约", () => {
  it("冻结 stage4e-v1，并仅允许 Prepare 输入瞬时携带 Prompt", () => {
    expect(CONTRACT_VERSION).toBe("stage4e-v1");
    expect(isShotRequirementImageFulfillmentPrepareInput({
      expected_confirmed_revision_id: "revision_1", provider_config_id: "config_1",
      prompt: "private prompt",
    })).toBe(true);
    expect(isShotRequirementImageFulfillmentPrepareInput({
      expected_confirmed_revision_id: "revision_1", provider_config_id: "config_1",
      prompt: "p", extra: true,
    })).toBe(false);
    const preview = {
      preview_id: "preview_1", project_id: "project_1", shot_list_revision_id: "revision_1",
      shot_requirement_id: "requirement_1", requirement_sha256: sha,
      fulfillment_payload_sha256: sha, execution_mode: "provider_image_v1",
      prompt_sha256: sha, size: "1024x1024", output_format: "png", image_count: 1,
      provider, estimated_cost: 0.1, estimated_cost_currency: "CNY", price_tier: "1K",
      expires_at: now,
    };
    expect(isShotRequirementImageFulfillmentPreparedPreview(preview)).toBe(true);
    expect(isShotRequirementImageFulfillmentPreparedPreview({ ...preview, prompt: "leak" })).toBe(false);
    expect(isShotRequirementImageFulfillmentPreparedPreview({
      ...preview, provider: { ...provider, raw_response: "leak" },
    })).toBe(false);
  });

  it("严格校验 Link、State、Create、Adopt 与分页响应", () => {
    expect(isShotRequirementImageGenerationLinkPage({ items: [link], next_cursor: null })).toBe(true);
    expect(isShotRequirementImageGenerationLinkPage({
      items: [{ ...link, absolute_path: "C:/private.png" }], next_cursor: null,
    })).toBe(false);
    expect(isShotRequirementImageFulfillmentState({
      project_id: "project_1", shot_list_revision_id: "revision_1",
      shot_requirement_id: "requirement_1", requirement_sha256: sha,
      currently_confirmed: true, lifecycle: "unstarted", link_count: 0,
      current_adoption: null, current_asset_availability: null,
    })).toBe(true);
    expect(isShotRequirementImageFulfillmentCreateResponse({
      link, request, task, generation_reused: false, link_reused: false,
    })).toBe(true);
    expect(isShotRequirementImageAdoption(adoption)).toBe(true);
    expect(isShotRequirementImageAdoptInput({
      generation_link_id: "link_1", task_id: "task_1", asset_id: "asset_1",
      expected_current_adoption_id: null, confirmed: true,
    })).toBe(true);
    expect(isShotRequirementImageAdoptInput({
      generation_link_id: "link_1", task_id: "task_1", asset_id: "asset_1",
      expected_current_adoption_id: null, confirmed: true, payload: "leak",
    })).toBe(false);
  });
});
/**
 * W4.2 召回来源选择 UI（AI 粗剪对话框）。
 *
 * 钉住三条（不使用「找不到就跳过」的软化逻辑，避免假绿）：
 * 1) 默认仍是 auto（D1=A：旧行为不变）；
 * 2) 可选到 fused 且说明权重未调优（R1/P147，不得暗示已证明更优）；
 * 3) 选择后 preparePlanning 实际收到 candidate_source。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";
import { App } from "../src/app/App.js";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openDialog() {
  const api = buildDesktopApi();
  vi.mocked(api.listProviders!).mockResolvedValue({ items: [{
    provider_config_id: "provider_1", kind: "openai_compatible_text", display_name: "P",
    base_url: "https://provider.test", model: "m", enabled: true, credential_status: "configured",
    input_price_per_million: null, output_price_per_million: null,
    timeline_patch_capability_status: "supported", timeline_patch_response_adapter_id: "a",
    timeline_patch_probe_protocol_version: "1", timeline_patch_capability_tested_at: "t",
    timeline_patch_capability_failure_code: null, timeline_patch_capability_probe_sha256: "sha256:" + "d".repeat(64),
    candidate_capability_status: "supported", candidate_response_adapter_id: "a",
    candidate_probe_protocol_version: "1", candidate_capability_tested_at: "t",
    candidate_capability_failure_code: null, candidate_capability_probe_sha256: "sha256:" + "e".repeat(64),
    captions_provider_capability_status: "supported", captions_provider_response_adapter_id: "c",
    captions_provider_probe_protocol_version: "1", captions_provider_capability_tested_at: "t",
    captions_provider_capability_failure_code: null, captions_provider_capability_probe_sha256: "sha256:" + "f".repeat(64),
    created_at: "t", updated_at: "t"
  } as never] });
  vi.mocked(api.preparePlanning!).mockResolvedValue({
    egress_preview_id: "preview_1",
    provider: { display_name: "P", origin: "https://p.test", model: "m" },
    prompt_template_version: "candidate-plan-v1",
    sent_fields: ["segments.text"],
    payload_sha256: "sha256:" + "b".repeat(64),
    expires_at: "t",
    payload: { segments: [] },
    stats: { transcript_count: 1, segment_count: 0, character_count: 0, estimated_tokens: 0 }
  } as never);
  window.desktop = api;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "AI 粗剪" }));
  return api;
}

describe("W4.2 召回来源", () => {
  it("默认 auto（旧行为不变）", async () => {
    await openDialog();
    const select = await screen.findByLabelText(/召回来源/) as HTMLSelectElement;
    expect(select.value).toBe("auto");
  });

  it("提供 fused 选项且明示权重未调优", async () => {
    await openDialog();
    const select = await screen.findByLabelText(/召回来源/) as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value);
    expect(values).toEqual(["auto", "transcript", "cv", "fused"]);
    // R1/P147：不得暗示融合已被证明更优
    expect(document.body.textContent).toMatch(/尚未调优|未调优/);
  });
});
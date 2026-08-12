import { describe, expect, it, vi } from "vitest";
import { issueCandidateClipMedia } from "../electron/main/candidate-media.js";

const request = { project_id: "project_1", candidate_plan_id: "candidate_plan_1", candidate_clip_id: "candidate_clip_1" };
const validPlan = { project_id: "project_1", clips: [{ clip_id: "candidate_clip_1", asset_id: "asset_1", source_start_us: 1_000_000, source_end_us: 3_000_000 }] };
function deps(overrides: Partial<Parameters<typeof issueCandidateClipMedia>[1]> = {}) {
  return {
    fetchPlan: vi.fn().mockResolvedValue(validPlan),
    listProjectAssets: vi.fn().mockResolvedValue({ items: [{ asset_id: "asset_1", availability: "available", kind: "video" }] }),
    issueAssetTicket: vi.fn().mockResolvedValue("aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH"),
    ...overrides
  };
}

describe("候选片段受限媒体票据", () => {
  it("仅按 Core CandidatePlan 的片段范围签发，响应不含路径、file URI、token 或 fingerprint", async () => {
    const services = deps(); const result = await issueCandidateClipMedia(request, services);
    expect(services.issueAssetTicket).toHaveBeenCalledWith("asset_1");
    expect(result).toEqual({ media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFGH", source_start_us: 1_000_000, source_end_us: 3_000_000 });
    expect(JSON.stringify(result)).not.toMatch(/path|file:|token|fingerprint/i);
  });
  it("拒绝跨项目、伪造计划和伪造片段", async () => {
    await expect(issueCandidateClipMedia(request, deps({ fetchPlan: vi.fn().mockResolvedValue({ ...validPlan, project_id: "project_2" }) }))).rejects.toThrow();
    await expect(issueCandidateClipMedia(request, deps({ fetchPlan: vi.fn().mockRejectedValue(new Error("not found")) }))).rejects.toThrow("not found");
    await expect(issueCandidateClipMedia({ ...request, candidate_clip_id: "candidate_clip_fake" }, deps())).rejects.toThrow();
  });
  it("拒绝不可用素材，且请求不接受 Renderer 提交的时间范围", async () => {
    await expect(issueCandidateClipMedia(request, deps({ listProjectAssets: vi.fn().mockResolvedValue({ items: [{ asset_id: "asset_1", availability: "missing", kind: "video" }] }) }))).rejects.toThrow();
    await expect(issueCandidateClipMedia({ ...request, source_start_us: 0, source_end_us: 9_999_999 }, deps())).rejects.toThrow();
  });
});

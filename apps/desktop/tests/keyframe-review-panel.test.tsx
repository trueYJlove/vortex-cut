/**
 * W3.3 S6：逐张审阅面板（D4）。
 *
 * 验收口径是三条不可让步的约束，每条都要能变红：
 *  1. 每张可见——不是「共 N 张」的汇总；
 *  2. 可单张移除，且移除**立即提交服务端**（不是本地 UI 状态）；
 *  3. 明示「这不是匿名化」。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeyframeReviewPanel } from "../src/app/keyframe-review/KeyframeReviewPanel.js";

const projectId = "project_1" as never;
const assetId = "asset_1" as never;

function frame(index: number, bytes = 20_000) {
  return {
    frame_index: index,
    timestamp_us: index * 1_000_000,
    source_reason: "scene_cut" as const,
    payload_width: 768,
    payload_height: 432,
    payload_bytes: bytes,
    payload_sha256: "a".repeat(64),
    thumbnail_width: 192,
    thumbnail_height: 108,
    thumbnail_bytes: 2_800,
    thumbnail_sha256: "b".repeat(64),
  };
}

function preview(excluded: number[] = []) {
  return {
    keyframe_egress_preview_id: "kp_1",
    frames: [frame(0), frame(1), frame(2)],
    excluded_frames: excluded,
    sampling_mode: "scene_cut" as const,
    covered_scene_cuts: 3,
    total_frame_bytes: 60_000,
    payload_sha256: "c".repeat(64),
    expires_at: "2026-10-21T12:00:00.000Z",
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const prepareKeyframePreview = vi.fn().mockResolvedValue(preview());
  const excludeKeyframeFrames = vi.fn().mockResolvedValue(preview([1]));
  const createKeyframeGeneration = vi.fn().mockResolvedValue({
    keyframe_generation_id: "gen_1", status: "queued", consent_id: "c_1",
  });
  const listProviders = vi.fn().mockResolvedValue({
    items: [{
      provider_config_id: "prov_1", display_name: "本地网关", model: "vision-model",
      enabled: true, credential_status: "configured",
    }],
  });
  (window as unknown as { desktop: Record<string, unknown> }).desktop = {
    prepareKeyframePreview, excludeKeyframeFrames, createKeyframeGeneration, listProviders,
    ...overrides,
  };
  return { prepareKeyframePreview, excludeKeyframeFrames, createKeyframeGeneration, listProviders };
}

function renderPanel(onClose = () => {}) {
  return render(
    <KeyframeReviewPanel
      projectId={projectId}
      assetId={assetId}
      assetName={"素材甲"}
      onClose={onClose}
    />,
  );
}

afterEach(cleanup);

describe("KeyframeReviewPanel（D4 逐张审阅）", () => {
  beforeEach(() => { setup(); });

  it("必须先显式说明这不是匿名化", async () => {
    renderPanel();
    // D4/规划门 R1：不得用「抽样关键帧」暗示低风险。
    expect(await screen.findByText(/这不是匿名化/)).toBeTruthy();
    expect(screen.getByText(/768 像素下人物面部、室内空间等仍可辨认/)).toBeTruthy();
  });

  it("生成预览后逐帧列出，而不是只给总数", async () => {
    const { prepareKeyframePreview } = setup();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));

    await waitFor(() => expect(prepareKeyframePreview).toHaveBeenCalled());
    // 三帧各自一行，含序号与实测字节
    expect(await screen.findByText("#0")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getAllByText(/768×432/)).toHaveLength(3);
  });

  it("移除帧会立即提交服务端（不是本地状态）", async () => {
    const { excludeKeyframeFrames } = setup();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));
    await screen.findByText("#1");

    fireEvent.click(screen.getByRole("button", { name: "移除第 1 帧" }));

    await waitFor(() => expect(excludeKeyframeFrames).toHaveBeenCalledWith({
      project_id: projectId,
      preview_id: "kp_1",
      frame_indices: [1],
    }));
  });

  it("移除后该帧显示为已移除且按钮禁用", async () => {
    setup();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "移除第 1 帧" }));

    expect(await screen.findByRole("button", { name: "第 1 帧已移除" })).toBeTruthy();
  });

  it("未勾选确认时不能提交", async () => {
    setup();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));
    await screen.findByText("#0");

    const submit = screen.getByRole("button", { name: "确认外传" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("勾选确认后才允许提交", async () => {
    setup();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));
    await screen.findByText("#0");

    fireEvent.click(screen.getByRole("checkbox"));
    const submit = screen.getByRole("button", { name: "确认外传" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("没有可用 Provider 时禁用预览按钮并给出说明", async () => {
    setup({ listProviders: vi.fn().mockResolvedValue({ items: [] }) });
    renderPanel();

    expect(await screen.findByText(/尚未配置可用的 Provider/)).toBeTruthy();
    const prepare = screen.getByRole("button", { name: "生成关键帧预览" }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
  });

  it("预览失败只给稳定文案，不泄漏上游细节", async () => {
    setup({
      prepareKeyframePreview: vi.fn().mockRejectedValue(
        new Error("VISION_FRAMES_UNMAPPED at C:/secret/db.sqlite"),
      ),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));

    expect(await screen.findByText(/没有可用的关键帧/)).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});

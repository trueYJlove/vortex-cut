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

function generationStatus(overrides: Record<string, unknown> = {}) {
  return {
    keyframe_generation_id: "gen_1",
    status: "queued",
    frame_count: null,
    vocabulary_violations: null,
    vocabulary_version: null,
    error_code: null,
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const prepareKeyframePreview = vi.fn().mockResolvedValue(preview());
  const excludeKeyframeFrames = vi.fn().mockResolvedValue(preview([1]));
  const createKeyframeGeneration = vi.fn().mockResolvedValue({
    keyframe_generation_id: "gen_1", status: "queued", consent_id: "c_1",
  });
  const getKeyframeGeneration = vi.fn().mockResolvedValue(generationStatus());
  const listProviders = vi.fn().mockResolvedValue({
    items: [{
      provider_config_id: "prov_1", display_name: "本地网关", model: "vision-model",
      enabled: true, credential_status: "configured",
    }],
  });
  const base = {
    prepareKeyframePreview, excludeKeyframeFrames, createKeyframeGeneration,
    getKeyframeGeneration, listProviders,
  };
  // 用合并后的对象回填 window 并**原样返回**：若返回合并前的局部 spy，
  // 断言会打在没人调用的替身上（区分力归零），这是本文件曾经的坑。
  const desktop = { ...base, ...overrides } as unknown as typeof base;
  (window as unknown as { desktop: Record<string, unknown> }).desktop = desktop;
  return desktop;
}

/** 走到「已生成预览 + 已勾选同意」，此时「确认外传」可点。 */
async function readyToSubmit() {
  const view = renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "生成关键帧预览" }));
  await screen.findByText("#0");
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => {
    expect((screen.getByRole("button", { name: "确认外传" }) as HTMLButtonElement).disabled).toBe(false);
  });
  return view;
}

/** 提交按钮会随相位改名（确认外传 → 提交中 → 已提交），按同一位置取。 */
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(确认外传|提交中…|已提交)$/ }) as HTMLButtonElement;
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

/**
 * W3.3 收口：「用户同意 → create → generation」。
 *
 * 这组用例守着当前真实缺陷的形态：按钮原本写的是 `onClick={onClose}`，
 * 只关弹窗、从不调用 createKeyframeGeneration，链路在界面上是断的。
 * 把按钮改回 onClose，下面第一条必须变红。
 */
describe("KeyframeReviewPanel（同意即外传）", () => {
  beforeEach(() => { setup(); });

  it("点「确认外传」只调用一次 createKeyframeGeneration，入参取自预览", async () => {
    const { createKeyframeGeneration } = setup();
    await readyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));

    await waitFor(() => expect(createKeyframeGeneration).toHaveBeenCalledTimes(1));
    expect(createKeyframeGeneration).toHaveBeenCalledWith({
      project_id: projectId,
      preview_id: "kp_1",
      payload_sha256: "c".repeat(64),
    });
    // 提交过就不许再点第二下（重复提交等于二次外传）。
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(submitButton().textContent).toBe("已提交");
    fireEvent.click(submitButton());
    expect(createKeyframeGeneration).toHaveBeenCalledTimes(1);
  });

  it("轮询到 succeeded 后展示帧数与词表违规数（0 也要显示）", async () => {
    const { getKeyframeGeneration } = setup({
      getKeyframeGeneration: vi.fn()
        .mockResolvedValueOnce(generationStatus({ status: "queued" }))
        .mockResolvedValueOnce(generationStatus({
          status: "succeeded", frame_count: 12, vocabulary_violations: 0, vocabulary_version: 3,
        })),
    });
    await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));

    // 第一次返回 queued ⇒ 必须继续轮询，否则这里永远等不到结果。
    expect(await screen.findByText(/生成完成/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/共 12 帧/)).toBeTruthy();
    expect(screen.getByText(/词表违规 0 处/)).toBeTruthy();
    expect(getKeyframeGeneration).toHaveBeenCalledWith({
      project_id: projectId, generation_id: "gen_1",
    });
  });

  it("轮询到 failed 只给稳定文案与可操作提示，不把上游原文送上屏", async () => {
    setup({
      getKeyframeGeneration: vi.fn().mockResolvedValue(generationStatus({
        status: "failed",
        error_code: "PROVIDER_AUTH_FAILED",
      })),
    });
    await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));

    expect(await screen.findByText(/Provider 认证失败/)).toBeTruthy();
    // 错误码本身不上屏：它可能携带上游原文片段。
    expect(screen.queryByText(/PROVIDER_AUTH_FAILED/)).toBeNull();
  });

  it("未登记的错误码退回稳定文案，上游原文一个字都不出现", async () => {
    setup({
      getKeyframeGeneration: vi.fn().mockResolvedValue(generationStatus({
        status: "failed",
        // Core 透传的上游原文：路径 + 内部标识，绝不能上屏。
        error_code: "Error: 500 vision backend at C:/secret/db.sqlite",
      })),
    });
    await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));

    expect(await screen.findByText(/关键帧理解未完成/)).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.queryByText(/vision backend/)).toBeNull();
  });

  it("提交成功后禁止再改动这批关键帧（exclude 禁用）", async () => {
    const { excludeKeyframeFrames } = setup();
    await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));

    const remove = await screen.findByRole("button", { name: "移除第 1 帧" }) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(true));
    fireEvent.click(remove);
    expect(excludeKeyframeFrames).not.toHaveBeenCalled();
  });

  it("切换到别的项目时预览与结果一并清空（旧预览不能带过去 create）", async () => {
    setup({
      getKeyframeGeneration: vi.fn().mockResolvedValue(generationStatus({
        status: "succeeded", frame_count: 3, vocabulary_violations: 1, vocabulary_version: 2,
      })),
    });
    const view = await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));
    expect(await screen.findByText(/生成完成/, {}, { timeout: 5000 })).toBeTruthy();

    view.rerender(
      <KeyframeReviewPanel
        projectId={"project_2" as never}
        assetId={assetId}
        assetName={"素材乙"}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(screen.queryByText("#0")).toBeNull());
    expect(screen.queryByText(/生成完成/)).toBeNull();
    expect(screen.getByRole("button", { name: "生成关键帧预览" })).toBeTruthy();
  });

  it("卸载后不再轮询、不再 setState", async () => {
    const getKeyframeGeneration = vi.fn().mockResolvedValue(generationStatus({ status: "queued" }));
    setup({ getKeyframeGeneration });
    const view = await readyToSubmit();
    fireEvent.click(screen.getByRole("button", { name: "确认外传" }));
    // 让第一次轮询真的发生，确认轮询是活的（否则下面「不再调用」没有区分力）。
    await waitFor(() => expect(getKeyframeGeneration).toHaveBeenCalledTimes(1));

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // React 卸载后再 setState 会告警；这里同时断言轮询确实停了。
    expect(getKeyframeGeneration).toHaveBeenCalledTimes(1);
  });
});

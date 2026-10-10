import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AngleGroup } from "@aivideo/contracts";
import { AngleSyncPanel } from "../src/app/angle-sync/AngleSyncPanel.js";

/** W2.1 机位同步面板：建组→同步、状态如实展示、人工偏移。 */

const now = "2026-10-10T00:00:00.000Z";

function asset(assetId: string, displayName: string) {
  return {
    asset: {
      asset_id: assetId, project_id: "project_1", kind: "video", storage_mode: "external",
      display_name: displayName, fingerprint: "sha256:" + assetId, size_bytes: 10,
      modified_at: now, availability: "available", media_info: { duration_us: 20_000_000 },
      created_at: now, updated_at: now
    },
    media_url: "aivideo://media/" + assetId
  } as never;
}

function angle(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asset_id: "asset_a", is_reference: false, status: "ready", reason: null,
    offset_us: 687_000, confidence: 0.93, source: "auto", stale: false,
    recorded_at: now, ...overrides
  } as never;
}

function group(overrides: Partial<AngleGroup> = {}): AngleGroup {
  return {
    group_id: "angle_group_1", project_id: "project_1", name: "双机位",
    reference_asset_id: "asset_a", algorithm_version: "1",
    angles: [angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
             angle({ asset_id: "asset_b" })],
    created_at: now, updated_at: now, ...overrides
  } as never;
}

function setup(overrides: Record<string, unknown> = {}) {
  const desktop = {
    listAngleGroups: vi.fn().mockResolvedValue({ items: [] }),
    createAngleGroup: vi.fn().mockResolvedValue(group()),
    syncAngleGroup: vi.fn().mockResolvedValue({ job_id: "job_1", group: group() }),
    getJob: vi.fn().mockResolvedValue({ status: "succeeded", error: null }),
    deleteAngleGroup: vi.fn().mockResolvedValue({ group_id: "angle_group_1", deleted: true }),
    getAngleGroup: vi.fn().mockResolvedValue(group()),
    setAngleOffset: vi.fn().mockResolvedValue(group({
      angles: [angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
               angle({ asset_id: "asset_b", offset_us: -253_000, source: "manual" })]
    })),
    ...overrides
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  const onNotify = vi.fn();
  render(<AngleSyncPanel projectId={"project_1" as never}
    assets={[asset("asset_a", "机位A.mp4"), asset("asset_b", "机位B.mp4")]}
    onClose={() => undefined} onNotify={onNotify} />);
  return { desktop, onNotify };
}

describe("W2.1 机位同步面板", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("建组并同步：参考机位 + 勾选成员，随后渲染偏移表", async () => {
    const { desktop } = setup();
    const dialog = screen.getByRole("dialog", { name: "机位同步" });
    expect(await within(dialog).findByText(/本地音频互相关对齐/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "建组并同步" }));
    await waitFor(() => expect(desktop.createAngleGroup).toHaveBeenCalledTimes(1));
    expect(desktop.createAngleGroup.mock.calls[0][0]).toMatchObject({
      project_id: "project_1", name: "双机位", reference_asset_id: "asset_a",
      member_asset_ids: ["asset_a", "asset_b"]
    });
    expect(desktop.syncAngleGroup).toHaveBeenCalledWith({
      project_id: "project_1", group_id: "angle_group_1", generate: true
    });
    const table = await within(dialog).findByRole("table");
    expect(within(table).getByText(/\+687\.0 ms/)).toBeTruthy();
  });

  it("状态如实展示：不可用给原因、素材变化标 stale、人工来源单独标注", async () => {
    setup({ listAngleGroups: vi.fn().mockResolvedValue({ items: [group({
      angles: [
        angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
        angle({ asset_id: "asset_b", status: "unavailable", reason: "low_confidence", offset_us: null, confidence: 0.05 }),
        angle({ asset_id: "asset_c", status: "stale", stale: true, offset_us: 1000 }),
        angle({ asset_id: "asset_d", source: "manual", offset_us: -253_000 })
      ]
    })] }) });
    const dialog = screen.getByRole("dialog", { name: "机位同步" });
    expect(await within(dialog).findByText("不可用")).toBeTruthy();
    expect(within(dialog).getByText(/相关性不足/)).toBeTruthy();
    expect(within(dialog).getByText("素材已变化")).toBeTruthy();
    expect(within(dialog).getAllByText("人工").length).toBe(1);
    expect(within(dialog).getByText(/-253\.0 ms/)).toBeTruthy();
  });


  it("作业在飞：显示分析中提示，作业成功后自动刷新为已就绪（以 jobs 终态为轮询依据）", async () => {
    const syncedGroup = group({
      angles: [angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
               angle({ asset_id: "asset_b", offset_us: 687_000 })]
    });
    const { desktop } = setup({
      createAngleGroup: vi.fn().mockResolvedValue(group({
        angles: [angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
                 angle({ asset_id: "asset_b", status: "missing", offset_us: null, confidence: null, source: null })]
      })),
      syncAngleGroup: vi.fn().mockResolvedValue({ job_id: "job_1", group: group({
        angles: [angle({ asset_id: "asset_a", is_reference: true, offset_us: 0 }),
                 angle({ asset_id: "asset_b", status: "missing", offset_us: null, confidence: null, source: null })]
      }) }),
      getAngleGroup: vi.fn().mockResolvedValue(syncedGroup)
    });
    const dialog = screen.getByRole("dialog", { name: "机位同步" });
    fireEvent.click(within(dialog).getByRole("button", { name: "建组并同步" }));
    expect(await within(dialog).findByText(/机位同步分析中/)).toBeTruthy();
    await waitFor(() => expect(desktop.getJob).toHaveBeenCalledWith("job_1"), { timeout: 5_000 });
    await waitFor(() => expect(desktop.getAngleGroup).toHaveBeenCalled(), { timeout: 5_000 });
    await waitFor(() => {
      const table = within(dialog).queryByRole("table");
      expect(table?.textContent ?? "(无表格)").toContain("+687.0 ms");
    }, { timeout: 5_000 });
  });


  it("删除机位组：两步确认后调用 deleteAngleGroup 并刷新列表", async () => {
    const { desktop } = setup({
      listAngleGroups: vi.fn().mockResolvedValue({ items: [group()] })
    });
    const dialog = screen.getByRole("dialog", { name: "机位同步" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "删除机位组" }));
    expect(desktop.deleteAngleGroup).not.toHaveBeenCalled();     // 第一次点击只进入确认态
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除机位组" }));
    await waitFor(() => expect(desktop.deleteAngleGroup).toHaveBeenCalledWith({
      project_id: "project_1", group_id: "angle_group_1"
    }));
    await waitFor(() => expect(desktop.listAngleGroups).toHaveBeenCalledTimes(2));
  });

  it("人工偏移：毫秒换算成微秒提交，非数字给错误提示", async () => {
    const { desktop } = setup({ listAngleGroups: vi.fn().mockResolvedValue({ items: [group()] }) });
    const dialog = screen.getByRole("dialog", { name: "机位同步" });
    const input = await within(dialog).findByLabelText("手填偏移 机位B.mp4");

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "保存" })[1]);
    expect(await within(dialog).findByText(/请填写毫秒数/)).toBeTruthy();
    expect(desktop.setAngleOffset).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "-253" } });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "保存" })[1]);
    await waitFor(() => expect(desktop.setAngleOffset).toHaveBeenCalledWith({
      project_id: "project_1", group_id: "angle_group_1", asset_id: "asset_b", offset_us: -253_000
    }));
    expect(await within(dialog).findByText("人工")).toBeTruthy();
  });
});

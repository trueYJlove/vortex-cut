import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, TimelineState } from "@aivideo/contracts";
import type { DesktopApi } from "../electron/preload/index.js";
import { App } from "../src/app/App.js";
import {
  desktopApi,
  expectSwitcherName,
  now,
  project,
  runningJob,
  stage3aPreview,
  stage3bPlatform,
  stage3bReframePreview,
  stage3bRendition,
  state,
  timelineDocument,
  transcript,
  video,
} from "./helpers/app-test-harness.js";

describe("Stage 1C Editor", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("渲染固定编辑工作台且不暴露敏感字段", async () => {
    render(<App />); await expectSwitcherName("演示项目"); await within(screen.getByRole("region", { name: "媒体库" })).findByText(video.display_name); expect(screen.getByText("V1")).toBeVisible(); expect(screen.getByText("C1")).toBeVisible(); expect(await screen.findByRole("note", { name: "合成预览回退提示" })).toBeVisible(); expect(document.body.textContent).not.toContain("C:\\");
  });

  it("synchronously captures native multi-file drops, imports supported files, and keeps them if the timeline patch fails", async () => {
    const api = desktopApi();
    const droppedAsset = { ...video, asset_id: "asset_dropped" as never, display_name: "Dropped scene.mp4" };
    vi.mocked(api.importDroppedAssets).mockResolvedValue({
      imported: [{ asset: droppedAsset, media_url: "aivideo://media/dropped", grant: { grant_id: "grant_drop" as never, display_name: droppedAsset.display_name, size_bytes: 10, modified_at: now, expires_at: now } }],
      failures: [{ name: "notes.txt", reason: "unsupported" }],
    });
    api.createPreviewSourceJob = vi.fn().mockResolvedValue({ job: null, reused: false });
    api.patchTimeline = vi.fn().mockRejectedValue(new Error("TIMELINE_INVALID"));
    window.desktop = api;
    render(<App />);
    await expectSwitcherName("演示项目");
    await screen.findByRole("button", { name: /video 5\.00s/ });
    const target = screen.getByLabelText("时间线画布");
    const videoFile = new File(["video"], "scene.mp4", { type: "video/mp4" });
    const textFile = new File(["notes"], "notes.txt", { type: "text/plain" });
    const getData = vi.fn(() => "");
    const dataTransfer = { types: ["Files"], files: [videoFile, textFile], items: [], getData, dropEffect: "none" };
    fireEvent.dragOver(target, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(getData).not.toHaveBeenCalled();
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(api.importDroppedAssets).toHaveBeenCalledWith({ project_id: project.project_id, files: [videoFile, textFile] }));
    await waitFor(() => expect(screen.getByText(droppedAsset.display_name)).toBeVisible());
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(droppedAsset.display_name)).toBeVisible();
    expect(await screen.findByText(/成功导入的素材已保留在素材栏；时间线未修改/)).toBeVisible();
    expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [
      expect.objectContaining({ op: "add_track", kind: "video" }),
      expect.objectContaining({ op: "insert_asset_clip", asset_id: droppedAsset.asset_id, at_index: 0, track_id: "V2" }),
    ] }) }));
  });

  it("支持片段与字幕编辑", async () => {
    const api = desktopApi(); window.desktop = api; render(<App />); await expectSwitcherName("演示项目"); fireEvent.click(await screen.findByRole("button", { name: /video 5.00s/ }, { timeout: 5000 })); fireEvent.keyDown(screen.getByRole("slider", { name: "时间线播放头" }), { key: "End" }); for (let i = 0; i < 30; i += 1) fireEvent.keyDown(screen.getByRole("slider", { name: "时间线播放头" }), { key: "ArrowLeft" }); await waitFor(() => expect(screen.getByRole("button", { name: "拆分片段" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "拆分片段" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "split_clip" })] }) })));
    fireEvent.click(screen.getByRole("radio", { name: "裁切填满" })); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "set_layout", layout: "crop_fill" })] }) }))); fireEvent.click(screen.getByRole("button", { name: /这是一条很长/ })); fireEvent.change(screen.getByLabelText("文本"), { target: { value: "修正字幕" } }); fireEvent.blur(screen.getByLabelText("文本")); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "update_caption", text: "修正字幕" })] }) })));
  });

  it("创建空时间线后忽略迟到的 404，并以冻结契约追加素材与转录", async () => {
    let rejectTimeline!: (reason: unknown) => void; const pendingTimeline = new Promise<TimelineState>((_, reject) => { rejectTimeline = reject; }); const api = desktopApi({ timeline: null }); api.getTimeline = vi.fn().mockReturnValue(pendingTimeline); window.desktop = api; render(<App />); fireEvent.click(await screen.findByRole("button", { name: "创建空时间线" })); await screen.findByRole("button", { name: /video 5.00s/ }); rejectTimeline(new Error("TIMELINE_NOT_FOUND 404"));
    fireEvent.dragOver(screen.getByLabelText("时间线画布"), { dataTransfer: { getData: (type: string) => type === "application/x-vortex-cut-asset" ? video.asset_id : "", dropEffect: "copy" } }); fireEvent.drop(screen.getByLabelText("时间线画布"), { dataTransfer: { getData: (type: string) => type === "application/x-vortex-cut-asset" ? video.asset_id : "", dropEffect: "copy" } }); await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ operations: [expect.objectContaining({ op: "add_track", kind: "video" }), expect.objectContaining({ op: "insert_asset_clip" })] }) })));
    fireEvent.click(screen.getAllByRole("button", { name: /^转录$/ })[0]);
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ })); fireEvent.click(await screen.findByRole("button", { name: /查看转录/ })); fireEvent.click(await screen.findByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "追加所选片段" }));
    await waitFor(() => expect(api.patchTimeline).toHaveBeenCalledTimes(2)); const operation = vi.mocked(api.patchTimeline).mock.calls[1][0].patch.operations[0]; expect(operation).toEqual({ op: "insert_transcript_segments", transcript_id: transcript.transcript_id, segment_ids: [transcript.segments[0].segment_id], at_index: timelineDocument.clips.length, padding_before_us: 150_000, padding_after_us: 150_000, create_captions: true, layout: "blurred_background" }); expect(operation).not.toHaveProperty("kind");
  });

  it("使用服务端 Revision 执行撤销重做并显示草稿恢复入口", async () => {
    const api = desktopApi({ timeline: { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } } }); window.desktop = api; render(<App />); expect(await screen.findByText("检测到上次未恢复草稿")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "丢弃" })); expect(api.deleteTimelineDraft).toHaveBeenCalledWith("project_1"); fireEvent.click(screen.getByRole("button", { name: "撤销" })); await waitFor(() => expect(api.undoTimeline).toHaveBeenCalled()); fireEvent.click(screen.getByRole("button", { name: "重做" })); await waitFor(() => expect(api.redoTimeline).toHaveBeenCalled());
  });
});

describe("Stage 1C Render", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => cleanup());

  it("按冻结 Revision 和编码模式创建权威预览，并允许无预览直接导出", async () => {
    const api = desktopApi();
    const previewJob = { ...runningJob, job_id: "job_preview" as never, asset_id: null, kind: "authoritative_preview" as const, status: "queued" as const, stage: "queued" };
    const exportJob = { ...previewJob, job_id: "job_export" as never, kind: "final_export" as const };
    vi.mocked(api.createPreview).mockResolvedValue({ job: previewJob, preview: null, reused: false });
    vi.mocked(api.chooseExportDestination).mockResolvedValue({ destination_grant_id: "destination_1" as never, display_name: "演示项目.mp4", extension: ".mp4", overwrite_authorized: false, expires_at: now });
    vi.mocked(api.createExport).mockResolvedValue({ job: exportJob, export_record: null });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    const previewButton = screen.getByRole("button", { name: "生成权威预览" });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "预览设置" }));
    fireEvent.change(screen.getByLabelText("编码模式"), { target: { value: "software" } });
    fireEvent.click(previewButton);
    await waitFor(() => expect(api.createPreview).toHaveBeenCalledWith({ project_id: project.project_id, preview: { timeline_revision_id: state.current_revision.timeline_revision_id, encoder_mode: "software", output_ratio: "916" } }));
    fireEvent.click(screen.getByRole("button", { name: "导出正式视频" }));
    const dialog = await screen.findByRole("dialog", { name: "导出视频" });
    fireEvent.click(within(dialog).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(api.chooseExportDestination).toHaveBeenCalledWith(project.project_id, "演示项目"));
    await waitFor(() => expect(api.createExport).toHaveBeenCalledWith({ project_id: project.project_id, export: { timeline_revision_id: state.current_revision.timeline_revision_id, destination_grant_id: "destination_1", encoder_mode: "software", output_ratio: "916", quality: "standard", resolution: "1080p", frame_rate: 30 } }));
  });

  it("空时间线和草稿会阻止 Render 提交", async () => {
    const emptyDocument = { ...timelineDocument, clips: [], captions: [] };
    const emptyState = { ...state, current_revision: { ...state.current_revision, document: emptyDocument } };
    const emptyApi = desktopApi({ timeline: emptyState }); window.desktop = emptyApi; render(<App />);
    expect(await screen.findByRole("button", { name: "生成权威预览" })).toBeDisabled(); expect(screen.getByRole("button", { name: "导出正式视频" })).toBeDisabled();
    cleanup();
    const draftState = { ...state, draft: { project_id: project.project_id, base_revision_id: state.current_revision.timeline_revision_id, document: timelineDocument, updated_at: now, conflict: false } };
    const draftApi = desktopApi({ timeline: draftState }); window.desktop = draftApi; render(<App />);
    await waitFor(() => {
      expect(screen.getByText("检测到上次未恢复草稿")).toBeVisible();
      expect(screen.getByRole("button", { name: "生成权威预览" })).toHaveAttribute("title", "存在未提交草稿，请先形成正式 Revision");
    });
  });
});

describe("Stage 3B 静态焦点重构图", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function setupStage3bApi(timeline: TimelineState = state) {
    const api = desktopApi({ timeline });
    vi.mocked(api.listPlatformPresets).mockResolvedValue({ items: [stage3bPlatform] });
    vi.mocked(api.listRenditionPresets).mockResolvedValue({ items: [stage3bRendition] });
    vi.mocked(api.listRenditionPreviews).mockResolvedValue({ items: [stage3aPreview("preserve_timeline"), stage3aPreview("fit_all"), stage3aPreview("crop_fill_all"), stage3aPreview("blurred_background_all")], next_cursor: null });
    vi.mocked(api.createRenditionReframePreview).mockResolvedValue({ job: null, preview: stage3bReframePreview, reused: true });
    return api;
  }

  async function openStage3b(api: DesktopApi) {
    window.desktop = api;
    render(<App />);
    const entry = await screen.findByRole("button", { name: "多平台导出" });
    await waitFor(() => expect(entry).toBeEnabled());
    fireEvent.click(entry);
    return await screen.findByRole("dialog", { name: "多平台导出" });
  }

  it("只为解析为 crop_fill 的 Clip 显示固定 3×3，并展示非 AI 与安全区边界", async () => {
    const cropDocument = { ...timelineDocument, clips: timelineDocument.clips.map(clip => ({ ...clip, layout: "crop_fill" as const })) };
    const cropState = { ...state, current_revision: { ...state.current_revision, document: cropDocument } };
    const dialog = await openStage3b(setupStage3bApi(cropState));
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    expect(within(editor).getByRole("group", { name: "Clip 1 静态焦点" })).toBeVisible();
    expect(within(editor).getAllByRole("button", { name: /^Clip 1 / })).toHaveLength(9);
    expect(editor).toHaveTextContent("非自动识别"); expect(editor).toHaveTextContent("非动态跟踪"); expect(editor).toHaveTextContent("不保证平台审核安全区");
    expect(within(editor).getByRole("button", { name: "生成重构图权威预览" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "fit_all" } });
    expect(within(dialog).getByText(/没有解析为 crop_fill/)).toBeVisible();
    expect(within(dialog).queryByRole("group", { name: "Clip 1 静态焦点" })).not.toBeInTheDocument();
  });

  it("中心点只执行删除语义，非中心 adjustment 才发送且选择变化使旧预览失效", async () => {
    const api = setupStage3bApi();
    const dialog = await openStage3b(api);
    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "crop_fill_all" } });
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 左上" }));
    fireEvent.click(within(editor).getByRole("button", { name: "生成重构图权威预览" }));
    await waitFor(() => expect(api.createRenditionReframePreview).toHaveBeenCalledWith({ project_id: project.project_id, preview: { base_rendition_snapshot_id: "rendition_snapshot_crop_fill_all", adjustments: [{ clip_id: "clip_1", horizontal_anchor: "left", vertical_anchor: "top" }], encoder_mode: "auto" } }));
    expect(await within(editor).findByRole("button", { name: "播放重构图预览" })).toBeVisible();

    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 中心" }));
    expect(within(editor).getByRole("button", { name: "生成重构图权威预览" })).toBeDisabled();
    expect(within(editor).queryByRole("button", { name: "播放重构图预览" })).not.toBeInTheDocument();
    expect(api.createRenditionReframePreview).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(api.createRenditionReframePreview).mock.calls)).not.toContain('"horizontal_anchor":"center","vertical_anchor":"center"');
  });

  it("任务成功后刷新独立 Reframe Preview，Batch payload 从 Snapshot 派生且不含 Revision", async () => {
    const api = setupStage3bApi();
    let listener: ((job: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_jobId, next) => { listener = next; return () => undefined; });
    const reframeJob = { ...runningJob, job_id: "job_reframe" as never, asset_id: null, kind: "authoritative_preview" as const, input: { rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1" } };
    vi.mocked(api.createRenditionReframePreview).mockResolvedValue({ job: reframeJob, preview: null, reused: false });
    vi.mocked(api.listRenditionReframePreviews).mockResolvedValue({ items: [stage3bReframePreview], next_cursor: null });
    vi.mocked(api.chooseExportDirectory).mockResolvedValue({ directory_grant_id: "directory_reframe_1" as never, display_name: "Exports", expires_at: now });
    vi.mocked(api.createReframeExportBatch).mockResolvedValue({ batch: { reframe_export_batch_id: "reframe_export_batch_1" as never, project_id: project.project_id, timeline_revision_id: state.current_revision.timeline_revision_id, status: "queued", directory_display_name: "Exports", items: [], retry_of_batch_id: null, created_at: now, updated_at: now }, jobs: [] });

    const dialog = await openStage3b(api);
    fireEvent.change(within(dialog).getByLabelText("目标布局策略"), { target: { value: "crop_fill_all" } });
    const editor = within(dialog).getByRole("region", { name: "静态焦点重构图" });
    fireEvent.click(within(editor).getByRole("button", { name: "Clip 1 右" }));
    fireEvent.click(within(editor).getByRole("button", { name: "生成重构图权威预览" }));
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => { listener?.({ ...reframeJob, status: "succeeded", stage: "completed", progress: 1 }); await Promise.resolve(); });
    expect(await within(editor).findByRole("button", { name: "播放重构图预览" })).toBeVisible();

    const choose = within(dialog).getByRole("button", { name: "选择重构图输出目录" });
    expect(choose).toBeEnabled(); fireEvent.click(choose);
    const create = await within(dialog).findByRole("button", { name: "创建重构图批次" });
    await waitFor(() => expect(create).toBeEnabled()); fireEvent.click(create);
    await waitFor(() => expect(api.createReframeExportBatch).toHaveBeenCalled());
    const payload = vi.mocked(api.createReframeExportBatch).mock.calls[0][0];
    expect(payload).toEqual({ project_id: project.project_id, batch: { directory_grant_id: "directory_reframe_1", items: [{ rendition_reframe_snapshot_id: "rendition_reframe_snapshot_1", preview_artifact_id: "reframe_artifact_1", encoder_mode: "auto" }] } });
    expect(payload.batch).not.toHaveProperty("timeline_revision_id");
  });
});

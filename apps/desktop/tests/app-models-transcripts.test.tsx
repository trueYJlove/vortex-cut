import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import { formatLocalStamp } from "../src/app/localTime.js";
import {
  createdJob,
  desktopApi,
  expectSwitcherName,
  job,
  model,
  now,
  readyModel,
  video,
} from "./helpers/app-test-harness.js";

describe("Stage 1A/1B 模型、任务与转录生命周期", () => {
  beforeEach(() => { window.desktop = desktopApi(); });
  afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); });

  it("支持模型确认下载、取消下载、发起转录及任务取消重试", async () => {
    const api = desktopApi({ models: [model] }); window.desktop = api; render(<App />); fireEvent.click(screen.getByRole("tab", { name: /^模型/ })); await screen.findByText("本地测试模型");
    fireEvent.click(screen.getByRole("button", { name: "下载模型" })); expect(await screen.findByRole("heading", { name: "确认下载本地模型" })).toBeVisible(); const confirm = screen.getByRole("button", { name: "确认并下载" }); expect(confirm).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /接受/ })); fireEvent.click(confirm); await waitFor(() => expect(api.downloadModel).toHaveBeenCalledWith({ model_id: model.model_id, license_acceptance: "license_1" }));
    fireEvent.click(await screen.findByTitle("取消模型下载")); await waitFor(() => expect(api.cancelModelDownload).toHaveBeenCalledWith(model.model_id));
    const readyApi = desktopApi({ models: [readyModel], jobs: [job] }); window.desktop = readyApi; cleanup(); render(<App />); fireEvent.click(screen.getByRole("tab", { name: /^模型/ })); await screen.findByText("本地测试模型");
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ })); fireEvent.click(await screen.findByTitle("转录")); expect(await screen.findByRole("heading", { name: "创建本地转录" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "开始转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledWith(expect.objectContaining({ asset_id: video.asset_id, model_id: model.model_id })));
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "重试转录" })); await waitFor(() => expect(readyApi.createTranscription).toHaveBeenCalledTimes(2)); fireEvent.click(screen.getAllByRole("button", { name: "取消" })[0]); await waitFor(() => expect(readyApi.cancelJob).toHaveBeenCalledWith("job_created_2"));
  });

  it("转录完成后刷新转录摘要，转录页出现可勾选片段", async () => {
    const api = desktopApi({ models: [readyModel] });
    let listener: ((job: Job) => void) | undefined;
    api.subscribeJob = vi.fn((_id, next) => { listener = next; return () => undefined; });
    let listed = 0;
    const listTranscripts = vi.fn().mockImplementation(async () => {
      listed += 1;
      return listed === 1
        ? { items: [], next_cursor: null }
        : { items: [{ transcript_id: "transcript_1", asset_id: video.asset_id, status: "ready", language: "zh", duration_us: 1_000_000, created_at: now, updated_at: now } as never], next_cursor: null };
    });
    api.listTranscripts = listTranscripts;
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ })); fireEvent.click(await screen.findByTitle("转录"));
    fireEvent.click(await screen.findByRole("button", { name: "开始转录" }));
    await waitFor(() => expect(api.subscribeJob).toHaveBeenCalled());
    act(() => listener?.({ ...createdJob, job_id: "job_created_1" as never, status: "succeeded" } as Job));
    await waitFor(() => expect(listTranscripts.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    expect(await screen.findByRole("checkbox", { name: /第一句/ })).toBeVisible();
  });

  it("转录终态经轮询对账后刷新摘要（不依赖未接通的 subscribeJob）", async () => {
    const api = desktopApi({ models: [readyModel] });
    api.subscribeJob = vi.fn(() => () => undefined);
    let listed = 0;
    const listTranscripts = vi.fn().mockImplementation(async () => {
      listed += 1;
      return listed === 1
        ? { items: [], next_cursor: null }
        : { items: [{ transcript_id: "transcript_1", asset_id: video.asset_id, status: "ready", language: "zh", duration_us: 1_000_000, created_at: now, updated_at: now } as never], next_cursor: null };
    });
    api.listTranscripts = listTranscripts;
    api.listJobs = vi.fn().mockResolvedValue({ items: [{ ...createdJob, job_id: "job_created_1" as never, status: "running", progress: 0.5 }], next_cursor: null });
    api.getJob = vi.fn().mockResolvedValue({ ...createdJob, job_id: "job_created_1" as never, status: "succeeded", progress: 1 } as Job);
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ })); fireEvent.click(await screen.findByTitle("转录"));
    fireEvent.click(await screen.findByRole("button", { name: "开始转录" }));
    await waitFor(() => expect(api.subscribeJob).toHaveBeenCalled());
    api.listJobs = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(listTranscripts.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000 });
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    expect(await screen.findByRole("button", { name: /查看转录 transcript_1/ })).toBeVisible();
  });

  it("单条转录摘要拉取失败不会抹掉其它已加载的转录", async () => {
    const api = desktopApi({ models: [readyModel] });
    api.subscribeJob = vi.fn(() => () => undefined);
    let failNext = false;
    const listTranscripts = vi.fn().mockImplementation(async () => {
      if (failNext) throw new Error("ECONNREFUSED");
      return { items: [{ transcript_id: "transcript_1", asset_id: video.asset_id, status: "ready", language: "zh", duration_us: 1_000_000, created_at: now, updated_at: now } as never], next_cursor: null };
    });
    api.listTranscripts = listTranscripts;
    api.listJobs = vi.fn().mockResolvedValue({ items: [{ ...createdJob, job_id: "job_created_1" as never, status: "running", progress: 0.5 }], next_cursor: null });
    api.getJob = vi.fn().mockResolvedValue({ ...createdJob, job_id: "job_created_1" as never, status: "succeeded", progress: 1 } as Job);
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    expect(await screen.findByRole("button", { name: /查看转录 transcript_1/ })).toBeVisible();
    failNext = true;
    fireEvent.click(screen.getByRole("tab", { name: /^素材/ })); fireEvent.click(await screen.findByTitle("转录"));
    fireEvent.click(await screen.findByRole("button", { name: "开始转录" }));
    await waitFor(() => expect(api.subscribeJob).toHaveBeenCalled());
    api.listJobs = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
    await waitFor(() => expect(listTranscripts.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000 });
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    expect(screen.getByRole("button", { name: /查看转录 transcript_1/ })).toBeVisible();
    expect(screen.queryByText(/尚未生成转录/)).toBeNull();
  });

  it("转录页每条记录只出现一次，点开后不新增重复记录", async () => {
    const api = desktopApi();
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    const transcriptList = document.querySelector(".transcript-list") as HTMLElement;
    const before = await within(transcriptList).findAllByText(video.display_name);
    expect(before).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    expect(await screen.findByRole("checkbox", { name: /第一句/ })).toBeVisible();
    expect(within(transcriptList).getAllByText(video.display_name)).toHaveLength(1);
    expect(document.querySelectorAll(".transcript-item")).toHaveLength(1);
  });

  it("未打开过的转录也能直接删除（无需先点开正文）", async () => {
    const api = desktopApi();
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_1/ }));
    const dialog = await screen.findByRole("dialog", { name: "删除转录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除转录" }));
    await waitFor(() => expect(api.deleteTranscript).toHaveBeenCalledWith("transcript_1"));
  });

  it("同类任务行可区分（素材名 + 时间），不只显示相同标题", async () => {
    const first = "2026-10-06T11:25:39.989Z";
    const second = "2026-10-06T07:30:19.056Z";
    const api = desktopApi({ jobs: [
      { ...job, job_id: "job_a" as never, status: "succeeded", stage: "completed", created_at: first },
      { ...job, job_id: "job_b" as never, status: "succeeded", stage: "completed", created_at: second },
    ] });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    expect(await screen.findByText(new RegExp(formatLocalStamp(first).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeVisible();
    expect(screen.getByText(new RegExp(formatLocalStamp(second).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeVisible();
  });

  it("可删除已结束任务；进行中任务只提供取消，不提供删除", async () => {
    const api = desktopApi({ jobs: [
      { ...job, job_id: "job_done" as never, status: "succeeded", stage: "completed" },
      { ...job, job_id: "job_run" as never, status: "running", stage: "transcribing" },
    ] });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    expect(screen.queryByRole("button", { name: /删除任务 job_run/ })).not.toBeInTheDocument();
    const deleteBtn = await screen.findByRole("button", { name: /删除任务 job_done/ });
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(api.deleteJob).toHaveBeenCalledWith("job_done"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /删除任务 job_done/ })).not.toBeInTheDocument());
  });

  it("任务被引用时删除给出下一步提示", async () => {
    const api = desktopApi({ jobs: [
      { ...job, job_id: "job_ref" as never, status: "succeeded", stage: "completed" },
    ] });
    api.deleteJob = vi.fn().mockRejectedValue(new Error("[JOB_REFERENCED] in use"));
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^任务/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除任务 job_ref/ }));
    expect(await screen.findByText(/被渲染产物或生成记录引用，无法删除/)).toBeVisible();
  });

  it("转录删除需显式确认，且被时间线引用时给出下一步", async () => {
    const api = desktopApi();
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_1/ }));
    const dialog = await screen.findByRole("dialog", { name: "删除转录" });
    expect(within(dialog).getByText(/此操作不可撤销/)).toBeVisible();
    expect(api.deleteTranscript).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除转录" }));
    await waitFor(() => expect(api.deleteTranscript).toHaveBeenCalledWith("transcript_1"));
  });

  it("转录被时间线字幕引用时删除被拒并提示先移除", async () => {
    const api = desktopApi();
    api.deleteTranscript = vi.fn().mockRejectedValue(new Error("[TRANSCRIPTION_IN_USE] referenced"));
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /查看转录 transcript_1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_1/ }));
    const dialog = await screen.findByRole("dialog", { name: "删除转录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除转录" }));
    expect(await screen.findByText(/请先移除相关字幕或片段后再删除/)).toBeVisible();
  });

  it("删除成功后弹窗不得永久停在「删除中…」", async () => {
    const api = desktopApi();
    const summaries = (ids: string[]) => ({
      items: ids.map(id => ({ transcript_id: id, asset_id: video.asset_id, status: "ready", language: "zh", duration_us: 1_000_000, created_at: now, updated_at: now } as never)),
      next_cursor: null,
    });
    let deleted = false;
    api.listTranscripts = vi.fn().mockImplementation(async () => summaries(deleted ? ["transcript_2"] : ["transcript_1", "transcript_2"]));
    api.deleteTranscript = vi.fn().mockImplementation(async () => { deleted = true; });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_1/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "删除转录" })).getByRole("button", { name: "删除转录" }));
    await waitFor(() => expect(api.deleteTranscript).toHaveBeenCalledWith("transcript_1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /删除转录 transcript_1/ })).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_2/ }));
    const confirm = within(await screen.findByRole("dialog", { name: "删除转录" })).getByRole("button", { name: /删除/ });
    expect(confirm).toHaveTextContent("删除转录");
    expect(confirm).toBeEnabled();
  });

  it("删除成功后记录立即消失，不等权威列表重拉", async () => {
    const api = desktopApi();
    const summaries = (ids: string[]) => ({
      items: ids.map(id => ({ transcript_id: id, asset_id: video.asset_id, status: "ready", language: "zh", duration_us: 1_000_000, created_at: now, updated_at: now } as never)),
      next_cursor: null,
    });
    let hang = false;
    api.listTranscripts = vi.fn().mockImplementation(async () => {
      if (hang) return new Promise(() => undefined);
      return summaries(["transcript_1", "transcript_2"]);
    });
    window.desktop = api; render(<App />);
    await expectSwitcherName("演示项目");
    fireEvent.click(screen.getByRole("tab", { name: /^转录/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除转录 transcript_1/ }));
    hang = true;
    fireEvent.click(within(await screen.findByRole("dialog", { name: "删除转录" })).getByRole("button", { name: "删除转录" }));
    await waitFor(() => expect(api.deleteTranscript).toHaveBeenCalledWith("transcript_1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /删除转录 transcript_1/ })).toBeNull());
    expect(screen.getByRole("button", { name: /删除转录 transcript_2/ })).toBeVisible();
  });
});

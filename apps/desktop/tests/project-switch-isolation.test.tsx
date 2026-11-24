/** Project-switch isolation tests: delayed project-scoped responses must never
 * combine a new project with an old revision or asset.  The two heavy renderer
 * children are deliberately bridged with tiny React mocks so this test checks
 * request identity without starting a worker or drawing a real timeline. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetPresentation, Project, TimelineDocument, TimelineState } from "@aivideo/contracts";
import { App } from "../src/app/App.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";

// Keep the isolation test about App's request wiring, not WebCodecs/OffscreenCanvas.
vi.mock("../src/app/preview/SyntheticPreview.js", async () => {
  const React = await import("react");
  return {
    SyntheticPreview: (props: { projectId: string; revisionId: string | null; outputRatio: string; mediaUrls: Map<string, string> }) => {
      React.useEffect(() => {
        void window.desktop.getPreviewIrV2Manifest({
          project_id: props.projectId as never,
          timeline_revision_id: props.revisionId,
          output_ratio: props.outputRatio,
        });
      }, [props.projectId, props.revisionId, props.outputRatio, props.mediaUrls]);
      return React.createElement("div", { "data-testid": "synthetic-preview-bridge" });
    },
  };
});

vi.mock("../src/app/timeline/TimelineCanvas.js", async () => {
  const React = await import("react");
  return {
    TimelinePanel: (props: { document?: TimelineDocument; waveformCache?: { pyramidFor: (assetId: string) => Promise<unknown> } }) => {
      React.useEffect(() => {
        for (const clip of props.document?.clips ?? []) {
          void props.waveformCache?.pyramidFor(String(clip.asset_id));
        }
      }, [props.document, props.waveformCache]);
      return React.createElement("div", { "data-testid": "timeline-panel-bridge" });
    },
  };
});

const now = "2026-08-11T00:00:00.000Z";
const canvas = { width: 1080, height: 1920, fps_num: 30, fps_den: 1 };

type Id = string & { readonly __brand: never };
const id = (value: string) => value as Id;

function makeProject(projectId: string, name: string, revisionId: string): Project {
  return {
    project_id: id(projectId), name, status: "active", canvas, root_dir_name: name,
    current_timeline_revision_id: revisionId, created_at: now, updated_at: now, last_opened_at: now,
  };
}

function makeAsset(projectId: string, assetId: string, displayName: string): AssetPresentation {
  return {
    asset: {
      asset_id: id(assetId), project_id: id(projectId), kind: "video", storage_mode: "external",
      display_name: displayName, fingerprint: assetId.padEnd(64, "a"), size_bytes: 10,
      modified_at: now, availability: "available", media_info: { duration_us: 1_000_000 },
      created_at: now, updated_at: now,
    },
    media_url: `aivideo://media/${assetId}`,
  };
}

function makeTimeline(projectId: string, revisionId: string, assetId: string): TimelineState {
  const document: TimelineDocument = {
    schema_version: 1, project_id: id(projectId), canvas: { ...canvas, background_color: "#000000" },
    tracks: [
      { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
      { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
      { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    ],
    clips: [{
      clip_id: id(`clip-${projectId}`), track_id: "V1", order_index: 0, asset_id: id(assetId), asset_kind: "video",
      source_start_us: 0, source_end_us: 1_000_000, timeline_start_us: 0, timeline_end_us: 1_000_000,
      layout: "fit", audio: { enabled: true, gain_db: 0 },
    }],
    captions: [], provenance: { created_by: "user", source_transcript_ids: [] },
  };
  return {
    project_id: id(projectId), current_revision: {
      timeline_revision_id: id(revisionId), project_id: id(projectId), parent_revision_id: null,
      document_sha256: revisionId.padEnd(64, "a"), summary: "fixture", created_by: "user", created_at: now,
      schema_version: 1, document,
    }, draft: null, can_undo: false, can_redo: false, current_preview: null, active_transitions: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}

function switcherButton() {
  return screen.getByRole("button", { name: "切换项目" });
}
function selectProject(name: string) {
  fireEvent.click(switcherButton());
  fireEvent.click(within(screen.getByRole("listbox", { name: "选择项目" })).getByRole("option", { name: new RegExp(`${name} 活跃`) }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("project switch request isolation", () => {
  it("does not issue B requests with A revision/assets while B timeline and assets are delayed", async () => {
    const projectA = makeProject("project-a", "项目 A", "revision-a");
    const projectB = makeProject("project-b", "项目 B", "revision-b");
    const assetA = makeAsset(projectA.project_id, "asset-a", "素材 A.mp4");
    const assetB = makeAsset(projectB.project_id, "asset-b", "素材 B.mp4");
    const timelineA = makeTimeline(projectA.project_id, "revision-a", assetA.asset.asset_id);
    const timelineB = makeTimeline(projectB.project_id, "revision-b", assetB.asset.asset_id);
    const timelineBResponse = deferred<TimelineState>();
    const assetsBResponse = deferred<{ items: AssetPresentation[]; next_cursor: null }>();
    const previewRequests: Array<{ project_id: string; timeline_revision_id?: string | null; output_ratio?: string }> = [];
    const waveformRequests: Array<{ project_id: string; asset_id: string; generate?: boolean }> = [];

    const api = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [projectA, projectB], next_cursor: null }),
        listAssets: vi.fn().mockImplementation(({ project_id }: { project_id: string }) => project_id === projectA.project_id
          ? Promise.resolve({ items: [assetA], next_cursor: null })
          : assetsBResponse.promise),
        getTimeline: vi.fn().mockImplementation((projectId: string) => projectId === projectA.project_id ? Promise.resolve(timelineA) : timelineBResponse.promise),
        getPreviewIrV2Manifest: vi.fn().mockImplementation(async (request: typeof previewRequests[number]) => { previewRequests.push(request); return {} as never; }),
        getWaveform: vi.fn().mockImplementation(async (request: typeof waveformRequests[number]) => { waveformRequests.push(request); return { status: "failed" } as never; }),
      },
    });
    window.desktop = api;
    render(<App />);
    await waitFor(() => expect(switcherButton().textContent).toContain(projectA.name));
    selectProject(projectB.name);

    // The project boundary clears timeline/working/assets before B replies.
    await waitFor(() => expect(vi.mocked(api.getTimeline)).toHaveBeenCalledWith(projectB.project_id));
    expect(previewRequests.filter(request => request.project_id === projectB.project_id)).toEqual([]);
    expect(waveformRequests.filter(request => request.project_id === projectB.project_id)).toEqual([]);

    // Releasing only B's timeline must produce B's revision, never A's revision.
    timelineBResponse.resolve(timelineB);
    await waitFor(() => expect(previewRequests.some(request => request.project_id === projectB.project_id)).toBe(true));
    const bPreviewRequests = previewRequests.filter(request => request.project_id === projectB.project_id);
    const bWaveformRequests = waveformRequests.filter(request => request.project_id === projectB.project_id);
    expect(bPreviewRequests.length).toBeGreaterThan(0);
    expect(bPreviewRequests.every(request => request.timeline_revision_id === "revision-b")).toBe(true);
    expect(bPreviewRequests.some(request => request.timeline_revision_id === "revision-a")).toBe(false);
    expect(bWaveformRequests.length).toBeGreaterThan(0);
    expect(bWaveformRequests.every(request => request.asset_id === "asset-b")).toBe(true);
    expect(bWaveformRequests.some(request => request.asset_id === "asset-a")).toBe(false);

    assetsBResponse.resolve({ items: [assetB], next_cursor: null });
    await waitFor(() => expect(screen.getByText(assetB.asset.display_name)).toBeInTheDocument());
    expect(previewRequests.filter(request => request.project_id === projectB.project_id).every(request => request.timeline_revision_id === "revision-b")).toBe(true);
    expect(waveformRequests.filter(request => request.project_id === projectB.project_id).every(request => request.asset_id === "asset-b")).toBe(true);
  });

  it("drops a late A asset page instead of repopulating B's library", async () => {
    const projectA = makeProject("project-a", "项目 A", "revision-a");
    const projectB = makeProject("project-b", "项目 B", "revision-b");
    const assetA = makeAsset(projectA.project_id, "asset-a", "迟到素材 A.mp4");
    const assetB = makeAsset(projectB.project_id, "asset-b", "当前素材 B.mp4");
    const assetsAResponse = deferred<{ items: AssetPresentation[]; next_cursor: null }>();
    const previewRequests: Array<{ project_id: string; timeline_revision_id?: string | null }> = [];
    const api = buildDesktopApi({
      overrides: {
        listProjects: vi.fn().mockResolvedValue({ items: [projectA, projectB], next_cursor: null }),
        listAssets: vi.fn().mockImplementation(({ project_id }: { project_id: string }) => project_id === projectA.project_id
          ? assetsAResponse.promise
          : Promise.resolve({ items: [assetB], next_cursor: null })),
        getTimeline: vi.fn().mockImplementation((projectId: string) => Promise.resolve(makeTimeline(projectId, projectId === projectA.project_id ? "revision-a" : "revision-b", projectId === projectA.project_id ? "asset-a" : "asset-b"))),
        getPreviewIrV2Manifest: vi.fn().mockImplementation(async (request: typeof previewRequests[number]) => { previewRequests.push(request); return {} as never; }),
        getWaveform: vi.fn().mockResolvedValue({ status: "failed" } as never),
      },
    });
    window.desktop = api;
    render(<App />);
    await waitFor(() => expect(switcherButton().textContent).toContain(projectA.name));
    selectProject(projectB.name);
    await waitFor(() => expect(screen.getByText(assetB.asset.display_name)).toBeInTheDocument());
    await waitFor(() => expect(previewRequests.some(request => request.project_id === projectB.project_id)).toBe(true));

    // Resolve the old request only after B is fully visible.  Its epoch must be stale.
    assetsAResponse.resolve({ items: [assetA], next_cursor: null });
    await waitFor(() => expect(screen.queryByText(assetA.asset.display_name)).toBeNull());
    expect(screen.getByText(assetB.asset.display_name)).toBeInTheDocument();
    expect(previewRequests.filter(request => request.project_id === projectB.project_id).every(request => request.timeline_revision_id === "revision-b")).toBe(true);
  });
});


import { app, dialog, shell, type BrowserWindow } from "electron";
import { access, lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  isAssetKind,
  type Asset,
  type AssetKind,
  type GrantId,
  type MediaInfo,
  type ProjectId,
} from "@aivideo/contracts";
import type { MediaPresentationService } from "../bootstrap/protocol.js";
import { mapLimited } from "../bootstrap/protocol.js";
import type { CoreAdminClient } from "../core-admin-client.js";
import {
  MAX_DROPPED_FILE_BYTES,
  isDroppedFileCountAllowed,
  isTrustedDroppedFileInvocation,
  validateDroppedFileSnapshot,
  type ValidatedDroppedFile,
} from "../dropped-file.js";
import { registerFileGrant } from "../file-grants.js";
import { appendLog } from "../logging.js";
import { requireAssetTicket, type RestrictedMediaRegistry } from "../restricted-media.js";
import { API_PREFIX, asId, buildQuery, type FetchBinaryWithUi, type FetchWithUi, type IpcHandle } from "./shared.js";

export interface AssetMediaIpcDependencies {
  handle: IpcHandle;
  fetchWithUi: FetchWithUi;
  fetchBinaryWithUi: FetchBinaryWithUi;
  requireCore: () => CoreAdminClient;
  restrictedMedia: RestrictedMediaRegistry;
  mediaPresentation: MediaPresentationService;
  getWindow: () => BrowserWindow | undefined;
  getLogPath: () => string;
  chooseAssetPath: (kind?: AssetKind, title?: string, relocate?: boolean) => Promise<string | null>;
}

/** Register media probe, frame decode, asset import/relocate/delete, subtitle import, and font ticket IPC handlers. */
export function registerAssetMediaIpc({
  handle,
  fetchWithUi,
  fetchBinaryWithUi,
  requireCore,
  restrictedMedia,
  mediaPresentation,
  getWindow,
  getLogPath,
  chooseAssetPath,
}: AssetMediaIpcDependencies): void {
  handle("media:choose", async () => {
    const selectedPath = await chooseAssetPath(undefined, "选择媒体");
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const media = await fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    return { grant, media };
  });
  handle("media:probe", (_event, grantId: GrantId) =>
    fetchWithUi<MediaInfo>("/api/v1/media/probe", { method: "POST", body: JSON.stringify({ grant_id: asId(grantId, "grant_id") }) }),
  );
  handle("decode-frames", async (_event, input: { project_id: string; asset_id: string; frame_numbers: number[]; fps: number; ticket_ref: string }) => {
    const projectId = asId(input?.project_id, "project_id");
    const assetId = asId(input?.asset_id, "asset_id");
    const frameNumbers = Array.isArray(input?.frame_numbers) ? input.frame_numbers : [];
    const fps = Number(input?.fps);
    if (!frameNumbers.length || frameNumbers.some(n => !Number.isInteger(n) || n < 0)) {
      throw new Error("DECODE_WINDOW_EMPTY");
    }
    // P30：窗口上限（Core 侧 max_length=32 为权威；这里提前拒绝给清晰错误）。
    if (frameNumbers.length > 32) throw new Error("DECODE_WINDOW_TOO_LARGE");
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("DECODE_FPS_INVALID");
    // P30：复用 restricted-media 票据鉴权（§2.5）——与媒体字节同一登记表、
    // 同一 TTL/purpose 校验；票据必须属于本实体。未持票渲染面不得发起窗口解码。
    requireAssetTicket(restrictedMedia, input?.ticket_ref, assetId);
    return fetchBinaryWithUi(`/api/v1/projects/${projectId}/assets/${assetId}/decode-frames`, {
      method: "POST",
      body: JSON.stringify({ frame_numbers: frameNumbers, fps, pixel_format: "nv12", ticket_ref: input.ticket_ref }),
    });
  });
  handle("decode-capability", () => fetchWithUi<unknown>("/api/v1/decode-capability"));

  handle("asset:list", async (_event, input: { project_id: ProjectId; availability?: string; limit?: number; cursor?: string }) => {
    const page = await fetchWithUi<{ items: Asset[]; next_cursor: string | null }>(`${API_PREFIX}/projects/${asId(input.project_id, "project_id")}/assets${buildQuery(input, ["project_id"])}`);
    return { next_cursor: page.next_cursor, items: await mapLimited(page.items, 8, mediaPresentation.assetPresentation) };
  });
  handle("asset:import", async (_event, input: { project_id: ProjectId; kind?: AssetKind }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    if (input.kind !== undefined && !isAssetKind(input.kind)) throw new Error("Invalid asset kind");
    const selectedPath = await chooseAssetPath(input.kind, "导入素材");
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, ...(input.kind ? { kind: input.kind } : {}) }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await mediaPresentation.restrictedMediaUrl(asset.asset_id) };
  });
  handle("asset:import-dropped", async (event, input: { project_id: ProjectId; files: unknown[] }) => {
    const windowRef = getWindow();
    if (!isTrustedDroppedFileInvocation({
      liveMainWindow: Boolean(windowRef && !windowRef.isDestroyed()),
      senderMatchesWindow: Boolean(windowRef && event.sender === windowRef.webContents),
      senderIsMainFrame: event.senderFrame === event.sender.mainFrame,
    })) {
      throw new Error("Untrusted renderer");
    }
    const projectId = asId(input?.project_id, "project_id") as ProjectId;
    if (!Array.isArray(input?.files) || !isDroppedFileCountAllowed(input.files.length)) {
      throw new Error("Dropped file batch size is invalid");
    }
    const project = await fetchWithUi<{ status: string }>(`${API_PREFIX}/projects/${projectId}`);
    if (project.status !== "active") throw new Error("Project is not active");

    const imported: Array<Awaited<ReturnType<MediaPresentationService["assetPresentation"]>> & { grant: Awaited<ReturnType<typeof registerFileGrant>> }> = [];
    const failures: Array<{ name: string; reason: "unsupported" | "invalid" | "import_failed" }> = [];
    const validated: ValidatedDroppedFile[] = [];
    for (const snapshot of input.files) {
      const name = snapshot && typeof snapshot === "object" && typeof (snapshot as { name?: unknown }).name === "string"
        ? (snapshot as { name: string }).name.slice(0, 256) : "未命名文件";
      try {
        const path = snapshot && typeof snapshot === "object" ? (snapshot as { path?: unknown }).path : undefined;
        if (typeof path !== "string") { failures.push({ name, reason: "invalid" }); continue; }
        const facts = await lstat(path);
        const result = validateDroppedFileSnapshot(snapshot, {
          isFile: facts.isFile(),
          isSymbolicLink: facts.isSymbolicLink(),
          size: facts.size,
          basename: basename(path),
        });
        if (result === "invalid") failures.push({ name, reason: "invalid" });
        else if (result === "unsupported") failures.push({ name, reason: "unsupported" });
        else validated.push(result);
      } catch {
        failures.push({ name, reason: "invalid" });
      }
    }
    if (validated.reduce((sum, item) => sum + item.size, 0) > MAX_DROPPED_FILE_BYTES) {
      throw new Error("Dropped file batch is too large");
    }
    for (const file of validated) {
      try {
        const grant = await registerFileGrant(requireCore(), file.path);
        const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, {
          method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, kind: file.kind }),
        });
        restrictedMedia.register(asset.asset_id, file.path);
        imported.push({ ...await mediaPresentation.assetPresentation(asset), grant });
      } catch {
        // Never return/log the dropped file's real path or an error string that might contain it.
        void appendLog(getLogPath(), `dropped asset import failed name=${file.name.slice(0, 128)}`);
        failures.push({ name: file.name.slice(0, 256), reason: "import_failed" });
      }
    }
    return { imported, failures };
  });
  handle("asset:refresh", async (_event, assetId: string) => {
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${asId(assetId, "asset_id")}/refresh`, { method: "POST" });
    return await mediaPresentation.assetPresentation(asset);
  });
  // 按素材重签媒体票据（时间线抽帧 filmstrip worker 用）：restrictedMediaUrl
  // 已注册路径纯内存签发（零网络），未注册才走带退避的 Core resolve。与
  // asset:refresh 的区别：不触发 Core 侧素材重扫。
  handle("asset:media-ticket", async (_event, assetId: string) => {
    return { media_url: await mediaPresentation.restrictedMediaUrl(asId(assetId, "asset_id")) };
  });
  // E2E-only multi-asset import: selects from an explicit benchmark fixture map
  // (AIVS_E2E_ASSET_PATHS_LIST = {"F07.mp4": "...", ...}) instead of a dialog.
  // Outside benchmark runs the env is unset and every call fails closed — the
  // requested name must be a plain fixture file name, no paths/wildcards.
  handle("asset:import-fixture", async (_event, input: { project_id: ProjectId; fixture_file: string }) => {
    const projectId = asId(input.project_id, "project_id") as ProjectId;
    const raw = process.env.AIVS_E2E_ASSET_PATHS_LIST;
    let selectedPath: string | undefined;
    if (raw) {
      try {
        const paths = JSON.parse(raw) as Record<string, unknown>;
        const candidate = paths[input.fixture_file];
        if (typeof candidate === "string") selectedPath = candidate;
      } catch { /* fall through: invalid env selects nothing */ }
    }
    if (!selectedPath || !/^[A-Za-z0-9._-]+\.mp4$/.test(input.fixture_file)) throw new Error("Unknown fixture file");
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/projects/${projectId}/assets`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id, kind: "video" }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await mediaPresentation.restrictedMediaUrl(asset.asset_id) };
  });
  handle("asset:relocate", async (_event, input: { asset_id: string }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const selectedPath = await chooseAssetPath(undefined, "重新定位素材", true);
    if (!selectedPath) return null;
    const grant = await registerFileGrant(requireCore(), selectedPath);
    const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
    restrictedMedia.register(asset.asset_id, selectedPath);
    return { grant, asset, media_url: await mediaPresentation.restrictedMediaUrl(asset.asset_id) };
  });

  // 打开素材所在文件夹；文件缺失时弹框提供 重新定位 / 移除 的恢复路径。
  handle("asset:reveal", async (_event, assetIdValue: string) => {
    const assetId = asId(assetIdValue, "asset_id");
    const resolved = await requireCore().resolveAsset(assetId);
    const windowRef = getWindow();
    try {
      await access(resolved.path);
    } catch {
      const box = await dialog.showMessageBox(windowRef!, {
        type: "warning",
        title: "素材文件不存在",
        message: "素材文件不存在，可能已被移动或删除。",
        detail: resolved.path,
        buttons: ["重新定位", "移除素材", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (box.response === 0) {
        const selectedPath = await chooseAssetPath(undefined, "重新定位素材", true);
        if (!selectedPath) return { status: "cancelled" as const };
        const grant = await registerFileGrant(requireCore(), selectedPath);
        const asset = await fetchWithUi<Asset>(`${API_PREFIX}/assets/${assetId}/relocate`, { method: "POST", body: JSON.stringify({ grant_id: grant.grant_id }) });
        restrictedMedia.register(asset.asset_id, selectedPath);
        return { status: "relocated" as const };
      }
      if (box.response === 1) {
        try {
          await fetchWithUi(`${API_PREFIX}/assets/${assetId}`, { method: "DELETE" });
          return { status: "deleted" as const };
        } catch {
          await dialog.showMessageBox(windowRef!, {
            type: "warning",
            title: "无法移除素材",
            message: "素材仍被时间线引用，无法直接移除。请先在时间线中删除相关片段。",
            buttons: ["确定"],
            noLink: true,
          });
          return { status: "cancelled" as const };
        }
      }
      return { status: "cancelled" as const };
    }
    shell.showItemInFolder(resolved.path);
    return { status: "opened" as const };
  });

  // 素材删除：remove_timeline_clips=true 时 Core 级联删除时间线相关片段，
  // 返回清理计数；默认模式下仍引用时返回 409（ASSET_IN_USE）。
  handle("asset:delete", async (_event, input: { asset_id: string; remove_timeline_clips?: boolean }) => {
    const assetId = asId(input.asset_id, "asset_id");
    const query = input.remove_timeline_clips ? "?remove_timeline_clips=true" : "";
    return await fetchWithUi<{ removed_clips: number; removed_captions: number }>(`${API_PREFIX}/assets/${assetId}${query}`, { method: "DELETE" });
  });

  // 本地字幕导入：弹文件框（SRT/ASS/SSA/LRC）读取文本内容返回给渲染进程
  // 解析（不走 Core 资产库——字幕文件不作为媒体素材管理）。
  handle("subtitle:import", async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: "导入本地字幕",
      properties: ["openFile"],
      filters: [{ name: "Subtitle files", extensions: ["srt", "ass", "ssa", "lrc"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const fileName = filePath.split(/[\\/]/).pop() ?? "subtitle";
    const content = await readFile(filePath, "utf8");
    return { file_name: fileName, content };
  });

  handle("media:caption-font-url", async () => {
    const fontPath = resolve(
      app.isPackaged ? process.resourcesPath : resolve(__dirname, "../../../../resources"),
      "fonts", "noto-sans-sc", "NotoSansCJKsc-VF.ttf",
    );
    if (!restrictedMedia.registeredPath("caption-font")) {
      restrictedMedia.register("caption-font", fontPath, "asset");
    }
    return restrictedMedia.issue("caption-font", "asset");
  });
  // 多字体（M2-B4 扩展）：bundle v2 注册表 → 全部字体下发 ticket + 族名列表。
  // bundle.json 是静态资源（随 resources 分发），直接读文件。
  handle("media:caption-font-urls", async () => {
    const fontsRoot = resolve(
      app.isPackaged ? process.resourcesPath : resolve(__dirname, "../../../../resources"),
      "fonts",
    );
    const bundle = JSON.parse(await readFile(resolve(fontsRoot, "bundle.json"), "utf8")) as {
      fonts?: Array<{ family: string; file: string }>;
    };
    const fonts = Array.isArray(bundle.fonts) ? bundle.fonts : [];
    return fonts.map(font => {
      // 实体 ID 必须过票据白名单正则([\w-],无空格)——族名含空格
      // (如 "Noto Sans CJK SC")直接注册会抛 Invalid registration,
      // 用序号键;族名本身经返回体 JSON 透传,不进票据键。
      const index = fonts.indexOf(font);
      const key = `caption-font-${index}`;
      if (!restrictedMedia.registeredPath(key)) {
        restrictedMedia.register(key, resolve(fontsRoot, font.file), "asset");
      }
      return { family: font.family, media_url: restrictedMedia.issue(key, "asset") };
    });
  });
}

import { protocol } from "electron";
import type {
  Asset,
  AuthoritativePreview,
  ExportRecord,
  RenditionPreview,
  RenditionReframePreview,
} from "@aivideo/contracts";
import { CoreHttpError, type CoreAdminClient } from "../core-admin-client.js";
import { appendLog } from "../logging.js";
import { RESTRICTED_MEDIA_SCHEME, RestrictedMediaRegistry, serveRestrictedMedia } from "../restricted-media.js";

/** Register the custom restricted media scheme before `app.whenReady()`. */
export function registerRestrictedMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: RESTRICTED_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

/** Register the Electron protocol handler serving ticket-authorized local media. */
export function registerRestrictedMediaProtocol(restrictedMedia: RestrictedMediaRegistry): void {
  protocol.handle(RESTRICTED_MEDIA_SCHEME, request => serveRestrictedMedia(request, restrictedMedia));
}

/**
 * 有界并发映射：asset 呈现等扇出此前用 Promise.all 一次性打出整页请求
 * （F04 reload 后 100 个素材的 restrictedMedia 注册全部失效，瞬时 100 个
 * admin resolve 请求 → 本地 Core 连接被瞬时打满，后续 manifest 请求
 * ECONNREFUSED，间歇但真实）。限并发后单批 ≤8，语义与顺序无关。
 */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface MediaPresentationService {
  restrictedMediaUrl: (assetId: string) => Promise<string>;
  artifactMediaUrl: (artifactId: string) => Promise<string>;
  previewPresentation: (preview: AuthoritativePreview) => Promise<{ preview: AuthoritativePreview; media_url: string }>;
  exportPresentation: (exportRecord: ExportRecord) => Promise<{ export_record: ExportRecord; media_url: string | null }>;
  renditionPreviewPresentation: (preview: RenditionPreview) => Promise<{ preview: RenditionPreview; media_url: string }>;
  renditionReframePreviewPresentation: (preview: RenditionReframePreview) => Promise<{ preview: RenditionReframePreview; media_url: string }>;
  assetPresentation: (asset: Asset) => Promise<{ asset: Asset; media_url: string | null }>;
}

/** Create ticketed media URL resolution & presentation helpers backed by Core admin resolve. */
export function createMediaPresentationService({
  restrictedMedia,
  requireCore,
  getLogPath,
}: {
  restrictedMedia: RestrictedMediaRegistry;
  requireCore: () => CoreAdminClient;
  getLogPath: () => string;
}): MediaPresentationService {
  /** Core admin resolve 的瞬时抖动重试（F04 100 素材复测暴露：reload 后批量
   *  restrictedMediaUrl 扇出期间 Core 偶发拒连，失败被 assetPresentation 折叠成
   *  media_url=null 且无重试通道——缺票永久化，合成预览回退无法自动恢复）。
   *  连接级失败 3 次退避（0/300/900ms）；CoreHttpError 的域错误
   *  （ASSET_MISSING/ASSET_CHANGED 等）语义明确，立即上抛不重试。 */
  async function resolveAssetWithRetry(assetId: string): Promise<{ path: string }> {
    const delays = [0, 300, 900];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        return await requireCore().resolveAsset(assetId);
      } catch (error) {
        lastError = error;
        if (error instanceof CoreHttpError) throw error;
      }
    }
    throw lastError;
  }

  async function restrictedMediaUrl(assetId: string): Promise<string> {
    if (!restrictedMedia.registeredPath(assetId)) {
      const resolved = await resolveAssetWithRetry(assetId);
      restrictedMedia.register(assetId, resolved.path, "asset");
    }
    return restrictedMedia.issue(assetId, "asset");
  }

  async function artifactMediaUrl(artifactId: string): Promise<string> {
    if (!restrictedMedia.registeredPath(artifactId, "artifact")) {
      const resolved = await requireCore().resolveArtifact(artifactId);
      restrictedMedia.register(artifactId, resolved.path, "artifact");
    }
    return restrictedMedia.issue(artifactId, "artifact");
  }

  return {
    restrictedMediaUrl,
    artifactMediaUrl,
    async previewPresentation(preview) {
      return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
    },
    async exportPresentation(exportRecord) {
      // 单个导出的产物文件若已缺失/损坏，不应让整个导出列表失败：降级为 media_url=null。
      try {
        return { export_record: exportRecord, media_url: await artifactMediaUrl(exportRecord.render_artifact_id) };
      } catch {
        return { export_record: exportRecord, media_url: null };
      }
    },
    async renditionPreviewPresentation(preview) {
      return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
    },
    async renditionReframePreviewPresentation(preview) {
      return { preview, media_url: await artifactMediaUrl(preview.render_artifact_id) };
    },
    async assetPresentation(asset) {
      if (asset.availability !== "available" || (asset.kind !== "video" && asset.kind !== "image" && asset.kind !== "audio")) {
        return { asset, media_url: null };
      }
      try {
        return { asset, media_url: await restrictedMediaUrl(asset.asset_id) };
      } catch (error) {
        // 静默折叠前落日志：缺票在现场无从定位（F04 100 素材复测），域错误与
        // 连接失败分开留痕。media_url=null 的折叠语义不变（列表 resilience）。
        void appendLog(getLogPath(), `asset presentation resolve failed asset=[redacted] error=${error instanceof Error ? error.message : String(error)}`);
        return { asset, media_url: null };
      }
    },
  };
}

/** B11 预览源解析器：素材 → (票据 URL, 源描述) 的会话级解析。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B11）：
 * - 源描述与 IR 逻辑 geometry 分离：解析产物只替换解码输入 URL；
 *   IR geometry/PiP/裁切坐标不变（代理像素变小不改变逻辑坐标）。
 * - auto：代理 ready 时用代理票据（decode-worker 吃 CFR30 代理 PTS 直
 *   接命中帧号请求）；否则回退原源票据——pending 期间预览不被阻塞。
 * - 不在此触发整段转码（生成作业由 UI 显式动作经 createPreviewSourceJob
 *   登记；source-resolver 只消费）。
 * - 每素材一次解析 + 会话内缓存（票据 5min TTL 由 restricted-media 侧
 *   管理；超时 fetch 失败由会话错误路径处理，同原源票据行为一致）。
 */
import type { PreviewSourceDescription, PreviewSourceMediaResponse, PreviewSourceProfileId } from "@aivideo/contracts";

export interface ResolvedPreviewSource {
  /** 解码输入 URL（原源或代理票据；传给 DecodeWorker.create）。 */
  url: string;
  /** true = 代理（CFR30、无 B 帧、编码尺寸 = 档位尺寸、rotation 已烘焙）。 */
  isProxy: boolean;
  description: PreviewSourceDescription;
}

export interface SourceResolverDeps {
  getPreviewSource: (input: { project_id: string; asset_id: string; mode?: "auto" | "original" | "proxy" }) => Promise<PreviewSourceDescription>;
  previewSourceMediaUrl: (input: { project_id: string; asset_id: string; profile_id: PreviewSourceProfileId }) => Promise<PreviewSourceMediaResponse>;
}

export class PreviewSourceResolver {
  private readonly cache = new Map<string, Promise<ResolvedPreviewSource | null>>();

  constructor(private readonly deps: SourceResolverDeps, private readonly projectId: string) {}

  /** 素材 → 解析源（null = 用调用方默认/原源票据）。同素材并发共享一次解析。 */
  resolve(assetId: string, originalUrl: string): Promise<ResolvedPreviewSource | null> {
    const cached = this.cache.get(assetId);
    if (cached) return cached;
    const task = (async (): Promise<ResolvedPreviewSource | null> => {
      try {
        const description = await this.deps.getPreviewSource({
          project_id: this.projectId, asset_id: assetId, mode: "auto",
        });
        if (description.status === "ready" && description.mode === "proxy" && description.cache_key) {
          const media = await this.deps.previewSourceMediaUrl({
            project_id: this.projectId, asset_id: assetId, profile_id: description.profile_id,
          });
          return { url: media.media_url, isProxy: true, description };
        }
        // pending/unavailable/original：原源回退（不阻塞预览）
        return null;
      } catch {
        // B11 失败路径永不阻塞预览：回退原源
        return null;
      }
    })();
    this.cache.set(assetId, task);
    return task;
  }

  /** 会话重建/素材指纹变化时清缓存。 */
  invalidate(assetId?: string): void {
    if (assetId === undefined) this.cache.clear();
    else this.cache.delete(assetId);
  }
}

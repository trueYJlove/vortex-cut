import type {
  AuthoritativePreview,
  ExportRecord,
  FileGrant,
  MediaInfo,
  RenderArtifact,
  RenditionPreview,
  RenditionReframePreview,
} from "@aivideo/contracts";

export interface MediaSelection { grant: FileGrant; media: MediaInfo }
export interface DesktopRuntime {
  protocol_version: 1;
  status: "ready";
  /** B13 资源预算档位（离散值；不暴露额外主机信息——Main 侧由总内存判定）。 */
  resource_tier?: "conservative" | "balanced" | "high";
  /** B13-R 判别诊断开关（仅 perf 诊断构建 + AIVS_FORCE_COPYTO=1 时下发）。 */
  force_copy_to?: boolean;
}
export interface AuthoritativePreviewPresentation { preview: AuthoritativePreview; media_url: string }
export interface ExportRecordPresentation { export_record: ExportRecord; media_url: string | null }
export interface RenderArtifactPresentation { artifact: RenderArtifact; media_url: string }
export interface PreviewIrPresentation {
  schema_version: number;
  content_fingerprint: string;
  timeline_revision_id: string;
  output_ratio: string;
  ir: Record<string, unknown>;
}
export interface RenditionPreviewPresentation { preview: RenditionPreview; media_url: string }
export interface RenditionReframePreviewPresentation { preview: RenditionReframePreview; media_url: string }

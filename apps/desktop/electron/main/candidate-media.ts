export interface CandidateClipMediaInput {
  project_id: string;
  candidate_plan_id: string;
  candidate_clip_id: string;
}

interface CandidateClip { clip_id: string; asset_id: string; source_start_us: number; source_end_us: number; }
interface CandidatePlan { project_id: string; clips: CandidateClip[]; }
interface ProjectAsset { asset_id: string; availability: string; kind: string; }

export interface CandidateMediaDependencies {
  fetchPlan(candidatePlanId: string): Promise<CandidatePlan>;
  listProjectAssets(projectId: string): Promise<{ items: ProjectAsset[] }>;
  issueAssetTicket(assetId: string): Promise<string>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${name} invalid`);
  return value;
}

/**
 * The Renderer can name only a Core-owned plan and clip.  Asset identity and
 * source bounds are reread from Core here, so it cannot mint arbitrary media tickets.
 */
export async function issueCandidateClipMedia(input: unknown, deps: CandidateMediaDependencies): Promise<{ media_url: string; source_start_us: number; source_end_us: number }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("candidate clip request invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !["project_id", "candidate_plan_id", "candidate_clip_id"].every(key => key in value)) throw new Error("candidate clip request invalid");
  const projectId = id(value.project_id, "project_id");
  const planId = id(value.candidate_plan_id, "candidate_plan_id");
  const clipId = id(value.candidate_clip_id, "candidate_clip_id");
  const plan = await deps.fetchPlan(planId);
  if (!plan || plan.project_id !== projectId || !Array.isArray(plan.clips)) throw new Error("candidate plan not authorized for project");
  const clip = plan.clips.find(item => item && item.clip_id === clipId);
  if (!clip || !ID.test(clip.asset_id) || !Number.isSafeInteger(clip.source_start_us) || !Number.isSafeInteger(clip.source_end_us) || clip.source_start_us < 0 || clip.source_end_us <= clip.source_start_us) throw new Error("candidate clip unavailable");
  const assets = await deps.listProjectAssets(projectId);
  const asset = assets?.items?.find(item => item && item.asset_id === clip.asset_id);
  if (!asset || asset.availability !== "available" || (asset.kind !== "video" && asset.kind !== "audio")) throw new Error("candidate asset unavailable");
  return { media_url: await deps.issueAssetTicket(clip.asset_id), source_start_us: clip.source_start_us, source_end_us: clip.source_end_us };
}

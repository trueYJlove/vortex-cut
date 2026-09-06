/** M3-0 探针公共：dev-only 桥接类型（window.probeDesktop 由 preload/probe-bridge.ts 注入）。 */

export interface ProbeSession {
  probe: "m3p1" | "m3p2" | "m3p3" | "m3p4" | "m3p5";
  chroma_phase: string;
  evidence_dir: string;
  assets: Array<{ entity_id: string; display_name: string }>;
  ir: string | null;
  sample: { sample_frames: number[]; caption_frames: number[] } | null;
  versions: { electron: string; chrome: string; node: string };
}

export interface ProbeBridge {
  session: () => Promise<ProbeSession>;
  mediaTicket: (entityId: string) => Promise<string>;
  writeArtifact: (relPath: string, content: string | { base64: string }) => Promise<string>;
  gpu: () => Promise<{
    metrics: Array<{ pid: number; type: string; memory: { workingSetSize?: number; private?: number } }>;
    feature_status: Record<string, string>;
    gpu_info: unknown;
    render_process_gone_count: number;
  }>;
  env: () => Promise<{ primary_display: Record<string, unknown> }>;
  done: (summary: unknown) => Promise<boolean>;
}

export function probeBridge(): ProbeBridge {
  const bridge = (window as unknown as { probeDesktop?: ProbeBridge }).probeDesktop;
  if (!bridge) throw new Error("probeDesktop bridge unavailable — AIVS_M3_PROBE gated preload did not run");
  return bridge;
}

export async function fetchAssetBlobUrl(bridge: ProbeBridge, entityId: string): Promise<string> {
  const ticket = await bridge.mediaTicket(entityId);
  // aivideo:// 具 supportFetchAPI 权限 + ACAO:*；fetch 校验票据可达性（R8 提前暴露）。
  const response = await fetch(ticket, { method: "HEAD" });
  if (!response.ok) throw new Error(`probe asset ${entityId} unreachable: ${response.status}`);
  return ticket;
}

import { app, ipcMain, screen } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { RestrictedMediaRegistry } from "../restricted-media.js";

/**
 * M3-0 探针 dev-only IPC（冻结方案 §7.1 四层隔离 · 第 1 层）。
 *
 * 仅当 `!app.isPackaged && process.env.AIVS_M3_PROBE ∈ {m3p1,m3p2,m3p3}` 时注册；
 * 生产构建中该模块仍被打包进主进程产物（隔离不依赖 tree-shake，依赖双重运行时
 * 门控：主进程不注册 handler + preload 不暴露桥），生产 grep 校验仅针对
 * out/renderer（见 scripts/verify-probe-isolation.mjs 与冻结方案原文）。
 *
 * 环境变量（dev 启动时注入）：
 * - AIVS_M3_PROBE          探针名
 * - AIVS_M3_PROBE_ASSETS   素材清单 JSON 路径 {assets:[{entity_id,path,display_name}]}
 * - AIVS_M3_PROBE_IR       渲染计划中立 IR JSON 路径（Core 投影器产出）
 * - AIVS_M3_PROBE_SAMPLE   采样帧表 JSON 路径（可选，m3p2 用）
 * - AIVS_M3_PROBE_EVIDENCE 证据输出目录
 */

export const PROBE_NAME_PATTERN = /^m3p[1-5]$/;

export function probeActive(): string | null {
  if (app.isPackaged || !process.env.AIVS_M3_PROBE) return null;
  const name = process.env.AIVS_M3_PROBE;
  return PROBE_NAME_PATTERN.test(name) ? name : null;
}

/** dev 加载 URL 追加 ?probe=<名>；will-navigate 已禁运行期导航，参数只能在加载时注入。 */
export function probeLoadQuery(): string {
  const name = probeActive();
  if (!name) return "";
  const mipmap = process.env.AIVS_M3_PROBE_MIPMAP;
  // P33：分段计时走 URL 参数（VITE_* env 在 electron-vite dev 的 SSR/渲染两侧
  // 替换不稳定，实测 timing-r1..r3 decode_seg=None——主进程 env 直通最可靠）。
  const timing = process.env.AIVS_M3_PROBE_DECODE_TIMING;
  return `?probe=${name}${mipmap ? `&mipmap=${mipmap}` : ""}${timing ? `&decodeTiming=${timing}` : ""}`;
}

export interface ProbeIpcHandle {
  noteRenderGone: () => void;
}

export function registerProbeIpc(deps: { registry: RestrictedMediaRegistry }): ProbeIpcHandle | null {
  const name = probeActive();
  if (!name) return null;
  const manifestPath = process.env.AIVS_M3_PROBE_ASSETS
    ? resolve(process.env.AIVS_M3_PROBE_ASSETS)
    : null;
  if (!manifestPath) throw new Error("AIVS_M3_PROBE requires AIVS_M3_PROBE_ASSETS");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as {
    assets: Array<{ entity_id: string; path: string; display_name?: string }>;
  };
  const evidenceDir = resolve(
    process.env.AIVS_M3_PROBE_EVIDENCE ?? join(app.getPath("userData"), "probes-evidence")
  );
  mkdirSync(evidenceDir, { recursive: true });
  for (const asset of manifest.assets) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(asset.entity_id) || !isAbsolute(asset.path)) {
      throw new Error(`Invalid probe asset entry: ${asset.entity_id}`);
    }
    deps.registry.register(asset.entity_id, asset.path, "asset");
  }
  const irPath = process.env.AIVS_M3_PROBE_IR ? resolve(process.env.AIVS_M3_PROBE_IR) : null;
  const samplePath = process.env.AIVS_M3_PROBE_SAMPLE ? resolve(process.env.AIVS_M3_PROBE_SAMPLE) : null;
  let renderGoneCount = 0;

  ipcMain.handle("probe:session", () => ({
    probe: name,
    chroma_phase: process.env.AIVS_M3_PROBE_CHROMA_PHASE ?? "0,0",
    evidence_dir: evidenceDir,
    assets: manifest.assets.map(asset => ({ entity_id: asset.entity_id, display_name: asset.display_name ?? asset.entity_id })),
    ir: irPath ? readFileSync(irPath, "utf8") : null,
    sample: samplePath ? JSON.parse(readFileSync(samplePath, "utf8")) : null,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  }));
  // R8：票据 5 分钟 TTL，长会话内按需重签（实体注册保持，票据重发）。
  ipcMain.handle("probe:media-ticket", (_event, entityIdValue: unknown) => {
    if (typeof entityIdValue !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entityIdValue)) {
      throw new Error("Invalid probe entity id");
    }
    return deps.registry.issue(entityIdValue, "asset");
  });
  ipcMain.handle("probe:write-artifact", (_event, relPathValue: unknown, content: unknown) => {
    if (typeof relPathValue !== "string" || relPathValue.includes("..") || relPathValue.startsWith("/")) {
      throw new Error("Invalid artifact path");
    }
    const target = resolve(evidenceDir, relPathValue);
    if (!target.startsWith(evidenceDir + sep)) throw new Error("Artifact path escapes evidence dir");
    mkdirSync(join(target, ".."), { recursive: true });
    if (typeof content === "string") {
      writeFileSync(target, content, "utf8");
    } else if (content && typeof content === "object" && typeof (content as { base64?: unknown }).base64 === "string") {
      writeFileSync(target, Buffer.from((content as { base64: string }).base64, "base64"));
    } else {
      throw new Error("Invalid artifact content");
    }
    return target;
  });
  ipcMain.handle("probe:gpu", async () => ({
    metrics: app.getAppMetrics(),
    feature_status: app.getGPUFeatureStatus(),
    gpu_info: await app.getGPUInfo("complete"),
    render_process_gone_count: renderGoneCount,
  }));
  ipcMain.handle("probe:env", () => {
    const display = screen.getPrimaryDisplay();
    return {
      primary_display: {
        bounds: display.bounds, work_area_size: display.workAreaSize,
        scale_factor: display.scaleFactor, display_frequency: display.displayFrequency,
        color_depth: display.colorDepth, color_space: display.colorSpace,
      },
      device_pixel_ratio_note: "renderer reports window.devicePixelRatio separately",
    };
  });
  ipcMain.handle("probe:done", (_event, summary: unknown) => {
    void import("../logging.js").then(logging =>
      logging.appendLog(logging.defaultLogPath(app.getPath("userData")), `probe ${name} done: ${JSON.stringify(summary ?? {}).slice(0, 2000)}`));
    setTimeout(() => app.quit(), 500);
    return true;
  });
  return { noteRenderGone: () => { renderGoneCount += 1; } };
}

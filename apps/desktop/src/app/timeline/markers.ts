/** 时间线标记（2026-11-10）：在时间线上打的时间点标记，带颜色与备注。
 *
 * **存储范围说明**：标记目前只存 localStorage，不进 TimelineDocument /
 * Revision，因此换机器或重装会丢失、也不随 Revision 回滚。
 * 这是刻意的取舍：进数据模型要新增 patch 操作并连带改 Core 的
 * PATCH_OPERATIONS、契约 schema、迁移与 STATUS.md，超出本次改造的硬约束。
 * 若将来要升级为随 Revision 持久化，本模块的读写接口可以原样保留，
 * 把 storage 层换成 Core 调用即可，调用方无需改动。
 */
export interface TimelineMarker {
  id: string;
  /** 时间线时间（µs）。 */
  timeUs: number;
  /** 颜色：几个预置色，便于一眼区分用途。 */
  color: string;
  /** 备注文字（可为空）。 */
  label: string;
}

/** 预置标记色：与调色板一致的低饱和亮色，在深浅两套主题下都够亮。 */
export const MARKER_COLORS = ["#4c8dff", "#3fbf6f", "#e8c547", "#f08a3c", "#e5484d", "#a57cf0"] as const;

const STORAGE_KEY = "vortex-cut.timeline.markers.v1";

/** 项目级标记表：projectId → markers。 */
type MarkerStore = Record<string, TimelineMarker[]>;

function readStore(): MarkerStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: MarkerStore = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      // 逐条校验：坏数据不应让整块标记失效（与 TIMELINE_PREFS 同一防御姿态）
      const items = value.filter((item): item is TimelineMarker =>
        Boolean(item) && typeof item === "object"
        && typeof (item as TimelineMarker).id === "string"
        && typeof (item as TimelineMarker).timeUs === "number"
        && (item as TimelineMarker).timeUs >= 0
        && typeof (item as TimelineMarker).color === "string"
        && typeof (item as TimelineMarker).label === "string");
      if (items.length > 0) out[projectId] = items;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: MarkerStore): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* 配额满/隐私模式：本次不持久化 */ }
}

export function loadMarkers(projectId: string): TimelineMarker[] {
  return readStore()[projectId] ?? [];
}

export function saveMarkers(projectId: string, markers: TimelineMarker[]): void {
  const store = readStore();
  if (markers.length === 0) delete store[projectId];
  else store[projectId] = markers;
  writeStore(store);
}

/** 生成标记 id（无需全局唯一，项目内唯一即可）。 */
export function newMarkerId(): string {
  return `mk_${Math.random().toString(36).slice(2, 10)}`;
}

/** 按时间排序（渲染前统一用这个，保证顺序稳定）。 */
export function sortMarkers(markers: TimelineMarker[]): TimelineMarker[] {
  return [...markers].sort((a, b) => a.timeUs - b.timeUs);
}

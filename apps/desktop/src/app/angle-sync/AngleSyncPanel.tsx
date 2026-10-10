import { useCallback, useEffect, useMemo, useState } from "react";
import type { AngleGroup, AngleSyncAngle, AssetPresentation, ProjectId } from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

/** W2.1 机位同步面板：建组 → 触发同步（轮询对账）→ 偏移表 + 人工偏移。 */

const STATUS_LABEL: Record<AngleSyncAngle["status"], string> = {
  missing: "未同步",
  queued: "排队中",
  running: "分析中…",
  ready: "已就绪",
  failed: "失败",
  unavailable: "不可用",
  stale: "素材已变化"
};
const REASON_LABEL: Record<string, string> = {
  low_confidence: "相关性不足（噪声/静音/非同源）",
  no_audio: "该机位无音轨",
  window_too_short: "可用时长过短",
  window_out_of_range: "对齐窗越出素材范围",
  asset_not_available: "素材当前不可用",
  asset_not_found: "素材不存在",
  clock_drift: "检测到时钟漂移（单偏移不适用，需分段对齐）",
  ANGLE_SYNC_NO_AUDIO: "音频解码失败或素材无音轨"
};

function fmtMs(us: number | null): string {
  if (us === null || us === undefined) return "—";
  const ms = us / 1000;
  return (ms >= 0 ? "+" : "") + ms.toFixed(1) + " ms";
}

export function AngleSyncPanel({
  projectId, assets, onClose, onNotify
}: {
  projectId: ProjectId;
  assets: AssetPresentation[];
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const videoAssets = useMemo(
    () => assets.filter(item => item.asset.kind === "video" && item.asset.availability === "available"),
    [assets]
  );
  const nameOf = useCallback((assetId: string) => {
    return videoAssets.find(item => item.asset.asset_id === assetId)?.asset.display_name ?? assetId.slice(0, 12) + "…";
  }, [videoAssets]);

  const [groups, setGroups] = useState<AngleGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("双机位");
  const [referenceId, setReferenceId] = useState<string>("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 在飞作业（job_id + 所属组）：**以 jobs 行终态为轮询依据**——Core 只落「完成行」，
   *  不落过渡行，所以按行状态判断 pending 会永远看不到进度（2026-10-10 e2e 现场）。 */
  const [inFlight, setInFlight] = useState<{ jobId: string; groupId: string } | null>(null);
  /** 两步确认删除机位组（组是元数据所有者，删组即丢同步数据；删后素材才可移除）。 */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = groups.find(group => group.group_id === selectedId) ?? null;

  // 注意：load 不得依赖 selectedId——否则每次选中变化都会重拉列表，
  // 并在列表尚未包含新建组时把它冲掉（2026-10-10 组件测试现场）。
  const load = useCallback(async () => {
    const page = await window.desktop.listAngleGroups(projectId);
    setGroups(page.items);
    setSelectedId(current => (
      current && page.items.some(group => group.group_id === current)
        ? current
        : (page.items[0]?.group_id ?? "")
    ));
  }, [projectId]);

  useEffect(() => {
    void load().catch(caught => setError(safeErrorMessage(caught, "机位组读取失败。")));
  }, [load]);

  useEffect(() => {
    if (!videoAssets.length) return;
    setReferenceId(current => current || String(videoAssets[0].asset.asset_id));
    setMemberIds(current => (current.length ? current : videoAssets.slice(0, 3).map(item => String(item.asset.asset_id))));
  }, [videoAssets]);

  // 作业终态轮询（subscribeJob 是死通道，沿用 Wave1 结论：状态以轮询为准）
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => {
      void window.desktop.getJob(inFlight.jobId as never).then(async job => {
        if (!["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return;
        window.clearInterval(timer);
        setInFlight(null);
        if (job.status === "succeeded") {
          const group = await window.desktop.getAngleGroup({
            project_id: projectId, group_id: inFlight.groupId as never
          });
          setGroups(prev => prev.map(item => item.group_id === group.group_id ? group : item));
          setSelectedId(group.group_id);
          onNotify("机位同步完成。");
        } else {
          setError("机位同步未完成（" + job.status + "）。");
        }
      }).catch(() => undefined);
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [inFlight, projectId, onNotify]);

  // 兜底：将来若 Core 落过渡行（queued/running），同样按行轮询
  const pending = selected?.angles.some(angle => angle.status === "queued" || angle.status === "running") ?? false;
  useEffect(() => {
    if (!selected || !pending) return;
    const deadline = Date.now() + 180_000;
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) { window.clearInterval(timer); return; }
      void window.desktop.getAngleGroup({ project_id: projectId, group_id: selected.group_id as never })
        .then(group => setGroups(prev => prev.map(item => item.group_id === group.group_id ? group : item)))
        .catch(() => undefined);
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [selected, pending, projectId]);

  const createAndSync = async () => {
    const members = memberIds.filter(id => id !== referenceId);
    if (!referenceId || members.length < 1) { setError("请选择 1 个参考机位与至少 1 个成员机位。"); return; }
    setBusy(true); setError("");
    try {
      const created = await window.desktop.createAngleGroup({
        project_id: projectId,
        name: name.trim() || "机位组",
        reference_asset_id: referenceId as never,
        member_asset_ids: [referenceId, ...members] as never
      });
      const synced = await window.desktop.syncAngleGroup({
        project_id: projectId, group_id: created.group_id, generate: true
      });
      setGroups(prev => [synced.group, ...prev.filter(item => item.group_id !== synced.group.group_id)]);
      setSelectedId(synced.group.group_id);
      if (synced.job_id) setInFlight({ jobId: synced.job_id, groupId: synced.group.group_id });
      onNotify(synced.job_id ? "已登记机位同步作业。" : "机位偏移已是最新（无需重算）。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "机位同步登记失败。"));
    } finally { setBusy(false); }
  };

  const sync = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const synced = await window.desktop.syncAngleGroup({
        project_id: projectId, group_id: selected.group_id, generate: true
      });
      setGroups(prev => prev.map(item => item.group_id === synced.group.group_id ? synced.group : item));
      if (synced.job_id) setInFlight({ jobId: synced.job_id, groupId: synced.group.group_id });
      onNotify(synced.job_id ? "已登记重新同步。" : "偏移已是最新（无需重算）。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "重新同步失败。"));
    } finally { setBusy(false); }
  };

  const removeGroup = async () => {
    if (!selected) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true); setError("");
    try {
      await window.desktop.deleteAngleGroup({ project_id: projectId, group_id: selected.group_id });
      setConfirmDelete(false);
      setManual({});
      await load();
      onNotify("已删除机位组（其同步数据一并移除）。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "删除机位组失败。"));
    } finally { setBusy(false); }
  };

  const saveOffset = async (angle: AngleSyncAngle) => {
    const raw = manual[String(angle.asset_id)];
    const ms = Number(raw);
    if (!raw || !Number.isFinite(ms)) { setError("请填写毫秒数（可为负）。"); return; }
    setBusy(true); setError("");
    try {
      const updated = await window.desktop.setAngleOffset({
        project_id: projectId, group_id: selectedId as never,
        asset_id: String(angle.asset_id), offset_us: Math.round(ms * 1000)
      });
      setGroups(prev => prev.map(item => item.group_id === updated.group_id ? updated : item));
      setManual(prev => ({ ...prev, [String(angle.asset_id)]: "" }));
      onNotify("已保存人工偏移（与自动测量并列）。");
    } catch (caught) {
      const code = errorCode(caught);
      setError(code === "ANGLE_OFFSET_REFERENCE_FIXED" ? "参考机位偏移必须为 0。"
        : safeErrorMessage(caught, "保存人工偏移失败。"));
    } finally { setBusy(false); }
  };

  return <Dialog titleId="angle-sync-title" label="机位同步" onClose={onClose} className="angle-sync-modal">
    <div className="modal-heading">
      <div>
        <h2 id="angle-sync-title">机位同步</h2>
        <p>本地音频互相关对齐（零外传）：算出每个机位相对参考机位的时间偏移，供多机位剪辑复用。</p>
      </div>
      <button type="button" className="icon-btn" aria-label="关闭机位同步" onClick={onClose}>×</button>
    </div>

    {error && <p className="ai-status" role="status">{error}</p>}
    {inFlight && <p className="readonly-note" role="status" aria-live="polite">机位同步分析中…（完成后自动刷新）</p>}

    <div className="angle-sync-create">
      <label>组名<input value={name} onChange={event => setName(event.target.value)} /></label>
      <label>参考机位
        <select value={referenceId} onChange={event => setReferenceId(event.target.value)}>
          {videoAssets.map(item => <option key={item.asset.asset_id} value={item.asset.asset_id}>{item.asset.display_name}</option>)}
        </select>
      </label>
      <div className="angle-sync-members">
        <span>成员机位（勾选）</span>
        {videoAssets.map(item => (
          <label key={item.asset.asset_id} className="angle-sync-member">
            <input type="checkbox"
              checked={memberIds.includes(String(item.asset.asset_id))}
              disabled={String(item.asset.asset_id) === referenceId}
              onChange={event => setMemberIds(prev => event.target.checked
                ? [...prev, String(item.asset.asset_id)]
                : prev.filter(id => id !== String(item.asset.asset_id)))} />
            <span>{item.asset.display_name}</span>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" disabled={busy || videoAssets.length < 2} onClick={() => void createAndSync()}>建组并同步</button>
      </div>
    </div>

    {groups.length > 0 && <div className="angle-sync-groups">
      <label>机位组
        <select value={selectedId} onChange={event => { setSelectedId(event.target.value); setConfirmDelete(false); }}>
          {groups.map(group => <option key={group.group_id} value={group.group_id}>{group.name}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !selected} onClick={() => void sync()}>重新同步</button>
      <button type="button" className={confirmDelete ? "danger" : ""} disabled={busy || !selected}
        onClick={() => void removeGroup()}>
        {confirmDelete ? "确认删除机位组" : "删除机位组"}
      </button>
    </div>}

    {selected && <table className="angle-sync-table">
      <thead><tr><th>机位</th><th>状态</th><th>偏移</th><th>置信度</th><th>来源</th><th>手填（ms）</th></tr></thead>
      <tbody>
        {selected.angles.map(angle => (
          <tr key={String(angle.asset_id)}>
            <td>{nameOf(String(angle.asset_id))}{angle.is_reference ? "（参考）" : ""}</td>
            <td>
              <span className={"angle-status " + angle.status}>{STATUS_LABEL[angle.status]}</span>
              {angle.reason && <small> · {REASON_LABEL[angle.reason] ?? angle.reason}</small>}
            </td>
            <td>{fmtMs(angle.offset_us)}</td>
            <td>{angle.confidence === null ? "—" : (angle.confidence * 100).toFixed(0) + "%"}</td>
            <td>
              {angle.source === "manual" ? "人工" : angle.source === "auto" ? "自动" : "—"}
              {angle.manual_stale && <small> · 人工值已失鲜，显示自动值</small>}
            </td>
            <td>
              <input aria-label={"手填偏移 " + nameOf(String(angle.asset_id))}
                value={manual[String(angle.asset_id)] ?? ""}
                placeholder={angle.is_reference ? "0" : "如 -253"}
                onChange={event => setManual(prev => ({ ...prev, [String(angle.asset_id)]: event.target.value }))} />
              <button type="button" disabled={busy} onClick={() => void saveOffset(angle)}>保存</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>}

    <p className="readonly-note">偏移为正 = 该机位晚于参考机位；置信度不足或素材变化时会如实标为「不可用 / 素材已变化」，不会给出看似合理的数值。帧级对齐还需打板/时码锚点。</p>

    <div className="modal-actions">
      <button type="button" onClick={onClose}>关闭</button>
    </div>
  </Dialog>;
}

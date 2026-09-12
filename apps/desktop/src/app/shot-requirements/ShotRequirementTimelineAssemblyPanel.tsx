import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../Dialog.js";
import type {
  ProjectId, ShotRequirementId, ShotRequirementImageAdoption,
  ShotRequirementTimelineAssembly, ShotRequirementTimelineAssemblyPreview, TimelineLayout,
} from "@aivideo/contracts";

const SAFE_ERROR = "时间线装配未完成；请刷新时间线和采用结果后重试。";
type Props = {
  projectId: ProjectId; requirementId: ShotRequirementId;
  adoption: ShotRequirementImageAdoption; available: boolean; readOnly: boolean;
};
export function ShotRequirementTimelineAssemblyPanel({
  projectId, requirementId, adoption, available, readOnly,
}: Props) {
  const [timelineRevisionId, setTimelineRevisionId] = useState("");
  const [clipCount, setClipCount] = useState(0);
  const [atIndex, setAtIndex] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState("3");
  const [layout, setLayout] = useState<TimelineLayout>("fit");
  const [preview, setPreview] = useState<ShotRequirementTimelineAssemblyPreview>();
  const [assemblies, setAssemblies] = useState<ShotRequirementTimelineAssembly[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [timeline, page] = await Promise.all([
        window.desktop.getTimeline(projectId),
        window.desktop.listShotRequirementTimelineAssemblies({
          project_id: projectId, requirement_id: requirementId, limit: 100,
        }),
      ]);
      setTimelineRevisionId(timeline.current_revision.timeline_revision_id);
      setClipCount(timeline.current_revision.document.clips.length);
      setAtIndex(current => Math.min(current, timeline.current_revision.document.clips.length));
      setAssemblies(page.items);
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  }, [projectId, requirementId]);
  useEffect(() => { setPreview(undefined); setNotice(""); void load(); }, [load, adoption.adoption_id]);
  const prepare = async () => {
    const durationUs = Math.round(Number(durationSeconds) * 1_000_000);
    if (!timelineRevisionId || !Number.isInteger(atIndex) || !Number.isFinite(durationUs)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setPreview(await window.desktop.prepareShotRequirementTimelineAssembly({
        project_id: projectId, requirement_id: requirementId,
        request: { expected_adoption_id: adoption.adoption_id,
          base_timeline_revision_id: timelineRevisionId as never,
          at_index: atIndex, duration_us: durationUs, layout },
      }));
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await window.desktop.applyShotRequirementTimelineAssembly({
        project_id: projectId, requirement_id: requirementId,
        request: { assembly_preview_id: preview.preview_id,
          proposed_document_sha256: preview.proposed_document_sha256, confirmed: true },
      });
      setPreview(undefined);
      setNotice(result.reused ? "已复用既有装配结果。" : "图片已装配为新的 Timeline Revision。请前往时间线查看。");
      await load();
    } catch { setError(SAFE_ERROR); }
    finally { setBusy(false); }
  };
  const duration = Number(durationSeconds);
  const valid = Number.isFinite(duration) && duration >= .5 && duration <= 30;
  if (readOnly) return assemblies.length ? <p>历史装配：{assemblies.length} 条（只读）</p> : null;
  return <section className="stage5-assembly" aria-label="已采用图片时间线装配">
    <header><strong>装配到时间线</strong><button disabled={busy} onClick={() => void load()}>刷新时间线</button></header>
    <p className="readonly-note">仅本地确定性装配；Provider 调用、网络外传和费用增量均为 0。不会自动预览、渲染或导出。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!available ? <p>当前采用图片不可用，不能装配。</p> : !timelineRevisionId ? <p>项目尚无可用时间线。</p> : <>
      <div className="stage5-assembly-fields">
        <label>插入位置<select aria-label="时间线插入位置" value={atIndex} onChange={event => setAtIndex(Number(event.target.value))}>{Array.from({ length: clipCount + 1 }, (_, index) => <option key={index} value={index}>{index}</option>)}</select></label>
        <label>图片时长（秒）<input aria-label="装配图片时长" type="number" min="0.5" max="30" step="0.5" value={durationSeconds} onChange={event => setDurationSeconds(event.target.value)} /></label>
        <label>布局<select aria-label="装配图片布局" value={layout} onChange={event => setLayout(event.target.value as TimelineLayout)}><option value="fit">适应</option><option value="crop_fill">裁切填充</option><option value="blurred_background">模糊背景</option></select></label>
      </div>
      {!preview && <button disabled={busy || !valid} onClick={() => void prepare()}>准备时间线装配</button>}
      {preview && <Dialog label="确认时间线装配" onClose={() => setPreview(undefined)} className="compact-dialog"><p>将新增 1 个图片 Clip；现有 Clip {preview.clip_count_before} 个，位移 {preview.shifted_clip_count} 个，字幕位移 {preview.shifted_caption_count} 个。</p><p>总时长：{preview.duration_before_us / 1_000_000}s → {preview.duration_after_us / 1_000_000}s</p><div className="modal-actions"><button onClick={() => setPreview(undefined)}>返回修改</button><button disabled={busy} onClick={() => void apply()}>显式确认装配</button></div></Dialog>}
    </>}
    {assemblies.length > 0 && <p>已记录 {assemblies.length} 条不可变装配事实。</p>}
  </section>;
}

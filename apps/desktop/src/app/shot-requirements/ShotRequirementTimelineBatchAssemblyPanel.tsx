import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../Dialog.js";
import type {
  ProjectId,
  ShotListRevisionId,
  ShotRequirement,
  ShotRequirementId,
  ShotRequirementImageAdoption,
  ShotRequirementTimelineBatchAssemblyPreview,
  TimelineRevisionId,
  TimelineLayout,
} from "@aivideo/contracts";

const SAFE_ERROR = "批量时间线装配未完成；请刷新时间线和采用结果后重试。";
const MAX_BATCH_SIZE = 24;
const MIN_BATCH_SIZE = 2;

type Props = {
  projectId: ProjectId;
  revisionId: ShotListRevisionId;
  requirements: ShotRequirement[];
};

type Candidate = {
  requirement: ShotRequirement;
  adoption: ShotRequirementImageAdoption;
};

type ItemSetting = {
  durationSeconds: string;
  layout: TimelineLayout;
};

function safeLabel(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function validDuration(value: string): boolean {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0.5 && seconds <= 30;
}

export function ShotRequirementTimelineBatchAssemblyPanel({
  projectId,
  requirements,
}: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<ShotRequirementId[]>([]);
  const [settings, setSettings] = useState<Record<string, ItemSetting>>({});
  const [timelineRevisionId, setTimelineRevisionId] = useState("");
  const [clipCount, setClipCount] = useState(0);
  const [atIndex, setAtIndex] = useState(0);
  const [preview, setPreview] = useState<ShotRequirementTimelineBatchAssemblyPreview>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [timeline, ...states] = await Promise.all([
        window.desktop.getTimeline(projectId),
        ...requirements.map(item => window.desktop.getShotRequirementImageFulfillment({
          project_id: projectId,
          requirement_id: item.shot_requirement_id,
        })),
      ]);

      setTimelineRevisionId(timeline.current_revision.timeline_revision_id);
      setClipCount(timeline.current_revision.document.clips.length);
      setAtIndex(current => Math.min(current, timeline.current_revision.document.clips.length));

      const next = requirements.flatMap((item, index) => {
        const state = states[index];
        return state.current_adoption
          && state.currently_confirmed
          && state.current_asset_availability === "available"
          ? [{ requirement: item, adoption: state.current_adoption }]
          : [];
      });

      setCandidates(next);
      setSelected(current => current.filter(id => next.some(candidate =>
        candidate.requirement.shot_requirement_id === id,
      )));
      setSettings(current => Object.fromEntries(next.map(candidate => {
        const id = candidate.requirement.shot_requirement_id;
        return [id, current[id] ?? { durationSeconds: "3", layout: "fit" as TimelineLayout }];
      })));
    } catch {
      setError(SAFE_ERROR);
    } finally {
      setBusy(false);
    }
  }, [projectId, requirements]);

  useEffect(() => {
    setPreview(undefined);
    setNotice("");
    void load();
  }, [load]);

  const candidateMap = useMemo(() => new Map(
    candidates.map(candidate => [candidate.requirement.shot_requirement_id, candidate]),
  ), [candidates]);

  const selectedCandidates = selected.flatMap(id => {
    const candidate = candidateMap.get(id);
    return candidate ? [candidate] : [];
  });

  const valid = selectedCandidates.length >= MIN_BATCH_SIZE
    && selectedCandidates.length <= MAX_BATCH_SIZE
    && selectedCandidates.every(item => validDuration(
      settings[item.requirement.shot_requirement_id]?.durationSeconds ?? "",
    ));

  const clearPreview = () => {
    setPreview(undefined);
    setNotice("");
  };

  const toggle = (requirementId: ShotRequirementId, checked: boolean) => {
    clearPreview();
    setSelected(current => checked
      ? [...new Set([...current, requirementId])]
      : current.filter(id => id !== requirementId));
  };

  const move = (requirementId: ShotRequirementId, offset: -1 | 1) => {
    clearPreview();
    setSelected(current => {
      const index = current.indexOf(requirementId);
      const next = index + offset;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  };

  const patch = (requirementId: ShotRequirementId, patchValue: Partial<ItemSetting>) => {
    clearPreview();
    setSettings(current => ({
      ...current,
      [requirementId]: {
        durationSeconds: current[requirementId]?.durationSeconds ?? "3",
        layout: current[requirementId]?.layout ?? "fit",
        ...patchValue,
      },
    }));
  };

  const prepare = async () => {
    if (!timelineRevisionId || !valid) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPreview(await window.desktop.prepareShotRequirementTimelineBatchAssembly({
        project_id: projectId,
        request: {
          base_timeline_revision_id: timelineRevisionId as TimelineRevisionId,
          at_index: atIndex,
          items: selectedCandidates.map(item => ({
            requirement_id: item.requirement.shot_requirement_id,
            expected_adoption_id: item.adoption.adoption_id,
            duration_us: Math.round(Number(
              settings[item.requirement.shot_requirement_id]?.durationSeconds ?? "3",
            ) * 1_000_000),
            layout: settings[item.requirement.shot_requirement_id]?.layout ?? "fit",
          })),
        },
      }));
    } catch {
      setError(SAFE_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.desktop.applyShotRequirementTimelineBatchAssembly({
        project_id: projectId,
        request: {
          batch_preview_id: preview.preview_id,
          proposed_document_sha256: preview.proposed_document_sha256,
          confirmed: true,
        },
      });
      setNotice(result.reused
        ? "已复用既有批量装配结果。"
        : "批量图片已装配为一个新 Timeline Revision。请前往时间线查看。");
      await load();
      setPreview(undefined);
    } catch {
      setError(SAFE_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stage6r-batch-assembly" aria-label="已采用图片批量时间线装配">
      <p className="readonly-note">
        仅对当前已采用且可用的图片执行本地确定性批量装配；Provider 调用、网络外传和费用增量均为
        0。整批 all-or-nothing：任一条失败则全部不装配。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {candidates.length < MIN_BATCH_SIZE
        ? <p>当前可用候选不足 2 条，不能批量装配。</p>
        : !timelineRevisionId
          ? <p>项目尚无可用时间线。</p>
          : <>
            <div className="stage6r-batch-candidates">
              {candidates.map(candidate => {
                const id = candidate.requirement.shot_requirement_id;
                return (
                  <label key={id}>
                    <input
                      aria-label={`批量候选 ${safeLabel(id)}`}
                      type="checkbox"
                      checked={selected.includes(id)}
                      onChange={event => toggle(id, event.target.checked)}
                    />
                    <span>{safeLabel(id)} · Asset {safeLabel(candidate.adoption.asset_id)}</span>
                  </label>
                );
              })}
            </div>
            <div className="stage6r-batch-order">
              {selectedCandidates.map((item, index) => {
                const id = item.requirement.shot_requirement_id;
                return (
                  <div key={id} aria-label={`批量顺序 ${index + 1}`}>
                    <strong>{index + 1}</strong>
                    <span>{safeLabel(id)}</span>
                    <button
                      aria-label={`上移 ${safeLabel(id)}`}
                      disabled={index === 0}
                      onClick={() => move(id, -1)}
                    >上移</button>
                    <button
                      aria-label={`下移 ${safeLabel(id)}`}
                      disabled={index === selectedCandidates.length - 1}
                      onClick={() => move(id, 1)}
                    >下移</button>
                    <label>
                      时长（秒）
                      <input
                        aria-label={`批量图片时长 ${safeLabel(id)}`}
                        type="number"
                        min="0.5"
                        max="30"
                        step="0.5"
                        value={settings[id]?.durationSeconds ?? "3"}
                        onChange={event => patch(id, { durationSeconds: event.target.value })}
                      />
                    </label>
                    <label>
                      布局
                      <select
                        aria-label={`批量图片布局 ${safeLabel(id)}`}
                        value={settings[id]?.layout ?? "fit"}
                        onChange={event => patch(id, { layout: event.target.value as TimelineLayout })}
                      >
                        <option value="fit">适应</option>
                        <option value="crop_fill">裁切填充</option>
                        <option value="blurred_background">模糊背景</option>
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
            <label>
              起始插入位置
              <select
                aria-label="批量时间线起始插入位置"
                value={atIndex}
                onChange={event => {
                  clearPreview();
                  setAtIndex(Number(event.target.value));
                }}
              >
                {Array.from({ length: clipCount + 1 }, (_, index) => (
                  <option key={index} value={index}>{index}</option>
                ))}
              </select>
            </label>
            <p>已选择 {selectedCandidates.length} / {MAX_BATCH_SIZE} 条。批量范围必须在 2–24 条之间。</p>
            {!preview && (
              <button disabled={busy || !valid} onClick={() => void prepare()}>
                准备批量时间线装配
              </button>
            )}
            {preview && (
              <Dialog title="确认批量时间线装配" onClose={() => setPreview(undefined)} className="compact-dialog" footer={<>
                  <button onClick={() => setPreview(undefined)}>返回修改</button>
                  <button disabled={busy} onClick={() => void apply()}>显式确认批量装配</button>
                </>}>
                <p>
                  将以一个事务装配 {preview.item_count} 个图片 Clip；任一条失败则全部不装配。现有 Clip
                  {preview.clip_count_before} 个，装配后 {preview.clip_count_after} 个，位移
                  {preview.shifted_clip_count} 个，字幕位移 {preview.shifted_caption_count} 个。
                </p>
                <p>总时长：{preview.duration_before_us / 1_000_000}s → {preview.duration_after_us / 1_000_000}s</p>
              </Dialog>
            )}
          </>}
    </section>
  );
}


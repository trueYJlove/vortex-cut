/**
 * W3.1 素材池语义检索面板。
 *
 * **A8 命中率显式留空（P142）**：评测语料是合成纯色块，语义命中率无法验证。
 * 本面板因此**不显示任何「准确率/命中率」话术**，只显示相似度分数，并在 UI 上
 * 明示「分数不是命中率保证」——避免把管线可用误读成能力达标。
 *
 * 建索引入口放在**面板内**而不是素材卡片：素材行已有 5 个操作按钮，再加一个
 * 会挤；更要紧的是检索空结果的成因就是「从没建过索引」——把建索引放在空结果
 * 旁边，用户不必跨界面找原因。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssetId, AssetPresentation, JobId, ProjectId, SemanticIndexSummary } from "@aivideo/contracts";

export interface SemanticSearchPanelProps {
  projectId: ProjectId | null;
  assetNames: Record<string, string>;
  assets?: AssetPresentation[];
  onClose: () => void;
}

interface Hit {
  asset_id: string;
  score: number;
}

/** 索引状态词汇（Core 只在读侧算 stale，见 semantic_service.index_summary）。 */
const INDEX_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "建索引中…",
  ready: "已建索引",
  failed: "建索引失败",
  unavailable: "不可用",
  stale: "索引已过期（素材已变化或模型已更换）"
};

/** 索引不可用时**必须给人话出路**：Core 对模型缺失显式不静默降级。 */
function indexHint(summary: SemanticIndexSummary): string | null {
  if (summary.status !== "unavailable" && summary.status !== "failed") return null;
  if (summary.reason === "model_not_installed") return "语义模型尚未安装，请先在设置中下载 CLIP 模型";
  if (summary.reason === "no_video_stream") return "该素材没有画面轨，无法建立语义索引";
  if (summary.reason === "no_frames") return "未能从该素材抽到可用画面，换一段素材再试";
  return null;
}

export function SemanticSearchPanel({ projectId, assetNames, assets, onClose }: SemanticSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const run = useCallback(async () => {
    if (!projectId) { setError("未打开项目"); return; }
    const q = query.trim();
    if (!q) { setError("请输入检索内容"); return; }
    setBusy(true); setError(null);
    try {
      const res = await window.desktop.searchSemantic({ project_id: projectId, query: q, limit: 20 });
      setHits(res.hits);
      setSearched(true);
    } catch (e) {
      // 只暴露稳定文案：上游错误可能含内部路径/模型细节。
      const msg = String(e).includes("SEMANTIC_MODEL_NOT_INSTALLED")
        ? "语义模型尚未安装，请先在设置中下载 CLIP 模型"
        : "检索失败，请稍后重试";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [projectId, query]);

  // ── 建索引：索引是检索的前提，没有索引检索必然空结果 ──
  const [indexStates, setIndexStates] = useState<Record<string, SemanticIndexSummary>>({});
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const subscriptions = useRef<Array<() => void>>([]);
  useEffect(() => () => { subscriptions.current.forEach(stop => stop()); subscriptions.current = []; }, []);

  // 只对画面素材建索引：Core 对无画面轨的素材只会落 unavailable(no_video_stream)。
  const indexable = useMemo(
    () => (assets ?? []).filter(item =>
      (item.asset.kind === "video" || item.asset.kind === "image") && item.asset.availability === "available"),
    [assets]
  );

  const readIndex = useCallback(async (assetId: AssetId) => {
    if (!projectId) return;
    try {
      const summary = await window.desktop.indexSemanticAsset({ project_id: projectId, asset_id: assetId, generate: false });
      setIndexStates(current => ({ ...current, [assetId]: summary }));
    } catch { /* 只读摘要失败不打断列表：状态回退到上一次已知值 */ }
  }, [projectId]);

  const buildIndex = useCallback(async () => {
    if (!projectId) { setIndexError("未打开项目"); return; }
    if (indexable.length === 0) { setIndexError("当前项目没有可建立索引的视频或图片素材"); return; }
    setIndexBusy(true); setIndexError(null);
    // 已 ready 的素材跳过（Core 对 ready/queued/running/unavailable 也不再登记作业）。
    const targets = indexable.filter(item => indexStates[item.asset.asset_id]?.status !== "ready");
    try {
      for (const item of (targets.length > 0 ? targets : indexable)) {
        const summary = await window.desktop.indexSemanticAsset({
          project_id: projectId, asset_id: item.asset.asset_id, generate: true
        });
        setIndexStates(current => ({ ...current, [item.asset.asset_id]: summary }));
        if (summary.job_id) {
          // 作业终态后回读一次摘要：进度只在作业里，摘要才是面板要显示的状态。
          // 契约里 job_id 是 string（同 CV/机位同步摘要），preload 要的是 branding 后的 JobId。
          const stop = window.desktop.subscribeJob(summary.job_id as JobId, job => {
            if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) {
              stop();
              void readIndex(item.asset.asset_id);
            }
          });
          subscriptions.current.push(stop);
        }
      }
    } catch (caught) {
      const msg = String(caught).includes("SEMANTIC_MODEL_NOT_INSTALLED")
        ? "语义模型尚未安装，请先在设置中下载 CLIP 模型"
        : "建立索引失败，请稍后重试";
      setIndexError(msg);
    } finally {
      setIndexBusy(false);
    }
  }, [projectId, indexable, indexStates, readIndex]);

  // 只按 reason 判定模型缺失：status=unavailable 还可能是 no_video_stream/no_frames，
  // 那两种说「模型未安装」是错误归因。
  const modelMissing = Object.values(indexStates).some(summary => summary.reason === "model_not_installed");

  return (
    <div className="modal semantic-search" role="dialog" aria-label="素材语义检索">
      <header className="modal-header">
        <h2>素材语义检索</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭素材语义检索">×</button>
      </header>
      <div className="modal-body">
        <form
          className="semantic-search-form"
          onSubmit={(e) => { e.preventDefault(); void run(); }}
        >
          <input
            type="text"
            value={query}
            maxLength={512}
            placeholder="例如：a person talking to the camera"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="检索内容"
          />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "检索中…" : "检索"}
          </button>
        </form>
        <p className="readonly-note">
          按画面语义相似度排序。当前模型为英文 CLIP，中文查询效果未验证。
          分数仅表示相似度排序，<strong>不构成</strong>对识别准确性或可用性的承诺。
        </p>
        {error ? <p className="semantic-search-error" role="alert">{error}</p> : null}
        {busy ? <p className="readonly-note">正在编码查询并检索…</p> : null}
        {!busy && searched && hits.length === 0 ? (
          <p className="readonly-note">没有匹配素材。若从未索引过，请先对素材建立语义索引。</p>
        ) : null}
        {hits.length > 0 ? (
          <ol className="semantic-search-hits">
            {hits.map((h) => (
              <li key={h.asset_id}>
                <span className="hit-name">{assetNames[h.asset_id] ?? h.asset_id}</span>
                <span className="hit-score">{h.score.toFixed(3)}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <section className="semantic-index" aria-label="语义索引">
          <div className="semantic-index-head">
            <strong>语义索引</strong>
            <button
              type="button"
              onClick={() => void buildIndex()}
              disabled={indexBusy || !projectId || indexable.length === 0}
            >
              {indexBusy ? "建立中…" : "为此项目建索引"}
            </button>
          </div>
          <p className="readonly-note">
            检索前需要先建立索引；索引只保存画面语义向量，不写时间线，也不随素材自动更新。
          </p>
          {modelMissing ? (
            <p className="semantic-index-hint">语义模型尚未安装，请先在设置中下载 CLIP 模型</p>
          ) : null}
          {indexable.length === 0 ? (
            <p className="readonly-note">当前项目没有可建立索引的视频或图片素材。</p>
          ) : (
            <ul className="semantic-index-list">
              {indexable.map(item => {
                const summary = indexStates[item.asset.asset_id];
                const hint = summary ? indexHint(summary) : null;
                return (
                  <li key={item.asset.asset_id}>
                    <span className="index-name">{item.asset.display_name}</span>
                    <span className={`index-status ${summary?.status ?? "none"}`}>
                      {summary?.status ? INDEX_STATUS_LABEL[summary.status] ?? summary.status : "未建索引"}
                    </span>
                    {hint ? <small className="index-hint">{hint}</small> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {indexError ? <p className="semantic-search-error" role="alert">{indexError}</p> : null}
        </section>
      </div>
      <footer className="modal-actions">
        <button type="button" onClick={onClose}>关闭</button>
      </footer>
    </div>
  );
}

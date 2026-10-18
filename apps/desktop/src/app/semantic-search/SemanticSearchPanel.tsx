/**
 * W3.1 素材池语义检索面板。
 *
 * **A8 命中率显式留空（P142）**：评测语料是合成纯色块，语义命中率无法验证。
 * 本面板因此**不显示任何「准确率/命中率」话术**，只显示相似度分数，并在 UI 上
 * 明示「分数不是命中率保证」——避免把管线可用误读成能力达标。
 */
import { useCallback, useState } from "react";

import type { ProjectId } from "@aivideo/contracts";

export interface SemanticSearchPanelProps {
  projectId: ProjectId | null;
  assetNames: Record<string, string>;
  onClose: () => void;
}

interface Hit {
  asset_id: string;
  score: number;
}

export function SemanticSearchPanel({ projectId, assetNames, onClose }: SemanticSearchPanelProps) {
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

  return (
    <div className="modal semantic-search" role="dialog" aria-label="素材语义检索">
      <header className="modal-header">
        <h2>素材语义检索</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
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
      </div>
      <footer className="modal-actions">
        <button type="button" onClick={onClose}>关闭</button>
      </footer>
    </div>
  );
}
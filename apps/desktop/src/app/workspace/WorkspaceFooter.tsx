import { Download, History, Save, Sparkles } from "lucide-react";

/**
 * 主工作区底栏（从 App.tsx 抽出，2026-11-10 GATE-3）。
 *
 * 抽出的判据是「自包含」：这一块只读 props、无本地状态、无副作用，
 * 因此可以整体搬走而不改变任何行为。抽取时 DOM 结构、类名、
 * role/aria-label 与 title 全部原样保留——11 个测试直接挂载 App 并按
 * 可访问名称取元素（"保存状态"/"Core 连接状态"/"设置"等），
 * 任何改写都会让它们静默失配。
 *
 * 仍由父组件持有状态：saveState、runtimeReady、任务计数、各入口开关权。
 */
export interface WorkspaceFooterProps {
  saveState: string;
  runtimeReady: boolean;
  previewIsStale: boolean;
  renderDisabledReason?: string;
  renderActivity: number;
  runningProgressText: string;
  hasProject: boolean;
  hasTimeline: boolean;
  contractVersion: string;
  onGeneratePreview: () => void;
  onOpenJobs: () => void;
  onOpenExportBatch: () => void;
  onOpenAi: () => void;
  onOpenPatch: () => void;
  onOpenRevisionCompare: () => void;
  onOpenProviderSettings: () => void;
  onOpenSettings: () => void;
}

export function WorkspaceFooter({
  saveState, runtimeReady, previewIsStale, renderDisabledReason,
  renderActivity, runningProgressText, hasProject, hasTimeline, contractVersion,
  onGeneratePreview, onOpenJobs, onOpenExportBatch, onOpenAi, onOpenPatch,
  onOpenRevisionCompare, onOpenProviderSettings, onOpenSettings,
}: WorkspaceFooterProps) {
  const saveFailed = saveState === "保存失败" || saveState === "草稿冲突";
  return <footer>
    <div className="footer-status">
      <div role="status" aria-label="保存状态" className={`save-state ${saveFailed ? "error" : ""}`} title={saveState === "草稿冲突" ? "检测到冲突草稿，请在顶部提示中处理" : undefined}><Save />{saveState}</div>
      <div className="footer-sep" aria-hidden="true" />
      <div className="job-state" role="status" aria-label="Core 连接状态"><span className={`core-dot ${runtimeReady ? "on" : ""}`} />{runtimeReady ? "Core 已连接" : "Core 连接中"}</div>
      {previewIsStale && <button className="status-chip stale" disabled={Boolean(renderDisabledReason)} title={renderDisabledReason ?? "点击立即生成权威预览"} onClick={onGeneratePreview}><span className="chip-dot" aria-hidden="true" />权威预览已过期</button>}
    </div>
    <div className="footer-tasks">
      {renderActivity > 0 ? (
        <button className="tasks-summary" onClick={onOpenJobs} title="点击查看任务列表">
          <span className="tasks-spinner" aria-hidden="true" />
          {renderActivity} 个任务进行中{runningProgressText ? ` · ${runningProgressText}` : ""}
        </button>
      ) : (
        <span className="tasks-idle">后台空闲</span>
      )}
    </div>
    <div className="footer-actions"><button className="ai-entry" disabled={!hasProject || !hasTimeline} onClick={onOpenExportBatch}><Download size={12} />多平台导出</button><button className="ai-entry" disabled={!hasProject} onClick={onOpenAi}>AI 粗剪</button><button className="ai-entry" disabled={!hasTimeline} onClick={onOpenPatch}><Sparkles size={12} />AI 修改</button><button className="ai-entry" disabled={!hasTimeline} onClick={onOpenRevisionCompare}><History size={12} />版本比较</button><button className="ai-entry" title="管理 Provider、密钥与连接测试" onClick={onOpenProviderSettings}>Provider 设置</button><button className="ai-entry" title="应用设置" onClick={onOpenSettings}>设置</button></div>
    <span className="footer-version" title="权威预览与最终导出均由冻结 Timeline Revision 生成。">{contractVersion}</span>
  </footer>;
}

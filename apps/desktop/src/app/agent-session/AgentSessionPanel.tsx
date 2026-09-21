import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSession, AgentSessionEgressPreview, AgentSessionStep, ProviderConfig, ProjectId, TimelineRevisionId } from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

type Step = "form" | "confirm" | "running" | "done";

const FAILURE_LABELS: Record<string, string> = {
  AGENT_SESSION_STEP_LIMIT: "已达单会话步数上限，会话中止（已完成的步骤保留）。",
  AGENT_SESSION_BUDGET_EXCEEDED: "已达会话 token 预算上限，会话中止。",
  AGENT_SESSION_BASE_DRIFT: "会话期间时间线在会话之外被修改，会话中止；请基于最新版本重新发起。",
  AGENT_SESSION_ALREADY_ACTIVE: "已有进行中的会话；请等待其结束。",
  AGENT_SESSION_EGRESS_EXPIRED: "外传确认已过期，请重新准备并确认。",
  AGENT_SESSION_EGRESS_MISMATCH: "外传内容校验不一致，请重新准备并确认。",
  AGENT_SESSION_PROVIDER_UNSUPPORTED: "Provider 不支持多步会话；请先在 AI 修改中测试兼容性。"
};

function stepStageLabel(step: AgentSessionStep): string {
  if (step.status === "succeeded") return "完成";
  return step.error?.code ? `失败 · ${step.error.code}` : step.stage || "失败";
}

/**
 * DESK-5：AI 助手面板（内置多步 agent 会话 UI 面）。四步流程对齐 AI 修改
 * 面板先例（form → confirm → running → done）；一项目仅一个 active 会话，
 * 打开面板时先查活跃会话直接续看。权威状态源 = getAgentSession 轮询，
 * provider 推进信号只做提前刷新。每步已落 Revision——结果页引导用
 * 版本比较/撤销查看轨迹，不在此面板重复展示每步 diff（规划门 §5 裁决②）。
 */
export function AgentSessionPanel({ projectId, baseRevisionId, providers, onClose, onNotify }: {
  projectId: ProjectId;
  baseRevisionId: TimelineRevisionId | null;
  providers: ProviderConfig[];
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [instruction, setInstruction] = useState("");
  const [providerId, setProviderId] = useState("");
  const [preview, setPreview] = useState<AgentSessionEgressPreview>();
  const [session, setSession] = useState<AgentSession>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const eligible = useMemo(() => providers.filter(item => item.enabled && item.credential_status === "configured" && item.timeline_patch_capability_status === "supported"), [providers]);

  // 打开面板即查活跃会话：存在 active 会话则直接进入运行/结果视图。
  useEffect(() => {
    let active = true;
    void window.desktop.listAgentSessions(projectId).then(page => {
      if (!active) return;
      const activeSession = page.items.find(item => item.status === "queued" || item.status === "running");
      if (activeSession) {
        setSession(activeSession);
        setStep(activeSession.status === "running" || activeSession.status === "queued" ? "running" : "done");
        void refreshSession(activeSession.agent_session_id);
      }
    }).catch(() => undefined);
    return () => { active = false; if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const refreshSession = async (sessionId: string): Promise<void> => {
    try {
      const value = await window.desktop.getAgentSession(sessionId);
      setSession(value);
      if (value.status === "queued" || value.status === "running") {
        pollRef.current = setTimeout(() => void refreshSession(sessionId), 1500);
      } else {
        setStep("done");
      }
    } catch { pollRef.current = setTimeout(() => void refreshSession(sessionId), 3000); }
  };

  const prepare = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    setBusy(true); setError("");
    try {
      const value = await window.desktop.prepareAgentSession({ project_id: projectId, base_revision_id: baseRevisionId, provider_config_id: providerId, instruction: instruction.trim() });
      setPreview(value);
      setStep("confirm");
    } catch (caught) {
      const code = errorCode(caught);
      setError(FAILURE_LABELS[code ?? ""] ?? safeErrorMessage(caught, "准备失败。请检查 Provider 凭据后重试。"));
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const response = await window.desktop.createAgentSession({ project_id: projectId, agent_session_egress_preview_id: preview.agent_session_egress_preview_id, payload_sha256: preview.payload_sha256 });
      setSession({ agent_session_id: response.agent_session_id, project_id: projectId, base_revision_id: baseRevisionId ?? "" as never, instruction, max_steps: preview.max_steps, status: "queued", payload_sha256: preview.payload_sha256, created_at: response.job.created_at, updated_at: response.job.created_at, finished_at: null });
      setPreview(undefined);
      setStep("running");
      void refreshSession(response.agent_session_id);
    } catch (caught) {
      const code = errorCode(caught);
      setError(FAILURE_LABELS[code ?? ""] ?? safeErrorMessage(caught, "创建失败；重试前必须重新准备并确认外传内容。"));
      setPreview(undefined);
      setStep("form");
    } finally { setBusy(false); }
  };

  const canPrepare = !busy && instruction.trim().length > 0 && [...instruction].length <= 4000 && providerId !== "" && baseRevisionId !== null;

  return <Dialog titleId="agent-session-title" label="AI 助手" onClose={onClose} className="agent-session">
    <div className="modal-heading"><div><h2 id="agent-session-title">AI 助手</h2><p>多步任务会话：每一步都会先校验再落为版本，失败步骤不产生任何修改。</p></div><button className="icon-button" aria-label="关闭 AI 助手" onClick={onClose}>×</button></div>
    {error && <p className="ai-status" role="status">{error}</p>}
    {step === "form" && <>
      <label>任务指令<textarea aria-label="会话指令" maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：把视频剪短到 30 秒左右，并为关键画面加字幕" /></label>
      <label>Provider<select aria-label="AI 助手 Provider" value={providerId} onChange={event => setProviderId(event.target.value)}>
        <option value="">选择已配置 Provider</option>
        {eligible.map(item => <option value={item.provider_config_id} key={item.provider_config_id}>{item.display_name} · {item.model}</option>)}
      </select></label>
      {eligible.length === 0 && <p className="readonly-note">尚无支持的 Provider：请先在 AI 修改中完成"测试 AI 修改兼容性"（多步会话与 AI 修改使用同一能力门）。</p>}
      <p className="readonly-note">一次确认覆盖整个会话：会话中每一步的失败反馈会作为上下文再次外发，具体字段在下一步确认页明示。</p>
      <div className="modal-actions"><button disabled={!canPrepare} onClick={() => void prepare()}>准备外传确认</button></div>
    </>}
    {step === "confirm" && preview && <>
      <h3>确认本次会话外传</h3>
      <div className="instruction-preview"><strong>你的本地指令</strong><p>{instruction}</p></div>
      <dl>
        <dt>Provider</dt><dd>{preview.provider.display_name} · {preview.provider.origin}</dd>
        <dt>模型</dt><dd>{preview.provider.model}</dd>
        <dt>字段类别</dt><dd>{preview.sent_fields.join("、")}</dd>
        <dt>内容计数</dt><dd>{preview.clip_count} Clip / {preview.caption_count} Caption / {preview.locked_count} 锁定</dd>
        <dt>字符 / Token</dt><dd>{preview.character_count} / {preview.estimated_tokens}</dd>
        <dt>步数上限</dt><dd>{preview.max_steps} 步 · token 预算 {preview.token_budget}</dd>
        <dt>哈希</dt><dd>{preview.payload_sha256}</dd>
        <dt>有效期</dt><dd>{preview.expires_at}</dd>
      </dl>
      <p className="readonly-note">费用最终以 Provider 账单为准；会话每步成功即落一个版本，可随时撤销。</p>
      <div className="modal-actions">
        <button onClick={() => { setPreview(undefined); setStep("form"); }}>返回修改</button>
        <button disabled={busy} onClick={() => void create()}>确认并开始会话</button>
      </div>
    </>}
    {step === "running" && session && <>
      <h3>会话进行中</h3>
      <p>{session.status === "queued" ? "排队中" : "执行中"} · 步数 {session.steps?.length ?? 0}/{session.max_steps}{session.token_usage ? ` · Token ${session.token_usage.total_tokens}` : ""}</p>
      <progress max={session.max_steps} value={session.steps?.length ?? 0} aria-label="会话步数进度" />
      <ol className="agent-session-steps">
        {(session.steps ?? []).map(item => <li key={item.ordinal}><strong>第 {item.ordinal} 步</strong> · {stepStageLabel(item)}{item.summary ? <span> · {item.summary}</span> : null}{item.duration_ms !== null ? <small> · {(item.duration_ms / 1000).toFixed(1)}s</small> : null}</li>)}
      </ol>
      <div className="modal-actions"><button onClick={onClose}>后台等待（关闭面板）</button></div>
    </>}
    {step === "done" && session && <>
      <h3>{session.status === "succeeded" ? "会话完成" : session.status === "failed" ? "会话失败" : "会话已取消"}</h3>
      {session.status === "succeeded" && <p className="readonly-note">每个成功步骤都已落为版本；使用"版本比较"查看会话轨迹，或撤销回退到任意一步。</p>}
      {session.status === "failed" && <p>共执行 {(session.steps ?? []).filter(item => item.status === "succeeded").length} 个成功步骤（已保留），失败步骤不产生修改。</p>}
      {session.token_usage && <p className="readonly-note">费用估算：{session.token_usage.total_tokens} tokens · {session.token_usage.provider_calls} 次 Provider 调用 · ≈{session.token_usage.estimated_cost.toFixed(4)} 元（按 Provider 配置单价估算，最终以服务商账单为准）。</p>}
      <ol className="agent-session-steps">
        {(session.steps ?? []).map(item => <li key={item.ordinal}><strong>第 {item.ordinal} 步</strong> · {stepStageLabel(item)}{item.summary ? <span> · {item.summary}</span> : null}</li>)}
      </ol>
      <div className="modal-actions">
        <button onClick={() => { setSession(undefined); setInstruction(""); setStep("form"); }}>发起新会话</button>
        <button onClick={onClose}>关闭</button>
      </div>
    </>}
  </Dialog>;
}

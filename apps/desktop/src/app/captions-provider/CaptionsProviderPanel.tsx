import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CaptionsProviderEgressPreview,
  CaptionsProviderGeneration,
  CaptionsProviderProposal,
  ProjectId,
  ProviderConfig,
  TimelineRevisionId,
  Transcript,
  TranscriptId,
  TranscriptSegmentId,
} from "@aivideo/contracts";
import { Dialog } from "../Dialog.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

type Step = "form" | "confirm" | "running" | "proposal" | "applied";

const FAILURE_LABELS: Record<string, string> = {
  CAPTIONS_PROVIDER_UNSUPPORTED: "Provider 尚未通过字幕能力测试。下一步：点“测试字幕兼容性”，通过后再发起。",
  CAPTIONS_PROVIDER_SEGMENTS_INVALID: "所选片段无效或不属于当前项目。下一步：重新勾选片段后重试。",
  CAPTIONS_PROVIDER_BASE_DRIFT: "时间线在准备期间发生了变化。下一步：重新准备外传确认。",
  CAPTIONS_PROVIDER_EGRESS_EXPIRED: "外传确认已过期。下一步：返回表单重新准备。",
  CAPTIONS_PROVIDER_EGRESS_MISMATCH: "外传内容校验不一致。下一步：返回表单重新准备并确认。",
  CAPTIONS_PROVIDER_EGRESS_REUSED: "该外传确认已被使用。下一步：重新准备新的确认。",
  CAPTIONS_PROVIDER_SNAPSHOT_DRIFT: "Provider 配置或凭据状态已变化。下一步：重新准备外传确认。",
  CAPTIONS_PROVIDER_OUTPUT_INVALID: "Provider 返回内容不符合固定结构；未写入任何结果。下一步：重试或更换 Provider。",
  CAPTIONS_PROVIDER_PROPOSAL_EMPTY: "Provider 没有产生文本变化（原文已足够简短），无需应用。",
  CAPTIONS_PROVIDER_PARAMS_INVALID: "字幕参数不合法（例如最大字数）。下一步：调整后重试。",
  CAPTIONS_PROVIDER_RESULT_NOT_FOUND: "尚未产生可用结果。下一步：等待生成完成或重新发起。",
  PROVIDER_AUTH_FAILED: "Provider 认证失败。下一步：检查设置中的密钥。",
  PROVIDER_RATE_LIMITED: "Provider 限流。下一步：稍后重试。",
  PROVIDER_TIMEOUT: "Provider 请求超时。下一步：稍后重试。",
  PROVIDER_NETWORK_ERROR: "网络不可达。下一步：检查系统代理后重试。",
};

const PRESETS = [
  { value: "default-bottom", label: "默认底部" },
  { value: "game-safe-bottom", label: "游戏安全区" },
  { value: "high-contrast", label: "高对比" },
];

/**
 * AI 字幕优化面板（Slice 5）。
 *
 * 用户视角：把已生成的转录字幕文本交给 Provider 改写成更短的字幕。
 * 边界（与 Core 契约一致）：
 * - 只外发 segment_id/ordinal/text/duration_bucket，不发时间码、不发画面；
 * - caption_id 与时间码全部由 Core 绑定，Provider 只能改文字；
 * - 产出提案，必须显式“应用”才落新 Revision；
 * - 前置条件：时间线中已存在 origin=transcript 的字幕（即已“追加所选片段”）。
 *
 * 权威状态源 = getCaptionsProviderGeneration 轮询（CreateResponse 不含 job_id，
 * 无法 subscribeJob；对齐 AgentSessionPanel 的既有轮询先例）。
 */
export function CaptionsProviderPanel({
  projectId,
  baseRevisionId,
  providers,
  transcript,
  segmentIds,
  onClose,
  onApplied,
  onNotify,
}: {
  projectId: ProjectId;
  baseRevisionId: TimelineRevisionId | null;
  providers: ProviderConfig[];
  transcript: Transcript;
  segmentIds: string[];
  onClose: () => void;
  onApplied: () => void;
  onNotify: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [providerId, setProviderId] = useState("");
  const [presetId, setPresetId] = useState("default-bottom");
  const [maxChars, setMaxChars] = useState(24);
  const [preview, setPreview] = useState<CaptionsProviderEgressPreview>();
  const [generation, setGeneration] = useState<CaptionsProviderGeneration>();
  const [proposal, setProposal] = useState<CaptionsProviderProposal>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilityTesting, setCapabilityTesting] = useState(false);
  // 探测结果合并回本地 Provider 快照，使 supported 门禁即时生效。
  const [overrides, setOverrides] = useState<Record<string, Partial<ProviderConfig>>>({});
  // Provider 列表由本面板自行加载：转录页入口不经过 AI 粗剪/修改对话框，
  // 那两处才填充 App 的 provider 状态，直接复用会拿到空列表。
  const [loaded, setLoaded] = useState<ProviderConfig[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const projectRef = useRef(projectId);

  useEffect(() => {
    let active = true;
    if (!window.desktop.listProviders) return () => { active = false; };
    void window.desktop.listProviders().then(page => {
      if (!active || !Array.isArray(page.items)) return;
      setLoaded(page.items);
      // 默认选中首个已通过字幕能力测试的 Provider。
      const ready = page.items.find(item => item.enabled && item.credential_status === "configured" && item.captions_provider_capability_status === "supported");
      if (ready) setProviderId(current => current || ready.provider_config_id);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  // 项目切换即中止轮询与迟到响应（对齐 WorklistPanel 的隔离做法）。
  useEffect(() => {
    projectRef.current = projectId;
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [projectId]);

  const merged = useMemo(
    () => [...providers, ...loaded]
      .filter((item, index, all) => all.findIndex(other => other.provider_config_id === item.provider_config_id) === index)
      .filter(item => item.enabled && item.credential_status === "configured")
      .map(item => ({ ...item, ...overrides[item.provider_config_id] })),
    [providers, loaded, overrides],
  );
  const current = merged.find(item => item.provider_config_id === providerId);
  const textById = useMemo(
    () => new Map<string, string>(transcript.segments.map(item => [String(item.segment_id), item.text])),
    [transcript],
  );
  const characterCount = segmentIds.reduce((total, id) => total + (textById.get(String(id))?.length ?? 0), 0);
  const canPrepare = !busy && providerId !== "" && current?.captions_provider_capability_status === "supported"
    && baseRevisionId !== null && segmentIds.length > 0;

  const testCapability = async (id: string) => {
    if (!window.desktop.testCaptionsProviderCapability) { setError("字幕兼容性测试不可用。"); return; }
    try {
      setCapabilityTesting(true); setError("");
      const result = await window.desktop.testCaptionsProviderCapability(id) as Record<string, unknown>;
      setOverrides(current => ({
        ...current,
        [id]: {
          captions_provider_capability_status: result.captions_provider_capability_status as ProviderConfig["captions_provider_capability_status"],
          captions_provider_response_adapter_id: (result.captions_provider_response_adapter_id ?? null) as ProviderConfig["captions_provider_response_adapter_id"],
          captions_provider_probe_protocol_version: (result.captions_provider_probe_protocol_version ?? null) as string | null,
          captions_provider_capability_tested_at: (result.captions_provider_capability_tested_at ?? null) as string | null,
          captions_provider_capability_failure_code: (result.captions_provider_capability_failure_code ?? null) as ProviderConfig["captions_provider_capability_failure_code"],
          captions_provider_capability_probe_sha256: (result.captions_provider_capability_probe_sha256 ?? null) as string | null,
        },
      }));
      const status = String(result.captions_provider_capability_status ?? "");
      if (status === "supported") setError("字幕能力可用。");
      else if (status === "untested") setError("字幕能力测试未完成，请重试。");
      else setError("当前 Provider 不支持字幕文本生成。");
    } catch {
      setError("字幕兼容性测试失败；未显示 Provider 响应内容。");
    } finally { setCapabilityTesting(false); }
  };

  const poll = useCallback(async (generationId: string): Promise<void> => {
    if (!window.desktop.getCaptionsProviderGeneration) return;
    try {
      const value = await window.desktop.getCaptionsProviderGeneration({ project_id: projectRef.current, generation_id: generationId });
      if (projectRef.current !== projectId) return;
      setGeneration(value);
      if (value.status === "queued" || value.status === "running") {
        pollRef.current = setTimeout(() => void poll(generationId), 1500);
        return;
      }
      if (value.status !== "succeeded") {
        setStep("form");
        setError(value.status === "cancelled" ? "生成已取消。旧确认已失效，请重新准备。"
          : "生成未完成。旧确认已失效，请重新准备。");
        return;
      }
      if (!window.desktop.createCaptionsProviderProposal) { setStep("form"); setError("提案功能不可用。"); return; }
      const value2 = await window.desktop.createCaptionsProviderProposal({ project_id: projectRef.current, generation_id: generationId });
      if (projectRef.current !== projectId) return;
      setProposal(value2);
      setStep("proposal");
    } catch (caught) {
      if (projectRef.current !== projectId) return;
      const code = errorCode(caught);
      setStep("form");
      setError(FAILURE_LABELS[code ?? ""] ?? "生成已完成，但提案读取失败；请稍后重试。");
    }
  }, [projectId]);

  const prepare = async () => {
    if (!baseRevisionId) { setError("请先创建时间线。"); return; }
    if (!window.desktop.prepareCaptionsProvider) { setError("字幕优化功能不可用。"); return; }
    setBusy(true); setError("");
    try {
      const value = await window.desktop.prepareCaptionsProvider({
        project_id: projectId,
        base_revision_id: baseRevisionId,
        provider_config_id: providerId,
        transcript_id: transcript.transcript_id as TranscriptId,
        segment_ids: segmentIds as TranscriptSegmentId[],
        language: transcript.language,
        preset_id: presetId,
        max_chars_per_caption: maxChars,
      });
      setPreview(value);
      setStep("confirm");
    } catch (caught) {
      const code = errorCode(caught);
      setError(FAILURE_LABELS[code ?? ""] ?? safeErrorMessage(caught, "准备失败。请刷新 Timeline 后重试。"));
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (!preview || !window.desktop.createCaptionsProvider) return;
    setBusy(true); setError("");
    try {
      const response = await window.desktop.createCaptionsProvider({
        project_id: projectId,
        captions_provider_egress_preview_id: preview.captions_provider_egress_preview_id,
        payload_sha256: preview.payload_sha256,
      });
      setPreview(undefined);
      setStep("running");
      void poll(response.captions_provider_generation_id);
    } catch (caught) {
      const code = errorCode(caught);
      setError(FAILURE_LABELS[code ?? ""] ?? safeErrorMessage(caught, "调用失败；必须重新准备并确认外传内容。"));
      setPreview(undefined);
      setStep("form");
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!proposal || !window.desktop.applyCaptionsProviderProposal) return;
    setBusy(true); setError("");
    try {
      await window.desktop.applyCaptionsProviderProposal({
        project_id: projectId,
        proposal_id: proposal.captions_provider_proposal_id,
        base_revision_id: proposal.base_revision_id,
        proposed_document_sha256: proposal.proposed_document_sha256,
      });
      setStep("applied");
      onApplied();
      onNotify("字幕优化已应用为新的 Revision。");
    } catch (caught) {
      const code = errorCode(caught);
      setError(FAILURE_LABELS[code ?? ""] ?? safeErrorMessage(caught, "应用冲突。请刷新 Timeline 后重新生成提案。"));
    } finally { setBusy(false); }
  };

  return <Dialog titleId="captions-provider-title" label="AI 字幕优化" onClose={onClose} className="captions-provider">
    <div className="modal-heading">
      <div>
        <h2 id="captions-provider-title">AI 字幕优化</h2>
        <p>把选中的转录文本改写成更短的字幕；时间码与字幕归属由本地决定，Provider 只能改文字。</p>
      </div>
      <button className="icon-button" aria-label="关闭 AI 字幕优化" onClick={onClose}>×</button>
    </div>
    {error && <p className="ai-status" role="status">{error}</p>}

    {step === "form" && <>
      <div className="readonly-note">
        <strong>已选 {segmentIds.length} 段</strong> · 共 {characterCount} 字
        <ul>{segmentIds.slice(0, 6).map(id => <li key={id}>{textById.get(String(id)) ?? id}</li>)}</ul>
        {segmentIds.length > 6 && <small>另有 {segmentIds.length - 6} 段未展开。</small>}
      </div>
      <p className="readonly-note">
        前置条件：这些片段需已“追加所选片段”到时间线并生成字幕，否则 Provider 改写的文本无法对应到字幕。
      </p>
      <label>Provider
        <select aria-label="字幕优化 Provider" value={providerId} onChange={event => setProviderId(event.target.value)}>
          <option value="">选择已配置 Provider</option>
          {merged.map(item => <option value={item.provider_config_id} key={item.provider_config_id}>
            {item.display_name} · {item.model} · {
              item.captions_provider_capability_status === "supported" ? "字幕可用"
                : item.captions_provider_capability_status === "untested" ? "未测试"
                  : "当前 Provider 不支持字幕生成"}
          </option>)}
        </select>
      </label>
      {merged.length === 0 && <p className="readonly-note">
        尚无已配置 Provider。下一步：打开「Provider 设置」（工具菜单或设置里），新建 Provider 并保存密钥，然后回到这里。
      </p>}
      {current && <div className="captions-provider-status-row">
        <span>{current.captions_provider_capability_status === "supported" ? "字幕能力已验证" : current.captions_provider_capability_status === "untested" ? "需要先验证字幕能力" : "当前 Provider 不支持字幕生成"}</span>
        <button disabled={capabilityTesting} onClick={() => void testCapability(current.provider_config_id)}>
          {capabilityTesting ? "测试中…" : "测试字幕兼容性"}
        </button>
      </div>}
      <label>字幕预设
        <select aria-label="字幕预设" value={presetId} onChange={event => setPresetId(event.target.value)}>
          {PRESETS.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label>每条字幕最大字数
        <input aria-label="每条字幕最大字数" type="number" min={1} max={200} value={maxChars}
          onChange={event => setMaxChars(Number(event.target.value))} />
      </label>
      <div className="modal-actions">
        <button disabled={!canPrepare} onClick={() => void prepare()}>准备外传确认</button>
      </div>
    </>}

    {step === "confirm" && preview && <>
      <h3>确认本次外传内容</h3>
      <dl>
        <dt>Provider</dt><dd>{preview.provider.display_name} · {preview.provider.origin}</dd>
        <dt>模型</dt><dd>{preview.provider.model}</dd>
        <dt>外发字段</dt><dd>{preview.sent_fields.join("、")}</dd>
        <dt>内容计数</dt><dd>{preview.segment_count} 段 · {preview.character_count} 字</dd>
        <dt>哈希</dt><dd>{preview.payload_sha256}</dd>
        <dt>有效期</dt><dd>{preview.expires_at}</dd>
      </dl>
      <p className="readonly-note">只发送文本与片段标识，不发送时间码与画面。改写结果会先作为提案展示，不会自动修改时间线。</p>
      <div className="modal-actions">
        <button onClick={() => { setPreview(undefined); setStep("form"); }}>返回修改</button>
        <button disabled={busy} onClick={() => void create()}>确认并生成</button>
      </div>
    </>}

    {step === "running" && <>
      <h3>正在生成字幕文本</h3>
      <p>{generation?.status === "queued" ? "排队中" : "执行中"}（{generation?.status ?? "queued"}）</p>
      <progress max={1} value={generation?.status === "succeeded" ? 1 : 0} aria-label="字幕生成进度" />
      <p className="readonly-note">生成期间可关闭面板；结果会保留，稍后可从工作单继续处理。</p>
    </>}

    {step === "proposal" && proposal && <>
      <h3>字幕改写提案</h3>
      <p className="readonly-note">{proposal.patch.summary} · 共 {proposal.patch.operations.length} 处文本变化</p>
      <ul className="captions-provider-diff">
        {proposal.patch.operations.map(operation => <li key={operation.caption_id}>
          <code>{operation.caption_id}</code> → <strong>{operation.text}</strong>
        </li>)}
      </ul>
      <p className="readonly-note">仅在你明确点击下方按钮后应用；应用会创建一个新的 Revision。</p>
      <div className="modal-actions">
        <button onClick={onClose}>稍后处理</button>
        <button disabled={busy} onClick={() => void apply()}>应用为新的 Revision</button>
      </div>
    </>}

    {step === "applied" && <>
      <h3>已应用</h3>
      <p className="readonly-note">字幕文本已更新为新的 Revision。可使用撤销回退。</p>
      <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
    </>}
  </Dialog>;
}

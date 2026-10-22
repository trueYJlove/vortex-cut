/**
 * W3.3 逐张审阅面板（D4：egress preview 必须可逐张审阅）。
 *
 * 这个面板存在的**唯一理由**是 ADR-0003 D4 的硬承诺：
 * 「egress preview 呈现『这 N 张关键帧将发送给 Provider X』，用户可逐张审阅」。
 *
 * 三条不可让步的设计约束：
 *  1. **每张都可见**：序号 / 时间码 / 尺寸 / 实测字节逐行列出，不给「共 N 张」的汇总敷衍了事。
 *     （注：面板只渲染**数字**，不渲染图片——缩略图字节已不再落盘，见 2026-10-21 收口。）
 *  2. **可单张移除**：移除是**服务端持久**的（exclude 端点），不是本地 UI 状态；
 *     关掉面板再打开，被移除的帧仍然不在外传集合里。
 *  3. **明示这不是匿名化**：768px 下行人人脸、室内空间仍可辨（规划门 R1），
 *     界面**不得**用「抽样关键帧」暗示低风险。
 *
 * 为什么移除要立即提交服务端而不是「先攒着最后一起提交」：
 * 后者会造出一个「界面显示已移除、实际仍会外传」的时间窗——
 * 那正是 A12 审计保真要防的形态。
 *
 * 「确认外传」的语义（W3.3 收口）：**同意即外传**。
 * 点击后必须真的走 create → 轮询 → 终态，只关闭弹窗等于假装同意了没发生。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AssetId,
  KeyframeEgressPreview,
  KeyframeGenerationStatus,
  ProjectId,
  ProviderConfig,
} from "@aivideo/contracts";

import { Dialog } from "../Dialog.js";
import { errorCode } from "../safeErrors.js";

/**
 * 提交后的相位。`running` 覆盖上游 queued/running：
 * 对用户而言「已提交、还在算」是一种状态，没必要暴露内部排队细节。
 */
type SubmitPhase = "idle" | "running" | "succeeded" | "failed";

/**
 * 失败码 → 可操作提示。**只认白名单码**：未登记的错误一律落到稳定文案，
 * 绝不把上游原文（可能含路径、Provider 响应正文）送到 DOM——
 * 与本文件 prepare 的「只暴露稳定文案」同一口径。
 */
const FAILURE_HINTS: Record<string, string> = {
  VISION_PROVIDER_UNSUPPORTED: "该 Provider 不支持关键帧理解。下一步：在设置中换一个支持视觉输入的 Provider。",
  VISION_FRAMES_UNMAPPED: "该素材没有可用的关键帧。下一步：确认素材是有效视频后重新生成预览。",
  KEYFRAME_PREVIEW_EXPIRED: "外传确认已过期。下一步：重新生成关键帧预览并再次确认。",
  KEYFRAME_EGRESS_CONSENT_REQUIRED: "本次外传缺少有效同意。下一步：重新生成预览并勾选确认。",
  VISION_VOCABULARY_VIOLATION: "帧标签超出词表范围，已改道备注、未阻断生成。可查看逐帧标签确认。",
  PROVIDER_AUTH_FAILED: "Provider 认证失败。下一步：检查设置中的密钥。",
  PROVIDER_RATE_LIMITED: "Provider 限流。下一步：稍后重试。",
  PROVIDER_TIMEOUT: "Provider 请求超时。下一步：稍后重试。",
  PROVIDER_NETWORK_ERROR: "网络不可达。下一步：检查系统代理后重试。",
};

/** 轮询间隔：与 AgentSessionPanel / CaptionsProviderPanel 保持一致。 */
const POLL_INTERVAL_MS = 1500;

/** 把字节数换成人能读的尺度；预览里这个数字是「将要传出去多少」的实测值。 */
function humanBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatStamp(timestampUs: number): string {
  const totalSeconds = Math.max(0, timestampUs) / 1_000_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

/** null 与 0 必须可区分：0 是真的没有违规，null 是没算过。 */
function countText(value: number | null): string {
  return value === null ? "未知" : String(value);
}

function failureText(value: KeyframeGenerationStatus): string {
  if (value.status === "cancelled") return "生成已取消，未写入任何结果。";
  // 只按白名单码给提示；error_code 本身永不上屏（它可能携带上游原文）。
  const hint = value.error_code === null ? undefined : FAILURE_HINTS[value.error_code];
  return hint ?? "关键帧理解未完成，未写入任何结果。下一步：检查 Provider 配置后重新发起。";
}

export interface KeyframeReviewPanelProps {
  projectId: ProjectId | null;
  assetId: AssetId | null;
  assetName: string;
  onClose: () => void;
}

export function KeyframeReviewPanel({
  projectId, assetId, assetName, onClose,
}: KeyframeReviewPanelProps) {
  const [preview, setPreview] = useState<KeyframeEgressPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState("");
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * 代次隔离（照 App.tsx `projectDataEpochRef` 的做法）：
   * 项目/预览切换、组件卸载都会 `++`，此前发出的轮询响应一律丢弃——
   * 否则一个迟到的成功响应会把「已经换掉的那份预览」的结果贴到界面上。
   */
  const epochRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = undefined;
  }, []);

  useEffect(() => () => { epochRef.current += 1; stopPolling(); }, [stopPolling]);

  // 切项目 ⇒ 连预览一起丢掉：那份预览属于旧项目的素材，
  // 带着它去 create 只会拿到 404，或者在两个项目之间张冠李戴。
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    if (projectIdRef.current === projectId) return;
    projectIdRef.current = projectId;
    epochRef.current += 1;
    stopPolling();
    setPreview(null);
    setConfirmed(false);
    setPhase("idle");
    setResult(null);
  }, [projectId, stopPolling]);

  // 预览换了（重新生成）⇒ 代次 +1，旧的同意与旧结果都不再适用。
  useEffect(() => {
    epochRef.current += 1;
    stopPolling();
    setPhase("idle");
    setResult(null);
  }, [preview?.keyframe_egress_preview_id, stopPolling]);

  // Provider 必须由用户显式选择：预览本身不发网络，但预览行要冻结
  // 「将发给谁」。Core 的 prepare 端点要求 provider_config_id 非空且可解析。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await window.desktop.listProviders?.();
        if (cancelled) return;
        const usable = (response?.items ?? []).filter(
          (item) => item.enabled && item.credential_status === "configured",
        );
        setProviders(usable);
        setProviderId((current) =>
          usable.some((item) => item.provider_config_id === current)
            ? current
            : usable[0]?.provider_config_id ?? "",
        );
      } catch {
        // 拉不到 Provider 不该让面板崩：下面会显示「尚未配置」并禁用按钮。
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const prepare = useCallback(async () => {
    if (!projectId || !assetId) { setError("未选择素材"); return; }
    if (!providerId) { setError("请先配置一个可用的 Provider"); return; }
    setBusy(true); setError(null);
    try {
      const value = await window.desktop.prepareKeyframePreview({
        project_id: projectId,
        asset_id: assetId,
        provider_config_id: providerId,
      });
      setPreview(value);
      setConfirmed(false);
    } catch (caught) {
      // 只暴露稳定文案：上游错误可能含路径或内部标识。
      const message = String(caught).includes("VISION_FRAMES_UNMAPPED")
        ? "该素材没有可用的关键帧（可能不是视频，或时长无效）"
        : "生成预览失败，请稍后重试";
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [projectId, assetId, providerId]);

  const exclude = useCallback(async (frameIndex: number) => {
    if (!projectId || !preview) return;
    // 已经提交过的预览不允许再改：改了也不会影响已发出的载荷，
    // 让用户以为还能改是更坏的结果（见文件头「同意即外传」）。
    if (phase !== "idle") return;
    setBusy(true); setError(null);
    try {
      // 立即提交服务端：见文件头「为什么要立即提交」。
      const updated = await window.desktop.excludeKeyframeFrames({
        project_id: projectId,
        preview_id: preview.keyframe_egress_preview_id,
        frame_indices: [frameIndex],
      });
      setPreview(updated);
      // 载荷变了 ⇒ 之前的「我确认过」自动失效，必须重新确认。
      setConfirmed(false);
    } catch {
      setError("移除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }, [projectId, preview, phase]);

  const poll = useCallback(async (generationId: string, epoch: number): Promise<void> => {
    try {
      const value = await window.desktop.getKeyframeGeneration({
        project_id: projectId as ProjectId,
        generation_id: generationId,
      });
      if (epoch !== epochRef.current) return;
      if (value.status === "queued" || value.status === "running") {
        pollRef.current = setTimeout(() => void poll(generationId, epoch), POLL_INTERVAL_MS);
        return;
      }
      if (value.status === "succeeded") {
        setPhase("succeeded");
        // 违规数为 0 也要显示：0 是「查过了、没有」，不是「没查」。
        setResult({
          tone: "ok",
          text: `生成完成：共 ${countText(value.frame_count)} 帧，词表违规 ${countText(value.vocabulary_violations)} 处`,
        });
        return;
      }
      setPhase("failed");
      setResult({ tone: "error", text: failureText(value) });
    } catch (caught) {
      if (epoch !== epochRef.current) return;
      // 传输层失败同样只给稳定文案（按白名单码取提示，取不到就用兜底）。
      setPhase("failed");
      setResult({ tone: "error", text: FAILURE_HINTS[errorCode(caught)] ?? "查询生成结果失败，请稍后重试。" });
    }
  }, [projectId]);

  /**
   * 「同意外传」= 真的把它发出去。
   * 之前这里写的是 `onClick={onClose}`：只关弹窗、从不调用 create，
   * 于是「用户同意 → generation」这条链在界面上是断的。
   */
  const submit = useCallback(async () => {
    if (!projectId || !preview) return;
    if (phase !== "idle") return; // 已提交过：重复提交等于二次外传。
    setBusy(true); setError(null); setResult(null);
    const epoch = epochRef.current;
    try {
      const response = await window.desktop.createKeyframeGeneration({
        project_id: projectId,
        preview_id: preview.keyframe_egress_preview_id,
        payload_sha256: preview.payload_sha256,
      });
      if (epoch !== epochRef.current) return;
      setPhase("running");
      void poll(response.keyframe_generation_id, epoch);
    } catch (caught) {
      if (epoch !== epochRef.current) return;
      // create 失败 ⇒ 什么都没发出去，回到可重试态（外传尚未开始）。
      setPhase("idle");
      setResult({
        tone: "error",
        text: FAILURE_HINTS[errorCode(caught)] ?? "外传未发起，未写入任何结果。下一步：重新生成预览后再确认。",
      });
    } finally {
      if (epoch === epochRef.current) setBusy(false);
    }
  }, [projectId, preview, phase, poll]);

  const remaining = preview
    ? preview.frames.filter((f) => !preview.excluded_frames.includes(f.frame_index))
    : [];
  const remainingBytes = remaining.reduce((sum, f) => sum + f.payload_bytes, 0);
  const submitted = phase !== "idle";

  return (
    <Dialog label="关键帧外传审阅" onClose={onClose} className="keyframe-review">
      <header className="modal-header">
        <h2>关键帧外传审阅</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭关键帧外传审阅">×</button>
      </header>
      <div className="modal-body">
        <p className="readonly-note">
          这些关键帧将被发送给你配置的云端 Provider。<strong>这不是匿名化</strong>：
          768 像素下人物面部、室内空间等仍可辨认。请逐张确认后再继续。
        </p>

        {!preview ? (
          <div className="keyframe-review-start">
            <p className="readonly-note">素材：{assetName}</p>
            <label className="keyframe-provider">
              发送给：
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                disabled={providers.length === 0}
                aria-label="接收关键帧的 Provider"
              >
                {providers.length === 0 ? <option value="">尚未配置可用的 Provider</option> : null}
                {providers.map((item) => (
                  <option key={item.provider_config_id} value={item.provider_config_id}>
                    {item.display_name}（{item.model}）
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" onClick={() => void prepare()} disabled={busy || !assetId || !providerId}>
              {busy ? "准备中…" : "生成关键帧预览"}
            </button>
          </div>
        ) : null}

        {error ? <p className="semantic-search-error" role="alert">{error}</p> : null}

        {preview ? (
          <>
            <ul className="keyframe-frame-list" aria-label="待外传关键帧">
              {preview.frames.map((frame) => {
                const isExcluded = preview.excluded_frames.includes(frame.frame_index);
                return (
                  <li key={frame.frame_index} className={isExcluded ? "keyframe-frame excluded" : "keyframe-frame"}>
                    <span className="keyframe-frame-index">#{frame.frame_index}</span>
                    <span className="keyframe-frame-time">{formatStamp(frame.timestamp_us)}</span>
                    <span className="keyframe-frame-size">
                      {frame.payload_width}×{frame.payload_height} · {humanBytes(frame.payload_bytes)}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => void exclude(frame.frame_index)}
                      disabled={isExcluded || busy || submitted}
                      aria-label={isExcluded ? `第 ${frame.frame_index} 帧已移除` : `移除第 ${frame.frame_index} 帧`}
                    >
                      {isExcluded ? "已移除" : "移除"}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="readonly-note">
              将外传 <strong>{remaining.length}</strong> 张，合计 <strong>{humanBytes(remainingBytes)}</strong>
              （实测字节，非估算）。
            </p>
            <label className="keyframe-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={remaining.length === 0 || submitted}
              />
              我已逐张审阅上述关键帧，同意发送给 Provider
            </label>
            {remaining.length === 0 ? (
              <p className="readonly-note">所有帧都已被移除，没有内容会被外传。</p>
            ) : null}
            {phase === "running" ? (
              <p className="keyframe-result" role="status">已提交，正在生成关键帧理解…</p>
            ) : null}
            {result ? (
              <p className={result.tone === "ok" ? "keyframe-result" : "keyframe-result error"} role="status">
                {result.text}
              </p>
            ) : null}
            {submitted ? (
              <p className="readonly-note">本次外传已发起，不再接受对这批关键帧的改动。</p>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="primary"
          disabled={!preview || !confirmed || busy || remaining.length === 0 || submitted}
          onClick={() => void submit()}
        >
          {submitted ? "已提交" : busy ? "提交中…" : "确认外传"}
        </button>
      </footer>
    </Dialog>
  );
}

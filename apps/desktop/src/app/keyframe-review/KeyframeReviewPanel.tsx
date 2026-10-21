/**
 * W3.3 逐张审阅面板（D4：egress preview 必须可逐张审阅）。
 *
 * 这个面板存在的**唯一理由**是 ADR-0003 D4 的硬承诺：
 * 「egress preview 呈现『这 N 张关键帧将发送给 Provider X』，用户可逐张审阅」。
 *
 * 三条不可让步的设计约束：
 *  1. **每张都可见**：帧缩略与字节数逐行列出，不给「共 N 张」的汇总敷衍了事。
 *  2. **可单张移除**：移除是**服务端持久**的（exclude 端点），不是本地 UI 状态；
 *     关掉面板再打开，被移除的帧仍然不在外传集合里。
 *  3. **明示这不是匿名化**：768px 下行人人脸、室内空间仍可辨（规划门 R1），
 *     界面**不得**用「抽样关键帧」暗示低风险。
 *
 * 为什么移除要立即提交服务端而不是「先攒着最后一起提交」：
 * 后者会造出一个「界面显示已移除、实际仍会外传」的时间窗——
 * 那正是 A12 审计保真要防的形态。
 */
import { useCallback, useEffect, useState } from "react";

import type { AssetId, KeyframeEgressPreview, ProjectId, ProviderConfig } from "@aivideo/contracts";

import { Dialog } from "../Dialog.js";

export interface KeyframeReviewPanelProps {
  projectId: ProjectId | null;
  assetId: AssetId | null;
  assetName: string;
  onClose: () => void;
}

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

export function KeyframeReviewPanel({
  projectId, assetId, assetName, onClose,
}: KeyframeReviewPanelProps) {
  const [preview, setPreview] = useState<KeyframeEgressPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState("");

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
      const result = await window.desktop.prepareKeyframePreview({
        project_id: projectId,
        asset_id: assetId,
        provider_config_id: providerId,
      });
      setPreview(result);
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
  }, [projectId, preview]);

  const remaining = preview
    ? preview.frames.filter((f) => !preview.excluded_frames.includes(f.frame_index))
    : [];
  const remainingBytes = remaining.reduce((sum, f) => sum + f.payload_bytes, 0);

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
                      disabled={isExcluded || busy}
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
                disabled={remaining.length === 0}
              />
              我已逐张审阅上述关键帧，同意发送给 Provider
            </label>
            {remaining.length === 0 ? (
              <p className="readonly-note">所有帧都已被移除，没有内容会被外传。</p>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="primary"
          disabled={!preview || !confirmed || busy || remaining.length === 0}
          onClick={onClose}
        >
          确认外传
        </button>
      </footer>
    </Dialog>
  );
}

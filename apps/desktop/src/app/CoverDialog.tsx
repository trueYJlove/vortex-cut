/** 项目封面设置弹窗（2026-09-23 · v5 设计稿场景③）：导出弹窗 Hero 封面与
 *  时间线面板封面入口共用。三个动作——截取当前播放头画面（调用方注入，
 *  复用 App 的 captureCover 快照链）、从本机选择图片（File → ≤540px JPEG
 *  dataURL，与截取口径一致，localStorage 容量安全）、移除封面。
 *  持久化由调用方负责（onChange 回调 + localStorage，键
 *  vortex-cut.cover.<projectId>），本组件只管编辑与会话内预览。 */
import { useRef, useState } from "react";
import { Dialog } from "./Dialog.js";

const MAX_COVER_EDGE = 540;

/** 本机图片 → 等比缩到 ≤540px 的 JPEG dataURL（失败返回 null）。 */
export function imageFileToCoverUrl(file: File): Promise<string | null> {
  return new Promise(resolve => {
    if (!file.type.startsWith("image/")) { resolve(null); return; }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, MAX_COVER_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round(img.width * scale));
      canvas.height = Math.max(2, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
    img.src = objectUrl;
  });
}

export function CoverDialog({ coverUrl, onClose, onCapture, onChange }: {
  coverUrl: string | null;
  onClose: () => void;
  /** 截取当前播放头画面（App.captureCover）；返回新封面或 null。 */
  onCapture: () => Promise<string | null>;
  onChange: (coverUrl: string | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const capture = async () => {
    setBusy(true);
    setError("");
    try {
      const url = await onCapture();
      if (url) onChange(url);
      else setError("预览尚未就绪，无法截取封面。");
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const url = await imageFileToCoverUrl(file);
      if (url) onChange(url);
      else setError("图片读取失败，请换一张试试。");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog titleId="cover-title" title="设置项目封面" subtitle="用于项目列表与导出信息展示 · 本机持久化" closeLabel="关闭封面弹窗" bodyClassName="cov-body" footer={<>
        <button type="button" disabled={!coverUrl} onClick={() => onChange(null)}>移除封面</button>
        <button type="button" onClick={onClose}>完成</button>
      </>} label="设置项目封面" onClose={onClose} className="cover-modal">
        {coverUrl
          ? <img className="cov-preview" src={coverUrl} alt="当前封面预览" />
          : <div className="cov-preview cov-preview-empty">暂无封面（16:9）</div>}
        <div className="cov-actions">
          <button type="button" className="cov-accent" disabled={busy} onClick={() => void capture()}>截取当前播放头画面</button>
          <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>从本机选择图片…</button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden aria-hidden
            onChange={event => void pickFile(event.target.files?.[0])} />
        </div>
        {error && <p className="cov-error" role="status">{error}</p>}
    </Dialog>
  );
}
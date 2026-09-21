import { useEffect, useState } from "react";
import { Dialog } from "../Dialog.js";
import { safeErrorMessage } from "../safeErrors.js";

type ProxyMode = "system" | "custom" | "direct";

interface SettingsState {
  saved: { proxy_mode: ProxyMode; provider_proxy: string | null };
  effective: { proxy_mode: ProxyMode; provider_proxy: string | null } | null;
  pending_restart: boolean;
}

const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
  system: "系统代理（默认）",
  custom: "自定义代理",
  direct: "直连"
};

const EFFECTIVE_LABELS: Record<ProxyMode, string> = {
  system: "系统代理",
  custom: "自定义代理",
  direct: "直连"
};

/**
 * DESK-3：设置对话框（代理三选 + 自定义地址）。当前生效状态行区分
 * "已保存"与"当前生效"两态——Core 启动时解析一次代理，保存后需重启内核
 * 才生效（规划门 §5 裁决①）。
 */
export function SettingsDialog({ onClose, onNotify }: { onClose: () => void; onNotify: (message: string) => void }) {
  const [state, setState] = useState<SettingsState | undefined>();
  const [mode, setMode] = useState<ProxyMode>("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    let active = true;
    void window.desktop.getSettings().then(value => {
      if (!active) return;
      setState(value);
      setMode(value.saved.proxy_mode);
      setProxyUrl(value.saved.provider_proxy ?? "");
    }).catch(() => { if (active) setError("无法读取设置。"); });
    return () => { active = false; };
  }, []);

  const proxyUrlValid = mode !== "custom" || /^https?:\/\/[A-Za-z0-9._\-]+(:\d{1,5})?(\/.*)?$/.test(proxyUrl.trim());

  const save = async () => {
    if (!proxyUrlValid) { setError("自定义代理地址需形如 http://127.0.0.1:10809。"); return; }
    setBusy(true); setError("");
    try {
      const saved = await window.desktop.setSettings({ proxy_mode: mode, provider_proxy: mode === "custom" ? proxyUrl.trim() : null });
      setState(current => current ? {
        saved,
        effective: current.effective,
        pending_restart: current.effective !== null && (current.effective.proxy_mode !== saved.proxy_mode || current.effective.provider_proxy !== saved.provider_proxy)
      } : current);
      onNotify("设置已保存。" + (mode === "custom" ? "连接测试将使用当前代理设置。" : ""));
    } catch (caught) { setError(safeErrorMessage(caught, "设置保存失败。")); }
    finally { setBusy(false); }
  };

  const restartCore = async () => {
    if (!confirmRestart) { setConfirmRestart(true); return; }
    setConfirmRestart(false);
    setRestarting(true); setError("");
    try {
      await window.desktop.restartCore();
      const value = await window.desktop.getSettings();
      setState(value);
      onNotify("内核已重启，代理设置已生效。");
    } catch (caught) { setError(safeErrorMessage(caught, "内核重启失败，请查看日志。")); }
    finally { setRestarting(false); }
  };

  const effectiveLabel = state?.effective ? EFFECTIVE_LABELS[state.effective.proxy_mode] + (state.effective.proxy_mode === "custom" && state.effective.provider_proxy ? ` · ${state.effective.provider_proxy}` : "") : "内核尚未启动";

  return <Dialog titleId="settings-title" label="设置" onClose={onClose} className="settings-dialog">
    <div className="modal-heading"><div><h2 id="settings-title">设置</h2><p>Provider 出网与本地分析行为。</p></div><button className="icon-button" aria-label="关闭设置" onClick={onClose}>×</button></div>
    {error && <p className="ai-status" role="status">{error}</p>}
    {state && <>
      <fieldset>
        <legend>Provider 代理</legend>
        <div role="radiogroup" aria-label="代理模式">
          {(Object.keys(PROXY_MODE_LABELS) as ProxyMode[]).map(value => (
            <label key={value} className="settings-radio">
              <input type="radio" name="proxy-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
              {PROXY_MODE_LABELS[value]}
            </label>
          ))}
        </div>
        <label>自定义代理地址
          <input aria-label="自定义代理地址" value={proxyUrl} disabled={mode !== "custom"} placeholder="http://127.0.0.1:10809" onChange={event => setProxyUrl(event.target.value)} />
        </label>
        <p className="readonly-note">连接测试将使用当前代理设置；代理不改变外发内容，只改变网络路径。</p>
        <div className="modal-actions">
          <button disabled={busy || !proxyUrlValid || (state.saved.proxy_mode === mode && (state.saved.provider_proxy ?? "") === (mode === "custom" ? proxyUrl.trim() : ""))} onClick={() => void save()}>保存</button>
        </div>
      </fieldset>
      <p className="settings-effective"><strong>当前生效：</strong>{effectiveLabel}{state.pending_restart && <span className="readonly-note">（有已保存未生效的更改）</span>}</p>
      {confirmRestart && <p className="ai-status" role="alert">重启将中断进行中的任务（转录/生成/导出等），确认继续吗？<button onClick={() => { setConfirmRestart(false); void restartCore(); }}>确认重启</button><button onClick={() => setConfirmRestart(false)}>取消</button></p>}
      <div className="modal-actions">
        <button disabled={restarting || !state.pending_restart} title={state.pending_restart ? "重启本地内核以应用新代理设置" : "没有待生效的设置"} onClick={() => void restartCore()}>{restarting ? "正在重启内核…" : confirmRestart ? "再次点击确认重启" : "重启内核使设置生效"}</button>
      </div>
    </>}
  </Dialog>;
}

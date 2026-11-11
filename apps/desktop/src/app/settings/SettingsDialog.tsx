import { useEffect, useState } from "react";
import { MonitorPlay, Search, Settings2, SquareTerminal, Wifi } from "lucide-react";
import { Dialog } from "../Dialog.js";
import { safeErrorMessage } from "../safeErrors.js";
import { useThemeMode, type ThemeMode } from "../theme.js";

type ProxyMode = "system" | "custom" | "direct";
type PreviewQuality = "auto" | "540" | "720" | "1080";

interface PlaybackSettings {
  preview_proxy_auto: boolean;
  preview_proxy_quality: PreviewQuality;
}

interface SettingsState {
  saved: { proxy_mode: ProxyMode; provider_proxy: string | null } & PlaybackSettings;
  effective: ({ proxy_mode: ProxyMode; provider_proxy: string | null } & PlaybackSettings) | null;
  pending_restart: boolean;
}

type SectionId = "general" | "network" | "playback" | "developer";

const THEME_LABELS: Record<ThemeMode, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

const PREVIEW_QUALITY_LABELS: Record<PreviewQuality, string> = {
  auto: "自动（按素材尺寸）",
  "540": "540p（更流畅）",
  "720": "720p（平衡）",
  "1080": "1080p（更清晰）",
};

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
export function SettingsDialog({ onClose, onNotify, onOpenProviderSettings }: { onClose: () => void; onNotify: (message: string) => void; onOpenProviderSettings: () => void }) {
  const [state, setState] = useState<SettingsState | undefined>();
  const [mode, setMode] = useState<ProxyMode>("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [proxyAuto, setProxyAuto] = useState(true);
  const [proxyQuality, setProxyQuality] = useState<PreviewQuality>("auto");
  const [themeMode, setThemeMode] = useThemeMode();

  useEffect(() => {
    let active = true;
    void window.desktop.getSettings().then(value => {
      if (!active) return;
      setState(value);
      setMode(value.saved.proxy_mode);
      setProxyUrl(value.saved.provider_proxy ?? "");
      setProxyAuto(value.saved.preview_proxy_auto);
      setProxyQuality(value.saved.preview_proxy_quality);
    }).catch(() => { if (active) setError("无法读取设置。"); });
    return () => { active = false; };
  }, []);

  const proxyUrlValid = mode !== "custom" || /^https?:\/\/[A-Za-z0-9._\-]+(:\d{1,5})?(\/.*)?$/.test(proxyUrl.trim());

  /** 播放设置即时生效（下次登记/解析代理时读取），与需重启内核的代理设置分开保存。 */
  const savePlayback = async (next: PlaybackSettings) => {
    setBusy(true); setError("");
    try {
      const saved = await window.desktop.setSettings(next);
      setState(current => current ? {
        saved,
        effective: current.effective,
        pending_restart: current.effective !== null && (current.effective.proxy_mode !== saved.proxy_mode || current.effective.provider_proxy !== saved.provider_proxy)
      } : current);
      onNotify("播放设置已保存，下次预览生效。");
    } catch (caught) { setError(safeErrorMessage(caught, "播放设置保存失败。")); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!proxyUrlValid) { setError("自定义代理地址需形如 http://127.0.0.1:10809。"); return; }
    setBusy(true); setError("");
    try {
      const saved = await window.desktop.setSettings({ proxy_mode: mode, provider_proxy: mode === "custom" ? proxyUrl.trim() : null, preview_proxy_auto: proxyAuto, preview_proxy_quality: proxyQuality });
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

  /* 分区定义（2026-11-10，参照 OpenFilm 的 SettingsModal 左侧导航）：
     原先是单页 fieldset 堆叠，分区一多就要一直往下滚。改为左侧导航 + 右侧内容，
     导航分组与 OpenFilm 同构：设置组（通用/网络/预览）、帮助组（快捷键/诊断）。
     每个分区保留原有的全部控件与 aria 名称，只改容器结构——
     既有测试按 aria 名称取元素，因此不会失效。 */
  const sections: { id: SectionId; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "通用", icon: <Settings2 size={18} strokeWidth={1.75} /> },
    { id: "network", label: "网络代理", icon: <Wifi size={18} strokeWidth={1.75} /> },
    { id: "playback", label: "预览播放", icon: <MonitorPlay size={18} strokeWidth={1.75} /> },
    { id: "developer", label: "诊断", icon: <SquareTerminal size={18} strokeWidth={1.75} /> },
  ];
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const matched = sections.filter(item => !query.trim() || item.label.toLowerCase().includes(query.trim().toLowerCase()));

  const generalPanel = <>
  <fieldset>
    <legend>外观</legend>
    <div role="radiogroup" aria-label="主题">
      {(Object.keys(THEME_LABELS) as ThemeMode[]).map(value => (
        <label key={value} className="settings-radio">
          <input type="radio" name="theme-mode" value={value} checked={themeMode === value} onChange={() => setThemeMode(value)} />
          {THEME_LABELS[value]}
        </label>
      ))}
    </div>
    <p className="readonly-note readonly-note--plain">「跟随系统」会随操作系统明暗外观实时切换；选择立即生效并记住。</p>
  </fieldset>
  <fieldset>
    <legend>Provider 配置</legend>
    <p className="readonly-note readonly-note--plain">AI 粗剪、AI 修改、AI 助手与 AI 字幕优化共用的 Provider（地址、模型、密钥）。</p>
    <div className="modal-actions">
      <button onClick={() => { onOpenProviderSettings(); onClose(); }}>打开 Provider 设置</button>
    </div>
  </fieldset>
  </>;

  const saved = state?.saved;
  const pendingRestart = Boolean(state?.pending_restart);
  const networkPanel = state && <>
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
        <button disabled={busy || !proxyUrlValid || (saved!.proxy_mode === mode && (saved!.provider_proxy ?? "") === (mode === "custom" ? proxyUrl.trim() : ""))} onClick={() => void save()}>保存</button>
      </div>
    </fieldset>
    <p className="settings-effective"><strong>当前生效：</strong>{effectiveLabel}{pendingRestart && <span className="readonly-note readonly-note--plain">（有已保存未生效的更改）</span>}</p>
  </>;

  const playbackPanel = <fieldset>
    <legend>预览播放</legend>
    <label className="settings-radio">
      <input
        type="checkbox"
        aria-label="为大体素材生成预览代理"
        checked={proxyAuto}
        onChange={event => { const next = event.target.checked; setProxyAuto(next); void savePlayback({ preview_proxy_auto: next, preview_proxy_quality: proxyQuality }); }}
      />
      为大体素材生成预览代理
    </label>
    <p className="readonly-note readonly-note--plain">超过 1080p 或解码较慢（ProRes / HEVC / 10 位）的素材，会在后台生成一份轻量副本用于预览播放；导出始终使用原片。关闭后预览直接播放原片。</p>
    <label>代理分辨率
      <select
        aria-label="代理分辨率"
        value={proxyQuality}
        disabled={!proxyAuto}
        onChange={event => { const next = event.target.value as PreviewQuality; setProxyQuality(next); void savePlayback({ preview_proxy_auto: proxyAuto, preview_proxy_quality: next }); }}
      >
        {(Object.keys(PREVIEW_QUALITY_LABELS) as PreviewQuality[]).map(value => (
          <option key={value} value={value}>{PREVIEW_QUALITY_LABELS[value]}</option>
        ))}
      </select>
    </label>
    <p className="readonly-note readonly-note--plain">档位越低播放越流畅、画面越糊；自动档按素材短边选择。此设置即时生效，无需重启内核。</p>
  </fieldset>;

  const developerPanel = <>
    <fieldset>
      <legend>版本信息</legend>
      <p className="readonly-note readonly-note--plain">窗口缩放、渲染后端与解码能力等运行期信息显示在界面底栏的版本号处。</p>
    </fieldset>
    <fieldset>
      <legend>内核</legend>
      <p className="readonly-note readonly-note--plain">代理设置在重启本地内核后生效；其余设置即时生效。</p>
      <div className="modal-actions">
        <button disabled={restarting || !pendingRestart} title={pendingRestart ? "重启本地内核以应用新代理设置" : "没有待生效的设置"} onClick={() => void restartCore()}>{restarting ? "正在重启内核…" : confirmRestart ? "再次点击确认重启" : "重启内核使设置生效"}</button>
      </div>
    </fieldset>
  </>;

  return <Dialog titleId="settings-title" title="设置" subtitle="外观、网络与预览行为。" closeLabel="关闭设置" label="设置" onClose={onClose} className="settings-dialog settings-dialog-nav">
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="设置分区">
        <label className="settings-search">
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
        </label>
        {matched.length === 0 && <p className="settings-nav-empty">没有匹配的分区</p>}
        {matched.map(item => (
          <button
            key={item.id}
            type="button"
            aria-current={section === item.id ? "page" : undefined}
            className={`settings-nav-item${section === item.id ? " active" : ""}`}
            onClick={() => setSection(item.id)}
          >
            <span className="settings-nav-icon">{item.icon}</span>
            <span className="settings-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {error && <p className="ai-status" role="status">{error}</p>}
        {section === "general" && generalPanel}
        {section === "network" && networkPanel}
        {section === "playback" && playbackPanel}
        {section === "developer" && developerPanel}
        {confirmRestart && <p className="ai-status" role="alert">重启将中断进行中的任务（转录/生成/导出等），确认继续吗？<button onClick={() => { setConfirmRestart(false); void restartCore(); }}>确认重启</button><button onClick={() => setConfirmRestart(false)}>取消</button></p>}
      </div>
    </div>
  </Dialog>;
}

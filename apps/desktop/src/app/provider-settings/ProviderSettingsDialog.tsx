import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderConfig } from "@aivideo/contracts";
import { LockKeyhole } from "lucide-react";
import { Dialog } from "../Dialog.js";
import { errorCode, safeErrorMessage } from "../safeErrors.js";

type ProviderPreset = { id: string; name: string; description: string; base_url: string; model: string };

// 这些是“填表模板”，不会替用户保存密钥，也不会偷偷发起请求。
// 选择后填充地址与模型；密钥可在创建时提交，也可稍后在管理页保存。
const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", description: "官方 OpenAI API", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "deepseek", name: "DeepSeek", description: "DeepSeek 官方 API", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "qwen", name: "通义千问", description: "阿里云百炼兼容接口", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "moonshot", name: "月之暗面", description: "Moonshot Kimi API", base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "openrouter", name: "OpenRouter", description: "多模型聚合网关", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { id: "custom-gateway", name: "其他中转 / 网关", description: "使用自定义兼容地址", base_url: "", model: "" },
];

/**
 * Provider 设置（独立入口）。
 *
 * 为什么独立：Provider 的创建/密钥/连接测试原先只存在于「AI 粗剪」对话框里，
 * 但 AI 粗剪、AI 修改、AI 助手、AI 字幕优化都依赖它。对不使用 AI 粗剪的人，
 * 这是断头路——字幕优化面板提示"选择已配置 Provider"，却无处创建。
 * 本对话框与具体 AI 功能无关，只管理 Provider 本身。
 *
 * 脱敏边界：密钥只提交、不回显；输入框提交后立即清空；错误文案不含密钥内容。
 */
export function ProviderSettingsDialog({
  providers,
  onProvidersChange,
  onClose,
  onNotify,
}: {
  providers: ProviderConfig[];
  onProvidersChange: (next: ProviderConfig[]) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ display_name: "", base_url: "", model: "" });
  const [providerMode, setProviderMode] = useState<"preset" | "custom">("custom");
  const [selectedPreset, setSelectedPreset] = useState("");
  const [view, setView] = useState<"create" | "manage">(providers.length ? "manage" : "create");
  const [selectedId, setSelectedId] = useState<string>(providers[0]?.provider_config_id ?? "");
  const createSecretRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // 开关专用反馈：只进 sr-only live region，不参与内容区布局（见 toggleEnabled）。
  const [toggleNotice, setToggleNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProviderConfig | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [loading, setLoading] = useState(providers.length === 0);
  const secretRef = useRef<HTMLInputElement>(null);
  // 本对话框自持一份权威列表：打开时重新拉取，变更后回写 App（供其它 AI 功能共用）。
  const [items, setItems] = useState<ProviderConfig[]>(providers);

  useEffect(() => {
    let active = true;
    if (providers.length > 0) { setLoading(false); return () => { active = false; }; }
    if (!window.desktop.listProviders) { setLoading(false); return () => { active = false; }; }
    void window.desktop.listProviders().then(page => {
      if (!active) return;
      setItems(page.items);
      if (page.items.length) {
        setSelectedId(page.items[0].provider_config_id);
        setView("manage");
      }
      onProvidersChange(page.items);
    }).catch(() => { if (active) setError("无法加载 Provider 列表。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => items.find(item => item.provider_config_id === selectedId),
    [items, selectedId],
  );
  const canCreate = !busy && draft.display_name.trim() !== "" && draft.base_url.trim() !== "" && draft.model.trim() !== "";

  const publish = (next: ProviderConfig[]) => {
    setItems(next);
    onProvidersChange(next);
  };

  const create = async () => {
    if (!window.desktop.createProvider) { setError("创建 Provider 不可用。"); return; }
    const secret = createSecretRef.current?.value.trim() ?? "";
    if (createSecretRef.current) createSecretRef.current.value = "";
    setBusy(true); setError(""); setStatus(""); setToggleNotice("");
    try {
      const created = await window.desktop.createProvider({
        kind: "openai_compatible_text",
        display_name: draft.display_name.trim(),
        base_url: draft.base_url.trim(),
        model: draft.model.trim(),
        enabled: true,
        input_price_per_million: null,
        output_price_per_million: null,
      });
      publish([...items, created]);
      setSelectedId(created.provider_config_id);
      setDraft({ display_name: "", base_url: "", model: "" });
      setView("manage");
      setSelectedPreset("");
      if (secret) {
        try {
          if (!window.desktop.setProviderSecret) throw new Error("Unavailable");
          await window.desktop.setProviderSecret({ provider_config_id: created.provider_config_id, secret });
          publish([...items, { ...created, credential_status: "configured" }]);
          setStatus(`已创建「${created.display_name}」，密钥已安全保存。`);
        } catch {
          setError("配置已创建，但密钥未能同步。请重新输入并安全保存密钥。");
        }
      } else {
        setStatus(`已创建「${created.display_name}」。下一步：填入密钥并保存。`);
      }
    } catch (caught) {
      setError(safeErrorMessage(caught, "Provider 配置无效。请检查名称、HTTPS/HTTP 地址和模型名。"));
    } finally { setBusy(false); }
  };

  const saveSecret = async () => {
    if (!window.desktop.setProviderSecret) { setError("保存密钥不可用。"); return; }
    if (!selectedId) { setError("请先选择或创建一个 Provider。"); return; }
    const input = secretRef.current;
    const secret = input?.value ?? "";
    if (!secret) { setError("请先输入密钥。"); return; }
    setBusy(true); setError(""); setStatus(""); setToggleNotice("");
    try {
      await window.desktop.setProviderSecret({ provider_config_id: selectedId, secret });
      if (input) input.value = "";
      publish(items.map(item => item.provider_config_id === selectedId ? {
        ...item,
        credential_status: "configured",
        // 换密钥等于换能力前提：探测结论必须失效重测（与 Core 触发器语义一致）。
        candidate_capability_status: "untested",
        candidate_response_adapter_id: null,
        candidate_probe_protocol_version: null,
        candidate_capability_tested_at: null,
        candidate_capability_failure_code: null,
        candidate_capability_probe_sha256: null,
        timeline_patch_capability_status: "untested",
        timeline_patch_response_adapter_id: null,
        timeline_patch_probe_protocol_version: null,
        timeline_patch_capability_tested_at: null,
        timeline_patch_capability_failure_code: null,
        timeline_patch_capability_probe_sha256: null,
        captions_provider_capability_status: "untested",
        captions_provider_response_adapter_id: null,
        captions_provider_probe_protocol_version: null,
        captions_provider_capability_tested_at: null,
        captions_provider_capability_failure_code: null,
        captions_provider_capability_probe_sha256: null,
      } : item));
      setStatus("密钥已安全保存。下一步：在具体 AI 功能中测试兼容性。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "密钥未能同步到本地核心；未显示或记录密钥内容。"));
    } finally { setBusy(false); }
  };

  const deleteSecret = async () => {
    if (!window.desktop.deleteProviderSecret || !selectedId) return;
    setBusy(true); setError(""); setStatus(""); setToggleNotice("");
    try {
      await window.desktop.deleteProviderSecret(selectedId);
      publish(items.map(item => item.provider_config_id === selectedId ? { ...item, credential_status: "missing" } : item));
      setStatus("密钥已从本机安全存储与 Core 内存中删除。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "删除密钥失败；未显示密钥内容。"));
    } finally { setBusy(false); }
  };

  const deleteProvider = async (provider: ProviderConfig) => {
    // P67：废弃 Provider 此前只能删密钥、条目永留下拉。被外发/生成历史
    // 引用时 Core fail-closed（PROVIDER_IN_USE）——此时出路是删除密钥并停用。
    if (!window.desktop.deleteProvider) { setError("删除 Provider 不可用。"); return; }
    setDeleteBusy(true); setError(""); setStatus("");
    try {
      await window.desktop.deleteProvider(provider.provider_config_id);
      const next = items.filter(item => item.provider_config_id !== provider.provider_config_id);
      publish(next);
      setPendingDelete(null);
      if (!next.length) {
        setSelectedId("");
        setView("create");
        setStatus("已删除全部 Provider。可新建一个继续使用 AI 功能。");
      } else {
        setSelectedId(current => (current === provider.provider_config_id ? next[0].provider_config_id : current));
        setStatus(`已删除「${provider.display_name}」。`);
      }
    } catch (caught) {
      const code = errorCode(caught);
      setError(code === "PROVIDER_IN_USE"
        ? "该 Provider 已被外发/生成历史引用，无法删除——外发与费用记录必须可追溯，删除会断开审计链。请改用：① 删除密钥让它无法再被调用；② 关闭下方「在 AI 功能中启用」。两条做完后，它不会再出现在任何 AI 功能中。"
        : code === "PROVIDER_NOT_FOUND"
        ? "该 Provider 已不存在，请刷新列表。"
        : safeErrorMessage(caught, "删除 Provider 失败。"));
      setPendingDelete(null);
    } finally { setDeleteBusy(false); }
  };

  const testConnection = async () => {
    if (!window.desktop.testProvider || !selectedId) return;
    setBusy(true); setError(""); setStatus(""); setToggleNotice("");
    try {
      await window.desktop.testProvider(selectedId);
      setStatus("连接测试通过。仍可在具体 AI 功能中测试兼容性。");
    } catch (caught) {
      const code = errorCode(caught);
      setError(code === "PROVIDER_AUTH_FAILED"
        ? "认证失败。下一步：检查 API 密钥是否正确。"
        : code === "PROVIDER_ENDPOINT_NOT_FOUND"
        ? "接口地址不存在（HTTP 404）。请填写 API 基础地址，例如 https://api.example.com/v1，不要填写完整的 /chat/completions 路径。"
        : code === "PROVIDER_INVALID_REQUEST"
        ? "接口拒绝了测试请求。请检查 API 协议、API 地址和模型 ID。"
        : code === "PROVIDER_CONTENT_REJECTED"
        ? "模型拒绝了测试请求。请确认模型 ID 可用，并检查网关是否兼容 OpenAI Chat Completions。"
        : code === "PROVIDER_NETWORK_ERROR"
        ? "无法连接到 Provider。请检查网络、代理设置和 API 地址。"
        : code === "PROVIDER_TLS_ERROR"
        ? "TLS 连接失败。请检查 API 地址证书和 HTTPS 配置。"
        : code === "PROVIDER_TIMEOUT"
        ? "Provider 响应超时。请检查网络或稍后重试。"
        : "连接测试失败，请检查 Provider、网络和凭据。");
    } finally { setBusy(false); }
  };

  const toggleEnabled = async () => {
    if (!selected) return;
    if (!window.desktop.updateProvider) { setError("停用功能不可用。"); return; }
    setBusy(true); setError(""); setStatus(""); setToggleNotice("");
    try {
      const updated = await window.desktop.updateProvider({ provider_config_id: selected.provider_config_id, patch: { enabled: !selected.enabled } });
      // 必须先更新本地 items，否则 selected 仍取旧值、开关视觉不跟随实际状态
      // （2026-11-06 真机实测：已停用但开关仍显示为开启）。
      const nextItems = items.map(item => item.provider_config_id === updated.provider_config_id ? updated : item);
      setItems(nextItems);
      onProvidersChange(nextItems);
      // 开关反馈不进内容区：提示条插在首位会把整张表单往下推（实测 58px），
      // 反复开关就在 0 / 44px 之间来回跳，整窗上下抖。改为只写常驻的
      // sr-only live region——读屏照常播报，布局零影响。
      setToggleNotice(updated.enabled ? "已启用：该 Provider 会重新出现在 AI 功能中。" : "已停用：该 Provider 不再出现在 AI 功能中，历史记录保留。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "切换启用状态失败。"));
    } finally { setBusy(false); }
  };

  const switchView = (next: "create" | "manage") => {
    if (secretRef.current) secretRef.current.value = "";
    if (createSecretRef.current) createSecretRef.current.value = "";
    setError(""); setStatus(""); setView(next);
  };

  return <Dialog titleId="provider-settings-title" title="Provider 设置" subtitle="管理 AI 模型连接 · 密钥只提交、不回显" closeLabel="关闭 Provider 设置" bodyClassName="ps-body" footer={<>{view === "create" ? <>
        {items.length > 0 && <button className="footer-link" disabled={busy} onClick={() => switchView("manage")}>已有配置</button>}
        <button className="btn ghost" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={!canCreate} onClick={() => void create()}>{busy ? "正在创建…" : "创建 Provider"}</button>
      </> : <>
        <button className="footer-link" disabled={busy} onClick={() => switchView("create")}>＋ 新建 Provider</button>
        <button className="btn ghost" disabled={busy} onClick={onClose}>关闭</button><button className="btn primary" disabled={busy || !selected} onClick={() => void testConnection()}>{busy ? "处理中…" : "连接测试"}</button>
      </>}</>} label="Provider 设置" onClose={onClose} className="provider-settings">
    {pendingDelete && <Dialog titleId="provider-delete-title" title="删除 Provider" footer={<>
        <button disabled={deleteBusy} onClick={() => setPendingDelete(null)}>取消</button>
        <button className="danger" disabled={deleteBusy} onClick={() => void deleteProvider(pendingDelete)}>{deleteBusy ? "删除中…" : "删除 Provider"}</button>
      </>} label="删除 Provider" onClose={() => setPendingDelete(null)} className="asset-delete-modal">
      <p className="confirm-object">确定要删除「<strong>{pendingDelete.display_name}</strong>」吗？</p>
      <div className="warning"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg><span>该 Provider 的配置与本机加密存储中的密钥将一并删除，此操作不可撤销。若其已被外发/生成历史引用，删除会被拒绝——此时请改为删除密钥并停用。</span></div>
    </Dialog>}
      {/* 开关反馈不进入内容区布局：提示条是内容区首个子元素，插入时会把整张
          表单往下推（实测 58px），反复开关就在 0 / 44px 之间来回跳，整窗上下抖。
          关掉的只是"重复提示"——开关自身的开/关态，加上下方那行静态说明
          （"停用后不再出现在…；历史记录保留"）已经把后果说全了。
          这里保留一个常驻 live region：读屏仍能听到状态变化，但它对布局零影响。 */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{toggleNotice}</span>
      {error && <div className="alert alert-danger" role="alert"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg><div><strong>无法完成操作</strong><span>{error}</span></div></div>}
      {status && <div className="alert alert-ok" role="status"><div><span>{status}</span></div></div>}
      {loading && <p className="ps-hint">正在加载…</p>}
      {view === "create" ? <>
        <div className="mode-tabs" role="tablist" aria-label="Provider 类型">
          <button disabled={busy} className={providerMode === "preset" ? "mode-tab active" : "mode-tab"} role="tab" aria-selected={providerMode === "preset"} onClick={() => setProviderMode("preset")}>第三方模型提供商</button>
          <button disabled={busy} className={providerMode === "custom" ? "mode-tab active" : "mode-tab"} role="tab" aria-selected={providerMode === "custom"} onClick={() => setProviderMode("custom")}>自定义模型 API</button>
        </div>
        <p className="privacy-line"><LockKeyhole className="icon" size={13} aria-hidden="true" />{!loading && !items.length ? "尚无 Provider。" : ""}连接兼容 OpenAI 的服务，填写地址、密钥和模型即可。</p>
        <div className="form-grid" aria-label="新建 Provider">
          {providerMode === "preset" && <div className="field span-2"><label>提供商预设</label><select aria-label="提供商预设" disabled={busy} value={selectedPreset} onChange={event => {
            const preset = PROVIDER_PRESETS.find(item => item.id === event.target.value);
            setSelectedPreset(event.target.value);
            if (preset) setDraft({ display_name: preset.name, base_url: preset.base_url, model: preset.model });
          }}><option value="">选择提供商</option>{PROVIDER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></div>}
          <div className="field span-2"><label>显示名称</label><input disabled={busy} aria-label="Provider 名称" value={draft.display_name} onChange={event => setDraft(value => ({ ...value, display_name: event.target.value }))} placeholder="例如：我的网关" /></div>
          <div className="field span-2"><label>API 地址</label><input disabled={busy} aria-label="Provider 地址" value={draft.base_url} onChange={event => setDraft(value => ({ ...value, base_url: event.target.value }))} placeholder="https://api.example.com/v1" /></div>
          <div className="field"><label>API 协议</label><select aria-label="API 协议" disabled value="openai"><option value="openai">OpenAI Chat Completions</option></select></div>
          <div className="field"><label>模型 ID</label><input disabled={busy} aria-label="Provider 模型" value={draft.model} onChange={event => setDraft(value => ({ ...value, model: event.target.value }))} placeholder="例如：gpt-4o-mini" /></div>
          <div className="field span-2"><label>API 密钥 <span className="field-hint">密钥只提交、不回显</span></label><input ref={createSecretRef} aria-label="新建 Provider 密钥" disabled={busy} type="password" autoComplete="off" placeholder="输入 API 密钥（可稍后配置）" /></div>
        </div>
        <p className="provider-note"><LockKeyhole className="icon" size={13} aria-hidden="true" />密钥仅保存在本机；能力兼容性在各 AI 功能中测试。</p>
      </> : <>
        <div className="form-grid" role="group" aria-label="管理已有 Provider">
          <div className="field span-2">
            <label>已有 Provider</label>
            <select aria-label="已有 Provider" disabled={busy} value={selectedId} onChange={event => {
              if (secretRef.current) secretRef.current.value = "";
              setSelectedId(event.target.value); setError(""); setStatus("");
            }}>{items.map(item => <option key={item.provider_config_id} value={item.provider_config_id}>{item.display_name} · {item.model}</option>)}</select>
          </div>
          {selected && <>
            <dl className="detail-panel span-2"><dt>API 地址</dt><dd>{selected.base_url}</dd><dt>模型 ID</dt><dd>{selected.model}</dd><dt>密钥状态</dt><dd>{selected.credential_status === "configured" ? "密钥已配置" : "缺少密钥"}</dd></dl>
            <div className="field span-2 enabled-row">
              <div>
                <label>在 AI 功能中启用</label>
                <span className="field-hint">停用后不再出现在 AI 粗剪、AI 修改等下拉中；历史记录保留。</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={selected.enabled}
                aria-label={selected.enabled ? "停用该 Provider" : "启用该 Provider"}
                className={`switch${selected.enabled ? " on" : ""}`}
                disabled={busy}
                onClick={() => void toggleEnabled()}
              ><span /></button>
            </div>
            <div className="field span-2">
              <label>API 密钥</label>
              <input key={selectedId} ref={secretRef} aria-label="Provider 密钥" type="password" autoComplete="off" disabled={busy} placeholder="仅输入新密钥，留空保留已保存密钥" />
            </div>
            <div className="field span-2 secret-actions">
              <button className="btn" disabled={busy} onClick={() => void saveSecret()}>安全保存密钥</button>
              <button className="btn" disabled={busy || selected.credential_status !== "configured"} onClick={() => void deleteSecret()}>删除密钥</button>
              <button className="btn danger-quiet" disabled={busy || deleteBusy} onClick={() => { setError(""); setStatus(""); setPendingDelete(selected); }}>删除配置</button>
            </div>
          </>}
        </div>
        <p className="provider-note"><LockKeyhole className="icon" size={13} aria-hidden="true" />连接测试不发送项目内容；能力兼容性在各 AI 功能中测试。</p>
      </>}
  </Dialog>;
}

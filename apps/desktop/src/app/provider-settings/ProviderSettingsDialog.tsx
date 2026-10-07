import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderConfig } from "@aivideo/contracts";
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
  const [busy, setBusy] = useState(false);
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
    setBusy(true); setError(""); setStatus("");
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
    setBusy(true); setError(""); setStatus("");
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
    setBusy(true); setError(""); setStatus("");
    try {
      await window.desktop.deleteProviderSecret(selectedId);
      publish(items.map(item => item.provider_config_id === selectedId ? { ...item, credential_status: "missing" } : item));
      setStatus("密钥已从本机安全存储与 Core 内存中删除。");
    } catch (caught) {
      setError(safeErrorMessage(caught, "删除密钥失败；未显示密钥内容。"));
    } finally { setBusy(false); }
  };

  const testConnection = async () => {
    if (!window.desktop.testProvider || !selectedId) return;
    setBusy(true); setError(""); setStatus("");
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

  const switchView = (next: "create" | "manage") => {
    if (secretRef.current) secretRef.current.value = "";
    if (createSecretRef.current) createSecretRef.current.value = "";
    setError(""); setStatus(""); setView(next);
  };

  return <Dialog titleId="provider-settings-title" label="Provider 设置" onClose={onClose} className="provider-settings">
    <div className="modal-heading">
      <div><h2 id="provider-settings-title">Provider 设置</h2><p>管理 AI 模型连接 · 密钥只提交、不回显</p></div>
      <button className="icon-button" aria-label="关闭 Provider 设置" onClick={onClose}>×</button>
    </div>
    <div className="ps-body">
      {error && <p className="ps-feedback ps-error" role="alert">{error}</p>}
      {status && <p className="ps-feedback" role="status">{status}</p>}
      {loading && <p className="ps-hint">正在加载…</p>}
      {view === "create" ? <>
        <div className="provider-mode-tabs" role="tablist" aria-label="Provider 类型">
          <button disabled={busy} className={providerMode === "preset" ? "active" : ""} role="tab" aria-selected={providerMode === "preset"} onClick={() => setProviderMode("preset")}>第三方模型提供商</button>
          <button disabled={busy} className={providerMode === "custom" ? "active" : ""} role="tab" aria-selected={providerMode === "custom"} onClick={() => setProviderMode("custom")}>自定义模型 API</button>
        </div>
        <p className="ps-hint">{!loading && !items.length ? "尚无 Provider。" : ""}连接兼容 OpenAI 的服务，填写地址、密钥和模型即可。</p>
        <div className="ps-form" aria-label="新建 Provider">
          {providerMode === "preset" && <label>提供商预设<select aria-label="提供商预设" disabled={busy} value={selectedPreset} onChange={event => {
            const preset = PROVIDER_PRESETS.find(item => item.id === event.target.value);
            setSelectedPreset(event.target.value);
            if (preset) setDraft({ display_name: preset.name, base_url: preset.base_url, model: preset.model });
          }}><option value="">选择提供商</option>{PROVIDER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>}
          <label>显示名称<input disabled={busy} aria-label="Provider 名称" value={draft.display_name} onChange={event => setDraft(value => ({ ...value, display_name: event.target.value }))} placeholder="例如：我的网关" /></label>
          <label>API 地址<input disabled={busy} aria-label="Provider 地址" value={draft.base_url} onChange={event => setDraft(value => ({ ...value, base_url: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
          <label>API 协议<select aria-label="API 协议" disabled value="openai"><option value="openai">OpenAI Chat Completions</option></select></label>
          <label>API 密钥<input ref={createSecretRef} aria-label="新建 Provider 密钥" disabled={busy} type="password" autoComplete="off" placeholder="输入 API 密钥（可稍后配置）" /></label>
          <label>模型 ID<input disabled={busy} aria-label="Provider 模型" value={draft.model} onChange={event => setDraft(value => ({ ...value, model: event.target.value }))} placeholder="例如：gpt-4o-mini" /></label>
        </div>
        <small className="ps-hint">密钥仅保存在本机；能力兼容性在各 AI 功能中测试。</small>
      </> : <>
        <label>已有 Provider<select aria-label="已有 Provider" disabled={busy} value={selectedId} onChange={event => {
          if (secretRef.current) secretRef.current.value = "";
          setSelectedId(event.target.value); setError(""); setStatus("");
        }}>{items.map(item => <option key={item.provider_config_id} value={item.provider_config_id}>{item.display_name} · {item.model}</option>)}</select></label>
        {selected && <>
          <dl className="ps-details"><dt>API 地址</dt><dd>{selected.base_url}</dd><dt>模型 ID</dt><dd>{selected.model}</dd><dt>密钥状态</dt><dd>{selected.credential_status === "configured" ? "密钥已配置" : "缺少密钥"}</dd></dl>
          <label>API 密钥<input key={selectedId} ref={secretRef} aria-label="Provider 密钥" type="password" autoComplete="off" disabled={busy} placeholder="仅输入新密钥，留空保留已保存密钥" /></label>
          <div className="ps-secret-actions"><button disabled={busy} onClick={() => void saveSecret()}>安全保存密钥</button><button disabled={busy || selected.credential_status !== "configured"} onClick={() => void deleteSecret()}>删除密钥</button></div>
          <small className="ps-hint">连接测试不发送项目内容；能力兼容性在各 AI 功能中测试。</small>
        </>}
      </>}
    </div>
    <div className="modal-actions ps-footer">
      {view === "create" ? <>
        {items.length > 0 && <button className="ps-back" disabled={busy} onClick={() => switchView("manage")}>已有配置</button>}
        <button disabled={busy} onClick={onClose}>取消</button><button disabled={!canCreate} onClick={() => void create()}>{busy ? "正在创建…" : "创建 Provider"}</button>
      </> : <>
        <button className="ps-back" disabled={busy} onClick={() => switchView("create")}>＋ 新建 Provider</button>
        <button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy || !selected} onClick={() => void testConnection()}>{busy ? "处理中…" : "连接测试"}</button>
      </>}
    </div>
  </Dialog>;
}

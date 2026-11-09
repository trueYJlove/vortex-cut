import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@aivideo/contracts";
import { ProviderSettingsDialog } from "../src/app/provider-settings/ProviderSettingsDialog.js";

const now = "2026-08-11T00:00:00.000Z";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider_config_id: "provider_1" as never,
    kind: "openai_compatible_text",
    display_name: "测试 Provider",
    base_url: "https://provider.test",
    model: "model",
    enabled: true,
    credential_status: "missing",
    input_price_per_million: null,
    output_price_per_million: null,
    timeline_patch_capability_status: "untested",
    timeline_patch_response_adapter_id: null,
    timeline_patch_probe_protocol_version: null,
    timeline_patch_capability_tested_at: null,
    timeline_patch_capability_failure_code: null,
    timeline_patch_capability_probe_sha256: null,
    candidate_capability_status: "untested",
    candidate_response_adapter_id: null,
    candidate_probe_protocol_version: null,
    candidate_capability_tested_at: null,
    candidate_capability_failure_code: null,
    candidate_capability_probe_sha256: null,
    captions_provider_capability_status: "untested",
    captions_provider_response_adapter_id: null,
    captions_provider_probe_protocol_version: null,
    captions_provider_capability_tested_at: null,
    captions_provider_capability_failure_code: null,
    captions_provider_capability_probe_sha256: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function setup(items: ProviderConfig[]) {
  const onProvidersChange = vi.fn();
  const onNotify = vi.fn();
  const desktop = {
    listProviders: vi.fn().mockResolvedValue({ items }),
    setProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "configured" }),
    deleteProviderSecret: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", credential_status: "missing" }),
    deleteProvider: vi.fn().mockResolvedValue({ provider_config_id: "provider_1", deleted: true }),
    updateProvider: vi.fn().mockImplementation((input: { patch: { enabled?: boolean } }) =>
      Promise.resolve(provider({ enabled: input.patch.enabled ?? true }))),
    testProvider: vi.fn().mockResolvedValue({ status: "succeeded" }),
    createProvider: vi.fn(),
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  render(<ProviderSettingsDialog providers={items} onProvidersChange={onProvidersChange} onClose={() => undefined} onNotify={onNotify} />);
  return { desktop, onProvidersChange, onNotify };
}

describe("Provider 设置：共用状态与脱敏", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("无 Provider 时给出空态与下一步", async () => {
    setup([]);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    expect(await within(dialog).findByText(/尚无 Provider/)).toBeVisible();
    expect(within(dialog).getByLabelText("Provider 名称")).toBeVisible();
    expect(within(dialog).queryByLabelText("已有 Provider")).not.toBeInTheDocument();
  });

  it("保存密钥后把更新后的列表回报给上层（各 AI 功能共用同一份状态）", async () => {
    // 这是「共用状态」的实际契约：面板必须通过 onProvidersChange 把新状态交回 App，
    // 否则其它 AI 功能仍看到旧的 credential_status=missing。
    const items = [provider()];
    const { desktop, onProvidersChange } = setup(items);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.change(within(dialog).getByLabelText("已有 Provider"), { target: { value: "provider_1" } });
    fireEvent.change(within(dialog).getByLabelText("Provider 密钥"), { target: { value: "SENTINEL" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "安全保存密钥" }));
    await waitFor(() => expect(desktop.setProviderSecret).toHaveBeenCalledWith({ provider_config_id: "provider_1", secret: "SENTINEL" }));
    await waitFor(() => expect(onProvidersChange).toHaveBeenCalled());
    const reported = onProvidersChange.mock.calls.at(-1)![0] as ProviderConfig[];
    expect(reported[0].credential_status).toBe("configured");
    // 换密钥等于换能力前提：三组探测结论都必须失效重测。
    expect(reported[0].candidate_capability_status).toBe("untested");
    expect(reported[0].timeline_patch_capability_status).toBe("untested");
    expect(reported[0].captions_provider_capability_status).toBe("untested");
    // 脱敏：密钥不回显
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it("删除密钥同样回报上层，并清空为 missing", async () => {
    const items = [provider({ credential_status: "configured" })];
    const { desktop, onProvidersChange } = setup(items);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.change(within(dialog).getByLabelText("已有 Provider"), { target: { value: "provider_1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除密钥" }));
    await waitFor(() => expect(desktop.deleteProviderSecret).toHaveBeenCalledWith("provider_1"));
    await waitFor(() => expect(onProvidersChange).toHaveBeenCalled());
    const reported = onProvidersChange.mock.calls.at(-1)![0] as ProviderConfig[];
    expect(reported[0].credential_status).toBe("missing");
  });

  it("未填完整信息时禁止创建，填全后回报新 Provider", async () => {
    const items: ProviderConfig[] = [];
    const created = provider({ provider_config_id: "provider_new" as never, display_name: "我的网关", base_url: "https://gw.test" });
    const { desktop, onProvidersChange } = setup(items);
    desktop.createProvider.mockResolvedValue(created);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    const submit = within(dialog).getByRole("button", { name: "创建 Provider" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Provider 名称"), { target: { value: "我的网关" } });
    expect(submit).toBeDisabled(); // 缺地址/模型仍禁用
    fireEvent.change(within(dialog).getByLabelText("Provider 地址"), { target: { value: "https://gw.test" } });
    fireEvent.change(within(dialog).getByLabelText("Provider 模型"), { target: { value: "m" } });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(desktop.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "openai_compatible_text", display_name: "我的网关", base_url: "https://gw.test", model: "m", enabled: true,
    })));
    // 空列表时面板会先自行拉取并回报一次，故此处只断言最后一次是最新结果。
    await waitFor(() => expect(onProvidersChange).toHaveBeenCalled());
    const reported = onProvidersChange.mock.calls.at(-1)![0] as ProviderConfig[];
    expect(reported).toHaveLength(1);
    expect(reported[0].provider_config_id).toBe("provider_new");
    expect(await within(dialog).findByText(/下一步：填入密钥并保存/)).toBeVisible();
  });

  it("第三方模型提供商不是摆设：选择模板会填充真实地址和模型", () => {
    setup([]);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "第三方模型提供商" }));
    expect(within(dialog).getByRole("combobox", { name: "提供商预设" })).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText("提供商预设"), { target: { value: "deepseek" } });
    expect(within(dialog).getByLabelText("Provider 名称")).toHaveValue("DeepSeek");
    expect(within(dialog).getByLabelText("Provider 地址")).toHaveValue("https://api.deepseek.com/v1");
    expect(within(dialog).getByLabelText("Provider 模型")).toHaveValue("deepseek-chat");
  });

  it("已有配置与新建表单不会堆叠；切换时清空密钥输入", () => {
    setup([provider()]);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    expect(within(dialog).queryByLabelText("Provider 名称")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "删除密钥" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Provider 密钥"), { target: { value: "UNSAVED" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "＋ 新建 Provider" }));
    expect(within(dialog).getByLabelText("Provider 名称")).toBeVisible();
    expect(within(dialog).queryByLabelText("已有 Provider")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "已有配置" }));
    expect(within(dialog).getByLabelText("Provider 密钥")).toHaveValue("");
  });

  it("多个已有配置仍用一个下拉；切换 Provider 不携带上个密钥", () => {
    setup([provider(), provider({ provider_config_id: "provider_2" as never, display_name: "第二个", model: "m2" })]);
    fireEvent.change(screen.getByLabelText("Provider 密钥"), { target: { value: "UNSAVED" } });
    fireEvent.change(screen.getByLabelText("已有 Provider"), { target: { value: "provider_2" } });
    expect(screen.getByLabelText("Provider 密钥")).toHaveValue("");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("m2")).toBeVisible();
  });

  it("创建成功但密钥同步失败时保留配置并提示重试，不重复创建", async () => {
    const { desktop, onProvidersChange } = setup([]);
    desktop.createProvider.mockResolvedValue(provider({ provider_config_id: "provider_new" as never }));
    desktop.setProviderSecret.mockRejectedValue(new Error("SENTINEL"));
    fireEvent.change(screen.getByLabelText("Provider 名称"), { target: { value: "网关" } });
    fireEvent.change(screen.getByLabelText("Provider 地址"), { target: { value: "https://gw.test/v1" } });
    fireEvent.change(screen.getByLabelText("Provider 模型"), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText("新建 Provider 密钥"), { target: { value: "SENTINEL" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("配置已创建，但密钥未能同步");
    expect(desktop.createProvider).toHaveBeenCalledTimes(1);
    expect(onProvidersChange.mock.calls.at(-1)?.[0][0].credential_status).toBe("missing");
    expect(screen.getByLabelText("Provider 密钥")).toHaveValue("");
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it("新建时可一并保存密钥；切换管理后不回显", async () => {
    const { desktop, onProvidersChange } = setup([]);
    desktop.createProvider.mockResolvedValue(provider({ provider_config_id: "provider_new" as never }));
    fireEvent.change(screen.getByLabelText("Provider 名称"), { target: { value: "网关" } });
    fireEvent.change(screen.getByLabelText("Provider 地址"), { target: { value: "https://gw.test/v1" } });
    fireEvent.change(screen.getByLabelText("Provider 模型"), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText("新建 Provider 密钥"), { target: { value: "SENTINEL" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Provider" }));
    await waitFor(() => expect(desktop.setProviderSecret).toHaveBeenCalledWith({ provider_config_id: "provider_new", secret: "SENTINEL" }));
    await waitFor(() => expect(onProvidersChange.mock.calls.at(-1)?.[0][0].credential_status).toBe("configured"));
    expect(screen.getByLabelText("Provider 密钥")).toHaveValue("");
    expect(screen.queryByLabelText("Provider 名称")).not.toBeInTheDocument();
  });
});

describe("Provider 设置：删除配置（P67）", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("删除需经危险确认弹窗；成功后条目从列表消失并回报上层", async () => {
    const items = [
      provider({ provider_config_id: "provider_1" as never, display_name: "废弃网关" }),
      provider({ provider_config_id: "provider_2" as never, display_name: "在用网关" }),
    ];
    const { desktop, onProvidersChange } = setup(items);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除配置" }));
    // 未确认前不得发起删除
    expect(desktop.deleteProvider).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: "删除 Provider" });
    expect(within(confirm).getByText(/此操作不可撤销/)).toBeVisible();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除 Provider" }));
    await waitFor(() => expect(desktop.deleteProvider).toHaveBeenCalledWith("provider_1"));
    const reported = onProvidersChange.mock.calls.at(-1)![0] as ProviderConfig[];
    expect(reported).toHaveLength(1);
    expect(reported[0].provider_config_id).toBe("provider_2");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除 Provider" })).not.toBeInTheDocument());
    expect(within(dialog).queryByText("废弃网关")).not.toBeInTheDocument();
  });

  it("删除被历史引用（PROVIDER_IN_USE）时给出可操作出路，条目保留", async () => {
    const items = [provider({ provider_config_id: "provider_1" as never, display_name: "历史网关" })];
    const { desktop } = setup(items);
    desktop.deleteProvider.mockRejectedValue(new Error("[PROVIDER_IN_USE] Provider 已被外发/生成历史引用"));
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除配置" }));
    const confirm = screen.getByRole("dialog", { name: "删除 Provider" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除 Provider" }));
    await waitFor(() => expect(within(dialog).getByText(/删除密钥.*停用/)).toBeVisible());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除 Provider" })).not.toBeInTheDocument());
    expect(within(dialog).getByText(/历史网关/)).toBeVisible();
  });

  it("删除最后一个 Provider 后回落到新建视图", async () => {
    const items = [provider({ provider_config_id: "provider_1" as never, display_name: "独苗" })];
    const { desktop, onProvidersChange } = setup(items);
    const dialog = screen.getByRole("dialog", { name: "Provider 设置" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除配置" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除 Provider" })).getByRole("button", { name: "删除 Provider" }));
    await waitFor(() => expect(desktop.deleteProvider).toHaveBeenCalledWith("provider_1"));
    const reported = onProvidersChange.mock.calls.at(-1)![0] as ProviderConfig[];
    expect(reported).toHaveLength(0);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "创建 Provider" })).toBeVisible());
  });
});

/**
 * P217 第二批：停用开关。
 * 背景：Core 的 delete() 对被审计表引用的 Provider fail-closed，正确出路是
 * 「删除密钥 + 停用」。此前 UI 没有停用入口，这条出路是断的（用户实测提出）。
 */
describe("Provider 停用开关", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("管理视图渲染启用开关，初始状态取自 enabled", async () => {
    // 有 Provider 时初始即管理视图（ProviderSettingsDialog.tsx:44）。
    setup([provider()]);
    const toggle = await screen.findByRole("switch", { name: "停用该 Provider" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("点击后调用 updateProvider 并回报停用状态", async () => {
    const { desktop, onProvidersChange } = setup([provider()]);
    const toggle = await screen.findByRole("switch", { name: "停用该 Provider" });
    fireEvent.click(toggle);
    await waitFor(() => expect(desktop.updateProvider).toHaveBeenCalledWith({
      provider_config_id: "provider_1",
      patch: { enabled: false },
    }));
    await waitFor(() => expect(onProvidersChange).toHaveBeenCalled());
    expect(await screen.findByText(/已停用：该 Provider 不再出现在 AI 功能中，历史记录保留/)).toBeInTheDocument();
  });

  it("删除被拒时给出可操作的两步指引", async () => {
    const { desktop } = setup([provider()]);
    (desktop.deleteProvider as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("PROVIDER_IN_USE"));
    fireEvent.click(await screen.findByRole("button", { name: "删除配置" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除 Provider" }));
    expect(await screen.findByText(/删除会断开审计链/)).toBeInTheDocument();
    expect(await screen.findByText(/关闭下方「在 AI 功能中启用」/)).toBeInTheDocument();
  });
});

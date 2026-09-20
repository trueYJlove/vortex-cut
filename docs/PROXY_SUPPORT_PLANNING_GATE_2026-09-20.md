# Provider 代理支持（默认系统代理 + 可自定义）——Planning Gate

> 起草：LiuWei，2026-09-20。来源：AI 真实世界验证发现 2
> （`AI_VALIDATION_REPORT_2026-09-20.md`——sidecar `trust_env=False` 直连
> 境外网关超时，中国用户配 provider 后必遇 `PROVIDER_NETWORK_ERROR`）。
> 产品裁决（用户 2026-09-20）：默认走系统代理，允许用户自定义。

## 0. 现状走读结论（2026-09-20 代码级）

- `providers.py` 出网 httpx 全部 `trust_env=False` 且不传 proxy（:577、:740 等）——设计意图是"出网行为完全显式、不依赖环境"（隐私硬承诺 ADR-0003 D4 的出网受控点），但代价是完全无法穿越代理，境外网关直连超时。
- 受影响出口面：文本 provider（candidate/patch/agent/连接测试）、图片 provider（`provider_images.py` 同款 client 模式）、模型下载（`model_registry.py` 用 urllib——`urllib.request` 默认**尊重系统代理**，行为已正确，不动）。
- 系统代理语义（Windows）：注册表 `ProxyEnable/ProxyServer`；Electron Main 的网络栈默认遵循系统代理（Chromium 行为），因此**桌面端 UI 侧网络与 sidecar 侧网络行为不一致**是用户可感知的现状。

## 1. 范围

### 必须实现（Core）

1. **Settings 增 `provider_proxy: str | None`**（CLI 参数 `--provider-proxy`；Electron Main 从设置读取传入）。
2. **代理解析三级回退**：显式设置值 → 系统代理（Windows 读注册表 `ProxyEnable/ProxyServer`；兜底 `http://127.0.0.1:<port>` 形式）→ 无代理。解析结果进程内缓存。
3. **注入点统一**：`OpenAICompatibleTextProvider` 与图片 provider 的 client factory 增加 proxy 透传（`httpx.AsyncClient(proxy=..., trust_env=False)`——`trust_env=False` 保持，杜绝环境变量逃逸，代理只来自显式配置链）。取消传播、超时、严格解析语义零变化。
4. **能力探测与正式调用同链路**（探测通过 = 正式调用可达，代理语义一致）。
5. **e2e/单测**：注入点替身模式沿用现有 client_factory 测试先例；系统代理解析的单测（注册表 mock）；`PROVIDER_NETWORK_ERROR` 路径不回归。

### Desktop

6. 设置 UI：代理模式三选（系统代理（默认）/自定义/直连）+ 自定义地址输入；provider 配置对话框提示"连接测试将使用当前代理设置"。

### 明确不做

- PAC 脚本/认证代理（`http://user:pass@host:port` 的 URL 凭据段 v1 不支持）；
- 分域代理规则（只支持全局单一出口）；
- 模型下载通道改造（urllib 已遵循系统代理）。

## 2. 设计要点

- **trust_env=False 保留**：代理必须来自"显式配置链"（用户设置或系统设置），绝不静默读环境变量——与 egress 受控哲学一致，egress preview 的知情范围不变（代理不改变外发内容，只改变路径）。
- **连接测试即代理测试**：现有 `providers/{id}/test` 端点自动继承代理语义，UI 无需新增诊断端点。
- **系统代理解析失败（注册表不可读）**：静默回退直连 + 日志，不报错（代理是优化不是依赖）。

## 3. 验收

1. 单测：三级回退解析、factory 注入、trust_env 恒 False、错误路径回归。
2. 集成：mock 代理服务器（本地起一个 forward proxy）验证 provider 调用经代理可达；系统代理关闭时直连路径不变。
3. 真实世界：验证 spike 同款脚本（`AIVS_VALIDATION_PROXY` 已验证注入可行性，本单将其转正为产品机制）。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 系统代理指向不可用端口 → 全部 provider 调用失败 | 连接测试前置暴露；错误信息带代理上下文（"经代理 127.0.0.1:10809 连接失败"） |
| 注册表读取抖动 | 解析结果进程内缓存 + 设置变更时失效 |
| 代理引入 TLS 中间人（企业环境） | verify=True 保持；证书错误显式失败不静默 |

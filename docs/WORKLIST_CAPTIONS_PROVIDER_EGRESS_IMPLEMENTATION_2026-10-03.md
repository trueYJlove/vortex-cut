# W4.1 captions Provider egress——Implementation Slice 2

> 当前状态以 [`STATUS.md`](STATUS.md) 为准。本记录覆盖安全的 Core egress prepare/create/get、持久化、IPC 与本地 mock runner 切片，不声明真实 Provider 已交付。

## 已实现

- `build_captions_provider_payload()` 固定 `captions_provider_v1` allowlist，拒绝未知字段、重复/空 segment、非法 bucket、超长文本和非法参数；
- `captions_provider_preview()` 生成脱敏摘要；
- v28–v33 captions Provider egress 持久化：preview payload_json、consent、generation、capability 状态、immutable normalized result 和未应用 proposal；
- Core prepare/create/get API；create 做 payload/hash、Provider snapshot 漂移、capability、基线、原子事务和同 preview 重试保护；
- Main/Preload typed IPC 与严格输入校验；
- 内部 `claim_for_runner()` 原子消费 consent 并将 queued generation 转为 running；
- `run_mock()` 不联网校验 `caption-text-output-v1`，成功/失败关闭 generation，并只保存规范化结果/hash；不创建 Timeline Revision；
- `build_captions_provider_patch()` 只把已验证文本映射到 Core 已有 transcript caption ID，Provider 不得创建时间码、ID 或任意 patch 字段；
- `create_proposal()` 持久化 patch、base/proposed document hash 和完整 proposed document，但不执行 Apply、不创建 Revision；
- Core 提供 proposal 只读 API 和显式 Apply API，contracts/Main/Preload typed IPC 返回脱敏 patch/hash；v33 application record 保证基线、hash、一次性 Apply；Worklist 显式分派 `captions_provider`，不再误走 editing grammar；Worklist 项目切换会清理 current/items/error/busy/input，并丢弃迟到 proposal 响应；Worklist 回归 5 passed，Core proposal/Worklist 回归 20 passed，Desktop IPC/preload/Worklist 回归 20 passed，typecheck 通过。

## 验证

```text
Core migration + Provider + STATUS tests: 76 passed
Desktop IPC + preload tests: 14 passed
Contracts/Desktop typecheck: passed
Core compileall: passed
git diff --check: passed
```

## 未实现与边界

- 真实 Provider worker 和网络调用；Core capability probe route 已准备，但执行需要 Provider 凭据；
- Desktop 完整 Diff UI 和显式 consent UX；
- 真实 Provider/代理两步验证。

当前 mock runner 仅用于本地 schema/状态机验证，不构成 Provider captions 能力交付声明。

## 安全结论

queued generation 可由内部 claim 边界消费；没有 worker 时不会自动运行。mock runner 不访问网络、不使用 API key、不创建 Revision。真实 worker 必须另行通过 Design/Verification Gate。

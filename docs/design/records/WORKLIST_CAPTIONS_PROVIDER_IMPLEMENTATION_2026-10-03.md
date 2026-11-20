# W4.1 captions Provider 文本生成——Implementation Slice 1

> 本记录只声明 Slice 1 的固定 schema 与 Core fail-closed validator 已实现；Provider egress、Worklist planner 接线、Desktop consent 和真实 Provider 验收仍未完成。当前状态以 [`../../STATUS.md`](../../STATUS.md) 为准。

## 1. 实现范围

- `CAPTIONS_PROVIDER_SCHEMA` 注册为 `caption-text-output-v1`；
- `validate_captions_provider_value()` 校验：closed fields、输入 segment 集合、覆盖且不重复、字幕字符上限、warnings、confidence；
- Provider 输出不接受时间码或 TimelinePatch，时间范围继续由 Core 重建；
- 未新增迁移、协议版本或 AI 白名单操作；
- 未新增网络旁路，既有 `StructuredTextRequest` 仍是后续接线入口。

## 2. Acceptance cross-check

| 设计条目 | 结果 | 证据 |
|---|---|---|
| 固定输出 schema | ✅ | `services/core/src/aivs_core/providers.py` |
| 未知 segment 拒绝 | ✅ | `test_captions_provider_rejects_unknown_refs_duplicate_refs_and_uncovered_segments` |
| 重复/缺失 segment 拒绝 | ✅ | 同上 |
| 超长文本与非法 confidence 拒绝 | ✅ | `test_captions_provider_rejects_prompt_like_oversized_text_and_invalid_confidence` |
| Provider 不能提交时间码/patch | ✅ | schema 无此字段；validator closed-field 检查 |
| 零网络旁路 | ✅ | 本切片只增加纯函数和 schema |
| Worklist planner/API/IPC 接线 | ⏳ | 下一实现切片 |
| Desktop consent/Diff | ⏳ | 下一实现切片 |
| 真实 Provider/代理 | ⏳ | 独立 Verification Gate |

## 3. Verification

```text
uv run --locked pytest services/core/tests/unit/test_stage2a_providers.py services/core/tests/unit/test_status_doc_consistency.py
71 passed
```

## 4. 状态结论

Slice 1 通过自动化验收，可进入下一 Implementation Slice；不构成 Provider captions 能力交付声明。

## 5. 当前阻塞与下一步

Desktop consent/Diff 和 Worklist planner 不能在本 Slice 安全提前接入：当前仓库尚未冻结 Provider egress prepare/create 的实际 Core API、持久化语义和真实 provider capability 证据。继续接线会产生未审计的网络入口，因此暂缓，待下一门补齐 egress API/IPC 设计后实施。

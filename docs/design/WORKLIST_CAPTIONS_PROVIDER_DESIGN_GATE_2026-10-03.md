# W4.1 captions Provider 文本生成——Design Gate

> 当前状态以 [`../STATUS.md`](../STATUS.md) 为准。本门只覆盖 Provider 生成/改写字幕文本，不改变本地 transcript 装配 step。

## 1. 冻结范围

首个切片命名为 `captions_provider_v1`。输入来自当前 project 的显式 transcript segment 选择；Provider 只能返回按 segment 引用的字幕文本，不得返回时间码、路径、asset ID、TimelinePatch 或其他项目数据。

Core 根据输入 segment 的原始时间范围自行生成确定性 `update_caption`/装配 proposal；Provider 输出不直接进入 Revision。用户必须通过 egress preview、显式 Create、Diff 和 Apply 才能产生 Revision。

## 2. Payload

```json
{
  "schema_version": 1,
  "recipe_id": "captions_provider_v1",
  "language": "zh-CN",
  "preset_id": "default-bottom",
  "max_chars_per_caption": 24,
  "segments": [
    {"segment_id": "seg_1", "ordinal": 0, "text": "脱敏后的转录文本", "duration_bucket": "short"}
  ]
}
```

只允许上述字段。`segments` 必须来自当前 project，顺序稳定、非空、无重复；payload 不保存 secret、路径或完整 Timeline。

## 3. Provider output schema

`caption-text-output-v1`：

```json
{
  "items": [
    {"segment_refs": ["seg_1"], "text": "生成后的字幕", "confidence": null}
  ],
  "warnings": []
}
```

约束：items 至少一个；segment_refs 只能引用输入集合，不能重复覆盖；text 非空且不超过 `max_chars_per_caption`；confidence 为 null 或 0..1；禁止额外字段。Core fail-closed，不接受 Provider 传入时间码。

## 4. Egress 与隐私

- 复用既有 `StructuredTextRequest`、Provider capability 探测、代理设置和 egress preview 表；不新增网络旁路。
- preview 只返回 provider display/model、sent_fields、payload hash、估算 token、segment/caption 数量和过期时间。
- 不返回 raw request/response、API key、完整 transcript 或路径。
- Provider 未配置、未 consent、能力探测失败、代理不可达时，不创建 job、不写 proposal。

## 5. Error contract

固定错误码：`CAPTIONS_PROVIDER_PARAMS_INVALID`、`CAPTIONS_PROVIDER_SEGMENTS_INVALID`、`CAPTIONS_PROVIDER_OUTPUT_INVALID`、`CAPTIONS_PROVIDER_CONSENT_REQUIRED`、`CAPTIONS_PROVIDER_BASE_DRIFT`。错误不改变 Worklist 状态，不创建 Revision。

## 6. Implementation slices

1. Core schema/纯校验函数和 provider adapter，网络调用使用现有 provider 抽象；
2. Worklist planner registry：`captions_provider` 只在明确 provider egress 已 Create 后运行；
3. egress preview/Create/API/IPC typed DTO；
4. Desktop consent、Diff、Apply 和脱敏错误展示；
5. 自动化：schema、prompt injection 数据、跨项目、取消、超限、重复 apply、基线漂移、零 raw response 落盘；
6. 独立 Reviewer 复核后再做真实 Provider/代理两步验收。

## 7. Gate 判定

- Planning Gate：通过，范围和风险已登记；
- Design Gate：本文件冻结契约，可进入 Implementation Slice 1；
- Implementation Gate：未开始；
- Verification/Release Gate：未开始。

## 8. Acceptance cross-check

| 条目 | 结果 |
|---|---|
| Provider 不返回时间码/patch | ✅ 冻结 |
| 只发送显式 segment | ✅ 冻结 |
| egress/consent/代理复用 | ✅ 冻结 |
| AI 白名单不扩大 | ✅ 冻结 |
| Core fail-closed 校验 | ✅ 冻结 |
| Desktop 脱敏 | ⏳ Implementation Slice 1 后验证 |
| 真实 Provider/代理 | ⏳ 独立验收阶段 |

## 9. 承诺

本门对应 `STATUS.md` §4 的 P38。实现前不得宣称 Provider captions 已交付；实现完成也必须保留真实 Provider/代理证据缺口的独立记录。

## 10. 变更记录

- 2026-10-03：首次冻结。

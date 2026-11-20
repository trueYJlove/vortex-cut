# W4.1 本地 transcript captions step——Design Gate

> 本设计只覆盖“从已有本地转录片段装配字幕”，不生成或改写字幕文本；当前状态仍以 [`../STATUS.md`](../STATUS.md) 为准。
> 前置决策：[`WORKLIST_ORCHESTRATION_CAPTIONS_DECISION_2026-10-02.md`](records/WORKLIST_ORCHESTRATION_CAPTIONS_DECISION_2026-10-02.md)。

## 1. 范围

`captions` Worklist step 接收已有 transcript 的 segment IDs，生成一个 TimelinePatch proposal。用户显式 Apply 后才创建 Revision。

请求参数：

```json
{
  "transcript_id": "transcript_1",
  "segment_ids": ["segment_1", "segment_2"],
  "at_index": 0,
  "preset_id": "default-bottom"
}
```

不接受自由文本、不调用 Provider、不读取其他项目数据、不发送网络请求。

## 2. 复用边界

- 复用 `TimelineService` 的 `insert_transcript_segments` 语义和 `_transcript_clips` 校验；
- 复用 Worklist 的 proposal → waiting_for_apply → apply → Revision 状态机；
- 不把 `add_caption` / `import_captions` 加入 AI 白名单；
- 不创建新的数据库表或迁移；参数继续存储在 `worklist_steps.params_json`；
- 不进入 `agent_session`、Provider 或 job runner。

## 3. 安全和正确性约束

Core 在创建 proposal 前必须验证：

1. Worklist 项目存在且当前 Revision 等于 step base Revision；
2. transcript 属于当前 project 的 asset；
3. 所有 segment 属于该 transcript；
4. `segment_ids` 非空、无重复、顺序稳定；
5. `at_index` 为非负整数且不超过当前 clips 数量；
6. preset 属于 `CAPTION_PRESETS`；
7. 当前素材/转录状态允许使用 segment；
8. proposal 只含确定性 `insert_transcript_segments` patch；
9. 全程不产生网络调用。

任一校验失败返回明确 `WORKLIST_CAPTIONS_*` 错误，并且不改变 Worklist 状态、不创建 Revision、不写 proposal。

## 4. 状态和项目隔离

- `captions` step 与 `editing_grammar` step 一样进入 `waiting_for_apply`；
- Apply 后如果还有 pending step，继续下一步；否则 Worklist 成功；
- A 项目 transcript/segment 不能被 B 项目 Worklist 引用；
- Worklist 项目切换只影响 Desktop 展示，迟到响应不能写入新项目状态。

## 5. 验收标准

- valid transcript + segments 生成可读 proposal，patch 使用 `insert_transcript_segments`；
- 空 segment、重复 segment、非法 at_index、非法 preset 被拒绝；
- transcript/segment 跨项目引用被拒绝；
- captions step 可以和 editing_grammar step 串联；
- apply 只生成一个 Revision，重复 apply 被拒绝；
- 基线漂移拒绝 apply；
- monkeypatch 网络出口为零；
- 数据库重开后 waiting proposal 状态保持；
- 既有编辑语法、TimelinePatch、Agent、预览测试不回归。

## 6. Implementation Gate 切片

1. `WorklistService._start_next_step()` 分派 `editing_grammar` / `captions`；
2. 新增 `_prepare_captions_proposal()`，在 Core 内构造 patch 并保存到现有 editing grammar proposal 表，或抽出共享 proposal store；
3. 保持 apply 使用统一 proposal ID/hash 语义；
4. 增加 Core 单测矩阵；
5. Desktop 面板增加 captions step 选择/参数入口；
6. 更新 Worklist acceptance cross-check。

如果发现复用 `editing_grammar_proposals` 会造成语义污染，应在实现前改为独立 proposal 类型，不得通过类型欺骗绕过数据契约。

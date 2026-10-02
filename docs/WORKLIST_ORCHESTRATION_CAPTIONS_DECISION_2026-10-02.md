# W4.1 captions step 决策记录

> 当前状态以 [`STATUS.md`](STATUS.md) 为准。本记录说明为什么 captions 尚未进入当前 Worklist 实现切片。

## 结论

当前不直接实现 `captions` Worklist step，保持 `WORKLIST_STEP_UNAVAILABLE` 的明确拒绝语义。

原因不是缺少字幕数据结构，而是现有架构对“字幕文本创作”和“确定性字幕装配”有明确边界：

- `TimelinePatch` 的 `add_caption` / `import_captions` 不在 `AI_PATCH_OPERATIONS` 白名单中；
- 现有 Timeline 注释明确将字幕文本创作视为人工输入域；
- 已有字幕能力主要来自用户导入或 `insert_transcript_segments` 的转录选段链路；
- Worklist 当前只保证 `editing_grammar` 通过已验收的本地 proposal/apply 链路执行。

如果直接把 captions 接入 Worklist，必须先明确它属于哪一种语义：

1. **本地确定性装配**：从已有 transcript segment IDs 生成字幕，不生成/改写文本；建议复用 `insert_transcript_segments(create_captions=true)`，并新增专用 `WorklistCaptionsAdapter`，不扩大 AI 白名单；
2. **Provider 文本生成**：允许模型生成/改写字幕文本，需要新的 egress preview、provider payload、consent、白名单裁决和隐私验收；不能伪装成本地 step；
3. **用户已有字幕样式编排**：只修改既有 caption 的 preset/style/timing，可复用当前 AI 白名单，但需要明确 step 参数和 proposal 语义。

## 下一步建议

优先做方案 1 的独立 Design Gate：

- 输入只接受已存在的 `transcript_id`、`segment_ids`、`at_index` 和 preset；
- Core 校验 transcript 属于当前项目、segment 不重复且顺序有效；
- 输出仍为 Worklist step proposal，采纳才创建 Revision；
- 不发送网络、不引入 provider、不扩大 `AI_PATCH_OPERATIONS`；
- 增加跨项目 transcript 越权、空 segment、重复 apply、基线漂移和预览一致性测试。

方案 2 暂缓到真实 Provider/egress 验收条件具备后再立项。

# 性能证据

这里保留可读的测量说明、运行配置、夹具清单和关键复测证据。项目状态与采纳结论以 `docs/STATUS.md` 和对应性能验收记录为准。

## Git 管理规则

- Git 仅保留 Markdown 报告、`run-config.json`、manifest 与小型摘要 JSON（`< 200 KB`）。
- 原始逐轮输出（`results-F*.json`、`run-*/result.json`、`app-drop-*.json`、`app-multiclip-*.json`）、`.log`、`.jsonl` trace 及媒体/缓存目录均由 [`.gitignore`](../../.gitignore) 排除，不纳入源码仓库。
- 复跑入口见 [`tools/performance/README.md`](../../tools/performance/README.md)；每份运行配置记录参数和环境，报告保存采用的汇总值。

## 原始数据与摘要

需要复核或逐帧追溯时，按保留的配置在本地重新运行基准脚本即可，源码仓库只保存汇总结论与基线配置。

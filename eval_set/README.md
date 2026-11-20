# 质量评测集（W0.4）

对应 `docs/requirements/QUALITY_EVAL_PLANNING_GATE_2026-09-24.md`（开放问题裁决见其 §5）。

## 布局

- `manifest.json`：素材清单与分档最小样本量
- `schema/annotation.schema.json`：标注 JSON Schema（`schema_version` 变更须向后兼容）
- `annotations/<asset_id>.json`：一文件一素材
- `predictions/<asset_id>/<task>.json`：被测系统输出（见下）
- 媒体：可合成者入 `test-assets/generated/`；真实素材走仓外路径（manifest `media` 指到 pointer 或相对仓根路径）。fingerprint 以内容摘要为准。

## 任务与预测文件

| 任务 | 预测文件 | 标注字段 |
|---|---|---|
| 切点检测 | `predictions/<id>/scene_cut.json` → `{"task":"scene_cut","density_status":"full\|sparse","cuts_us":[...]}` | `scene_cuts_us` |
| 召回排序 | `predictions/<id>/recall.json` → `{"task":"recall_rank","queries":[{"query_id","ranking":[...]}]}` | `recall.queries[].relevance` |

其余任务（卡点 / L/J / 多机位 / 叙事 / 结构可用）在标注 schema 已占位，能力未就绪时报告为 `unavailable`。

## 跑评测

```bash
"$MIMO_PYTHON" tools/quality_eval/run_quality_eval.py
"$MIMO_PYTHON" tools/quality_eval/run_quality_eval.py --selfcheck
"$MIMO_PYTHON" tools/quality_eval/compare_baselines.py <旧快照> <新快照>
```

快照写入 `evidence/quality_eval/`。**分档样本不足时输出 `insufficient`，禁止假分。**

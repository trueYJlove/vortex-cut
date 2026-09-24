# W1.3 卡点规划器（E4）—— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接总纲 W1.3；依赖 W1.1 + W1.2（均已合入）。
> 实施：ZhangSan（Core）；验收：LiuKeAi。

## 0. 现状走读结论

1. W1.1 `editing_grammar` 三段式就绪；W1.2 `beat_grids` / `BeatGridService` 就绪。
2. 镜头权重特征已有先例：`planning._cv_scenes` 的 `face / motion / sharpness`
   （排序：人脸 > 运动 > 清晰度）。卡点「重镜头」沿用同一序，权重数值本单冻结。
3. 产品前置「BGM + 目标时长」：**不改 LLM prepare 契约**——走语法层 `params`
   （`bgm_asset_id` / `target_duration_us`），对齐 P-A 零 egress。
4. 采纳链已支持 mint 新 id 的插入序列（v25 `proposed_document_json`）。

## 1. 范围

### 1.1 必须实现

1. **规划器 `beat_sync`**：
   - 输入：`segments[]`（asset 源区间 + face/motion/sharpness）、
     `beats_us` / `downbeats_us`（signals 或 params）、
     `target_duration_us`、`beats_per_shot`（N，默认 2）、`bgm_asset_id`；
   - 镜头时长 = **相邻 beat 跨度 × N**（有网格则用真实 beat 差，否则 period×N）；
   - **切点吸附 beat**：每镜头起点落在 beat 上；
   - **强拍（downbeat）放重镜头**：score = 3·face + 2·motion + 1·sharpness（冻结），
     降序分配到 downbeat 槽，其余按序填弱拍槽；
   - 输出 TimelinePatch（insert 序列）+ rationale（槽位/beat/权重/分配）。
2. **合成 fixture 验收**：切点 100% 落在 beat 容差内；强拍/弱拍分配可断言。
3. 确定性 + 零 egress（继承 W1.1）。

### 1.2 明确不做

- 不改 `timeline-patch-generations/prepare`（LLM 路径）契约。
- 不做 BGM 轨自动插入（调用方负责已铺 BGM / 只借网格）。
- 不做真实素材 e2e（W0.4 样本缺口；验收写明合成门）。
- 不做 W1.4 `split_edit`。

## 2. 设计要点

### 2.1 槽位与分配（冻结）

```
slot_j 占 beats[b_j : b_j+N]，timeline 时长 = beats[min(b_j+N, end)]-beats[b_j]
b_j = j * N
强拍槽 := downbeat ∈ slot 起点 beat
score(segments) = 3*min(face,3) + 2*min(motion,1) + 1*min(sharpness,1)
```

- 段数 > 槽数：截断并记入 rationale；
- 段数 < 槽数：循环复用源区间（同素材多段），标记 `reused`。

### 2.2 操作序列

按槽位时间序 `insert_asset_clip`（源区间按需裁短至镜头时长；`at_index` 递增）。
新 id 由 v25 拟议文档承载。

## 3. 验收

1. 合成 beats：全部镜头 `timeline_start/end` 与 beat 对齐（容差 1ms）；
2. 重段落在 downbeat 槽；
3. 段少于槽时复用且 rationale 标明；
4. 确定性；noop（无段或无 beat）语义明确；
5. Core 全量不红。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 真实 BPM 相位不齐 | 切点容差断言；相位取首 beat |
| 源区间短于镜头时长 | 自动截短 / 循环复用，rationale 记录 |
| 与 remove_pauses 策略不一致 | 统一 insert 拼装 + v25 文档 |

## 5. 裁决（实施前）

1. 权重 **3/2/1** 对齐 face > motion > sharpness 序，数值冻结进 rationale。
2. BGM 不自动入轨——**params 只带 `bgm_asset_id` 作 provenance**。
3. `beats_per_shot` 默认 **2**。

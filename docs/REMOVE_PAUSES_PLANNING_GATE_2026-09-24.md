# W1.5 跳切 / 去停顿 —— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接总纲 W1.5（E2）；依赖 W1.1（已完成）。
> 实施：ZhangSan（Core）；验收：LiuKeAi。分支建议：`ai/w15-remove-pauses`。

## 0. 现状走读结论

1. **W1.1 骨架已就绪**：`editing_grammar` 纯函数规划器 + 三段式零 egress 采纳链。
2. **静音信号**：`cv_samples.audio_energy`（astats 窗口 RMS，无音轨恒 0）；
   `CvSignalService.samples_for_range` 可查。**无独立静音表**——由能量阈值在线判定。
3. **原语足够**：`split_clip`（源时间拆分）+ `remove_clip` + `position_clip`
   （闭合空隙）可表达跳切；W0.3 链接组保证 A1 跟画面联动（若存在）。
4. **转录词级时间戳**可用于口癖，但总纲写明「需裁决是否纳入 v1」——见 §5。

## 1. 范围

### 1.1 必须实现

1. **静音区间检测**（纯函数）：`audio_energy ≤ threshold` 且持续 ≥ `min_silence_us`
   的区间；两端各让出 `pad_us`（不足则吞并，**不产生 < `MIN_VIDEO_US` 碎片**）。
2. **规划器 `remove_pauses`**（注册进 W1.1 目录）：
   - 输入：`clip_id`（video）、`min_silence_us`、`energy_threshold`、`pad_us`；
   - 信号：服务端注入该片段源范围内的 `samples[{timestamp_us, audio_energy}]`
     或显式 `silence_intervals_us`（测试/无 CV 时）；
   - 输出：在静音边界 `split_clip` → `remove_clip` 静音段 → `position_clip`
     使保留段**同素材连续拼接**（消除空隙）；
   - rationale：逐静音区间（起止、能量证据、是否因 pad/min 长度跳过）。
3. **合成 fixture 验收**：已知静音区间 → 保留区间精确、无过短碎片。
4. **零 egress / 确定性**：继承 W1.1 门禁测试形态。

### 1.2 明确不做

- **去口癖 v1 不做**（§5 裁决）。
- 不做 beat 卡点（W1.3）、不做 L/J（W1.4）。
- 不改 CV 采样算法；不新增迁移。
- 不做 Desktop UI。

## 2. 设计要点

### 2.1 静音判定（冻结口径）

```
silence_run := 连续 samples 满足 audio_energy ≤ threshold
区间 [first_sample.ts, next_non_silence.ts)  —— 右开用下一有声样本时刻
时长 < min_silence_us → 忽略
有效区间两端各收缩 pad_us；收缩后 < MIN_VIDEO_US 的**保留段**与相邻保留段合并
```

**无音轨 / 全零能量**：整段视为静音 → **拒绝规划**（避免把无声视频剪没），
返回 `EDITING_GRAMMAR_NO_SPEECH`。

### 2.2 跳切操作序列（确定性）

1. 收集保留区间（补集 + pad + 最短段合并）；
2. 若保留区间 == [整段] → noop；
3. 在全部内部切点 `split_clip`（从右往左拆，避免 id 失效——**按源时间降序**）；
4. `remove_clip` 全部静音段（`clip_id` 字典序）；
5. `position_clip` 保留段按原相对内容顺序**首尾相接**（起点 = 原 timeline_start）。

### 2.3 与链接组

拆分出的片段若带 `link_group_id`，W0.3 会剥单成员组；A1 对应音频由联动 trim/remove
处理。v1 只操作指定 `clip_id`（视频）；音频侧依赖链接联动，**不单独规划 A1**。

## 3. 验收（LiuKeAi）

1. 合成 samples：两段静音 → 保留 3 段内容精确、静音 2 段被删、时间轴闭合；
2. 过短静音（< min_silence_us）不切；
3. pad 后碎片 < MIN_VIDEO_US 与邻段合并；
4. 全零能量 → 拒绝；无静音 → noop；
5. 确定性 + 零 egress（同 W1.1）；
6. 产物无 < MIN_VIDEO_US 视频片段；
7. Core 全量不红。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 采样密度粗导致切点抖动 | 阈值/min 时长/pad 全入 rationale；确定性测钉死 |
| 误剪呼吸/轻声 | threshold 可配；默认偏保守（0.05） |
| 无音轨被剪光 | §2.1 显式拒绝 |
| 拆分产生碎片 | §2.1 合并规则 + 验收 6 |

## 5. 开放问题（已裁决 2026-09-24，LiuWei 代决）

1. **去口癖是否进 v1 → 不进**。转录口癖标记属语义编辑，与确定性静音跳切混装会
   扩大误操作面；独立小单待 W0.4 样本补足后再议。
2. 操作是否联动 A1 → **依赖 W0.3 链接组默认联动**；本单不生成 A1 专用 op。
3. 默认 `energy_threshold` → **0.05**（astats RMS 归一后经验值），可配且入快照/rationale。

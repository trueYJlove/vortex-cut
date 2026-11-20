# W1.4 L-cut / J-cut（E3）—— Planning Gate

> 起草：LiuWei（架构师），2026-09-24。承接总纲 W1.4；ADR-0004 **D7**（`split_edit` 进 AI 白名单）
> 与 D1/D8（W0.3 链接）。实施：ZhangSan（Core）；验收：LiuKeAi。

## 0. 现状走读结论

1. **无 `split_edit`**。`split_clip` 只在**同一源时间**切画面；声画无法错位。
2. ASR 词级时间戳已落 `transcript_words(start_us,end_us,text)`，可作 J/L 偏移依据。
3. 双声风险：V1 内嵌 `audio.enabled` + A1 并存必炸——W0.3 `detach_audio` 已示范
   「派生 A1 + 关掉 V1 音频」。
4. DEC-7 已裁决 `split_edit` **准入 AI 白名单**（三处同步）。

## 1. 范围

### 1.1 必须实现

1. **语义 op `split_edit`**（原子）：
   ```
   {op, clip_id, source_time_us, audio_delta_us}
   ```
   - 画面切点 `source_time_us`；
   - 音频切点 = `source_time_us + audio_delta_us`（**约定冻结**）；
   - **J-cut**：`audio_delta_us < 0`（下段声先入）；
   - **L-cut**：`audio_delta_us > 0`（上段声延后）。
2. **实现语义**：
   - 画面在 `source_time` 拆成 L/R；
   - 若内嵌音频：派生 A1 上 L/R 音频段（音频切点拆），**两段视频 `audio.enabled=false`**；
   - 若已有链接 A1：对 A1 同步 `split_edit` 偏移（或拆 A1）；
   - 边界：音频切点必须在源区间内；不得产生 < `MIN_VIDEO_US` 的**画面**段。
3. **三处同步准入**（DEC-7）：`AI_PATCH_OPERATIONS` + `TIMELINE_PATCH_OPERATIONS_SCHEMA`
   + `_PATCH_FIELDS`；契约 `TimelinePatchOperation` 增 split_edit。
4. **规划器 `lj_cut`**：对给定切点 + ASR 词表，输出 `split_edit` 序列：
   - J：下一句首词提前 300–500ms（默认 400ms）；
   - L：上一句末词延后同窗口；
   - rationale 记录词戳与选用方向。
5. **单测**：偏移方向、边界拒、双声（V1 静音 + A1 有声）、不越素材时长。

### 1.2 明确不做

- 渲染级 A1 双声 e2e（需真实口播 + 导出链路）——**登记为剩余**（总纲验收原文要求，
  本单以单元语义断言覆盖「结构上不可能双声」）。
- 不做多切点复杂转场；不做口癖。

## 2. 设计要点

### 2.1 `split_edit` 字段（冻结）

| 字段 | 含义 |
|---|---|
| `clip_id` | 目标 video clip |
| `source_time_us` | 画面切点（源时间，严格内部） |
| `audio_delta_us` | 有符号；音频切点 = 画面切点 + delta；允许 0（退化为 split） |

### 2.2 产出结构

```
V1:  L_picture [src0, T)  |  R_picture [T, src1)
A1:  L_audio   [src0, T+Δ) |  R_audio  [T+Δ, src1)   # 内嵌音频时派生
V1 两段 audio.enabled = false
```

### 2.3 `lj_cut` 规则

- 输入：`clip_id`、`mode: j|l`、`words:[{start_us,end_us}]` 或 `segments` 词表、
  `offset_us`（默认 400_000，限制 300_000–500_000）；
- J：找切点后首词 `w`，`audio_delta = -(w.start - cut)` 钳到 300–500ms；
- L：找切点前末词 `w`，`audio_delta = +(w.end 延后)` 同窗；
- 无词表 → 拒绝（`EDITING_GRAMMAR_NO_WORDS`）。

## 3. 验收

1. `split_edit` 三处同步测试绿（既有 `test_provider_operations_consistency`）；
2. 偏移方向：J 负 / L 正；
3. 边界：delta 使音频切点越源 → 拒；
4. 画面段 < MIN_VIDEO_US → 拒；
5. 双声：两段 V1 `audio.enabled=false` 且 A1 两段 enabled；
6. lj_cut 规划器合成词表 → delta 在 300–500ms；
7. 确定性；Core 单测/集成不红。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 双声 | 强制 V1 静音 + 单测 |
| AI 误用 split_edit | DEC-7 已准入；沙盒用例覆盖 |
| 词戳缺失 | 拒绝而非猜偏移 |

## 5. 裁决

1. `audio_delta_us` **有符号**、音频切点 = 画面 + delta（本门冻结）。
2. 默认偏移窗 **300–500ms**，默认 **400ms**。
3. 渲染双声 e2e 留独立小单（本单结构断言）。

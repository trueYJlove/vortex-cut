# 诊断单:4K60 decode 计数缺口(F05 seek 相位 decode 160–166 对预期 200+)

> 立单:2026-09-17(ZhangSan 诊断)。承接 `PRODUCT_DEFECTS_FIX_PLAN_2026-09-15.md` §5
> 预登记:"4K60 decode 慢/超时根因(SEEK 缺陷的深层):W1 后 F05 数据把真实失败显形,
> 届时按数据另立诊断单"。触发条件已满足(09-16 W1/W2 复跑 `defect-verify-f05-20260915-v2`
> 五轮全过,decode 计数与预期的差距已显形),本单即为该诊断单。
> 性质:诊断(数据归因 + 代码走读,无新代码)。

## 1. 现象与登记口径

- G0 基线(`g0-baseline-20260911-v2`)与 W1/W2 复跑(`defect-verify-f05-20260915-v2`)
  的 F05 on 轮同形态:**seek 事件 86–97/100、decode 160–166、upload 94–106**,
  而登记预期"正常场景 decode≈seek≈200+"。
- 原始缺陷(DEFECT-4K60-SEEK)的"事件不齐/静默失败"经 W1 修复(错误落定写
  lastError 不上抛)与 W2(装配看门狗)后:复跑五轮全过、无 unhandled rejection、
  无挂起。本单回答:**剩余的计数缺口是残余故障还是设计语义。**

## 2. 数据归因(v2 复跑 run-0 逐事件分析,六轮同构)

| 观测 | 数值 | 解释 |
|---|---|---|
| seek 事件 | 86–97(非 100) | 部分 seek 被后续 seek 取代(latest-wins),不落事件 |
| epoch 上限 | 189–191 | **每 harness seek 产生 2 次 seekToFrame**(主 seek + 250ms 后 refineAfterDrag 再 seek 同帧),100 seek ≈ 200 epoch ✓ |
| 完全静默 epoch | 33–41 | 被更新的 seek 取代(epoch 失配提前 return -1,preview-session.ts:1424/:1428——**既不记 seek 也不触发 decode,语义正确**) |
| decode 事件 | 160–166 | = 实际发生的解码次数;**目标帧已在环内的 seek 跳过 decode**(App.tsx:1407 ready 检查),相邻落点近时零解码直接 compose |
| decode 时长 | p50 115ms / max 668ms | 远小于 15s 超时——**本环境无一次 decode 超时或失败** |
| upload 时长 | p50 1.1ms / max 56ms | 无上传挂起 |
| seek(合成提交)时长 | p50 13.6ms / max 256ms | 4K60 单帧合成正常 |

逐 event 交叉验证:有 decode 事件但无 seek 事件的 epoch(59 个)= 被 latest-wins
取代的 seek 的解码劳动在事件流中留痕——与"取代后 decode 继续完成、只是合成被
跳过"的代码路径(preview-session.ts:1424 处 epoch 失配静默)完全吻合。

## 3. 机制链(harness 300ms 节奏 × 产品语义)

harness 每 300ms 点击进度条一次(playhead 跳变 >0.5s)。产品侧行为:

1. playhead 跳变 → SyntheticPreview effect(SyntheticPreview.tsx:394–402)
   `seekToFrame(target)` + 250ms 定时 `refineAfterDrag()`;
2. refineAfterDrag(preview-session.ts:1461–1466)内部**再调一次 seekToFrame**
   ——这是 M3-2 的拖拽快速档设计(风暴中主轨优先,落定后全量精修);
3. 若下一个 click 在 refine/主 seek 的解码完成前到来(300ms 窗口 vs
   4K60 decode p50 115ms×双输入),旧 seek 被 epoch 取代——**用户所见即最终
   落点,被跳过的中间帧渲染是 latest-wins 的正确语义**(scrub 的标准行为,
   与 M3-2 验收口径一致);
4. 落点与上一次落点邻近时,目标帧已在解码环内 → 零 decode 直接 compose。

**计数缺口 = (被取代的 seek) + (环命中零解码的 seek) × (decode/seek 比率)**
的合成结果,与 4K60 无关——G0 的 1080p 场景同形态(88–96/100、160–165 decode)
即为证:**这不是 4K60 特有退化,而是 seek 相位负载形状下的稳定计数口径。**

## 4. 结论

1. **无残余故障**:六轮复跑 + G0 六轮,零 decode 超时(max 668ms ≪ 15s)、
   零上传挂起、零 unhandled rejection、零挂起;seek/decode 计数逐轮分布
   与 G0 基线逐位同形态——W1/W2 修复后 4K60 seek 路径**没有新缺陷**。
2. **"decode≈seek≈200+"的登记预期口径错误**:它假设每 seek 恰一次
   seekToFrame + 恒解码,未计入 (a) refineAfterDrag 的第二次 seek、
   (b) latest-wins 丢弃、(c) 解码环命中。真实稳态 = seek 事件 86–97、
   decode 160–166、无失败——**该口径应修正为观测区间,而非继续当作缺口**。
3. **"4K60 decode 慢"维度如实登记**:decode p50 115ms(max 668ms)对 4K60
   单帧在本机(i7-1165G7 核显硬解)是物理能力区间,300ms 节奏下足以支撑
   latest-wins 落定;它在拖拽风暴(p95 翻倍,见 :1436 注释既有实测)中的
   表现已被拖拽快速档设计兜住。**无需另立修复工作单。**

## 5. 处置

- DEFECT-4K60-SEEK 台账状态行的"decode 侧 4K60 慢/超时根因未修(规划 §5
  另立诊断单)"表述更新:诊断已完成,结论 = 无故障、口径修正,本单即为
  规划 §5 所指的诊断单;
- F05 后续复跑协议的判读口径改用本单 §2 表(预期区间而非 200+ 点值);
- FIX_PLAN §5 的该项预登记同步闭合。

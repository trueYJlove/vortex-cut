# 多剪辑片段预览卡顿/卡死根修 · 实施记录（2026-10-07）

> 规划/承接门：`PREVIEW_SMOOTHNESS_PLANNING_GATE_2026-09-28.md`；STATUS.md §4 P33。
> 当前状态以 `docs/STATUS.md` 为准。本文是点时间实施记录。

## 1. 用户报障与复现口径

> 「当存在多个剪辑片段时，播放会很卡顿，甚至直接卡住不播放了。」
> （截图：960x540 画布合成预览 + 时间线多段剪辑）

复现载体（本仓库内，无需真机）：`apps/desktop/tests/preview-multiclip-chain.test.ts`
——单素材、6 个片段、源窗口起点 `[0, 3000, 30, 6000, 100, 9000]`（前跳与回跳交替，
即自动粗剪的真实形状），全部片段共享一个 `input_id`。虚拟时钟 + 立即应答的
worker 桩把「链推进逻辑」与真实解码耗时解耦，断言因此是确定性的。

## 2. 根因

### 2.1 结构前提：同素材多片段共享一条顺序解码链

`services/core/src/aivs_core/rendering/plan.py:367-370` 按 **asset** 去重分配
`input_id`：

```python
input_id = input_by_asset.get(asset["id"])
if input_id is None:
    input_id = f"I{len(inputs)}"
    input_by_asset[asset["id"]] = input_id
```

桌面侧 `PreviewSession.assemble` 为**每个 input** 建一个 decode worker
（`preview-session.ts` 的 `for (const input of ir.inputs)` 循环），且每个 input
只有**一条**顺序解码链（`rig.fed` 单调游标 + 环形槽）。因此：**同一素材的
N 个剪辑片段 = 1 个 worker + 1 条链**，而片段之间的源窗口可以任意跳变
（自动粗剪就是把同一素材的远距片段接起来）。

### 2.2 直接根因：链按「稠密整数」推进，而不是按「展示需求」

`pump()` 旧实现（`preview-session.ts`）：

```ts
const anchor = displayMaxByInput.get(inputId) ?? sorted[0]!;
const max = Math.min(sorted[sorted.length - 1]!, anchor + min(LEAD, ringDepth - 3));
let next = rig.fed < 0 ? sorted[0]! : rig.fed + 1;
while (next <= max && this.ringSlotIndex(rig, next) >= 0) { rig.fed = next; next += 1; }
```

`next = rig.fed + 1` 是**逐帧 +1**，而超前上限 `max` 锚在**当前展示需求**
`anchor`。剪辑点一过 `anchor` 立刻跳到新片段的源位置，于是出现两种病态：

| 形态 | 机制 | 观感 |
|---|---|---|
| **前跳**（新片段源位置更靠后） | `max` 跳到新位置，`fed+1` 从旧位置**逐帧空走** `[fed+1, anchor)` —— 这段区间**没有任何展示需求**，每帧仍要走一次「解码 + 上传」往返。源距离 3000 帧 = 3000 次往返 | 「很卡顿」 |
| **回跳**（新片段源位置更靠前） | `max = anchor + LEAD` 落在**旧位置之前**，`next = fed + 1 > max` ⇒ **一个请求都不发** | 「直接卡住不播放了」 |

回跳形态的实测证据（修复前基线，`currentFrame` 冻结在第 1 个片段末尾）：

```
RESULT currentFrame= 29 dropped= 0        ← 片长 180 帧，冻结在 clip_0 末帧
REQ count= 338 unique= 126
TOP repeat counts: 3x3 4x3 5x3 6x3 ...    ← 同一 src_n 反复重发
```

（`currentFrame=29` 即 `CLIP_FRAMES-1`：第 2 个片段的源起点 3000 **从未被请求**，
播放头再也无法推进。）

### 2.3 放大器：在途只计数、不按 src_n 去重（L12 定位）

`InputRig` 旧字段是 `inFlightCount: number`（只计数）。同一输入在剪辑点会被
反复要求同一批展示需求，而「这一帧已经在途」无法用计数判断 ⇒ 对同一 `src_n`
重复入队。实测（修复前，同一夹具）：

```
DUPLICATE total= 213
TOP repeat counts: 3x3 4x3 5x3 ... 17x37   ← 单帧最多被请求 37 次
```

这解释了 `PREVIEW_SMOOTHNESS_IMPLEMENTATION_2026-09-29.md` §4 **L12**
（「客户端同帧重发的来源未定位」）——来源就是 `pump` 的链推进与环形簿记：
重复请求把 worker 串行队列堵满，真正需要的帧被排在后面。

### 2.4 已排除：工作区里 `ir.py` 的「源不连续即拆分输入」改动

先前工作区改过 `ir.py::_split_overlapped_inputs`，让「源不连续」的相邻片段
也拆分复制输入（`I0~1`、`I0~2`…），意图是让每个片段各得独立 worker/环池。
实测该方向**与根因相反且有害**：

- 10 个片段 ⇒ 造出 9 个 input（`I0`…`I0~8`）⇒ 9 个 decode worker + 9 套环形
  纹理池（`ringDepth` 8~12 槽/输入）。纹理与解码器会话成倍增长，而
  `resource-budget.inputTextureBytes` 正是按「输入数」记账——直接撞预算降级。
- 它把「一条链被跳变打断」换成「每条链只服务一个片段」，代价是解码器数量
  与**起播冷启次数**随片段数线性增长（自动粗剪几十段 = 几十个 worker）。
- 既有测试直接判红：`test_non_overlapping_same_asset_keeps_single_input`
  （同素材不重叠 → 应保持单输入单 worker）。

⇒ **已回退**该改动（`git checkout -- services/core/src/aivs_core/rendering/ir.py`），
根因在会话侧的链推进，不在 IR 投影的输入分配。

## 3. 修法

### 3.1 链按「展示需求」推进（`preview-session.ts::pump`）

```ts
const demanded = [...(rig.fed < 0 ? (enterNeeds.get(inputId) ?? needs) : needs)]
  .sort((a, b) => a - b);
if (rig.shadowInFlight !== null) continue;
const anchor = displayMaxByInput.get(inputId) ?? demanded[0]!;
const max = anchor + Math.min(PreviewSession.LEAD, this.ringDepth - 3);
for (const srcN of demanded) {
  if (srcN > max) break;
  if (rig.inFlight.size >= PreviewSession.IN_FLIGHT) break;
  if (rig.inFlight.has(srcN)) continue;
  if (this.ringSlotIndex(rig, srcN) >= 0) continue;
  const generation = rig.chainGeneration;
  rig.inFlight.set(srcN, generation);
  rig.fed = Math.max(rig.fed, srcN);
  void this.uploadRing(rig, inputId, srcN)…
}
```

- **前跳**只请求新片段的真实需求（worker 侧既有 `farForward` 判定自行决定
  「关键帧重解 vs 热态续喂」）；**回跳**直接请求更早的需求（worker 侧既有
  `behindCursor` 判定自行冷启）。会话不再做启发式回卷，`resetInputChain` 与
  `lastDemandByInput` 启发式一并删除（它们的 `backwardJump = demand <
  previousDemand` 判据会在**正常的 pump 目标回退**上误触发，把满环 12 槽清空
  ——实测 `RESET … ringNonEmpty=12` 后 `fed` 在 10/11/12/13 间震荡）。
- `max` 封顶语义**保持不变**（锚 `anchor` + `min(LEAD, ringDepth-3)`）：
  W4/W11/W12 记录的「变速防卡顶 / 环槽不被写深覆盖」约束逐位保留。
- 影子槽串行约束保留（`rig.shadowInFlight !== null` 时不发主环请求）。

### 3.2 在途按 src_n 记账并带世代

`InputRig.inFlightCount: number` → `inFlight: Map<number, number>`
（`src_n → 入队时的 chainGeneration`）：

- 用 `inFlight.has(srcN)` 真正去重 ⇒ 消除 2.3 的重发风暴（L12）；
- 带世代是为了让**被 seek/重建作废**的旧任务收尾时不误删同 `src_n` 的新
  在途标记（`if (rig.inFlight.get(srcN) === generation) …delete`），否则会
  重新引入一次重复请求；
- `resetChains` / `recreateDecoder` 同步 `rig.inFlight.clear()`；
  `chainState()` 诊断改为输出在途 `src_n` 列表。

## 4. 验证

### 4.1 有区分力的回归（修复前红 / 修复后绿）

`apps/desktop/tests/preview-multiclip-chain.test.ts`，3 例全部对拍确认：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 源窗口前跳/回跳交替：播放头走完全片 + 每片段源位置都被请求 + 无空走 | ❌ 冻结在 `currentFrame=29` | ✅ `currentFrame=179`、`dropped=0` |
| 远距前跳不逐帧空走（源距离 3000 帧） | ❌ | ✅ 请求数 < 3000（远小于单个剪辑点源距离） |
| 变速 2x 片段按需求推进（不空走、不因环深收窄冻结） | ❌ | ✅ `currentFrame=179` |

对拍方法：`git stash push -- <两个源文件>` → 跑测试（3/3 红）→ `git stash pop`
→ 跑测试（3/3 绿）。

### 4.2 回归面

- Desktop 全量：**804 passed / 1 failed**。唯一失败
  `tests/app.test.tsx > 支持素材库刷新、删除确认弹窗和只读 Transcript 查看`
  经 stash 对拍确认**修复前既存失败**（`Unable to find an element with the text:
  原始 ASR 结果只读…`），与本次改动无关。
- Desktop typecheck：绿。
- Core 全量：绿（`ir.py` 回退后 `test_render_ir*` 56 passed，含
  `test_non_overlapping_same_asset_keeps_single_input`）。
- `test_status_doc_consistency.py`：8 passed。

## 5. 遗留

- **L1**（插桩零开销对跑）与**用户真机复测确认**仍未闭环，沿用 P33 行口径。
- **L8**（跳转风暴下的解码器表面池停摆）不受本修影响：本修只改会话侧「请求
  哪些帧」，不改变 worker 侧持有帧水位与表面池策略。
- **L13**（50fps 源 + 30fps 画布稳态延迟残留）保持观察：本修消除了剪辑点的
  空走与重发，但「喂够 vs 吐到」的 1~2 源帧稳态滞后仍由 worker 侧管线深度决定。
- 本修**未**做真机 e2e 复测（需要用户素材与 GUI 会话）；建议用户按原操作路径
  复测「多片段顺播」，并观察指标行的 `丢帧` / `解码 p50·p95` 是否回到稳态。

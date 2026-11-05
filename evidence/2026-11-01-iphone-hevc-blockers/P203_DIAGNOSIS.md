# P203 定位记录：10-bit HDR HEVC 解码静默停止（2026-11-01）

> 状态源引用 `docs/STATUS.md` §4 **P203**。本文只记录实验事实与证据等级。

## 0. 结论先说

**已把故障缩小到一个可复现的确定性特征，但未定位到具体代码行。**

- **【观测】10-bit 素材：解码器吐出第 1 帧（`pts:0`，被 active 请求消费）后，不再吐任何帧。**
- **【观测】同步的 8-bit 素材在同一位置之后持续吐帧（`pts:41666`、`83333`…），日志总量 18,588 行 vs 挂死版 21 行。**
- **【观测】挂死时无 `decoder_error`、无 `unmatched_near`、无 `stall_recovered` —— 解码器不报错，只是静默停止。**
- **【观测】客户端主线程在点击播放后 18 秒内 `page.evaluate` 全部 `EVAL_BLOCKED`（渲染进程不可响应）。**

## 1. 已排除的因素（全部为观测）

| 实验 | 结果 | 排除了 |
|---|---|---|
| 去掉 3 条 `mebx` 数据轨（`-c copy`） | 仍挂死 | **数据轨**不是成因 |
| remux 保留 147 关键帧（`media_time=1632`） | 仍挂死 | **单一超长 GOP** 不是成因 |
| 原始 `raw.mp4`（`media_time=0`） | 仍挂死 | **edit list 偏移**不是成因（P204 已修，与本条独立） |
| 转 8-bit SDR（同内容同帧率） | **不挂死** | 缩小到 **10-bit / HDR** |
| `WebCodecs.isConfigSupported` | 10-bit 与 8-bit 均 `prefer-hardware: supported` | **不是「不支持」**，是支持但运行中停 |
| 纹理池探测：64 张 3840×2160 RGBA16F | 全部成功，无 GL 错误 | **GPU 纹理池耗尽**不是成因（至少不是这个口径） |

## 2. 关键代码事实

**A. 像素格式未覆盖 P010（相容，未证因果）**

`compositor-worker.worker.ts:437-490` 的 `uploadToTextures` 只处理两种格式：

```ts
if (frame.format === "NV12") { … }
else if (frame.format === "I420") { … }
else { throw new Error("unsupported decoded frame format: " + frame.format); }
```

**没有 `P010` / 10-bit 分支**。10-bit HEVC 解码输出通常是 `P010`（或 `I420P10`）。
若真走到这里会**抛错**——但挂死日志里**没有该错误**，说明**故障发生在合成器收到帧之前**。

**B. 能力探测只覆盖 8-bit codec string（相容，未证因果）**

`decode-capability.ts:26`：

```ts
hevc: ["hvc1.1.6.L120.B0", "hev1.1.6.L120.B0"],
```

而 10-bit 素材实际 codec string 是 `hvc1.2.4.L150.B0`（**profile 2 = Main 10**）。
探测判「支持」依据的是 8-bit 样本，**与实际 profile 不一致**。
这与该文件注释自述的「profile/tier/level 可能与实配 hvcC 错位」属同型，
**但本轮未验证该错位是否导致挂死**。

## 2.5 ⭐ 决定性测量：合成器从未收到帧（2026-11-01 补）

在 `compositor-worker.worker.ts` 的 `uploadToTextures` 入口加 `console.log("[p203fmt]", frame.format …)`
后复跑 10-bit 素材：

- **`p203fmt` 一次都没有输出** ⇒ **合成器从未收到任何帧**。
- 日志仍停在 `output {"pts":0,"active":0}`（共 20 行）。

**⇒ 故障发生在 worker 内部：`output pts:0` 之后、把帧 `post` 出去之前。**

这把范围从「worker 或合成器」**收窄到 worker 内部一处**，并**排除**了两条此前只是
「相容」的猜测：

- ❌ **不是** `compositor-worker` 缺 `P010` 分支——那一行根本走不到。
- ❌ **不是** GPU 纹理池耗尽——合成器没参与。

**仍未定位到具体行**：`output` 回调里 `pts:0` 命中 `activeRequest` 之后，
到 `post({type:"frame"})` 之间还有 `cachePut` / `frame.clone()` / `allocationSize()`
等步骤，本轮**未逐步插桩**，故无法断言是哪一步停止。

**下一步唯一该做的测量**：在 `createDecoder` 的 `output` 回调内、`post({type:"frame"})` 前后
各加一条 trace，确定是「回调没被再次调用」还是「回调内某步抛了未被捕获的异常」。

## 2.6 ⭐⭐ 第二轮：output 回调只被调用一次，且帧 format 为 null

在 `createDecoder` 的 `output` 回调**入口**加 `trace("output_enter", { pts, fmt: frame.format, decoded })`
后复跑 10-bit 素材，全程仅 22 行日志：

```
feed {"index":0..4}                      ← 喂入 5 个包，dq 从 1 降到 0
output_enter {"pts":0,"fmt":null,"decoded":0}   ← 回调仅触发 1 次
output {"pts":0,"active":0}              ← 第 1 帧被 id=0 请求消费
（结束，无任何后续日志）
```

**三条硬事实**：

1. **`output_enter` 全程只出现 1 次** ⇒ 解码器**只吐出过 1 帧**，之后**再也不回调**。
2. **`frame.format` 是 `null`** ⇒ 这个 VideoFrame 没有像素格式信息，本身就是异常状态。
3. **`dq` 从 4 降到 0** ⇒ 解码器**接受并消费了输入**，却不产生输出。

**⇒ 故障精确定位：10-bit HEVC 硬件解码器在吐出第 1 帧后静默停止，不再产生任何输出，
且不触发 `decoder.error`。** 这与应用层逻辑无关（喂包、索引、定位均正常）。

### 与 `P010` 假说的关系（重要更正）

此前 `compositor-worker` 缺 `P010` 分支被列为「相容」。**本轮证明它走不到**：
合成器从未收到帧（`p203fmt` 零输出）。**故该方向应降级为「无关」**，不是候选成因。

**`frame.format === null` 才是当前最强的线索**：正常 8-bit HEVC 解码输出应为 `NV12`。
拿到 `null` 说明解码器产出的 VideoFrame 不完整——很可能与「HW 解码器对 10-bit
（P010）表面配置失败但仍接受输入」有关。**但这一点本轮未验证。**

### 下一步（仍未做）

在 `output` 回调内、拿到帧后立即调用 `frame.allocationSize()` 与 `frame.copyTo()`
并打印结果/异常——能区分「帧是空壳」与「帧有效但格式未知」。
**在完成该测量前，不得把 P203 归因写到任何具体代码行。**

## 2.7 ⭐⭐⭐ 定案测量：10-bit 解码产出的是**不可用的 VideoFrame**（format=null）

在 `output` 回调内对拿到的帧立即调用 `frame.allocationSize()`（同步、轻量；
**不调 `copyTo`** 以免阻塞 worker 掩盖停摆点），得到决定性对照：

| | **10-bit HDR HEVC** | **8-bit HEVC** |
|---|---|---|
| `frame.format` | **`null`** | `"NV12"` |
| `displayWidth × displayHeight` | 3840 × 2160（**正常**） | 2160 × 3840（正常） |
| `codedWidth × codedHeight` | 3840 × 2160（正常） | 2160 × 3840（正常） |
| `allocationSize()` | **抛错**：`Operation is not supported when format is null.` | **12,441,600**（正常） |
| 输出帧数 | **1 帧后停止** | **持续**（日志 23,105 行） |

### 结论（成立）

**10-bit HEVC 解码器产出的 VideoFrame 尺寸正确但 `format` 为 `null`，
导致任何像素访问 API 均不可用。** 这不是「格式未识别」，是**帧本身不可用**。

**为什么表现为挂死而非报错**：应用层没有任何代码检查 `frame.format` 是否为空；
坏帧被当作正常帧走完回调链，之后解码器不再产出，而 `prefer-software` 对
**所有** HEVC 均返回 `false`（**无软解后备**，见 §2 已测），故无降级路径，最终表现为
渲染进程主线程堵死。

### 仍然未定的部分（不得越读）

- **未**确定是 Chromium/D3D11 硬件解码器对 10-bit 的缺陷，还是本应用传给
  `VideoDecoder.configure()` 的 `description`（hvcC）不含完整 10-bit 配置所致。
  **这两者本轮无法区分**——需要有 10-bit 能正常解码的对照环境，或改配 description 后复测。
- **未**验证「在应用层加 `frame.format == null` 检查并在检测到坏帧时降级」
  能否把挂死变成可恢复错误。这是**下一步唯一有把握的工程动作**，
  但它**治标**（把静默挂死变为可感知失败），不解决 10-bit 解码本身。
- **未**测其他 10-bit 素材（n=1）。

### 建议的修法方向（未实施）

1. **检测**：在 `output` 回调入口，若 `frame.format === null`，立即 `frame.close()`
   并走 `decoder.error` 同一恢复路径（reset + 报错 + 降级），
   把「静默挂死」降级为「明确失败 + 可降级到 FFmpeg B 后端」。
2. **预防**：`decode-capability.ts` 的探测应覆盖 10-bit codec string
   （`hvc1.2.4.*`），并把「10-bit 探测结果」与「8-bit 探测结果」分开记录，
   避免用 8-bit 的 supported 冒充 10-bit 可用。

**两者都未实施**；本轮只做定位。

## 3. 挂死点的精确形态（观测）

worker trace 末段（`diag-p203b-22924/console.log`，共 21 行）：

```
feed {"index":4,"batchEnd":4,"gen":1,"dq":1,"stash":0}
output {"pts":0,"active":0}          ← 第 1 帧，被 id=0 请求消费
stall_exit {"tick":3,"why":"request-changed","dq":0}
```

对照 8-bit 版同位置：

```
output {"pts":0,"active":0}
output {"pts":41666,"active":null}   ← 继续吐
stash_put {"pts":41666,"size":1,"cap":12}
output {"pts":83333,"active":null}
```

**⇒ 10-bit 版在 `output pts:0` 之后再无输出。** `dq=0` 说明解码器队列已空（输入被接受、无积压），
却不再产生任何输出——**不是背压、不是等待，是解码器停止工作且不报错**。

## 4. 本轮未能回答的问题（不得越读）

- **未**确定解码器为何静默停止：可能是 HW 解码器对 P010 输出的表面管理、
  可能是 `VideoFrame.close()` 时机、可能是 D3D11 纹理格式协商失败——**均未验证**。
- **未**确认故障发生在 worker 内部还是跨 worker 传输（frame post 走 transfer，无 trace）。
- **未**在 `uploadToTextures` 加日志，故**不能断定**故障在合成器之前还是之中。
- **未**测其他 10-bit 素材（n=1）。

## 4. 尝试修复：两次均失败（如实记录，代码已回退）

### 4.1 尝试一：坏帧检测 + reset 重试 → **失败（自锁风暴）**

在 `output` 回调加 `frame.format === null` 检查，关闭坏帧后走 `decoder.error`
同一恢复路径（reset + 报错）。

**结果：更糟。** 日志从 22 行涨到 **4,312 行**，事件分布：

```
feed 2077 / stall_exit 270 / enqueue 265 / decoder_reset 265
cold_start 265 / output_enter 264 / bad_frame_format 264
```

**每次 reset 后重新冷启 → 又从关键帧重解整 GOP → 又解出坏帧 → 再 reset**，
形成自锁风暴。**主线程依然 100% 堵死**（18s 内 `page.evaluate` 全部超时）。

### 4.2 尝试二：加熔断（streak 上限 + 拒绝后续请求）→ **仍失败**

加 `BAD_FRAME_STREAK_LIMIT = 8` 与 `sessionFatal` 门禁。

第一次实测发现熔断**没锁死**：`streak` 一路涨到 **107**、`bad_frame_fatal` 触发 **863 次**——
因为 fatal 分支只 `return`，下一个请求照样进来。

补上「`sessionFatal` 后拒绝入队」后，worker 侧确实止住了：

| 指标 | 熔断前 | 熔断后 |
|---|---|---|
| `feed` | 3041 | **54** |
| `bad_frame_format` | 870 | **10** |
| `enqueue` | 767 | **57,898** ← **爆炸** |

**⇒ 主线程依旧 100% 堵死。** 根因转移到了**客户端**：
`preview-session.ts:1143` 在 `maybeFallBackToFfmpeg` 之后**又调用一次
`decode(srcN)`**，熔断拒绝 → 抛错 → 上层再试 → 无限循环。

**结论：熔断在客户端重试路径上制造了二次伤害，比不做更糟。**

### 4.3 当前保留的改动（最小、且不声称修复）

只保留 **`frame.format === null` 检测 + `bad_frame_format` trace + 关闭坏帧**，
**不 reset、不熔断、不改客户端**。实测该形态下：439 次冷启 / 2793 次 feed，
**主线程仍然堵死**。

**⇒ 必须明确：P203 未被修复。** 保留该检测的唯一价值是把「坏帧」这一事实
显式记录下来（`fmt:null` + `allocationSize()` 抛错），便于下一手复现与验证。

## 5. 下一步真正该做的（本轮未做）

问题已从「哪一步坏了」转为「**为什么客户端会无限重试**」。三个待查点：

1. `preview-session.ts:1143` 降级后再 `decode()` 的逻辑：降级失败后是否有重试上限？
2. `RequestScheduler` / `pump()` 是否在错误后立刻重新入队同一帧？
3. `maybeFallBackToFfmpeg` 对本错误码的判定：`DECODE_FRAME_FORMAT_NULL` 是否
   命中降级正则？若不命中，会走「什么都没变」的分支继续重试。

**在查清这三点前，不应再改 worker 侧。**


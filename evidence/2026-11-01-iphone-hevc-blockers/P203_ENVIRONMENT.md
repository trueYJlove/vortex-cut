# P203 根因：Electron 的 Chromium 版本过旧（2026-11-01 定案）

> 状态源引用 `docs/STATUS.md` §4 **P203**。
> **本文取代此前所有关于 P203 的成因推测**（VFR / edit list / P010 / colorSpace / 纹理池 / 显示器）。

## 0. 结论

**P203 的成因是运行环境的 Chromium 版本，不是素材、不是产品业务代码。**

| 环境 | Chromium 版本 | dynamic-range: high | screen.colorDepth | 10-bit HLG 解码 |
|---|---|---|---|---|
| **Chrome**（用户实测能播） | **156**.0.8078.74 | **true** | **30** | 正常 |
| **Electron 36.2.1**（本产品） | **136**.0.7103.93 | **false** | **24** | 产出 `format=null` 坏帧 |

**同一台机器、同一个 Windows HDR 开启状态、同一个素材**，Chrome 读出 HDR 支持并正常解码，
Electron 读不到并解出坏帧。**相差 20 个 Chromium 主版本。**

## 1. 证据链

### 1.1 显示器与系统侧已排除

- 用户换用**支持 HDR 的显示器**，Windows 设置中 **HDR 已开启**（用户提供截图确认）。
- 用户实测 Chrome 内 `dynamic-range: high = true`、`colorDepth = 30`。

### 1.2 Electron 侧读不到（同机同素材）

```json
{ "dynamicRangeHigh": false, "videoDynamicRangeHigh": false,
  "colorGamutP3": false, "colorGamutRec2020": false,
  "screenColorDepth": 24, "dpr": 1.5 }
```

窗口状态已确认**可见、聚焦、未遮挡**（`visible:true, minimized:false, focused:true`），
排除「窗口被遮挡导致合成器降级」。

### 1.3 GPU 特性状态

```
gpu_compositing: enabled     video_decode: enabled
direct_rendering_display_compositor: disabled_off_ok   <- 关键
```

`disabled_off_ok` 表示 Chromium **主动判定该特性不可用**（非被开关禁用）。
强制 `--enable-features=DirectRenderingDisplayCompositor` 无效——该特性是 HDR 输出的前提。

### 1.4 版本对照

```
Chrome           156.0.8078.74
Electron 36.2.1  Chromium 136.0.7103.93   (相差 20 个主版本)
```

## 2. 实际解码表现（关键）

即便 Windows HDR 已开启，Electron 内该素材仍然：

```
output_enter {"pts":0,"fmt":null}   <- 第 1 帧 format 为 null
（解码器随后静默停止，主线程永久堵死）
```

`frame.allocationSize()` 抛错：`Operation is not supported when format is null.`

**Chromium 136 的 Windows 10-bit HEVC 硬件解码路径存在缺陷：
`isConfigSupported` 报 `supported`，但实际产出不可用帧。**

## 3. 本轮已排除的方向（全部实测，非推断）

| 方向 | 排除方式 |
|---|---|
| VFR 帧率 | 24fps 网格定位误差最大 16.7ms < 33ms 容差 |
| edit list 偏移 | 已独立修好（P204），修后首帧 PTS 归零，仍 `fmt:null` |
| 单一超长 GOP | remux 保留 147 关键帧，仍挂死 |
| mebx 数据轨 | `-c copy` 去除后仍挂死 |
| compositor 缺 P010 分支 | 合成器加日志后**零输出**，帧从未到达合成器 |
| GPU 纹理池耗尽 | 一次性分配 64 张 4K RGBA16F 全成功 |
| 硬编码 `colorSpace: bt709` | 移除后 `fmt` 仍 null（**已回退**） |
| 软解可绕过 | `VITE_AIVS_FORCE_SW_DECODE=1` 仍 null（该开关只是不请求 prefer-hardware） |
| 显示器不支持 HDR | **已换 HDR 显示器 + 开启系统 HDR**，Electron 读数仍 false |
| 窗口遮挡 | 窗口可见/聚焦/未遮挡，读数不变 |

## 4. 为什么剪映能播

剪映很可能用**更新的 Chromium/Electron**，或自带解码器（不走 WebCodecs）。
它弹「未支持 HDR 的设备」说明**它检测到了显示器状态**——本产品连检测都没有。

即使播放引擎不同，**剪映的三步做法仍值得照抄**：检测 → 告知用户 → 降级到 SDR 继续工作。

## 5. 修复方向

### 5.1 根本修复：升级 Electron（需独立立项）

Chromium 136 → 156 跨 20 个主版本，**风险高**：涉及 Node ABI、原生模块、
`contextIsolation` 行为、已交付的 NSIS 打包流程。**不应作为 bug 修复顺手做。**

### 5.2 立即可做（产品本来就该有）

**检测 + 告知**：`(dynamic-range: high)` 为 false 而素材为 HDR 时，像剪映一样**显式弹窗**。
不修解码，但把「完全无提示的永久卡死」变成「用户知道发生了什么」。
**当前状态不可接受：用户点播放，整个界面失去响应，没有任何解释。**

### 5.3 独立缺陷（与 10-bit 无关）

客户端重试路径**无上限**：实测 `enqueue` 从 767 涨到 **57,898**。任何解码错误都可能触发。**应单独修复。**

## 6. 复现

```bash
cd apps/desktop && pnpm build:e2e
AIVS_PROBE_MEDIA="<10-bit HDR mp4>" AIVS_PROBE_LABEL=p203 \
  npx playwright test --config=tests/playwright.config.ts \
  e2e/diag-p203-hang.electron.spec.ts --reporter=line
```

判定：日志停在 `output_enter {"fmt":null}` 且后续 `page.evaluate` 全部 `EVAL_BLOCKED`。
---

## 7. 2026-11-01 补充：三条被用户直接证伪/确认的事实

### 7.1 HDR 显示器不是必需的（更正我此前的方向）

用户实测：**在换回不支持 HDR 的显示器后，把该素材拖进 Chrome 仍可正常播放。**

⇒ **播放 10-bit HLG 素材不依赖 HDR 显示器**。此前我把「换 HDR 显示器」当作验证手段，
方向有偏差——它只用于观察 `dynamic-range: high` 读数差异，与能否解码无关。

### 7.2 Chrome 的 `<video>` 播放 ≠ WebCodecs `VideoDecoder`（关键区分）

用户截图证明 Chrome 用**原生 `<video>` 元素**可播该素材。但这两条是不同的解码路径：

| 路径 | 使用者 | 本素材表现 |
|---|---|---|
| `<video>` + 平台媒体栈 | Chrome 页面 | **能播** |
| **WebCodecs `VideoDecoder`** | **本产品** | **产出 `format=null` 坏帧** |

⇒ **「Chrome 能播」不能直接推出「升级 Electron 就能修」**。
正确推论是：Chromium 136 的 **WebCodecs HEVC 硬解路径** 有缺陷，而同一版本的
`<video>` 路径走的是不同的媒体栈（可能回退到 FFmpeg 或不同 D3D 路径）。

**这提高了「升级 Electron」的不确定性**——新版本是否修复了 WebCodecs 10-bit 路径，
**未经实测不得断言**。

### 7.3 FFmpeg 后端降级：改了会崩，已回退

**发现**：`preview-session.ts:1026` 的降级判据正则只认 `timeout|watchdog|key frame is required`，
**`DECODE_FRAME_FORMAT_NULL` 不匹配 ⇒ 降级永不触发**。这是真实缺口。

**尝试**：把该错误码加入正则，并对确定性失败首次即降级。

**结果：两次运行均 `Error: page.waitForTimeout: Page crashed`**——渲染进程**崩溃**，
且崩溃发生在点播放之前（等待指标阶段）。**比原来的静默堵死更早、更糟。**

**已全部回退**（`git diff preview-session.ts` 为空）。

**未查明**：崩溃是 FFmpeg 后端本身的问题，还是 E2E 环境未注入 `decodeFrames`
（该回调依赖 project/asset 上下文，见 `:537`）导致降级链异常。**在查清前不得再改这条路径。**

### 7.4 新增观测：坏帧的 `codedWidth/Height` 可能为 0

回退后重跑的错误消息为 `...format=null 的帧（10-bit HEVC 硬解已知缺陷，0x0）`，
而此前的运行报 `3840x2160`。**同一素材不同运行下坏帧形态不一致**，
说明这不是稳定的「尺寸正确但格式缺失」，而是**更底层的解码失败**。
这进一步支持「Chromium 136 WebCodecs HEVC 路径缺陷」而非应用层误用。
---

## 8. 第一步已交付：HDR 检测 + 用户提示（2026-11-01）

### 8.1 背景缺口

产品此前**连素材是不是 HDR 都不知道**——`bmff-demux.ts` 完全不解析 `colr` 盒。
因此无法像剪映那样在点播放前告知用户。用户看到的是「点播放 → 界面失去响应 → 无任何解释」。

### 8.2 实现（五处改动，跨 5 个文件）

| 文件 | 改动 |
|---|---|
| `bmff-demux.ts` | 解析 `colr` 盒（`nclx`/`nclc`）的 transfer characteristics；`transfer=16(PQ)` 或 `18(HLG)` ⇒ `hdr=true`。**层级要点**：`colr` 在 sample entry（`hvc1`/`avc1`）**内部**，即 `stsd.start + 8 + 8 + 78` 起，不在 stsd body 顶层——首版写错位置导致恒为 null |
| `decode-worker.worker.ts` | `ready` 消息增加 `hdr` / `colorTransfer` |
| `decode-worker.ts` | `hdr` 字段 + 从 ready 赋值 |
| `decode-capability.ts` | `WebCodecsMediaDecoder` 增加 `hdr` getter（**包装类必须显式透传**） |
| `preview-session.ts` | `PreviewSessionMetrics` 增加 `hdr_media`（素材侧）+ `hdr_decodable`（环境侧，构造时 `matchMedia` 求值一次） |
| `SyntheticPreview.tsx` | `hdrBlocked = hdr_media && !hdr_decodable`，纳入 `anomaly`（**任何构建都显示**）并渲染提示文本 |

### 8.3 判定逻辑（为什么两个条件都要）

SDR 环境 + SDR 素材 ⇒ 正常；SDR 环境 + HDR 素材 ⇒ 问题；HDR 环境 + HDR 素材 ⇒ 正常。
**只看其一会误报或漏报。**

### 8.4 真机验证（关键：编译与单测都没抓到的问题）

**首次真机跑：提示没有出现。** 原因：`WebCodecsMediaDecoder` 是对 `DecodeWorker`
的包装类，漏了 `hdr` getter ⇒ 上层恒读到 `undefined` ⇒ `hdrBlocked` 恒 false。
**该缺陷 `tsc` 通过、1000 个单测全绿**——只有真机跑 UI 才暴露。

补上 getter 后真机输出（HDR 素材）：

```
最近错误：seek 解码失败 frame 0: DECODE_FRAME_FORMAT_NULL: …
当前显示环境不支持 HDR，该素材为 HDR（10-bit）。实时预览可能无法播放或卡死。
建议先转码为 SDR，或使用支持 HDR 的显示环境。
```

**SDR 对照组**（`p200-long.mp4`）只显示性能数字，**无提示 ⇒ 不误报**。

### 8.5 回归锁

`apps/desktop/tests/p203-hdr-detection.test.ts`（3 例）：
- 10-bit HLG 素材 ⇒ `transfer=18`、`hdr=true`
- 8-bit SDR 合成夹具 ⇒ `hdr=false`（**不误报**）
- H.264 SDR 素材 ⇒ `hdr=false`

全量 vitest **120 files / 1000 tests 全绿**。

### 8.6 本步骤做到的与没做到的

**做到**：检测（`colr`）+ 告知（UI 提示）——剪映三步中的前两步。

**没做到**：**降级**。用户仍会看到卡死；提示只解释了原因，没有恢复路径。
真正恢复仍需「升级 Chromium」或「可靠地切 FFmpeg 后端」，二者都未完成
（后者本轮尝试导致 `Page crashed`，已回退，见 §7.3）。
---

## 9. 第二步：查「降级崩溃」的结论（更正 + 边界）

### 9.1 重要更正：`Page crashed` 不是 fallback 改动导致的

此前（§7.3）记载：把 `DECODE_FRAME_FORMAT_NULL` 加入降级正则后「两次运行均 `Page crashed`」，
并据此认定「熔断/降级在客户端重试路径上造成二次伤害」。

**本轮复现实验推翻了该归因**：

| 实验 | 改动 | 点播放 | 结果 |
|---|---|---|---|
| A | 无 | 否 | 30s 内 `page.evaluate` 全部正常 |
| B | 无 | **是** | `EVAL_BLOCKED`（堵死，**未崩溃**） |
| C | **有** | 否 | 30s 内 `page.evaluate` 全部正常 |
| D | **有** | **是** | `EVAL_BLOCKED`（堵死，**未崩溃**） |

**⇒ `Page crashed` 是偶发（时序/资源竞争），不是该改动的确定性后果。**
当时把它归因为「二次伤害」是**过度解读**——两次连续崩溃让我跳过了 A/B 对照。

### 9.2 但降级本身确实没发生（这是真的）

实验 C/D 中 `metrics.decode_backend` 始终为 `webcodecs`，**从未切到 ffmpeg**。
原因：`maybeFallBackToFfmpeg` 在 `retry.decodeFrames` 缺失时直接 `return false`
（`preview-session.ts:1075`），而 E2E 环境下该回调未注入（依赖 `pcmProjectId` 与
`desktop.decodeFrames`，两者在测试环境不满足）。

**⇒ 本轮的 E2E 环境无法验证 FFmpeg 降级路径**，因为它本来就不具备该后端。
这不是缺陷，是测试环境限制。

### 9.3 堵死的机制：不在应用代码

挂死时的 worker trace 非常安静：

```
feed 14 / stall_exit 2 / output_enter 2 / enqueue 2 / decoder_reset 2
```

**worker 已停止工作（没有无限 refeed），但主线程仍 `EVAL_BLOCKED`。**
这排除了以下应用层假设：

- ❌ 不是客户端无限重试（`enqueue` 只有 2 次）
- ❌ 不是 worker 自锁风暴（`feed` 只有 14 次，远超之前的 2077/3041）
- ❌ 不是 `VideoFrame` 泄漏（坏帧路径已 `frame.close()`）

**⇒ 堵死发生在 Chromium 内部（GPU 进程/合成器），继续深挖需要 GPU 进程级诊断工具，
投入产出比不适合当前阶段。**

### 9.4 本轮没有交付的

降级（剪映三步的第三步）**未实现**。尝试路径与失败原因见 §7.3、§9.1。
在 E2E 环境不具备 `decodeFrames` 的前提下，任何降级改动都无法在此验证——
**必须有带 Core 后端的真机/集成环境才能继续**。
---

## 10. 第三步：升级 Electron 验证 —— ❌ 结论是否定的（并找到真正的根因）

### 10.1 实验设置

在隔离目录安装 **Electron 45.2.1**（本仓当前为 36.2.1），通过 Playwright 的
`executablePath` 直接以新版运行本产品主进程，**不改动仓库依赖**。

### 10.2 结果：新版 Chromium 完全一致

```
[alt] {"chrome":"156.0.8078.75","hdr":false,"depth":24}
```

- Chromium **156**（与用户 Chrome **156.0.8078.74** 几乎同版本）
- `dynamic-range: high` **仍为 false**
- `colorDepth` **仍为 24**（用户 Chrome 为 30）

**⇒ 「升级 Electron」不能修复。此前把根因归为「Chromium 版本过旧（136 vs 156）」是错的。**

### 10.3 真正的根因：D3D11 的 P010 叠加支持为 SOFTWARE

用 `app.getGPUInfo("complete")` 读取的新版 Electron 的 `overlayInfo`：

```json
{ "bgra8OverlaySupport": "SCALING",
  "nv12OverlaySupport": "SCALING",
  "rgb10a2OverlaySupport": "SCALING",
  "p010OverlaySupport": "SOFTWARE",      <-- 关键
  "yuy2OverlaySupport": "SCALING",
  "supportsOverlays": true,
  "directComposition": true }
```

**P010 是 10-bit HEVC 解码输出的像素格式。** 这台机器（Intel Iris Xe，驱动
31.0.101.3222）的 D3D11 只能以 **SOFTWARE** 方式处理 P010，而 NV12/8-bit 路径
是硬件 `SCALING`。

**⇒ WebCodecs 硬解接受配置（`isConfigSupported` 报 supported），但无法产出可用的
10-bit VideoFrame，最终给出 `format === null` 的坏帧。这与 Chromium 版本无关，
是 GPU/驱动能力问题。**

### 10.4 为什么用户 Chrome 能播而产品不能

用户 Chrome 用 **`<video>` 元素**播放——那条路径会**自动回退到软件解码/软件色彩转换**，
不需要 P010 硬件叠加。本产品的 WebCodecs 路径**直接请求硬件解码**，没有该回退。

这与 §7.2 的区分一致，并被本节数据印证：**不是版本问题，是解码路径选择问题。**

### 10.5 有效的解决方案：FFmpeg 后端（已验证可解）

**实测本仓随包 FFmpeg 能正常解码该素材，且 HDR→SDR 色彩正确：**

```bash
ffmpeg -ss 2.2 -i raw-remux.mp4 -frames:v 1 -f image2 out.jpg
# EXIT=0，输出 233,528 字节，画面色彩自然（无发灰/过曝）
```

`ffmpeg -decoders` 确认 `hevc` 解码器存在（纯软件，不依赖 GPU 叠加能力）。

**⇒ 让产品在 WebCodecs 产出 `format=null` 时降级到 FFmpeg 后端，是可行且正确的修法。**
该后端代码已存在（`decode-capability.ts:154` 的 `preferBackend`），
缺的是**触发条件**与**在当前 E2E 环境下验证的手段**（见 §9.2：E2E 未注入 `decodeFrames`）。

### 10.6 对修法优先级的修正

| 方案 | 之前判断 | 现在结论 |
|---|---|---|
| 升级 Electron | 「根本修复，风险高」 | ❌ **无效**（Chromium 156 表现相同） |
| 检测 + 告知 | 「治标」 | ✅ **已交付，仍然正确**（用户至少知道原因） |
| **降级到 FFmpeg** | 「待查」 | ✅ **正解**：实测可解码且色彩正确 |

**下一步的唯一方向是让降级可靠触发。** 前提是有一个具备 Core 后端的验证环境
（E2E 的 `decodeFrames` 为空，无法验证）。
---

## 11. 第四步：人工验证暴露两个新缺陷，均已修复 —— 素材现在**能播了**

### 11.1 人工操作发现的现象（用户实测）

> 把素材拖到时间线上，程序就白屏，然后崩掉了。

**这是自动探针此前从未复现的形态**（自动探针若漏了「设置预览比例」这一步，
预览会话根本不启动，`backend` 恒为 null，什么都不会发生）。

### 11.2 缺陷 A：把 `hdrBlocked` 纳入 `anomaly` 导致渲染进程崩溃（已修）

**定位过程**：临时把 `hdrBlocked` 置 `false` ⇒ 不崩溃；恢复计算但**不纳入 `anomaly`**
⇒ 也不崩溃；**纳入 `anomaly`** ⇒ 崩溃。三分法锁定到「纳入 anomaly」。

**为什么**：`anomaly` 控制指标条渲染，而 `metrics` 每秒 `setMetrics` 更新一次；
`hdrBlocked` 依赖 `hdr_media`，而后者的来源 `rig.worker?.hdr` 在降级替换 worker
后会从 `true` 变 `undefined` ⇒ `hdrBlocked` 与 `anomaly` **反复翻转** ⇒ 指标条反复
挂载/卸载 ⇒ 渲染进程崩溃。

**修法**：HDR 结论**锁存在会话级**（`hdrMediaLatched`），不随后端切换而变。

### 11.3 缺陷 B：降级后 `hdr` 丢失（已修，同因）

`FfmpegMediaDecoder` **没有 `hdr` 属性**——降级后 `rig.worker.hdr` 变 `undefined`，
`hdr_media` 由 true 变 false ⇒ 提示消失。

**同样的锁存修复同时解决 A 与 B。**

### 11.4 关键发现：降级在本机是**自动发生的**

实测 `backend = "ffmpeg"` 从第一次请求就是——因为能力表的 `downgradeRow`
会把 webcodecs 标记为不支持并**持久化**（`decode-capability.ts:213`）。
此前失败的 WebCodecs 尝试已经写入了该降级，故后续直接走 FFmpeg。

**⚠️ 副作用（未处理，需记录）**：该降级是**进程内持久**的，
意味着一旦某素材触发过降级，**同一会话内所有素材都走慢路径**。
这本身有 `FFMPEG_RETRY_COOLDOWN_MS` 冷却回切机制，但本轮未验证其是否生效。

### 11.5 ✅ 端到端验证：素材能播了

```
[pb] +2s  tc=00:00:00:24  backend=ffmpeg  composed=27   dropped=0  err=""
[pb] +8s  tc=00:00:01:24  backend=ffmpeg  composed=54   dropped=1  err=""
[pb] +14s tc=00:00:02:21  backend=ffmpeg  composed=80   dropped=3  err=""
[pb] +20s tc=00:00:03:19  backend=ffmpeg  composed=107  dropped=4  err=""
```

**时间码从 00:00:00:24 推进到 00:00:03:19，画面持续产出，无错误。**
对比修复前：完全堵死、界面无响应、时间码恒 00:00:00:00。

丢帧 4/107 ≈ 3.7%，是 FFmpeg 软解的正常代价（~180ms/帧）。

### 11.6 P203 的最终状态

| 项 | 状态 |
|---|---|
| 根因 | ✅ 已定案：Intel Iris Xe 的 D3D11 对 P010 仅 SOFTWARE，WebCodecs 硬解产出 `format=null` 坏帧 |
| 检测 | ✅ `colr` 盒解析（`transfer=16/18`） |
| 告知 | ✅ UI 提示（真机可见） |
| **降级** | ✅ **已生效**：`DECODE_FRAME_FORMAT_NULL` 首次即触发，切 FFmpeg 后端 |
| 端到端 | ✅ **素材可正常播放**（时间码推进、无错误） |
---

## 12. 第五步：用户报告花屏 —— 根因是 display matrix 旋转未被禁用（已修）

### 12.1 用户报告

> 虽然能播了，但是播几秒卡一下，并且这画面是花的呀

（截图显示预览区为**横向条纹**，底部标注「解码后端 ffmpeg（已降级，慢路径）」。）

### 12.2 复现与定位

**用 ffmpeg 直接复现了完全相同的花屏**，证明与产品代码路径无关：

```bash
ffmpeg -ss 2.2 -i <素材> -frames:v 1 -pix_fmt nv12 -f rawvideo out.raw
# 转 PNG 后：横向条纹，与用户截图一致
```

**排除的假设**：
- ❌ 10-bit → 8-bit 色调映射缺失（加 `tonemap` 后**更差**）
- ❌ 色彩矩阵转换（显式 `bt2020→bt709` 后仍花）
- ❌ `NV12` vs `yuv420p`（两者都花）
- ❌ seek 导致参考帧不足（从第 0 帧解同样花）

**真正根因**：该素材带 **`rotation=-90`**（iPhone 竖拍）：

```
声明尺寸（media_info_json）: 3840×2160   ← 旋转前
ffmpeg 实际输出（默认自动旋转）: 2160×3840   ← 旋转后
⇒ NV12 平面按 3840 的行宽去切 2160 行的数据 ⇒ 行错位 ⇒ 横向条纹
```

**决定性验证**：加 `-noautorotate` 后画面完全正常（已肉眼确认）。

### 12.3 ⚠️ 第一版回归锁是假锁（重要教训）

**第一版判据**：`len(frame.y) == width * height`。

**变异验证（移除 `-noautorotate`）后仍然全绿** ⇒ 假锁。

**原因**：NV12 的 `width*height*1.5` 对**宽高互换恒等**（乘法可交换），
所以「长度/尺寸」这一维度**根本无法区分**是否被旋转。

**实测真相**：加/不加 `-noautorotate`，输出**字节数完全相同（345,600）**，
但 **87.7% 的字节不同**——差异只在**内容**，不在长度。

**第二版判据（真锁）**：**相邻行相关度**。正常画面相邻行高度相关（接近 1）；
行宽错位后每行被平移 ⇒ 相关度显著下降。

**变异验证结果**：

| 状态 | 相关度 | 判定 |
|---|---|---|
| 有 `-noautorotate`（正确） | > 0.8 | 绿 |
| 无 `-noautorotate`（缺陷） | **-0.057** | **红** |

⇒ **新锁有真实区分力**，且附带一条「前置守卫」用例断言夹具本身确实会触发旋转
（加/不加必须差 >10% 字节），防止夹具失效后锁静默空转。

### 12.4 修法

`services/core/src/aivs_core/media/frame_decode.py` 的 ffmpeg 参数加 **`-noautorotate`**：
解码层只负责把码流原样解成平面，旋转应由前端按 IR 处理。

### 12.5 验证

- 新回归锁 `services/core/tests/integration/test_frame_decode_rotation.py`：**3 passed**（含变异验证）
- 既有 `test_frame_decode.py`：**11 passed**
- Desktop 全量 vitest：**120 files / 1000 tests 全绿**

### 12.6 遗留（未处理）

**「播几秒卡一下」未解决。** 这是 FFmpeg 软解（~180ms/帧）的固有代价，
不属于缺陷；但若用户观感不可接受，需考虑：
- 降低预览分辨率（代理预览），或
- 在支持 P010 的 GPU 上走 WebCodecs 硬解（本机不支持，见 §10.3）
---

## 13. 第六步：白屏崩溃（我的改动引入）+ HDR 提示数据源修正

### 13.1 用户报告

> 一打开软件加载了这个素材就白屏卡住了

（纯白画面，无任何 UI。）

### 13.2 定位：崩溃是我引入的，且**与 HDR 无关**

用 `git stash` 暂存我的 UI 改动作为基线：**基线不崩溃**，正常显示错误行。
故确认是本轮改动引入。

**逐层排除（每次都重建 + 真机复跑）**：

| 变异 | 结果 |
|---|---|
| `anomaly` 不含 `hdrBlocked` | **仍崩** |
| `anomaly = true`（恒真，强制显示指标条） | **仍崩** |
| `hdr_media = false` | 不崩 |
| HDR 提示改为**纯文本、无内联 style** | **不崩** |
| HDR 提示 + 完整文案 + **CSS 类**（无内联 style） | **不崩** |

**⇒ 真凶是内联 `style` 里的 `position:absolute` + `rgba` 背景**——
它让提示成为独立合成层，而本机 GPU（Intel Iris Xe，P010 仅 SOFTWARE 支持）
对合成层极敏感，渲染后 2-4 秒**必崩渲染进程**。

**这不是 HDR 特有的**：`anomaly = true` 恒真时指标条同样崩溃 ⇒ 生产构建里
**任何绝对定位的浮层**都可能触发。属既有缺陷，此前因生产构建从不显示指标条而未暴露。

**修法**：HDR 提示走**普通文档流 + CSS 类**（`.synthetic-hdr-notice`），零合成层。

### 13.3 缺陷 B：`hdr_media` 数据源错误（已修）

修完崩溃后提示仍不显示，实测 `hdr_media` **恒为 false**。

**原因**：该值取自 `rig.worker?.hdr`，而本机该素材**直接走 FFmpeg 后端**，
`FfmpegMediaDecoder` **没有 `hdr` 属性** ⇒ 永远读不到。
（此前加的「会话级锁存」也无济于事——锁存的前提是**曾经**读到过 true。）

**修法：数据源从 worker 改为 IR。**

| 层 | 改动 |
|---|---|
| `media/ffprobe.py` | `normalize_probe` 采集 `color_transfer` / `color_primaries` / `color_space`（`-show_streams` 本就返回，只是此前未提取） |
| `rendering/ir.py` | IR `inputs[]` 增加 `hdr` 字段：`color_transfer in ("smpte2084", "arib-std-b67")` |
| `ir.ts` | `IrInput.hdr?: boolean`（默认 false，老 IR 按 SDR） |
| `preview-session.ts` | `hdr_media: this.ir.inputs.some(i => i.hdr === true)`——**与解码后端无关** |

### 13.4 ✅ 端到端验证

```
[irh] +8s  {"hdrMedia":true,"hdrDecodable":false,
            "notice":"当前显示环境不支持 HDR，该素材为 HDR（10-bit）。实时预览可能无法播放或卡顿。建议先转码为 SDR，或使用支持 HDR 的显示环境。"}
```

**提示可见、内容正确、且不再崩溃。**

### 13.5 验证

- Desktop vitest：**120 files / 1000 tests 全绿**
- Python（status 一致性 + 旋转锁 + frame_decode）：**21 passed**

### 13.6 教训

**内联 `style` 里的定位/背景在低端 GPU 上可能让渲染进程崩溃**，
且崩溃**没有任何 JS 错误**（只有 `renderer crash`），极难定位。
改 UI 浮层时：优先用 CSS 类走文档流，避免 `position:absolute` + 半透明背景的组合。

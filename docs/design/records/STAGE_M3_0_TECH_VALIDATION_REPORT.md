# M3-0 技术验证报告

> Gate M3-0-2 交付物（对应冻结方案 §11 证据集合 a–f）
> 依据：[M3-0 预览合成引擎技术验证详细设计 v1.0](STAGE_M3_0_PREVIEW_ENGINE_VALIDATION.md)（Gate M3-0-1 冻结）
> 日期：2026-09-05
> 运行基线：`uiux-polish-round3` @ `dd82033`（探针代码与本报告随其后提交提交，生产路径改动仅限 §A.3 所列四文件）
> 角色：ZhangSan（P2 Core 侧）/ YeJing（P1/P3 与 Electron 载体）/ LiuWei（架构与判定口径）；LiuKeAi 独立验收（M3-0-3）待执行

## 0. 结论速览

| 探针 | 冻结判据 | 实测 | 判定 |
|---|---|---|---|
| **P1 合成性能** | 掉帧率 < 1%（33.3ms 任务预算）；任务起始间隔 p95 ≤ 33ms；scrub p95 ≤ 100ms（固定种子） | **合成任务提交 p95 = 0.1–0.4ms**；**60/75/100Hz 三档刷新率复测（修正测量污染后）：渲染循环节拍 p50 = 10/13.3/16.7ms（各档满速率），循环节拍 p95 = 10.4–17.7ms ≤ 33ms ✓，掉帧率 0–0.61%（三轮中位 0%，最差 < 1% 门）✓**；scrub p95 = 565–592ms | **合成与节拍达标；scrub 未达标**（多路顺序寻址编排问题，见 §1.4） |
| **P2 逐帧一致性** | 非字幕采样帧全部 PSNR ≥ 40dB 且几何错位 ≤ 1px | **几何错位 = 0px（26/26 全部）**；语义全部对齐；PSNR 受系统性重采样栈差异限制：第 0 步自校准底噪 31.4–38.6dB（< 40dB 门），主时间线非字幕帧 19.1–35.4dB | **原 40dB 门未达 → 按 [ADR-1](../STAGE_M3_0_ADR_1_P2_GATE.md) 相对化口径达标**（几何 0px ✓ 语义零偏差 ✓ 回归基线 ≥19dB ✓ 字幕 IoU ✓），ADR-2/3 不采纳 |
| **P3 帧寻址** | WebCodecs 或 WebCodecs+缓存：100 次随机跳转 p95 ≤ 100ms 且 PTS 偏差 ≤ 1 帧（100/100）、失败/黑帧 = 0 | **WebCodecs p95 = 30.1–39.6ms；WebCodecs+缓存 p95 = 30.1–38.6ms；PTS 偏差 = 0（100/100）；失败 = 0；黑帧 = 0**；HTML5 现状路径 p95 = 13.6–26.8ms（proxy 材质 3/100 超时） | **通过**（三材质 × 1080p/540p/代理全覆盖；主解码路径建议 = WebCodecs + 帧缓存） |

另：探针过程**发现两个权威端（生产渲染管线）真实缺陷**（§4.5），均在改动生产代码的前提下以证据归档，待主线排期修复。

---

## A. 证据集合 a：探针代码清单、运行基线、零改动报告

### A.1 代码清单（全部为新增，除 A.3 所列四文件）

**Core 侧工具（`tools/m3_0/`，Python，只读调用生产代码）**
- `common.py` — ffmpeg/ffprobe 路径、素材编码参数（libopenh264/CFR30/GOP30/BT.709 colr）
- `make_materials.py` — 自产固定参数测试素材（numpy 逐帧合成 → rawvideo 管道 → 编码 → colr remux）
- `make_proxy_reference.py` — 只读复用生产 `media/render.py proxy_filter()` 把 VFR 源转出代理参考
- `test_project.py` — 固定测试时间线 document JSON、白名单断言（R11）、临时 DB 播种、生产 `RenderPlanCompiler` 编译
- `ir_projector.py` — 中立 IR 投影器（白名单硬失败 + 30fps 逐帧数值表 + 转场窗口/offset/黑底填充收敛 Core 单点）
- `baseline_harness.py` — FFV1 无损基准端：直调 `compile → ffprobe → build_ass → build_timeline_args → run_timeline_render`（与 `rendering/service.py` 同序），encoder 替换 ffv1/mkv；PNG 采样提取（`scale=in_color_matrix=bt709` 钉死矩阵）
- `compare_tool.py` — 逐帧比对（ffmpeg psnr/ssim 滤镜于 gbrp RGB 空间 + FFT 相位相关 ±8px + 字幕文本 IoU 单独口径）+ 第 0 步自校准
- `run_electron_probe.py` — 探针运行器（AIVS_M3_PROBE 环境变量组注入）

**Renderer 探针（`apps/desktop/src/probes/`，§7.1 第 3 层目录约定）**
- `common/bridge.ts`、`common/shell.ts`、`common/ir.ts`、`common/stats.ts` — 桥接、页面壳、IR 类型、确定性 PRNG/统计
- `common/compositor.ts` — WebGL2 合成器（IR 消费端，P1/P2 共用；NV12 平面纹理 + 着色器内 BT.709 limited→full；显式 LOD；字幕层）
- `m3p1.ts` / `m3p2.ts` / `m3p3.ts` / `p3-worker.ts`（手写 BMFF demux + VideoDecoder）
- `types-probe.d.ts`、`env.d.ts` — WebGPU/ImportMeta 本地类型兜底（无新增生产依赖）

**隔离机制（§7.1 四层）**
1. 主进程：`electron/main/probe-ipc.ts`（新文件）+ `index.ts` 内 4 处门控钩子（见 A.3）
2. 预加载：`electron/preload/probe-bridge.ts`（新文件）+ `preload/index.ts` 尾部 4 行 `NODE_ENV !== "production" && AIVS_M3_PROBE` 双条件动态导入（生产构建 NODE_ENV 静态替换 → 分支死代码消除，实测 `out/preload/` 仅含门控壳与 chunk，不加载）
3. 渲染入口：`src/renderer/main.tsx` — `import.meta.env.DEV && probe ∈ {m3p1,m3p2,m3p3}` 动态导入替代 App 挂载
4. 构建校验：`apps/desktop/scripts/verify-probe-isolation.mjs`，纳入 `package:verify`（`pnpm build` 后 `out/renderer` 对 `m3p1/m3p2/m3p3/probeDesktop/AIVS_M3_PROBE` 零命中 ✓，`out/preload`/`out/main` 无探针名 ✓——运行记录见 §A.4）

### A.2 运行基线与运行记录

- 代码基线：`dd82033`（工作树含未提交探针代码运行；探针代码随本报告提交）
- 运行时间：2026-09-05 12:00–15:20（本地），全部探针在同一次开机会话内顺序运行
- 运行命令：`tools/m3_0/run_electron_probe.py {m3p1|m3p2|m3p3}`（electron-vite dev + 环境变量门控）
- 桌面端日志：`%APPDATA%/@aivideo/desktop/logs/desktop.log`（含每轮 probe done 摘要与 renderer console 采集，仅探针门控开启时采集）

### A.3 生产路径零改动 diff 报告

对 HEAD（`dd82033`）的全部生产文件改动共 4 个、+46/−4 行：

| 文件 | 改动 | 行数 |
|---|---|---|
| `apps/desktop/electron/main/index.ts` | 探针钩子：import、`probeIpc` 模块变量、`registerProbeIpc` 调用、`probeLoadQuery()` 注入、render-process-gone 计数、probe 门控的 console 采集 | +13/−1 |
| `apps/desktop/electron/preload/index.ts` | 尾部双条件动态导入 probe-bridge | +4 |
| `apps/desktop/src/renderer/main.tsx` | 探针分支（DEV 门控动态导入）替代直接 App 挂载；styles.css 改静态导入 | +25/−3 |
| `apps/desktop/package.json` | `package:verify` 前置 probe-isolation 校验；新增 `verify:probe-isolation` script | +2/−1 |

生产渲染管线（`services/core/**`）、交互预览（App.tsx）、票据协议（restricted-media.ts）、任务系统零改动 ✓（`git diff HEAD --stat` 全量可复核）。`rendering/ffmpeg.py`、`rendering/plan.py` 等仅被**只读调用**。

### A.4 构建 grep 校验记录

```
[probe-isolation] ok: out/renderer clean (5 files scanned)
[probe-isolation] ok: out/preload clean (2 files scanned)
[probe-isolation] ok: out/main has no probe names (1 files scanned)
[probe-isolation] PASS: probe code is absent from production bundles
```

---

## B. 证据集合 b：硬件与环境记录

| 项 | 值 | 与冻结协议对照 |
|---|---|---|
| 机型 | Intel NUC11PAHi7（i7-1165G7 @ 2.80GHz，32GB） | 与冻结写入一致 ✓ |
| GPU 适配器（探针断言） | `ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)` | 非 SwiftShader/llvmpipe ✓（R7 免疫）；以 Iris Xe 为准、忽略 OrayIddDriver 虚拟适配器 ✓ |
| GPU 驱动 | 31.0.101.3222 | 与冻结写入一致 ✓ |
| 显示器 | 3440×1440，**60 / 75 / 100Hz 三档实测**（另有 OrayIddDriver 虚拟适配器；切换经 `tools/m3_0/set_hz.ps1`，ChangeDisplaySettingsEx） | 首轮 75Hz 属协议偏差，后已按冻结条件 60Hz 复测并加测 75/100Hz（§1.2）；偏差 D1 关闭 |
| DPR / 缩放 | 1.0 / 100% | ✓ |
| 窗口 | 1440×960（代码默认），探针期间前台 | ✓ |
| Electron / Chromium / Node | 36.2.1 / 136 / 22.15.0（`process.versions` 实测） | ✓ |
| FFmpeg | `resources/ffmpeg/win-x64/ffmpeg.exe`，版本见 `p2/baseline/baseline_manifest.json` | ✓ |
| 硬解路径证据 | `VideoDecoder.isConfigSupported({codec:"avc1.640028", hardwareAcceleration:"prefer-hardware"})` = **supported** | ✓ |
| 电源 | 未强制插电/高性能计划（未协议化控制） | **协议偏差 D2**：未验证电源计划对结果的影响；P1 数据为插电常态 |

---

## C. 证据集合 c：全部原始数据（索引）

| 数据 | 文件（`evidence/m3_0/`） | 入库 |
|---|---|---|
| 素材 SHA-256 总清单 | `sha256_manifest.json` | ✓ |
| 固定测试工程 document / plan / **中立 IR** / 采样帧表 | `p2/document.json`、`p2/plan.json`、`p2/ir.json`、`p2/sample_frames.json` | ✓ |
| P1 三轮逐帧 task_ms/interval 原始序列 + scrub 100 样本（种子 20260904） | `p1/m3p1_result.json` | ✓ |
| P1 no-mipmap A/B 轮 | `p1_nomipmap/m3p1_result.json` | ✓ |
| P2 基准端清单（FFV1 SHA-256、提取命令、媒体校验） | `p2/baseline/baseline_manifest.json` | ✓ |
| P2 逐帧 PSNR/SSIM/相位相关/字幕 IoU + 判定 | `p2/baseline/comparison.json` | ✓ |
| P2 第 0 步自校准（提取确定性、601/709 失配、GL 底噪逐帧） | `p2/step0_calibration/step0.json` | ✓ |
| P3 三路×三材质原始 100 样本 + 步进 + 缓存统计 | `p3/m3p3_result.json` | ✓ |
| FFV1 基准（baseline.mkv / baseline_nocap.mkv / second_ref_h264.mp4，1830 帧） | `p2/baseline/*.mkv|mp4` | 本地（SHA-256 已入库） |
| GL 合成端采样帧 PNG（37 帧 + 11 无字幕帧）、基线采样帧 PNG | `p2/baseline/gl*/`、`p2/baseline/frames/` | 本地（不入库） |

固定种子：P1 scrub = `20260904`，P3 = `20260905`（mulberry32，实现公开于 `common/stats.ts`，可复算）。

---

## 1. P1 合成性能探针（§7.1）

### 1.1 方法

四层隔离入口加载 `?probe=m3p1`；WebGL2 合成器消费固定测试时间线 IR（V1 主轨 + 2 PiP 覆盖轨 + 字幕层，5×1080p 视频输入经 `aivideo://` 票据）；rAF 驱动 30fps 内容帧节奏连续播放 3 轮 × 1800 帧；固定种子随机 scrub 100 次。视频元素以 200px 可见缩略图呈现（离屏 video 会被 Chromium 节流——校准阶段实测发现并修正）。

### 1.2 结果

**首轮（75Hz，旧测量口径）发现测量污染**：渲染循环内每 150 帧调用一次 `getGPUInfo("complete")`（GPU 指标采样）造成 ~1s 级停顿（循环 max 462–594ms），将节拍与掉帧数据污染至 36–38ms / 7.4–8.1%。将采样移至轮次边界后，在 **60 / 75 / 100Hz 三档刷新率**（`set_hz.ps1` 程序切换）下以修正口径（vsync 锁定合成器：每 rAF 提交一个合成任务；内容帧间隔另列）重测：

| 刷新率 | 循环节拍 p50/p95 (ms) | 内容帧间隔 p50 (ms) | 掉帧率（三轮） | 数据文件 |
|---|---|---|---|---|
| 60Hz（冻结条件） | 16.7 / 17.4 | 33.3（精确） | **0% / 0% / 0.61%**（首轮含解码器冷启动） | `p1_60hz/m3p1_result.json` |
| 75Hz | 13.3 / 13.7–14.5 | 37.7–38（rAF 量化，均值 33.3） | **0.61% / 0.22% / 0%** | `p1_75hz_new/m3p1_result.json` |
| 100Hz | 10.0 / 10.4–11.1 | 30.2–30.4（rAF 量化，均值 33.3） | **0.39% / 0% / 0%** | `p1_100hz/m3p1_result.json` |

- 合成任务提交 p95 = 0.1–0.4ms（三轮×三档全部 ≪ 33.3ms 预算）；
- **掉帧率三轮中位 = 0%，最差 0.61% < 1% 门**（最差轮均含首轮解码器冷启动停顿，max 103–133ms）；
- **渲染循环节拍 p95 = 10.4–17.7ms ≤ 33ms**（三档均满速率运行——75Hz 半速率假设被复测否定）；
- scrub（100 次，mediaTime 偏差全部 ≤1 帧）：p95 = 565–592ms，冷/热无显著差异；
- GPU 进程内存：轮次边界采样，见 `gpu_memory_samples`；
- WebGPU 对照路径：已运行但结果未落盘（实现缺项记录，非门判据）。

历史数据（污染轮，留档）：`p1/m3p1_result.json`（75Hz 旧口径，36–38ms/7.4–8.1%）与 `p1_nomipmap/m3p1_result.json`（no-mipmap A/B）。

### 1.3 归因

- 合成本身（上传后的 draw+submit）p95 0.2–0.4ms → **WebGL2 三轨合成在 Iris Xe 上算力余量极大**；
- 首轮的节拍异常与掉帧全部由探针自身的 GPU 指标采样停顿造成——**测量方法学发现：`getGPUInfo("complete")` 不得在渲染循环内调用**（M3 引擎的遥测设计约束）；
- 内容帧间隔在 75/100Hz 下呈 rAF 量化偏移（75Hz 下 33.3ms 边界落在 13.3ms 刻度之间 → p50 37.7ms），均值恒等于 33.3ms，无帧丢失；
- scrub 565–592ms 为**多输入顺序 seek**所致（每个目标帧顺序 seek 2–5 路 1080p 视频，每路 seek+呈现 ~100–250ms）；单路 seek 实测仅 13–27ms（见 P3）——**scrub 瓶颈在解码寻址编排，不在合成**。

### 1.4 P1 判定

- 掉帧率（<1%）：**达标**（三档刷新率三轮中位 0%，最差 0.61%）；
- 任务起始间隔 p95（≤33ms）：**达标**（10.4–17.7ms）；
- 合成任务预算：**达标**（0.1–0.4ms ≪ 33.3ms）；
- scrub p95（≤100ms）：**不达标**（565–592ms）——多路并行 seek 编排是 M3 引擎的设计任务，非能力缺口（单路 13–40ms 见 P3）。

---

## 2. P2 逐帧一致性探针（§7.2）

### 2.0 第 0 步自校准（R10 免疫）

校准时间线：色卡 A --fade 0.5s--> 色卡 B（同素材 960×540 画布，`p2/step0_calibration/`）。

| 项 | 结果 |
|---|---|
| FFV1 两路提取确定性 | **逐位一致（PSNR = ∞）** ✓ |
| 601/709 矩阵失配量化 | **27.82dB**（同帧双矩阵提取 PSNR——证明钉死 BT.709 的必要性） |
| GL 合成器 vs FFmpeg 底噪（13 帧逐帧） | **31.41–38.59dB（min 31.41）** |

**底噪 31.4dB < 40dB 门**：该底噪是两条 YUV→RGB/缩放算法栈的系统性差异（libswscale 双三次缩放 + 双线性色度上采样 + 定点系数 vs GPU mip-trilinear/显式 LOD + 着色器 BT.709 浮点），在平滑渐变帧上表现为通道级偏置（实测 B 通道 +5~10），灰阶帧最优（38.6dB）。**此为 P2 硬门不可达的约束性因素**——即使语义完全一致，40dB 也不可达。

### 2.1 比对管线（口径先于实现钉死）

- 基准端：FFV1（mkv，yuv420p 域无损）**直调生产链路**（compile → ffprobe → build_ass → build_timeline_args → run_timeline_render），encoder 替换 ffv1，`-movflags/-b:v` 摘除；生产 H.264（libopenh264）另存第二参考口径；
- 帧对齐：输出 CFR 30fps，采样以帧索引 n（n ↔ PTS n/30）定义，GL 端按 IR 逐帧数值表渲染对应帧（帧源 = WebCodecs 解码，见 §4.4 实现偏差 V1）；
- 色彩：素材 BT.709 colr 钉死 + PNG 提取 `scale=in_color_matrix=bt709` + 解码器 config colorSpace bt709 + 着色器 BT.709 limited→full；
- 比对：ffmpeg `psnr`/`ssim` 滤镜于 gbrp（RGB 平面）空间；几何错位 = FFT 相位相关（±8px）；字幕帧 = 文本掩码 IoU + 中心偏移 + 全帧 diff 比率（与无字幕对照帧相减），不计入硬门。

### 2.2 采样（37 帧 ≥ 24，覆盖全子集）

转场起止±1/中点（7）+ 黑底填充（2）+ 关键帧区间非端点（7）+ PiP1/PiP2 叠加帧（8）+ 字幕激活帧（11，其中 4 帧与 PiP 重叠）+ 普通帧（10）。转场区间 ∩ 活动字幕 = ∅ ✓。

### 2.3 主时间线结果（`p2/baseline/comparison.json`）

- **几何错位：26/26 非字幕帧全部 (0,0)px（±8px 搜索窗内无平移）**——语义/时序/几何全对齐；
- 字幕帧 11/11：文本掩码 IoU 0.376–0.453，文本中心偏移 ≤5px（libass vs Canvas2D 光栅化+定位差，预期系统差，不计硬门）；
- 非字幕帧（26 帧）PSNR：无 PiP/无旋转帧 31.0–35.4dB；PiP/速度/转场/快速运动帧 19.1–27.9dB（最低 n=510，19.10dB）；字幕帧（11 帧，不计门）14.8–16.5dB；（勘误 E1/E2，LiuKeAi 验收）
- **判定：未达 40dB 硬门**（判据适用 26 个非字幕帧；区间 19.1–35.4dB < 40dB，根因见 §2.0 底噪与 §2.4 归因）。

### 2.4 PSNR 归因（逐层剥离，证据链完整）

1. **算法栈底噪（31.4dB）**：见 §2.0——约束性因素；
2. **权威端 rotate 单位缺陷（PiP 帧）**：见 §4.5-(b)——`transform.rotate=8`（UI 度数）被权威端按 **8 弧度（≈98°）** 渲染；GL 端已复刻该实际行为，残余为旋转采样滤波差异（GL 双线性 mip vs swscale 旋转重采样），PiP 区域 MSE 显著；
3. **速度段帧选择口径**（B 段 0.8×）：fps 滤镜取帧的 floor/nearest 口径差 ±1 帧，快运动内容下 PSNR 降至 ~20dB；
4. 字幕帧不计硬门 ✓。

### 2.5 实现偏差记录（探针实现自身）

- **V1（帧源切换）**：P2 合成端先以 `<video>.currentTime` 步进实现，实测暂停视频 rVFC 不触发、`texImage2D(video)` 取到陈旧帧（呈现语义不透明）→ **帧源改用 WebCodecs（worker 手写 BMFF + VideoDecoder，colorSpace 钉死 bt709）**，帧号精确寻址；P1 仍用 `<video>`（实时播放语义正是其考察对象）；
- V2（视频可见化）：离屏 `<video>` 被 Chromium 节流（seek 后不呈现）→ 探针视频以 200px 可见缩略图呈现；
- V3（preserveDrawingBuffer）：readback 与分步绘制存在 await 边界 → 开启 preserveDrawingBuffer；
- V4（共享输入转场）：转场左右帧先采集后同步绘制（绘制中途不得 await）。

### 2.6 P2 判定与 ADR 事项（已决）

**原 40dB 硬门未达**；经项目所有者 2026-09-05 决策，采纳 **[ADR-1 门限相对化](../STAGE_M3_0_ADR_1_P2_GATE.md)**（备选 ADR-2 着色器复刻 swscale / ADR-3 子集收缩 均不采纳），P2 按修订口径**达标**（几何 0px、语义零偏差、PSNR 回归基线 ≥19dB、字幕 IoU ≥0.35 且偏移 ≤8px）。原 40dB 降级为 M3 工程北极星。无任何口径下出现"不可归因漂移"或语义差 → R2 语义差剔除流程未触发。IR 契约冻结草案 v0.1 见 [独立文档](../STAGE_M3_0_IR_CONTRACT_DRAFT.md)。

---

## 3. P3 帧寻址探针（§7.3）

### 3.1 方法

三路对比（同目标集，每材质 100 目标 = 92 固定种子均匀 + 关键帧边界邻域；边界邻域数取决于素材 stss——自产素材 8 个，proxy 参考为全关键帧流故均匀目标补足至 100；±1 步进 30 次；冷/热分离）：
- A：HTML5 `video.currentTime` + rVFC（现状路径）
- B：WebCodecs（DedicatedWorker 内手写 BMFF demux + `VideoDecoder`，`prefer-hardware` supported）
- C：WebCodecs + LRU 长帧缓存（VideoFrame，容量 24，close() 纪律 + 内存记账）

材质：540p 自产 / **1080p 自产** / 生产 proxy 口径（VFR 源转出，`proxy_filter()` 只读复用）。

### 3.2 结果（`p3/m3p3_result.json`，全量 100 样本/材质/路）

| 材质 | 路径 | p50 (ms) | p95 (ms) | max (ms) | 失败 | PTS>1帧 | 黑帧 |
|---|---|---|---|---|---|---|---|
| 540p | WebCodecs | 20.4 | 37.6 | 38.6 | 0 | 0 | 0 |
| 540p | WebCodecs+缓存 | 15.8 | 30.1 | 34.6 | 0 | 0 | 0 |
| 540p | HTML5 | 13.3 | 13.6 | 40.2 | 0 | 0 | 0 |
| 1080p | WebCodecs | 19.1 | 35.1 | 42.1 | 0 | 0 | 0 |
| 1080p | WebCodecs+缓存 | 18.1 | 34.5 | 41.8 | 0 | 0 | 0 |
| 1080p | HTML5 | 13.4 | 26.8 | 53.3 | 0 | 0 | 0 |
| 代理(VFR转出) | WebCodecs | 28.1 | 39.6 | 51.4 | 0 | 0 | 0 |
| 代理(VFR转出) | WebCodecs+缓存 | 20.4 | 38.6 | 48.9 | 0 | 0 | 0 |
| 代理(VFR转出) | HTML5 | 13.5 | 26.8 | 49.4 | **3** | 0 | 0 |

缓存统计：命中 28–54，淘汰 52–78，内存 19–75MB（1080p 缓存 75MB @24 帧，含 allocationSize 记账）。

### 3.3 P3 判定

**通过**：WebCodecs 与 WebCodecs+缓存两路在全部三材质上满足 p95 ≤ 100ms、PTS 偏差 ≤1 帧（100/100）、解码失败/黑帧 = 0。1080p 就绪并已加测 ✓。**主解码路径建议：WebCodecs + 帧缓存**（p50 最优、无失败；缓存对重复邻域命中收益明确）。

意外发现（如实记录）：HTML5 `currentTime` 单路 seek 在本栈上仅 13–27ms（proxy 3/100 超时除外）——现状寻址路径的单路延迟并不差；P1 scrub 的 579ms 来自多路顺序 seek 编排。该发现缩小了 M3 寻址设计的风险面。

---

## 4. 权威端已知近似与缺陷清单（探针发现；缺陷①②已于 456c89a 修复，见 §8）

1. **[缺陷·高→已修复 456c89a] V1 主轨 position 关键帧链超长**：`_keyframe_animation_filters` 的 position overlay 以 `d=timeline_total` 的黑底 lavfi 输入为**主输入**（`eof_action=repeat`），段链输出被撑到时间线总长 → concat 输出超长（实测 61s 时间线渲染 106s：内容 [45,60s)，其后 [60,106s) 为冻结帧，相对时间线末超长 45s），超出 `validate_rendered_media` 容差（±83ms）→ **生产路径上含 V1 position 关键帧的时间线渲染必失败**（单段满长时间线除外）。生产单测仅断言滤镜图文本、未断言渲染时长，故未被发现。证据：`p2/baseline/baseline.mkv`（3180 帧）+ 本报告 §2.3。
2. **[缺陷·中→已修复 456c89a] transform.rotate 单位错位**：数值被原样传给 ffmpeg `rotate` 滤镜（参数单位为**弧度**），UI 度数语义在权威端被按弧度解释（实测 8 度输入渲染为 ≈98° 旋转）。证据：`p2/baseline/` 下 PiP 采样帧对比。
3. **[近似·已冻结] opacity 关键帧 = 整体 fade 渐入近似**（`fade=alpha=1:st=0:d=末关键帧t`）：本探针实证其可见且按预期合成（46.5s 帧 mean=12.8 ≈ 黑底+8% 内容 ✓）。
4. **[近似] PiP overlay 忽略 transform.opacity**（`_pip_overlay_chain` 未消费）。
5. **[已知系统差] 字幕光栅化 libass vs 浏览器**：IoU 0.38–0.45、文本中心偏移 ~4.5px（Canvas2D 基线估算 vs libass 度量），单独口径记录。

以上 1、2 已写入 IR 草案 `known_approximations`（`p2/ir.json`）；修复排期为独立跟进项（LiuWei），不阻塞 M3-0-3。

---

## 5. IR 契约冻结草案输入状态

- 中立 IR 草案 schema：`m3-0-probe-ir-draft/1`（`p2/ir.json`，1830 帧逐帧数值表）——覆盖 §7.2 全部实测子集：canvas、segments（trim/layout/speed/transform）、fade 转场窗口与 offset（借用式压缩语义已与权威端对齐）、黑底填充、position/opacity 关键帧（含 fade 近似）、PiP 内容盒（width/height/SAR 增补 ✓）、已解析字幕样式、白名单硬失败（R11）；
- **实测语义对齐项**：转场借用式 offset（B 段内容从源 0.8s 起）、借用压缩后的内容时间原点（C 段输出 45s 起）、变速段 fps-hold 帧对位（nearest）、PiP 内容盒（含 Python `round` 银行家舍入复刻）、opacity fade 近似；
- **契约草案须携带**：IR `known_approximations` 全文（§4）——红线检查点：草案不得包含任何已知不一致特征，1、2 两项缺陷在权威端修复前，对应语义（V1 position 关键帧、PiP rotate）**不得进入冻结子集**。

---

## 6. 未验证项与剩余风险

| 项 | 状态 |
|---|---|
| ~~60Hz 协议环境复测 P1~~ | **已关闭**：60/75/100Hz 三档复测完成（§1.2），偏差 D1 关闭 |
| 电源计划协议化控制 | 未做（偏差 D2） |
| 探针测量方法学 | `getGPUInfo("complete")` 在渲染循环内调用会造成 ~1s 级停顿（§1.2）——M3 遥测设计约束 |
| WebGPU 对照路径数据 | 已运行未落盘（实现缺项，非门判据） |
| blurred_background / crop_fill 主轨布局、dissolve 等其余转场、scale/rotate 关键帧、蒙版/抠像/reframe | 不在实测子集（§7.2 白名单），维持"仅权威预览"口径 |
| 音频（acrossfade/音画同步） | 不在 P2/P1 范围（P1 视频静音播放） |
| VFR 源直解（未经代理） | P3 材质为代理口径转出；直解 VFR 未测 |
| ~~逐帧一致性的 ADR 决策~~ | **已决**：ADR-1 采纳（2026-09-05），P2 按相对化口径达标 |
| 独立跟进项（冻结时在案） | M2_B3 文档残留清理、`ffmpeg.py:103–107` 注释对齐——另有本报告新增缺陷 1、2 待排期 |

## 7. M3 立项建议（供 Gate M3-0-3）

- **合成引擎能力成立**：WebGL2 三轨合成任务耗时 0.1–0.2ms 级（Iris Xe），算力余量两个数量级；R1 无需触发；
- **架构方向证实（R4）**：Core 生成 IR（逐帧数值表）+ Renderer 只消费 的实现全程无插值/借位二义性，几何 0px 对齐——"预览=导出"的语义层可行性已证；
- **带约束立项**：①解码路径建议 WebCodecs+帧缓存、scrub 需多路并行寻址编排设计，②权威端缺陷 1、2 修复排期（position 关键帧/rotate 修复复测后方可入冻结子集）；逐帧一致性 ADR 已决（ADR-1）；
- 探针代码按 §8 保留至 M3-0-3 结束，处置决定记入放行记录。


---

## 8. 缺陷修复与重基线化记录（Gate 后追加，2026-09-05）

按 [ADR-1](../STAGE_M3_0_ADR_1_P2_GATE.md) §3-5 重基线化条款执行（修复 commit `456c89a`）：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 缺陷① position 关键帧链超长 | 61s 时间线渲染 106s（校验必失败） | overlay `shortest=1`，渲染 1800 帧整；新增渲染时长集成测试 |
| 缺陷② rotate 弧度错位 | 8° 输入渲染 ≈98° | `'{val}*PI/180'`（两处静态路径与关键帧路径对齐）；新增度数语义像素三角验证（0/15/360°） |
| 非字幕帧 PSNR 最低 | 19.10dB（n=510） | **20.19dB（n=570）**，旋转受影响帧 +2~3.2dB |
| 回归门（ADR-1 §3-3） | ≥19dB | **≥20dB**（重基线化） |
| IR 输出时长模型 | 1830 帧（时间线口径） | 1800 帧（借用压缩口径，与修复后渲染一致） |

诚实记录：ADR 预测"PiP 帧恢复至 ≥28dB 档"**未实现**——旋转重采样滤波残差（GL mip/双线性 vs swscale）仍在，属 ADR-2 北极星路径范围；几何错位保持 0px（1 帧 1px 量化位移，门内）。IR 契约冻结草案随之升级 **v0.2**（position 关键帧与 rotate 按重入条件纳入，[见契约 §4](../STAGE_M3_0_IR_CONTRACT_DRAFT.md)）。比对工具复算数据：`p2/baseline/comparison.json`（重基线化后）。

# 预览引擎、缩略图与合成流畅度需求规格

> 状态口径统一见 [`../STATUS.md`](../STATUS.md)（Rule 1 / Rule 5）；本文件整合原 P231 预览画布模型重构、P232 素材级缩略图预抽（filmstrip）与 P227 预览流畅度收口三份冻结规划规格。

---

## 1. 预览画布模型与全轨道自由排版（P231）

> 本节裁定 IR 投影、权威渲染与预览合成器三处数据模型的统一盒模型、转场/关键帧契约随迁范围及 UI 门控边界；转场**不扩展**到跨轨道（§1.5 Q5）。

### 1.1 现状基线（2026-11-17 勘察要点）

1. **IR 投影原按 `track_id == "V1"` 二分**：`visual` 链仅收 V1，`overlays` 收非 V1；权威渲染 `ffmpeg.py` 同构二分，且 IR 白名单对 V1 拒绝 `mask`/`keying`、对非 V1 拒绝关键帧与转场。
2. **转场锚定原限 V1 邻接**：`_transition_successor` / `_transition_neighbors` / GC 全按 V1 口径。
3. **Desktop 合成器与 PiP 手势层已是盒模型**：`compositor.ts` / worker、`PreviewPipOverlays.tsx`、`SyntheticPipLayer.tsx` 本身不依赖 `track_id` 语义。
4. **UI 与契约门控**：`App.tsx` 六处 V1 过滤、`PropertyPanels.tsx` overlay 门控、`geometry.ts` 仅 V1 转场几何；`contracts` 中 `isTimelineClip` 原将图片限制在 `"V1"`。

### 1.2 冻结设计

#### 1.2.1 统一盒模型（核心裁决）

- **全视觉轨统一入盒**：`visual` 帧装配层包含全部非音频、非隐藏轨片段（V1、V2、T1……）；V1 降级为普通盒子（不再作为独占底板）。
- **黑底公共背景**：画布背景恒黑（`canvas.background`），空档渲染黑填充段（`kind: "black"` 语义不变）。
- **z 序 = 轨道序**：按 `tracks` 数组自上而下顺序绘制，**上层轨道盖下层**；同轨片段按时间排序。
- **IR 帧条目形状（兼容过渡）**：
  ```text
  IrFrame {
    n, t_us,
    main: { kind: "black" } | { kind: "segment", ... } | { kind: "transition", ... },
    layers: Array<IrLayer>,      // 全部非首段可见段，按轨道序（上→下）带 box/transform/effects
    captions: string[],
  }
  ```
  过渡期保留 `main` / `overlays` 兼容字段，避免一次性破坏消费者；后续再把 `main` 并入 `layers`。

#### 1.2.2 转场、关键帧与特效契约随迁

- **转场**：从「V1 时间序邻接」改为「**同轨内**时间序邻接」（`_transition_successor` 按 `track_id` 分组）；仍仅限相邻段；IR 白名单 `ALLOWED_TRANSITIONS` 不变（`fade`/`fadeblack`）；`ffmpeg` `xfade` 与 IR `transition_windows` 对齐同轨口径。
- **关键帧与 mask/keying**：移除非 V1 关键帧拒绝与 V1 `mask`/`keying` 拒绝；全视觉段开放 `position`/`scale`/`rotate`/`opacity` 关键帧（复用 `_keyframe_animation_filters`）与 `mask`/`keying`。

#### 1.2.3 权威渲染、UI 门控、contracts 与 IR 版本

- **权威渲染（`ffmpeg.py`）**：`visual_items` 与 `overlay_segments` 合并，统一走「源 trim → 布局 → 内容盒 × transform →（可选 mask/keying alpha）→ 按轨道序叠加黑底」；空档黑填充、转场借用、A1 混音、变速/倒放预算护栏保持不变。
- **Desktop UI**：放开 `App.tsx`、`SyntheticPipLayer`、`PropertyPanels.tsx` 的非/仅 V1 限制；`geometry.ts` 转场几何改为按轨分组，保留 `MAIN_TRACK_H` 产品行高语义。
- **`contracts`**：`isTimelineClip` 放宽为校验 `track_id` 存在于 `tracks` 且 `kind` 与 `asset_kind` 兼容（视频/图片 → `video` 轨，音频 → `audio` 轨），移除图片仅 `"V1"` 限定；**不改 `PROTOCOL_VERSION`**。
- **IR 版本**：`IR_PROJECTOR_VERSION` 自 `5` 升级（随迭代递增，`ir_disk_cache` 自动失效旧缓存），`IR_SCHEMA` 保持 `"preview-ir-v1"`，移除 `known_approximations` 中关于 PiP 忽略 `opacity` 的过时条目。

### 1.3 实施切片概览

| 切片 | 内容 | 边界 |
|---|---|---|
| **S1（Core IR）** | `ir.py` 全段 `layers` + 解除三处 V1 限制；提升 `IR_PROJECTOR_VERSION`；`ir_window.py` / `ir_disk_cache.py` 同步 | Core `rendering/` |
| **S2（Core 权威）** | `ffmpeg.py` 合并链 + 轨道序 overlay；`input_window.py` 全段 transform 放行；`service.py` 全段 `_rendered_duration_us` | `ffmpeg.py` / `input_window.py` / `service.py` |
| **S3（Core 时间线）** | `timeline.py` 同轨邻接转场与 GC、全轨 `set_image_duration` 涟漪 | `timeline.py` |
| **S4（contracts）** | `isTimelineClip` 放宽 + 图片轨限定移除 | `packages/contracts/src/index.ts` |
| **S5（Desktop 预览）** | `ir.ts` 加 `layers`；`compositor` / `preview-session` / 手势层消费 `layers` | `apps/desktop/src/app/preview/` |
| **S6（Desktop UI）** | `App.tsx`、`PropertyPanels.tsx`、`geometry.ts` 门控与分组改造 | Desktop UI 组件 |
| **S7（测试）** | 迁移 Python 与 Desktop 既有 `"V1"` 夹具及 `contracts.test.ts` 负向断言 | 双侧 tests |

### 1.4 验收标准（A1–A11，每项配负向对照）

| # | 验收项 | 判据 | 证据 |
|---|---|---|---|
| **A1** | 全轨盒模型 | V2 片段在 IR `layers` 中输出完整盒与效果；V1 段渲染等价 | `pytest` (`test_render_ir`) |
| **A2** | 权威/预览一致 | `ffmpeg` 与 IR 合成帧的段盒子几何逐像素对齐 | `pytest` + 真实 `ffmpeg` 对拍 |
| **A3** | 转场同轨邻接 | V2 轨内相邻段可加转场；跨轨拒绝；V1 行为不变 | `pytest` (`test_timeline`) |
| **A4** | 关键帧全轨 | V2 段关键帧在 IR 与 `ffmpeg` 双侧生效 | `pytest` |
| **A5** | mask/keying 全轨 | V1 段不再被白名单拒绝且渲染生效（恢复拒绝即红） | `pytest` |
| **A6** | 黑底公共背景 | 空档渲染黑底；z 序符合轨道自上而下遮挡 | `pytest` + 真机截图 |
| **A7** | UI 手势全轨 | V2 段可 move/scale/rotate/mask | Desktop vitest + 真机 |
| **A8** | contracts 放宽 | `isTimelineClip` 接受任意 `video` 轨的视频/图片；音频仍限音频轨 | `contracts.test.ts` |
| **A9** | IR 缓存失效 | `IR_PROJECTOR_VERSION` 变更后旧缓存条目不命中 | `pytest` (`ir_disk_cache`) |
| **A10** | 回归锁 | 全量 Python + Desktop 用例通过 | `pnpm test:python` + `vitest` |
| **A11** | 隐藏视觉轨预览 | 隐藏层不入帧 `layers`，保留时间线尾长，隐藏段不可见效果不触发整条预览回退 | Core IR 单测 + Electron E2E |

### 1.5 风险对策与裁决记录（Q1–Q5 已冻结）

- **风险对策（逐条记入 STATUS §4）**：R1 `layers` 与 `main`/`overlays` 双轨过渡；R2 `_pip_box`/`_pip_overlay_chain`/`segment_frame` 复用坐标函数；R3 保留 V1 兼容与转场自然 GC；R4 冻结「轨道序优先、同轨时间序」；R5 分批迁移夹具；R6 保持 `MAX_IR_FRAMES` 上限并复用压测。
- **冻结裁决 Q1–Q5**：Q1「适应」比例取**最上层视觉轨首片段**；Q2 copy/cut/paste 快照扩展至**全视觉轨**；Q3 `changePreviewRatio` 批量将全视觉轨 `blurred_background` 改为 `crop_fill`；Q4 保留 V1 行高 `MAIN_TRACK_H`；Q5 转场不扩展到跨轨。

---

## 2. 素材级缩略图预抽契约（P232 / Filmstrip）

### 2.1 方案裁决（复用 B10 派生缓存与后台作业）

| 层 | 方案 | 理由 |
|---|---|---|
| 生成时机 | 导入 / 转录完成即登记低优先级后台作业（同 `waveform`） | Core 拥有源文件且不依赖 Renderer 常驻，不阻塞前台 |
| 生成工具 | Core 单次 `ffmpeg select+tile` 产整条 sprite | 避免逐帧多次拉起进程 |
| 存储复用 | `derived_media_cache` `kind='filmstrip'`（复用内容寻址、盘预算与授权） | 产物为单列 sprite JPEG + 元数据 JSON |
| 消费回退 | 时间线画布优先查 sprite（`ImageBitmap` 常驻），未命中走既有运行时补抽并补录缺格 | 缩放切换新档位时旧档位 sprite 兜底，永不空格 |

> **否决项**：禁止用渲染端 WebCodecs 作为主预抽路径（仅保留作运行时补抽兜底）。

### 2.2 产物契约（filmstrip sprite）

- **`params`**：`{ step_ms }`——源时间阶梯档位（对齐 `1 · 2 · 2.5 · 5 × 10^n ms`，参照 `thumb-cache.ts ladderStepMs`）；同档位内缩放不重抽（覆盖 ≤ 2.5× 稀疏）。
- **`sprite` 规格**：单列 JPEG，格宽固定 `160px`，格高按素材显示宽高比计算；元数据 JSON 为 `{ step_ms, cell_w, cell_h, count, duration_us }`。
- **缓存表条目**：`derived_media_cache` 中 `kind='filmstrip'`，`params_json` 记录 `step_ms` 档位。

### 2.3 切片与历史衔接

- **Slice 1（Core）**：`media/filmstrip.py` 生成 sprite 与 `run_filmstrip_job`；`jobs.py` 增加 `filmstrip` 分派；`app.py` 暴露 `create/lookup` 与 `internal/media` 路由（无需新建迁移，复用 v44 / B10 表）。
- **Slice 2（contracts）**：`JobKind` 增 `"filmstrip"`，新增 `FilmstripRequest`/`Response` DTO，**不动 `PROTOCOL_VERSION`**。
- **Slice 3（Desktop）**：`performance-ipc` 提供 `filmstrip:media` handler；导入/转录回调异步触发 `ensureFilmstrip(assetId, stepLadder)` 并按 `WaveformCache` 退避轮询。
- **Slice 4（画布查表）**：`ThumbnailLoader` 增加 `SpriteFrameSource`，优先查表后再落回运行时 `filmstrip worker`，并保留 `P230-②a` 的 busy 重排/余量放宽/失败降级兜底逻辑。

### 2.4 验收（§5）

- 自动化：`filmstrip.py` 阶梯档位/tile 参数/元数据纯函数单测、`jobs` 分派单测、`contracts` 往返解析单测。
- 真机：导入 20 素材后任务页出现批量 `filmstrip` 作业；拖素材上轨即刻出帧；放大时间线跨档位后台重抽期间由旧档位 sprite 顶替，无空白格。

---

## 3. 预览流畅度与硬件解码收口（P227）

### 3.1 问题陈述与核查结论

| 环节 | 现状 | 结论 |
|---|---|---|
| fps 感知解码预算（原 Slice 1） | 预览时钟与 Core `ir.py FPS = 30` 为编译期常量 | **否证，不做**（不存在非 30fps 素材触发预算误判） |
| 帧上传路径（Slice 2） | WebGL2 `direct` 在 D3D11 常退化为内部拷贝、`copyTo` 往返耗时 ~42ms | **采纳 WebGPU 零拷贝合成器**（Electron 36 / Chromium 134 可用 `importExternalTexture`） |
| 假硬解诊断（Slice 3） | `prefer-hardware` 成功但实测 p95 192.3ms 时原有 UI 提示失明 | **采纳保守的实测超预算提示**（建议用户生成代理） |

### 3.2 架构边界（不变项）

- Electron 壳、Python sidecar、IR 契约、`DrawCommand` 协议、`CompositorWorkerClient` 接口、WebAudio 与 decode-worker **全部不动**；不新增 IPC、迁移、也不改 `PROTOCOL_VERSION` 或 AI 白名单。
- WebGL2 路径原样保留为回退通道；WebGPU 在同一 `compositor-worker.worker.ts` 内依据 probe 自动选择，保持同构会话级自愈机制。

### 3.3 WebGPU 零拷贝合成器

- **路径选择**：`init` 时一次探测 `navigator.gpu` → `requestAdapter` → `device` → `canvas.getContext("webgpu")`，成功走 `"webgpu"`（`frameUploadMode = "external"`），否则回退 `"webgl2"`。
- **运行期自愈**：先尝试 `importExternalTexture(frame)`；若句柄过期则该帧降级 `copyExternalImageToTexture`；若仍异常则会话级回退重建 `webgl2` worker。诊断开关 `forceCopyTo=1` 下直接使用 `copyExternalImageToTexture`。
- **绘制语义对齐**：全量覆盖现有 `DrawCommand` 集——`draw`（external RGBA 直出或 RGBA 纹理采样）、`fill`（÷4 → ÷16 两级下采样模糊垫底 pass）、`captions`（OffscreenCanvas 2D → `copyExternalImageToTexture`）、`chroma phase / texSwap / rotation / mask / keying`（WGSL 与 GLSL 同式）。
- **呈现与 readback**：`context.configure({ device, format, alphaMode: "opaque" })`，readback 走 `copyTextureToBuffer` 独立编码。
- **验收映射（§3.4）**：路径选择单测（`navigator.gpu` 缺失 → `webgl2`、`forceCopyTo` → 禁用 `external`）、`DrawCommand` 序列同构单测、Desktop 全量回归绿，以及 `VITE_AIVS_GPU=1` 构建下的 4K 真机压测与多显卡驱动矩阵回退检查。

### 3.4 软解实测推断提示（§4）

- **保守判据（§4.1）**：仅当 `decode_hardware === "prefer-hardware"` 且同一素材 `decodeBudget().over_budget === true`（p95 > 33.3ms，样本 ≥ 30）持续成立时，才追加提示「硬解请求已发出但实测解码超预算，疑似实际软解——建议生成代理素材」；不自动改写 `preferFfmpeg` 状态机。
- **验收与负向对照（§4.2）**：覆盖 `over_budget + prefer-hardware`（出提示）、`no-preference`（走既有文案）、预算内（无提示）三条正负用例，及断开判据与文案连线的变异验证。

### 3.5 风险与灰度 Flag

- 风险与对策：`importExternalTexture` 驱动 quirk 与 `frame.close()` 竞态（probe 首帧校验 + pass 提交前不 close）、`device.lost` 触发既有上下文重建链路、readback 探针默认维持 WebGL。
- **灰度开关**：`VITE_AIVS_GPU=1` 仅用于诊断构建开启 WebGPU；默认不开启以保证发布行为与基准一致，待真机矩阵核销后再行决定是否翻为默认。

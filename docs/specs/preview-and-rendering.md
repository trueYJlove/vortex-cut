# 预览与权威渲染引擎规格

> 本文整合预览画布统一盒模型（P231）、权威合成 IR 契约与已知系统差（M3-0）、素材级缩略图预抽（P232）、合成流畅度与 WebGPU 后端（P227）及运行护栏（A07 / C20 v2 / C23 / L8）。
> 当前交付与核销状态统一见 [`../STATUS.md`](../STATUS.md) 与 [`../BACKLOG.md`](../BACKLOG.md)。

---

## 1. 预览画布模型与全轨道自由排版（P231）

### 1.1 统一盒模型（核心裁决）

- **全视觉轨统一入盒**：`visual` 帧装配层包含全部非音频、非隐藏轨片段（`V1`、`V2`、`T1`……）；`V1` 降级为普通盒子（不再作为独占底板）。
- **黑底公共背景**：画布背景恒黑（`canvas.background`），空档渲染黑填充段（`kind: "black"`）。
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
  过渡期保留 `main` / `overlays` 兼容字段，后续再把 `main` 并入 `layers`。

### 1.2 转场、关键帧与特效契约随迁

- **转场**：从「`V1` 时间序邻接」改为「**同轨内**时间序邻接」（`_transition_successor` 按 `track_id` 分组）；仍仅限相邻段（不扩展到跨轨道）；`ALLOWED_TRANSITIONS` 与 `ffmpeg xfade` / IR `transition_windows` 对齐同轨口径。
- **关键帧与 `mask`/`keying`**：移除非 `V1` 关键帧拒绝与 `V1` `mask`/`keying` 拒绝；全视觉段开放 `position`/`scale`/`rotate`/`opacity` 关键帧与 `mask`/`keying`。
- **渲染、UI 与契约口径**：
  - `ffmpeg.py` 将 `visual_items` 与 `overlay_segments` 合并走统一链（源 trim → 布局 → 内容盒 × transform → 可选 mask/keying alpha → 按轨道序叠加黑底）。
  - `contracts` `isTimelineClip` 放宽为校验 `track_id` 存在于 `tracks` 且 `kind` 与 `asset_kind` 兼容，移除图片仅 `"V1"` 限定（不改 `PROTOCOL_VERSION`）。
  - 冻结裁决 Q1–Q5：「适应」比例取最上层视觉轨首片段；copy/cut/paste 快照扩展至全视觉轨；`changePreviewRatio` 批量改全视觉轨 `blurred_background` 为 `crop_fill`；保留 `V1` 行高 `MAIN_TRACK_H`；转场不跨轨。
  - 隐藏视觉轨：不入帧 `layers`，保留时间线尾长，隐藏段不触发整条预览回退。
  - **权威端统一盒护栏（A2/A4/A5 对齐）**：基底轨（最下层视觉轨；缺 `track_index` 时回退 `V1`）短于上层视觉轨终点时以黑底画布承接 `[vcat]`（并按需延长 `[acat]`）避免上层截断；带 `mask`/`keying` 或内容盒 `transform` 的基底段在基底槽输出黑帧、仅在 `_pip_overlay_chain` 单绘一次（杜绝双绘重影与蒙版/抠像失效）；`_pip_overlay_chain` 与 IR `_layer_entry` 同式消费静态 `transform.opacity` 与 `keyframes`（`position` / `rotate` / `opacity`）；A2 逐像素对拍由 `services/core/tests/integration/test_p231_a2_pixel_parity_real.py` 锁定（`dx=0, dy=0`、PSNR 与盒边界验证）。

### 1.3 验收标准（A1–A11）

| # | 验收项 | 判据 |
|---|---|---|
| **A1** | 全轨盒模型 | `V2` 片段在 IR `layers` 输出完整盒与效果；`V1` 等价 |
| **A2** | 权威/预览一致 | `ffmpeg` 与 IR 合成帧的段盒子几何逐像素对齐 |
| **A3** | 转场同轨邻接 | `V2` 轨内相邻段可加转场；跨轨拒绝 |
| **A4** | 关键帧全轨 | `V2` 段关键帧在 IR 与 `ffmpeg` 双侧生效 |
| **A5** | `mask`/`keying` 全轨 | `V1` 段不再被白名单拒绝且渲染生效 |
| **A6** | 黑底公共背景 | 空档渲染黑底；z 序符合自上而下遮挡 |
| **A7** | UI 手势全轨 | `V2` 段可 move/scale/rotate/mask |
| **A8** | contracts 放宽 | `isTimelineClip` 接受任意 `video` 轨视频/图片；音频限音频轨 |
| **A9** | IR 缓存失效 | `IR_PROJECTOR_VERSION` 变更后旧缓存不命中 |
| **A10** | 回归锁 | 全量 Python + Desktop 用例通过 |
| **A11** | 隐藏视觉轨预览 | 隐藏层不入帧 `layers` 且不触发回退 |

---

## 2. 权威合成 IR 契约与已知系统差（M3）

### 2.1 与 `render-plan-v1` 的关系

- **投影 + 逐帧展开关系，非替换**：权威渲染仍由 Core FFmpeg 管线（`render-plan-v1` → `build_timeline_args`）执行；IR 投影层（`services/core/src/aivs_core/rendering/ir.py`）从 `render-plan-v1` + `ffprobe` 输入几何投影出逐帧数值表 IR，Renderer 只做确定性应用。

### 2.2 核心冻结子集

- **画布与取窗**：输出 CFR 30fps（`n ↔ n/30`），黑底；`inputs[].geometry{width,height,sar}` 归一方像素后计算内容盒；源帧号 `floor(源位置 × 30)`。
- **布局与 PiP**：`fit` 等比缩进黑边居中；中心点 `(cx·W, cy·H)` × `transform.scale`，`transform.rotate` 度数语义。
- **转场**：`fade` / `fadeblack` 借用式重叠，逐帧混合系数 `p = (t − offset) / T`（休眠态转场不入活跃集合）。
- **蒙版与抠像（双端 shader / FFmpeg `rgba-geq` 同式）**：
  - `effects.mask`：`ellipse` 硬边 `clamp(1−d)`、`rect` 硬边 `clamp(1−norm)`、`linear` 软边 `clamp(0.5 + ux/(feather·pw))`，`feather` 将过渡带收进边界内侧 `[1−feather, 1]`；支持 `rotation`（角度）与 `invert`。
  - `effects.keying`：`dist01 = RGB欧氏距离 / (255·√3)`，`≤ similarity` 全透明、`≥ similarity+blend` 全不透明、中间线性；`mask × keying` 相乘。
- **显示方向与竖拍旋转（P206）**：`ffprobe` 扫描完整 `side_data_list` 归一化 `rotation`（含 `-90→270`）；`frame_decode` 加 `-noautorotate` 保证 NV12 平面行宽不花屏；IR `inputs[].geometry` 携带 `display_width/display_height/rotation` 供布局铺满画布；Desktop 合成器按 `needsTextureAxisSwap` 仅对未烘焙原片交换采样 UV 轴（代理已 autorotate 烘焙则不换轴）；权威渲染 `_pip_overlay_chain` 同口径按 `rotation ∈ {90, 270}` 换轴算内容盒（`test_rotation_regression.py`、`test_frame_decode_rotation.py` 与 `rotation-portrait-fill.test.ts` 锁定）；画布比例以项目画布为唯一真源（2026-11-18 已取消「适应」跟随素材）。

### 2.3 双端一致性度量与已知系统差红线

- **度量口径**：几何错位 = `0px`（FFT 相位相关 `±8px`）；语义/时序零偏差；PSNR 回归基线 ≥ `19dB`（静态/慢速 ≥ `31dB`，PiP/快速/效果帧 ≥ `19–20dB`）；字幕 IoU ≥ `0.35` 且中心偏移 ≤ `8px`。
- **已知系统差 / 权威端已知近似**：
  1. **字幕光栅化**（`libass` vs Canvas2D）：文本/时机/位置一致，掩码 IoU 0.376–0.453 属感知等效系统差。
  2. **重采样/色度栈差异**（`libswscale` vs GPU 采样 + 着色器 BT.709）：算法与精度差异，回归门 ≥ `20dB`。
  3. **变速段帧选择口径**（`fps-hold` floor vs nearest）：±1 帧差异。
  4. **`opacity` / `scale` 关键帧与 `keying.invert`**：部分历史路径的权威端近似已由全视觉轨渲染与 `known_approximations` 清单显式约束（双端一致渲染，不作为静默分叉）。

---

## 3. 素材级缩略图预抽契约（P232 / Filmstrip）

- **方案裁决**：Core 导入/转录完成即登记低优先级后台 `filmstrip` 作业（单次 `ffmpeg select+tile` 产单列 JPEG sprite + 元数据 JSON），复用 B10 `derived_media_cache`（`kind='filmstrip'`）；禁止用渲染端 WebCodecs 作为主预抽路径（仅保留作运行时补抽兜底）。
- **产物契约**：
  - `params`：`{ step_ms }`——对齐 `1 · 2 · 2.5 · 5 × 10^n ms` 阶梯档位（覆盖 ≤ 2.5× 稀疏）。
  - `sprite`：单列 JPEG，格宽固定 `160px`，格高按显示宽高比计算；元数据 JSON `{ step_ms, cell_w, cell_h, count, duration_us }`。
- **跨端协作**：`contracts` `JobKind` 含 `"filmstrip"`（不动 `PROTOCOL_VERSION`）；Desktop `performance-ipc` 提供 `filmstrip:media`，`ThumbnailLoader` 优先查 `SpriteFrameSource`，跨档位后台重抽期间由旧档位 sprite 兜底，永不空格。
- **调度与轮询**：`job_scheduler` 将 `filmstrip` 登记为 light 资源、priority 3（低于用户正在看的波形，与 proxy 同档；未登记会按 unknown 保守独占 heavy 槽挡住导出）；Desktop `loadFilmstripsOnce` 每个素材只发一路请求，未就绪时按 `SPRITE_RETRY_BACKOFF_MS`（250ms 起、最多 10 档）退避重试，作业 failed 或 `MEDIA_NO_VIDEO` 时立即放弃并负缓存；`step_ms` 由 `thumbnailStepMs(THUMB_CELL_PX(80px) / pps × 速度)` 单一来源按 1·2·2.5·5×10ⁿ 阶梯取整（与 Core `ladder_step_ms` 同表）。

---

## 4. 合成流畅度、WebGPU 后端与运行护栏

### 4.1 WebGPU 零拷贝合成器与软解推断提示（P227）

- **WebGPU 路径（`VITE_AIVS_GPU=1` 灰度门控，默认 WebGL2）**：`init` 时一次探测 `navigator.gpu` → `requestAdapter` → `device` → `canvas.getContext("webgpu")`，成功启用 `"webgpu"`（`frameUploadMode = "external"` via `importExternalTexture`），句柄过期降级 `copyExternalImageToTexture`，异常会话级回退重建 `"webgl2"` worker。WGSL 与 GLSL 全量覆盖现有 `DrawCommand` 集。
- **假硬解诊断提示**：仅当 `decode_hardware === "prefer-hardware"` 且同一素材 `decodeBudget().over_budget === true`（p95 > `33.3ms`，样本 ≥ `30`）持续成立时，追加提示「硬解请求已发出但实测解码超预算，疑似实际软解——建议生成代理素材」；不自动改写 `preferFfmpeg` 状态机。

### 4.2 关键运行护栏与历史冻结决策

1. **C20 v2 窗口/增量 IR 默认开启（2026-09-13 决策）**：
   - `previewIrV2Enabled()` 默认开启，解除 27,000 帧表传输上限，保留 `VITE_AIVS_PREVIEW_IR_V2=0` 作为显式回退开关（不预设删除时间表）。
   - 已知限制：长时间线随机全谱 seek 取窗等待与首帧 manifest 投影延迟受窗协议约束，长时线约 8 分钟退化追踪见 [`../BACKLOG.md`](../BACKLOG.md#p200)。
2. **A07 重复探测与编码器缓存约束（`media/probe_cache.py`）**：
   - probe 缓存键 = `asset fingerprint + stat(size, mtime_ns) + ffprobe build`；同任务相同输入仅探测一次；初始并发 ≤ 2，缓存 ≤ 256 条；失败短暂缓存（5s），文件变化立即失效。
   - 编码器可用性与 smoke cache 为进程内 session 缓存（`single-flight`，成功 TTL 30 分钟 / 失败 30 秒），渲染编码失败时清除对应成功缓存并保留软件回退；**禁止缓存「最终输出文件验证成功」**。
3. **C23 长源倒放内存预算护栏（`rendering/ffmpeg.py`）**：
   - FFmpeg `reverse` 滤镜将单段全部解码帧驻留内存（实测极易触发 OOM）；不实施高风险分块倒放实验，改为交付**内存预算护栏 + 显式错误码**，超预算倒放明确失败并提示可操作文案；合成预览对倒放维持 `PREVIEW_IR_UNSUPPORTED`（UI 回退交互预览）。
4. **L8 解码表面池全局自适应预算（`decode-worker.worker.ts`）**：
   - `heldFrameCount()` 统一统计持有窗 + GOP 锚 + LRU 缓存；安全水位上限锁定为 `8`（跨 H.264/HEVC 素材避免表面池占满永久停摆），检测到「静默 + `dq > 0`」时 `shrinkForBackpressure()` 立刻减容让出表面并冻结上调。相关 E2E 回归（`p33-seek-play.electron.spec.ts`）跟踪状态见 [`../BACKLOG.md`](../BACKLOG.md#p194)。

### 4.3 流需求隔离与 `audio-only` 零视觉解码护栏（P235-R2）

- **流需求真源（`video_required` / `audio_required`）**：`RenderPlan` 与 `PreviewRenderIr`（`IR_PROJECTOR_VERSION`）对每条输入显式标记 `video_required` / `audio_required`；`asset_kind === "audio"`（包括作为音频轨源使用的视频文件）固定 `video_required = false`。
- **`resolution="original"` 分辨率归属**：Core `_project_plan` / 规划期仅对 `video_required = true` 且可见的输入探测源分辨率，`audio-only` 的 4K 视频不参与 `resolution="original"` 画布尺寸判定。
- **Desktop 运行时零视觉/零误解码隔离**：
  - `PreviewSession.assemble()` 通过 `inputNeedsVideo` / `inputNeedsVisual` / `inputNeedsAudio` 仅对 `video_required` 输入创建视频纹理与解码 Rig，不对音频角色输入发起视觉帧解码或 `frame_decode` IPC；
  - `TimelineCanvas` filmstrip sprite 预加载按可见 `asset_kind === "video"` 过滤，不对纯音频用途的视频素材请求/触发 `filmstrip` 缩略图；
  - `usePreviewPlayback` 为视频素材的 `audio-only` 音频角色保留原始素材音频播放票据（不与带视觉 proxy 混淆路径），避免音频路径误绑定到无音轨或重编码 proxy。
- **权威渲染（`ffmpeg.py` / `service.py`）零视觉解码**：`ffmpeg.py` 对 `asset_kind == "audio"` 且非静默占位输入加 input-side `-vn`，对静默音频角色片段（禁用/倒放/`has_audio=False`/越界 EOF）直接跳过 `-i` 改以 `anullsrc` 合成并重映射后续输入序号与黑场兜底索引；`RenderService._project_plan` 与 `run` 对无需视频与音频探测的非图片输入跳过 `_probe`（已由 `test_p235_r2_decode_cost_parity_real.py` 对 4K 视频做真实 FFmpeg `0` 视觉解码线程与 `0` decoded video frames 验证）。

# WP-P227 预览丝滑收口 Planning Gate

> 角色：LiuWei（架构师）
> 日期：2026-11-17
> 状态：Planning Gate 完成
> 来源：用户实测「预览挺卡」+ 会话内对三项目（Concat/OpenFilm/Vortex Cut）渲染路线对比分析

## 1. 问题陈述

用户真机反馈预览卡顿。会话内代码考古确认现状：

| 环节 | 现状 | 实测证据（代码注释） |
|---|---|---|
| 解码 | WebCodecs `prefer-hardware` 请求成功 ≠ 真机硬解 | 真机 H.264 解码 p95 192.3ms（preview-session.ts 重锚注释）；软解形态的提示只覆盖显式 `no-preference`（SyntheticPreview.tsx:563-676） |
| 帧上传 | direct（texImage2D 直采）仍是 CPU staging 往返 | copyTo p95 ~42ms（compositor-worker.worker.ts:384 注释）；direct 在 D3D11 路径常退化为内部拷贝 |
| 合成 | WebGL2 quad 绘制，p95 0.4ms 非瓶颈 | PHASE2_HANDOFF 实测 |

**三个候选切片的核查结论**：

- **Slice 1（fps 感知解码预算）：否证，不做。** `REALTIME_FRAME_BUDGET_MS = 1000/30` 的前提是预览时钟恒 30fps；Core `ir.py:23` `FPS = 30` 为编译期常量，IR/窗口端点全部输出该值，不存在 25fps 素材导致预算误判的形态。核查记录于此，防止将来重提。
- **Slice 2（WebGPU 零拷贝合成器）：做。** 唯一能让硬解帧不离开显存的 Web 通道（`importExternalTexture`）。Electron 36（Chromium 134）可用。
- **Slice 3（软解实测推断提示）：做。** 「假硬解」（配置成功、实际 D3D11 走 software overlay 或驱动回退）是真机 192ms 的最可能形态，现有 UI 提示对它失明。

## 2. 架构边界（不变项）

- Electron 壳 / Python sidecar / IR 契约 / `DrawCommand` 协议 / `CompositorWorkerClient` 接口签名 / WebAudio / decode-worker：**全部不动**。
- WebGL2 路径原样保留为回退；WebGPU 路径在同一 worker 内按 probe 结果选择，与现有 `frameUploadMode: probe→direct→copyTo` 自愈模式同构。
- 不新增 IPC、不新增迁移、不动 `PROTOCOL_VERSION`、不动 AI 白名单（STATUS.md §1 无字段变化）。

## 3. Slice 2：WebGPU 合成器（compositor-worker.worker.ts 内）

### 3.1 路径选择

```
init 时探测（一次）:
  navigator.gpu 存在? → requestAdapter → device
    → canvas.getContext("webgpu") 成功?
      → 路径 = "webgpu"（frameUploadMode = "external"）
    → 失败 → 路径 = "webgl2"（现有逻辑不变）
```

运行期回退（会话级、与现有自愈同型）：
- `upload` 命令带 VideoFrame：WebGPU 路径先试 `importExternalTexture(frame)` → `GPUExternalTexture` 过期（帧已被 close/复用）时该帧回退 `copyExternalImageToTexture`（GPU-GPU 或 CPU staging，驱动决定）→ 再失败回退整会话切 WebGL2（重建 worker，走现有 direct/copyTo）。
- 诊断开关 `forceCopyTo=1` 时 WebGPU 直接用 copyExternalImageToTexture（B13-R 判别模式延续）。

### 3.2 绘制语义对齐（known_approximation 清单）

WebGPU 首版覆盖与 WebGL2 完全相同的 `DrawCommand` 集：

| DrawCommand | WebGPU 实现 | 对齐说明 |
|---|---|---|
| draw（YUV ring/shadow/image） | external texture（RGBA 直出，YUV→RGB 已由解码器/浏览器完成）或 RGBA 纹理采样 | importExternalTexture 输出为采样后的 RGB；`u_lod`/mipmap 分支退化为 LINEAR（预览已砍 mipmap，等价） |
| fill（模糊垫底） | 两级 downscale：render pass A（÷4 target）→ render pass B（÷16 target）→ 主 pass 采样放大 | 与 WebGL2 ÷4/÷16 FBO 同构，known_approximation 语义不变 |
| captions | 2D canvas 层照旧（ OffscreenCanvas 2D → copyExternalImageToTexture 单纹理） | 上传量小，不动 |
| chroma phase / texSwap / rotation / mask / keying | WGSL 重写（与 GLSL 同式） | yuv2rgb709 仅 external 模式不需要；RGBA 纹理路径保留色度相位（copyExternalImageToTexture 产出 RGBA，色度相位内建于转换） |

### 3.3 呈现

`context.configure({ device, format, alphaMode: "opaque" })`；每 compose 一帧一个 render pass。`preserveDrawingBuffer` 语义（readback 与绘制跨 await）由「readback 走 `copyTextureToBuffer` 独立编码」替代，不受呈现清空影响。

### 3.4 验收（自动化 + 真机）

自动化（本工作包内完成）：
- 路径选择单测：`navigator.gpu` 缺失 → webgl2；`forceCopyTo` → external 被禁用。
- DrawCommand 分派纯函数单测（会话侧生成的命令序列在两路径下同构）。
- 现有 147 文件回归全绿（WebGL2 为缺省路径，现有断言不应感知新路径）。

真机（登记于 STATUS §4 P227，待用户执行后核销）：
- `VITE_AIVS_GPU=1` 构建下，4K 素材 decode/upload/compose p95 对照（预期：upload p95 从 42ms → ≈0，整体帧预算内）；
- webglcontextlost/contextdestroyed 模拟路径回退可用；
- 驱动 quirk 矩阵（Intel/AMD/NVIDIA 各一）回退链不产生黑屏。

## 4. Slice 3：软解实测推断提示

### 4.1 判据（保守，宁缺勿滥）

`decode_hardware === "prefer-hardware"`（请求成功）**且** 同一素材 `decodeBudget().over_budget === true`（实测 p95 超 33.3ms，样本 ≥30）持续成立时，在既有「硬解不可用」提示条位置追加一句：`硬解请求已发出但实测解码超预算，疑似实际软解——建议生成代理素材`。

不自动降级、不改 `preferFfmpeg` 状态机——那是后端可用性问题，这是吞吐问题，两者治理手段不同（降级治「解不动」，代理治「解得慢」）。

### 4.2 验收

- 单测：over_budget + prefer-hardware → 提示出现；no-preference → 走既有文案；预算内 → 无提示（负向对照三条）。
- 变异验证：断开判据与文案的连线 → 用例红（防恒真）。

## 5. 风险

| 风险 | 对策 |
|---|---|
| `importExternalTexture` 驱动 quirk（帧闪烁/句柄失效） | probe 一次 + 首帧校验失败即会话级回退 WebGL2；与 `frameUploadMode` 自愈同构 |
| external texture 生命周期与 `frame.close()` 竞态 | worker 内 import 后立即采样进 pass，pass submit 前不 close；residency 计数延续 |
| WebGPU 上下文丢失（device.lost） | 监听 `device.lost` → 上报 contextLost → 复用现有会话重建链路 |
| readback 探针（m3p5）依赖 WebGL 路径 | WebGPU 路径 readback 走 copyTextureToBuffer；探针默认仍跑 WebGL（发布构建 `VITE_AIVS_GPU` 不开则零影响） |

## 6. Flag 与灰度

- `VITE_AIVS_GPU=1`：启用 WebGPU 路径（诊断构建）；缺省不开，发布构建行为与 HEAD 完全一致。
- 真机验收通过后另立工作包决定是否翻缺省。

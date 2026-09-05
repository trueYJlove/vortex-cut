# M3-1 详细设计：IR 投影端点与合成预览组件（预览合成引擎增量一）

> 设计角色：LiuWei（架构师）
> 状态：草案 v1.0（待评审冻结）
> 日期：2026-09-05
> 上位：[M3 立项建议草案](./STAGE_M3_0_M3_INITIATION_RECOMMENDATION.md)（已放行）、[IR 契约冻结草案 v0.2](./STAGE_M3_0_IR_CONTRACT_DRAFT.md)、[M3-0 技术验证报告](./STAGE_M3_0_TECH_VALIDATION_REPORT.md)、[ADR-1](./STAGE_M3_0_ADR_1_P2_GATE.md)
> 探针资产基线：`8dd435e`（compositor/worker/投影器可毕业组件所在）

## 1. 文档目的

M3 已立项（放行记录 `85005c1`）。本设计定义**增量一（M3-1）**：把 M3-0 验证过的探针链路（IR 投影器、WebGL2 合成器、WebCodecs 解码 worker）毕业为生产组件，打通"revision → IR → 合成预览"的第一条端到端产品路径。后续增量（交互衔接深化、scrub、字幕统一栅格化、音频）在 §8 排期，不在本文展开。

## 2. 范围

### 2.1 必须实现

- **Core**：`rendering/ir.py` 生产投影模块（从 `tools/m3_0/ir_projector.py` 毕业）+ HTTP 端点 `GET /api/v1/projects/{project_id}/preview-ir`；输出按 `content_fingerprint` 缓存复用（沿用权威预览的 stale/复用机制）；
- **契约**：`preview-ir-v1` schema 定稿（探针 `m3-0-probe-ir-draft/1` 的正式化），子集 = [IR 契约冻结草案 v0.2](./STAGE_M3_0_IR_CONTRACT_DRAFT.md)（含 position 关键帧与 rotate 重入）；
- **Desktop**：preload/desktop API 增加 `getPreviewIr`（走既有 ui-token 通道，替代探针门控 IPC）；
- **Renderer**：`src/app/preview/` 合成预览组件（compositor/解码 worker/帧缓存组件化），`crossorigin` 票据复用现有 `aivideo://` 机制；
- **降级路径**：子集外语义（投影器硬失败）或 IR 不可用时，预览回退现状 HTML5 权威预览并提示；
- **回归门落地**：ADR-1 判据（几何 0px、PSNR ≥20dB、字幕 IoU ≥0.35）以探针资产（比对工具+基准时间线+素材）形成可执行的回归测试入口。

### 2.2 明确不实现（增量一）

- 音频（混音/音画同步）——探针未覆盖，维持视频静音预览；
- 蒙版/抠像/reframe、scale 关键帧、dissolve 等其余转场、blurred_background/crop_fill 主轨布局（契约子集外，投影器硬失败）；
- 交互预览 UX 全面替换——增量一以"合成预览视图"共存接入，编辑器主交互仍走现状 HTML5 路径；
- 字幕统一栅格化器（评估项，见 §8）；
- scrub 深度优化（多路并行寻址编排——增量二主题，本增量复用探针的顺序 seek 实现保证可用）。

## 3. 现状与事实基础

| 事实 | 位置 | 对设计的意义 |
|---|---|---|
| 投影器已验证（白名单硬失败、逐帧数值表、借用压缩内容原点、变速 nearest、PiP 内容盒） | `tools/m3_0/ir_projector.py`（LiuKeAi 复算：重生成 IR 与存档 1830 帧逐位一致） | 毕业为 `rendering/ir.py` 时语义零改动，仅工程化（类型、异常、DTO） |
| 合成器/解码 worker 已验证（vsync 锁定节拍、NV12 平面 + 着色器 BT.709、显式 LOD、度数旋转、LRU 帧缓存） | `apps/desktop/src/probes/common/compositor.ts`、`p3-worker.ts` | 组件化搬迁，探针耦合点见 §5.3 清单 |
| 权威渲染两缺陷已修复（渲染时长、rotate 度数语义） | `456c89a`（集成测试：时长 60 帧断言、0/15/360° 三角验证） | IR 输出时长 = 借用压缩口径（1800 帧），与渲染一致 |
| 预览/指纹/复用机制 | `rendering/service.py`（`content_fingerprint`、artifact 复用） | IR 缓存沿用同一 fingerprint 键 |
| Core HTTP 模式 | `app.py`（`@app.get` + `require_ui` + `_domain`/`_error` 异常映射） | 端点照此模式新增 |
| Desktop API 模式 | `preload/index.ts`（contextBridge）+ `electron/main/index.ts`（ipcMain.handle → fetchWithUi） | `getPreviewIr` 照此模式 |
| 渲染时长/旋转回归测试 | `services/core/tests/integration/test_transform_render_real.py` | 已堵住缺陷①②的逃逸缺口，随本增量扩展 |

## 4. 总体架构（数据流）

```mermaid
sequenceDiagram
    participant U as 编辑器（合成预览视图）
    participant R as Renderer（SyntheticPreview 组件）
    participant D as Desktop Main（IPC）
    participant C as Core（/preview-ir）
    participant F as FFmpeg 权威渲染（既有）

    U->>R: 打开合成预览（revision）
    R->>D: desktop.getPreviewIr(projectId, revisionId, outputRatio)
    D->>C: GET /api/v1/projects/{id}/preview-ir?...
    C->>C: compile(render-plan-v1) → ir.py 投影（白名单硬失败）
    C-->>D: {content_fingerprint, preview-ir-v1}（fingerprint 命中则走缓存）
    D-->>R: IR + aivideo:// 票据（既有 assetMediaUrl 通道）
    R->>R: WebCodecs 解码（worker，LRU 帧缓存）→ WebGL2 合成（IR 逐帧应用）
    R-->>U: 30fps 合成预览（+节拍/漂移自检指标）
    F -.-> 既有权威预览/导出（不变）
```

关键架构决策（继承 M3-0 结论）：**IR 全量逐帧数值表、Core 单点计算、Renderer 只应用**；预览与导出的一致性由"同一 render-plan 语义"保证，像素层为 ADR-1 感知等效口径。

## 5. 详细设计

### 5.1 Core：`rendering/ir.py` 投影模块

- **入口**：`project_preview_ir(plan: dict, probes: dict[str, dict]) -> dict`——签名与探针版一致（plan 来自 `RenderPlanCompiler.compile`，probes 来自 `ffprobe`）；纯函数、无 IO（探针实证可重入复算）。
- **白名单硬失败**（继承 R11）：遇子集外语义抛 `DomainError("PREVIEW_IR_UNSUPPORTED", message, feature=...)`；子集清单与 [契约 v0.2](./STAGE_M3_0_IR_CONTRACT_DRAFT.md) §2 一致，单测逐类断言拒绝（探针 check4 的 9 类 + rotate/position 重入后的放行断言）。
- **语义要点**（全部来自探针已验证实现，零改动毕业）：借用式转场 offset 与内容时间原点（输出时间轴）、黑底填充、变速 nearest 帧对位、PiP 内容盒（SAR 归一 + 银行家舍入复刻）、opacity fade 近似、rotate 度数语义、字幕样式解析（`CaptionResources` 预设 → 数值样式）。
- **输出时长口径**：借用压缩后的输出时长（1800 帧 @ 61s 时间线，见 M3-0 重基线化记录）。

### 5.2 Core：HTTP 端点与缓存

```
GET /api/v1/projects/{project_id}/preview-ir?timeline_revision_id={rid}&output_ratio={ratio}
```

- `require_ui` 鉴权（与 previews 端点同模式）；`output_ratio` 仅支持 `169`（增量一实测画布 960×540），其余值 400；
- 流程：`compile(revision, output_ratio="169")` → 探针各输入（复用 `FFprobe`，带结果缓存）→ `project_preview_ir` → DTO `{schema:"preview-ir-v1", content_fingerprint, timeline_revision_id, generated_at, ir}`；
- **缓存**：`content_fingerprint`（plan 语义指纹）+ ffprobe 几何 → 内存 LRU（键 = fingerprint；上限 8 条，IR 体量 ~1–3MB/分钟时间线）；fingerprint 未变直接复用（与权威预览复用语义同型，避免重复投影）；
- **失败语义**：`PREVIEW_IR_UNSUPPORTED` → HTTP 409（body 带 `feature` 字段，前端据此提示"该时间线包含实时合成暂不支持的效果"并降级）；revision/输入缺失 → 既有 404 语义；
- **体量护栏**：投影为 O(帧数) 纯 Python，10 分钟时间线 ~18k 帧、IR ~15–30MB——增量一接受（本地回环传输 + 内存缓存）；分页/增量 IR 列为 §8 开放问题。

### 5.3 Desktop：API 通道

- `preload/desktop.ts`：`getPreviewIr: (input) => Promise<PreviewIrPresentation>`（新增类型，contracts 包同步 `PreviewIrDto`）；
- `electron/main/index.ts`：`ipcMain.handle("preview-ir:get", ...)` → `fetchWithUi`；票据沿用既有 `assetMediaUrl`（`aivideo://` + ACAO，renderer 的 video/fetch 直接可用）；
- 探针门控（`probe-ipc.ts`/`probe-bridge.ts`）**保留**但不再是预览数据通道——探针继续作为回归资产运行（放行记录处置决定）。

### 5.4 Renderer：`src/app/preview/` 合成预览组件

从探针毕业的改造清单（探针耦合点 → 生产形态）：

| 探针耦合点 | 毕业形态 |
|---|---|
| `setupProbe`（session/票据/证据目录） | props 注入：IR、票据表（既有 `desktop.listAssets`/`getPreviewIr`）、容器节点 |
| `probeDesktop` 桥 | 删除；诊断写 `console` + 组件错误边界 |
| 视频元素缩略图条（M3-0 节流规避） | 保留可见性策略但集成进组件（合成画布 + 1px 可见性保底的隐藏策略需实测——§7 开放问题 O1） |
| 证据目录 writeArtifact | 删除；指标经组件回调暴露（供测试与诊断） |
| 硬编码 ADR 常量（帧预算/种子） | 常量模块 `preview/constants.ts` |
| 保留原样 | compositor 全部渲染语义、worker BMFF/解码、LRU 缓存、stats |

- 组件 API：`<SyntheticPreview ir={PreviewIr} tickets={Map<assetId, url>} onMetrics={...} onError={...} />`；
- 解码 worker：`p3-worker.ts` 毕业（去探针消息糖衣，保留 demux/decode/缓存）；mp4box.js 评估列为增量二决策（手写版已过验收，非阻塞）；
- **生命周期**：组件卸载必须 `close()` 全部 VideoFrame/Worker（M3-0 已有 close() 纪律）；
- **降级**：`onError(PREVIEW_IR_UNSUPPORTED)` → 编辑器回退 HTML5 预览 + 浮层提示；IR 加载/解码失败同路径。

### 5.5 交互衔接（增量一形态）

- 编辑器时间线工具栏新增"合成预览"开关（feature flag `AIVS_SYNTHETIC_PREVIEW`，默认关，开发期验证后转默认开）；
- 开启时：预览区挂载 SyntheticPreview，播放头拖动 = `seek(targetFrame)`（复用探针 scrub 的 seekVideo/decodeOnce 语义，顺序 seek 编排——增量二优化）；
- 播放：vsync 锁定合成循环（探针同款），30fps 内容帧节奏；

### 5.6 遥测与诊断纪律（M3-0-3 约束继承）

- `getGPUInfo`/重型诊断**禁止在渲染循环内调用**（~1s 停顿实证）；指标采样仅在轮次/会话边界；
- 循环内工件需可独立重算：组件 metrics 回调输出结构化 JSON（帧号、task_ms、间隔、漂移计数），不写不可复算的内部计数；
- 渲染循环内禁止探针式证据写盘。

## 6. 测试与验收

| 层 | 内容 | 工具/位置 |
|---|---|---|
| 单测（Core） | 投影器：子集外硬失败逐类、数值表抽点（转场 p/变速 src_n/内容原点/PiP 盒/字幕样式）、输出时长压缩口径、缓存键 | `services/core/tests/unit/test_render_ir.py` |
| 集成（Core） | 端点：200/缓存命中/409 降级/404；渲染时长回归（`test_transform_render_real.py` 已有） | `services/core/tests/integration/test_preview_ir_api.py` |
| 集成（Renderer） | 组件：`test_pip_rotate_uses_degree_semantics` 同款三角色迁移为 vitest+playwright 断言；节拍门（60Hz 满速率、间隔 p95 ≤ 33ms） | `apps/desktop/tests/`、`evidence/m3_0/` 比对工具 |
| **回归门（ADR-1）** | 合成预览输出 vs FFmpeg：几何 0px、PSNR ≥20dB、字幕 IoU ≥0.35——比对工具 + 基准时间线 + 素材（探针资产，处置已定为保留） | `tools/m3_0/compare_tool.py` + `run_electron_probe` 等价入口 |
| 手动验收 | 60Hz 见证复跑（沿用 M3-0-3 模式） | `tools/m3_0/set_hz.ps1` |

## 7. 风险与开放问题

- **O1 视频可见性与产品形态**：探针用 200px 可见缩略图规避 Chromium 离屏节流；产品画布本身可见，但 PiP 源视频在产品形态下的呈现方式（画中画小窗 vs `opacity:0.01` vs 移出视口）需实测选定——增量一实现期做 A/B 定案；
- **O2 IR 体量与长时间线**：全量数值表对 ≥10 分钟时间线的传输/内存未实测；触发条件（>5 分钟）预留分页/按需投影的设计位（§5.2 护栏），增量二决策；
- **O3 字幕统一栅格化**：Canvas2D 与 libass 的 IoU 差（0.38–0.45）是否可感知——增量二评估（OffscreenCanvas + libass.wasm 或服务端预栅格化）；
- **O4 音频**：未设计；增量二/三按 WebAudio 混音单独立项；
- **O5 mp4box.js vs 手写 BMFF**：手写版已过验收；若 M3 期出现兼容性长尾（非常规 muxer）再引入依赖。

## 8. 里程碑

| 增量 | 内容 | 预估 |
|---|---|---|
| **M3-1（本文）** | IR 端点 + 合成预览组件 + 回归门落地 | 单人 4–5 天 |
| **M3-2（已完成 2026-09-05）** | scrub 并行寻址编排、播放头衔接、O1–O3 落地 | 实际 0.5 天 |
| M3-3 | 音频、长时线优化（O2 分页）、硬化与遥测 | 按需 |

### M3-2 执行记录（2026-09-05）

- **scrub 并行编排达标**：生产 `PreviewSession.seekToFrame` 并行解码 + latest-wins 合并 + 拖拽快速档（快速连续 seek 仅解码主轨，停止 250ms 后全量精修）。m3p4 基准（生产会话，M3-0 时间线）：100 次种子化随机 seek **p95 = 69.4ms ≤ 100ms**（P1 遗留判据闭合，此前多路顺序编排 565–592ms）、p50 = 45.2ms；±1 步进 p95 = 50ms；拖拽模拟 30 次合并 0 超代。数据：`evidence/m3_0/m3p4/m3p4_result.json`（种子 20260906）。
- **O1（视频可见性）关闭**：生产解码路径为 WebCodecs worker（无 `<video>` 元素），不存在离屏节流问题；合成画布本身即产品可见面。探针时期的现象仅适用于 `<video>` 步进方案（已弃用）。
- **O2（IR 体量）落地**：`project_preview_ir` 增加帧数护栏 `PREVIEW_IR_TOO_LARGE`（>27000 帧 = 15 分钟 @30fps），超长时间线 409 降级并提示；分页/按需投影留待实际需求出现（当前产品时间线远低于阈值）。
- **O3（字幕栅格化）评估决策**：IoU 0.38–0.45、中心偏移 ≤5px 属感知等效范围，**暂缓 libass.wasm 统一栅格化**（引入 wasm 运行时的复杂度大于收益）；若用户反馈字幕预览偏差再重启。

## 9. Gate

| Gate | 条件 | 放行物 |
|---|---|---|
| M3-1-1 | 本设计经评审冻结 | 冻结版设计文档 |
| M3-1-2 | 实现 + 回归门通过（ADR-1 判据 + 节拍门）+ 测试报告 | 代码 + 测试报告 |
| M3-1-3 | 独立验收（同 M3-0-3 模式） | 增量放行记录 |

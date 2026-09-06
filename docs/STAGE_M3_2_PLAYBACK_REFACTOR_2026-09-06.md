# M3-2.2 合成预览播放重构与实证（2026-09-06）

## 背景与用户症状

用户实测（真实项目：竖版 1080x1920，V1 双 clip 同源 1920x1080 视频（第二段 1.25x 变速 +
scale 0.87 静态变换），V2 PiP 682x686 屏幕录制）：

- 合成预览播放极卡，与交互预览差距巨大；
- 丢帧 404，任务 p95 0.3ms（合成极快但帧就是不就绪）；
- 画中画（PiP）显示纯绿块，不显示真实内容；
- 此前一轮还出现过"解码失败 I0#210: decode timeout"。

## 复现载体（新增 m3p5 播放探针）

`apps/desktop/src/probes/m3p5.ts`：生产 `PreviewSession` 在**用户真实项目 IR + 真实素材**
上播放全片，250ms 采样丢帧/合成帧/解码 RTT/解码链状态，并在 0.5/3.5/6/9.5/10.1/10.4/10.62s
回读画布 PNG，另含片尾暂停态逐帧对照（postmortem）与全新会话 seek 对照（fresh）。

运行方式：

```bash
python tools/m3_0/run_electron_probe.py m3p5 \
  --ir evidence/m3_2/playback-repro/ir_user_project.json \
  --assets evidence/m3_2/playback-repro/assets.manifest.json \
  --evidence evidence/m3_2/playback-repro/<run-name>
```

IR 由离线脚本按用户 DB（`RenderPlanCompiler` → `project_preview_ir`，canvas 540x960@30，
320 帧）生成，素材映射真实文件路径。

## 基线实测（旧架构，evidence/m3_2/playback-repro/baseline）

| 指标 | 值 |
| --- | --- |
| 合成帧数 / 全片 320 帧 | **36** |
| 丢帧 | 550 |
| 合成间隔 p95 / max | 2635ms / 6206ms |
| 解码 RTT p50 / p95 | 2.1ms / 30ms |
| decode_in_flight（僵尸请求堆积） | **327** |
| 画面 | 冻结在第 ~12 帧；PiP 纯绿 (0,77,0) |

## 根因（全部实证定位）

1. **tick 反应式请求 + 单 `pendingResolve` 覆盖**：播放循环每个 rAF tick 对当前墙钟目标
   发起新解码请求；worker 端单 `pendingResolve` 被后发请求置空——旧 promise 永不落定
   （客户端 15s 超时 → "decode timeout"），且后发请求可被前一帧输出按 33.3ms 容差
   **错配解决**（系统性早一帧）。解码本身极快（p50 2ms），瓶颈全在编排。
2. **只合成"精确目标帧" + 墙钟永不重锚**：`frameReady(target)` 只认墙钟目标帧，已就绪的
   旧帧被直接丢弃；一旦解码链跟不上，目标无限狂奔、丢帧按 tick 线性堆积（404/550）。
3. **PiP 纯绿 (0,77,0)**：两条独立缺陷叠加——
   - `slot.uploaded = srcN` 在异步上传完成前就被置位（`uploadVideoFrame` 未 await），
     合成可读到"Y 新/UV 空"纹理；
   - 更根本：`UNPACK_ALIGNMENT` 默认 4，而 682 宽 NV12 的 Y 平面行距 682（非 4 对齐），
     `texImage2D` 以 `INVALID_OPERATION` **静默失败**（GL 错误不抛 JS 异常）→ Y/UV 纹理
     全空 → YUV 路径绘制出 RGB(0,77,0) 纯绿。1920 宽主轨行距对齐故无此现象。
   - 图片素材路径：`drawOverlays` 无条件走 YUV 模式，RGBA 静图纹理被当作 Y 平面
     （红通道当亮度 + 空 UV）→ 同样绿块（上一项目实测）。
4. **热态跳帧喂入破坏 GOP 参考链（驱动级）**：speed≠1 时 src_n 每 4-5 帧跳 1，跳帧采样
   作为中间输出被即时 close——本机 Intel D3D11 路径上 GOP3（keyframe@300 后）出现
   **确定性花屏**（两次运行 PNG 逐字节一致；ffmpeg 软解与 d3d11va 同字节均干净；
   全新 Worker 实例解同段干净）。详见"已知限制"。

## 修复架构（apps/desktop/src/app/preview/）

### PreviewSession（播放编排重构）

- **每输入一条顺序解码链**：按 IR 帧序把解码游标单调推进到
  `[target-BACKSCAN, target+LEAD]` 窗口的最大展示需求 src_n，链深度 1、完成即续
  （不等 rAF tick）；**speed≠1 的被跳采样以 decode-only 喂入**（解码、不展示不上传），
  worker 始终看到 `target = fed+1` 的纯顺序流（与 ffmpeg 喂入同构）。
- **环形纹理池（RING=6）**：解码帧上传到独立槽位；`uploadRing` 全程 await
  （copyTo → texImage2D Y+UV → mipmap → getError 轮询）完成后才标记 srcN 就绪
  （杀掉绿块竞态）；每输入上传串行尾（杜绝同槽交错）。
- **合成取 ≤ 墙钟目标的最新就绪帧**（回扫 ≤ 15 帧）：已就绪帧绝不丢弃；
- **饥饿护栏**：落后 > LAG_REANCHOR(10) 帧即重锚时钟（播放按解码吞吐放慢），
  替代旧实现的"目标狂奔 + 画面冻结 + 丢帧堆积"。
- **seek（暂停态）**：并行解码经同一环形/影子槽位（await 后就绪），并同步链游标
  （避免回播放触发无谓冷启）；拖拽快速档语义保持。
- **源宽 LOD**：`setSourceWidthScale` 此前从未被会话调用（恒 1920），682 宽 PiP 被
  过度降采样模糊——现按 IR geometry 注入。

### Compositor

- `uploadVideoFrameToTextures(frame, y, uv)` 核心上传：NV12 零拷贝快路径
  （`UNPACK_ROW_LENGTH` + 平面视图直传，省去 1080p ~3MB 的 JS 逐行重打包）；
  I420 回退重打包；`UNPACK_ALIGNMENT=1`；上传后 `getError()` 显式轮询——
  纹理上传失败从此抛错而非静默绿块。
- `drawTextures`（显式纹理对，uv=null 走 RGBA 模式——静图修复绿块）、
  `drawTransitionWithPairs`、影子槽公共访问、`setViewportBacking`
  （预览框适配：合成画布填满预览框、IR 画布 contain 居中，观感对齐交互预览）。

### 解码 Worker（decode-worker.worker.ts）

- **请求队列**：单 `pendingResolve` 改为严格串行队列（`decodeQueue` + `activeRequest`），
  一次一个请求、按目标 PTS 半帧容差（16_667µs，修复系统性早一帧）匹配，完成即续队；
  请求永不互相覆盖、永不悬挂（15s 客户端超时仅作兜底）。
- **GOP 锚与中间帧延迟关闭**：跨关键帧跳帧/回退走 `reset()` 冷启；冷启首输出（IDR）
  持有为 GOP 锚（`gopAnchor`）直至下个关键帧冷启；中间输出经 3 层延迟关闭环。
- **回退路径整例重建解码器**（close + new VideoDecoder）。

## 修复后实测（evidence/m3_2/playback-repro/fixed15|fixed16）

| 指标 | 基线 | 修复后 |
| --- | --- | --- |
| 合成帧数（320 帧全片） | 36 | 640（60Hz 合成节奏，每帧 ≥1 次） |
| 丢帧 | 550 | **0** |
| 合成间隔 p50 / p95 | 33.4ms / 2635ms | **16.7ms / 22.9ms** |
| 解码 RTT p50 / p95 | 2.1ms / 30ms | 1.9ms / 14.6ms |
| 墙钟耗时（10.667s 内容） | 10.695s（冻结） | **11.13s 含读回取证开销，无冻结** |
| PiP | 纯绿块 | 真实内容（屏幕录制帧） |
| 片尾帧 | 冻结在 12 帧 | 正确（"ok! bye."，scale 0.87 内容盒） |

## 已知限制（本机驱动级，非编排缺陷）

- **暂停态 seek 进入深 GOP（keyframe@300 之后）时，本机 Intel D3D11 WebCodecs 路径
  仍可能产出花屏帧**（postmortem 取证，确定性复现）。同字节流：ffmpeg 软解、
  ffmpeg d3d11va、全新 Worker 实例均干净；`reset()`/整例重建/中间帧延迟关闭/
  GOP 锚持有均无法清除（毒化随解码历史在 Worker 全局残留）。**播放路径已通过
  连续采样喂入完全规避**（fixed15/16 播放全程干净）；纯 seek 路径的彻底解需
  Worker 级重建（成本 ~150ms/次）或等待上游修复，暂记为已知限制。
- 竖版项目在横版预览框中，合成预览画布按权威输出（9:16）contain 居中——与交互
  预览（预览框内 object-fit）观感对齐已通过 `setViewportBacking` 落地；内容几何
  仍以权威 IR 画布为准。

## 验证记录

- `pnpm typecheck`（desktop）通过；`pnpm test` 353/355 通过（2 个失败为 HEAD 上
  既有失败：素材箱交互 2 例，与本次改动无关，已用 git stash 对照验证）。
- m3p4 seek 基准（100 次随机跳转）回归：见 `evidence/m3_2/playback-repro/m3p4-regress3/`。
- m3p5 播放探针：baseline / fixed15 / fixed16 证据链齐备（PNG + JSON）。

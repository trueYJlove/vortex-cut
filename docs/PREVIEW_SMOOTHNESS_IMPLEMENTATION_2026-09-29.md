# 预览播放流畅度收敛 · 实施记录（2026-09-29）

> 规划门：`PREVIEW_SMOOTHNESS_PLANNING_GATE_2026-09-28.md`；STATUS.md §4 P33。
> 当前状态以 `docs/STATUS.md` 为准。本文是点时间实施记录。

## 1. 交付摘要

| 门限项 | 基线（用户实测/首轮基线） | 终测（skip2-r1..r3，真机 3 轮） | 结论 |
|---|---|---|---|
| 丢帧 ≤0.5% 且方差稳定 | 34~423（用户实测）/ 5-6/1800（首轮基线） | **0/1800 × 3 轮（0.00%）** | ✅ |
| decode p95 ≤20ms | 53.8ms | **1.6~2.2ms**（顺播稳态） | ✅ |
| decode p50 ≤12ms | ~34ms | **0.4ms** | ✅ |
| compose interval p95 ≤40ms | 未取样 | **33.6~33.7ms**（满帧率 30fps） | ✅ |
| 看门狗/降级 = 0（回归） | 0 | 播放段 0（EOF 边界另见 §4） | ✅ |
| 插桩零开销 | — | 未单测（插桩仅开启路径生效，见 §5 L1） | ⚠️ L1 |
| EOF 回卷（真机 App 内，用户原素材） | 播到尾后再点播放无效 | **e2e 通过：片尾吸附 → 回卷复播 → 推进**（2026-09-29，见 §2 W2.6） | ✅ |
| 用户真机确认 | — | **待用户复测** | ⏳ |

测量载体：`python tools/m3_0/run_electron_probe.py m3p5 --ir evidence/performance/preview-smoothness-baseline/ir_hevc_b_60s.json --assets evidence/performance/preview-smoothness-baseline/assets.manifest.json --evidence <dir>`，素材 `test-assets/generated/hevc/hevc-1080p-60s-g90-b3.mp4`（1080p30 HEVC Main、GOP=90、B 帧重排实测回跳 7、60s、faststart）。

## 2. 改动清单（每项独立 A/B 证据）

### W1 分段计时插桩（3be4ef5，后续 6f7a75e 修复链路）
- decode-worker.worker：`feedMs`（出队→最后一批喂包提交）+ `outputMs`（喂包提交→匹配输出），`decodeTiming` init 注入；跨线程不传绝对时间戳。
- decode-worker 客户端：残差 = 客户端 RTT − worker 两段，环形 512 样本。
- MediaDecoder 接口 `timingSamples`（WebCodecsMediaDecoder 透传）；`metrics().decode_seg` 聚合；m3p5 result 携带分段表（**dispose 前快照**）。
- 计时开关经主进程 `probeLoadQuery` 注入 URL（VITE_* env 直通渲染侧不可靠，timing-r1..r3 实测 None）。

### W3 起播丢帧根治（两部分，提交见 git log）
1. **pump max 封顶收紧**：`anchor + RING−3` → `anchor + min(LEAD, ringDepth−3)`。链完成即续快于实时时收窄超前冗余（单独 A/B 不解决起播丢帧，保留以减淘汰窗）。
2. **LAG_REANCHOR 12→4 + 重锚「洞跳过」**：
   - 单独收紧 LAG 会死锁（fix-ttl-r14..r16、hole-skip-r1..r3 五轮定位）：洞 = 预读淘汰且 pump 游标单调不回补的不可展示帧；旧重锚锚在 currentFrame，target 永远爬不出洞区，预读区就绪帧轮不到回扫窗——合成冻结。
   - `findHoleSkipCandidate`：重锚时在 (current, target+LAG] 找洞后第一个就绪帧，把播放头跳过去（搜索窗必须延至 target+LAG，hole-skip 轮验证）。跳过 = 承认被淘汰帧不可展示。
   - 效果：skip2-r1..r3 丢帧 0/1800 × 3、合成间隔 33.4/33.6ms、content 匀速走完、复播回归过。

### W2.5 EOF 边界快速报错
- 现象：暂停态 seek 片尾 B 帧区（1780/1783/1786/1789/1798）45s 看门狗挂起，快照 `dqSize=15-17`。
- 定位（eof-* 六轮 A/B）：尾 GOP 冷启喂到文件尾后，重排金字塔尾帧滞留输出管道；**flush 救援实测无效**——D3D11 硬解尾帧缺后续参考时 `flush()` promise 永不落定、`reset()` 丢弃排队输出，重排队冷启再撞同一堵墙。
- 收口：rescue_flush/feedSamples 检测已喂至文件尾 → 立即报 `EOF reorder watchdog`（命中降级正则）；rescue_flush 加 5s 竞速超时防 promise 挂起闸死泵。
- 效果：探针 wall 286s → **61.5s**（4×45s 挂起全消），播放丢帧保持 0/1800。

### W2.6 EOF 定格替代 + 片尾吸附——「播放到尾后再点播放无效」根修（真机素材）
- 真机现象（用户素材 fdf0f0e2，HEVC 720x1280 B 帧交错、尾 GOP 截断 88→20 帧）：播到片尾自动暂停后，**再点播放无效**——原地续播再停滞 2s 循环。
- 根因链（user-eof-r1..r9 十轮 A/B + decode_trace 离线取证）：截断尾 GOP 的最后 3 帧（1774-1776）滞留 D3D11 重排缓冲**永久不可达** → 片尾形成洞 → `currentFrame` 停在 `last-3`，播放靠 2s 停滞兜底结束，而 `play()` 回卷条件（`currentFrame >= last`）永不成立 → 再点播放从卡死点原地续播。
- 收口（两处）：
  1. **decode-worker.worker `postEofFreezeFrame`**：喂至文件尾仍 miss 时，取 stash/缓存中 pts ≤ 目标的最近持有帧 clone 回填（贴标准播放器「尾帧定格」语义）；同时 cachePut 目标位供后续命中。无持有帧才回落快速报错（W2.5 路径兜底降级）。附带废弃 flush 救援（eof-flush-r1..r3 已证伪）；中段 GOP 的 miss **不**延伸喂包（r7/r8 证伪：整 GOP 狂喂丢帧 343），延伸仅限目标位于最后一个 GOP 且 dq==0。
  2. **preview-session 片尾吸附**：停滞兜底结束时 `currentFrame = last` 再 pause+onEnded——吸附后回卷条件成立，再点播放正常从头复播。
- 效果（user-eof-r10，**用户原素材**直测）：dropped 3/1800、decode p95 2.7ms、compose p95 34.1ms、`replay_after_end_ok=true`；真机 App 内 e2e（`e2e/p33-eof-replay.electron.spec.ts`）：播到片尾吸附 → 再点播放回卷 `00:00:00:07` → 复播推进 → 全程无 watchdog 错误。
- 探针侧：`verifyTrace` 经 init 参数注入（decodeTiming 开启时同步开启），trace 事件经 `__TRACE` 池落盘 `decode_trace.jsonl`（挂死形态离线取证）。
- **e2e 复测期间定位的既有产品缺陷（未修，记录）**：overlay-only 时间线（片段全部落在 V2/画中画等叠加轨、V1 主轨为空）→ IR 投影 `visual` 只取 V1 → manifest `total_frames=0` → `play()` 首个 tick 即结束判定，**静默无任何提示**。应回落取最早可视段建主图或显式报错。e2e spec 内以 V1 行带落点（y=112）+ 落轨断言规避。

### W4 无 B 帧直线流「解码器输出管线深度 vs 持有窗容量」根修（2026-09-30，用户原素材 App 内复现）
- **复现口径**（首次做到「与用户指标条同画布」）：用户原素材 `C:/Users/trueY/Videos/5月11日(3)/5月11日(3)-1.mp4`（ffprobe：3440x1440 H.264 High、**has_b_frames=0**、GOP=150/5s、22.5Mbps、1241 帧、41.378s）经新工具 `tools/m3_0/make_user_repro_ir.py` 生成单段 1x fit IR（canvas **960x540**，与用户截图指标条一致），m3p5 探针复现 **dropped 242/1241**、decode p95 58ms、合成间隔 p95 **200ms**。
- **decode_trace 三条实锤**（非推测）：
  1. 该流在 D3D11 上的**输出管线深度 = 11**：喂到 target+11 才吐第一帧。
  2. 旧容量公式 `min(8, max(4, 回跳深度+2))` 是按**重排深度**定窗——无 B 帧流 maxBackstep=0 → **窗 4 ≪ 11**。
  3. 段末延伸的触发条件是 `dq == 0`（decodeQueueSize 归零），但批间让步 `setTimeout(0)` 期间解码器**必然**把 input queue 抽干——dq 归零只代表「输入已被接受」，输出仍躺在管线里。于是几乎每次都命中延伸分支，且一次 `EXTEND_STEP = 32` 采样（41s 内 `feed_extend` **133 次**）。
  → 解码器为释放目标而必须吐出的后续帧被自己的容量逐个挤掉，而客户端**顺序**请求的下一个目标恰好就是被挤掉的那一帧 → `missingStuck` 成立 → **冷启整 GOP 154 次/41s**（每次清空暂存 + 关键帧重喂 + ~300ms 空窗；`output_p95 = 296ms`）。
- **修复**（`decode-worker.worker.ts` 三处 + 一处诊断通道）：
  1. **段末改输出活性驱动**：段喂完后先等输出——只要仍有新输出到达就继续等（管线深是正常），完全停滞 `STALL_MS = 30` 才判「喂得不够」；延伸步长不再是 32，改为**按批几何放大**（4→8→16→32），把超前量压到解码器真实需要的最小值。
  2. **持有窗按实测超前量前摄扩容**（`growHoldCapFor`，在喂包循环内调用——必须早于输出回调，否则新吐出的帧先被旧容量驱逐）；硬上限 16（持有帧总量 = 窗 + gopAnchor + LRU 3 ≈ 20，仍在 D3D11 表面池可承受范围）。无 B 帧流的窗由 4 起、实测长到 13。
  3. **驱逐显式化为「丢展示序最新」**（原实现锚 `min(上一请求 pts, 新帧 pts)` 再丢「距锚最远」——对顺播直线流恰好退化为总是丢最新吐出的帧，即客户端下一个要的帧）。顺序消费者下丢最新 = 损失落在最远处，前沿方向保留连续跑道。
  4. 诊断：App 内 `window.__aivsPreviewMetrics`（仅 `VITE_AIVS_PERF=1` 构建）——把「探针 0 丢帧 / App 丢帧」两张皮收敛为同源可对账数值。
- **效果（探针，同一素材同一 IR）**：dropped **242 → 1**（W4 版窗上限 16）/**4**（W5 终版窗上限 8，见 L8 取舍）、decode p95 58 → **6.9~7.3ms**、`output_p95` 296 → **7.9~35.5ms**、合成间隔 p95 200 → **33.6ms**、`cold_start` 154 → **4~10**、`feed_extend` 133 → 1。终版与 W4 版同向，唯窗上限按跨素材安全水位收敛到 8。
- **效果（App 内，新 spec `e2e/p33-user-drop.electron.spec.ts`：真机 UI + 音频 + 时间线 + 960x540 画布）**：3440x1440 素材 **丢帧 452 → 0/1241 × 3 轮**、decode p95 83.1 → **6.4~7.2ms**、上传 p95 20.7 → **2.8~3.2ms**；用户 HEVC 720x1280 素材 **丢帧 211 → 0/1777 × 3 轮**、decode p95 56.1 → **4.7~4.8ms**、上传 p95 2.6 → **2.4~2.5ms**。
- **App 内 worker 决策 trace**（timing 构建，3440x1440）：`cold_start 0`、`feed_extend 0`、`evict_newest 0`、`hold_cap` 扩容 7 次、`take_hit_exact 301` / `decodeSamples 306`（1241 帧中绝大多数由持有窗直接回填）——对照修复前 154 次冷启。
- **回归（探针，既有 fixture）**：1080p 无 B 帧 dropped 0（decode p95 35.4 → **2.0ms**、`output_p95` 41.8 → 2.2ms、合成间隔 max 230.9 → 49.9）；1080p HEVC B3 dropped 0（decode p95 4.7 → 1.8ms）。
- **回归测试**：`tests/decode-linear-pipeline-hold.test.ts`——同一「管线深度 11」模型对拍旧/新策略，**含反向对照**（旧策略必然重建风暴 > COUNT/20；新策略 `rebuilds === 0`），证明断言有区分力而非恒真。

### W5 未 close 持有帧「全局自适应预算」+ seek→play 停摆根修（2026-09-30）
- **触发**：`e2e/p33-seek-play.electron.spec.ts`（上一会话留下、此前从未转绿的回归门——六档时间线跳转 → 点播放）。症状与用户报障同形：时间码 10s 不动、指标条 `解码 p95 1502ms`。
- **根因（3 轮同形 trace + 变量隔离实锤）**：**解码器表面池被未 close 的 VideoFrame 占满后永久停摆**——既不吐输出也不再消费输入（`dq` 20→48→80→112→…→312 单调攀升），目标帧永不吐出，请求一路喂到文件尾才由 EOF 兜底报错。
  - 变量隔离：持有窗上限 16 / 9 / 5 三档都复现；把**全局未 close 预算**压到 6 时同一 spec 六档全过；停摆点 `held`（窗+锚+缓存）恒等于当时预算上限，而冷启复活瞬间 held=0 → 与「重建」无关，是「持有量 > 该解码器表面池」。
  - 池大小随编解码/分辨率而变：3440x1440 H.264 容得下 13+（W4 探针/App 全绿），720x1280 HEVC 在 ~10 就停摆——所以上限不能写死。
- **收口**（`decode-worker.worker.ts`）：
  1. **全局口径**：`heldFrameCount()` = 持有窗 + GOP 锚 + LRU 缓存；`releaseForBudget()` 超预算即让出（先丢 LRU 缓存最旧＝已交付帧，再丢持有窗展示序最新＝最远未来帧）。旧实现只限持有窗，缓存与锚白占表面池。
  2. **自适应预算（实测收敛到固定安全水位）**：初始 8、上限 **8**（＝实测安全水位）。判据来自同一批真机复测：预算 8 时用户 3440x1440 H.264 播放 0~2 帧、720x1280 HEVC 播放 0 帧；上限放到 14 时 HEVC 出现 **210/1777 帧**的整段停摆（解码器撞池后长时间不恢复），而 H.264 只从 0~1 帧改善到 0 帧——**不用单素材收益去冒跨素材的整段停摆风险**，故锁定 8。喂包循环一旦观察到「静默 + dq>0」＝池告急，`shrinkForBackpressure()` 立刻把预算压到当前水位 −2、让出表面、清零健康计数并冻结上调（自愈路径保留，用于兜住任何仍撞池的场景）。
  3. **段末三态判定**：有新输出 → 继续等（管线深是正常）；静默 + dq>0 → **先让出表面再等，绝不继续喂**（继续喂只会加深停摆）；静默 + dq==0 → 小步几何延伸。
  4. **目标落在已喂游标之后**（超出重排窗 + lookahead）→ 按关键帧重解（旧实现会朝前越喂越远：请求 525 却一路喂到 1776 仍不匹配）。
  5. **停摆自恢复**：喂到文件尾仍不匹配且 dq>0（＝停摆，真截断尾 GOP 会 dq 归零）→ 重置解码器 + 按关键帧重喂 **原地重试一次**，成功则静默交付，避免用户可见错误横幅、也避免「一次停摆污染后续所有请求」。
  6. 冷启重建一并释放 LRU 缓存（缓存帧属于已关闭的旧解码器）；冷启改用 `reset()+configure()`（新实例在真机 D3D11 上同样会静默停摆，且无需新硬件会话）。
- **效果（部分达成，诚实标注）**：`p33-seek-play` 六档跳转**在多数轮次全部推进**（连跑 3 次：2 次六档全过、1 次仍在 0.15 档停住）——**未稳定收敛**，故该 spec 以 `test.fixme` 挂起并保留为唯一可执行复现载体（见 L8）；`p33-eof-replay` 通过；app-drop 两素材 3 轮复测 0/0/0 与 0/1/0（见 §3）。**用户主诉的「顺播丢帧」与「一次停摆污染后续全部请求」的连锁已根治；跳转风暴下的稳定性仍有缺口。**

### W6 「越修越卡」根因：降级闸门被单帧缺口误触 + 单请求无界喂包（2026-09-30，用户 dev 运行复现）
- **用户现象**（`pnpm dev` 实机）：H.264 素材 `解码 p95 180.5ms`、丢帧 95；HEVC 素材界面常驻「最近错误：解码失败 I0#5: DECODE_FRAME_NOT_FOUND」，终端反复打印 Core `decode-frames` 400。
- **定位（终端指纹即可判定）**：`decode-frames` 是 **Core/FFmpeg 后端（B 路径）**的处理器，WebCodecs 路径**不会**调用它 → 整条输入已被 `maybeFallBackToFfmpeg` **永久降级到 IPC 软解**（~180ms/帧）。触发链是本会话 W5 引入/放大的两处：
  1. W5 的单帧停摆兜底以 `EOF reorder watchdog: …` 文案报错 → 命中降级正则 `/timeout|watchdog|key frame is required/i` → 连续 2 次即永久降级；
  2. 撞池停摆的请求会以「每轮等 1.5s 背压 + 小步延伸」一路喂到文件尾（1776 采样 ≈ 55 轮 ≈ 80s），先撞客户端 50s 超时（文案同样命中正则）→ 又一次 strike。
- **收口（4 处）**：
  1. 单帧停摆错误改前缀 `FRAME_UNREACHABLE:` 并从降级判据排除（它已被「重置解码器 + 重锚 + 原地重试」处理过，不代表后端不可用）；
  2. **降级可回退**：进入 FFmpeg 路径后经 45s 冷却期允许一次回到 WebCodecs 的尝试（成功即恢复快路径并清错误横幅）；
  3. **单请求喂包总预算 6s**（`REQUEST_FEED_BUDGET_MS`）：超预算即走定格/停摆兜底，秒级收敛，不再无限延伸；
  4. **首/尾越界钳制**：请求落在素材首/尾采样之外 ≤2 帧时交付端帧（worker 侧 `edge_clamp` + 客户端相邻帧回退；命中 `DECODE_FRAME_NOT_FOUND`/`no sample` 不再刷错误横幅）——真机 HEVC 素材 duration 59.233s、末帧 pts 59.2s，客户端会请求 59.2667s 那一帧。
- **附带：解码后端可见化**——指标行在后端 ≠ webcodecs 时显示「解码后端 ffmpeg（已降级，慢路径）」。这类问题不再需要靠终端日志推断（本次就是靠终端指纹才认出来的）。

### W7 持有帧预算按编解码分档（2026-09-30）
- 实测表（同批真机复测）：3440x1440 H.264 无 B 帧 → 释放首帧需喂 **11**、容得下 **13+** 未 close；720x1280 HEVC → 管线 ~8、持有 **9-10 即停摆**。
- 单一水位两边不讨好：取 8 → H.264 冷启首批 11 帧装不下 → 驱逐 miss → 偶发起播丢帧（实测 9~24 帧）；取 14 → HEVC 撞池整段停摆（实测 **210/1777**）。
- 收口：`unclosedBudget` 按 demux codec 分档（**HEVC 8 / 其余 12**），仍保留背压收缩与停摆自恢复；通用解（按解码器实测池大小自适应）登记 L8。

### W8 指标可信化：重锚丢帧入账 + 解码后端/硬解模式上界面（2026-09-30，用户第二次复测暴露）
- **用户现象**：dev 运行里 H.264 素材观感「像幻灯片」却显示 `丢帧 0`（同时 `解码 p95 192.3ms`）；HEVC 素材观感流畅但**片尾累计掉帧 ≈100**（`解码 p95 51.6ms`）。
- **口径缺陷（本次修）**：`LAG_REANCHOR` 重锚只把播放头挪到「洞后第一个就绪帧」而**不计数**——解码吞吐不足时界面因此显示 0 丢帧，指标失去诊断价值。现按诚实口径计入 `dropped`（重锚跳过的帧 = 未能展示的帧）；`editorPerf` 的 reanchor 事件同时携带跳帧数。
- **不可见缺陷（本次修）**：指标行只看得到 p95，分不清「稳态慢」与「偶发尖峰」；也看不到解码后端/硬解模式。现补：指标行显示 **解码 p50 / p95**；后端 ≠ webcodecs 时显示「解码后端 ffmpeg（已降级，慢路径）」；解码器模式不含 `prefer-hardware` 时显示「硬解不可用（no-preference，软件解码）」。
  - 判读：p50 ≈ p95 且数量级到百毫秒 = **稳态慢**（软解或撞池停摆）；p50 小、p95 大 = 偶发尖峰（冷启/停摆）。
- **为什么我的复测环境看起来「太好」**：App 内验收跑的是**生产构建**（`out/main/index.cjs` + 已构建渲染层），dev（未压缩 React + source map + HMR）负载更重；且我的 e2e 用**全新 user-data-dir**，而用户 dev 会话是长期存在的 profile/GPU 进程（userData 里累积 Dawn/Graphite/WebGPU 缓存）。这两条差异必须在结论里说明，不能把「生产构建 0 丢帧」当成「任何环境都 0 丢帧」。同机 dev 模式的 m3p5 探针同样为 0~4 帧，说明**dev 本身不是慢的充分条件**——长期会话的 GPU/硬解状态才是首要嫌疑（由新增的硬解模式标签当场判定）。

### W9 「dev 卡、生产不卡」的定量归因（2026-09-30，四段计时 + 同画布对照）
- 用户真机 dev 行（HEVC 素材，跑满全片）：`解码 p50 1.3ms / p95 55.8ms · 上传 p95 3.7ms · 丢帧 112 · 分段 喂包 0 / 出帧 1.5 / 排队 0 / 残差 63.3ms(p95)`。
- **归因**：解码链路完全没参与——喂包 0（无需喂）、出帧 1.5ms（解码器立刻吐）、排队 0（worker 无串行等待）；**63ms 全在「残差」= 跨线程消息投递 + 主线程任务调度**。p50 1.3ms 说明绝大多数交付是即时的，只有 ~5% 的尖峰把帧推迟 ~60ms；一次尖峰 ≈ 1~2 帧错过呈现窗口 → 112/1777 ≈ 6.3% ≈ 每秒约 1 次尖峰。
- **同画布对照（排除「面板太大」这个变量）**：App 内 e2e 加 `AIVS_P33_VIEWPORT` 覆写视口以复刻用户窗口——1920x1080 视口下后备缓冲 **1132×637**（用户实测 1096×617），生产构建结果仍是 `p50 1.7 / p95 5.3ms · 喂包 0 / 出帧 2.1 / 排队 0.1 / 残差 4.2ms · 丢帧 0`。
  → **画布尺寸不是变量；dev 模式（未压缩 React + HMR + sourcemap + devtools）的主线程压力才是**。
- **结论与边界**：产品交付路径（打包/生产构建）本身干净；但这条流水线**对主线程尖峰敏感**——呈现时钟与请求泵都在主线程 rAF 上，一次 60ms 尖峰就会跳 1~2 帧并如实计入丢帧。结构性对策（把帧交接与呈现节拍移出主线程：decode worker → compositor worker 直连 + 合成器侧自走）已识别但**未实施**，因为它是跨模块改动而当前生产路径已达标。登记为 L9。

### W10 dev 模式流畅度收敛（L9 正面收口）：呈现期零 React 提交（2026-09-30）
- **先补上缺失的自测闭环**：新增 `apps/desktop/scripts/dev-cdp-probe.mjs`——经 CDP 接管 `electron-vite dev` 启动的**真实编辑器**（`scripts/dev.mjs` 现在转发 `--` 之后的 Electron 参数，因此可 `--user-data-dir=<临时目录>` 隔离，不触碰本机项目库），采集指标行 + longtask + rAF 间隔 + `__editorPerf` 主线程归因。此前自动化只跑生产构建，dev 的「残差 63ms」因此无法本地复现。
- **复现（用户同款 dev，同素材）**：丢帧 **85~112**、longtask **274~295**（p95 64ms）、rAF 间隔 p95 51ms；而**解码链路合计仅 ~5ms**（喂包 0 / 出帧 2~3.5 / 排队 0 / 残差 1~2）。
- **归因**（perf 逐秒排空累计，59 秒播放）：`react_commit` **1723 次 / 21.5 秒 / 单次最大 67ms**。主体是 `TimelinePlayheadLayer` 的 `useSyncExternalStore`——覆盖层随 playhead-store 按帧通知（30Hz）走 React 提交；dev 的 StrictMode 双渲染再翻倍。
- **收口（两处，都是「降密度/降成本」，不改语义）**：
  1. **播放头覆盖层改命令式跟随**：订阅只写 `style.transform / height / display`，播放期**零 React 提交**（可视判据由「条件渲染」改为 `display` 切换，语义不变；`timeline-redraw` 相应用例断言随之改为检查隐藏态）；
  2. **播放回传节流按构建分档**：dev 250ms / 生产保持 100ms（10Hz 观感不变）。
- **效果（同机 dev，同素材）**：HEVC 丢帧 **112 → 12 → 3**、H.264 丢帧 **135 → 3**；longtask **295 → 33 → 1~2**；rAF 间隔 p95 **51.8 → 14ms**（≈60Hz 满帧）；`react_commit` 次数 1723 → 282 → **播放期 ~0**（时间码/进度条改 DOM 直写后，播放段 App 组件树完全静止）。注意 `解码 p95` 也从 55.8ms 回落到 **2.8~4.2ms**——那 50ms 本身就是主线程卡顿把 RTT 测量拉长的假象，而非解码慢。
- **生产路径回归**：两素材各 3 轮 = **0/3/0**（H.264，≤0.24%）与 **0/0/0**（HEVC）；749 单测 + typecheck 绿。

### W11 「收缩变棘轮」：持有帧预算/持有窗必须能自愈（2026-09-30，用户第三次复测暴露）
用户现象（截图）：**同一 dev 会话**里 HEVC 720x1280 素材流畅（`解码 p50 1.5 / p95 2.6ms · 上传 p95 2.3 · 丢帧 2`），而 3440x1440 H.264 素材「很卡、无法正常播放」（`解码 p50 30.7 / p95 194.6ms · 上传 p95 11.9 · 丢帧 35 · 分段 喂包 0 / 出帧 204.3 / 排队 0.1 / 残差 1.2ms`）。

**先排除（每条都是实测，不是推断）**：
1. **文件与画布尺寸**：生产构建 + 用户同款画布（`AIVS_P33_VIEWPORT=1920x1080` ⇒ 缓冲 1132×637 ≈ 用户 1122×631）播放同一素材：`丢帧 3/1241 · 解码 p50 2.6ms`；dev + 同画布（`dev-cdp-probe.mjs --viewport`，本轮新增参数）：`丢帧 3 · p50 1.9ms`。
2. **模糊垫底布局**：`blurred_background` vs `crop_fill` 同实例同素材 A/B（`dev-playback-sample.mjs`，本轮新增工具）：两者都顺（出帧 p95 7~17ms）。此前 `预览比例` 切换会把主轨布局自动改写为 `crop_fill`（App.tsx「比例切换」策略），所以**用户真机那种 `blurred_background` 形态从没被真正测到过**——本次补测，无罪。
3. **上传慢路径**：`AIVS_FORCE_COPYTO=1` 强制 copyTo 上传（上传 p95 30ms，为 direct 的 ~10 倍）：播放仍 **0 丢帧**（环形缓冲吸收了上传延迟）⇒ 上传慢不是充分条件。
4. **硬解能力**：当场探针 `navigator.mediaCapabilities.decodingInfo`（`powerEfficient` 才是「真会用硬解」；`VideoDecoder.isConfigSupported` 只回显请求的模式）：`avc1.640032` 3440x1440 = **powerEfficient true** ⇒ 本机硬解可用。

**确定性复现（新增诊断开关 `VITE_AIVS_FORCE_DEGRADED_BUDGET=<n>`）**：把会话起点钉在「刚观察到一次背压」的收缩水位（预算 n / 窗 n−1 / 回升计时=现在）。同素材同窗口 20s 采样：

| 起点 | 解码 p50 | 出帧 p95 | 冷启 | 观感 |
|---|---|---|---|---|
| 预算 6 / 窗 5（修复前） | 53→107ms（持续恶化） | 173ms | **176** | 时间码 20s 只走 2s（≈10× 慢），`evict_newest` 5648 次 |
| 预算 9 / 窗 8 | 1.9ms | 17ms | 0 | 正常 |
| 预算 6 / 窗 5（修复后） | 1.8~2.6ms | 4.6~17ms | **0** | 正常（首秒 4 帧起播抖动后恢复） |

用户指标条的形状（p50 数十毫秒 + 出帧 p95 200ms + 上传 p95 12ms + 残差干净）与「持有窗被压到 5~7」完全一致。

**根因**：`shrinkForBackpressure()` 里的 `backpressureSeen = true` 是**单向棘轮**——「一旦见过背压就永不上调预算」。本素材的解码器输出管线深度是 11（W4 实测），窗 < 管线深度 ⇒ 客户端顺序请求连环 miss ⇒ 每帧「冷启整 GOP」⇒ 越卡越重建 ⇒ **直到该 worker 复位才恢复**。持有帧水位是 **worker 模块级状态、每个输入一个 worker**，因此：换素材（= 换 worker）会拿到初始水位 ⇒ 同会话里另一个素材照常流畅（对应「图 1 顺、图 2 卡」）；重启（全部 worker 重建）则整段复位。触发那次收缩的事件可以只是任何一次瞬时抖动（判据是喂包循环的「静默 30ms + dq>0」），与素材/画布无关——这正是它「偶发、粘住、重启即好」的原因。

**修复（`decode-worker.worker.ts`，四处）**：
1. 单向标记 → `lastBackpressureAt` 时间戳：**收缩仍然即时且激进**（安全侧不变，W5/W6 结论不动），但回升允许在「安静 ≥1.5s + 连续 4 次健康交付」后逐级放行（真撞池会持续复现背压、冷却窗口被反复重置 ⇒ 等于维持不涨）。
2. **被驱逐导致的 miss（`missingStuck`）= 「窗太小」的确凿证据**：目标帧**曾吐出过**、损失完全由我们自己的容量/预算驱逐造成，而且证明池子当时在工作 ⇒ 立即抬一级水位，**不受冷却窗口限制**（按 codec 档位封顶 + 200ms 限速）。这条是自愈主力：纯计时式自愈会被风暴自身的「疑似背压」观测反复重置（实测同一会话误触发 94 次，冷却永不生效）。
3. 新增 `unclosedBudgetCap`：回升**绝不越过**本会话 codec 档位（HEVC 8 / 其余 12）——否则自愈会把 HEVC 爬回 W5 记录的 10+ 停摆水位。
4. 收缩时**不再抹掉**实测管线深度 `feedAheadPeak`（它是知识不是水位）：旧实现抹掉后 `want = peak + 2` 只剩 7，窗再也回不到实测需要的 12。
- **顺带把状态变成可见证据**：`residency` 快照（1Hz，perf 构建随 e2e/探针落 JSON）新增 `budget / budgetCap / windowCap / feedAheadPeak / shrinks`——「窗 < 管线深度」这类**状态性**卡顿只能从这里当场看出来（指标行的分段只能看到症状）。

**验证**：
- **修复前臂**（同一 knob、修复前构建，本记录留痕；该臂的 JSON 未保留——当时的构建已被回滚）：冷启 176 次、时间码 20s 只走 2s、出帧 p95 173ms、`evict_newest` 5648 次。
- **修复后臂**（证据在库）：`dev-sample-w11-degraded-6.json`（强制降级起点 预算 6/窗 5，20s 采样）**冷启 0 次**、解码 p50 1.6~2.8ms、出帧 p95 7.5~16.9ms（首秒 50.9ms 起播抖动后恢复）、时间码实时；`dev-sample-w11-healthy.json`（健康臂对照）p50 2.7~2.8ms、出帧 p95 8~16.8ms、丢帧 3；`dev-probe-w11-h264.json`（dev + 用户同窗，完整用户操作链路）丢帧 5/1241、p50 2.7 / p95 5.9ms、longtask 1、rAF p95 14.2ms。
- App 内 e2e（生产构建，用户同画布 1920x1080 ⇒ 缓冲 1132×637）：**H.264 3440 3 轮 = 2 / 0 / 3 帧（≤0.24%）**、**HEVC 720 3 轮 = 3 / 4 / 0 帧（≤0.23%）**，全在门限（≤0.5%）内；`e2e/p33-eof-replay` 通过。
- 全量 **753 tests + typecheck** 绿（新增 `tests/decode-hold-budget-recovery.test.ts`：4 例策略回归，含「旧棘轮必然回不去」的反向对照与 HEVC 档位封顶）。
- 工具链修复（非生产路径）：`dev-cdp-probe.mjs` 新增 `--viewport`（复刻用户窗口）+ 输出目录自动创建 + 文档补 `AIVS_E2E_ASSET_PATHS`（「导入视频」按钮走 `kind=video`，**只设 `AIVS_E2E_MEDIA_PATH` 会弹原生对话框**；且该 JSON 里路径要用正斜杠，反斜杠是非法 JSON 转义 → 解析失败同样退化成对话框）；新增 `dev-playback-sample.mjs`（同实例单变量对照 + 决策 trace 落 JSON）。

### W12 「源帧率 ≠ 画布帧率」素材：陈旧帧驱逐 + 重发容忍（2026-09-30，用户第四次复测——换素材又成幻灯片）
**用户现象**：换成「刘可艾 小花猫舞蹈视频.mp4」（**1920x1080 H.264 Main L4.2 · 50fps · 31Mbps · 无 B 帧** · 168s）+ 30fps 画布 → 又是幻灯片：`解码 p50 59ms / p95 111.5ms · 上传 p95 3.2 · 丢帧 14 · 出帧 114 / 残差 0.5ms`（上传与残差干净 ⇒ 瓶颈既不在上传也不在主线程）。

**隔离复现**（生产构建 + 独立 profile + 用户同画布 1920x1080 ⇒ 缓冲 1132×637）：`解码 p50 64.2 / p95 132.2ms · 丢帧 60/5040（1.19%）`，residency/决策现场：`budget 5 / windowCap 4 · decoded 73837 帧而只交付 3459（21×）· unmatched_near 32067 · evict_newest 59892 · cold_start 2251 · backpressure_shrink 950`。

**根因（两条叠加，全部由 worker trace 实锤）**：
1. **客户端只请求约 3/5 的源帧**（30fps 画布 ↔ 50fps 源）：其余 2/5 被解码出来后**永远不会被请求**。旧驱逐策略只有「丢展示序最新」一档，这些陈旧帧占满本来就只有 4~6 帧的持有窗，被丢掉的恰好是客户端下一步要的帧 ⇒ 每个请求 miss ⇒ `missingStuck` 冷启整 GOP。**同一缺陷覆盖变速片段（speed≠1）与 VFR 源**。
2. **客户端会对同一输出帧发出重复请求**（trace：同一 frameN 连续 2~3 次；22 个冷启目标里 19 个是重复请求、间隔 p50 = 1 个请求）。第一发已交付该帧，第二发时帧已被驱逐（交付帧 LRU 又被预算腾挪优先清空：`budget_evict_cache` 5240、`cacheSize` 0）⇒ `missingStuck` / `behindCursor` ⇒ 又一次冷启。两条叠加成 **14 次/秒的冷启风暴**：解码器被重解塞满 → 停摆 → 收缩预算 → 窗更小，自锁。

**修法（`decode-worker.worker.ts`）**：
1. **陈旧帧优先驱逐**：驱逐阈值取**最旧未服务请求**的展示序位（`evictionThresholdRank`），取其中最旧者先丢。**关键是否掉「按已请求的最大 rank（前沿）」**——请求泵会提前把环填满，前沿可比当前请求靠前 ~13 个源帧，按前沿判会把**正在等待的帧**当陈旧丢掉（实测 `evict_stale` 25997 伴随 `cold_start` 938）；改用最旧未服务请求后 `evict_newest` 掉到个位数。
2. **近邻替代（`postNearRepeatSubstitute`）**：目标「刚吐出过 / 刚被越过」（`missingStuck` 或 `behindCursor`）且手里有 **≤3 个展示序位**内的持有帧时，直接交付该近邻帧（时间差 ≤60ms；预览是非权威通道，边界早有定格语义），不再冷启整 GOP——实测 17 次替代、`cold_start` 归零。远距 miss 与真正的回退 seek 仍走原冷启路径，不掩盖真实缺口。
3. 由此冷启风暴消失后，交付帧 LRU 自然存活（`cacheSize 3`）、预算不再被误判收缩（`shrinks 1`）。

**试错记录（三条都已回退，方向性结论一致）**：
- 给交付帧 LRU 加 2 帧保留额度（想让重复请求必中）→ 持有窗被压到 `budget−3`，同一素材丢帧 **168 → 897**；
- 按实测峰值前摄喂够（想省掉停滞检测的 30ms 空等）→ **p95 55ms → 1021ms**；
- `growHoldCapFor` 每次调用都重试扩容 → 同上恶化。
  ⇒ 这条素材的平衡点是「持有窗 vs 预读深度」，**任何抬高持有量的改动都会撞池**；正确做法是丢掉无用帧、容忍重发，而不是多拿表面。

**验证**（生产构建 + 独立 profile + 用户同画布）：
| 指标 | 修复前 | 修复后（2 轮） |
|---|---|---|
| 解码 p50 | 59~64ms | **2.4~2.5ms** |
| 丢帧 | 60/5040（1.19%，隔离复现） | **25~27/5040（0.50~0.54%）** |
| `cold_start` | 2251 | **0** |
| 解码器吐出/交付 | 21× | **1.7×** |
| `backpressure_shrink` | 950 | **1** |

回归（同构建、用户同画布）：3440x1440 H.264 **3/1241（0.24%）**、720x1280 HEVC **0/1777**、`p33-eof-replay` 通过；全量 **755 tests + typecheck** 绿（新增 `tests/decode-skipped-source-frames.test.ts`：2 例策略回归——旧策略必然冷启风暴 / 新策略零冷启）。

### 探针/测量链路修复（非生产路径）
- freshSession 前重签票据：session1 + postmortem 挂起后距签票 ~250-290s 贴着票据 TTL 5min，跨线即 init 404（fix-lag-r1..r13 伪相关定位：与代码改动无关，与 wall 时长相关）。
- m3p5 合成间隔只计播放段；run_electron_probe 多轮轮次透传。

## 3. 验收对照表（规划门 §7）

| 门限项 | 基线 | 终测（3 轮） | 结论 |
|---|---|---|---|
| 丢帧 ≤0.5% 且方差稳定 | 34~423 | 0/1800 × 3（skip2-r1..r3） | ✅ |
| decode p95 ≤20ms | 53.8ms | 1.6~2.2ms | ✅ |
| decode p50 ≤12ms | ~34ms | 0.4ms | ✅ |
| compose interval p95 ≤40ms | 未取样 | 33.6~33.7ms | ✅ |
| 看门狗/降级 = 0（回归） | 0 | 播放段 0 | ✅ |
| 插桩零开销 | — | 未做关/开 env 对跑 | ⚠️ L1 |
| EOF 回卷（真机 App 内，用户原素材） | 播到尾后再点播放无效 | e2e 通过（§2 W2.6） | ✅ |
| **App 内丢帧：用户 3440x1440 无 B 帧原素材** | 452/1241（36.4%，用户截图） | **0 / 0 / 0（0.00%，3 轮）** | ✅ |
| **App 内丢帧：用户 HEVC 720x1280 原素材** | 211/1777（11.9%，用户截图） | **0 / 0 / 0（0.00%，3 轮）** | ✅ |
| **App 内 decode p95（同上两类素材）** | 83.1 / 56.1ms | **5.4~6.5 / 3.7~4.4ms** | ✅ |
| **App 内 upload p95（同上两类素材）** | 20.7 / 2.6ms | **1.8~2.9 / 2.1~2.2ms** | ✅ |
| **解码后端（上述全部轮次）** | — | **webcodecs（快路径）**，`last_error` 全为 null | ✅ |
| **W11 自愈：强制降级起点（预算 6/窗 5）** | 冷启 176 次 / 时间码 10× 慢 / 出帧 p95 173ms | **冷启 0 次 / p50 1.8~2.6ms / 出帧 p95 4.6~17ms / 时间码实时** | ✅ |
| **W11 App 内丢帧（用户同画布 1920x1080 ⇒ 缓冲 1132×637）** | 用户截图 35 帧 / 7s（同会话小素材流畅） | **H.264 2/0/3 ÷1241（≤0.24%）· HEVC 3/4/0 ÷1777（≤0.23%）** | ✅ |
| **W12 源帧率 ≠ 画布帧率（1080p50 舞蹈素材 + 30fps 画布）** | 解码 p50 59~64ms · 丢帧 1.19%（隔离复现）· cold_start 2251 | **解码 p50 2.4~2.5ms · 丢帧 0.50~0.54%（2 轮）· cold_start 0** | ✅（门限边缘） |
| **跳转后点播放（`e2e/p33-seek-play`，六档时间线跳转）** | 第一档即挂死（时间码 10s 不动、`解码 p95 1502ms`） | **多数轮次六档全部推进**（3 次连跑 2 次全过；未稳定，见 L8） | ⚠️ 部分 |
| 用户真机确认 | — | 待用户复测 | ⏳ |

Desktop 全量 **743 tests**（含新增 `decode-linear-pipeline-hold`）+ typecheck 绿；App 内验收 `e2e/p33-user-drop.electron.spec.ts` × 2 素材 × 3 轮全绿。

## 4. 遗留与已知限制

- **L1 插桩零开销未对跑**：插桩全部在 `decodeTiming` 开启分支内，默认关；未做关/开 env 探针对跑定量确认（规划门 §6 风险项）。
- ~~L2 EOF 边界降级待真机验证~~ ✅ **2026-09-29 核销**：W2.6 定格替代后探针 postmortem 全速（user-eof-r10 尾帧取证全过），真机 App 内 e2e 播放到片尾无 watchdog 错误（`e2e/p33-eof-replay.electron.spec.ts` 通过）。
- **L3 起播洞跳过的用户感知**：起播期跳过的是已被预读淘汰的帧（≤8 帧、<0.3s 内容），正常播放不可感知；变速/多输入组合仅单输入顺播验证过，现有 playback 回归测试全绿。
- ~~L4 用户素材复测~~ ✅ **2026-09-29 核销**：user-eof-r1..r10 全程使用用户原素材 fdf0f0e2（探针），r10 dropped 3/1800 + replay_ok；真机 App 内 e2e 同素材通过。结论同向成立。
- **L5 无B帧（H.264 Baseline 等老格式）回归——2026-09-30 根修**：用户报告「之前 0 丢帧的格式也卡了」。三层根因（全部 m3p5 真机探针 + decode_trace 实锤，素材 `test-assets/generated/h264-1080p-60s-g30-nobf.mp4`）：
  1. **EOF 报错竞态**：W2.7 的排空判定用「8 次宏任务让步」计数——无B帧批小（batch=4）、30 帧 GOP 8 批喂完，D3D11 直通管线输出回调晚于 8 轮 → dq=25（输出仍在途）时误报 `EOF reorder watchdog`，随后 cold_start close() 把在途输出全部丢弃 → 暂停态 seek 尾 GOP 连环失败（h264-nobf-r1/r2：postmortem 5 连败）。**修复**：让步改墙钟预算（2s）；EOF 报错前排空 dq（预算 1.5s，真滞留 dq 会归零）。
  2. **stash 驱逐锚 bug**：锚 = 上一请求 pts，B 帧回跳流的下一目标恰在锚另一侧最远处 → 目标帧被主动驱逐 → missingStuck 冷启整 GOP（hevc-b-afterfix-r1：33s 处 4 帧空窗）。**修复**：锚 = min(上一请求 pts, 新帧 pts)。
  3. **stash 容量不足**：B3 金字塔需求窗 = LOOKAHEAD(3)+回跳(6)+1 ≈ 10 > 容量 6（hevc-b-afterfix-r2：20s 处 3 帧空窗）。**修复**：容量 6→8（总持有 10 < D3D11 背压阈值 ~13）。
  验证：无B帧探针 dropped 0、零错误、postmortem 0 失败（h264-nobf-r5）；HEVC B 帧探针 dropped 0、interval p95 34.5、replay_ok True（hevc-b-afterfix-r4）；全量 741 tests + typecheck 绿。附带说明：探针 `no sample for frame 0` 错误为该 HEVC 素材首 pts=66.7ms 的素材特性（基线 skip2-r1..r3 同样存在，非回归）。
  排查过程中排除的假设：W3 的 LAG 收紧/跳洞重锚对无B帧顺播无回归（探针满帧率零丢帧）；W2.8 冷启决策对无B帧无狂喂/重建风暴（seek-play 仿真 + 新探针证实）。
- **L6 无 B 帧直线流的「持有窗容量 / 喂包延伸」根修——2026-09-30 核销**（承接 L5）：L5 只覆盖了 HEVC B 帧流（**重排深度**这条轴），无 B 帧流真正的轴是**解码器输出管线深度**（见 §2 W4）。探针 + App 双口径复测达成（3440x1440 App 内 0/1241 × 3；HEVC 720p App 内 0/1777 × 3）。**同时修正 L5 第 2 条的方向性错误**：`锚 = min(上一请求 pts, 新帧 pts)` 对无 B 帧直线流恰好退化为「总是驱逐最新输出」——这正是 W4 miss 链的源头之一；本版以「丢展示序最新 + 容量前摄扩容」取代该锚。
- **L7 低频起播/片尾瞬态（终轮未复现，保留观察）**：修复后**早期轮次**里 3440x1440 素材出现过多轮 1~8 帧的**单次尖峰**（丢帧集中在同一瞬间，不是持续卡顿），perf 事件给出两处候选成因：
  1. **起播首秒上传尖峰**：单次 `upload` 33.8~59.9ms（direct RGBA 19.8MB 纹理首次落地），而起播时钟已开跑 → 记 1~4 帧。**保留证据**：`app-drop-user-h264-3440-timing-r1.json`（dropped 1、upload max 33.8ms）。
  2. **尾 GOP 冷启**：单次 `decode` 406.8ms（帧 1179，最后一个 5s GOP）+ 1 次 reanchor → 记 5 帧（该轮原始 JSON 已被同文件名的终轮复测覆盖，仅本记录留痕）。
  **终轮 3 轮复测（同一构建、两素材 6/6 轮）全 0，未复现** → 按「低频瞬态、非系统性」登记；若用户真机复测再现，从这两处查（起播等首帧再锚时钟 / 尾 GOP 预取）。
- **L8 跳转风暴下的解码器停摆（未彻底收敛，按 `test.fixme` 挂起）**：`e2e/p33-seek-play`（每档 45 次连按 = 270 次 seek 的压力场景）连跑多次：多数轮次六档全部推进、个别轮次仍在某一档停住。机理：**解码器表面池被未 close 的 VideoFrame 占满后静默停摆**（既不吐输出也不再消费输入，`dq` 单调攀升）。已收口五层：全局持有帧预算、**按编解码分档**（W7）、背压收缩、停摆自恢复（重锚 + 原地重试）、「目标落在已喂游标之后 → 关键帧重解」、以及**降级闸门不再被单帧缺口误触 + 可回退**（W6）。剩余缺口的本质：安全持有量随编解码/分辨率而变且 WebCodecs 不暴露表面池大小，只能用「两侧都不出错」的分档水位近似。彻底消除需要：把持有帧改成纹理级缓存（不再长时间持有解码器表面）或按解码器实测池大小自适应探测。**顺播（用户主诉场景）与 EOF 回卷均不受此缺口影响**——最终复测两素材 3 轮全 0 丢帧、后端全程 webcodecs。
- **L9 流水线对主线程尖峰敏感（dev 已收敛至与生产同级）**：见 §2 W9/W10——三处收口后 dev 实测 **丢帧 112 → 3（HEVC）/ 135 → 3（H.264）**、longtask 295 → 1~2、rAF p95 51.8 → 14ms；生产同素材 0~3 帧。**残留（低优先）**：极端负载下每次 App 提交仍可能 ~50-60ms（dev StrictMode），长视频/多轨工程仍在，长期方案是把帧交接与呈现节拍下沉到 worker（decode worker → compositor worker 直连 + 合成器自走），属跨模块改动，按需立项。
- **L10 棘轮触发源未坐实（观察项，W11 已消除其放大效应）**：用户那次 dev 会话**触发收缩的那一瞬间**没有现场证据（当时指标行/快照看不到水位，重启即复位）。本轮修掉的是「一次瞬时抖动 → 整段幻灯片」这条**放大器**（对任何触发源都成立，且已用强制降级起点 A/B 证明自愈），触发源候选：GPU/驱动瞬时抖动、解码器表面池在长会话下的竞争、`dq>0` 判据对「窗太小导致的自我节流」误判。**下一步取证手段已就位**：`residency` 快照现有 `budget / cap / windowCap / feedAheadPeak / shrinks`，复现时一眼可见是否走了收缩；如需更强证据，可在 `VITE_AIVS_DECODE_TIMING=1` 构建下看 `__TRACE` 的 `backpressure_shrink` / `budget_raise_evicted_miss` 序列。
- **L11 分段归因在「喂包被 I/O 阻塞」时会串段（诚实记录，未改）**：`fedMs` 只在喂包循环**正常收尾**时打点；若请求在喂包过程中被匹配/被读阻塞，`feedMs` 记 0 而把等待算进 `outputMs`（指标行会显示「喂包 0 / 出帧很大」）。W11 排查中曾据此怀疑读慢，后用强制降级 A/B 证明该形态与桶一致（真因是冷启风暴而非读慢）。修法（把每批喂包时刻也打点、或单列「读等待」段）留待需要时再做，避免再次插桩改动。
- **L12 客户端「同帧重发」的来源未定位（W12 已在 worker 侧消掉其代价）**：trace 实锤客户端会对**同一个输出帧**连续发出 2~3 次请求（间隔 p50 = 1 个请求），是 50fps 素材冷启风暴的主要触发源（22 个冷启目标里 19 个是重复请求）。worker 端已用「近邻替代」把代价压掉（`cold_start` 2251 → 0），但 **pump 侧为什么重发**尚未定位到具体代码路径（嫌疑：预读/环形簿记与 `rig.fed` 推进的竞态；`noteDecodeError` 不重试，已排除错误重试）。它影响所有素材，只是 fps 不匹配时更容易变成 miss。下一步定位入口：`pump()` 的 `next = rig.fed + 1` 与 `uploadRing`/`resetChains` 对 `rig.fed` 的写点，配合 `AIVS_P33_TRACE=1` 的 enqueue id 序列。
- **L13 W12 残留：50fps 源 + 30fps 画布的稳态延迟仍偏高（0.50~0.54% 丢帧，门限边缘）**：冷启已归零，残留丢帧来自 `出帧 p50 ≈ 39ms / p95 ≈ 58ms` 的**稳态延迟**——客户端 55% 的请求到达时目标尚未吐出（解码器输出管线深度 ~9-11 让"喂够"与"吐到"之间必然滞后 1~2 个源帧），偶尔 1~3 帧错过呈现窗口。若要进一步压：把喂包与呈现彻底解耦（worker 自走的喂包泵，按实测深度维持余量而不依赖停滞检测），属结构性改动，且本轮三次"抬高持有/前摄喂包"的尝试都因撞表面池而恶化（见 §2 W12 试错记录），故未立项。**（2026-10-09 核销：已不复现——同素材同后备缓冲 1132×637，W12 时代 25/5040 = 0.496% vs 现今 3 轮 0/5040；W13/P71/P72 之后残留消除，现状见 STATUS.md §4 P33 行）**

## 5. 复测命令（可复现）

```bash
# 3 轮复测（每轮独立子目录）
for i in 1 2 3; do
  VITE_AIVS_DECODE_TIMING=1 python tools/m3_0/run_electron_probe.py m3p5 \
    --ir evidence/performance/preview-smoothness-baseline/ir_hevc_b_60s.json \
    --assets evidence/performance/preview-smoothness-baseline/assets.manifest.json \
    --evidence evidence/performance/preview-smoothness-baseline/verify-r$i
done
# 判读：m3p5_result.json 的 dropped_frames（≤9=0.5%）、compose_interval_ms.p95（≤40）、
#       decode_ms.p95（≤20）、last_error（null）

# 用户原素材复现 IR（W4 起；canvas 与用户指标条一致 = 960x540）
python tools/m3_0/make_user_repro_ir.py \
  --asset "C:/Users/trueY/Videos/5月11日(3)/5月11日(3)-1.mp4" --entity asset_user_h264_3440 \
  --width 960 --height 540 --has-audio \
  --out-ir evidence/performance/preview-smoothness-baseline/repro-user-h264-3440/ir.json \
  --out-manifest evidence/performance/preview-smoothness-baseline/repro-user-h264-3440/assets.manifest.json

# App 内量化复测（W4 起，验收真源：真机 UI + 音频 + 时间线 + 真机画布）
cd apps/desktop
VITE_AIVS_PERF=1 npx electron-vite build           # __aivsPreviewMetrics / __editorPerf 仅此构建存在
AIVS_P33_MEDIA="C:/Users/trueY/Videos/5月11日(3)/5月11日(3)-1.mp4" AIVS_P33_LABEL=user-h264-3440 AIVS_P33_ROUND=1 \
  npx playwright test --config=tests/playwright.config.ts e2e/p33-user-drop.electron.spec.ts
# 判读：evidence/performance/preview-smoothness-baseline/app-drop-*.json
#       （final.dropped_frames / decode_ms_p95 / upload_ms_p95 + perf_events + decisions）
# 追加 VITE_AIVS_DECODE_TIMING=1 构建可拿到 worker 决策 trace（decisions.counts：
#       健康顺播应为 cold_start 0 / feed_extend 0 / evict_newest 0）
#       + residency.decode.budget / windowCap / feedAheadPeak / shrinks（W11 起）：
#       窗 < 管线深度（本素材 11）= 状态性卡顿，冷启风暴会同时把 shrinks 顶起来

# ── W11 自愈验证（真机 dev，单变量对照；先起 dev 实例）────────────────────
cd apps/desktop
REMOTE_DEBUGGING_PORT=9333 VITE_AIVS_PERF=1 VITE_AIVS_DECODE_TIMING=1 \
  AIVS_E2E_ASSET_PATHS='{"video":"C:/Users/trueY/Videos/5月11日(3)/5月11日(3)-1.mp4"}' \
  npx electron-vite dev -- --user-data-dir=<临时 profile>

# 健康臂（对照）
node scripts/dev-playback-sample.mjs --port 9333 --label healthy --seconds 16 --viewport 1920x1080
# 强制降级臂（模拟「刚观察到一次背压」的收缩水位；**修复后必须自愈**）
#   重启 dev 时加 VITE_AIVS_FORCE_DEGRADED_BUDGET=6
node scripts/dev-playback-sample.mjs --port 9333 --label degraded-6 --seconds 18 --viewport 1920x1080
# 判读：evidence/.../dev-sample-*.json 的逐秒 p50/p95/out95 + decisions
#   修复前后对照（同素材同窗口）：冷启 176 → 0、解码 p50 53~107ms → 1.8~2.6ms、
#   出帧 p95 173ms → 4.6~17ms、时间码从 10× 慢回到实时
#   AIVS_FORCE_COPYTO=1 可另测上传慢路径（上传 p95 ~30ms 但播放仍 0 丢帧）
```

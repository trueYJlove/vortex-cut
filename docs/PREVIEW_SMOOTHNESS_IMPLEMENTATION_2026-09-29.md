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
- **L8 跳转风暴下的解码器停摆（**未彻底收敛**，按 `test.fixme` 挂起）**：`e2e/p33-seek-play`（每档 45 次连按 = 270 次 seek 的压力场景）连跑多次：多数轮次六档全部推进、个别轮次仍在某一档停住。机理：**解码器表面池被未 close 的 VideoFrame 占满后静默停摆**（既不吐输出也不再消费输入，`dq` 单调攀升）。已收口五层：全局持有帧预算、**按编解码分档**（W7）、背压收缩、停摆自恢复（重锚 + 原地重试）、「目标落在已喂游标之后 → 关键帧重解」、以及**降级闸门不再被单帧缺口误触 + 可回退**（W6）。剩余缺口的本质：安全持有量随编解码/分辨率而变且 WebCodecs 不暴露表面池大小，只能用「两侧都不出错」的分档水位近似。彻底消除需要：把持有帧改成纹理级缓存（不再长时间持有解码器表面）或按解码器实测池大小自适应探测。**顺播（用户主诉场景）与 EOF 回卷均不受此缺口影响**——最终复测两素材 3 轮全 0 丢帧、后端全程 webcodecs。

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
```

# C20-T/B11-D(下一工作包)Planning Gate(2026-09-12)

角色:LiuWei(范围与验收口径,待批准)。依据:C20 v2 A/B 报告
`PERFORMANCE_C20_PHASE2_AB_2026-09-12.md` §3/§5(性能目标未全达,残余项列调优清单)、
B13-R 判别结论 `PERFORMANCE_B13_RESIDENCY_IMPLEMENTATION_2026-09-11.md` §6
(应用层无泄漏,真实方向转 Chromium 上游/B11 代理降档)、主计划头部
"更新·五/更新·六"的下一工作包建议。

## 1. 问题重述(实测驱动)

**取窗等待(v2 seek 退化)**:C20 v2 数据面下,未缓存窗口的 seek 新增
`await ensureRange`(单窗 IPC 50–70ms),随机 seek p95 退化 F01 +31%
(29.2→38.2ms)、F03 +29%(30.8→39.7ms),超出 §5.2 的 ≤20% 门。
【2026-09-13 勘误:F03 的 39.7ms 系混入修复前目录的数值,-v2 目录实测
31.1ms(+1%),F03 seek 退化从未成立;不影响本 Gate 范围与 T1 验收门
(F01 退化真实存在且已由 T1 消除)——见
`PERFORMANCE_C20T_AB_ACCEPTANCE_2026-09-12.md` §8.2。】缓存参数
全部硬编码:窗口 300 帧(契约硬上限)、缓存预算 8MiB、在途上限 2、
预取仅沿播放方向 1 窗——随机 seek 与首窗外触达均需现场取窗。

**ready 串行链(v2 装配退化)**:v2 ready = manifest 请求 + 首窗请求
两次**串行** IPC + 契约解析。F01 ready 2386→3200ms(+34%)。"ready <2s"
目标 v1 基线即未达(F02 5.78s),其归因从未分解——本轮先分解再决定
是否立项,不承诺未归因的绝对值目标。

**F02 内存(16.6GiB)的残余路线**:B13-R 三轴判别已排除应用层可修对象
(Chromium 层有界池高水位,~600KB/帧 @640×360,随 unique 帧数饱和,
2400s 无晚发增长)。真实可行动方向 = **B11 代理降档**(解码输入换成
低分辨率代理,帧字节按像素数线性缩小,Chromium 池结构不变、总量降档),
或 Chromium 上游行为变更(超出本轮能力,登记不动)。

## 2. 范围

三个子包,一次 Gate 批准,D 决策点独立:

- **S1 小修包(不等其余,先行)**:
  1. input-pool-protocol 测试 2 个 unhandled rejection(ack promise 在
     terminate 后 reject 无人消费,B13-R 报告 §4 经 git stash 对照确认为
     HEAD 既有);
  2. failure.json 持久化**脱敏**错误文本(runner 侧,按既有隐私策略裁剪)
     ——可诊断性缺口,是 F02 低频崩溃待查的前提;崩溃本身仍登记待查,
     不入本轮。
- **C20-T1 seek 取窗调优(Desktop,ZhangSan 配合契约)**:
  - 缓存预算参数化:`resource-budget.ts` 档位表新增 `windowCacheMiB`
    (初值 conservative 16 / balanced 32 / high 64,对照现硬编码 8MiB)、
    `prefetchWindows`(默认 1,上限 2)、`maxInFlight`(默认 2,上限 4);
    windowedFrameSource 改读档位,默认值语义不变。
  - seek 落定后的方向性预取(目标窗 ±2,去抖后发起,受在途上限约束);
    复用既有 `window_fetch` 遥测评估命中率。
- **C20-T2 ready 并行化(Desktop + Core 配合)**:
  - 首选**无契约变更**方案:Core 在 manifest 响应返回前预热首窗
    (window 0 服务端预 stage),或 Renderer 侧 pipeline 化(收到
    manifest_id 即发首窗请求,解析后置);
  - 契约级合并端点( manifest+首窗一次往返 )仅在无契约方案实测不达标
    时提请契约 Gate,不默认做;
  - 附带交付 ready **分段遥测**(manifest/首窗/解析/注入四段),产出
    F02 5.7s 的归因分解报告——绝对值 <2s 目标本轮不设门,按归因另立。
- **B11-D 代理降档决策轮(测量+决策,不含实施)**:
  - D1 spike:F02 用强制 320×180 代理作为解码输入(source-resolver
    指向手工转码产物,不改默认策略),5 轮实测 Tab WS 平台,对照
    `predictResidencyBytes` 预测(~150KB/帧 → 27000 帧 ≈ 4.0GiB + 0.4GiB
    base ≈ 4.5GiB 量级,允差 ±25%);
  - D2 决策备忘录(LiuWei 裁决):i) auto 模式接入驻留预测的降档触发
    线(B11 规范已留"超预算时请求代理"语义,阈值用 predictResidencyBytes
    对照档位预算);ii) 是否增设低于源短边的档位(F02 640×360 源对
    preview-540/720/1080 均禁上采样不生效,无既有档可用);iii) 代理
    质量降级的 UX 登记(沿用 B11"质量变化记录为代理降级,不混同原片
    基准")。若批准实施,另立 B11-D2 工作单,不在本 Gate 内预授权。

**不修改**:C20c(dirty-range 复用,优先级维持中,继续挂起)、Chromium
上游行为、v1 数据面、导出管线、音频链路、B16 调度语义、4K60 两产品
缺陷(DEFECT-4K60-SEEK/SESSION-HANG,产品工作单单独排期)、
GAP-LIST-ASSETS-PAGING(产品工作单,是后续 F04 100 素材口径复测的
前置,不阻塞本轮)。

## 3. 验收口径

| 项 | 判定 |
|---|---|
| S1 | Desktop 单测 unhandled rejection 归零;failure.json 含脱敏错误文本(单测覆盖);既有 619 项不回归 |
| C20-T1 | F01/F03 v2 seek p95 相对 v1 退化收敛到 **≤20%**(现 +31%/+29%);命中缓存 seek 不劣化;window_fetch 命中率/预取取消率入报告;行为正确性(可播可 seek、v1/v2 帧内容对拍不变) |
| C20-T2 | v2 ready 相对 v1 退化 ≤5%(F01 现 +34%);ready 分段遥测四段贯通;F02 ready 归因分解报告交付(绝对值不设门,如实登记) |
| B11-D1 | spike 报告:实测平台值与预测允差 ±25% 内即"预测器可作触发线";超出则如实记录并回退到"实测标定"路线 |
| B11-D2 | 决策备忘录三问全部有结论(含"不实施"),LiuWei 签署 |
| A/B 口径 | 全部沿用 B00 harness:5 轮中位、off 复测 ±5%、同机插电关后台、environment 入档;v2 经 `VITE_AIVS_PREVIEW_IR_V2` 开关,默认 off 维持至"默认 on"决策 |
| 默认 on 决策 | 仅当 T1/T2 达标**且** B13+C20 二阶段独立验收通过后,作为独立决策项提请(LiuWei),不在本轮自动翻转 |

## 4. 风险与边界

- 预取风暴:seek 拖拽期间预取请求放大 IPC/CPU——预取仅在 seek 落定
  (去抖)后发起,受 maxInFlight 硬上限约束;遥测须包含被取消预取计数,
  证明"预取不与用户目标抢在途额度"。
- 预算调大的内存代价:v2 缓存的是 IR 帧元数据(~500B/帧实值),64MiB
  档对应数十万帧级元数据,与解码驻留(Chromium 池)正交,不得混淆口径
  ——报告须分列 JS 堆增量与 Tab WS。
- B11-D spike 的 320×180 预览质量不可作产品默认:spike 仅为测量,
  默认策略零改动;若 D2 批准降档触发线,小源(如 F02 类 360p 长源)
  的档位缺口是决策输入之一,不是既定结论。
- 无契约 ready 方案若依赖 Core 预热,须确认 Core manifest 端点在返回前
  预热不拖慢 manifest 自身(p95 对照),否则回退 pipeline 化。
- 机器噪声与 B13-R 同规:同机、插电、关后台,N≥5 轮,报告附 environment。

## 5. 开工前代码证据(2026-09-12 盘点,HEAD d032ea3)

- `apps/desktop/src/app/preview/frame-source.ts`:DEFAULT_CACHE_BYTES=8MiB(64)、
  DEFAULT_MAX_IN_FLIGHT=2(66)、FALLBACK_FRAME_BYTES=4096(68)、
  windowStartOf(100)、evictIfNeeded(101)、ensureRange 按窗口起点枚举
  (168–176);预取仅目标窗+下一窗(调用方 ensureRange 语义)。
- `apps/desktop/src/app/preview/preview-session.ts`:seekToFrame await
  ensureRange(1306)、播放 BACKSCAN ensure(835);装配链
  getPreviewIrV2Manifest→windowedFrameSource→首屏 ensureRange 串行
  (C20 二阶段报告 §2 目标 3)。
- `packages/contracts/src/performance.ts:460`:PREVIEW_IR_V2_MAX_WINDOW_FRAMES=300。
- `apps/desktop/src/app/preview/resource-budget.ts`:BUDGET_TABLES(1–30)、
  tierForTotalMemory(38)、predictResidencyBytes(78,~600KB/帧锚定 + 0.4GiB
  base,≥4× 锚定尺寸封顶)——B11-D 触发线与 T1 档位扩展均挂此表。
- `services/core/src/aivs_core/media/proxy_profiles.py`:preview-540/720/1080
  档位、禁上采样、CFR30/GOP15 闭合/无 B 帧/pts 归零;`run_proxy_job` 全链
  已交付(B11 报告)。auto 模式语义"超预算时请求代理"已预留,未接驻留预测。
- runner:`tools/performance/` failure.json 仅持久化 status(如
  invalid-incomplete),错误文本按隐私策略未持久化(B13-R §5 勘误口径)。

## 6. 门判定

**批准(2026-09-12,LiuWei)**:范围/口径如上,次序 **S1 → C20-T1 →
C20-T2 → B11-D**(S1 先行清障;T1/T2 可并行;D 的决策点在 spike 证据齐
后独立裁决)。实现按"可审查单提交"推进:S1 一提交、T1 一提交、T2 一
提交、D 报告一提交;各自报告落档 `docs/PERFORMANCE_*_2026-09-*.md`,
主计划头部同步"更新·七"。

| 批准项 | 结论 |
|---|---|
| 范围(§2)/验收(§3) | **批准** |
| 次序与并行关系 | **批准** |
| 默认 on 决策挂起至验收通过后 | **批准** |

(2026-09-12 经 LiuWei 批准,主计划头部"更新·七"已同步登记。)

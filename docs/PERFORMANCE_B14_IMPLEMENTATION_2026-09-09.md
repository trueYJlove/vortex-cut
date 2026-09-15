# B14 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B14(素材级持久化波形)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B14 与
第 6.1 节跨进程契约规则,在 B13(`d86895e` 报告收尾)之上实施,按
"Core 生成 → 契约/IPC 贯通 → Renderer 换链 + 预算接线"四个可审查提交
推进。

四个提交(单一目标,均本地,未 push):
- `ae4f328` B14-A Core 波形生成(流式金字塔 + 派生缓存/作业/端点)
- `22ad690` B14-B 契约与 IPC 贯通(performance.ts B14 段 + 8 通道 + preload)
- `91e6c96` B14-C Renderer 换链(waveform-cache + TimelineCanvas 移除整媒体解码)
- (本提交)B14-D A02 PCM 预算接线 + 本报告

## 2. 修改单(模板)

```text
修改单:B14 素材级持久化波形
基线HEAD / 工作树标识:d86895e(B13 报告);四个本地提交
目标与不修改范围:
  目标——波形移出 Renderer 整音频解码链:Core 后台 FFmpeg 输出固定
  采样率 mono(8000Hz)流式 stdout(不先读全部 PCM),每 256 samples
  计算 min/max 并逐级 2 倍汇总成金字塔;base 层覆盖全部原素材;key 按
  asset fingerprint + 算法参数;结果 = 小 header + Float32 min/max 二
  进制块,经 Main 受控票据访问;clip 显示映射使用 source_start/end、
  speed、reverse(同源不同 trim 不再共用同一全源图)。
  附带清偿——B13 已知限制"PCM 缓存预算表值已定未接线":A02
  AudioSourceCache 增加 ready 条目字节记账 + 超限 LRU 逐出(无活跃
  用户者;活跃条目正确性优先),preview-session 按 resource_tier 注入
  pcmCacheMiB(64/128/256MiB)。
  不修改——B15 分块 PCM/流式 worklet(A02 整段解码回退仍在,长素材
  "支持任意长度音频"仍不宣称);B16 调度(波形作业 resource_class=light
  走既有 jobs 队列);restricted-media 票据协议(B14 复用 purpose=
  "proxy" 注册通道);TimelineCanvas 波形绘制视觉(剪映式轮廓逐像素
  算法不变,仅峰值来源与取窗换链)。
实际修改文件(绝对路径):
  services/core/src/aivs_core/media/waveform.py(新增)
  services/core/src/aivs_core/jobs.py(WaveformRunner + _run_media 分派)
  services/core/src/aivs_core/app.py(服务装配 + 2 端点 + WaveformRequest)
  services/core/tests/unit/test_waveform.py(新增,18 项)
  services/core/tests/integration/test_waveform_api.py(新增,7 项)
  packages/contracts/src/performance.ts(B14 段:类型 + 校验器)
  apps/desktop/electron/main/performance-ipc.ts(waveform:get/media)
  apps/desktop/electron/main/core-admin-client.ts(resolveWaveformMedia)
  apps/desktop/electron/main/index.ts(接线)
  apps/desktop/electron/preload/index.ts(DesktopApi +2 方法)
  apps/desktop/src/app/timeline/waveform-cache.ts(新增)
  apps/desktop/src/app/timeline/TimelineCanvas.tsx(换链,移除旧解码链)
  apps/desktop/src/app/App.tsx(WaveformCache 注入)
  apps/desktop/src/app/preview/audio-source-cache.ts(PCM 预算)
  apps/desktop/src/app/preview/preview-session.ts(pcmCacheMiB 注入)
  测试:tests/performance-ipc.test.ts(B14 describe 5 项)、
    preload.test.ts(白名单 +2)、tests/waveform-cache.test.ts(新增 13 项)、
    tests/preview-audio-cache.test.ts(预算 describe 4 项)、
    app/editor-commands/editor-shell mock +2 方法。
前置Gate与接口版本:B10 派生缓存完整(kind=waveform 枚举/表/refs 均已
  存在);B11 作业/端点模式;B13 resource_tier 注入(PCM 预算接线依赖)。
算法/状态机变化:
  - Core 聚合:MinMaxAggregator 流式 O(1) 状态(256 样本桶 min/max),
    write() 自底向上重建金字塔(层 k 桶数 = ceil(base/2^k),低层在前
    的 float32 [min,max] 序列);产物头 = magic "AIVSWF01" + u32 header
    长度 + JSON(采样率/通道/桶宽/层数/桶数)。
  - FFmpeg 参数白名单:mono 8000Hz pcm_s16le raw → pipe:1(-vn,
    -map 0:a:0);进度/取消语义与 render.py 相同(0.05s 轮询 kill)。
  - Renderer 取窗:srcUs = reverse ? sourceEnd - offset*speed :
    sourceStart + offset*speed(对齐 computeFrameRequests);
    选层 pickLevel(每像素约一桶);桶峰值 = max(|min|,|max|)。
  - 缓存状态机:pending(describe 在途/building)→ ready(金字塔驻
    留,LRU 字节上限默认 64MiB)/failed(不自动重试,retry() 门)。
授权、取消、资源所有权、缓存失效规则:
  - 波形产物复用 B10 授权链:cache_key 内容寻址;media 解析仅 admin
    通道,refs 表记录 project/asset 引用;Renderer 只收票据 URL。
  - 文件解析端点无请求体——参数(8000/1/256)由服务端算法常量唯一
    决定,Renderer 不可注入。
  - 生成作业登记时取 stat(size, mtime_ns),执行期复验(MEDIA_CHANGED);
    无音轨 MEDIA_NO_AUDIO 明确失败。
  - 失败 mark_failed + 占位行(同 B11 幂等短路模式);磁盘预算
    enforce_disk_budget 前置。
新增/修改测试与命令:
  Core:.\.venv\Scripts\python.exe -m pytest services/core/tests/unit
    test_waveform.py -q(18);integration/test_waveform_api.py -q(7)
  Desktop:pnpm typecheck / vitest run(63 文件 556 项;
    waveform-cache 13、performance-ipc B14 5、audio-cache 预算 4)
功能回归结果(含跳过):
  Core 全量 unit 562 通过;B10/B11 相关集成 22 通过。Desktop 全量
  63 文件 556 项通过(2 个 jsdom HTMLMediaElement stderr 噪声为既有
  基线,与 B14 无关——B14-C 期间曾引入 65 个 unhandled rejection
  (mock 返回 undefined),已修复为静默降级后归零)。
before / after / 同机环境:
  B14 为能力换链(波形来源从 Renderer 整媒体解码 → Core 流式金字塔
  产物);"同源 50 clip 一次构建/解码"、"Renderer 不再调用
  decodeAudioData 生成波形"以单测断言覆盖;F01/F04 端到端同机量化
  (内存/耗时)列 F 场景复测轮,本报告不宣称实测数字。
质量与失败路径验证:
  - 金字塔逐层与全量重算 reference 一致(单测);文件损坏(magic/
    截断/层数越界)拒绝。
  - 假 FFmpeg 子进程全链:产物可解析、无音轨拒绝、stat 变化拒绝、
    非零退出 mark_failed、already-ready 短路不重转。
  - Renderer:pending 不 fetch、失败不自动重试、LRU 逐出与字节记账、
    dispose 清空;描述/媒体返回 undefined 等非法形状静默降级。
开关、兼容与回退:
  - 纯增量:waveformCache 不注入(TimelinePanel 无该 prop)= 不显示
    波形(与旧链路 fetch 失败行为一致,不回退旧解码链——计划要求
    移除而非双跑)。
  - Core 端点未就绪(旧 Core):getWaveform 抛错 → failed 条目 →
    静默无波形;不冒充数据。
  - B13 档位未注入(旧调用方):AudioSourceCache maxCacheBytes=null
    默认不限,行为与 B13 前一致。
已知限制、未解决问题:
  - PCM 预算为"尽力而为"会话级回收:活跃条目不清(正确性优先),
    单源超预算时如实超限(overBudget 暴露);B15 分块流式落地前仍
    不宣称长音频内存有界(A02 限制原文保持有效)。
  - 波形产物一次整文件取件(金字塔设计上界 ~8.6MiB/小时源,远小于
    B10 磁盘产物与旧链整媒体);"每次响应 ≤256KiB"的字节门在当前
    全金字塔取件路径下未启用分窗请求(端点支持后续 Range 扩展,
    见 B12 票据 Range 语义;需求出现时再做窗口化取件,不阻塞 B14)。
  - 金字塔驻留 Renderer 堆:默认 64MiB LRU 上限(保守;档位化留
    F 场景调优)。
  - 波形生成在导入时不触发(计划:禁止导入即生成)——首次时间轴
    可见即触发 describe(generate=true)登记作业;building 期间无
    波形显示(占位),job 完成后下轮视口变更/重渲染 bump 出现。
  - F06(播放+导出并发)下波形作业 resource_class=light 的调度行为
    未实测(B16 完整配额前保持单飞)。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:F 场景复测轮(B10-B14 能力就绪,F01-F04 量化验收);
  或 B15(分块 PCM 与流式 worklet——A02 整段回退届时替换为流式主
  路径,PCM 预算语义升级为分块缓存)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| Core 聚合/文件 | test_waveform.py(单测) | 18 | 脉冲定位/静音/min-max 对保留/金字塔 vs reference/尾桶/roundtrip/损坏拒绝/字节估算/缓存键稳定(换 build 换键)/作业载荷/全链 ready(假 ffmpeg)/无音轨/MEDIA_CHANGED/失败 mark_failed/already-ready/参数白名单/jobs 分派 |
| Core 端点 | test_waveform_api.py(集成) | 7 | UI 401/无音轨 MEDIA_NO_AUDIO/generate 登记与幂等短路/跨项目越权/素材缺失/admin-only resolve + refs 记录/未就绪 404 |
| 契约/IPC | performance-ipc.test.ts(B14 段) | 5 | 8 通道白名单/UI 通道请求形状/请求键严格拒绝/rendererSafe 剥离/admin resolve 票据换发不泄路径/未就绪+无音频+未知键拒绝 |
| preload | preload.test.ts | +2 行 | getWaveform/waveformMediaUrl 固定 channel 路由 |
| Renderer | waveform-cache.test.ts | 13 | 解析(magic/布局/roundtrip/损坏)/脉冲/trim 取窗/倒放镜像/2x 映射/静音与非法区间/pickLevel/single-flight 3 并发 1 次/pending 不 fetch/失败重试门/LRU 逐出记账/dispose |
| PCM 预算 | preview-audio-cache.test.ts(预算段) | 4 | ready 记账/超限 LRU(release 后逐出最旧)/活跃条目不清+overBudget 如实/dispose 清零 |

- Core 全量 unit:**562 通过**;Desktop 全量:**63 文件 / 556 项通过**,
  typecheck(tsc)通过。
- B13 时为 62 文件 / 534 项;净增主要为 B14 四层测试。

## 4. 与实施计划的偏差

- 计划"每次响应建议 ≤256KiB":实现为整金字塔一次取件(设计上界
  ~8.6MiB/小时源)。理由:时间轴绘制需任意窗口峰值,金字塔已把字节
  压到 MiB 量级;分窗取件会引入窗口协议复杂度而无当前必要。端点/
  票据链路支持后续 Range 扩展(B12 语义),列入已知限制而非静默缩减。
- 计划"worker 线程/进程计算每 256 样本聚合":FFmpeg 子进程即计算
  主体(解码/重采样在子进程),主进程只 O(1) 聚合状态——不另起第二
  个 worker 进程(等效满足"不得先读全部 PCM"与主进程不阻塞)。
- 计划"可见区优先生成/加载,后台预算由 B16 接管":当前按"时间轴
  视口内素材触发 describe(generate)"实现(可见区优先达成);B16
  前波形作业与代理作业同走 jobs 队列(单飞),无额外优先级通道。
- PCM 预算(B13 遗留)随 B14 落地:计划原文将其归入 B13 表值;
  接线语义 = ready 条目 LRU 回收 + overBudget 如实暴露(不静默漏音),
  非硬上限(见已知限制)。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_waveform.py services/core/tests/integration/test_waveform_api.py -q
pnpm --filter @aivideo/desktop test          # 63 文件 556 项
npx vitest run tests/waveform-cache.test.ts tests/preview-audio-cache.test.ts tests/performance-ipc.test.ts
pnpm --filter @aivideo/desktop lint
```

# B11 实施进度与自检报告(2026-09-09)


> **2026-11-02 局部更正（本文件其余部分仍为 2026-09-09 时点记录）**：§幂等 一行原写
> 「preview-source/jobs 对 ready/building/queued/failed 均短路」，**已失真**。
> 实测确认该行为让代理一旦失败便永久无法重登记（路由层死锁，而缓存层本可重建），
> 与同仓 waveform 路由既有约定相反。2026-11-02 已修：两处路由门改为
> {ready, building, queued} 短路、**failed 允许重登记**；
> 并修正了把它固化为例外的 test_preview_source_api.py。
> 以此处为准，正文该行不得再引作现状（见 docs/STATUS.md §4 P207）。

## 1. 状态与范围

**B11(全源代理与预览源选择)代码完成 + 功能验证完成(含真实 FFmpeg 转码链)。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B11 与
第 6.1 节跨进程契约规则,在 B10(`ed0032d` 及此前四提交)之上实施,按
"档位模型 → Core 服务/端点 → Desktop 接入 → 回归"四个可审查提交推进。

四个提交(单一目标,均本地,未 push):
- `18e8a5c` B11-A 代理档位与时间映射模型(proxy_profiles.py + 24 单测)
- `b4012d2` B11-B preview-source 服务/端点/作业接入 + mark_failed 守卫
- `4859780` B11-C Desktop source-resolver 接入(契约/IPC/preload/会话)
- (本次)B11-D mark_failed 原子认领修复 + 回归 + 本报告

## 2. 修改单(模板)

```text
修改单:B11 全源代理与预览源选择
基线HEAD / 工作树标识:ed0032d(B10-D 收官);四个本地提交
目标与不修改范围:
  目标——可用于长源的整段代理(preview-540/720/1080 档位、CFR30、闭合
  GOP≤15、无 B 帧、pts 归零、禁上采样、硬编不传 veryfast),代理作业进
  B10 derived_media_cache(begin/commit/mark_failed + refs 授权),Core
  三个端点(描述/作业/票据),四层契约贯穿(contracts → Core → Main IPC →
  preload),Renderer source-resolver 预览源选择(代理 ready 换代理票据,
  否则原源回退、永不阻塞预览)。
  不修改——render.py 既有 build_render_args(10 秒 sample 路径语义不变,
  代理走 proxy_profiles.proxy_args 独立白名单组装)、预览会话的 IR/几何/
  合成路径(代理只替换解码输入 URL,IR geometry 与 PiP/裁切坐标语义不变)、
  B10 存储层布局/键语义、媒体票据 TTL 机制。
实际修改文件(绝对路径):
  services/core/src/aivs_core/media/proxy_profiles.py(新增)
  services/core/src/aivs_core/media/preview_source.py(新增)
  services/core/src/aivs_core/media/derived_cache.py(mark_failed 原子认领)
  services/core/src/aivs_core/jobs.py(_run_media 载荷分派 + runner 注入)
  services/core/src/aivs_core/app.py(CoreState 接线 + 3 端点 + 请求模型)
  packages/contracts/src/performance.ts(B11 类型/校验器)
  apps/desktop/electron/main/performance-ipc.ts(+3 channel)
  apps/desktop/electron/main/core-admin-client.ts(resolvePreviewSourceMedia)
  apps/desktop/electron/main/index.ts(依赖注入)
  apps/desktop/electron/preload/index.ts(白名单 +3 方法)
  apps/desktop/src/app/preview/source-resolver.ts(新增)
  apps/desktop/src/app/preview/preview-session.ts(create 接 resolver)
  apps/desktop/src/app/preview/SyntheticPreview.tsx(props 透传)
  apps/desktop/src/app/App.tsx(resolver memo + 透传)
  测试:services/core/tests/unit/test_proxy_profiles.py(24)、
    test_preview_source.py(17)、integration/test_preview_source_api.py(11);
    apps/desktop/tests/source-resolver.test.ts(5)、performance-ipc.test.ts
    (+6 → 13)、preload.test.ts(+3 断言)、3 个 DesktopApi mock 文件补方法。
前置Gate与接口版本:B10 四提交完整(能力基座);无 DB 迁移(v18 表直接
  复用;jobs 表用既有 kind="proxy" + input_json 载荷字段分派,不迁移)。
算法/状态机变化:
  - 代理档位:preview-540-v1/preview-720-v1/preview-1080-v1(短边,禁上采样,
    旋转/SAR 归一显示比例,编码宽高偶数);choose_profile 按源短边选档,
    预算上限默认 720(1080p+ 源降 720 档——B13 显存预算接入后再放开)。
  - 代理规范:MP4/AVC yuv420p faststart CFR30、GOP=15 闭合(-sc_threshold 0
    + keyint_min)、-bf 0 无 B 帧、-ss 0 pts 归零、-an 无音频(音频走原素材
    B15)、编码器专属参数(libx264 preset medium+crf23;libopenh264 2M;
    硬编按档位 3M/5M/9M——禁止无条件 veryfast)。
  - 作业分派:jobs._run_media 按 input_json.cache_key 存在性分派——B11 全源
    代理(run_proxy_job:probe→begin_build→转码→commit_ready)与旧 10 秒
    sample 路径(artifacts 行)互不干扰;失败/取消 mark_failed。
  - mark_failed 原子认领(B11-D 修复):UPDATE ... WHERE status='building'
    先认领,认领成功才 rmtree——迟到的失败不删/不覆盖他人已发布的 ready
    条目(single-flight 语义完备;此前只有 UPDATE 守卫,rmtree 无守卫,
    集成测试暴露真实竞态:后台作业失败时删除测试直插的 ready 产物)。
  - 工具链指纹:aivs-core-proxy-v1|<ffmpeg-build>(B10 报告已知限制清偿:
    FFmpeg 更换即键换代;构建期同步探测一次,不可用明确落 no-ffmpeg-build)。
  - Renderer source-resolver:auto 模式代理 ready 时换代理票据,否则 null
    (调用方保留原源票据);IPC 失败静默回退;每素材 single-flight 缓存。
授权、取消、资源所有权、缓存失效规则:
  - 三个新端点全部 require_ui(admin 票据端点 require_admin);跨项目/
    缺素材 ASSET_NOT_FOUND;archived 409(与 B10 端点同语义)。
  - 代理票据经 admin resolve → restricted-media purpose="proxy" 换票——
    Renderer 只拿 aivideo:// URL(同 B10 media 通道)。
  - 禁止导入即转码:generate=true 且 mode="proxy" 才登记作业;ready/
    building/queued/failed 状态幂等短路(不重复登记)。
  - 缓存失效:fingerprint(内容寻址)+ profile + ffmpeg build 入键——
    原片变化/换档/换工具链即键变化,旧条目按 LRU 回收。
新增/修改测试与命令:
  Core:.venv pytest(test_proxy_profiles/test_preview_source/
    test_preview_source_api + 全量 -m 'not real_provider')
  Desktop:pnpm typecheck / lint / test(58 文件 485 项)
  真实链验证:resources/ffmpeg/win-x64(ffmpeg n8.0.1)——1080p60 源
    4s → 代理 1280x720 CFR30 时长 4_000_000us、I=8/P=112/B=0、moov 前置
    (faststart)、软编回退(libopenh264,硬编 smoke 失败如实降级)。
功能回归结果(含跳过):
  Core 全量 677 项通过(1 deselected = real_provider;B10 时 625);
  Desktop 58 文件 485 项(B10 时 57/474);typecheck/lint 通过;
  contracts 构建(pnpm contracts:generate)通过。
before / after / 同机环境:
  B11 为能力建设(代理生成与源选择),无既有路径性能数字目标;长源
  播放收益的量化验收(F03 末尾可播、稳态覆盖)归 B12 Range demux +
  B13 预算接入后的端到端复测。
质量与失败路径验证:
  - 生成失败(无 FFmpeg/探测失败):行标 failed + INSERT OR IGNORE 占位
    (幂等短路有据);retry 语义走既有 jobs.retry(queued/failed 可重试)。
  - 竞态:mark_failed 原子认领(见上);begin_build 单进程 single-flight
    + SQL building 行跨进程防重(既有 B10 语义)。
  - Renderer 路径:source-resolver 失败一律回退原源(预览永不断供);
    IPC 层白名单错误码透传(DERIVED_NOT_FOUND/PREVIEW_PROFILE_INVALID 等)。
  - 幂等:preview-source/jobs 对 ready/building/queued/failed 均短路。
开关、兼容与回退:
  - 纯增量:renderer 不传 sourceResolver 即旧行为(SyntheticPreview prop
    可选;App 当前总是提供,失败静默回退)。
  - 无 DB 迁移:旧库直接可用;旧 proxy 作业(无 cache_key 载荷)仍走
    sample 路径。
  - 数据回退:无新表;derived_media_cache 语义由 B10 测试守卫。
已知限制、未解决问题:
  - 代理无音频(计划如此:音频仍走原素材,波形/PCM 归 B14/B15)。
  - decode-worker 仍是整文件 arrayBuffer 加载(B12 Range demux 改造);
    代理文件显著小于原片(本例 1.98MB→0.99MB,长 4K 源差距更大),
    已降低加载成本,但 Range 读取归 B12。
  - 切档原子性(pause/seek 边界换源 + binding generation):会话级换源
    目前在重建时生效(revision/mediaUrls 变更路径);运行中切档留待
    B13 活跃输入预算一起做(计划"切档"段,B11 已提供源描述与票据通道)。
  - VFR/旋转/SAR 源的代理正确性:参数路径已按显示域归一(单测覆盖),
    真实 VFR 源端到端验证需要实机素材(后续 F 场景复测)。
  - auto 模式的负载感知(负载轻时允许原源):当前 auto = 代理 ready 即
    代理;负载判定归 B13。
开发者自测:通过(见上;含真实 FFmpeg 转码链四项断言)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:B12(MP4 Range demux,禁伪流式)——代理已就绪但
  decode-worker 仍整文件加载;B12 落地后长源播放才完整兑现 F03。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| Core 档位模型 | test_proxy_profiles.py | 24 | 尺寸/旋转/SAR/偶数/禁上采样、编码器专属参数(硬编无 veryfast)、CFR30 闭合 GOP 无 B 帧、全源无 -t、时间映射 |
| Core 服务 | test_preview_source.py | 17 | describe 三模式、缓存键(build/档位)、作业载荷、run_proxy_job 全链(fake render)、失败 mark_failed、already-ready 短路、jobs 分派 |
| Core API | test_preview_source_api.py(集成) | 11 | 三端点会话/错误码、auto 回退、generate 幂等、admin 票据 + refs 引用、越权 404 |
| 契约 | performance.ts 校验器(经 IPC 测试) | — | profile/mode/source_id 白名单、路径字段拒收、可选键语义 |
| Main IPC | performance-ipc.test.ts | 13 | 6 channel 白名单、UI/admin 分流、请求体白名单、响应剥路径、票据换发无盘符 |
| preload | preload.test.ts | +3 | 新方法仅经固定 channel |
| Renderer | source-resolver.test.ts | 5 | 代理换票、pending/unavailable/失败回退、single-flight、invalidate |

- Core 全量:`pytest services/core/tests -m "not real_provider" -q` → 677 通过(1 deselected)。
- Desktop 全量:`pnpm test` → 58 文件 / 485 项;`pnpm lint`(=tsc)通过。
- 真实 FFmpeg 链(开发机,ffmpeg n8.0.1):1080p60/4s 源 → 代理
  1280×720、fps 30/1、时长 4_000_000us、帧型 I=8/P=112/B=0、moov 前置、
  硬编 smoke 失败如实回退 libopenh264(fallback_reason 记录)。

## 4. 与实施计划的偏差

- 计划接口 `POST /api/v1/projects/{p}/assets/{a}/preview-source` 响应字段:
  按计划实现(source_id/status/job_id/asset_fingerprint/profile_id/
  duration_us/source_origin_us/fps_num/fps_den/coded_width/coded_height),
  另补充 display_width/height、rotation、codec、size_bytes(渲染侧布局
  与诊断需要;不含路径字段,与计划约束一致)。
- 计划 mode="auto" 的"原源可用且负载轻时允许原源":当前实现 = 代理
  ready 即代理、否则原源回退(负载感知归 B13,已在已知限制登记)。
- 计划"切档:pause/seek 边界原子切换 + binding generation":本单提供
  换源通道(票据/描述),运行中切档与 B13 活跃输入池一起实施(登记)。
- 计划目录约定未新增文件布局(复用 B10 derived-root 布局,无偏差)。
- mark_failed 语义增强(原子认领)超出 B10 原语义——修复的是 B11 集成
  测试暴露的真实竞态(迟到失败删 ready 产物),B10 既有测试全部保持通过。

## 5. 复现命令

```powershell
.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_proxy_profiles.py services/core/tests/unit/test_preview_source.py -q
.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_preview_source_api.py -q
.venv\Scripts\python.exe -m pytest services/core/tests -m "not real_provider" -q   # 677 项
pnpm --filter @aivideo/desktop test     # 58 文件 485 项
pnpm --filter @aivideo/desktop lint
```

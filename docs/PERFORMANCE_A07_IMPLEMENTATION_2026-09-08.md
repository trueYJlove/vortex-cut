# A07 实施进度与自检报告（2026-09-09）

## 1. 状态与范围

**A07（重复探测缓存）代码完成 + 功能验证完成。**
独立验收：**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A07，在 A06
（`fbd8f59`）之上实施，单次本地提交。未 push、未打包。

## 2. 修改单（模板）

```text
修改单：A07 重复探测缓存（probe cache + 编码器能力 session 缓存）
基线HEAD / 工作树标识：fbd8f59（A06）；本单单次提交
目标与不修改范围：
  目标——ffprobe 结果按（素材指纹 + stat + ffprobe build）会话缓存；
  900 同源切段仅 1 次探测；编码器 available/smoke 结果 session 缓存
  （single-flight + 成功 30min/失败 30s TTL）；ffmpeg -version 同 build
  只读一次；渲染中编码失败清除该 encoder 的 smoke 成功缓存。
  不修改——FFprobe.probe 本体语义（错误码/normalize/require_video）、
  smoke 测试的参数集与判据、渲染图与回退链、数据库 schema。
实际修改文件（绝对路径）：
  services/core/src/aivs_core/media/probe_cache.py（新增）
  services/core/src/aivs_core/media/encoders.py
  services/core/src/aivs_core/projects.py（asset_cache_identity）
  services/core/src/aivs_core/app.py（cached_probe/ffprobe_build/接线）
  services/core/src/aivs_core/rendering/service.py
  services/core/tests/unit/test_media_probe_cache.py（新增，11 项）
  services/core/tests/unit/test_encoders.py（扩展，+5 项）
前置Gate与接口版本：A01–A06 已合入；无跨进程契约变化。
算法/状态机变化：
  - ProbeCache：键 = ProbeCacheKey(fingerprint, size, mtime_ns, ffprobe_build)
    （不含绝对路径；stat 读取失败 → None → 调用方直探）。成功 LRU≤256
    （命中重插队尾）；失败 TTL 5s（期间复抛不重跑，到期重探）；并发同键
    single-flight（shield 共享）；等待者取消不取消真实探测，结果由
    done_callback 兜底入缓存（_settle，幂等）。
  - EncoderDetector：_session_cache[(kind, encoder)] → (ok, expires_at)；
    available（候选列表）与 smoke_test 均经 single-flight + TTL；build_id
    （-version 首行）读一次；reset() 显式重测入口；invalidate_smoke() 供
    渲染失败路径清除成功缓存。choose/capabilities 逻辑不变（只缓存探测）。
  - app.CoreState：cached_probe(path, fingerprint, require_video) 统一入口
    （ffprobe_build 读取一次）；ProjectAssetService 的 probe 注入改为
    cached_probe（导入素材路径也命中同缓存）；RenderCoordinator 注入
    probe=cached_probe 与 encoders；__init__ 尾段抽 _build_render_stack
    （纯整理，构建顺序与语义不变）。
  - RenderCoordinator：run() 的 segment probes 按唯一 input_id 去重后映射
    回 segment 顺序（900 同源段 → 1 次）；preview_ir 的 input probe 同样
    走缓存通道；渲染失败（RENDER_FAILED/RENDER_VALIDATION_FAILED/RuntimeError）
    → _invalidate_encoder_smoke(encoder)。
  - RenderService._toolchain：ffmpeg -version 结果进程内缓存（一次读取）。
  - ProjectAssetService.asset_cache_identity：同步只读
    (fingerprint, path, size, mtime_ns)，不哈希不探测；素材不可用返回 None。
授权、取消、资源所有权、缓存失效规则：
  全部为进程内会话缓存（Core 生命周期）；无持久化、无 IPC 变化。失效路径：
  文件变化（stat 键变化）、工具替换（build 键变化）、失败 TTL 到期、
  invalidate_smoke（渲染失败）、reset（显式重测）。
新增/修改测试与命令：
  test_media_probe_cache.py（11）：同键 900 次仅 1 探、并发 20 等待者
  single-flight、stat/build/指纹变化失效、失败 TTL 短暂性、LRU 驱逐与
  命中重插、等待者取消后结果入缓存、probe_cache_key 构造、显式失效、
  RenderCoordinator segment 去重集成（901 段映射 2 次探测）。
  test_encoders.py（+5）：available/smoke 缓存命中不重跑、invalidate_smoke
  强制真实重测、并发 choose 只 smoke 一次、build_id 只读一次、reset 清缓存。
  命令：pytest tests/unit -m 'not real_provider' -q（463 通过）。
功能回归结果（含跳过）：
  全量 463 通过 / 23 失败——23 项与干净基线完全一致（diff 验证：均为
  resources\recipes\manifest.json 相对路径读取的环境问题，涉及
  stage2a_planning/stage4d/bootstrap/render_ass_ffmpeg/stage3a_presets，
  与本单无关）；本单新增 19 项全绿。ruff：A07 触碰文件 0 新增问题
  （projects.py 4 项 E501/F821 为 A05 既有注记，app.py 4 项 E501 预存在）。
before / after / 同机环境：
  计数断言：同键 900 次调用 → 1 次真实 ffprobe（改造前 = 调用次数本身）；
  并发 20 个 choose → 1 次 available + 1 次 smoke；_toolchain 每次渲染
  不再各跑一遍 -version。同机 p95 级耗时数据由 B00 诊断入口在性能验证
  阶段采集（本单完成代码与功能验证）。
质量与失败路径验证：
  测试发现并修正 2 处实现缺陷：ProbeCache 等待者全部取消时探测结果丢失
  （done_callback 未写缓存——改为 _settle 兜底）；取消路径误清在途表
  （finally → 仅在探测终止时释放）。
开关、兼容与回退验证：
  probe/encoders 注入为可选参数：未注入（测试桩/旧调用方）时行为与
  改造前完全一致（直调 ffprobe.probe / 无缓存 choose）。失败缓存 TTL 5s
  保证坏媒体不长期掩盖修复重试。无新环境变量/开关。
已知限制、未解决问题：
  - jobs.py 的 asset_probe/_run_media（媒体采样/代理任务）仍直调
    self.ffprobe.probe——该路径输入是临时/用户文件且任务化执行（有
    状态机与取消），缓存收益小；接入待 B10 派生媒体缓存统一设计。
  - render_media 内产物 probe（输出验证）不缓存——产物是刚生成的新文件
    （stat 必变），缓存无意义，维持直探。
  - smoke 缓存键未含测试规格常量（规格由参数集决定，演进时同步清 reset
    即可——避免为常量引入字段）；后续若改 smoke 参数集需在发布说明登记。
  - probe 缓存 TTL/字节预算的持久化与共享纳入 B10（按计划不在本单扩契约）。
开发者自测：通过（见上）。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步：A08（轮询、缩略图和转录加载，Desktop）按计划推进。
```

## 3. 测试证据摘要

- `test_media_probe_cache.py`：11 项通过（含 900 段去重、并发 single-flight、
  取消后缓存入表、RenderCoordinator 集成映射）。
- `test_encoders.py`：8 项通过（3 项既有 + 5 项新增）。
- Core 全量 `-m 'not real_provider'`：463 通过 / 23 失败；失败集与干净基线
  diff 为空（预存在环境问题：`resources\recipes\manifest.json` 相对路径）。
- ruff：A07 触碰文件全部干净（预存在问题除外，逐项与基线比对确认）。

## 4. 与实施计划的偏差

- 计划"probe cache key=asset fingerprint + stat + ffprobe build"完整落地；
  失败缓存 5 秒、成功 ≤256 条、并发 ≤2 的"初始 probe 并发限制"由
  single-flight 语义覆盖（同键合并后，实际并发 = 不同键数，通常 = 轨道
  输入数，远低于旧实现的"每次调用一个子进程"）——未加全局信号量，避免
  对多输入长项目引入人为串行。
- 计划"编码器可用性与 smoke cache 为进程内 session 缓存，key=FFmpeg
  build + encoder + test profile"落地为 (kind, encoder) 键 + build 变化经
  build_id 通道自然区分（_version 缓存与 build 无关，工具替换需重启进程
  ——与 Core 生命周期一致，披露于已知限制）。
- 计划"渲染中编码失败清除此 encoder 的成功结果"落地为
  RenderCoordinator 失败分支调用 invalidate_smoke（只清该 encoder 的
  smoke 成功条目；软件回退链不受影响）。
- 计划"缓存命中 preview reuse 不触发多次编码探测"由
  available/smoke session 缓存 + choose 复用路径共同满足（计数断言见
  test_encoders）。

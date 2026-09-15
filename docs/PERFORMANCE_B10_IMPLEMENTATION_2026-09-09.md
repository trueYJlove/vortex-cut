# B10 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B10(派生媒体存储与缓存键)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B10 与
第 6.1 节跨进程契约规则,在 G1 复测(`3202b96`)之上实施,按"迁移 →
存储层 → 契约+Core API → Main/preload 接入"四个可审查提交推进。

四个提交(单一目标,均本地,未 push):
- `1d92ced` B10-A v18 迁移(derived_media_cache 表 + 引用映射)
- `1965e6e` B10-B 存储层(media/derived_cache.py)
- `c197c06` B10-C 契约 + Core API(performance.ts + lookup/stats/resolve)
- (本次)B10-D Main IPC + preload 白名单 + 四层测试

## 2. 修改单(模板)

```text
修改单:B10 派生媒体存储与缓存键
基线HEAD / 工作树标识:3202b96(G1 复测);四个本地提交
目标与不修改范围:
  目标——派生媒体(video_proxy/waveform/audio_pcm_chunk/reverse_chunk)
  的持久化缓存表、内容寻址键、目录布局、原子发布、引用授权、LRU 磁盘
  预算清理,以及跨进程四层契约(contracts → Core → main IPC → preload)。
  不修改——代理/波形的实际 FFmpeg 生成作业(B11/B14 接入)、预览会话
  行为、Renderer 现有数据加载路径、迁移既有 v1–v17 内容。
实际修改文件(绝对路径):
  services/core/src/aivs_core/database_v18.py(新增)
  services/core/src/aivs_core/database.py(注册 v18)
  services/core/src/aivs_core/media/derived_cache.py(新增)
  services/core/src/aivs_core/media/derived_service.py(新增)
  services/core/src/aivs_core/app.py(CoreState 接线 + 3 端点 + 启动恢复
    + ffprobe_build OSError 防护)
  packages/contracts/src/performance.ts(新增)+ index.ts(re-export)
  apps/desktop/electron/main/performance-ipc.ts(新增)
  apps/desktop/electron/main/core-admin-client.ts(resolveDerivedMedia)
  apps/desktop/electron/main/index.ts(注册 registerPerformanceIpc)
  apps/desktop/electron/preload/index.ts(白名单三方法)
  测试:services/core/tests/unit/test_migrations_v18.py(5)、
    test_derived_cache.py(9)、integration/test_derived_media_api.py(4)、
    apps/desktop/tests/performance-ipc.test.ts(7)、preload.test.ts 扩展;
    既有迁移测试版本集合断言 1..18 → 1..19(5 文件)。
前置Gate与接口版本:G1 功能复测通过;v18 迁移从实际最大 v17 取下一号。
算法/状态机变化:
  - derived_media_cache 表:cache_key 主键(SHA256 canonicalJSON,不含
    绝对路径/票据/asset_id——内容寻址物理去重);kind CHECK 枚举;
    building/ready/failed 状态;LRU 索引。
  - derived_media_cache_refs(cache_key,project_id,asset_id)引用行级联
    删除;INSERT 触发器强制"asset 属于 active project"——知道 cache_key
    不能凭空获得授权。
  - DerivedMediaCache:begin_build 同 key 在途拒绝(single-flight,
    DERIVED_BUILD_INFLIGHT);commit_ready 临时文件同目录原子 rename 后
    才写 SQL ready + relative_path;mark_failed 清工作目录;启动
    recover_orphaned_builds 只回收无在途认领的 building(半产物不作
    命中);pin=运行时 lease(TTL 10min,崩溃不残留永久 pin);
    enforce_disk_budget LRU 只清未 pin 未引用条目;所有删除路径经
    _validated_entry_root 逐级 reparse 校验 + resolved_path resolve 防
    越界——绝不触碰 cache 根外文件。
  - DerivedMediaService:kind/params/归属校验(域错误);lookup 命中即
    add_reference;resolve_internal 仅 Main 用(返回绝对路径)。
授权、取消、资源所有权、缓存失效规则:
  - Renderer 无路径:lookup/stats 响应 rendererSafe 剥离 path/uri;
    media 经 admin resolve → restricted-media purpose="proxy" 票据,
    Renderer 只拿 aivideo:// URL(Main IPC 测试断言响应不含盘符)。
  - UI token 调 internal resolve → 401(Core 集成测试覆盖)。
  - 缓存失效:cache_key 含 algorithm_version/toolchain,原素材指纹变化
    即键变化(旧条目按 LRU 回收,不主动删)。
新增/修改测试与命令:
  Core:.venv pytest(test_migrations_v18 / test_derived_cache /
    test_derived_media_api + 全量 -m 'not real_provider')
  Desktop:pnpm typecheck / lint / test(57 文件 474 项)
功能回归结果(含跳过):
  Core 全量 625 项通过(单测 503 + 集成 122;1 deselected = real_provider);
  Desktop 57 文件 474 项(+7 新增);typecheck/lint/contracts:generate 通过。
  既有迁移测试 9 处版本集合断言随 v18 上线更新(机械性 1..18→1..19,
  另 2 处"最新版本=v17"断言改 v18)。

### 全量集成套件附带修复(预存破损,非 B10 行为变化)

Core 集成套件(`services/core/tests/integration`)在 A01–A08 期间只跑过
unit 子集,本轮首次全量执行暴露三处历史遗留,均已在预存提交上复现
(worktree 验证 b15015b / 1e7d90a 同样失败)后修复:

1. **v18 版本断言**(8 文件 13 处):既有迁移测试硬编码"最新版本=v17 /
   集合 1..18";v18 追加后机械更新(v12/v14/v15/v16/v2/v3/v13 排除集、
   stage1a/stage3b 版本列表、stage4d 原型 frozen 计数)。
2. **GBK tasklist 解码**(test_stage1c_render_real 取消路径):中文 Windows
   下 `tasklist` 输出 GBK,`text=True` 按 UTF-8 解码线程抛错使 stdout 为
   None → `TypeError`;改字节级比较。
3. **跨 profile 指纹等式**(同文件 fingerprint 断言):`c9875e2`(09-02,
   比例功能)起输出规格参与 content_fingerprint(防跨比例误复用,
   plan.py 注释明示);08-12 写下的"preview(540) 与 export(1080) 指纹
   相等"断言自该提交起必然失败。按现语义改为断言两者均为合法 sha256
   且不同;内容等价性由既有 duration 容差 + SSIM≥0.95 校验承担。
before / after / 同机环境:
  B10 为能力建设(缓存基座),无性能数字目标;F02/F01 对照见 G1 报告。
  v18 前后打开旧项目:迁移追加式,v17 校验和不变(test_migrations_v18
  断言)。
质量与失败路径验证:
  - 并发同 key:in-flight 第二次 begin_build 抛 DERIVED_BUILD_INFLIGHT
    (存储层测试);跨进程 same-key 由 SQL building 行 + 进程内 _inflight
    双层防重(进程崩溃后 building 残留由启动恢复清除)。
  - 断电半产物:recover_orphaned_builds 删目录+行;lookup 对 building
    不作命中。
  - 原片变更:fingerprint 进缓存键,新键不命中旧条目(键稳定性测试)。
  - 越权:refs 触发器 + Core ASSET_NOT_FOUND + main 层 asId/asParams
    白名单(四层各自强制)。
  - 磁盘满:enforce_disk_budget 检查 shutil.disk_usage 可用空间,
    清理不足时如实返回(调用方提示,不静默)。
开关、兼容与回退:
  - 纯增量:无既有行为改变;Renderer 未调用新方法即旧行为。
  - 数据回退:旧版本遇 v18 表忽略即可(计划 10.3);不删任何既有表。
  - v18 失败回滚:迁移事务内(test_migrations_v18 断言行/表不残留)。
已知限制、未解决问题:
  - FFmpeg 生成作业未接入(计划归 B11 代理/B14 波形):当前仅存储/查询/
    票据化能力,lookup 对未生成条目返回 DERIVED_NOT_FOUND(404)。
  - derived_service._dto 的 created_at/last_accessed_at 以查询时刻替代
    (存储层 DerivedEntry 未携带列值;B11 接入时改为透传真实列)。
  - 工具链指纹当前为 aivs-core 版本串;B11 接入 FFmpeg 生成时应混入
    ffmpeg build(A07 ffprobe_build 模式),届时缓存键随之换代。
  - Renderer 侧消费方(UI 波形/代理播放)未接入——B14/B11 落地。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:B11 全源代理与预览源选择(B10 是其前置;代理生成
  作业将直接使用 begin_build/commit_ready/mark_failed + refs 授权)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 契约 | packages/contracts performance.ts 校验器(经 IPC/preload 测试间接) | — | kind/params 白名单、路径字段拒绝 |
| Core 迁移 | test_migrations_v18.py | 5 | 追加式、对象、CHECK 拒绝、越权引用、回滚 |
| Core 存储 | test_derived_cache.py | 9 | 键稳定、roundtrip、single-flight、失败清理、启动恢复、pin/引用保护、外部文件不可触碰、越界拒绝、触发器 |
| Core API | test_derived_media_api.py(集成) | 4 | 会话/错误码、跨项目越权、admin-only resolve + 无路径泄漏、stats 白名单 |
| Main IPC | performance-ipc.test.ts | 7 | 三 channel 白名单、UI 通道请求体、票据换发(无路径)、失败投影、输入拒绝、响应剥离 |
| preload | preload.test.ts 扩展 | +3 断言 | 新方法仅经固定 channel |

- Core 全量:`pytest services/core/tests -m "not real_provider" -q` → 625 通过(单测 503 + 集成 122;1 deselected)——含本轮附带修复的三处预存破损(见上)。
- Desktop 全量:`pnpm test` → 57 文件 / 474 项;`pnpm typecheck`、`pnpm lint`、`pnpm contracts:generate` 通过。
- 附带修复:`ffprobe_build` 对可执行文件缺失退化为空串键(不再 WinError 2),顺带修复 G1 报告登记的 `test_stage1c_timeline_api` resolve 预存环境失败。

## 4. 与实施计划的偏差

- 计划目录 `data_dir/cache/derived/<kind>/<key前2位>/<key>/`:实现为
  `data_dir/cache/derived-root/derived/<kind>/<...>`(cache 根多一层
  derived-root 命名,防与 data_dir/cache 下其他子系统混淆);语义不变。
- 计划"访问 pin 只做运行时 lease,不依赖易过期的永久 refcount":实现为
  内存 pin(TTL 10min)+ DB 引用行(授权证明,非 refcount)双层;LRU
  只在有引用且非空间压力时保留(极端空间压力仍可回收,避免引用行永久
  免死导致清理失效)。
- 计划"缓存≤256条/TTL 后续纳入 B10"(A07 注):本单未引入 TTL(条目
  按内容寻址,失效靠键变化 + LRU 预算);数值上限留给 B11 按实测定。
- v17 既有迁移测试的版本集合断言需随每个新迁移机械更新(仓库既有模式,
  本次照做:9 处 range + 2 处 latest)。

## 5. 复现命令

```powershell
.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_migrations_v18.py services/core/tests/unit/test_derived_cache.py -q
.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_derived_media_api.py -q
pnpm test   # desktop 57 文件 474 项
pnpm typecheck && pnpm lint
```

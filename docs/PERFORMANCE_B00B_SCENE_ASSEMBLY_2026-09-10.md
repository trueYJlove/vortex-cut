# B00-B 场景装配(第一阶段)实施报告(2026-09-10)

## 1. 状态与范围

**B00-B(完整 App 场景装配,第一阶段)代码完成 + 功能验证完成(四场景冒烟全绿)。**
独立验收:**待验收**。G0 仍未批准(正式重复采样/长测/独立复核未做)。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 4 节 B00 的
F01–F07 场景装配要求,在 F01 单场景基础上扩展 F02/F04/F07 三个完整场景
recipe(装配代码、夹具生成、runner 调度),并**发现与修复一个 B12 引入的
完整 App 级回归**(合成预览完全不可用,详见第 4 节)。

剩余(不在本报告范围):F03(60 分钟源)/F05(4K60)/F06(播放+导出竞争)
场景装配与长源生成(夹具生成器已支持 F03/F05 媒体生成,场景 recipe 与
`--allow-large` 实测轮待做);正式 G0 采样(5 轮×100 seek、5 分钟播放、
30–60 分钟内存)与独立评审。

## 2. 修改单(模板)

```text
修改单:B00-B 场景装配第一阶段(F01 保留 + F02/F04/F07 recipe)+ B12 回归修复
基线HEAD / 工作树标识:ffa33ad;工作树连续演化,最终以本提交为准
目标与不修改范围:
  目标 1(场景装配)——F02:900x1s 同源切段 + 900 字幕(IR 压 27000 帧上限);
  F04:48 素材、4 视觉层(V1 主轨 24x2s + V2-V4 各 24x1s 全程同时可见
  + 静态 transform PiP)+ 12 字幕;F07:速度矩阵 0.5x/1x/2x/4x(4x3s 段,
  快速在前)+ 无音轨素材段 + set_audio 静音/开启维度。装配函数为
  playwright page.evaluate 内自包含函数(可序列化、无 Node 闭包)。
  目标 2(B12 回归修复)——decode-worker 客户端把主线程 refreshTicket 闭包
  经 postMessage 传入 Worker,函数不可结构化克隆 → 每个含视频输入的合成
  预览 init 即抛 "could not be cloned" 并回退交互预览。改为消息往返桥:
  Worker 401/403 时发 ticket-refresh-request,客户端执行主线程回调后回发
  ticket-refresh-response。
  不修改——v1 预览协议/IR 形状/v1 端点;perf-metrics 事件协议;既有 E2E;
  B00-A 探针;F01 场景行为(原 full_asset 路径逐语义保留,仅复用新导入
  通道 importAssetByFixture)。
实际修改文件(绝对路径):
  apps/desktop/e2e/performance-editor.spec.ts(重构:场景 recipe 注册表
    + page.evaluate 内装配 + per-scenario results-<scene>.json + 多素材
    夹具 SHA 校验 + 重试恢复循环计数)
  apps/desktop/electron/main/index.ts(新增 asset:import-fixture 通道:
    从 AIVS_E2E_ASSET_PATHS_LIST 名称→路径映射选择;fail-closed,名称
    白名单正则,非基准环境无该 env 直接拒绝)
  apps/desktop/electron/preload/index.ts(importAssetByFixture API + 固定
    channel;DesktopApi 类型)
  apps/desktop/src/app/preview/decode-worker.ts(续票桥客户端:
    ticket-refresh-request 处理 + refreshTicket 主线程持有 + init 消息
    只传布尔标志;terminate 清空回调)
  apps/desktop/src/app/preview/decode-worker.worker.ts(续票桥 Worker 侧:
    requestTicketRefresh Promise + pending map + Outbound 新消息类型;
    init 参数 refreshTicket: () => Promise<string> → boolean)
  apps/desktop/tests/preview-lifecycle.test.tsx(新增回归锁测试:init/
    decode 消息不得含函数值;续票消息往返闭环)
  apps/desktop/tests/app.test.tsx、tests/editor-commands.test.tsx、
    tests/editor-shell.test.tsx(DesktopApi mock 补 importAssetByFixture)
  tools/performance/make_fixtures.py(schema_version 2:F04 48 文件族、
    F07 av+video-only 双文件;audio=none 用 -an 保证无音轨;磁盘预算
    按场景估算;单文件场景 recipe/manifest 结构与 v1 兼容)
  tools/performance/run_editor_benchmark.mjs(--scenarios 多场景 + KNOWN_
    SCENES 白名单拒绝未实现场景;manifest v2 门;fixture 名单进 run-
    config;--seed 透传;playwright -g 场景过滤)
  docs/PERFORMANCE_B00B_SCENE_ASSEMBLY_2026-09-10.md(本报告)
  docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md(头部状态登记)
前置Gate与接口版本:B00-A 全链;B10-B17/B20 契约四层模式;C20-C22。
算法/状态机变化:
  - 装配协议:SceneRecipe{scenario,label,media,distinct,inPage,scope} →
    inPage 以 page.evaluate(recipe.inPage, fixtureFiles) 在页面内执行,
    返回场景 extra 计数进 result.json(scene_extra)。
  - 夹具清单:schema_version 2;F04/F07 为 files 数组(含 audio:none 标记),
    其余单文件结构不变(向后兼容 F01 旧 manifest,v2 门仅限多场景)。
  - 续票状态机:Worker pending map(id→resolve/reject);客户端 onMessage
    拦截 ticket-refresh-request(在 disposed 检查之后、frame 处理之前);
    回调失败以 refreshError 文本回传,Worker 侧 reject → RangeSource
    沿既有 RANGE_REFRESH_FAILED 路径。有限一次语义不变(refreshed 标志)。
授权、取消、资源所有权、缓存失效规则:
  - asset:import-fixture:仅当 AIVS_E2E_ASSET_PATHS_LIST 存在时生效;
    fixture_file 必须匹配 ^[A-Za-z0-9._-]+\.mp4$(拒绝路径/通配符);
    其余流程与 asset:import 相同(grant→Core 创建→restrictedMedia 注册)。
  - 续票桥不改变票据 TTL/归属/有限一次语义;terminate 时客户端清空
    refreshTicket,pending 随 dispose 拒绝。
新增/修改测试与命令:
  Desktop:vitest run tests/preview-lifecycle.test.tsx(+1 回归锁);
    全量 vitest run(69 文件 608 项)。
  Core:pytest services/core/tests/unit -m 'not real_provider'(631)。
  完整 App 冒烟(四场景,见第 3 节证据)。
功能回归结果(含跳过):Core unit 631 通过;Desktop 69 文件 608 项通过
  (+1 = B12 回归锁;2 unhandled rejection 为 B13 已知噪音);lint/typecheck
  通过。F01/F02/F04/F07 完整 App 冒烟全绿。
before / after / 同机环境:见第 3 节(冒烟证据,非 G0 采样)。
质量与失败路径验证:
  - B12 回归先证后修:修复前 F01 冒烟失败留证
    (evidence/performance/b00b-smoke-f01-regression-check/),错误为
    "postMessage ... could not be cloned";修复后同场景通过。
  - 回归锁单测:遍历 client→worker 全部消息断言无函数值;续票 request/
    response 往返闭环(refreshCount=1、回发新 URL)。
  - 装配失败路径:F04 100 素材版暴露 list_assets 默认 limit=50 分页缺口
    (reload 后第 51+ 素材丢票)——按口径降为 48 素材并登记(第 5 节);
    F07 装配期间发现 4x4s 源区间越界、视频素材不可入 A1 等约束,均以
    夹具/recipe 侧收敛并登记。
开关、兼容与回退:
  - importAssetByFixture 是纯增量 IPC(非基准环境 fail-closed);续票桥
    为行为修复无开关;回退 = revert 对应 hunk(续票桥回退即回到"合成
    预览不可用"的回归状态,不建议单独回退该 hunk)。
已知限制、未解决问题:
  1. F03/F05/F06 场景 recipe 未实现(长源/4K 生成支持已在,装配待做)。
  2. F04 受 Core list_assets 默认 limit=50 限制,现为 48 素材口径;
     编辑器 reload 只装载第一页素材,超出页素材丢 media ticket →
     合成预览回退。产品分页修复后应升回 100 素材口径(计划原文)。
  3. F07 "双片段同源重叠混音"未装配:视频素材不能放 A1(音频轨只收
     纯音频素材),跨轨重叠片段(V1+V2 同时活跃)播放头停滞不推进——
     两项均为产品行为约束,harness 不伪装覆盖;测量口径 = 速度矩阵 +
     无音轨素材 + set_audio 静音/开启。
  4. 正式 G0(5 轮重复采样、100 seek、5/30-60 分钟播放、探针开销<3%
     校验、独立评审)未做;本报告全部证据为 smoke(1 轮 3 seek 5s)。
  5. compare_results.py 仍按单场景 results.json 对拍;多场景 results-<Fxx>
     .json 的对比扩展待 G0 前补齐。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:补 F03/F05/F06 装配 → 正式 G0 采样轮 → 探针开销
  A/B → 独立评审;实测瓶颈数据到位后按计划 10.2 决定 C20 Renderer v2
  数据面与 C20c 优先级。
```

## 3. 冒烟证据(同机,均 smoke 口径:1 warmup + 1 off/on 对,3 seek,5s 播放)

| 场景 | 证据目录 | 结果 | 要点 |
|---|---|---|---|
| F01 回归验证(修复前) | `b00b-smoke-f01-regression-check` | 失败留证 | postMessage 克隆错误,合成预览不可用 |
| F01(修复后) | `b00b-smoke-f01-01` | 通过 | 行为与 B00-A 时期一致 |
| F02 | `b00b-smoke-f02-01` | 通过 | 900 段+900 字幕,合成预览可播,seek/播放计数>0 |
| F04 | `b00b-smoke-f04-07` | 通过 | 48 素材/4 层/12 字幕,setup_recovery=0 |
| F07 | `b00b-smoke-f07-11` | 通过 | 速度矩阵+video-only+静音切换 |

每个目录含 `run-config.json`(commit/代码指纹/脏文件/夹具 SHA)、
`results-<Fxx>.json`(off/on 对、seek/播放指标、进程采样、GPU/环境)、
`warmup-on|run-0-*/result.json`。诊断 off 轮 events 为空、on 轮
seek/submitted 计数>0 断言内置于 spec。

## 4. B12 回归:发现、根因与修复

- **发现**:B00-B 首次以完整 App 冒烟 F07 时合成预览回退,错误
  "Failed to execute 'postMessage' on 'Worker': async () => {...} could
  not be cloned";随后 F01 复跑同样失败——**B12 以来所有完整 App 合成
  预览均不可用**。B12 的单测/对拍未覆盖该路径(mock 了 postMessage),
  且 B12 交付后未重跑完整 App 冒烟(B00 工具当时只支持 F01 且被搁置)。
- **根因**:`decode-worker.ts` 将主线程 `refreshTicket` 闭包放入 init
  postMessage;结构化克隆不支持函数。
- **修复**:消息往返桥(见修改单)。语义不变:有限一次续票、相同
  range 重发、失败上抛 `RANGE_REFRESH_FAILED`。
- **防再发**:回归锁单测(消息无函数值 + 往返闭环);B00-B 四场景
  冒烟纳入后续每轮验证。

## 5. 装配约束登记(harness 侧收敛,产品侧遗留)

1. **list_assets 分页**:默认 limit=50 且编辑器 reload 只装载第一页;
   超页素材无 media ticket,合成预览回退("no ticket for asset_...")。
   刷新素材库+重试不能恢复(refreshAsset 只补登记,不解决分页装载)。
   F04 以 48 素材交付;升回 100 需产品修复(loadProjectData 翻页装载)。
2. **视频素材不可入 A1**:`insert_asset_clip` 按 asset kind 分支,A1 只收
   纯音频素材;mp4(av)素材显式 `track_id: "A1"` 报"目标轨道不是视频轨道"。
3. **跨轨重叠播放停滞**:V1+V2 同源重叠片段装配成功(契约允许)后,
   预览播放头 ~1 帧后停滞(疑似 overlay 音频/时钟路径问题),未达可测
   状态;B13/B15 的"同源双位置"验收口径在完整 App 层面仍未验证。

## 6. 复现命令

```powershell
# 夹具(可复现,含 SHA)
.\.venv\Scripts\python.exe tools/performance/make_fixtures.py --scenarios F02 --output evidence/performance/f02-fixtures --seed 20260908 --allow-large
.\.venv\Scripts\python.exe tools/performance/make_fixtures.py --scenarios F04 --output evidence/performance/f04-fixtures --seed 20260908
.\.venv\Scripts\python.exe tools/performance/make_fixtures.py --scenarios F07 --output evidence/performance/f07-fixtures --seed 20260908
# 诊断构建
$env:VITE_AIVS_PERF='1'; pnpm --filter @aivideo/desktop build; Remove-Item Env:VITE_AIVS_PERF
# 冒烟(多场景)
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F04,F07 --fixtures evidence/performance/f07-fixtures --output evidence/performance/<new-dir> --runs 1 --seeks 3 --playback-seconds 5 --smoke
```

## 7. 与实施计划的偏差

- 计划 B00 的 F04 口径为"100 个短素材";因第 5 节分页缺口现以 48 素材
  交付,升回 100 依赖产品修复(已登记)。
- 计划 F07 口径含"双片段重叠音频、无音轨、静音→开启、seek 后切项目";
  现交付无音轨/静音切换/速度矩阵,双位置混音与"seek 后切项目"未装配
  (后者属工作量裁剪,装配接口已就绪可后续补)。
- 新增 `asset:import-fixture` IPC 与 `AIVS_E2E_ASSET_PATHS_LIST` 环境变量
  为计划未列举的必要装配通道(多素材导入需按名选择,原单 kind 映射
  不支持 48 文件族)。

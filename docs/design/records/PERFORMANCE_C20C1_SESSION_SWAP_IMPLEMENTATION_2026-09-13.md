# C20c-1(revision 换 manifest 沿用会话)实施报告(2026-09-13)

依据:`PERFORMANCE_C20C_PLANNING_GATE_2026-09-13.md` §2 C20c-1(2026-09-13
批准)。前置:C20 v2 默认 on 已裁决落地(同日);B13+C20 二阶段独立验收
通过(同日,条件已落实)。

## 1. 结论速览

**v2 数据面补齐了 v1 既有、v2 缺失的"同输入 revision 变更 → 会话保活"
语义**:编辑/撤销/重做/AI 应用提交导致的 revision 切换不再整会话重建
(worker/GL/池/音频全保留),新 manifest 帧源就地换装。会话侧
`replaceIr(nextIr, nextFrames?)` 的外部帧源换装机制在 C20a/C20b 时已
预留(sig 校验/音频 rig 重置/pip 索引重建/v2 游标),**本轮交付的是装配
侧接线 + 帧源所有权闭环**——此前 v2 装配 effect 注释明确写着"就地换表
路径在 v2 下不适用",每次 revision 切换付出全量重建(默认 on 后为每次
编辑的常发路径:F02 类 ~2.2s 装配段 + worker/GL 重建)。

## 2. 交付内容(全在 `SyntheticPreview.tsx` + 测试基建)

### 2.1 v2 就地换装路径

装配 effect 在 manifest 取回、`ir` 投影、新帧源构建后,**先尝试换装**:

- `existingSession.replaceIr(ir, frameSource)` 返 true(输入绑定未变,
  sig = inputs 的 id/asset/kind/geometry)→ 会话沿用,帧表/段表原子换
  新 manifest 帧源;旧帧源由组件释放(缓存清空 + 在途 abort)。
- **暂停态显式重锚**:换装后新源无就绪窗(recompose 无帧可绘,画布保留
  末帧不黑屏),`refineAfterDrag()`(既有公开原语,内部
  `seekToFrame(currentFrame)`)取当前帧窗口并重呈现;**播放态零动作**:
  pump 逐 tick 按引用读 `this.frames`,换装对 pump 透明,下一 tick 的
  BACKSCAN ensureRange 自愈(显式 buffering 语义不变)。
- 装配头部预取的窗 0(与 manifest 并行,T2 既有模式)经帧源
  `fetchWindow` 闭包复用,换装路径同样命中;`ensureRange(0, 600)` 在换装
  判定前已发起,与重锚取窗经 in-flight 去重合流。
- 返 false(输入集合增删)→ 走既有整会话重建,旧会话 + 旧帧源释放。
- 字体在换装路径**不重载**(会话已持有;装配头部并行的字体预取在换装
  路径成为无害冗余,catch 挂钩无孤儿拒绝)。

### 2.2 外部帧源所有权闭环(顺带闭合两处既有缺口)

`session.dispose()` 不释放外部帧源(v2 起帧源归调用方——stale 分支在
T2 已补)。本轮引入 `frameSourceRef` 统一持有,**闭合两处登记在案的
泄漏面**:项目切换清理块(`existing?.dispose()` 不带帧源)与卸载 effect
(同)——现均随会话一并释放;换装成功时旧源 dispose、ref 换指。

### 2.3 测试基建抽取

`preview-lifecycle.test.tsx` 的 ScriptedWorker/installWorkers/
stubOffscreenCanvas/activeWorkers 抽至 `tests/fixtures/preview-worker-stubs.ts`
共享(语义不变),新用例文件复用。

## 3. 验证

| 项 | 判定 |
|---|---|
| typecheck / lint | 通过 |
| Desktop 单测 | **70 文件 629 项全过**(625+4 新增) |
| v1 数据面 | 零改动(v1 路径 `replaceIr(ir)` 调用与语义不变;原有 625 项不动即过) |
| 新增单测 | `preview-revision-swap.test.tsx` 4 项:①同输入切换 worker 不销毁不重建(恰为最初 2 实例)+ manifest 按新 revision 重取;②输入集合变化 → 整会话重建(旧 2 全 terminate,新会话按输入数建 worker);③连续 100 次混合切换(含 33 次输入变化)worker 收敛有界、零 fallback;④换装后卸载 active 回基线 0 |
| 行为正确性(e2e) | **待 A/B 轮**——与 C20c-2 合并一轮(避免两轮机器时,T1 先例);本轮改动只影响 revision 切换路径,稳态播放/seek/装配代码不变,off 轮不受影响 |

测试口径注:ScriptedWorker 只应答 init,decode/upload 悬挂——窗口载荷用
最小 black 帧(`main.kind="black"` → mainNeeds 为空 → seekToFrame 不产生
上传请求、立即完成),使装配真正走到 ready/换装路径;完整帧会让装配悬挂
在 seek、rerender 清理即拆会话,换装路径反而不可达(首轮测试踩坑如实
登记)。

## 4. 边界与已知限制

1. **manifest 投影成本不在本轮范围**:revision 切换仍需 Core 重新投影
   (随源缩放,900s→1.8s / 3600s→4.1s)——本轮消除的是 Renderer 重建链
   (worker/GL/池重建 + 字体串行 + 全窗口作废);投影缓存/增量属 C20c
   Gate §2 明确排除项,待实测另立。
2. 画幅/全局样式变化:与 v1 同语义(replaceIr sig 不含画布,跟随
   manifest.canvas 换装);是否够用由 e2e 复验,不做额外保守重建。
3. 音频:replaceIr 既有语义(删除 clip 清 rig、源窗口变化重置位置、
   未变保留)对 v2 换装同样生效;`SegmentAudioConfig` 变化走
   `setAudioByClip` 独立通道,不触发装配。
4. PiP override 生命周期(replaceIr 重建索引后 override 引用刷新)与
   手势路径的交互按既有 A04 语义,未改动。

## 5. 验收对照(C20c Gate §3)

| 项 | 判定 |
|---|---|
| 会话沿用正确性(同型单测 + 100 次混合切换无旧帧/无泄漏) | **达标**(单测层;e2e 待 A/B) |
| 帧数据等价(golden 对拍) | 不适用——本轮无复用,C20c-2 范围 |
| 行为正确性(F01/F02/F03 off/on) | 待 A/B(与 C20c-2 合并;改动面不触稳态路径) |
| 回归 | 达标(629 单测 + typecheck;v1 不动即过) |
| 性能 | 待 A/B(机制目标达成:输入未变切换 worker/GL 保留;F02 revision 切换装配段 before/after 随 A/B 产出) |

## 6. 遗留

- C20c-2 dirty-range 窗口复用(指纹判定、宁重算不猜测)——下一工作单;
- A/B 验收轮(与 C20c-2 合并):F01/F02/F03 off/on 全断言 +
  revision 切换负载的装配段计时(如 harness 需扩负载,另行小修);
- Core manifest 投影缓存/增量、F02 段外启动链残差:按 C20c Gate §2
  排除清单维持另立。

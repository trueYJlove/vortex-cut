# 产品缺陷修复规划(Planning Gate,2026-09-15)

来源:`docs/requirements/PRODUCT_DEFECTS_2026-09-11.md` 四项登记(均 OPEN)。perf 线收束后
按优先级排期:4K60 两高优先行(同源模块,一并修复),中优两项随后。本文档为
LiuWei 规划裁决,ZhangSan(W4 Core 侧)/YeJing(W1/W2/W3 Desktop 侧)实施,
LiuKeAi 独立验收。

## 0. 根因结论(2026-09-15 代码级复核)

四项缺陷经代码走读全部定位到机制级,不再是"疑似":

- **DEFECT-4K60-SEEK**:`SyntheticPreview.tsx:386` `void session.seekToFrame(...)`
  无 catch;`seekToFrame`(preview-session.ts:1316)内 `Promise.all(requests)`
  (:1364)无 try/catch——decode 15s 超时(decode-worker.ts:143-146)的 rejection
  一路无人接,成为 unhandled rejection(与台账"控制台含未处理 rejection"吻合)。
  同文件 :223 换装路径有 `.catch(() => undefined)`,证明是漏加而非模式缺失。
  另 `compositor.upload`(compositor-worker.ts:158)无超时,worker 存活但 ack
  不回时 seekToFrame 永挂——"事件不齐"的挂起形态。
- **DEFECT-4K60-SESSION-HANG**:`PreviewSession.create`(preview-session.ts:254)
  是串行 await 链;15s 握手(worker-lifecycle.ts:2)只覆盖 worker init→ready
  单跳。链上 `sourceResolver.resolve` IPC(:285)、图片 fetch/createImageBitmap
  (:342-344)、`audioWorklet.addModule`(:371)等全部无看门狗。挂起时 canvas
  已 append(:298)但容器 `display:none`(SyntheticPreview.tsx:404)——正是
  "标签已切、canvas 不挂载"的形态。
- **GAP-LIST-ASSETS-PAGING**:`loadProjectData`(App.tsx:356)只调一次
  `listAssets`,不跟 `next_cursor` 翻页;Core `app.py:1616` 默认 `limit=50`。
  第 51+ 素材不进 `assets` 状态 → 无 media ticket → 合成预览回退。
- **GAP-CROSS-TRACK-OVERLAP**:`input_id` 按素材分配(plan.py:319-322)——
  同素材 V1 主轨 + V2 浮层共享一个 input → 会话侧共享一个 DecodeWorker 与
  一个环形纹理池(深 8)。`pump` 把两消费位置的 src_n 需求合并进同一单调
  游标(preview-session.ts:878-916);两位置 src 距离 >8 时互相淘汰槽位,
  `frameReady`(:826)永假 → 合成停滞 → 播放头停在 ~1 帧。台账"疑似 overlay
  音频/时钟路径"排除:播放头推进只由 rAF compose 环驱动,与音频无关;seek
  路径一次性双位置上传可共存(2 槽),与冒烟观察"seek 正常、播放停滞"一致。

## 1. W1:seek 错误传播修复(DEFECT-4K60-SEEK,产品侧)

**范围**:失败可见化 + 挂起兜底,不含 decode 侧 4K60 慢的根因诊断(见 §5)。

1. `seekToFrame` 内 `Promise.all(requests)` 加 try/catch:失败写
   `lastError`(`seek 解码失败 …`,与 noteDecodeError 同格式)、返回 -1;
   不再向上抛。装配期 seek(:269/:323)随之不再把整个预览打成 error。
2. `compositor-worker.ts` `upload`/`uploadShadow` 加 15s 超时(与 decode
   对齐):超时删 pending 项并 reject,迟到的 ack 落空(pending 已删,
   optional-chain 无操作);worker 真死时 error 事件 terminate 兜底不变。
3. `SyntheticPreview.tsx:386/:388` 两个 `void` 调用点保持(1 已使其不抛)。

**验收**:单测——decode reject / upload reject / upload 超时三形态下
seekToFrame 落定不抛、lastError 非空、返回 -1;既有 seek 行为回归。
**预期管理**:修后 F05 的 decode 计数(160–165 vs 200+)不会自动恢复——
那是 decode 侧真实超时/失败,由 §5 诊断工作单承接;本单把"静默"变"可见"。

## 2. W2:装配看门狗(DEFECT-4K60-SESSION-HANG,产品侧)

1. `PreviewSession.create` 整链加 45s 总期限(Promise.race + timer):
   超时 → `session.dispose()`(workers 终结、abort 监听清场)+ 抛类型化错误
   `合成预览装配超时(45s)…`。45s ≈ 最差实测 ready(≈16s)的 3 倍余量,
   远小于观察到的 4min 挂起;timer 在 finally 清除。
2. 超时错误走既有 error 路径(SyntheticPreview catch → 错误条 + onFallback),
   UI 机器已在位,无需新增组件。
3. `decode-worker.worker.ts` init fire-and-forget 改为失败回发 error 消息
   (客户端 15s 泛化超时 → 真实错误信息),消除 worker 内 unhandled rejection。

**验收**:单测——注入永不落定的 create 阶段(mock sourceResolver.resolve
挂起),45s(测试注入短期限)后 reject 且 session 已 dispose;正常路径
timer 不误杀。

## 3. W3:assets 分页装载(GAP-LIST-ASSETS-PAGING,产品侧)

1. `loadProjectData`(App.tsx:356):assets 改为 cursor 循环翻页直到
   `next_cursor=null`(上限 200 页 = 10,000 素材防病态环;触顶即止,行为
   不劣于现状)。jobs 维持现状(非登记缺陷,展示用途)。
2. 转录摘要 pairs 跟随全量 assets(既有 BoundedTaskQueue 并发闸门不变)。
3. `refreshAsset` 只补登记的既有语义不动。

**验收**:单测(mock listAssets 两页)——assets 状态含两页全部条目;
51+ 素材 media ticket 可解析。harness 侧 F04 升 100 素材口径属性能复跑
协议(§6),不在本代码单内。

## 4. W4:同源跨轨重叠双输入(GAP-CROSS-TRACK-OVERLAP,投影侧)

**裁决**:input 拆分放在**预览投影层**(ir.py `project_preview_ir`),
不动 plan.py/权威渲染路径——blast radius 最小,权威端零影响。

1. 投影时检测:同 input 的**可视** segments 中,timeline 窗口与他人重叠
   者(同轨重叠被契约禁止,实际即跨轨 V1↔V2、V2↔V2),自第二份起分配
   复制输入(input_id 加后缀,如 `I0~1`),inputs 列表追加同 asset/geometry
   条目,`segment_input` 重映射。首个(主轨优先)保持原 input。
2. 非重叠同素材复用不变(F03 三窗口、F07 速度矩阵仍是单输入单 worker——
   既有经济性保持);转场借用对(时间上不重叠)不受影响,影子槽逻辑不动。
3. 桌面侧零改动:session 按 inputs 条目建 rig,同 asset_id 两条 input 各得
   同一 ticket、各自 DecodeWorker/环池——双位置消费互不淘汰。内存代价
   (同素材第二 worker,受档位 range-cache 预算约束)登记为已知成本。
4. `IR_PROJECTOR_VERSION` 递增(v2 manifest_id 失配旧缓存,自动失效)。
5. A1 不收视频素材(`_asset_clip` 按 kind 分支)是**能力缺口**非缺陷,
   维持登记不并入本单(需契约层设计,另立工作单)。

**验收**:Core 单测——同素材 V1+V2 重叠文档投影出 2 inputs/正确重映射;
非重叠同素材仍 1 input;转场对不受影响。Desktop 单测——双 rig 会话
frameReady 可满足、compose 推进(mock worker 路径)。

## 5. 明确不做(本规划边界)

- **4K60 decode 慢/超时根因**(SEEK 缺陷的深层):W1 后 F05 数据把真实
  失败显形,届时按数据另立诊断单(驱动/硬解路径疑点已有 A01 握手遥测)
  ——**已交割(2026-09-17,`docs/design/records/DIAG_4K60_DECODE_COUNT_2026-09-17.md`)**:
  逐事件归因证实计数缺口为 latest-wins/refine 二次 seek/环命中三项设计
  语义的合成,零超时零挂起,无残余故障,无需修复工作单;
- **B17 render-cache / B14 分窗取件 / B11 运行中切档**:登记延后不变;
- **Core manifest 投影缓存**:独立立项候选,不与本缺陷批混合。

## 6. 验证协议(登记约定承接)

1. 单测层:每工作单如上;Core 全量(pytest)+ Desktop 全量(vitest)复跑。
2. 性能侧复跑(B00 harness,`tools/performance/run_editor_benchmark.mjs`):
   - W1/W2 → F05 复跑:seek 事件齐全性 + 装配不再挂起(setup_recovery=0
     维持);指标不设新门(4K60 decode 根因未修,seek 计数恢复程度如实记录);
   - W3 → F04 升 100 素材口径复跑(spec F04 recipe 调整)+ 既有 48 素材回归;
   - W4 → F07 补双位置混音装配(spec assembleF07 增 V2 重叠段)并复测。
   复跑结果回填 `PRODUCT_DEFECTS_2026-09-11.md` 对应条目
   (OPEN → IN-PROGRESS → FIXED → VERIFIED 状态机)。
3. 环境受限时(夹具/媒体不可得)如实登记 FIXED + 复跑挂起,不虚报。

## 7. 实施顺序与提交

W1 → W2 → W3(小步独立可验收)→ W4(投影层,Core+Desktop 两侧)→
全量测试 → harness 复跑 → 台账回填 → 单分支提交合入(沿用 fast-forward
惯例,工作分支 `uiux-polish-round3` 或新缺陷分支——采用新分支
`defects-4k60-paging-overlap` 以保持性能分支纯净)。

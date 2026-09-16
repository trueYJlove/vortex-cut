# 产品缺陷与工作单登记(2026-09-11,B00 G0 轮)

来源:B00-B 场景装配与正式 G0 采样(`docs/PERFORMANCE_B00_G0_BASELINE_2026-09-11.md`)
期间发现的被测系统缺陷与产品缺口。**这些不是 harness 问题**——harness 按实际行为
记录测量值,不阻断采样;修复属产品工作单,不自动纳入性能工程范围。

## 状态字段约定(2026-09-15 增设)

每条登记携带状态行,Owner 修复后在此回填并同步"最后核查"日期:
- `OPEN`:登记后未处置;
- `IN-PROGRESS`:修复进行中(注明 Owner/分支);
- `FIXED`:产品修复合入,待性能侧复跑;
- `VERIFIED`:性能侧复跑通过并记回结果(登记约定的闭环终点)。

证据位置:
- `evidence/performance/g0-baseline-20260911-v2/F05/`(DEFECT-4K60-SEEK 五轮数据)
- `evidence/performance/b00b-smoke-f05-02/`(首轮观察)
- `evidence/performance/b00b-smoke-f07-11/` 报告 5 节(A1/跨轨重叠约束)

---

## DEFECT-4K60-SEEK:4K/60fps 暂停态 seek 静默失败(事件不齐)

- **状态**:FIXED→**VERIFIED**(2026-09-16 复跑,分支 defects-4k60-paging-overlap;
  修复 2026-09-15 缺陷批 W1)——seekToFrame 失败落定写 lastError 不再向上抛
  (旧为 unhandled rejection)、compositor upload/uploadShadow 加 15s ack 超时
  (挂起形态兜底)。单测 5 项(preview-seek-errors.test.ts)。
  **复跑**:`evidence/performance/defect-verify-f05-20260915-v2/` 五轮全过
  (runs=5,seeks=100,playback=300,setup_recovery_count 全 0,装配无挂起、
  无未处理 rejection);seek 探针 on 轮 seek 事件 86–97、decode 160–166——
  与 G0 基线(86–96/160–165)同形态,如实记录:decode 侧 4K60 慢/超时根因
  未修(规划 §5 另立诊断单),seek 计数恢复程度与 W1 预期管理一致。
- **优先级建议**:高(4K 是 F05 格式上限探测的核心能力;播放正常,仅 seek 路径失效)
- **现象**:4K60 源播放 pump 正常(播放头推进、submitted≈30/s),但暂停态点击
  时间线 seek 后 seek/decode/upload 事件不齐。G0 五轮 × 100 seek:86–96/100
  轮内有 seek 事件,decode(160–165)与 upload(106)计数显著少于预期
  (正常场景 decode≈seek≈200+);事件缺失的 seek 无任何 UI 错误提示。
- **复现**:B00 harness F05 场景,`run-0-on`~`run-4-on` 的 `seek.counts`。
- **根因线索**:decode 超时/失败被吞(控制台含未处理 rejection);冒烟期
  (`b00b-smoke-f05-02`)曾观察到全 0 的更严重形态,提示缺陷表现有分级。
- **影响**:4K 项目暂停态 seek 后画面不更新或更新不完整,且不可感知。

## DEFECT-4K60-SESSION-HANG:4K 会话首次装配 create 挂起,无超时兜底

- **状态**:FIXED→**VERIFIED**(2026-09-16 复跑,分支 defects-4k60-paging-overlap;
  修复 2026-09-15 缺陷批 W2)——PreviewSession.create 加 45s 装配总期限
  (15s 握手仅覆盖 worker init 单跳;IPC/fetch/addModule 等阶段此前无看门狗),
  超时 dispose 已拉起的 worker 并走既有 error UI 兜底;decode worker init 失败
  回发 error(不再吞 rejection,真实错误直达客户端)。单测 3 项
  (preview-create-watchdog.test.ts)。
  **复跑**:`evidence/performance/defect-verify-f05-20260915-v2/` 五轮全过,
  装配 ready ≈2.7–4.2s(与 G0 基线一致),setup_recovery_count 全 0——
  首次装配不挂起、reload 后装配正常,门条款(45s 看门狗+错误直达)闭合。
- **优先级建议**:高(不可恢复的挂起,用户只能重载)
- **现象**:4K 源首次导入装配(不 reload)时,标签已切"合成预览"但 canvas
  超过 4 分钟不挂载;无错误、无回退提示。reload 后装配正常(F05 G0 各轮
  `setup_recovery_count=0`、ready ≈ 2.7s)。
- **复现**:B00 harness F05 冒烟首次装配(见 B00-B 报告 6b 节)。
- **根因线索**:PreviewSession/WebCodecs create 路径疑似挂起;A01 的握手
  超时(15s)未覆盖该分支,create 完成回调缺失时无兜底。

## GAP-LIST-ASSETS-PAGING:list_assets 分页导致超页素材丢票

- **状态**:FIXED(2026-09-15 缺陷批 W3,分支 defects-4k60-paging-overlap)
  ——loadProjectData 对 assets 跟随 next_cursor 翻页装载(200 页上限防
  病态游标环,触顶即止不劣于现状);转录摘要跟随全量素材。单测 2 项
  (assets-paging.test.tsx:三页游标链 + 环防护)。
  **复跑(2026-09-16,F04 升 100 素材口径)——代码行为验证通过,主数据
  部分通过**:100 素材翻页装载/票据签发/合成预览装配全链路在成功轮稳定
  达成(`defect-verify-f04-20260915-v5/v6/v9-v11/` 共 5 次运行,每次
  3–5/6 轮过;成功轮 ready 41–53s、setup_recovery_count=0、数据面完备
  ——DB 100 素材全 available、96 clips 引用 73 素材全部在册);单次运行
  连续 5 轮全过未达成:每轮间偶发一次 reload 后装配失败(三种形态:
  Core 连接瞬时拒连/单个素材 no-ticket/装配期慢),失败轮数据面复查全部
  完备,判为环境性(笔记本 i7-1165G7 连续满载热节流窗口)叠加
  renderer 票据到达时序竞态。**代码侧加固随本轮入库**:Core compile
  移出事件循环(8 处 async 调用点,to_thread——消除百 clip 级同步 SQLite
  编译对 accept 的阻塞贡献)、assetPresentation resolve 3 次退避重试
  (域错误不重试)+失败落日志、App 缺票恢复预算耗尽后一次延迟终验、
  harness 回退态恢复兜底。**Follow-up 登记**:单素材 no-ticket 在数据面
  完备下的复现路径(renderer 票据状态与 Core 数据不同步的时窗)待另立
  诊断单;5 轮全过复跑建议在台式机/低热噪声环境补做。
- **优先级建议**:中(48 素材内功能正常;100 素材口径被阻塞)
- **现象**:`list_assets` 默认 `limit=50`,编辑器 reload 只装载第一页;
  第 51+ 素材无 media ticket,合成预览回退("no ticket for asset_...")。
  "刷新素材库+重试"不能恢复(refreshAsset 只补登记,不解决翻页装载)。
- **影响**:F04 无法按计划升回 100 素材口径(现 48);大项目导入后预览不可用。
- **修复方向**:`loadProjectData` 对 assets 翻页装载(或提高 limit 后分批)。

## GAP-CROSS-TRACK-OVERLAP:跨轨重叠片段播放头停滞

- **状态**:FIXED→**VERIFIED**(复跑 2026-09-16,分支 defects-4k60-paging-overlap)
  ——根因定位:同素材 V1+V2 共享 input(plan 按素材分配)→ 会话侧共享
  环形纹理池(深 8)+ 单调解码链,双位置消费相距 >8 帧互相淘汰槽位,
  frameReady 永假(台账原"疑似 overlay 音频/时钟路径"排除——播放头推进
  仅由 rAF compose 环驱动)。修复:预览投影层拆分(ir.py
  _split_overlapped_inputs)——可视段 timeline 重叠者自第二份起分配复制
  输入(input_id 加 `~n` 后缀),桌面侧各得独立 worker/环池;非重叠同素材
  复用不变(F03/F07 既有经济性保持);权威渲染路径零影响;
  IR_PROJECTOR_VERSION 1→2(v2 manifest 缓存自动失效)。Core 单测 5 项
  +Desktop 单测 1 项(双 rig 会话 frameReady 可满足、compose 推进)。
  已知成本:重叠成员各占一个 decode worker(档位 range-cache 预算约束)。
  **复跑(2026-09-16)——VERIFIED**:`evidence/performance/defect-verify-f07-smoke2/`
  F07 双位置混音装配冒烟通过(spec assembleF07 增同素材 V1+V2 重叠段
  [源窗 2-4s] + PiP transform,`dual_position_overlap=1` 落入 scene_extra);
  装配成功、合成预览就绪,播放 30s 期间 compose 推进 858–868 次
  (≈28–29fps,满帧率)——旧缺陷"播放头停滞 ~1 帧"消失;off 轮探针干净;
  setup_recovery_count 全 0。A1 不收视频素材(能力缺口)维持登记,
  需契约层设计另立工作单。
- **优先级建议**:中(契约允许 V1+V2 重叠,但预览不可用)
- **现象**:V1+V2 同源重叠片段经 patch 装配成功(契约校验通过)后,预览
  播放头 ~1 帧后停滞不推进。疑似 overlay 音频/时钟路径问题。
- **影响**:B13/B15 的"同源双位置混音"验收口径在完整 App 层面无法验证;
  F07 场景该维度未装配(报告 5 节)。
- **关联**:视频素材不可入 A1(`insert_asset_clip` 按 kind 分支)是同类
  混音能力缺口,可合并处理。

---

**登记约定**:修复完成后由对应 Owner 在性能侧复跑相关场景验证(F05 两项
复跑 B00 harness F05;分页项升 F04 至 100 素材;重叠项补 F07 双位置混音
装配并复测),结果记回本文件对应条目。

**状态快照(2026-09-16 更新)**:四项处置完成——2026-09-15 缺陷批
(W1–W4,分支 defects-4k60-paging-overlap,规划见
`docs/PRODUCT_DEFECTS_FIX_PLAN_2026-09-15.md`)代码修复完成;2026-09-16
性能侧复跑:W1/W2(F05 五轮全过,`defect-verify-f05-20260915-v2/`)、
W4(F07 双位置混音装配冒烟通过,`defect-verify-f07-smoke2/`)升
**VERIFIED**;W3(F04 100 素材口径)代码行为验证通过但单次运行连续
5 轮全过未达成(失败轮皆环境性停顿+renderer 票据时序竞态,数据面完备;
代码侧加固随本轮入库,follow-up 已登记),维持 **FIXED**。
Desktop 全量 649 passed(75 文件)、Core 全量 798 passed+2 skipped
(C22 取消测试在本机解码快于取消窗口,环境性 skip)。A1 收视频素材为
能力缺口(另立工作单,非缺陷)。

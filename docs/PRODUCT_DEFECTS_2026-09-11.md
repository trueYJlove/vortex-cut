# 产品缺陷与工作单登记(2026-09-11,B00 G0 轮)

来源:B00-B 场景装配与正式 G0 采样(`docs/PERFORMANCE_B00_G0_BASELINE_2026-09-11.md`)
期间发现的被测系统缺陷与产品缺口。**这些不是 harness 问题**——harness 按实际行为
记录测量值,不阻断采样;修复属产品工作单,不自动纳入性能工程范围。

证据位置:
- `evidence/performance/g0-baseline-20260911-v2/F05/`(DEFECT-4K60-SEEK 五轮数据)
- `evidence/performance/b00b-smoke-f05-02/`(首轮观察)
- `evidence/performance/b00b-smoke-f07-11/` 报告 5 节(A1/跨轨重叠约束)

---

## DEFECT-4K60-SEEK:4K/60fps 暂停态 seek 静默失败(事件不齐)

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

- **优先级建议**:高(不可恢复的挂起,用户只能重载)
- **现象**:4K 源首次导入装配(不 reload)时,标签已切"合成预览"但 canvas
  超过 4 分钟不挂载;无错误、无回退提示。reload 后装配正常(F05 G0 各轮
  `setup_recovery_count=0`、ready ≈ 2.7s)。
- **复现**:B00 harness F05 冒烟首次装配(见 B00-B 报告 6b 节)。
- **根因线索**:PreviewSession/WebCodecs create 路径疑似挂起;A01 的握手
  超时(15s)未覆盖该分支,create 完成回调缺失时无兜底。

## GAP-LIST-ASSETS-PAGING:list_assets 分页导致超页素材丢票

- **优先级建议**:中(48 素材内功能正常;100 素材口径被阻塞)
- **现象**:`list_assets` 默认 `limit=50`,编辑器 reload 只装载第一页;
  第 51+ 素材无 media ticket,合成预览回退("no ticket for asset_...")。
  "刷新素材库+重试"不能恢复(refreshAsset 只补登记,不解决翻页装载)。
- **影响**:F04 无法按计划升回 100 素材口径(现 48);大项目导入后预览不可用。
- **修复方向**:`loadProjectData` 对 assets 翻页装载(或提高 limit 后分批)。

## GAP-CROSS-TRACK-OVERLAP:跨轨重叠片段播放头停滞

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

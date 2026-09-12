# B13-R(解码驻留上限)Planning Gate(2026-09-11)

角色:LiuWei(范围与验收口径)。依据:主计划 `PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md`
头部"下一工作包建议"(`c14c53a`)、C20 v2 A/B 报告 `PERFORMANCE_C20_PHASE2_AB_2026-09-12.md`
§4 归因修正、本工作包开工前的代码证据盘点(§5)。

## 1. 问题重述(实测驱动)

F02(900s@640×360@30,27000 帧,单视频输入)v1 全速播放下 Tab 工作集 16.7GiB。
C20 v2 A/B 实测已证明该内存**与 IR 帧表形态无关**(v1/v2 同为 16.7GiB),由解码量
线性驱动(v2 停滞 564 decode→3.5GiB;v2 全速 7968 decode→16.7GiB)。

**斜率归一(本工作包新证据)**:(16689−3503)MB ÷ (7968−564)decode ≈ **1.78MB/decode**
(≈1824KiB)。与 F02 尺寸的结构驻留对照:

| 每帧对象 | 640×360 |
|---|---:|
| NV12 VideoFrame | 337.5KiB |
| RGBA(含 mip 4/3) | 1200KiB |
| NV12(含 mip 4/3) | 450KiB |
| RGBA+mip + NV12+mip | **1650KiB** |

1.78MB/decode ≈ 1650KiB±10%:**嫌疑主体是"每 decode 一次、从不回收"的 GPU/D3D11
分配**(ANGLE zero-copy 路径的 surface 滞留/驱动 staging),而非 JS 可见驻留
——JS 侧全部有界:环槽 8 槽复用(~9.4MiB RGBA 口径)、decode LRU 缓存禁用
(`DecodeWorker.create` 固定 `cacheFrames:0`)、Range 缓存 128MiB 封顶、GOP 锚+中间环
<2MB、帧表 13.5MB。

**推论(待实测判别)**:这不是"预算不够"的问题,是"分配不回收"的问题。先判别、
再修复、后上限——顺序不可颠倒(在未定位主体前加预算硬上限只会制造超预算回退,
不影响泄漏)。

## 2. 范围

**目标(阶段化)**:

- **R1 判别(遥测先行)**:
  - Worker 侧 VideoFrame 生命周期计数:`decoded` / `posted`(转移出)/ `closed`
    (worker 内)/`inFlight`(在途),decode-worker 与 compositor-worker 各自记账,
    每 N 秒经既有 perf 通道上报;compositor 侧补 `uploadOk/uploadErr/closedOnErr`。
  - Tab WS 斜率 A/B(单场景 F02 短轮,~120s 播放,看斜率而非绝对值):
    a) direct 上传 off(强制 copyTo 回退,`frameUploadMode` 已有开关语义);
    b) compose flush 策略(每 compose flush vs 每 30 compose);
    c) decode 频率对斜率的线性度(LEAD 收 2 复跑)。
  - 判别输出:斜率主体归因到"direct texImage2D(VideoFrame) 路径"/"驱动 surface 池
    随 decode 增长"/"在途 VideoFrame 未关闭",三选一(或组合),写进报告。
- **R2 修复**:按判别结论修(候选:direct 路径定期重建槽纹理防 surface 滞留、
  copyTo 回退、flush 合并、在途帧关闭兜底)。附带两处无争议小修(不等判别):
  1) `uploadToTextures` catch 分支不 `frame.close()`(错误路径泄漏,补 finally 语义);
  2) direct 模式下 `textureBytesOf` 仍按 NV12 记账(实际 RGBA 2.67×),记账改随
     `frameUploadMode` 实况。
- **R3 上限(修复落地后)**:解码驻留硬上限接线到 B13 预算表(新增
  `decodeResidencyMiB` 档位值,初值 conservative 64/balanced 128/high 256);
  超限行为=收缩 LEAD→降 decode 保温→明确回退提示(复用 InputPool pressure 次序,
  不静默删层)。**R3 仅在 R1 判别出"JS 可见主体"时按原样实施;若判别为驱动侧,
  R3 改为"播放速率 × 驻留斜率的护栏值"(无分配可挡,只能限速/告警),如实登记。**

**不修改**:B11 代理降级(本轮不接,压力次序最后一档留接口)、C20c、ready 串行链、
音频链路、导出管线。

## 3. 验收口径

| 项 | 判定 |
|---|---|
| 判别报告 | 斜率主体有实验证据支撑(每组 A/B 带 N≥2 轮、斜率置信区间),不靠推演定罪 |
| 修复后斜率 | F02 全速播放 WS 斜率 ≤0.2MB/decode(即 300s/8000 decode 级别下 WS 增量 ≤1.6GiB→目标 <300s 曲线进入平台,平台判定=最后 60s 斜率 ≤10MiB/min) |
| 行为正确性 | Desktop 单测/typecheck/lint 全过;F02/F01 smoke 可播可 seek;v1/v2 帧内容无回归 |
| R3 | 上限生效可观测(遥测字段),超限降级路径有单测;若驱动侧则护栏值+告警落地 |
| 不掩盖 | 判别失败/无法修复时如实登记,不重定验收;C20 v2 A/B 报告 §6.1 "trace 留证"表述同步勘误(实际无崩溃 dump,仅 failure.json `invalid-incomplete`,见 §5) |

## 4. 风险与边界

- 驱动/ANGLE 行为不可从 JS 完全控制:若 R2 候选全部无效,F02 内存问题的残余
  归为平台限制,登记后转向"限速护栏+文档化"(R3 变体),不无限投入。
- direct→copyTo 回退有实测代价(copyTo p95 ~42ms 是 scrub 延迟大头,worker 化后
  上传 p95 14–25ms):修复方案不得无条件退回 copyTo,须先试重建槽纹理/定期
  GL 上下文健康检查等保留 zero-copy 的手段。
- A/B 机器噪声:斜率指标对后台负载敏感,轮次间控制变量(同机、插电、关后台),
  报告附 environment。

## 5. 开工前代码证据(2026-09-11 盘点,引用行号为当日 HEAD c14c53a)

- `decode-worker.worker.ts`:`cacheFrames:0` 禁用 LRU(46–52,159–174);GOP 锚
  (127–142)与中间环 3(108–125)有界;冷启整例重建解码器(262–270)——
  解码器实例不随 decode 增长。
- `compositor-worker.worker.ts`:环槽按槽复用(723–731),上传成功路径
  `frame.close()`(298/404);catch 分支漏 close(406–412);direct 模式
  `texImage2D(gl.TEXTURE_2D, ..., frame)`(281–299)每次重指定槽纹理——**JS 层
  纹理对象不变,但驱动层分配行为未证**;`gl.flush()` 每 compose(711)。
- `preview-session.ts`:`uploadRing` epoch 作废路径有 close(743/756);LEAD
  联动环深(817);压力降级次序完整(629–663)。
- 崩溃证据勘误:`evidence/performance/c20v2-ab-20260911-v2/F02/run-0-on/` 仅
  failure.json(status=invalid-incomplete,错误文本按隐私策略未持久化)+
  user-data 快照;desktop.log 末尾为正常 before-quit shutdown,**无崩溃 dump、
  无 crashpad 目录**。C20 A/B 报告"trace 留证"表述过重,随本工作包勘误。

## 6. 门判定

范围/口径如上,**批准进入实现**,次序 R1→R2→R3(R3 形态由 R1 结论定)。
实现按"可审查单提交"推进:R1 遥测一提交、R2 修复一提交、R3 上限一提交,
报告落档 `PERFORMANCE_B13_RESIDENCY_IMPLEMENTATION_2026-09-12.md`(顺延日期以
实际为准),主计划头部同步。

# Core manifest 投影缓存——磁盘持久层(Planning Gate)

> 起草:LiuWei,2026-09-18。承接主计划更新·十七/十九的立项候选
> ("实测已齐:命中收益 ≈1.8s/冷启动")与 C20c Gate §2 排除项第 1 条。
> 实施:ZhangSan(Core)。验收:LiuKeAi 独立复核。

## 0. 立项输入复核(2026-09-18 代码级复核,修正一处关键认知)

- **链路现状**:`preview_ir`/`preview_ir_manifest` 每请求先 `_compile_off_loop`
  (SQLite 读 document_json + 逐 clip 构建),再查**进程内存缓存**
  (v1 `preview_ir_cache` LRU 4 / v2 `preview_ir_v2_cache` LRU 2,键 =
  content_fingerprint);未命中才走 ffprobe(会话缓存)+ 投影
  (IrProjectExecutor single-flight)。
- **收益边界修正**:主计划登记的"重开项目 ready 2,433→0.7s"其 1,806ms
  首投影发生在**进程冷启动后的首个 manifest 请求**。进程内存缓存只在
  Core 常驻期间有效——renderer reload(页面刷新/开发迭代)场景命中,
  **app 重启(用户次日重开)场景 Core 新进程、缓存空,1.8s 照付**。
  因此本工作单的实质是**把投影结果持久到磁盘**,让"每 app 安装后首次"
  之后的冷启动都命中——这才对应登记的收益场景。
- 收益口径维持:命中收益 ≈1.8s/冷启动(用户口径 ready ≈0.7s);基准口径
  (含 harness 导入+patch 负载)不设绝对值门。

## 1. 范围

### 必须实现

1. **磁盘持久层**:`data_dir/cache/preview-ir/<manifest_id 前 2 字符>/<manifest_id>.json`
   (manifest_id 已含 content_fingerprint@mode@profile_id,天然含比例/模式/
   revision 语义;v1 全量 IR 同键族——manifest_id 与 v1 共享投影源)。
2. **读路径**:`_ir_v2_bundle` 与 `preview_ir` 在进程缓存未命中时查磁盘;
   磁盘命中 → 直接装回进程缓存并返回(跳过 ffprobe 与投影)。
3. **写路径**:进程内新投影完成后原子写盘(tmp + os.replace)。
4. **失效键**:缓存文件名携带校验段,条目内嵌
   `{projector_version, asset_identity_fingerprints, created_at}`;
   读取时 projector_version 不符(投影器升级)或素材指纹集不符
   (素材替换/重导)→ 视为未命中并删除陈旧文件。
   content_fingerprint 已覆盖时间线语义与输出规格;**素材内容变化但
   fingerprint 复用**的场景由素材 identity 段兜底(A07 的
   fingerprint+stat+build 三元中的指纹集合)。
5. **体量护栏**:LRU 语义延伸到磁盘——目录条目 >8 条时按 mtime 淘汰最旧
   (v1+v2 分池各 4 条与内存对齐;单条 1–3MB,磁盘占用上限 ≈25MB)。
6. **容错**:磁盘读/写/删除任何 OSError 静默降级为未命中/不写盘——缓存
   永远只是加速,不成为正确性依赖。

### 明确不做(边界)

- 不做增量投影/段级 diff(主计划登记的"/增量"半边,待真实需求);
- 不做跨机器迁移(缓存目录在 user-data,随项目数据走);
- 不改 endpoint/契约形状(纯 Core 内部);渲染/导出路径零影响;
- A07 probe 会话缓存不变(磁盘命中时连 probe 都跳过——probe 结果已隐含
  在 IR 内,素材身份由失效键保证)。

## 2. 设计要点

- **键选择**:磁盘文件名 = `manifest_id_of(plan)`(含 fingerprint,对
  时间线内容/revision 切换/输出比例天然分区);文件内嵌
  `meta = {"projector_version": N, "asset_fingerprints": sorted([...]),
  "created_at": iso}`。projector_version 变更(如本仓库 v3)→ 全部旧条目
  自然失效,无需迁移。
- **原子性**:写 `.tmp` 后 `os.replace`;读侧 JSON 解析失败即删文件回
  未命中(防半写/损坏条目永久 miss)。
- **single-flight 协同**:磁盘命中在 `IrProjectExecutor.project` 之外、
  进程缓存检查之后——并发首请求仍由既有 single-flight 合并,磁盘层
  不引入新竞态(读-装回进程缓存的 set 幂等)。
- **失效写入时机**:素材删除/替换走既有 derive/invalidate 通道外的
  兜底——不主动清理(指纹不符读时自愈),避免在删除路径上新增 IO。

## 3. 验收

1. **单测**(Core):
   - 首次投影写盘;第二次同 plan(新 coordinator 实例 = 模拟重启)直接
     磁盘命中,ffprobe/投影零调用(mock 计数);
   - projector_version 变更 → 旧条目不命中且被删除;
   - 素材指纹变化(同 fingerprint 复用场景)→ 不命中;
   - 损坏文件 → 静默删除回未命中,不抛;
   - >8 条目 LRU 淘汰(mtime 最旧);
   - v1 `preview_ir` 与 v2 manifest 同键共享(先 v2 后 v1 命中同一磁盘条目
     的投影产物——按 bundle→v1 payload 的适配,或 v1 独立条目,以实现
     简洁者为准,测试锁定所选语义)。
2. **全量回归**:Core pytest 全量;Desktop 全量(零改动预期全绿)。
3. **实测留证**(性能侧,协议沿 F02):冷启动(删缓存目录)vs 二次启动
   (磁盘命中)各 1 轮 F02,ready 段 ② 对比留证 `evidence/performance/`
   ——命中轮 manifest 请求 <100ms。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 陈旧缓存被消费(投影语义变了但版本没动) | projector_version 是语义变更的既定载体(v3 先例);单测锁"版本不符不命中" |
| 磁盘 IO 抖动反而拖慢 | 命中路径 = 读 ≤3MB JSON,≪1.8s 投影;失败即降级 |
| 缓存目录膨胀 | LRU 8 条 ≈25MB 上限 |
| 多进程并发写 | Core 单实例(sidecar);os.replace 原子 |

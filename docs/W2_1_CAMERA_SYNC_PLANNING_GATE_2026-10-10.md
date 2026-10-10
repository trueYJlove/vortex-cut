# W2.1 机位同步（多机位对齐）—— Planning Gate

> 起草：LiuWei（架构师），2026-10-10。**修订：2026-10-10（按 LiuKeAi 独立评审的最小修改集）**。
> 承接 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` §6 Wave 2 / W2.1；依赖 W0.2（已完成）、ADR-0004 **DEC-2**。
> 实施：ZhangSan（Core）+ YeJing（Desktop/契约）；验收：LiuKeAi。

## 0. 现状走读结论（代码级，2026-10-10）

1. **全仓无任何互相关 / 机位 / 角度概念**（grep correlation / camera_sync / angle 均 0 命中；services 与 contracts 同）——本包从零起。
2. **PCM 解码面必须按事实写清**（评审 A/D-1 纠正）：既有两条音频解码路径语义**互不相同**——
   `media/audio_chunks.py` 是 **交错双声道 f32le 2s 块**（12 字节头，每块一个独立 ffmpeg 进程），
   `media/beat_service.py` 是 **22050 s16le 单声道单遍流式**。本包**不复用块路径**（见 §2.2 冻结口径）。
3. **分析类交付范式齐备**：job kind 分派、`algorithm_version` 行化存储 + 指纹 stale、Core 路由 + IPC + 面板轮询。
4. **迁移头 v35** → 本包 **v36**（纯分析表）。**纪律：v36 落地必须同改 `docs/STATUS.md` §1 的 `latest_migration`（35 → 36）**，否则 `test_status_doc_consistency.py` 红。
5. **本包不写任何时间线 op**：只产「机位映射元数据」；V1 展平是 W2.3 的事（I4 / DEC-2）。
6. **DEC-2 三项元数据的承接口径**（评审 A2）：D2 要求「各机位时间偏移 + 切换点对应机位 + 同步数据引用」三项。本包冻结**前两项的引用形状**：
   偏移表即 `angle_syncs`；**切换映射表由 W2.3 冻结，但必须引用本包行标识（`angle_syncs.id` + `algorithm_version` + 双侧指纹）**，不得另起一套互不引用的元数据面。

## 1. 范围

### 1.1 必须实现

1. **机位组（angle group）**：项目内具名组 = 1 个参考机位 + N 个成员机位；每个机位 = 一个视频素材；持久化（D1）。
2. **同步算法（本地、零 egress、纯 numpy）**：包络（10ms RMS）归一化互相关粗对齐 → 按粗对齐平移后取 2s 窗做样本级归一化互相关 → 双窗一致性 → 置信度判定。
3. **状态机**：`queued / running / ready / failed / unavailable`（stale **不落库**，读时计算——见 §2.1 行选择规则）。
4. **存储（v36）**：`angle_groups` + `angle_syncs`；**指纹入唯一键**（素材变更 = 新行、旧行保留）；**双侧**指纹（参考侧 + 成员侧）。
5. **无音频 / 静音 / 低置信度**：`unavailable` + reason；**人工偏移**为合法降级（`source=manual`），与自动行**并列**而非覆盖；人工偏移带来源时间戳（D-3）。
6. **Core API**：建组 / 列组 / 触发同步（`generate=True`）/ 读摘要 / 写人工偏移。
7. **Desktop 最小面**：素材箱多选 →「机位同步」→ 结果面板（参考机位选择 + 每机位 offset/confidence/status + 重算 / 手填）。

### 1.2 明确不做

- 不做说话人分离（W2.2）、不做切换规划器与 V1 展平（W2.3）、**不写任何时间线 op**；
- 不做时间码解析；不做漂移建模（先取证，见 R1）；不引入新模型 / 新依赖（无模型下载、无 embedding、无降噪模型）；
- 不冻结「切换点对应机位」表（W2.3），但按 §0.6 约束其引用形状；
- **本包不是 editing_grammar 规划器**：不受「信号快照 → TimelinePatch」统一输出格式约束，只产分析表（评审 A5）。

## 2. 设计要点（冻结项）

### 2.1 数据模型（v36，分析表；按评审 C1/C2/C3 修正）

```sql
CREATE TABLE angle_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  reference_asset_id TEXT NOT NULL REFERENCES assets(id),
  members_json TEXT NOT NULL,        -- 有序成员（含参考机位，index 0 = 参考）；组创建即固定
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_angle_groups_project ON angle_groups(project_id, created_at DESC);

CREATE TABLE angle_syncs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES angle_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  is_reference INTEGER NOT NULL CHECK(is_reference IN (0,1)),
  offset_us INTEGER,
  confidence REAL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  reason TEXT,
  source TEXT NOT NULL CHECK(source IN ('auto','manual')),
  reference_fingerprint TEXT NOT NULL,
  asset_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
  CHECK (is_reference = 0 OR offset_us = 0)
);
-- 指纹入唯一键 + 部分索引（照抄 database_v26.py:28-29 的 beat_grids 范式）：
-- 素材变更 ⇒ 新指纹 ⇒ 新行可写，旧行保留；**不会**出现「重算写失败」。
CREATE UNIQUE INDEX idx_angle_syncs_ready ON angle_syncs(
  group_id, asset_id, algorithm_version, source, asset_fingerprint, reference_fingerprint
) WHERE status IN ('ready','unavailable');
CREATE INDEX idx_angle_syncs_group ON angle_syncs(group_id, asset_id, created_at DESC);
```

**行选择规则（冻结，评审 C2）**：摘要按 `(asset_id)` 取一条 —— ① 有 `source=manual` 的行优先（人工声明优先于自动测量）；
② 同 source 内 `algorithm_version` 降序优先，再 `created_at` 降序；③ 只取 `status IN ('ready','unavailable')`。
①的例外：manual 行若判定为 stale（见下）则不参与优先，退回 auto 并在摘要标注。

**stale 判定（冻结）：读时计算**（对齐 `beat_grids`，不落状态位）：行内 `reference_fingerprint` / `asset_fingerprint` 与当前素材指纹比对；
任一侧不符 ⇒ 该行报 `stale`。**回退语义（与 P79 一致）**：素材改回原样 ⇒ 指纹回到原值 ⇒ 旧行自动重新有效（明确为期望行为，验收 4 覆盖）。
**素材 availability ≠ available** ⇒ 摘要报 `unavailable(reason=asset_not_available)`（不消费 changed/missing 素材的偏移）。

**组内成员顺序（S1b 实施修订）**：成员列表与顺序落在 `angle_groups.members_json`（index 0 = 参考机位），
本轮不做成员增删；`angle_syncs` 只存结果行，不承担成员表职责。

**外键与删除策略（冻结，评审 C3）**：
① 删素材：`angle_syncs.asset_id` 为裸引用 ⇒ 沿用既有 `ASSET_IN_USE` 拒绝路径，但**错误码文案必须能被用户理解**（W2.1 在 `projects.delete_asset` 的占用检查里补 angle 引用分支，文案：「素材被机位组引用」）；
② 删组：`angle_syncs` 随组 CASCADE 删除（有意为之——组是元数据的所有者；W2.3 的「重算」依赖组存在）；
③ 从组里移除机位：本轮**不做**成员增删（组创建即固定），遗留行为不存在（后续若做，须同时删该机位的行）。

### 2.2 算法与 PCM 口径（冻结；评审 D-1 纠正）

- `ANGLE_SYNC_ALGORITHM_VERSION = 1`
- **PCM 口径（冻结，versioned）**：48kHz / **单声道（显式 `-ac 1` 下混）** / **f32le** / **单遍流式解码**：
  `-ss(预滚 0.5s) + atrim 精裁` → `aresample=48000:async=1:first_pts=0` → `-ac 1` → `-c:a pcm_f32le -f f32le` → stdout 流式读取；
  **不复用 audio_chunks 的块路径**（那是交错双声道 2s 块 + 每块一个进程，语义不同且进程数×30）；混音/下混规则与位深计入算法版本。
- 包络 hop 10ms；粗搜索窗 = min(60s, 两侧重叠时长)；精对齐窗 2s、第二窗偏移 1s；
- 置信度 = 精对齐窗的**归一化相关峰**（不用峰值/次峰比：spike 实测无区分力）；`confidence >= 0.5` 且双窗差 ≤ 5ms 才 `ready`；
- **精度口径（两级，评审 B1）**：粗对齐断言 |误差| ≤ 10ms（证明粗阶段工作）；**精对齐断言 |误差| ≤ 1ms**（48kHz 下 48 样本）——
  这样「没做精对齐」的实现必然红；
- **±10ms 是音频样本对齐精度，不等于帧级对齐**（评审 D-2）：25/30/50fps 帧间隔 40/33/20ms；帧级对齐需额外锚点（打板/时码），属 W2.3 前置条件；
- 确定性：无随机、无时间依赖 → 同输入 byte-equal。

### 2.3 接口与契约（增量）

- `POST /api/v1/projects/{p}/angle-groups` / `GET .../angle-groups`
- `POST /api/v1/projects/{p}/angle-groups/{g}/sync`（`generate=True`；幂等短路：**组内全部**机位都有指纹相符的可用行时才短路）
- `POST /api/v1/projects/{p}/angle-groups/{g}/angles/{asset_id}/offset`（人工偏移；**写入新行**（source=manual），不 upsert 覆盖）
- 契约：`JobKind` 追加 `angle_sync`；新增 `AngleGroup` / `AngleSyncSummary` + parse；PROTOCOL_VERSION 不动（增量，P46 先例）
- Renderer 可见面不含路径字段

## 3. 验收（可断言，逐项给证据；按评审 B 系列重写）

1. **合成偏移 fixture（两级口径 + 负向对照）**：真值 1234 / 137.4 / 41.7 / 0 / −253 / −1500 ms（含**非整数样本**与**负值**，防符号取反/常数 0 蒙过）
   → 粗 |误差| ≤ 10ms **且** 精 |误差| ≤ 1ms；**负向对照：把精对齐短路（只取粗）⇒ 必须红**。
2. **区分力对照（必须有）**：①**无关音频** ⇒ `unavailable(low_confidence)`（置信度硬编码 1.0 时必红）；
   ② 同源但通道退化（混响 + −30dB 噪声底）⇒ 仍 `ready` 且在门内（证明阈值不是靠宁滥勿缺蒙过）；③ 纯静音/无音轨 ⇒ `unavailable(no_audio_or_decode)`。
3. **幂等与重试**：全 ready 且指纹相符 ⇒ 不建作业；**指纹变化后再 sync ⇒ 必须建新作业/新行**；**failed 行存在 ⇒ 允许重试**（不得一次失败永久锁死）。
4. **stale 矩阵（4 变体）**：① 只改参考侧 ⇒ 全组行 stale；② 只改成员侧 ⇒ 仅该成员 stale（其余不受影响）；③ 改回原样（previous_fingerprint 回退）⇒ 自动恢复有效；④ 素材 availability ≠ available ⇒ 摘要 `unavailable(asset_not_available)`。
5. **确定性**：同输入两次运行 `offset_us` 完全相同。
6. **零 egress + 无新模型面**：provider 调用 0 **且** 无 `model_download` 作业、无 `model_installations` 新行。
7. **性能门（带环境口径）**：2×60s ≤ 30s，须记录机型 / ffmpeg build / 素材编码 / 冷热态 / 并发度，并归档 evidence（沿用 P33/P69 惯例）。
8. **人工偏移**：写入后可读回、摘要标注 `manual` + 时间戳，且与 auto 行**并列**（不覆盖）；
   **9. 真实多机位端到端**：需用户提供同场次双机位素材；另按 D-2 以**共同声音事件**（击掌/打板）人眼标注核对「音频偏移 == 画面偏移」。
   **未取证不阻塞本门批准，但阻塞 Verification Gate 的「含真实素材」判定**（评审 §5-7）。

## 4. 风险与对策（逐条登记到 STATUS §4）

| # | 风险 | 对策 | 登记 |
|---|---|---|---|
| R1 | 设备采样时钟漂移 → 单一偏移在长素材上不成立 | 分段偏移 + 线性拟合斜率；|斜率| 超阈时**如实报 drift 并给分段表**，不静默接受单值 | P81 |
| R2 | 无音频 / 纯静音 / 极低信噪机位 | `status=unavailable` + reason；人工偏移为合法降级，**不猜** | P82 |
| R3 | 混响 / 不同麦克风导致相关性退化 | 归一化相关峰 + 双窗一致性；低置信度一律 unavailable（宁可少收，不可误伤） | P83 |
| R4 | 无真实多机位素材 → 验收 9 无法取证 | 向用户索取样片；未取得前该项显式标「未取证」（禁止合成素材顶替） | P84 |
| R5 | 长素材解码/FFT 成本 | **单遍流式解码**（不用块路径）+ 窗口化；性能门见验收 7（带环境口径） | P85 |
| R6 | 素材变更后陈旧偏移被误用 | 双侧指纹入行**并入唯一键** + 读时 stale；消费方（W2.3）必须拒 stale | P86 |

## 5. 待裁决（实施前需用户/架构师确认）

| ID | 问题 | 建议 |状态 |
|---|---|---|---|
| D1 | 机位组是否持久化 | **持久化**（W2.3 重算需要组身份） | 按建议执行 |
| D2 | 参考机位如何选 | **用户指定**，默认组内第一个 | 按建议执行 |
| D3 | 精度目标 | **音频样本级：粗 ≤10ms / 精 ≤1ms**；帧级对齐需额外锚点（D-2） | 按建议执行（口径已改写） |
| D4 | 漂移处理是否进本包 | **先取证**（验收 1 加漂移 fixture），超阈才实现分段 | 按建议执行 |
| D5 | 真实多机位素材由谁提供 | **需用户提供**（阻塞验收 9 的取证判定，不阻塞本门批准） | 待用户 |
| D-1 | 精对齐用哪条解码面 + 性能基准口径 | **单遍流式（已冻结 §2.2）**；块缓存不进正确性路径；性能门带环境口径 | 已裁决（评审驱动） |
| D-2 | 「音频对齐 ⇒ 画面帧对齐」的隐含假设 | ±10ms 为**音频样本精度**；帧对齐需打板/时码锚点，列为 W2.3 前置条件；验收 9 加共同声音事件核对 | 已裁决（评审驱动） |
| D-3 | 人工偏移可追溯性 | 落行带 `created_at` + 摘要标注来源与时间；W2.3 rationale 若采信手工偏移必须标注 | 已裁决（评审驱动） |

## 6. 门禁状态

- [x] Planning Gate 起草（2026-10-10）
- [x] **独立评审完成（LiuKeAi，2026-10-10）：判定「需修改后批准」，最小修改集 7 项已全部落回本文件**
- [ ] Planning Gate 批准（用户）
- [ ] Design Gate / Implementation / Verification / Release

## 7. 评审处置记录（2026-10-10）

| 评审项 | 处置 |
|---|---|
| C1 UNIQUE 键不含指纹 ⇒ 重算写失败 | ✅ 已改：指纹入唯一键 + 部分索引（§2.1） |
| C2 行选择规则未定义 / stale 计算方式未裁决 | ✅ 已冻结：manual 优先 + 版本/时间降序；stale 读时计算（§2.1） |
| C3 外键与删除策略三问 | ✅ 已冻结：删素材拒绝但补专用文案 / 删组 CASCADE / 本轮不做成员增删（§2.1） |
| C4 stale 边界（回退、availability、manual 是否跟指纹） | ✅ 回退即重新有效；availability≠available ⇒ unavailable；manual 亦随指纹 stale（§2.1） |
| C5 STATUS §1 同改纪律 | ✅ 已写入 §0.4 |
| B1 容差无区分力 | ✅ 两级口径 + 短路负向对照（§2.2/§3.1） |
| B2 fixture 缺区分力对照 | ✅ 无关音频 / 通道退化 / 0 真值 / 边界（§3.1–§3.2） |
| B3 幂等只验计数 | ✅ 补指纹变化与 failed 重试（§3.3） |
| B4 stale 缺变体 | ✅ 4 变体矩阵（§3.4） |
| B5 性能门无口径 | ✅ 环境口径 + evidence（§3.7） |
| B6 并列不覆盖零断言 | ✅ 验收 8 |
| A2 DEC-2 三项元数据承接 | ✅ §0.6 |
| A3 零 egress 断言面不足 | ✅ 验收 6 加无模型面 |
| A4 W0.4 评测维度 | ✅ 本包不产评测样本：机位同步质量**不进入** W0.4 评测集（理由：评测集无多机位档位，且本包只产元数据；待真实素材到位后另行立项） |
| A5 与语法层输出格式的关系 | ✅ §1.2 末条 |
| D-1/D-2/D-3 | ✅ §5 三条裁决 |

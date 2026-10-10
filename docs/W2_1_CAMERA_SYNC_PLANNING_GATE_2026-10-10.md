# W2.1 机位同步（多机位对齐）—— Planning Gate

> 起草：LiuWei（架构师），2026-10-10。承接 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` §6 Wave 2 / W2.1。
> 依赖：W0.2（已完成）、ADR-0004 **DEC-2**（多机位 = V1 展平 + 机位映射元数据，可重算）。
> 实施：ZhangSan（Core）+ YeJing（Desktop/契约）；验收：LiuKeAi（独立验证门）。

## 0. 现状走读结论（代码级，2026-10-10）

1. **全仓无任何互相关 / 机位 / 角度概念**：grep 无 correlation / camera_sync / angle —— 本包从零起，无历史包袱可复用决策。
2. **音频解码有既有可复用面**（关键：不新开解码路径）：`media/audio_chunks.py` 已提供 48kHz 单声道 PCM 2s 分块 + derived_cache 缓存 + `ensure_chunk`；`media/beat_service.py` 已有「FFmpeg PCM → numpy → 落库」的作业执行范式。
3. **分析类交付范式齐备**：job kind 分派（`jobs.py`）、`algorithm_version` 行化存储 + 指纹 stale 语义（v26 `beat_grids` 范式）、Core 路由 + Desktop IPC/preload + 面板轮询（Wave1 L2 刚做过一遍）。
4. **迁移头 v35** → 本工作包新增 **v36**（纯分析表，不动时间线文档 schema——符合总纲 §2.3「只有分析类数据才需要迁移」）。
5. **本包不写任何时间线 op**：W2.1 只产出「机位映射元数据」；把机位切到 V1 的展平序列是 W2.3 的事（I4 / DEC-2）。

## 1. 范围

### 1.1 必须实现

1. **机位组（angle group）**：项目内具名组 = 1 个参考机位 + N 个成员机位；每个机位 = 一个视频素材。
2. **同步算法（本地、零 egress、纯 numpy）**：
   - 粗对齐：能量包络互相关（10ms hop）→ 秒级偏移；
   - 精对齐：粗对齐附近取高能量窗做 GCC-PHAT → 样本级偏移（48kHz）；
   - 输出：`offset_us`（成员相对参考，正 = 成员晚于参考）、`confidence`（峰值/次峰比 + 覆盖率）、`status`。
3. **状态机**：queued / running / ready / failed / stale / unavailable（与 beat_grids 同形）。
4. **存储（v36）**：`angle_groups` + `angle_syncs` 两表；行内记 `algorithm_version` 与**双侧素材指纹**（参考侧 + 成员侧）——任一侧素材变更即 stale。
5. **无音频 / 静音机位**：`unavailable` + reason；**人工偏移**为合法降级（`source=manual`），与自动结果并列而不互相覆盖。
6. **Core API**：建组 / 列组 / 触发同步（`generate=True` 登记作业，幂等）/ 读偏移表 / 写人工偏移。
7. **Desktop 最小面**：素材箱多选 →「机位同步」→ 结果面板（每机位 offset + 置信度 + 重算 / 手填）。

### 1.2 明确不做

- 不做说话人分离（W2.2）、不做切换规划器（W2.3）、**不写任何时间线 op**；
- 不做时间码解析（降级路径本轮只给人工偏移）；
- 不做漂移建模（除非真实素材取证显示需要，见 §4 R1）；
- 不引入新模型 / 新依赖（纯 numpy + 既有 FFmpeg PCM 面）。

## 2. 设计要点（冻结项）

### 2.1 数据模型（v36，分析表）

```sql
CREATE TABLE angle_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  reference_asset_id TEXT NOT NULL REFERENCES assets(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE angle_syncs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES angle_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  is_reference INTEGER NOT NULL CHECK(is_reference IN (0,1)),
  offset_us INTEGER,              -- 成员相对参考；参考自身恒 0
  confidence REAL,
  status TEXT NOT NULL,           -- queued/running/ready/failed/unavailable
  reason TEXT,
  source TEXT NOT NULL,           -- auto / manual
  reference_fingerprint TEXT NOT NULL,
  asset_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(group_id, asset_id, algorithm_version, source)
);
```

### 2.2 算法与常量（versioned，改值即递增）

- `ANGLE_SYNC_ALGORITHM_VERSION = 1`
- 采样 48kHz 单声道（**复用 audio_chunks 的 PCM 语义**，不新开解码路径）
- 包络 hop 10ms；粗搜索窗 = min(60s, 两侧重叠时长)；精对齐窗 2s、重叠 50%
- **置信度（冻结）= 精对齐窗的归一化相关峰**（v3 曾用「峰值/次峰比」，spike 实测**无区分力**：同源 1.22 vs 无关 0.93 —— 见 §2.4）：
  `confidence >= 0.5` 且**双窗一致**（两个 2s 窗的残差之差 ≤ 5ms）才 `ready`，否则 `unavailable` + `reason=low_confidence`
- **确定性**：同输入 → 同输出（byte-equal 断言）

### 2.3 接口与契约（增量，旧客户端不受影响）

- `POST /api/v1/projects/{p}/angle-groups`（建组：name + reference_asset_id + member asset_ids）
- `GET  /api/v1/projects/{p}/angle-groups`（列表 + 每组每机位偏移摘要）
- `POST /api/v1/projects/{p}/angle-groups/{g}/sync`（`generate=True` 登记作业；ready 且指纹相符则幂等短路）
- `POST /api/v1/projects/{p}/angle-groups/{g}/angles/{asset_id}/offset`（人工偏移，`source=manual`）
- 契约：`JobKind` 追加 `angle_sync`；新增 AngleGroup / AngleSyncSummary / parse 校验
- Renderer 可见面**不含任何路径字段**（沿用既有纪律）

### 2.4 算法 spike 记录（2026-10-10，实施前已完成）

规模：30s 合成带限噪声 + 随机停顿，20dB 独立噪声 + 0.7 增益差，48kHz 单声道；脚本 `.tmp/w21-spike4.py`（临时）。

| 真实偏移 | 粗对齐 | 粗+精 | 误差 | 置信度 |
|---|---|---|---|---|
| +1234ms | 1230000us | 1234000us | **0.000ms** | 0.991 |
| +137ms | 140000us | 137000us | **0.000ms** | 0.989 |
| +41ms | 40000us | 41000us | **0.000ms** | 0.990 |
| 0ms | 0us | 0us | **0.000ms** | 0.990 |
| −253ms | −250000us | −253000us | **0.000ms** | 0.989 |
| −1500ms | −1500000us | −1500000us | **0.000ms** | 0.991 |

置信度区分力（选阈值依据）：同源 20dB **0.990** / 10dB **0.916** / 5dB **0.788**；**无关音频 0.052**；纯静音 0.000（offset=nan）；−40dB 低电平噪声 **0.011** ⇒ 阈值 0.5 两侧余量充分（0.788 vs 0.052）。

**spike 中真实踩到的三个坑（写进实现约束，避免重犯）**：
1. **符号/单位约定**必须由 sign check 钉死（v1/v2 均在 `-lag` 上翻车：测出 +1234ms ⇒ 报 −1234ms）；
2. **精对齐窗必须按粗对齐平移后再取**（v2 对同一段直接取窗 ⇒ 偏移被**双计**成 2×）；
3. **负偏移要对称处理**（v3 对 +偏移全对、−253ms 差 500ms：只处理了 `start>=0` 的分支）。

## 3. 验收（可断言，逐项给证据）

1. **合成偏移 fixture（含负偏移）**：同一音频源人为平移**已知**偏移（1234ms / 137ms / 41ms / 0 / −253ms / −1500ms）→ |测得 − 真值| ≤ 10ms；spike 已把该门钉在 0.000ms（20dB 独立噪声 + 增益差），实现不得回退。
2. **负向对照（区分力，必须有）**：①**无关音频**（不同内容的两个素材）→ 必须 `unavailable`（不得输出看似合理的偏移）；②**纯静音/无音轨机位** → `unavailable` + reason；③人工偏移可写入并在摘要中生效（`source=manual`，不覆盖自动行）。
2b. **双窗一致性**：人为构造只有单窗可信的输入（另一窗为静音）→ 必须 `unavailable` 而非 `ready`。
3. **复用**：同步一次 → 读两次 / 规划两次不产生新作业（作业计数断言）。
4. **stale**：任一素材指纹变化 → 该组行 stale；重算后恢复 ready。
5. **确定性**：同输入两次运行 `offset_us` 完全相同。
6. **零 egress**：全链路 provider 调用为 0（外发表计数断言）。
7. **性能门**：2×60s 机位、48kHz，同步 ≤ 30s（resource_class=light）。
8. **真实多机位素材端到端**：需**用户提供同场次双机位素材**（≥30s，含共同声音事件）；未提供前该项标记「未取证」，**不得以合成素材顶替**（见 §4 R4）。

## 4. 风险与对策（逐条登记到 STATUS §4）

| # | 风险 | 对策 | 登记 |
|---|---|---|---|
| R1 | 设备采样时钟漂移 → 单一偏移在长素材上不成立 | 分段偏移 + 线性拟合斜率；|斜率| 超阈时**如实报 drift 并给分段表**，不静默接受单值 | P81 |
| R2 | 无音频 / 纯静音 / 极低信噪机位 | `status=unavailable` + reason；人工偏移为合法降级，**不猜** | P82 |
| R3 | 混响 / 不同麦克风导致相关性退化 | GCC-PHAT + 置信度阈值；低置信度一律 unavailable（宁可少收，不可误伤） | P83 |
| R4 | 无真实多机位素材 → 验收项 8 无法取证 | 向用户索取样片；未取得前该项显式标记「未取证」（禁止合成素材顶替） | P84 |
| R5 | 长素材 FFT 成本 | 窗口化 + 复用 derived_cache PCM；性能门见验收 7 | P85 |
| R6 | 素材变更后陈旧偏移被误用 | 双侧指纹行内记录 + stale 语义；消费方（W2.3）必须拒 stale | P86 |

## 5. 待裁决（实施前需用户/架构师确认）

| ID | 问题 | 建议 |
|---|---|---|
| D1 | 机位组是否持久化（还是每次现选一组素材） | **持久化**——W2.3「换机位 = 用同一同步数据重算」需要组身份 |
| D2 | 参考机位如何选 | **用户指定**，默认取组内第一个；自动挑选（最长/最响）留后续 |
| D3 | 精度目标 | **≤10ms**；帧对齐余量如实展示，不假装帧内对齐 |
| D4 | 漂移处理是否进本包 | **先取证**（验收 1 加漂移 fixture），超阈才实现分段 |
| D5 | 真实多机位素材由谁提供 | **需用户提供**（阻塞验收项 8） |

## 6. 门禁状态

- [ ] Planning Gate 批准（用户）
- [ ] Design Gate（ZhangSan + YeJing 细化实现计划：算法细节 / IPC / 面板 / 迁移）
- [ ] Implementation Gate
- [ ] Verification Gate（LiuKeAi 独立验证：合成 fixture 复跑 + 负向对照）
- [ ] Release Gate

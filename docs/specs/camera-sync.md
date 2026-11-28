# 多机位同步与说话人降级交付规格

> 本文整合 W2.1 多机位音频同步需求规格与模块设计，以及 W2.2 说话人层降级交付契约（D3）。
> W2.2 收口与 W2.3 冻结裁决见 [`../adr/0009-w22-diarization-closeout.md`](../adr/0009-w22-diarization-closeout.md)；当前未闭环项（P81/P84/P89/P132）见 [`../STATUS.md`](../STATUS.md) 与 [`../BACKLOG.md`](../BACKLOG.md)。

---

## 1. W2.1 机位同步需求与冻结口径

### 1.1 范围与关键约束

- **机位组（angle group）**：项目内具名组 = 1 个参考机位 + N 个成员机位（`angle_groups.members_json` index 0 为参考，创建即固定）；不支持成员增删。
- **本地纯 numpy 算法**：`ANGLE_SYNC_ALGORITHM_VERSION = 1`；全链路零 egress、不引入新模型或第三方依赖，不属于 `editing_grammar`（只产分析表，不写时间线 op）。
- **PCM 口径（冻结）**：48kHz / 单声道（`-ac 1`）/ `f32le` / 单遍流式解码（`-ss 0.5s + atrim` → `aresample=48000:async=1:first_pts=0` → `pcm_f32le`），不复用块缓存路径。
- **精度与漂移口径**：
  - 包络 hop 10ms 粗搜索窗（`min(60s, 重叠)`）→ 2s 精对齐窗（第二窗偏移 1s）；归一化相关峰 `confidence >= 0.5` 且双窗差 ≤ 5ms 才 `ready`。
  - **两级断言口径**：粗对齐 |误差| ≤ 10ms，精对齐 |误差| ≤ 1ms；±10ms 为音频样本对齐精度，帧级对齐需打板/时码锚点。
  - **时钟漂移检查**：相隔 `DRIFT_WINDOW_SPACING_S = 20s` 两窗残差差 > `10ms` ⇒ `unavailable(clock_drift)`（宁可拒答，不返回两端折中单值）；可用时长不足 `≈22s` 时 `drift_us = None`（照常 `ready`，标明短素材未取证限制）；双窗均取不齐 ⇒ `unavailable(window_too_short)`。

### 1.2 数据模型与 stale 语义（迁移 v36）

- **`angle_groups`** & **`angle_syncs`**：`angle_syncs` 含 `source ('auto'|'manual')`、`reference_fingerprint`、`asset_fingerprint`、`algorithm_version`、`status ('queued'|'running'|'ready'|'failed'|'unavailable')`。
- **部分唯一索引**：`idx_angle_syncs_ready ON angle_syncs(group_id, asset_id, algorithm_version, source, asset_fingerprint, reference_fingerprint) WHERE status IN ('ready','unavailable')`——素材变更写新行、旧行保留。
- **行选择与 stale 读时计算**：优先取未 stale 的 `source=manual`（人工偏移与自动行并列不覆盖），否则按 `algorithm_version` / `created_at` 降序取最新；任一侧指纹不符标 `stale`，素材不可用标 `unavailable(asset_not_available)`；素材改回原指纹自动恢复有效。
- **外键与删除**：`angle_syncs` 随 `angle_groups` CASCADE 删除；删除被引用素材返回 `ASSET_IN_USE`（文案：「素材被机位组引用」）。

---

## 2. W2.1 模块实现与接口

- **Core**：
  - `services/core/src/aivs_core/media/angle_sync.py`：纯函数 `envelope` / `measure_offset` / `window_pcm_args` / `decode_window` 与 `AngleSyncService`（建组 / 列组 / `group_summary` / `create_sync_job` 幂等短路 / `run_sync_job` / `write_manual_offset`）。
  - `jobs.py` 分派 `kind="angle_sync"`（light 档）；`app.py` 提供 `POST/GET .../angle-groups`、`POST .../sync`、`POST .../angles/{asset_id}/offset`。
- **Contracts & Desktop**：`JobKind` 增 `"angle_sync"`（`PROTOCOL_VERSION` 不动）；IPC 注册 5 个白名单通道；UI 入口为「工具菜单 → 机位同步」，面板以 `getJob` 终态轮询后刷新摘要（不落过渡行），Renderer 可见面不含本地路径。
- **测试矩阵**：`test_angle_sync_algorithm.py`（含精对齐短路负向对照）、`test_angle_sync_storage.py`（行选择与 stale 4 变体）、`test_angle_sync_api.py`（零 egress / 项目隔离）、`test_angle_sync_real.py`（真实 ffmpeg + 2×60s ≤ 30s 性能门）。

---

## 3. W2.2 说话人层降级交付契约（D3，长期态）

> 依据 [`ADR-0009`](../adr/0009-w22-diarization-closeout.md)，W2.2 因精度门未过（S3）且无可盲测素材，停在 D3 降级交付形态并冻结 W2.3 机位切换线。本节保留正在生效的下游准入硬约束。

### 3.1 机器可读标注定义（迁移 v38）

`speaker_diarizations` 每行与摘要 DTO 必须携带三条标注，不可静默缺省（历史行回填安全默认值）：

| 字段 | 当前交付态取值 | 语义 |
|---|---|---|
| `quality_status` | `'unvalidated'` | 未通过精度门显式声明 |
| `quality_basis` | `'gate:mean_le_0.40,worst_en_le_0.60,worst_cn_le_0.55'` | 判定依据门版本 |
| `usable_for` | `['reference']` | 仅可作参考；严禁包含 `'multicam_switch'` 或「部分可用」语义 |

### 3.2 下游 W2.3 准入硬约束（对应 `BACKLOG.md` `P132`）

1. **强制校验**：任何未来的 W2.3 机位切换规划器读 speaker turn 前必须校验 `quality_status == 'validated'`，非 `validated` 一律拒绝或降级为不切换（禁止写「可用低置信部分」类软约束——欠分割场 margin 失真已证无区分判据）。
2. **负向对照要求**：W2.3 立项与测试中必须包含「将标注改为 `validated` 则拒绝测试变红」的负向对照；在 `P132` 关闭且满足 `ADR-0009` §3 U1–U3 解冻条件前，不得开工消费 speaker turn。

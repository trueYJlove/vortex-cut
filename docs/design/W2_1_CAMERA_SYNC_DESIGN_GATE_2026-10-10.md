# W2.1 机位同步 —— Design Gate

> 依据：`W2_1_CAMERA_SYNC_PLANNING_GATE_2026-10-10.md`（**修订版**：§2.1 表结构 / §2.2 PCM 与精度口径 / §3 验收 / §5 D-1~D-3）。
> **共同冻结项不在本文件复述**（Rule 5）：数据模型、行选择规则、stale 语义、PCM 口径、精度口径一律以 Planning Gate 为准。
> 本文件只写**实施计划**：模块划分、函数签名、切片顺序、测试清单。实施：ZhangSan（Core）+ YeJing（契约/Desktop）；验收：LiuKeAi。

## 1. 模块划分（冻结）

| 层 | 文件 | 内容 |
|---|---|---|
| Core 算法（纯函数，可单测无需 DB） | `services/core/src/aivs_core/media/angle_sync.py` | `envelope` / `_xcorr` / `measure_offset` / `window_pcm_args` / `decode_window` |
| Core 服务 | 同上（`AngleSyncService`） | 建组 / 列组 / 摘要（行选择 + stale 读时计算）/ 登记作业 / 执行作业 / 人工偏移 |
| Core 存储 | `services/core/src/aivs_core/database_v36.py` + `database.py:MIGRATIONS` | 两张表 + 部分唯一索引 + CHECK（形状见 Planning Gate §2.1） |
| Core 作业 | `services/core/src/aivs_core/jobs.py` | `kind=angle_sync` 分派（light 档，与 `beat_analysis` 同型） |
| Core 路由 | `services/core/src/aivs_core/app.py` | 建组 / 列组 / 同步 / 摘要 / 人工偏移 |
| 契约 | `packages/contracts/src/index.ts` | `JobKind += angle_sync`；`AngleGroup` / `AngleSyncSummary` / `AngleSyncRow` + parse |
| Desktop IPC | `apps/desktop/electron/main/`（新 `w21-ipc.ts`）+ `preload` | `angle-sync:*` 四件套 |
| Desktop UI | `apps/desktop/src/app/`（`AngleSyncPanel`） | 素材箱多选入口 + 参考机位选择 + 偏移表 + 重算/手填 |

## 2. 关键函数签名（冻结，含评审要求的边界语义）

```python
# 纯函数（无 I/O，无 DB）
def envelope(pcm: np.ndarray) -> np.ndarray: ...
def measure_offset(ref: np.ndarray, mem: np.ndarray) -> dict[str, Any]:
    # -> {"status": "ready"|"unavailable", "reason": str|None, "offset_us": int|None,
    #     "confidence": float, "coarse_us": int|None, "dual_delta_us": int|None}
def window_pcm_args(input_path: str, start_s: float, duration_s: float) -> list[str]: ...
async def decode_window(ffmpeg, input_path, start_s, duration_s, cancel_event=None) -> np.ndarray: ...

# 服务
class AngleSyncService:
    def create_group(self, project_id, name, reference_asset_id, member_asset_ids) -> dict
    def list_groups(self, project_id) -> list[dict]
    def group_summary(self, project_id, group_id) -> dict      # 行选择 + stale 读时计算
    def create_sync_job(self, project_id, group_id) -> str | None   # None = 幂等短路
    async def run_sync_job(self, row, cancel_event, progress=None, stage=None) -> dict
    def write_manual_offset(self, project_id, group_id, asset_id, offset_us) -> dict
```

## 3. 实施切片

| 切片 | 内容 | 完成判据 |
|---|---|---|
| **S1a** | 算法纯函数 + 单测（两级精度、负偏移、0 真值、无关音频、通道退化、双窗一致性） | 纯函数测试全绿 + 「关掉精对齐必红」负向对照实测 |
| **S1b** | v36 迁移 + STATUS §1 `latest_migration` 同改 + 服务层（建组/摘要/作业/人工偏移） | 迁移测试 + 服务单测（含 stale 4 变体矩阵、幂等/重试） |
| **S1c** | Core 路由 + jobs 分派 + 集成测试（真实 wav 素材，含性能门 + 零 egress/无模型面断言） | 集成测试全绿；性能数据归档 |
| **S2** | 契约 + IPC + preload | 契约测试 + IPC 测试（渲染可见面无路径字段） |
| **S3** | Desktop 面板 | 组件测试（手动偏移、状态如实展示） |
| **S4** | e2e + 真实素材核对（D-2 共同声音事件） | 真实素材未到位则显式标「未取证」 |

## 4. 测试清单（映射 Planning Gate §3 验收）

| 测试 | 覆盖验收 |
|---|---|
| `test_angle_sync_algorithm.py`：合成 fixture 两级容差、负值、0、边界（重叠 29.5s）、无关音频 → unavailable、通道退化仍 ready、双窗不一致 → unavailable、确定性、**精对齐短路负向对照** | 1 / 2 / 5 |
| `test_angle_sync_storage.py`（服务层）：建组 / 行选择（manual 优先 + 版本时间降序）/ stale 4 变体 / 幂等短路 / 指纹变化后新行 / failed 允许重试 / 人工偏移并列且带时间戳 | 3 / 4 / 8 |
| `test_angle_sync_api.py`（路由）：401 / 跨项目 404 / 非视频素材拒绝 / 同步登记 / 摘要形状（键齐全、无路径字段）/ 零 egress + 无模型面 | 6 |
| `test_angle_sync_real.py`（真实 ffmpeg）：两段真实 wav 平移已知偏移 → 端到端 offset 与容差；性能计时（环境口径记录） | 1 / 7 |

## 5. 实施修订（S2/S3，2026-10-10）

- **UI 入口改为「工具菜单 → 机位同步」+ 面板内选择参考/成员**（原设计写「素材箱多选」）：素材箱的选中态同时驱动属性面板与拖拽，改成多选会牵连既有交互；面板内选择语义等价且隔离风险。素材箱多选入口留作后续按需追加。
- **IPC 白名单冻结**：新增 5 个通道（groups/create/get/sync/offset），`stage2b-ipc.test.ts` 的「只注册冻结白名单」断言同步扩张（这是既有的契约锁，必须同改）。
- **过渡行不落库（S3 实施修订）**：Core 只落「完成行」，作业在飞时面板看不到 pending 状态。面板改为**以 jobs 行终态为轮询依据**（`getJob` 轮询 → 终态后刷新摘要），行级 queued/running 轮询作为将来的兜底保留。理由：避免过渡行残留导致 pending 卡死，且作业进度本就以 jobs 行为权威。

## 6. 实施中必须回写的文档（纪律）

- v36 落地 → **同改 `docs/STATUS.md` §1 `latest_migration` 35 → 36**（否则一致性测试红）；
- 每个切片完成 → 在 `W2_1_CAMERA_SYNC_IMPLEMENTATION_2026-10-10.md` 记「验收逐项对照表」（AGENTS.md Rule 3：无对照表不算闭环）；
- P81–P86 核销 → 各附证据与日期；R5 的性能数据在 S1c 归档后核销。

## 7. 开放项

- 真实多机位素材（D5）——阻塞 S4 取证，不阻塞 S1–S3；
- 漂移 fixture 判定口径（分段表 vs unavailable）在 S1a 实测后定稿并回写。

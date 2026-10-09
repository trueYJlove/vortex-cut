# P4 真实 provider 扩展指令会话取证（2026-10-09）

> **点时间记录**：本次真实 provider 调用的取证快照。现状以 `docs/STATUS.md` 为准。

## 1. 验收项

`AI_WHITELIST_EXPANSION_PLANNING_GATE_2026-09-22.md` §3.2：

> **集成**：真实 deepseek（复用验证脚本）实验 C 扩展指令（"剪短并加一个转场"）跑通两步会话。

原登记为 `docs/STATUS.md` §4 承诺 P4「❓ 仓内无证据」——`AI_VALIDATION_REPORT_2026-09-20.md`
实验 C 两模型均为 **1 步**且用的是**单动作指令**（"把视频剪短一点，保留最精彩的部分"）。

## 2. 本次运行

- 驱动：`tools/validation/run_validation.py`（复用验证脚本；本次新增 `--instruction` 参数，
  缺省值保持原指令不变，不影响既有取证）。
- 指令：**「剪短并加一个转场」**（扩展指令，点名的验收指令）。
- 素材：`刘可艾 小花猫舞蹈视频.mp4`（dance，1920×1080 50fps H.264 168s/709MB）。
- 隔离：`--data-dir .validation/`（独立 sidecar + 独立库）。
- **真实 provider**：`https://api.xkiro.com/v1`，模型 **`xiaomi/mimo-v2.6-pro`**
  （`AIVS_REAL_PROVIDER_*` 注册表配置；`AIVS_REAL_PROVIDER_ENABLED=1` 以进程级 opt-in，
  注册表仍为 0 未改动）。

## 3. 结果

**会话 succeeded**（`revision_33ab7729…`，2026-10-09T15:10:30Z）：

```
agent step 1: 将单段视频剪短至约75%时长，在中点切开并添加0.5秒叠化转场
```

| 项 | 值 |
|---|---|
| 步数 | **1**（`provider_invocations` 中 `agent_session_planning` 行数 = 1，"行数 = 步数"不变量成立） |
| 产出 op | **3**：`trim_clip`（168s → 126s ≈ 75%）+ `split_clip`（中点 63s）+ **`add_transition`**（dissolve 0.5s） |
| 白名单校验 | `apply_in_memory(ai=True)` 通过（含本次晋升的 `add_transition`） |
| 落盘 | 真实 Revision：clips **2**、transitions **1**（`kind=dissolve, duration_us=500000`） |
| 能力探测 | `candidate = supported`、`patch = supported` |
| 会话墙钟 | 40.7s（单次 provider 调用） |

同批附带（非 P4 范围）：实验 A（dance CV 分析）16.8s/168 采样 succeeded；
实验 B（三候选）按已知探测门槛拦截（`PROVIDER_SCHEMA_MISMATCH: 候选时长无效`，
与 `AI_VALIDATION_REPORT_2026-09-20.md` 实验 B 的既有记录一致）。

## 4. 两处偏离（需 LiuWei 裁决）

**① 模型偏离**：验收点名「真实 **deepseek**」，但 `AIVS_REAL_PROVIDER_*` 注册表配置现已指向
`xiaomi/mimo-v2.6-pro`（gateway `api.xkiro.com`）——历史 deepseek 配置（`apikey.fun` /
`deepseek-v4.1-flash`）已被覆盖，仓内无从复跑 deepseek。本库中确实存在 2026-09-20/21 的
`deepseek-v4.1-flash` 真实调用记录（见 `.validation/app.db` 的 `provider_invocations`），
但用的是**单动作指令**。若必须 deepseek 复跑，需要你恢复该配置。

**②「两步会话」与实现的收束判定不一致**：`agent_session.py` 的收束判定是「**成功步即会话成功**」
（失败步 `continue` 带反馈重试，`break` 于首个成功步），因此**多步只会出现在失败→反馈→重试路径**
（AI-1 单测 C1 正是该路径）。而「剪短并加一个转场」这类两动作指令，模型会把多个 op 合并进
**一次** patch（本次 3 op / 1 步）——所以**用点名指令无法稳定产生 2 步**：本跑 1 步即成。
换言之，「两步会话」若指 2 次 provider 调用，它依赖模型首步失手，非确定性；若指「两动作指令
一次会话跑通」，本次已达成。

## 5. 结论

**实质验收已达成**：晋升白名单 op（`add_transition`、`split_clip`）经真实 provider 端到端可用
——模型产出合法 patch → 白名单校验通过 → 落真实 Revision。**步数口径待裁决**（见 §4②）。
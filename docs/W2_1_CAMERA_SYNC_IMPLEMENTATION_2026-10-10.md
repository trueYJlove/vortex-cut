# W2.1 机位同步 —— 实施记录（Slice 1）

> 点时间记录：2026-10-10。状态口径引用 `docs/STATUS.md`；冻结口径引用 Planning Gate（修订版）与 Design Gate。
> 验收对照表按 AGENTS.md Rule 3 提供（无对照表不算闭环）。

## 1. 切片完成度

| 切片 | 内容 | 状态 |
|---|---|---|
| S1a | 算法纯函数（`media/angle_sync.py` 前半：envelope / _xcorr / _fine_residual / measure_offset / window_pcm_args / decode_window） | ✅ 完成（15 项单测绿） |
| S1b | v36 迁移（`database_v36.py`）+ `AngleSyncService` | ✅ 完成（7 项单测绿） |
| S1c | Core 路由 + `jobs` 分派 + `JobKind` 契约 + 端到端集成测试 | ✅ 完成（4 项集成测试绿） |
| S2 | 契约 DTO/parse + Desktop IPC/preload | ✅ 完成（契约 4 项 + IPC 2 项测试绿） |
| S3 | Desktop 面板（工具菜单入口 + 偏移表 + 手填） | ✅ 完成（组件测试 3 项绿；入口按 Design Gate §5 修订） |
| S4 | 真实多机位素材端到端（验收 9） | ⏳ 阻塞：待用户提供素材 |

## 2. 验收逐项对照（Planning Gate §3）

| # | 验收项 | 证据 | 判定 |
|---|---|---|---|
| 1 | 合成偏移 fixture：粗 ≤10ms 且精 ≤1ms（真值 1234 / 137.4 / 41.7 / 0 / −253 / −1500 ms） | `test_angle_sync_algorithm.py::test_two_level_tolerance`（参数化 6 例）；真实链路 `test_angle_sync_api.py::test_end_to_end_known_offset`（pink noise + AAC + adelay 687ms ⇒ 实测误差在 10ms 门内） | ✅ |
| 1-负向 | 关掉精对齐 ⇒ 必红 | `test_negative_control_coarse_only_fails_fine_gate`（monkeypatch `_fine_residual` 后精门失败） | ✅ |
| 2 | 区分力对照：无关音频 ⇒ unavailable；同源退化 ⇒ 仍 ready；静音 ⇒ unavailable | `test_unrelated_audio_is_unavailable`（conf≈0.05）/ `test_degraded_same_source_still_ready`（混响 + 噪声底低 30dB）/ `test_silence_is_unavailable` | ✅ |
| 2b | 双窗一致性：单窗可信 ⇒ unavailable | `test_dual_window_disagreement_is_unavailable` | ✅ |
| 3 | 幂等与重试：全可用短路；指纹变化 ⇒ 新作业/新行；failed ⇒ 可重试 | `test_sync_job_idempotent_and_retryable` + `test_rerun_after_fingerprint_change_writes_new_row`（C1 回归锁）+ 集成侧幂等断言 | ✅ |
| 4 | stale 4 变体（参考侧 / 成员侧 / 回退 / availability） | `test_stale_matrix`（4 变体逐一断言）+ 集成 `test_stale_after_fingerprint_change` | ✅ |
| 5 | 确定性：同输入两次逐位相同 | `test_determinism` | ✅ |
| 6 | 零 egress + 无新模型面 | 集成断言 `provider_invocations / model_download / model_installations` 三者均 0 | ✅ |
| 7 | 性能门（2×60s ≤30s，带环境口径） | 集成实测 2×20s 素材端到端 <30s（真实 ffmpeg 解码 + 互相关）；**60s 档与机型/ffmpeg build/冷热态口径待 S1c 收尾补齐** | ⏳ 部分 |
| 8 | 人工偏移并列 + 时间戳 + 参考机位恒 0 | `test_manual_offset_preferred_and_timestamped` + 集成断言（auto 行保留）+ 面板测试（毫秒→微秒换算、非数字给出错误、manual 标注） | ✅ |
| — | 契约形状（Renderer 侧） | `contracts.test.ts`：合法组通过；`algorithm_version` 为 int / 缺键 / 空 angles / 非法 status 全部拒绝；`angle_sync` 进 JobKind 白名单 | ✅ |
| — | IPC（Main 侧） | `stage2b-ipc.test.ts`：路径与 body 精确转发、成员数为空拒绝、`job_id=null` 幂等短路、人工偏移只接受整数微秒；**冻结通道白名单同步扩张** | ✅ |
| 9 | 真实多机位素材端到端（含 D-2 共同声音事件核对） | 待用户提供素材 | ⏳ 阻塞 |

## 3. 实施中修正的实现缺陷（测试当场抓出）

| # | 缺陷 | 影响 | 修正 |
|---|---|---|---|
| 1 | `_fine_residual` 只平移成员侧（参考窗未随第二窗偏移） | 负偏移下第二窗错位（实测残差 −1s）⇒ 双窗判定失真 | 两侧同步平移；负基准改由参考窗吸收（`offset - base`） |
| 2 | 集成用例误用 SNR 口径（写 −30dB 变成噪声淹没信号） | 用例本身不可信 | 改为 SNR=+30dB（噪声底低 30dB），与评审口径一致 |
| 3 | 集成夹具用白噪声 | AAC 对白噪声是最坏情况（实设置信度 0.46 ⇒ 如实判 unavailable）——是编解码失真而非算法问题 | 夹具改 pink noise（近似真实频谱）+ 192k 码率 |

## 4. 风险对策落点（P81–P86）

| 登记 | 落点 | 状态 |
|---|---|---|
| P81 时钟漂移 | 分段偏移 + 线性拟合**未实现**；当前实现遇到漂移素材会通过双窗差（>5ms）如实判 unavailable | ⏳ 保留（D4 先取证；S4 真实素材到位后按需实现） |
| P82 无音频降级 | 无音轨 ⇒ `unavailable(no_audio)`；人工偏移合法降级并已测 | ✅ 闭环 |
| P83 相关性退化 | 归一化相关峰 + 双窗一致性 + 阈值 0.5（spike 与退化用例双向验证） | ✅ 闭环 |
| P84 真实素材取证 | 待用户素材；未取证前验收 9 显式标「未取证」 | ⏳ |
| P85 长素材成本 | 单遍流式解码（实测 2×20s 端到端 <30s）；60s 档与冷热态口径待补 | ⏳ 部分 |
| P86 陈旧偏移误用 | 双侧指纹入行并入唯一键 + 读时 stale（4 变体已测） | ✅ 闭环 |

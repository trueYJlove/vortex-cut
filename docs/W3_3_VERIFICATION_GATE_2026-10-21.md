# W3.3 Verification Gate 记录 · 关键帧理解（Layer 2）

> **日期**：2026-10-21
> **范围**：规划门 A1–A14 + 设计门 S1a/S1b/S2/S2b/S3/S4/S5a/S5b
> **结论**：**有条件通过** —— A1–A14 全部有实现与机器判据；**A9（人工盲评）保持开放**，见 §5。
> **裁定**：本轮由调度方独立复核，非执行者自检转述。

---

## 1. 触发本次收口的起因

W3.3 六个切片在**测试层面**均已交付并被标记 ✅。收口盘点做**生产链路走查**时发现：

- 写入链路断成四截（`create` 不建作业 / runner 未接线 / 调度策略未登记 / `provider_invocations` 从不写入）；
- 素材删除缺陷（做过关键帧预览的素材永删不掉，P102 原样重演）；
- **A4 与 A9 是零实现**，不是「没通过」——全仓 grep `vision-capability` 与措辞正则均零命中。

其中第三条是本门最该记住的：**两个验收项在文档里被引用、在测试里不存在**，
而回归全绿放行了它们。这与 P65/P149 记录的失败模式同型：**声明与证据脱节，且无人复算**。

---

## 2. A1–A14 逐项落点

| 项 | 判据落点 | 证据（文件 / 用例） | 结论 |
|---|---|---|---|
| **A1** 逐张可见 + 可移除 | `keyframe_egress.exclude_frames` 重算哈希 | `test_keyframe_egress.py`：移除改变 payload 哈希、只增不改、未知序号拒绝 | ✅ |
| **A2** 未同意不发（I-1） | `claim_for_runner` 是唯一放行点 | 探测路径同样先 claim；伪造 claim dict 被拒（回库验 `consumed_at`） | ✅ |
| **A3** payload 可复算（I-2） | 哈希由**磁盘真实字节**算，含帧序号 | `test_exclude_changes_payload_hash` + 同参两次同哈希 | ✅ |
| **A4** 能力探测 fail-closed | 六列落库 + `create` 内门禁 | `test_vision_probe.py` **26 项**；三条零外传判据见 §3 | ✅ |
| **A5** 抽帧策略 | 三种切点语义不合并（`None`/`[]`/`[t…]`） | `test_keyframe_sampling.py` 29 项 | ✅ |
| **A6** 帧规格与成本可见 | 实测 768 长边、q85、实测字节 | `test_keyframe_encode.py` 16 项 | ✅ |
| **A7** 词表 + 备注 | 词表外改道 notes、计数、版本入行 | `test_keyframe_tagging.py`：改道 / 不阻断落库 / 违规计数 | ✅ |
| **A8** 契约增量锁 | `JobKind` 三处同步 | `test_keyframe_contracts.py` 解析集合并断言**完全相等** | ✅ |
| **A9** 质量口径诚实 | ① 预登记先于看数 ② 优越性表述正则负向检查 | `PRE_REGISTRATION.md`（08:xx 落盘、无评分数据）+ `test_keyframe_wording.py` 6 项 | ⚠️ **口径达标，评分开放**（§5） |
| **A10** 打标端到端 | 真实网关 + 落库 + `provider_invocations` 行数=调用数 | S3 记录（真实网关）；`test_keyframe_tagging.py`：1 帧撞顶 ⇒ 2 行、状态 `['failed','succeeded']` | ✅ |
| **A11** 素材生命周期 | CASCADE + stale + 指纹同源 | `test_frame_tags.py` 11 项；素材删除后计数返回 `None` 而非 0 | ✅ |
| **A12** 审计保真 | 载荷与缩略图两套字节、逐帧等于外传字节 | `test_keyframe_egress.py`：尺寸/字节/哈希三者皆不同 | ✅ |
| **A13** 打包后编码可用 | **PyInstaller 产物内**实跑 | `evidence/2026-10-21-w33-a13-packaged/`，见 §4 | ✅ |
| **A14** 载荷到期清理 | 独立目录、单一清理者 | 到期后目录字节 0 而 `frames_json` 哈希仍在；幂等 | ✅ |

---

## 3. A4 的三条「零字节外传」机器判据

A4 的「此后 create 被拒且**零字节外传**」原先只在**外层服务**成立，生产路由直调 `egress.create` 可绕过。
门禁已下沉至 `KeyframeEgressService.create`，且在**写 consent 行之前**拒绝。三条判据：

1. **网络调用计数不变**（外传的物理判据）；
2. **`keyframe_egress_consents` 行数不变**（「零外传」还包括不签同意书）；
3. **`keyframe_generations` 行数不变**。

`allow_unprobed`（探测自举）的正当性由两条机器判据守住，非注释声明：
- 请求模型 `KeyframeCreateRequest.model_fields` 恰好 `{payload_sha256}` + `extra=forbid` + 路由体不含该字样；
- **AST 遍历全 `src`**：`allow_unprobed=True` 调用点恰好 1 个且来自 `vision_probe.py`。

**调度方独立验证**：注入第二个调用点后守卫精确报出
`['keyframe_orchestration.py:117', 'vision_probe.py:288']` ⇒ 恢复后绿。该守卫有真实区分力。

---

## 4. A13 打包产物取证（摘要）

详见 `evidence/2026-10-21-w33-a13-packaged/EVIDENCE.md`。要点：

- 在 `git archive HEAD` 的**干净导出**中构建（避免打到并行改动中的树）；
- 产物内 `ffmpeg/win-x64/ffmpeg.exe` sha256 `a9eb7fb2…`，**与 `components.json` 的 pin 逐位相同**；
- 产物内 `-encoders` 共 **237 行**，第 **77** 行 ` VFS..D mjpeg  MJPEG (Motion JPEG)`；
- 用该二进制按生产 `jpeg_args` 实编：3 夹具 × 2 时间点全部 768×432、SOI/EOI 合法；
- 解码路径：视频 NV12 5 帧 = 1,728,000 B 精确相等、PNG IHDR 一致、音频 PCM 3.008 s / 2.005 s。

**边界如实**：证据里「产物内 vs 源码树字节相同」区分力有限（同一份二进制），
真正的区分力来自 sha256==pin 与实跑 `-encoders`。未打 NSIS、未跑 Electron 端到端。

---

## 5. A9 保持开放（本门唯一的未闭环项）

**已达标的是「口径诚实」**：
- `PRE_REGISTRATION.md` 在任何评分数据之前落盘，冻结抽样规则、三档判定、统计口径与结论上限；
- 优越性表述的正则负向检查已实现（6 项，含 5 条防恒真自检）。

**未达标的是「评分」**：打标质量**没有客观真值**（与 W2.2 有 RTTM 标注不同），
必须人工盲评。在本项关闭前，门与本记录**均不得出现任何「打标质量更好/优于」的表述**——由正则锁钉死。

**关闭条件**：用户完成盲评并回填 `evidence/2026-10-21-w33-keyframe-blind-eval/` 的评分表。

---

## 6. 收口修复的独立复核（调度方亲手跑，非转述）

| 复核 | 结果 |
|---|---|
| 关键帧 9 套件 | 134 passed |
| **删掉 `delete_asset` 的 detach 调用** | 1 failed / 3 passed，红的是 P102 原样复现 `ASSET_IN_USE`；恢复后 4 passed |
| 桌面「确认外传」改回 `onClose`（缺陷原形） | 7 failed / 8 passed；恢复后 15 passed |
| 桌面全量 | 903 passed / 106 files；lint 通过 |
| A4/A9/删除清单三套件 | 32 passed |
| **A9 注入一句裸优越性断言**（措辞按判据构造，此处不复述以免自触发） | 1 failed / 6 passed，精确报 `W3_3_S2_IMPLEMENTATION:119`；恢复后 7 passed |
| **注入第二个 `allow_unprobed=True`** | AST 守卫精确报出两个调用点；恢复后绿 |

---

## 7. 本轮新增/关闭的登记

见 `docs/STATUS.md` §4 **P179–P183**；§1 `latest_migration` 40 → **41**（v41 vision 六列）。

---

## 8. 遗留（如实，勿引用为已解）

1. `generation_status` 用 `input_json LIKE` 关联作业行，非外键（id 空间不冲突，实际不误配）。
2. `POST /providers/{id}/vision-capability` 需 `project_id` query 参数——设计门未规定，属实现下沉细节。
3. **A13 未覆盖安装器级**（未打 NSIS、未跑 Electron 端到端）——本记录只证 PyInstaller 产物。
4. `VisionProbeService.create_generation` 与 `egress.create` 门禁重复，须同步演进。

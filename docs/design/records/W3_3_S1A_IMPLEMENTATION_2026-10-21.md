# W3.3 S1a 实施记录 · 关键帧 JPEG 编码

> **切片**：S1a（Design Gate §7 首切片，**纯本地、零 egress**）
> **上游**：规划门（已批准）D7/D8 / Design Gate（已批准）§3.1、§8
> **日期**：2026-10-21
> **验收归属**：本文的 A6/A13 结果由 **`W3_3_VERIFICATION_GATE_2026-10-21.md`** 汇总复核；A13 的打包产物证据见 `evidence/2026-10-21-w33-a13-packaged/EVIDENCE.md`。

---

## 1. 交付

| 文件 | 行数 | 作用 |
|---|---|---|
| `services/core/src/aivs_core/media/keyframe_encode.py` | 233 | 单帧 → JPEG 载荷 + 缩略图两套字节；JPEG 尺寸自解析；批量编码 |
| `services/core/tests/unit/test_keyframe_encode.py` | 216 | 16 项测试（含 3 组负向对照） |

**未做的事（切片边界）**：抽样决策（S1b）、数据库（S2）、网络（S3/S4）。

---

## 2. 验收核对（Design Gate §7 映射：S1a → A6、A13）

| 验收 | 判据 | 结果 |
|---|---|---|
| **A6** 帧规格与成本可见 | 长边 768、JPEG q85(q:v 3)、呈现**实测**字节 | ✅ 实测横屏 `768x432`、竖屏 `432x768`；见 §3 实测表 |
| **A13** 打包后编码可用 | 打包产物内 ffmpeg 编码成功 | ⚠️ **部分**：源码树的随包 ffmpeg 已实测通过；**打包产物内尚未验**（需构建 release，本轮未做）——如实标注，不冒充完成 |

### A12 的前置（本切片只做了一半，另一半在 S2）

Design Gate 把 A12（审计保真）挂在 S2，但它的**前提**是「缩略图 ≠ 载荷」这对字节必须由 S1a 产出。本切片已实现并锁定：

```
payload  768x432  18171 B   ← 将外传
thumbnail 192x108   2856 B   ← 仅展示（小 6.4×）
```

**若两者相同，用户审阅的就是错的**（规划门 §3.2）。测试 `test_thumbnail_differs_from_payload` 断言尺寸、字节、哈希三者皆不同。

---

## 3. 实测数字（经**生产代码**跑出，非另行脚本）

| 输入素材 | 载荷尺寸 | 载荷字节 | 缩略图尺寸 | 缩略图字节 |
|---|---|---|---|---|
| 1920×1080 | 768×432 | 18,171 B | 192×108 | 2,856 B |
| 1280×720 | 768×432 | 17,557 B | 192×108 | 2,848 B |
| 1080×1920（竖屏） | 432×768 | 21,681 B | 108×192 | 3,537 B |

**24 帧外传合计 ≈ 0.56 MiB/素材**（按 1920×1080 口径）。

> **与 Design Gate §0.12 的关系**：门里记的是「24–30 KB/帧」（来自 `-q:v 3` 直出 testsrc 单帧 24,411 B），本表是**经生产代码 + 编码后重新读取**的 17.6–21.7 KB。差异来自素材内容与编码器路径，**两者都远低于门里更早的「数 MB」高估**。以本表为准（它是生产路径的真实产物）。

---

## 4. 负向对照（**实跑，不是断言式声明**）

按 Design Gate §8「还原实现即红」的要求，逐条临时改坏生产代码再跑同一套测试：

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **NC1** | 把缩略图赋成载荷本身（破坏 A12 前提） | **1 failed**, 15 passed |
| **NC2** | 忽略 `long_edge` 参数、固定 320（破坏 A6） | **4 failed**, 12 passed |
| **NC3** | 哈希算在 `payload + b"x"` 上（破坏 A3 前置） | **1 failed**, 15 passed |

三组均**精准变红**且失败数与其影响面相符（NC2 影响全部尺寸断言 ⇒ 4 项），恢复后 **16 passed**。

---

## 5. 测试清单（16 项）

| 组 | 用例 | 覆盖 |
|---|---|---|
| argv 形状 | `test_jpeg_args_pins_long_edge_and_quality` | D8 两个用户裁决值不得被改 |
| | `test_jpeg_args_rejects_negative_timestamp` | 非法输入 |
| | `test_jpeg_args_seeks_before_input_for_speed` | `-ss` 在 `-i` 前（性能回归） |
| JPEG 解析 | `test_jpeg_dimensions_reads_sof` | 自解析 SOF 取尺寸 |
| | `test_jpeg_dimensions_rejects_non_jpeg` | 非 JPEG / 无 SOF 均拒绝**不编造尺寸** |
| A6 规格 | `test_encode_frame_hits_768_long_edge` | 横屏长边=768 |
| | `test_encode_frame_portrait_pins_long_edge_on_height` | **竖屏长边在高**（只按宽缩放会红） |
| A3 前置 | `test_payload_is_valid_jpeg_and_hashed` | SOI/EOI + 哈希来自真实字节 |
| **A12 前提** | `test_thumbnail_differs_from_payload` | 两套字节尺寸/内容/哈希皆不同 |
| 确定性 | `test_reencoding_is_deterministic` | 同参两次同哈希 |
| 批量 | `test_encode_frames_preserves_plan_order_and_reasons` | 顺序与来源标记保真 |
| | `test_encode_frames_honours_cancel` | 取消按帧粒度 |
| fail-closed | `test_encode_frame_fails_closed_on_missing_input` | 缺素材抛错，不返回空字节 |
| 元数据 | `test_to_meta_carries_both_byte_sets` | 两套都进元数据，**字节本身不进** |
| | `test_total_payload_bytes_measures_payload_not_thumbnail` | 合计只算载荷 |
| 常量 | `test_max_frames_matches_planning_gate_d7` | 封顶 24 与门一致 |

---

## 6. 实现中的两个坑（供后续复用）

### 6.1 随包 ffmpeg **没有 libx264**

首版测试用 `-c:v libx264` 合成素材，直接失败：`Unknown encoder 'libx264'`。实测 `-encoders` 中只有 `libopenh264`（及硬件 h264_* 系列）。

**这不是本切片的缺陷**（生产代码只做**解码 → mjpeg 编码**，与 x264 无关），但它是**测试夹具**的必要知识——后续任何需要合成 H.264 素材的测试都必须用 `libopenh264`。

### 6.2 pytest-asyncio 只在 `.venv` 中可用

系统 `python` 是 3.13 且**未装** `pytest-asyncio`（`pyproject.toml` 的 `asyncio_mode` 被报为未知配置项）。必须用 `.venv/Scripts/python.exe -m pytest`。

**附带发现**：在事件循环内再调 `asyncio.run` 会报 `cannot be called from a running event loop`——本文件的夹具辅助函数因此全部改成 `async` 并在测试内 `await`。

---

## 7. 质量门

| 项 | 结果 |
|---|---|
| `pytest test_keyframe_encode.py` | **16 passed** |
| `ruff check`（生产 + 测试） | **All checks passed** |
| `pyright`（生产模块） | **0 errors, 0 warnings** |
| 恢复后复跑 | 16 passed（负向对照未留残留） |

---

## 8. 未完成 / 移交下一片

| 项 | 归属 |
|---|---|
| **A13 的打包产物验证**（构建 release 后在产物内实跑编码） | 待构建；本轮只证源码树 |
| 抽样决策（切点优先/间隔兜底/封顶/降级） | **S1b** |
| `payload_sha256` 的集合级复算（含编码参数绑定） | **S2** |
| 独立缓存目录 `data/keyframe-cache/` 与 `purge_expired` | **S2** |

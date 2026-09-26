# H2 A 路径 HEVC demux——实施记录

> 实施：2026-09-26（与 H3 并行）。规划门：`MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md`
> §3 H2。对应 P31（主流 MP4 范围）。

## 0. 范围

| 包 | 内容 | 验收 |
|---|---|---|
| **H2** | `bmff-demux` 支持 `hev1`/`hvc1` + `hvcC`；codec string 交给 `VideoDecoder` | 平台支持时 HEVC 合成预览可播（与剪映同等） |

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `bmff-demux.ts` | 接受 avc1/hev1/hvc1；hev1/hvc1 解析 hvcC；`avcC`→`description`；导出 `buildHevcCodecString` |
| `decode-worker.worker.ts` / `filmstrip-worker.ts` | 消费 `description`（原 `.avcC`） |
| `tests/bmff-demux.test.ts` | HEVC 手工 moov 用例（hvc1/hev1、codec string、bit reverse、非法 hvcC） |

## 2. codec string（ISO 14496-15 E.3）

- 前缀 = 采样入口 4CC（`hvc1.` / `hev1.`）
- profile_space 1/2/3 → 字母 A/B/C + profile_idc 十进制
- `general_profile_compatibility_flags` **reverseBits32** 后 hex（去前导零）
- `L|H` + level_idc
- 约束 6 字节逐字节 hex、点分隔、**尾部**零字节省略
- 示例：`hvc1.1.6.L120.B0`（compat `0x60000000` → reverse `6`）

## 3. 验收核对表（H2）

| # | H2 验收 | 结果 | 证据 |
|---|---|---|---|
| 1 | hev1/hvc1 + hvcC 解析 | ✅ | 手工 moov 测试；description = hvcC payload |
| 2 | codec string 交 VideoDecoder | ✅ | `buildHevcCodecString` + decode-worker 配置 |
| 3 | 主流 MP4 仅此范围 | ✅ | moof 仍 `BMFF_FRAGMENTED`；未知入口 `BMFF_CODEC_UNSUPPORTED` |
| 4 | AVC 回归 | ✅ | bmff 15 + 合并后相关 57 绿；filmstrip/preview 42 绿 |
| 5 | 平台支持时可播 | ⏳ **真机** | 需 Electron + 系统 HEVC 解码实测（与 H3 汇合后端到端） |

## 4. 遗留

| 项 | 归属 |
|---|---|
| 真机 HEVC 合成预览端到端（H2+H3+preview-session 接线） | H3 收口 / 门验收 |
| 异常容器强制 B 后端 | 工厂已可选 B；接线后生效 |
| hvcC profile 与实配错位时 configure 失败回写 | P28（H1 工厂已失败落次选） |

## 5. 测试

- `tests/bmff-demux.test.ts` 15 passed
- 合并 H3 后相关套件 57 passed；preview/filmstrip 42 passed
- desktop typecheck 绿

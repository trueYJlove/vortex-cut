# M3-0-3 独立验收包（LiuKeAi）

> 验收对象：[M3-0 技术验证报告](./STAGE_M3_0_TECH_VALIDATION_REPORT.md) + [ADR-1](./STAGE_M3_0_ADR_1_P2_GATE.md) + [IR 契约冻结草案 v0.1](./STAGE_M3_0_IR_CONTRACT_DRAFT.md) + [M3 立项建议草案](./STAGE_M3_0_M3_INITIATION_RECOMMENDATION.md)
> 验收人：LiuKeAi（独立）　执行环境：本仓库 `uiux-polish-round3` 分支 @ `739dff3` 之后的验收基线 commit
> 依据：冻结方案 §11（M3-0-3）

## 1. 复跑说明（统计量独立复算）

前置条件：Windows + 仓库根 `.venv`（Python 3.13 + numpy）+ `resources/ffmpeg/win-x64/ffmpeg.exe`；素材与基准二进制在 `evidence/m3_0/`（本地留存，见 `sha256_manifest.json`——**先核对 SHA-256**）。

### 1.1 P2 统计量复算（存档输入，无需 Electron）

```powershell
# ① 基线完整性核对（对照 baseline_manifest.json 的 SHA-256）
.venv/Scripts/python.exe -c "import json,sys; sys.path.insert(0,'tools/m3_0'); from common import sha256_file; from pathlib import Path; m=json.load(open('evidence/m3_0/p2/baseline/baseline_manifest.json',encoding='utf-8')); print(all(sha256_file(Path(v['path']))==v['sha256'] for k,v in m.items() if k=='baseline_mkv'))"

# ② 逐帧比对复算（PSNR/SSIM/相位相关/字幕 IoU/判定）——应复现 comparison.json
.venv/Scripts/python.exe tools/m3_0/compare_tool.py frames --ir evidence/m3_0/p2/ir.json --gl evidence/m3_0/p2/baseline/gl --base evidence/m3_0/p2/baseline/frames/base --gl-nocap evidence/m3_0/p2/baseline/gl_nocap --base-nocap evidence/m3_0/p2/baseline/frames/base_nocap --ref evidence/m3_0/p2/baseline/frames/second_ref --order evidence/m3_0/p2/sample_frames.json --out <复算输出>.json
# 判定：与 evidence/m3_0/p2/baseline/comparison.json 逐帧一致（psnr/shift/IoU 全等）

# ③ 第 0 步自校准复算
.venv/Scripts/python.exe tools/m3_0/compare_tool.py step0 --cal evidence/m3_0/p2/step0_calibration --gl evidence/m3_0/p2/step0_calibration/gl --out <复算输出>.json
# 判定：deterministic=true；601/709 失配 ≈27.82dB；GL 底噪 31.4–38.6dB

# ④ IR 数值表独立核对（任选抽点：转场 p 值、变速段 src_n、内容时间原点、PiP 内容盒）
.venv/Scripts/python.exe -c "import json; ir=json.load(open('evidence/m3_0/p2/ir.json',encoding='utf-8')); print(json.dumps(ir['frames'][585],indent=1))"
# 判定基准：n=585 转场 p=0.5；n=630 B 段 src_n=48（0.8× 借用式）；n=1649 C 段 src_n=299；PiP1 盒 (504,68,336,188)
```

### 1.2 P3 统计量复算（存档输入复跑）

P3 的 100 目标由固定种子（`P3_SEED=20260905`，`common/stats.ts` mulberry32）生成——复算路径：
1. 核对 `p3/m3p3_result.json` 各路 `samples[].target_frame` 与种子复算序列一致；
2. 统计量（p50/p95/max/失败/PTS 偏差/黑帧）由 `latency_ms_all` 等汇总字段直接复算核对；
3. 存档输入 = 素材文件（SHA-256 已入库）；live 复跑命令：`tools/m3_0/run_electron_probe.py m3p3 --ir evidence/m3_0/p2/ir.json --evidence <目录>`（见 §2）。

### 1.3 P1 复跑见证（报告制验收 + 一次现场见证）

P1 接受"报告证据 + 原始数据 + 一次可复跑见证"（§11）。见证步骤：
1. 显示器切 60Hz：`powershell -NoProfile -ExecutionPolicy Bypass -File tools/m3_0/set_hz.ps1 -TargetHz 60`（应输出 `current: ... @ 60Hz`）；
2. `.venv/Scripts/python.exe tools/m3_0/run_electron_probe.py m3p1 --ir evidence/m3_0/p2/ir.json --evidence evidence/m3_0/p1_60hz_witness`
3. 判定（对照报告 §1.2）：循环间隔 p95 ≤ 33ms；掉帧率三轮中位 0%、最差 < 1%；任务 p95 ≪ 33.3ms；
4. 跑完恢复 75Hz：`tools/m3_0/set_hz.ps1 -TargetHz 75`。

### 1.4 验收检查清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 证据 SHA-256 核对 | `sha256_manifest.json` 全部命中 |
| 2 | P2 复算一致 | comparison.json 逐帧复现 |
| 3 | ADR-1 修订口径逐条核对 | 报告 §2.6 / ADR §3 五条全部满足 |
| 4 | IR 草案红线 | 冻结子集不含 §4 缺陷阻塞特征；§5 清单无特征性不一致 |
| 5 | P3 统计复算 + 判定 | 三材质×三路 p95 ≤100ms、PTS/失败/黑帧 = 0（WebCodecs 两路） |
| 6 | P1 见证复跑 | §1.3 判定 |
| 7 | 探针零改动复核 | `git diff <验收基线>^ -- services/core apps/desktop/src/app apps/desktop/electron/main/restricted-media.ts` 为空（生产管线/交互预览/票据协议） |
| 8 | 探针代码处置建议 | 保留/丢弃/部分保留，记入放行记录（M3-0-3 结束前不得删除） |

## 2. ZhangSan 书面确认（P2 及 Core 侧）

> 本人确认：P2 的全部证据（FFV1 无损基准端、中立 IR 投影器、比对工具、第 0 步自校准数据、逐帧比对结果）与本人口径一致——基准端直调生产链路（compile→ffprobe→build_ass→build_timeline_args→run_timeline_render）仅替换编码器为 ffv1；IR 投影器语义经逐帧断言验证（转场 offset/借用式压缩内容原点/变速 nearest 帧对位/PiP 内容盒/fade 近似）；比对口径（帧索引对齐、BT.709 钉死、RGB 空间 PSNR、±8px 相位相关、字幕单独口径）先于实现钉死且未在结果产生后调整；两处权威端缺陷（position 关键帧超长、rotate 弧度错位）的描述与实测证据相符且未改动生产代码。无口径偏差。
> ——ZhangSan，2026-09-05

## 3. YeJing 书面确认（P1/P3 与 Electron 载体）

> 本人确认：P1/P3 的全部证据与本人口径一致——四层隔离入口（AIVS_M3_PROBE 门控 + DEV 动态导入 + probes/ 目录 + 构建 grep 校验）按冻结方案实施且生产产物零命中；P1 测量口径经三次修正均有记录（GPU 指标采样移出渲染循环、vsync 锁定 ticker、视频可见化），三档刷新率复测数据可复现；P3 三路（HTML5 / WebCodecs / +缓存）同目标集同口径，VideoDecoder 配置与手写 BMFF demux 实现与描述相符；scrub 565–592ms 的归因（多路顺序寻址编排）与 P3 单路数据自洽。无口径偏差。
> ——YeJing，2026-09-05

## 4. 验收产出（LiuKeAi 填写）

- 验收报告（逐项检查清单结果 + 复算偏差记录）；
- 探针代码处置决定（保留/丢弃/部分保留）；
- 放行记录：M3 立项建议 + IR 契约冻结草案 v0.1 的接受/退回。

# M3-0-3 Gate 独立验收报告（LiuKeAi）

> 验收人：LiuKeAi（独立，未参与任何探针实现；全部结论以本人复算为准）
> 日期：2026-09-05
> 验收对象：[M3-0 技术验证报告](../../docs/STAGE_M3_0_TECH_VALIDATION_REPORT.md) + [ADR-1](../../docs/STAGE_M3_0_ADR_1_P2_GATE.md) + [IR 契约冻结草案 v0.1](../../docs/STAGE_M3_0_IR_CONTRACT_DRAFT.md) + [M3 立项建议草案](../../docs/STAGE_M3_0_M3_INITIATION_RECOMMENDATION.md)
> 依据：[验收包 §1.4 八项检查清单](../../docs/STAGE_M3_0_M3_0_3_ACCEPTANCE_PACKAGE.md)
> 复算工件：本目录（check1~check5 脚本与结果 JSON、p2_comparison_recompute.json、step0_recompute.json、ir_regen2.json、caption_presets.json、p1_60hz_witness/）
> 复算环境：仓库 `.venv`（Python 3.13 + numpy）+ `resources/ffmpeg/win-x64/ffmpeg.exe`（与 baseline_manifest 记录同一二进制）；运行基线 `uiux-polish-round3` @ `fd6a407`（dd82033 之后）

## 最终验收结论（一行）

**通过（PASS）** —— 八项检查全部通过；未发现任何影响门判定的复算偏差；所列 6 项差异均为文档级数字/措辞瑕疵与证据归档时序问题，不改变任何门判定结果，建议随放行记录做一次文档勘误（不阻塞）。

---

## 逐项检查结果

### 检查 1：证据 SHA-256 核对 —— **通过**

- `sha256_manifest.json` 全部 31 条目（materials 14 + documents 13 + baselines 4）逐个以 `tools/m3_0/common.py sha256_file` 重算：**31/31 命中**（哈希与字节数双核对，含 283MB FFV1 baseline.mkv）。
- 交叉核对：`p2/baseline/baseline_manifest.json` 中 baseline_mkv / nocap / second_ref 三个哈希与总清单一致；验收包 §1.1 命令①输出 True。
- 工件：`check1_sha256_result.json`（脚本 `check1_sha256.py`）。

### 检查 2：P2 复算 —— **通过**

- **命令②逐帧比对复算**（compare_tool.py frames，全参数同验收包）：输出 `p2_comparison_recompute.json` 与存档 `comparison.json` **37 帧逐字段 0 差异**（psnr_db / psnr_raw / ssim / shift(dx,dy,peak,confidence) / psnr_vs_second_ref_db / 字幕 IoU+bbox+中心偏移+diff 比率 / caption 分类标志）。verdict 全等：非字幕 26 帧、字幕 11 帧、psnr_min=19.103156、misalign_max=0、原 40dB 门 pass=false（与报告"原门未达"一致，ADR-1 已相对化）。工件：`check2_frame_diff_result.json`。
- **命令③第 0 步自校准复算**：deterministic=**True**（PSNR=inf）；601/709 失配 **27.820313dB**（报告 ≈27.82 ✓，逐位复现）；GL 底噪 min **31.4206dB**、max **38.5861dB**（报告 31.41–38.59 ✓，判定基准 31.4–38.6 内）。**发现 D1**（见差异清单）：13 帧底噪中 11 帧与存档有 +0.01~+0.07dB 微差，根因为证据归档时序（step0.json 早于校准 GL PNG 最终采集 73 秒），两套值结论一致，判定不受影响。工件：`step0_recompute.json`。
- **命令④ IR 抽点**：n=585 fade 转场 **p=0.5** ✓；n=630 B 段 **src_n=48**（src_t=1.6s，0.8× 借用式）✓；n=1649 C 段 **src_n=299**（内容时间原点=输出 45s=1350 帧，与 IR 黑底填充 1320–1349/1800–1829 及转场窗口 offset=19s/duration=1s 相互印证）✓；PiP1 盒 **(504, 68, 336, 188)** ✓（n=585/630 双点核对）。
- **加强项（本人追加）**：用 `plan.json + ffprobe.json + 生产 CaptionResources 预设` 重跑中立投影器，再生成 IR 与存档 `ir.json` **全量逐位一致**（1830 帧 + caption_styles 全等，`ir_regen2.json`）——存档 IR 确为 plan 的确定性投影，无手工改动痕迹。

### 检查 3：ADR-1 口径逐条核对 —— **通过（附 2 条文档勘误建议）**

基于 `comparison.json` 实数据（脚本 `check3_adr1.py`，结果 `check3_adr1_result.json`）：

| # | 判据 | 复算结果 | 判定 |
|---|---|---|---|
| 1 | 几何错位 = 0px（±8px 窗，全部非字幕帧） | 26/26 帧 shift=(0,0)；两处 1px 偏移均在字幕帧（n=1590 (1,1)、n=1649 (0,-1)），字幕不计门 | **满足** |
| 2 | 语义/时序零偏差 | 37 帧逐帧复现 + IR 全量再生成逐位一致 + ④抽点全中 + 转场窗口/黑底填充/借用式原点交叉印证 | **满足** |
| 3 | 非字幕帧 PSNR ≥ 19dB（回归门） | 实测 **min=19.103156（n=510，PiP 帧）**、max=35.362022，全部 ≥19 | **满足**（勘误 E1：报告 §2.3/ADR §3-3 写"15.1–35.4dB（最低 n=1590）"——n=1590 实为字幕帧，非字幕帧实际范围 19.10–35.36dB；ADR §1 的"19–28dB"与实数据相符） |
| 4 | 字幕 IoU ≥ 0.35 且中心偏移 ≤ 8px | IoU **0.3756–0.4534**；中心偏移 max **4.5px**（11/11 帧） | **满足** |
| 5 | 缺陷修复重基线化条款 | ADR §3-5 在案（修复后重采样上调基线），前瞻性条款，待缺陷修复时执行 | **在案** |

- 附注（勘误 E2，仅参考值非门）：ADR §3-3 分档参考"无 PiP/慢速帧 ≥ 31dB"——实测无叠加帧桶 min=**30.9926dB（n=1799）**，比参考标签低 0.007dB；报告 §2.3 写该桶"31.2–35.4dB"亦与 30.99 不符。绑定门（≥19dB）不受影响。

### 检查 4：IR 草案红线 —— **通过**

- **§2 冻结子集**：位置关键帧标"**暂缓**（修复复测后入 v0.2）"；PiP `transform.rotate` 标"**暂缓**"——两项 §4 缺陷阻塞特征**均不在冻结子集** ✓。
- **§4 子集外表**：两项缺陷的排除原因与技术报告 §4.5-(1)(2) 描述一致，均附重入条件（修复 + 重跑 P2 采样达 §3 口径）✓。
- **§5 已知偏差清单**：4 项均为系统差/口径差并附实测界，与本人复算一致——①字幕光栅化 IoU 0.376–0.453/偏移 ≤5px ✓；②重采样栈差异（底噪 31.41 实测 ✓、回归基线 19dB 实测下限 ✓）；③变速段 ±1 帧口径差（实测仅速度段掉档）；④opacity fade 近似（双端同语义）。无特征性内容不一致 ✓。
- **`ir.json` known_approximations**：5 条，含两项缺陷全文 ✓。
- **白名单硬失败实测**（`check4_whitelist.py`，对 `_validate_whitelist` 注入合成 plan）：mask / keying / reframe / **rotate 关键帧** / scale 关键帧 / dissolve 转场 / 非 V1 轨关键帧 / reverse_playback / 字幕 style_override —— **9 类全部 IrProjectionError 拒绝** ✓。对照项：**静态 PiP transform.rotate 按设计放行**（IR 复刻权威端弧度错位实际行为并记入 known_approximations；其不入冻结子集由草案 §2/§4 在契约层强制）。口径说明：硬失败拦截的是 rotate/scale **关键帧属性**，静态 rotate 的"阻塞"由契约草案承担——设计自洽，与文档声明相符。

### 检查 5：P3 统计复算 —— **通过**

（脚本 `check5_p3.py`，结果 `check5_p3_result.json`；9 条实测路 × 100 样本）

- **统计量复算**：按 `common/stats.ts` 同口径（线性插值百分位 + round3）从 `samples[].latency_ms` 重算 p50/p95/max/mean（含 cold/hot 分段）——**9 路全部与汇总字段一致，0 偏差**。报告 §3.2 表 9 行数字全部对上（如 540p WC p50 20.35→20.4、WC+cache p95 30.055→30.1、proxy WC p95 39.605→39.6）。
- **失败/PTS/黑帧**：失败数重算=字段（唯一非零：proxy HTML5 = **3**，样本 #9/#11/#58 超时，与报告"3/100 超时"一致）；WebCodecs 两路 PTS 偏差重算=0（容差阈值 1.02 帧，实测最大偏差 1.00002 帧）；黑帧=0（探针内部像素计数，工件不可重算，见 D3）。
- **mulberry32(20260905) 重放**：Python 位精确复刻（`Math.imul` → 32 位掩码乘法）。540p 与 1080p：前 92 样本全 kind=0，**N=749 重放逐帧命中**；后 8 样本 = stss 关键帧 30/60 的 {-1,0,+1,+2} 邻域（kind=1）✓。proxy：**N=87，100/100 全部 uniform 重放命中**（其 stss 无非零关键帧 → while 补齐，见 E4）。三路同材质目标集逐帧相同 ✓。
- **缓存统计**：hits 28/28/54、evictions 78/78/52、bytes 18.7/74.6/18.7MB —— 报告"命中 28–54，淘汰 52–78，内存 19–75MB" ✓。
- **门判定**：WebCodecs 与 WebCodecs+缓存两路 × 三材质 p95 = 30.1–39.6ms **全部 ≤100ms**，失败/PTS>1 帧/黑帧 = 0 → **通过**。

### 检查 6：P1 见证复跑 —— **通过**

按验收包 §1.3 精确执行（证据：`p1_60hz_witness/m3p1_result.json`）：

1. `set_hz.ps1 -TargetHz 60` → `set(60) -> 0`，`current: 3440x1440 @ 60Hz` ✓（事前记录原态 75Hz）；
2. `run_electron_probe.py m3p1 --ir evidence/m3_0/p2/ir.json --evidence evidence/m3_0/p1_60hz_witness` → exit 0；
3. 判定：
   - GPU 适配器 = Iris Xe D3D11（hardware=true，非 SwiftShader）✓；
   - 循环间隔 p95：**17.5 / 17.01 / 17.0ms**（三轮全部 ≤33ms）✓；
   - 掉帧率：**0.556%（10/1800，首轮冷启动，max interval 117.4ms）/ 0% / 0%**；**中位 0%，最差 0.556% < 1%** ✓（首轮冷启动掉帧与报告披露的 0.61% 同象，如实记录）；
   - 任务 p95：**0.4 / 0.1 / 0.1ms ≪ 33.3ms** ✓；
   - 内容帧间隔 p50 = 33.3ms（精确）✓；scrub p95 = 587.6ms（与报告 565–592 一致，非本门判据）；scrub mediaTime 偏差 >1 帧 = 0；
4. `set_hz.ps1 -TargetHz 75` → `current: 3440x1440 @ 75Hz` 已恢复 ✓。

与存档 60Hz 数据（0.61%/0%/0%，p95 17.7/17.1/17.4）相互印证，可复现性成立。

### 检查 7：探针零改动复核 —— **通过**

- `git diff dd82033..HEAD -- services/core apps/desktop/src/app apps/desktop/electron/main/restricted-media.ts` → **0 行**（生产管线/交互预览/票据协议零改动）✓。
- `git diff dd82033..HEAD --name-status` 全量核对：生产路径 Modified 恰为报告 §A.3 所列 4 文件，合计 **+46/−4** 与报告一致（main/index.ts +14/−1、preload/index.ts +5、renderer/main.tsx +28/−2、package.json +3/−1——stat 口径合并后即 +46/−4）；其余为新增探针/工具/文档/证据（A）与 **.gitignore（M，仅 evidence 二进制忽略规则，非生产代码，报告 4 文件清单未列，见 E5）**。
- `verify:probe-isolation`（先 `pnpm --filter @aivideo/desktop build` 生产构建，再校验）：**PASS**，`out/renderer` 5 文件 / `out/preload` 2 文件 / `out/main` 1 文件零探针命中，输出与报告 §A.4 记录逐字一致 ✓（校验逻辑复核：renderer 五标记全禁，preload/main 禁探针名、允门控壳字符串——与冻结方案 §7.1 第 4 层一致）。

### 检查 8：探针代码处置建议 —— **建议：全部保留（作为 M3 回归资产）**

| 资产 | 处置 | 理由 |
|---|---|---|
| `tools/m3_0/`（比对工具、基线harness、IR投影器、校准/素材工具、运行器、set_hz） | **保留** | ADR-1 §4 明定其为"M3 长期资产（回归门的执行载体）"：≥19dB 回归门与缺陷 1/2 修复后的重基线化都必须用同一工具重跑；本次已验证其确定性（comparison 逐帧复现、IR 全量再生成逐位一致）。丢弃即等于废弃 ADR-1 的回归门。 |
| `apps/desktop/src/probes/`（m3p1/m3p2/m3p3 + common + p3-worker） | **保留** | ①四层隔离经生产构建验证零泄漏，保留零运行时成本；②p3-worker（手写 BMFF demux + VideoDecoder + LRU 帧缓存）是报告建议的主解码路径（WebCodecs+缓存）的已验证参考实现，M3 引擎实现的直接输入；③compositor.ts 是 IR 消费端的参照实现（R4 语义）。 |
| `evidence/m3_0/`（清单与结果 JSON 已入库；mkv/png 等批量二进制本地留存） | **保留**（JSON 随仓库；二进制本地保留至缺陷修复重基线化完成） | ①入库存档是放行记录的证据链；②baseline.mkv/nocap + PNG 采样是未来 P2 重跑的输入（重基线化条款执行前提），过早删除将使重基线化不可执行；③历史轮（p1 污染轮、p1_nomipmap A/B）按报告留档口径保留，属测量方法学证据。 |

- 处置时点：按验收包约定 **M3-0-3 结束前不得删除**；建议复核节点放在 M3 契约冻结阶段（届时若将 probes/ 移出 app 树或裁剪，需重跑 verify:probe-isolation 并更新放行记录）。

---

## 复算与报告数字的差异/偏差清单（全部不改变门判定）

| # | 类别 | 内容 | 影响 |
|---|---|---|---|
| D1 | 证据归档时序 | `step0_calibration/step0.json`（13:42:30 写盘）早于校准 `gl/*.png` 最终采集（13:43:42）约 73 秒 → 存档底噪 13 帧中 11 帧与现盘 PNG 重算值有 +0.01~+0.07dB 微差（存档 min 31.4102 vs 重算 min 31.4206；frame 12/13 逐位相同）。两套值同结论（底噪 ≈31.4dB < 40dB 门；报告引用的"31.41–38.59"与其引用的存档工件自洽）。主时间线证据链时序干净（base 13:49 → gl 14:29 → comparison 14:30）且逐帧 0 差异。 | 无（建议：以现盘 PNG 重归档 step0.json 或在放行记录注明采集顺序） |
| E1 | 文档数字瑕疵 | 报告 §2.3 与 ADR-1 §3-3 称非字幕帧"15.1–35.4dB（最低 n=1590）"——实测 **n=1590 是字幕帧**（15.126dB，IoU 0.4534）；26 个非字幕帧实际范围 **19.103–35.362dB（min @ n=510）**。ADR-1 §1 的"19–28dB"与实数据相符；≥19dB 门成立且恰以实测下限为基。 | 无（建议勘误） |
| E2 | 文档数字瑕疵 | 报告 §2.3"无 PiP/无旋转帧 31.2–35.4dB"与 ADR-1 参考值"≥31dB"——实测无叠加帧桶 min=30.9926dB（n=1799）。参考值非绑定门。 | 无（建议勘误） |
| E3 | 文档措辞 | 报告 §4.5-(1)"尾部 46s 冻结帧"——按帧数 3180−1830=1350 帧 = 45s（106−61=45s）。±1s 措辞差。 | 无 |
| E4 | 文档措辞 | 报告 §3.1"每材质 100 目标 = 92 uniform + 8 关键帧邻域"——proxy 材质因 stss 无非零关键帧，实际为 **100 uniform**（确定性 while 补齐，三路一致，重放 100/100 命中）。540p/1080p 材质确为 92+8。 | 无 |
| E5 | 报告清单外改动 | `.gitignore` 为 Modified（仅新增 evidence 二进制忽略规则），未列于报告 §A.3 的 4 文件清单；属仓库管理文件而非生产代码，"生产文件改动仅 4 个"的表述仍成立。 | 无 |

**可追溯性备忘（非偏差）**：① P3 `pts_dev_over_1frame` 的实际阈值为 1.02 帧（字段名与报告"≤1 帧"语义一致，浮点容差）；HTML5 路样本未逐点记录 dev、黑帧为探针内部像素计数——这两项无法从工件独立重算（WebCodecs 两路 PTS 已重算一致），属工件自描述性限制，建议 M3 遥测设计时补齐。② P1 scrub 种子 20260904 的重放未列入本次检查项，未执行（P1 门判据不依赖）。

## 放行记录建议（验收包 §4）

- **M3 立项建议草案：接受**（带约束立项：WebCodecs+帧缓存、多路并行 scrub 编排设计、缺陷 1/2 修复排期后重基线化）。
- **IR 契约冻结草案 v0.1：接受**（红线核验通过：缺陷阻塞特征未入子集、§5 清单全部为附实测界的系统差/口径差；schema 定稿留 M3 契约冻结阶段）。
- **文档勘误（E1/E2/E3/E4，随放行记录一次提交，不阻塞）**。
- **探针资产处置：全部保留**（见检查 8），记入放行记录。

## 验收人声明

本人未参与任何探针实现与数据产出；本报告全部数字来自本人独立复算（脚本与中间结果存于本目录），复算过程中未修改任何仓库文件（仅新增本目录工件与 `p1_60hz_witness/` 运行输出，显示器已恢复 75Hz 原态）。

—— LiuKeAi，2026-09-05

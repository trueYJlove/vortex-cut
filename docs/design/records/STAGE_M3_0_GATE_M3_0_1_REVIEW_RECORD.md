# M3-0 Gate M3-0-1 评审与放行记录

> 评审对象：[M3-0 预览合成引擎技术验证详细设计](STAGE_M3_0_PREVIEW_ENGINE_VALIDATION.md)
> 评审轮次：v0.1 → v0.2（修订）→ v1.0（冻结）
> 日期：2026-09-04
> 决策：项目所有者"冻结 v0.2 放行"，Gate M3-0-1 通过

## 1. 三方评审结论

| 评审人 | 职责范围 | 结论 | 放行条件 |
|---|---|---|---|
| ZhangSan（核心/渲染） | P2 及 Core 侧 | 有条件放行 | 按 B1–B4 修订 §6.2/§4/§5（现 §7.2/§5）后即可实施 |
| YeJing（桌面/Electron） | P1/P3 及 Electron 载体 | 有条件放行 | 落实 B1–B4 与 S2/S6（现 §7.1/§7.3/§4） |
| LiuKeAi（独立评审） | 范围纪律、判据可验证性、证据链 | 需补充后可决策 | 清除阻塞 B1–B4（判据操作化、Gate 证据集合、红线检查点、主线锚点更新） |

三方一致：三探针架构方向可行，全部问题为文档文字级修订，不改架构、不影响 P1/P3 与 P2 互评。

## 2. 阻塞项 → 落实条款映射

| 来源 | 阻塞项 | 落实位置（v0.2/v1.0） |
|---|---|---|
| LiuKeAi B1 | 主线锚点过时（原引 Stage 5-R 第一优先；实际 Stage 0–8 已收口、M2 为当前最高优先级） | §8 第一条（已核实 `PROJECT_RELEASE_STATUS.md`、`STAGE8_POST_RELEASE_CLOSURE.md`、分支 `uiux-polish-round3`） |
| LiuKeAi B2 / YeJing B2 | 掉帧率/帧时间/scrub/延迟判据未操作化 | §7.1 通过标准（掉帧分母 1800、p95 口径、固定种子、rVFC 出图延迟、冷/热分离、3 轮取最差）；§7.3 PTS 偏差 ≤1 帧替换主观判据 |
| LiuKeAi B3 / ZhangSan B2/B3 | P2 比对口径未固定（有损基准、色彩矩阵、帧对齐） | §7.2 基准端 FFV1 无损、BT.709 钉死、帧索引 n↔PTS n/30、第 0 步自校准、阈值修订须 ADR |
| LiuKeAi B4 | Gate 无证据集合、红线无检查点、探针代码处置时点未锚定 | §11 M3-0-2 证据集合 a–f；M3-0-3"已知逐帧偏差清单"红线；探针代码 M3-0-3 结束前不得删除 |
| YeJing B1 | 1080p30 指标与复用 ≤960p 代理自相矛盾 | §7.1 素材条：探针自产固定参数素材脚本，现有代理仅作注明低估的对照口径 |
| YeJing B3 | 探针入口在本仓库不可直达、生产隔离未定义 | §7.1 载体四层隔离（`AIVS_M3_PROBE` 注入 + `import.meta.env.DEV` 动态导入 + 目录约定 + 构建产物 grep 校验） |
| YeJing B4 | P3 缺 MP4 demuxer 决策、Worker 内 decodeAudioData 不可用 | §7.3 实现要点 |
| ZhangSan B1 | opacity 关键帧语义描述与权威实现相悖（实际为 fade=alpha 整体渐入近似，非 lerp） | §7.2 关键帧子集按 ffmpeg.py 实际行为建模，记入"权威端已知近似"清单 |
| ZhangSan B4 | IR 范围遗漏 transform 与输入流几何（PiP 采样无法执行） | §7.2 IR 范围增补 transform 与 width/height/SAR |

## 3. 主要建议项处置

- 采纳：ZhangSan S1（IR 携带 30fps 逐帧数值表，插值收敛 Core 单点）、S2（投影器白名单硬失败）、S3（关键帧仅 V1 主轨）、S4/S5（字幕帧单独口径、避开转场∩字幕采样帧）、S6（P1 表述为 V1 主轨 + 覆盖轨）、S7（R10 口径风险 + 事前校准）；YeJing S1–S8（现状描述修正、GPU 指标 IPC、技术基线章节、口径统一、R6–R9、票据机制、devDependency 声明）；LiuKeAi S1–S9（WebGPU 不计入判定、三态放行、错位测量法、契约草案边界、探针目录收敛、M2 关系、core 管线只读、Gate 体例对齐、交付物条件统一）。
- 独立跟进（非本阶段交付，LiuWei 排期）：`design/M2_B3_KEYFRAMES_DESIGN.md` 末尾残留脚本清理与 §3 opacity 方案勘误；`rendering/ffmpeg.py:103–107` 失真注释与实现对齐。

## 4. 冻结时写入

- 测试机型：Intel NUC11PAHi7（i7-1165G7）+ Intel Iris Xe Graphics，驱动 31.0.101.3222，32GB 内存，显示 3440×1440；虚拟适配器 OrayIddDriver 存在，硬件断言以 Iris Xe 为准。
- 代码基线：分支 `uiux-polish-round3` @ `cab8b95`；本文档与本记录随该基线 commit 提交。

## 5. 证据与边界

- 三份评审全文在评审会话中交付，本记录为其结论、阻塞项与处置映射的固化；M3-0-2 的验证报告须按方案 §11 证据集合 a–f 独立成册。
- 评审所依据的代码事实（plan.py、ffmpeg.py、App.tsx、restricted-media.ts、Electron 版本等）由各评审人独立核对，未发现与仓库不符的陈述残留于 v0.2。

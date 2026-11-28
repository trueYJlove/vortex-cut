# P237 0.1.0 发布门与后续路线图

> **状态**：已立项（2026-11-28 用户确认）；当前项目状态与能力边界只见 [`../STATUS.md`](../STATUS.md)，开放项明细见 [`../BACKLOG.md`](../BACKLOG.md#p237)。
> **执行方式**：按下文步骤**逐步执行**，每次只推进一个步骤（或一个子项）。每步动手前先列出最小改动文件清单与门禁，收尾时贴出真实命令、退出码与 `git diff --stat`（AGENTS.md Execution Rules 1–4）。本文件的勾选框只跟踪本工作包自身进度。

## 0. 用户裁决记录（2026-11-28）

| # | 事项 | 裁决 | 理由摘要 |
|---|---|---|---|
| D1 | P161 中文 CLIP 分发与许可 | **暂不处理，路线规划中按“可用”对待**；许可核实与公网托管延后，不阻塞 0.1.0 | 用户裁决；留存建议：后续先限期 1–2 天核实上游许可，明确则自建 HTTPS 托管，否则换许可明确的模型并重跑评测，同时评估 fp16/int8 量化以缩减 719 MB 下载 |
| D2 | P235-R4 HTML `page` | **降级挂起**：保留已冻结架构与 Schema 预留（`asset_kind=page` 不删），移出 P235 验收范围；待 P236 Agent 工作区落地且出现真实“Agent 生成动效”需求后再单独立项 | 执行用户 HTML 安全面大（sandbox/网络/资源白名单/越权负例），与 ADR-0003 隐私承诺张力大；核心场景已由字幕/花字/关键帧覆盖 |
| D3 | P220 色彩令牌 | **以 Graphite `--dlg-primary`（`#35d6ae`）为单一来源**：先 `--vc-accent: var(--dlg-primary)` 别名收敛，再逐步替换约 29 处引用，最后删除旧令牌 | 两色（`#25d3ac` vs `#35d6ae`）肉眼几乎无差，本质是单源化；别名零视觉风险；与 P217 方向一致 |
| D4 | 版本节奏 | **定义 0.1.0 发布门**（见 §5）；P236 作为 0.2.0 主题 | 用客观门槛逼迫收口；0.1.0 聚焦“稳定可用”，0.2.0 聚焦“Agent 协作” |

## 1. 阶段 0：签字/补证收口（约 1 周，不新增功能）

目标：STATUS.md §4 开放行从约 32 行降到 ≤ 24 行。

- [x] **0.1 P232** Filmstrip 预抽：跑全量门禁（`pnpm run ci`），通过后按 Rule 7 核销（结论已在 `specs/preview-and-rendering.md` §3，核对后移除 §4/BACKLOG 行）。（2026-11-28 已核销：`pnpm run ci` 全绿；同时以 best-of-3 p95 稳定了拖动规划挂钟断言）
- [x] **0.2 P217** Graphite 弹窗：整体核销确认（28 个弹窗证据见 `evidence/2026-11-09-dialog-family-c/`），结论并入 `specs/desktop-ui.md` §2 后移除。（2026-11-28 已核销：28 个已登记弹窗 11 份守卫测试全绿，长期结论已并入 specs/desktop-ui.md §2）
- [x] **0.3 P230** 五项观察：①②③⑤ 已落地，④ 由 P231、预抽由 P232 接续 → 直接核销。（2026-11-28 已核销：①②③⑤ 长期结论并入 specs/timeline-and-editing.md §1.3，④ 由 P231 承接、预抽由已核销的 P232 闭环）
- [x] **0.4 P231** 补 A2 `ffmpeg`/IR 逐像素对拍证据，达标后核销。（2026-11-28 已核销：修复 ffmpeg.py 4 处多轨/盒模型缺陷，test_p231_a2_pixel_parity_real.py + 真媒体回归 + pnpm run ci 全绿）
- [x] **0.5 P206** 补 `App.tsx` `assetOriginalRatio` 在“适应”模式读取 `rotation` + 竖拍铺满画布回归锁测试，完成后核销。（2026-11-28 已核销：原「适应」assetOriginalRatio 已由 2026-11-18 画布比例真源裁决取代；补修 ffmpeg.py _pip_overlay_chain 旋转换轴并补全 IR/FFmpeg 真渲染/Desktop texSwap 竖拍铺满回归锁，同时在 setup.ts 同步 asyncUtilTimeout 至 5s，pnpm run ci 全绿）
- [x] **0.6 P220** 按 D3 写入别名 `--vc-accent: var(--dlg-primary)`（第一步），后续替换随日常改动推进；别名落地后 P220 行改为“迁移中”。（2026-11-28 已完成第一步：`01-shell-and-timeline.css` 改为 `--vc-accent: var(--dlg-primary)`、移除 `08-workspace-studio-and-theme.css` 浅色重复字面量、新增 `theme-token-coverage.test.ts` 单源守卫，`STATUS.md` / `BACKLOG.md` 已更新为「迁移中」，`pnpm run ci` 全绿）
- [ ] **0.7 Wave1-L3**（需人工）：用户真机听感/审美签字。
- [ ] **0.8 P227**（需人工真机）：4K 对照、`VITE_AIVS_GPU=1` 回退无黑屏、假硬解提示验证。

## 2. 阶段 1：P235 语义正确性优先（2–3 周）

- [x] **1.1 P235-R1** Replace：无音轨 video → 静音片段，未知时长按 OpenFilm 目标需求长度 fallback；覆盖时间线校验、预览与成片 EOF。（2026-11-28 已核销：补齐 `set_clip_source_window` 未知时长、`ffmpeg` `tpad`/past-EOF 补黑静音、`asset-drop` `center` 预览时长、`PreviewSession` 跳过静音视频流式 PCM 请求及统一 `SOURCE_EOF` 边界反馈，`test_p235_r1_replace_render_real.py` 与 `pnpm run ci` 全绿）
- [x] **1.2 P235-R2** 时长范围统一（100ms – `Number.MAX_SAFE_INTEGER` µs）、`video_required`/`audio_required`、Desktop rig 过滤、原始音频票据与 proxy 分离、FFmpeg input-side `-vn`、解码计数对拍证据。（2026-11-28 完成并按 Rule 7 归并入 `specs/preview-and-rendering.md` 与 `specs/timeline-and-editing.md`）
- [ ] **1.3 P235-R3** 转场 active pair 共用投影 + migration 45（仅从不可变历史恢复 incoming identity，否则保留 null/dormant）。**新增迁移须同步 STATUS.md §1 `latest_migration`。**
- [ ] **1.4 P235 剩余项**：Core revision/undo、双端手势矩阵、46 区像素验收、冷/热性能对照。
- **R4 不在本阶段**（按 D2 挂起）。

## 3. 并行线 A：iPhone 素材兼容包（0.1.0 必需）

- [ ] **A.1 P216 路线裁决**：推荐“从 `ffprobe.py` 补全 profile/level 生成真实 codec string”为主，保留运行时坏帧降级兜底；实施前确认。
- [ ] **A.2 P203** 代理就绪后是否仍挂死的复测 + 冷却回切安全验证，修根因或明确边界。
- [ ] **A.3 P204** 结合 P203 完成含 `elst` 素材完整播放闭环验收。
- [x] **A.4 P206** 若 0.5 未完成，在此完成。（已在 0.5 完成核销）

## 4. 并行线 B：P200 限期排查

- [ ] **B.1** 限期 3 个工作日，目标：抓到可稳定复现的触发状态量。
- [ ] **B.2** 若未达成：降级为“已知边界”（约 8 分钟以上长时线），写入 `specs/preview-and-rendering.md` 与 `guides/user-manual.md`，从 §4 移除或改为“已知边界”，停止无限期排查。

## 5. 0.1.0 发布门（Release Gate）

必须全部满足：
1. 阶段 0 核销清单完成（人工项 0.7/0.8 已签字或用户明确豁免）；
2. P235-R1/R2/R3 闭环；
3. iPhone 素材兼容包（P203/P204/P206）闭环；
4. `pnpm run ci` 与 `pnpm run ci:release` 全绿（`p33-seek-play` 的 `test.fixme` 与 `stage4d` env-gate 用例按现状可接受）。

**明确不阻塞**：P200（按 B.2 降级为已知边界）、P161（按 D1）、P236（0.2.0）、W2.2/W2.3（冻结）。

发布动作：`package.json` 版本 0.0.1 → 0.1.0，同步 STATUS.md §2 发布版本字段，按 Rule 7 清理已核销文档。

## 6. 阶段 2（0.2.0 主题）：P236 规划门与切片

先过 P236 规划门（登记为一个工作包行，风险对策单独登记），再按“只读 → 可写”逐片验收：

| 切片 | 内容 | 依赖 |
|---|---|---|
| S0 | TD-01 先行：拆分 `timeline.py`（Schema / 校验 / 编译分离） | — |
| S1 | 单向导出工作区：`timeline.vcut.json` + `assets.manifest.json` + `.vortex/views/timeline.readable.md`，往返无损（整数微秒） | S0 |
| S2 | MCP/CLI 只读工具，复用 MCP-ready 编辑命令层（合并推进 W4.3 / P198） | S1 |
| S3 | 外部改写摄入：Core 校验 → 新 Revision；失败写 `sync-diagnostics.json` | S1 |
| S4 | MCP 写工具 + 双向同步冲突/乐观锁 | S2、S3 |

## 7. 本路线不主动推进（保持现状，触发条件见 BACKLOG）

P207、P187/P188、P196、P197、P165、P181、P149、P147/P148、P198（除 W4.3 并入 S2）、P81/P84、W2.2/W2.3（ADR-0009）、P132、P192/P194 剩余项、AI-Misc、TD-02..TD-05、P161（D1）、P235-R4（D2）。

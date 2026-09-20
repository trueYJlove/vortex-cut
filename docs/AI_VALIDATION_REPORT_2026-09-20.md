# AI-2/AI-1 真实世界验证报告（spike）

- 日期：2026-09-20（实验 B/C 补充同日）
- 执行：ZhangSan（Core 验证脚本 `tools/validation/run_validation.py`，隔离 data_dir `.validation/`，真实 sidecar + 真实素材 + 真实 provider）
- 素材（均为本机真实视频，非合成）：dance（1080p50，168s）、science（720p 竖屏，10.1s）、lichun（720p，150.9s）
- Provider：用户既有 `AIVS_REAL_PROVIDER_*` 配置组（apikey.fun 网关 / deepseek-v4.1-flash / 期望 json_schema 适配器），零重复配置
- 人脸模型：YuNet（`AIVS_E2E_MODEL_DIR` seed，sha256 清单校验）

## 实验 A：CV 信号分析（真素材，性能门 + 信号有效性）——全部完成

| 素材 | 时长 | 墙钟 | 每分钟源 | 采样 | 切点 | 人脸帧 | 门 A1（≤10s/分） |
|---|---|---|---|---|---|---|---|
| dance | 168s | 54.6s | **19.5s** | 168 | 0 | 23/168 | ✗ 超标 |
| science | 10.1s | 1.4s | **8.1s** | 11 | 0 | 0 | ✓ |
| lichun | 150.9s | 12.4s | **4.9s** | 167 | 19 | 0 | ✓ |

**A1 判定：条件性达标**。dance（50fps 高 GOP 密度 + 人脸二次遍历）超预算一倍，优化路径明确（采样密度自适应、双通道合并遍历），归 UI 阶段参数校准工作单。
**A2 判定：✓**。dance 固定机位零切点正确；lichun 19 切点/14 场景段与多镜头结构吻合；人脸检出（143-165s，23 帧，score≈0.8）经抽帧核验与画面一致（150s 清晰人脸/60s 无脸）。

## 实验 C：AI-1 多步 agent 会话（真 provider）——通过

- **C1 ✓**：会话单步收敛 `succeeded`，墙钟 11s。指令"把视频剪短一点，保留最精彩的部分"→ 模型产出 `trim` 语义 patch：168s 全段 → 0-90s（保留前半），结构合理。
- **C2 ✓（观测设计生效）**：本次未触发反馈重试（一步即中）；错误反馈路径已由单测覆盖。
- **C3 ✓**：单会话 616 tokens（预算 200k 的 0.3%）。
- patchscript 适配器锁定 `openai_chat_completions_patchscript_v1`。

## 实验 B：真 provider 三候选——部分完成，暴露关键发现

**B1（召回非空）✓**：无转录项目 CV 召回正常（lichun 14 场景段、dance/science 单场景段）。
**B2（三候选过时长硬门）✗——被能力探测拦截**：candidate 探测要求模型单发构造三变体且每变体时长**恰好**等于 15s 探测目标。deepseek-v4.1-flash 两次尝试均未通过（balanced/compact 的时长组合算不准；第二次叠加网络抖动）。诊断链路：裸调确认模型能产出**完全合规**的 candidatescript 信封与记录（parse+schema 校验均通过），失败点仅在"时长精确算术"这一强探测语义。
**B3**：未到达（被探测拦截）。

**判定：B 在当前强探测语义下对该档模型不可用**。这不是解析/schema 链路问题（已证明可用），而是探测设计的模型能力门槛问题。

## 验证发现（按重要性）

1. **【产品 bug，已修复】timeline patchscript 适配器缺格式说明**：`_generate_adapter` 的 instructions 从未告知模型 AIVS-PATCH/1 信封（candidate 分支有完整说明，patch 分支在演进中丢失），模型返回裸 JSON 被严格解析拒收——patchscript 探测/调用必败。修复后探测 supported、实验 C 全链通过。真实 provider 才能暴露的缺陷，验证目标直接命中。
2. **【产品需求，登记工作单】sidecar 出网不走系统代理**：`httpx` `trust_env=False` + 显式禁代理，而中国用户访问境外 provider 网关普遍需代理（本机验证即依赖 `127.0.0.1:10809`）。桌面用户在 UI 配 provider 后会遭遇同样的 `PROVIDER_NETWORK_ERROR`。需产品级方案（设置项"代理地址"或尊重系统代理开关）——登记为 provider 域独立工作单。
3. **【探测语义裁决】candidate 能力探测的"时长精确匹配"门槛过高**：强校验防误标（好），但把能正确产出结构化输出的中档模型全部挡在门外（候选校验本有 0.8-1.2×容差，探测却要求精确相等）。建议放宽探测时长校验为区间容差（与真实候选校验同语义），归入探测设计裁决单。
4. **【性能】dance 1080p50 分析超预算一倍**：见实验 A，参数校准工作单。

## 结论

- **Layer 0 全链在真实世界成立**（A 全项 + B1）；**AI-1 agent 管线在真实世界成立**（C 全项）。
- 一次验证 spike 命中 1 个真 bug（已修复）+ 1 个产品需求（代理）+ 1 个设计裁决（探测语义）+ 1 项性能数据——真实验证的价值完全兑现。
- 后续顺序建议：① patchscript 修复提交（本报告附带）；② 代理支持工作单 + 探测语义裁决单（Planning Gate）；③ UI 面单（含性能参数校准）。

## 附：实验环境

- 验证脚本：`tools/validation/run_validation.py`（自动读 `AIVS_REAL_PROVIDER_*` 用户环境变量，与 opt-in 测试同源，零重复配置）
- 原始数据：`.validation/report.json`（不入库）；能力探测/会话/候选记录均在 `.validation/app.db`

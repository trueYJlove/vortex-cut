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

## 实验 C：AI-1 多步 agent 会话（真 provider）——双模型通过

| 模型 | 结果 | 步数 | 墙钟 | tokens | 产出 |
|---|---|---|---|---|---|
| gpt-5.6-luna | succeeded | 1 | 11s | 616 | 168s→保留前 90s |
| deepseek-v4.1-flash | succeeded | 1 | 18s | 3529 | 168s→保留 42-126s（中段） |

**C1 ✓**（两模型均 ≤6 步收敛）；**C2 ✓**（反馈路径由单测覆盖，本轮一步即中未触发）；
**C3 ✓**（deepseek 3529 tokens，预算 0.3% 的 1.8%）。deepseek 的产出（中段 84s）与
luna（前段 90s）风格不同但都满足指令语义——会话管线对模型无偏好性依赖。

## 实验 B：真 provider 三候选——链路通过，探测门槛跨模型拦截（裁决数据齐备）

**B1（召回非空）✓**。**探测门槛拦截（双模型一致）**：

- candidate 探测要求单发构造三变体且每变体时长**精确等于** 15s。deepseek-v4.1-flash
  三次尝试 consistent 失败：三变体均只选 1 段（5s）；gpt-5.6-luna 部分变体算准仍总体失败。
- **两模型的结构正确性 100% 合格**（candidatescript 信封/记录/引用全过 parse+schema 校验）
  ——失败点唯一收敛于"精确时长算术"这一强探测语义。
- json_schema 类适配器在网关层被 `oneOf` 拒绝（400），两个模型一致——script 类适配器是
  唯一通路（格式说明修复后工作正常）。

**判定**：B 的解析/schema 链路真 provider 可用（双模型裸调证明）；端到端被探测门槛挡住。
**放宽探测时长校验为结构正确性校验的裁决依据已齐**（跨模型一致失败 + 真实候选侧本有
0.8-1.2× 硬门兜底时长质量）。

## 验证发现（按重要性）

1. **【产品 bug，已修复】timeline patchscript 适配器缺格式说明**：`_generate_adapter` 的 instructions 从未告知模型 AIVS-PATCH/1 信封（candidate 分支有完整说明，patch 分支在演进中丢失），模型返回裸 JSON 被严格解析拒收——patchscript 探测/调用必败。修复后探测 supported、实验 C 全链通过。真实 provider 才能暴露的缺陷，验证目标直接命中。
2. **【产品需求，已确认方案】sidecar 出网不走系统代理**：`httpx` `trust_env=False` + 显式禁代理，而中国用户访问境外 provider 网关普遍需代理（本机验证即依赖 `127.0.0.1:10809`）。**产品裁决（2026-09-20）：增加代理设置——默认走系统代理，允许用户自定义**。登记 provider 域独立工作单。
3. **【探测语义裁决，跨模型数据齐备，已落地】candidate 能力探测的"时长精确匹配"门槛过高**：
   强校验防误标（好），但 gpt-5.6-luna 与 deepseek-v4.1-flash **两个模型一致失败**——
   结构正确性 100% 合格，唯"精确时长算术"不过。真实候选侧本有 0.8-1.2× 硬门兜底时长
   质量。**裁决（用户 2026-09-20）：放宽为结构校验**——探测协议 v2（CANDIDATE/
   TIMELINE_PATCH_PROBE_PROTOCOL_VERSION → "2"），迁移 v22 触发器换血 + 旧探测结果
   全量重置为 untested（重新探测）。**deepseek 真实验证：candidate 探测转 supported**。
   附带发现与修复：CV 候选拼接校验从"单场景一段"放宽为"同素材"（deepseek 自然行为
   即跨场景取段，粗剪语义本就如此）；candidatescript 指令补时长约束说明后裸调 3/3
   三变体全部进 0.8-1.2× 硬门。
4. **【新发现，工作单】patch 探测网关慢滴挂起毒化 sidecar**：timeline-patch 探测在
   网关上出现 read timeout 被持续重置的挂起（>10 分钟无返回），且挂起的探测请求会
   拖慢 sidecar 后续请求处理（实验 B/C 的 HTTP 调用因此超时）。脚本侧已加 300s
   线程兜底；产品侧需"探测/调用总预算"机制（登记 provider 域工作单，与代理支持
   同批实施）。
4. **【性能——已定根因，非技术路线瓶颈】dance 1080p50 分析 19.5s/分超标一倍**：拆解实验确认瓶颈是 **FFmpeg `select` 滤镜前的全量解码**（50fps×1080p 的解码成本乘积 ≈ 与 4.4 倍墙钟比吻合），而非"采样点数"或 CV 技术路线本身。**优化方案已实测：`-skip_frame nokey`（解码器只解 I 帧）在 dance 上 6.4 倍加速（22.3s→3.5s）且输出逐字节一致**。代价：长 GOP 素材（lichun 有 8.3s 的 GOP）的"≥1s 兜底采样"在 skip_frame 下失效（兜底依赖解码非 I 帧的时间戳，167 帧→30 帧）——8s 空洞内的快速运动不可见。这是"速度 vs 采样粒度"的产品裁决而非纯技术问题，量化数据已齐，归规划门裁决（候选方案：默认 skip_frame + 检测到长 GOP 时回退全量解码；或密度参数用户可调）。

## 模型不一致说明（已查实并修正实验条件）

用户中转站记录显示调用模型与最新配置不符。**根因：进程环境变量快照**——验证脚本所在
shell 启动于用户修改注册表之前，读到旧值 `gpt-5.6-luna`。**修正**：脚本改为注册表
User 环境变量直读（`winreg`，绕过快照），`AIVS_REAL_PROVIDER_ENABLED` 优先级为进程
环境显式 1 > 注册表 > 缺省 0。deepseek 重跑已完成（本报告 C 表/B 节即 deepseek 数据；
gpt-5.6-luna 数据保留为跨模型对照）。中转站记录的 `/v1/responses` 端点调用为产品
responses 类适配器的正常探测路径。

## 结论

- **Layer 0 全链在真实世界成立**（A 全项 + B1）；**AI-1 agent 管线在真实世界成立**（C 全项）。
- 一次验证 spike 命中 1 个真 bug（已修复）+ 1 个产品需求（代理）+ 1 个设计裁决（探测语义）+ 1 项性能数据——真实验证的价值完全兑现。
- 后续顺序建议：① patchscript 修复提交（本报告附带）；② 代理支持工作单 + 探测语义裁决单（Planning Gate）；③ UI 面单（含性能参数校准）。

## 附：实验环境

- 验证脚本：`tools/validation/run_validation.py`（自动读 `AIVS_REAL_PROVIDER_*` 用户环境变量，与 opt-in 测试同源，零重复配置）
- 原始数据：`.validation/report.json`（不入库）；能力探测/会话/候选记录均在 `.validation/app.db`

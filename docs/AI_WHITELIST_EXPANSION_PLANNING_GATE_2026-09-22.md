# AI 操作白名单纪律与扩容（阶段 B 第一单）——Planning Gate

> ## ✅ 本单已交付（commit `5bec655`，PR #36）——交付后对照（2026-09-24 补）
>
> **以下为规划时点内容；与最终交付不一致之处以本横幅为准。**
>
> | 本文表述 | 最终交付 | 说明 |
> |---|---|---|
> | §0「白名单已漂移至 **24 种**」 | **22 种** | 24 是**治理前快照**。最终 22 = 24 − 2 |
> | §1.2「晋升 **12 种**（含 transform/mask/keying **五件套**）」 | **晋升 11 op** | `set_clip_mask` / `set_clip_keying` **被显式排除**——理由：蒙版形状/抠像色彩是像素级数据，文本指令生成即猜测（`timeline.py` 注释）。句内 `clear_clip_keyframes` 重复、'五件套'实为 3 项，**原算术不闭合** |
> | §0「`TIMELINE_PATCH_OPERATIONS_SCHEMA` 只覆盖 **11 种**，`_PATCH_FIELDS` 同样 11 种」 | **各 22** | 缺口已全部关闭：schema oneOf = 22 分支、`_PATCH_FIELDS` = 22 条，三处一致由测试钉死 |
> | §2「字段清单 **15 op** × ~3 字段，prompt 增约 500 字符」 | **22 op** | 增量大于原估算 |
> | §5 开放问题「`set_clip_transform/mask/keying` 数值域收敛性」 | 适用面**缩小** | mask/keying 已出白名单，仅 `set_clip_transform` 在列 |
>
> ### 验收项落实（对照 §3）
>
> | # | 验收项 | 状态 |
> |---|---|---|
> | §3.1 | 白名单显式冻结 + 导入期断言 + 12 种晋升 op 沙盒用例 + 三处同步一致性测试 | ✅ `test_ai_whitelist_consistency.py`（10 项） |
> | §3.2 | 真实 deepseek 扩展指令（"剪短并加一个转场"）**跑通两步会话** | ⚠️ **实质已达成、步数口径待裁决（2026-10-09）**——真实 provider 跑扩展指令：`xiaomi/mimo-v2.6-pro` **1 步**产出 3 op（`trim_clip` + `split_clip` + **`add_transition`** dissolve 0.5s），白名单 `ai=True` 校验过、落真实 Revision（clips 2 / transitions 1）；`provider_invocations` 行数 = 步数不变量成立。**两处偏离**：① 模型非点名的 deepseek（注册表配置已切，历史 deepseek 调用记录在 `.validation/app.db` 但用单动作指令）；② 「两步会话」与实现收束判定（「成功步即会话成功」，多步仅出现在失败→反馈→重试路径）不一致——点名指令 1 步即成，2 步非确定性。取证 `AI_WHITELIST_EXPANSION_P4_PROVIDER_RUN_2026-10-09.md`。**已登记为 `docs/STATUS.md` §4 承诺 P4** |
> | §3.3 | Core + Desktop 全量回归；candidate 链路不回归 | ✅ |
> | §3.4 | PROTOCOL_VERSION 不动；`sent_fields` 如实 | ✅ |
> | §3.5 | **更新 AI-1 规划门"13 种"记载** | ✅ **2026-09-24 补做**（W0.1）——原文长期未改，是本次审计中"验收项静默丢失"的典型。**已登记为 `docs/STATUS.md` §4 承诺 P3** |

> 起草：LiuWei，2026-09-22。承接 AI-1 规划门 §1 边界（"AI 操作白名单扩容……
> 独立工作单"）。分支 `ai/whitelist-expansion`。实施：ZhangSan（Core）+
> YeJing（Desktop 无改动预期）。验收：LiuKeAi。

## 0. 现状走读结论（2026-09-22 代码级，master 88ed495）

**发现 1：白名单已经"被动扩容"，与规划门记载（13 种）漂移至 24 种。**

- `AI_PATCH_OPERATIONS`（timeline.py:52）= `PATCH_OPERATIONS`（33 种）− 9 种
  结构性排除（insert_asset_clip / insert_transcript_segments / add_caption /
  import_captions / set_clip_locked / add_track / remove_track / move_track /
  set_track_flags）= **24 种**。
- 漂移机理：排除清单是"结构性操作"语义（增删容器/来源绑定/用户锁定），而
  8-28 以来新增的操作（转场三件套、关键帧、transform/mask/keying、字幕样式）
  落地时**默认进了全量 `PATCH_OPERATIONS` 且未被排除**——白名单没有独立
  的准入闸门，任何新 patch op 自动成为 AI 可用操作。
- 后果评估：**不是安全事故**（这些 op 的 apply 校验完整、consent/egress 链
  不变），但三重不一致已现实存在：
  1. **契约缺口**：`TIMELINE_PATCH_OPERATIONS_SCHEMA`（providers.py:96，
     json_schema 族适配器的输出 schema）只覆盖 11 种 op——`position_clip` /
     `set_speed` / `set_reverse_playback` 三种白名单 op **schema 缺失**，
     `add_transition` 等 13 种 8-28 后新增 op 同样缺失。命中 json_schema
     适配器时模型无从输出这些 op（诚实失明）；命中 patchscript 时模型可能
     尝试输出但域校验的 `_PATCH_FIELDS`（providers.py:314）同样只覆盖 11 种
     ——**"白名单声称允许"与"解析器实际接受"不一致**。
  2. **提示词缺口**：patchscript instructions 的字段清单（167692e 注入）
     来自 `_PATCH_FIELDS`，同样是 11 种。
  3. **知识缺口**：AI-1 规划门"净 13 种"的记载已过时，新会话设计的认知
     基础失真。

**发现 2：probe（探测）不与白名单耦合**。`_validate_probe_output` 固定
`set_layout→fit` 场景（timeline_planning.py:130），白名单扩容不影响探测
语义与 provider 能力记录——已 supported 的 provider 无需重新探测。

**发现 3：sent_fields / egress 知情范围不受影响**。payload 的
`allowed_operations` 字段如实列表白名单（agent_session.py:623、
timeline_planning.py:493），白名单变化自动反映在用户确认页——隐私链路
无感。

## 1. 范围

### 必须实现（Core）

1. **白名单显式化（白-1）**：`AI_PATCH_OPERATIONS` 从"差集"改为**显式冻结
   集合**（`frozenset`，逐 op 列出），并加模块级断言：`PATCH_OPERATIONS` 新增
   op 未显式列入或排除时，`apply_in_memory` 域校验直接拒绝（现状已是拒绝，
   断言改为**导入期 fail-fast**：白名单 ⊆ PATCH_OPERATIONS，防无声漂移）。
   语义裁决：**准入制**——新 op 必须"显式列入白名单 + schema + 字段清单"
   三处同步才算 AI 可用（本门 §2 定纪律）。
2. **存量对齐（白-2）**：白名单 24 种按 §2 分层裁决处置：
   - **晋升（12 种）**：转场三件套（add/update/remove_transition）、字幕样式
     （set_caption_style/clear_caption_style）、关键帧（set_clip_keyframes/
     clear_clip_keyframes）、transform/mask/keying 五件套、clear_clip_keyframes
     ——全部为**片段/字幕/转场内的效果与属性操作**，apply 校验完整、无结构
     增删、无来源绑定，与既有白名单 op 同风险级。晋升 = 补齐 §1.3 的契约。
   - **维持排除（9 种）**：结构性排除清单不变（新增素材/转录插入/字幕导入
     = 来源绑定与内容注入；轨道增删移 = 结构变更；锁定 = 用户意图保护）。
   - **补排除（3 种候选，实裁）**：`add_caption`（需要人工文本创作，AI 添加
     字幕属质量风险且 egress 无对应文本来源——维持排除，仅从"顺手排除"
     变为"显式裁决排除"）。
3. **契约补齐（白-3）**：`TIMELINE_PATCH_OPERATIONS_SCHEMA` 补 3 种存量缺口
   （position_clip/set_speed/set_reverse_playback）+ 12 种晋升 op 的
   oneOf 分支（严格字段枚举，对齐 `_operation_schema`）；`_PATCH_FIELDS`
   同步 15 种；字段清单注入提示词自动跟随（167692e 机制）。
4. **提示词升级（白-4）**：patchscript instructions 补一句"op 必须取自
   payload.allowed_operations"（把允许域显式交给模型，替代隐式猜测）。
5. **单测（白-5）**：白名单导入期断言；新 op 经 apply_in_memory(ai=True)
   逐 op 沙盒通过/拒绝用例；schema/字段清单与白名单一致性断言（三处同步
   由测试钉死）；json_schema 适配器输出新增 op 的端到端解析用例。

### 明确不做（边界）

- **Desktop/UI 改动**：AI 助手面板与确认页无操作级 UI，契约无新字段
  （PROTOCOL_VERSION 不动），零改动。
- **add_caption 加入白名单**：维持排除（见 §1.2），待"AI 生成字幕文本"
  有产品裁决再议。
- **轨道类操作白名单化**：结构性变更维持排除。
- **每个 op 的探测场景扩展**：probe 固定 set_layout 场景不变（探测验证
  的是"provider 能遵循结构化协议"，非逐 op 能力）。
- **candidatescript 侧扩容**：候选生成的 op 域是独立 schema
  （op/variant/segment_refs），不在本单。

## 2. 设计要点（纪律裁决）

- **三处同步纪律**：白名单准入 = `AI_PATCH_OPERATIONS` 显式列入 +
  `TIMELINE_PATCH_OPERATIONS_SCHEMA` oneOf 分支 + `_PATCH_FIELDS` 条目，
  三者由一致性单测钉死；缺一即测试红。**这是本单的核心产出**——把
  "隐性自动准入"改为"显式三处同步准入"。
- **晋升风险面**：12 种晋升 op 的共同特征 = 操作对象已存在（clip/caption/
  transition id 引用），失败模式 = 引用不存在/参数域非法，全部被
  `_exact_keys` + 域校验 + `_structured_failure` 结构化反馈覆盖；会话失败
  对用户零副作用语义（无 partial Revision）不变。
- **feedback 兼容**：新增 op 失败同样走既有结构化反馈通道
  （`_structured_failure` 产 op 序号/字段），反馈注入机制零改动。
- **expedited prompt 风险**：字段清单变长（15 op × ~3 字段）使 system
  prompt 增加约 500 字符——deepseek 实测（2026-09-21 复跑）在此量级下
  收敛良好，不做分页/裁剪设计。

## 3. 验收（LiuKeAi）

1. **单测（Core）**：
   - 白名单显式冻结 + 导入期断言（构造漂移场景验证 fail-fast）；
   - 12 种晋升 op 的 ai=True 沙盒用例（各至少 1 通过 + 1 拒绝路径）；
   - 三处同步一致性测试（白名单 ⊆ schema ops = 字段清单 keys）；
   - patchscript 端到端：含 add_transition 的响应经 parse → validate →
     apply 全链成功；json_schema 端到端同；
   - 3 种存量缺口 op（position_clip/set_speed/set_reverse_playback）经
     json_schema 输出路径可用。
2. **集成**：真实 deepseek（复用验证脚本）实验 C 扩展指令
   （"剪短并加一个转场"）跑通两步会话。
3. **回归**：Core + Desktop 全量全绿；既有 candidate 链路（独立 schema）
   不回归。
4. **契约**：PROTOCOL_VERSION 不动；sent_fields 如实（allowed_operations
   白名单自动反映）。
5. **文档**：AI-1 规划门"13 种"记载由本单替换为准入纪律 + 显式清单。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 晋升 op 扩大模型误操作面（如错误 remove_transition） | 反馈重试机制本就覆盖；会话步数/token 双闸门；失败零副作用 |
| schema 变长降低 json_schema 适配器遵循度 | 实测 deepseek 在 patchscript 15-op 清单量级收敛良好；json_schema 由网关强约束 |
| 字段清单 prompt 膨胀 | ~500 字符增量，实测无影响；不做动态裁剪（可预测性优先） |
| 白名单漂移复发 | 导入期 fail-fast 断言 + 三处同步测试双保险 |

## 5. 开放问题（实施前裁决，ZhangSan）

- `set_clip_transform/mask/keying` 的数值域较宽（如坐标/颜色），反馈重试
  收敛性是否需要专项用例——倾向并入白-5 常规用例，实测后定。

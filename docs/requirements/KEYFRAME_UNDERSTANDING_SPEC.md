# W3.3 Layer 2 云端关键帧理解 · Planning Gate

> **状态**：2026-10-21 起草 → **同日独立评审（LiuKeAi）「需修改后批准」并完成 9 项修订**，**待用户批准**（未批准前不得开工实现）。
> **评审记录**：见本文件 §9（逐条 M1–M9 + R9/R10 处置对照）。
> **上游**：\`AI_CAPABILITY_MASTER_PLAN.md\` §6 W3.3（U8，P1）/ §4 D2（P0 差异化）/ ADR-0003 D4（硬承诺）。
> **本门裁的是**：帧级 egress 审计的形态、vision 能力面、打标数据模型、抽帧策略、质量口径。
> **本门不裁**：帧标签是否接入粗剪召回（属后续独立门，见 §2.2）。

---

## 0. 现状走读（代码级，2026-10-21）

**每条标注证据强度**：✅ 已复算 / ⚠️ 未取证。评审已抽验 11 条（见 §9），本表按评审意见修订。

| # | 事实 | 证据 | 强度 |
|---|---|---|---|
| 0.1 | **Provider 侧零 vision 能力** | \`providers.py\` 对 \`image_url\` / \`input_image\` / \`multimodal\` / \`vision\` **零命中**；请求体 user content 一律 \`json.dumps(...)\` 字符串（\`:952\`、\`:1100\`、\`:1185-1190\`） | ✅ |
| 0.2 | **既有"图片"能力是文生图，不是图生文** | \`provider_images.py:22-23\` \`kind=apikey_fun_images\` / \`IMAGE_ADAPTER_ID="apikey_fun_images_sse_v1"\`（生成方向） | ✅ |
| 0.3 | **抽帧现成，但产物是 rawvideo 且尺寸钉死 224** | \`semantic_service.py:102-118\` \`select='eq(pict_type,I)+gte(t-prev_selected_t,间隔)',scale=224:224\` + \`-fps_mode vfr -f rawvideo -pix_fmt rgb24 pipe:1\`；\`CLIP_IMAGE_SIZE=224\`（\`:72\`） | ✅ |
| 0.4 | **生产代码无 JPEG/PNG 编码路径** | 编码点仅在 \`tools/prototypes/stage4d_provider_image_model.py:136-137\`（原型）。核查词含 \`mjpeg\` / \`image2pipe\` / \`-f image2\` / \`encode("png")\` / \`PIL\` / \`imageio\`。**注**：\`provider_image_generation.py:808\` 写 \`.png\` 是**下载落盘**，非编码 | ✅ |
| 0.5 | **PyAV 已声明为依赖；mjpeg 编码器在开发环境可用** | \`pyproject.toml:14\` \`av>=18,<19\`；本机 \`av 18.1.0\`，\`av.CodecContext.create('mjpeg','w')\` → \`'mjpeg'\` 实跑成功。**⚠️ 但打包形态未证**：本机 \`av\` 包目录内 **bundled libs = 0**，PyInstaller spec（\`aivs-core.spec:7-9\`）\`binaries=[] datas=[] hiddenimports=[]\` ⇒ **不得声称"零新增运行时依赖已证"**，见 §4 A13 | ⚠️ |
| 0.6 | **egress preview 有成熟范式可抄** | \`captions_provider_egress.py\`：\`prepare\`:141 / \`create\`:180 / \`claim_for_runner\`:313；job 原子落库 \`:222-242\`；consent 原子消费 \`:336\` | ✅ |
| 0.7 | **既有契约是文本级，无帧级字段** | \`packages/contracts/src/index.ts:554-557\` \`EgressPreview.stats\` 恰为 \`{transcript_count, segment_count, character_count, estimated_tokens}\` | ✅ |
| 0.8 | **场景切点信号已就绪** | \`cv_signals.py:69\` \`SCENE_CUT_DISTANCE=0.45\`；\`:144/:149\` 逐样本 \`scene_cut\` 布尔 | ✅ |
| 0.9 | **适配器阶梯 + 能力探测是既有机制，探测落库六列** | \`providers.py:16/37/50\` 三族 \`*_ADAPTER_IDS\`；\`captions_provider_egress.py:45 test_capability\`，落库 **六列**（含 \`capability_tested_at\`，\`:120-125\`），且 \`:136 _require_capable\` 的放行门禁**依赖该时效列** | ✅ |
| 0.10 | **迁移 39 个，最新 v39** | \`database.py:923-963\` = v1..v39；\`database_v39.py:14-17\` = \`asset_semantic_index\` | ✅ |
| 0.11 | **语义检索面板与 IPC 已存在** | \`SemanticSearchPanel.tsx\`（222 行）；\`preload/index.ts:220-221\`；契约 \`index.ts:1784\` | ✅ |
| 0.12 | **restricted-media 票据基建可用** | \`main/index.ts:29 / :426 requireAssetTicket / :1032 protocol.handle\` | ✅ |
| 0.13 | **多模态与 strict \`json_schema\` 能否并用——未取证** | 既有三族均靠 \`body["response_format"] = {"type":"json_schema",…}\`（\`providers.py:956\`、\`:1193\`）。图片内容块与该参数**同时**使用的行为无任何实测 | ⚠️ |

**由 0.1 + 0.4 + 0.13 得出的关键判断**：W3.3 不是"把已有能力接上网络"，而是**从零新建三条能力**——
① 多模态请求体构造；② 图片编码与帧级外传审计；③ **多模态下的结构化输出约束**（0.13）。
第三条是评审补上的，此前被低估：若 strict \`json_schema\` 与图片不可并用，D5 的受控词表只能退化为**后处理解析**，违规率会显著升高。

---

## 1. 已裁决事项（D1–D8）

用户 2026-10-21 逐项裁决，全部为选项 A。

| # | 事项 | 裁决 | 一句话理由 |
|---|---|---|---|
| **D1** | 打标结果交给谁消费 | **本包内置最小可见面**：语义检索面板按标签过滤/展示命中帧标签 | 反例在案：\`BeatGridService\` 曾零调用方 ⇒ \`beat_grids\` 生产永远为空、卡点必失败（STATUS §5）。只落表不建消费面 = 重演同一失败模式 |
| **D2** | Provider 是否有可用 vision 模型 | **有**，按完整交付：vision 适配器 + 探测 + **真实打标端到端** | 用户确认网关具备多模态模型。**⚠️ 该确认无取证记录**，风险全部压在 S3/S4，处置见 §5 R11 与 §4 A10 的关门路径 |
| **D3** | 打标质量口径 | **结构正确性 + 小样本人工盲评**，并显式声明"质量未证" | 本仓已因"给不存在的真值拍判据"翻车 7 次（W2.2 S1/ARI/τ、P147 融合排序）。照 P147 处理 |
| **D4** | 逐张审计形态 | **逐张可见 + 可单张移除，同意后整批发** | 满足 ADR-0003 D4「可逐张审阅」字面要求；"必须点 N 次同意"会诱导无脑全选，反降低审计真实度。**实质合规性由新增 A12 保证**（见 M5） |
| **D5** | 标签体系 | **受控词表 + 自由文本备注双列** | 过滤走词表（可索引、可聚合），新奇描述进备注列不丢信息；词表版本化，照 P148 纪律 |
| **D6** | 人工盲评归属 | **我产出离线盲评包**（图片 + 评分表 + 统计脚本），用户事后评；门里登记为"已交付工具、评分待完成" | 不把收口时间绑在用户档期上；评分口径**先预登记后看数**（M4） |
| **D7** | 抽帧策略 | **场景切点优先 + 间隔兜底，每素材封顶 N=24** | 复用既有 \`scene_cut\` 信号（零新增分析成本）；长镜头靠间隔兜底，短镜头不漏 |
| **D8** | 帧分辨率 | **长边 768px，JPEG q85** | VLM 打标可用档位；比原图少一个数量级外传体积。**⚠️ 这不等于匿名化，见 R1** |

---

## 2. 范围

### 2.1 本门批准的

1. **帧级 egress preview**：新建 \`keyframe_egress_preview\` 语义——逐帧元数据 + 缩略图 + 逐张移除 + 可审计；**复用 \`prepare → create → claim\` 三段式**（0.6），不新造流程。
2. **vision 适配器族**：新增 \`VISION_ADAPTER_IDS\` 阶梯（接入既有三族同款机制，0.9），首档为多模态 chat completions 图片内容块。
3. **vision 能力探测**：照 \`test_capability\` 范式落 **六列**——\`vision_capability_status / vision_response_adapter_id / vision_probe_protocol_version / vision_capability_tested_at / vision_capability_failure_code / vision_capability_probe_sha256\`（含\`tested_at\`，因放行门禁依赖其时效，见 0.9）。
4. **受控词表**：版本化词表文件（放 \`resources/\`），v1 起版并显式标注"未经验证"。
5. **打标存储**：迁移**下一个可用版本号**（当前 \`MIGRATIONS\` 最大 v39，v40 未被占用；**实现时以 \`MIGRATIONS\` 实际值为准**，不在本文档写死）；**照 v39 范式**（\`algorithm_version\` 行化 + 指纹入唯一键 + 读时 stale + **ON DELETE CASCADE**——P102 反例警示）。
6. **Desktop 最小可见面**：\`SemanticSearchPanel\` 增加按标签过滤与命中帧标签展示（D1）。
7. **离线盲评包**：图片 + 评分表 + 统计脚本，**评分口径先预登记**（D6/M4）。
8. **默认路径零变化**：未开启 Layer 2 的用户，行为与今日**逐字节相同**（A8）。

### 2.2 明确**不在**本门范围

- **帧标签接入粗剪召回排序**——撞 P147「无 ground truth」同一堵墙，须另立门（总纲 W3.4 地带）；
- **视频原片外传**——ADR-0003 明令"传静态关键帧，不传视频"，不重新讨论；
- **默认开启 / 静默上云**——D4 硬承诺，削弱提案在 Planning Gate 直接否决；
- **本地 VLM（Layer 1）**——ADR-0003 D3 已判继续搁置（总纲 W3.2）；
- **打标质量优越性断言**——见 D3 与 §4 A9；本门不承诺；
- **既有三族适配器（timeline_patch / candidate / captions）的任何行为变更**。

---

## 3. 设计要点（冻结项）

### 3.1 帧级 preview 生命周期（照 0.6 范式）

\`\`\`
prepare  → 逐帧解码 → JPEG 载荷 + 独立缩略图 → payload_sha256
         → 落 preview 行（逐帧元数据 + expires_at）→ 返回逐帧清单
[用户逐张审阅；可移除任意帧 ⇒ 记入 excluded_frames]
create   → 原子落 consent + generation + invocation + job（被移除帧不入最终载荷）
claim    → 原子消费 consent；此后才允许发起网络调用
\`\`\`

**四条不变量**（各有测试，见 §4）：

- **I-1 未消费 consent 不得发网络**：任何网络调用前必须先成功 \`claim\`，探测路径同理。
- **I-2 payload 必须可复算**：\`payload_sha256\` 由**实际发送的帧集合**决定。
- **I-3 移除生效于真实载荷**：不是 UI 装饰。
- **I-4 审计保真（新增，M5）**：preview 呈现给用户的每帧 \`frame_sha256\` / \`jpeg_bytes\` / 尺寸，必须**逐帧等于**实际外传的字节。

### 3.2 逐帧元数据

每帧至少：\`frame_index\`、\`timestamp_us\`、\`source_reason\`（\`scene_cut\`/\`interval\`）、\`width\`、\`height\`、\`jpeg_bytes\`、\`frame_sha256\`、\`thumbnail_ref\`。

**为什么必须给 \`jpeg_bytes\` 与真实尺寸**：A6 要求成本可见是**实测数字**，不是推算 token（P159 已因"注释里的推算当实测"翻过车）。

**缩略图与载荷分离**：呈现用缩略图**不得等于**外传 JPEG（更低分辨率/更高压缩比），否则形成"看到的比发出去的小"的误导性审计。两者关系由 A12 锁定。

### 3.3 抽帧策略（D7，判据已按 M2 冻结）

1. 有 \`cv_analyses\`（\`scene_cut\` 可用）⇒ 记切点数 \`k = scene_cut_count\`：
   - **k ≤ 24**：preview **必须包含全部 k 个切点帧**（每个切点取其首帧），再用间隔补齐至 24；
   - **k > 24**：先覆盖全部切点（按时间升序取前 24 个切点帧），**不做间隔补齐**；
   - \`stats.covered_scene_cuts\` **必须等于** \`min(k, 24)\`。
2. 无 CV 分析 ⇒ 降级**纯间隔**，\`stats.sampling_mode='interval_only'\`，**不得静默假装走过切点路径**。
3. 素材无视频流 ⇒ \`unavailable(no_video)\`，不登记必然失败的作业（P76 教训）。

### 3.4 受控词表（D5，判据已按 M3 冻结）

- 词表为**版本化数据文件**（\`vocabulary_id\` + \`vocabulary_version\` 入行，不得内联魔数）；
- 模型输出被约束为词表内标签（走适配器阶梯与 schema 校验）；
- **词表外标签一律改道 \`notes\` 自由文本列**（不丢弃、不静默改写成最近类），并计入 \`stats.vocabulary_violations\`；
- **\`vocabulary_violations > 0\` 时落 \`VISION_VOCABULARY_VIOLATION\`**（可诊断，但不阻断落库——否则一次违规丢整帧标签）；
- 词表版本升级不使既有行失效（行自带版本号）；**stale 判定含版本**：词表换代 ⇒ 旧行可重算。

### 3.5 数据模型（两表语义冻结，DDL 留 Design Gate）

| 表 | 语义 | 关键约束 |
|---|---|---|
| \`keyframe_egress_previews\` | 帧级外传预览 + 逐张移除记录 | 状态与 \`expires_at\`；\`excluded_frames_json\` 只增不改（审计记录） |
| \`asset_frame_tags\` | 逐帧打标结果 | \`asset_id\` **ON DELETE CASCADE**（P102）；指纹入唯一键 + 读时 stale；\`vocabulary_id/version\` 入行 |

**stale 口径统一（评审补，P102 同类风险）**：\`asset_frame_tags.source_fingerprint\` **必须与 \`asset_semantic_index.source_fingerprint\` 同源**（\`database_v39.py:20\`），复用同一取值函数；**禁止出现第三套指纹口径**。

**迁移对 STATUS.md 的影响（Rule 2 强制）**：新增迁移 ⇒ \`latest_migration\` 39 → **40**（实现时以实际为准），**必须在同一变更里改 §1**，否则 \`test_status_doc_consistency.py\` 变红。本包**不新增 TimelinePatch op** ⇒ \`patch_operations\` / \`ai_patch_operations\` 不变。

### 3.6 适配器阶梯（D2）

\`VISION_ADAPTER_IDS\` 首档：\`openai_chat_completions_image_url_v1\`——\`content\` 数组内 \`{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}\`。

**发现顺序即优先级**；探测按阶梯逐档实发，失败码落库。**不放"无图"档**（与本功能定义矛盾）。
**不置 \`responses\` 族于首档**：既有注释已实测该族 \`/responses+json_schema\` 返回 502（\`providers.py:47-48\`）。

**⚠️ 0.13 的处置**：若实测图片内容块与 strict \`json_schema\` 不可并用，则本阶梯须增一档"无 \`response_format\` + 受控词表后处理解析"，并把 \`VISION_VOCABULARY_VIOLATION\` 率作为该档的显式统计量上报（不隐藏降级）。

### 3.7 失败码（fail-closed，新增）

\`VISION_PROVIDER_UNSUPPORTED\` / \`VISION_FRAMES_UNMAPPED\` / \`KEYFRAME_PREVIEW_EXPIRED\` / \`KEYFRAME_EGRESS_CONSENT_REQUIRED\` / \`VISION_VOCABULARY_VIOLATION\`。

**纪律**：探测失败**不得**退化为"照样发"；生成失败**不得**留下半套 consent 消费。

### 3.8 存储清理（新增，评审 R10）

preview 表短期持有逐帧 JPEG（24 帧 × 768px 数 MB 级），\`expires_at\` 若只是标记则**必然堆积**——这是 P102"派生数据不清"换形态重现。
**冻结**：\`expires_at\` 到期后**必须实际删除帧载荷**（保留逐帧元数据与哈希以维持审计追溯）；清理由作业/启动期执行，且有测试断言"到期后载荷字节数为 0、元数据仍在"。

---

## 4. 验收

> **每项须配负向对照**（还原实现即红）。判据已按评审 M2/M3/M4/M5 收敛为**单值可判定**，不留"或"。

| # | 验收项 | 判据 | 负向对照 |
|---|---|---|---|
| **A1** | 逐张可见 + 可移除 | preview 返回 N 帧逐帧清单（缩略图引用 + 字节数）；移除第 k 帧后最终载荷不含该帧，\`excluded_frames\` 留记录 | 移除只改 UI 状态不改载荷 ⇒ 红 |
| **A2** | 未同意不发（I-1） | 无 consent / consent 未消费时**零网络调用**；httptest 计数断言 == 0 | 去掉 \`claim\` 前置 ⇒ 调用数 > 0 ⇒ 红 |
| **A3** | payload 可复算（I-2） | 同帧集合两次 prepare 得同一 \`payload_sha256\`；增删任一帧哈希必变 | 哈希只算元数据不含帧字节 ⇒ 红 |
| **A4** | 能力探测 fail-closed | 网关不支持图片内容块 ⇒ 落库 \`unsupported\` + 具体失败码；此后 create 被拒且**零字节外传** | 探测失败仍放行 ⇒ 红 |
| **A5** | 抽帧策略（**M2 收敛**） | \`k≤24\` ⇒ preview 含全部 k 个切点帧且 \`stats.covered_scene_cuts == k\`；\`k>24\` ⇒ 覆盖前 24 个切点、无间隔补齐、\`covered_scene_cuts == 24\`；无 CV 分析 ⇒ \`sampling_mode=='interval_only'\` | 忽略封顶 / 无分析即抛 / 静默走切点路径 ⇒ 红 |
| **A6** | 帧规格与成本可见 | 实测输出长边 768、JPEG q85；preview 呈现**实测** \`jpeg_bytes\` 与总字节数（非推算 token） | 报告推算值而非实测字节 ⇒ 红 |
| **A7** | 词表 + 备注（**M3 收敛**） | 词表外标签**一律**进 \`notes\`（不丢弃、不静默改写）；\`stats.vocabulary_violations\` 计数正确；\`>0\` 时落 \`VISION_VOCABULARY_VIOLATION\`；\`vocabulary_version\` 入行；换代使旧行 stale | 词表校验恒真 / 不记版本 / 丢弃违规标签 ⇒ 红 |
| **A8** | 默认路径零变化 | 未开启 Layer 2 时全部既有路径行为**逐字节不变**（回归锁） | 改动默认分派 ⇒ 红 |
| **A9** | 质量口径诚实（**M4 修订**） | ① 盲评包的判据与统计口径**先于看数预登记入库**（照 \`evidence/2026-10-20-w31-zh-fp32-eval/PRE_REGISTRATION.md\` 范式）；② 对实施记录与门文档做**正则负向检查**：出现"更好/优于/优于单源/质量提升"等优越性表述即失败（白名单语境豁免，照 STATUS.md 一致性测试的修正语境豁免做法） | 预登记缺失 / 优越性表述存在 ⇒ 红 |
| **A10** | 打标端到端（D2，真实） | 真实 provider + 真实素材跑通：帧 → 标签落库 → 检索面板按该标签过滤命中；\`provider_invocations\` 行数 = 调用次数 | 面板读硬编码而非落库数据 ⇒ 红 |
| **A11** | 素材生命周期 | 删素材 ⇒ 打标行随之消失（CASCADE）；素材指纹变更 ⇒ 标签 stale；指纹与 \`asset_semantic_index\` **同源** | 用 NO ACTION ⇒ 复现 P102 FK 拒绝 ⇒ 红 |
| **A12** | **审计保真（新增，M5）** | preview 呈现的每帧 \`frame_sha256\` / \`jpeg_bytes\` / 宽高，**逐帧等于**实际外传字节（从发出的请求体反解并比对） | 展示缩略图属性而外传原图（或反之）⇒ 红 |
| **A13** | **打包后编码可用（新增，0.5）** | 在**打包产物**（PyInstaller 构建）中实跑 mjpeg 编码成功，音频/视频解码路径不受影响；若打包 av 不含 mjpeg 编码器 ⇒ 记录并改用替代编码路径，不得默认成立 | 仅凭开发环境通过 ⇒ 红（必须打包环境证据） |
| **A14** | **载荷到期清理（新增，评审 R10）** | `expires_at` 到期后帧载荷字节**实际删除**（缓存目录字节数为 0），而逐帧元数据与 `frame_sha256` **仍在**；清理责任单一，不得由其他 LRU 代为清理（否则本项会假绿） | 只置标记不删字节 ⇒ 红；依赖既有 LRU 顺带清理 ⇒ 红（须证明是本功能自身清理生效） |

**A9 的边界如实**：本门**不承诺**打标质量优于任何基线，也无基线可言。机器只证结构；质量结论在用户完成盲评前**不存在**。

---

## 5. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| **R1** | **768px JPEG 不等于匿名化**——人脸、室内空间、儿童仍可辨，而目标用户恰是"最排斥默认上云"的人群（ADR-0003 §D4 成本段） | ① 项目级显式 opt-in，默认关闭；② 每张可见；③ **UI 与文档明写"这不是匿名化"**，不得用"抽样关键帧"暗示低风险；④ 打标后拒存原始 JPEG（只存标签与缩略图引用）。**2026-10-21 收口追记**：④ 原实现为「TTL 15 分钟 + 启动期 purge_expired」，打标后无清理 ⇒ 已改为 run_tagging_job 成功/失败两路调 purge_preview，且缩略图不再落盘（元数据保留支撑 A12）；**① 在代码中从未存在**，实际形态为逐次同意 + create fail-closed（更严），按现状核销不另做项目级开关。判据见 `docs/archive/W3_3_VERIFICATION_GATE_2026-10-21.md` §9 |
| **R2** | **vision 能力面从零新建**（0.1/0.4/0.13） | §0 摆在最前；按 §8 切片推进，**S1a/S1b/S2 均不触网** |
| **R3** | **token/带宽成本不可控** | A6 要求 preview 呈现**实测字节**；封顶 24；S2 先测成本再定是否放宽 |
| **R4** | **词表拍脑袋**：v1 无评测依据 | 显式版本化 + 标注"未经验证"；行自带版本 ⇒ 换代可重算；**不声称 v1 覆盖充分** |
| **R5** | **复现 BeatGridService 零调用方** | A10 验收"面板按落库标签过滤"，非"API 存在"；负向对照要求面板真读库 |
| **R6** | **D4 硬承诺被稀释** | A1 + A2 + **A12** 三重回归锁；ADR-0003 已要求 Verification Gate 沿用 D4 检查 |
| **R7** | **帧标签越界用于粗剪召回**（撞 P147） | §2.2 明令不在范围；命名限定 \`asset_frame_tags\`，不进入 candidate/planning 分派 |
| **R8** | **降级路径静默** | A5 要求 \`sampling_mode\` 如实落库 |
| **R9** | **多模态与 strict \`json_schema\` 能否并用未取证**（0.13）——若不可用，受控词表只能后处理解析，违规率显著上升 | 该档作为**显式降级**存在：必测、必报违规率，不隐藏；S3 的首要交付就是回答这个问题的实测 |
| **R10** | **preview 表存数 MB 级 JPEG 却无清理** ⇒ P102 换形态重现 | §3.8 冻结"到期实际删除载荷、保留元数据"，并有断言测试 |
| **R11** | **D2「网关有 vision 模型」为用户口述、无取证** ⇒ A4/A10 可能整体悬空 | 见 §7 关门路径：A4 可借 S3 探测独立关门；A10 若网关不可用则按 Rule 3 **登记为待取证**，不得默认豁免（见 §7） |
| **R12** | **打包形态未证**（av 目录 bundled libs=0，spec 未声明） | A13 强制打包环境证据，不接受开发环境通过 |

---

## 6. 待裁决

**无未决项。** D1–D8 已于 2026-10-21 全部裁决（§1）；**D9 于同日追加并裁决**（见下）。

### 追加裁决 D9（2026-10-21，Design Gate 阶段触发）

**事项**：帧编码路径选型——ffmpeg 子进程 / PyAV 进程内 / 双路可切换。

**裁决**：**走 ffmpeg 子进程**，不实现 PyAV 编码路径。

**为什么不就地拍板**：本条是在 Design Gate 起草中发现的新分叉（本门 §8 S1a 原文写的是「JPEG 编码（PyAV mjpeg）」）。按本节纪律，它**必须回到本门追加**，因此在此登记，不在 Design Gate 内自行生效。

**依据（均为实测，非推断）**：

1. 随包 `resources/ffmpeg/win-x64/ffmpeg.exe` 的 `-encoders` 全量 237 行中第 77 行为 `VFS..D mjpeg`；实跑 `-c:v mjpeg -f image2` 产出合法 JPEG（SOI/EOI 均 True）；
2. 该 ffmpeg 已由 `apps/desktop/electron-builder.yml:15-19` 打包；
3. 与既有抽帧范式一致（`semantic_service.py:102-118` 即 ffmpeg 子进程）。

**⚠️ 本节同时更正本门 §0 事实 0.5 的一处错误立论**：原文写「PyAV `bundled libs=0`、spec 未声明」并据此设 R12/A13。经复核，**当时看的是根目录 `/aivs-core.spec`，而它被 `.gitignore:40` 忽略、不参与构建**；真正的构建 spec 是 `services/core/aivs-core.spec`，其对 `av` 跑 `collect_all` 且 `av.libs/` 实有 25 个 dll。**故「PyAV 打包会挂」这一理由不成立**——ffmpeg 方案的结论仍成立，但理由更换为上述 1–3 条。R12 与 A13 的措辞已相应重写（见 Design Gate §9 / §8），**A13 予以保留**（打包环境证据仍是必要条件，只是风险来源不同）。

**不变更的部分**：D7（切点优先 + 封顶 24）、D8（长边 768 / JPEG q85）**均不变**，本裁决只换编码实现路径。

---

**实施中出现新的分叉，仍须回到本门追加裁决项，不得就地拍板。**

---

## 7. 门禁状态与关门路径

- **Planning Gate：修订完成，待用户批准**；本门**未批准前不得开工实现**。
- 契约变更：**增量**（帧级 preview 类型 + vision 能力六列 + 标签类型），既有类型**零变更**（A8 锁）。
- 迁移：**有**（下一个可用版本号）⇒ 触发 STATUS.md §1 \`latest_migration\` 同步（Rule 2）。
- 新增 egress 面：**一处**（帧级），ADR-0003 允许的 Layer 2 唯一出口。
- 默认行为变更：**无**。

**关门路径（M9，评审要求写死）**：

| 情形 | 处置 |
|---|---|
| 网关**有**可用 vision 模型 | A4 + A10 全项真实验收，正常关门 |
| 网关**无** vision 模型 | **A4 仍可关门**（"探测出 unsupported + 零字节外传"本身就是 fail-closed 的完整证据）；**A10 明确登记为待取证**，按 Rule 3 写入 STATUS.md §4 并注明"不得以 mock 顶替真实端到端"，本门**不得宣称 W3.3 完整交付** |
| 0.13 不成立（图片 + strict schema 不可并用） | 走 §3.6 降级档，A7 违规率成为必报统计量；**不算失败**，但须在实施记录中显式标注 |

---

## 8. 实施切片（供 Design Gate 细化；S1–S2 不触网）

| 切片 | 内容 | 网络 | 可独立验收 |
|---|---|---|---|
| **S1a** | JPEG 编码（PyAV mjpeg）+ 帧规格 768/q85 + 缩略图与载荷分离 | ❌ | ✅ A6 的一半 + A13 |
| **S1b** | 抽样策略（切点优先/间隔兜底/封顶 24/无分析降级） | ❌ | ✅ A5 |
| **S2** | 帧级 preview 契约 + 预览表 + prepare/create/claim 三段式 + 逐张移除 + 存储清理 | ❌ | ✅ A1/A2/A3/A12 + R10 |
| **S3** | vision 适配器族 + 能力探测（六列）+ 失败码 + **0.13 实测** | ✅ 探测 | ✅ A4 + R9 |
| **S4** | 打标落库 + 词表版本化 + stale + CASCADE | ✅ 生成 | ✅ A7/A11/A10 |
| **S5a** | Desktop 按标签过滤（D1） | ❌ | ✅ A10 后半 |
| **S5b** | 离线盲评包 + 预登记 | ❌ | ✅ A9 |

**S1a/S1b/S2/S5a/S5b 均不触网** ⇒ 即使网关当天不可用，六切片的验收仍可独立完成，仅 A10 受影响（§7 已写明关门路径）。

---

## 9. 独立评审处置对照（LiuKeAi，2026-10-21）

**评审结论**：需修改后批准。**本轮处置**：M1–M9 全部采纳，R9/R10 补入 §5，另**自行发现并修订** 0.5 的打包证据缺口（新增 A13/R12）。

| # | 评审意见 | 处置 |
|---|---|---|
| M1 | Rule 3 未履行：STATUS.md §4 零登记 | ✅ 已在 STATUS.md §4 登记（见 P162–P164，含工作包 + R1/R3/R5/R8 风险对策 + D6 未闭环评分） |
| M2 | A5 无阈值不可判定 | ✅ §3.3 + A5 冻结为 \`covered_scene_cuts == min(k,24)\` |
| M3 | A7 "被拒**或**改道"二义 | ✅ §3.4 + A7 冻结为"一律改道 notes + 计数 + >0 落码" |
| M4 | A9 非机器判据 | ✅ 改为"先预登记后看数 + 正则负向检查" |
| M5 | 缺"看到的就是发出去的" | ✅ 新增 I-4 + **A12 审计保真** |
| M6 | v40 预估写成事实 | ✅ 改为"下一个可用版本号，实现时以 MIGRATIONS 为准"（复核：v40 当前未被占用，但不在文档写死） |
| M7 | "五列"漏 \`capability_tested_at\` | ✅ 全文改**六列**，并说明放行门禁依赖该时效列 |
| M8 | 工作量低估 | ✅ S1→S1a/S1b，S5→S5a/S5b |
| M9 | 关门路径缺失 | ✅ §7 新增"关门路径"三行表 |
| R9 | 多模态 + strict schema 未取证 | ✅ 升为事实 0.13 + 风险 R9 + §3.6 降级档 |
| R10 | preview 表无清理策略 | ✅ 新增 §3.8 存储清理（冻结）+ R10 |
| — | 0.4 grep 词太窄 | ✅ 扩至 6 类词，并注明 \`.png\` 落盘非编码 |
| — | 指纹口径可能三分裂 | ✅ §3.5 冻结"与 \`asset_semantic_index\` 同源" |
| — | 0.5 打包未证（评审列为"未能核实"） | ✅ **采纳并升级**：实测 \`av\` 目录 bundled libs=0、spec 未声明 ⇒ 0.5 降为 ⚠️，新增 A13/R12 |

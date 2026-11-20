# W3.3 Layer 2 云端关键帧理解 · Design Gate

> **状态**：2026-10-21 起草 → 同日独立评审「需修改后批准」→ **12 项必须修改全部修订**，**待用户批准**。
> **评审记录**：见 §12（逐条处置）。
> **上游**：`docs/requirements/W3_3_KEYFRAME_UNDERSTANDING_PLANNING_GATE_2026-10-21.md`（已批准，D1–D8 冻结）＋ **同一文件的 §10 追加裁决 D9**（本门触发，已回填规划门）。
> **本门冻结**：DDL、服务签名、契约增量、API/IPC、作业分派、切片、测试清单。
> **本门不裁**：规划门 D1–D8 / A1–A13（已冻结，本门只能细化，不得收窄）。

---

## 0. 本门新增的实测事实

| # | 事实 | 证据 | 强度 |
|---|---|---|---|
| 0.1 | **随包 ffmpeg 带 mjpeg 编码器，实测可编码** | `resources/ffmpeg/win-x64/ffmpeg.exe -encoders` 全量 237 行，第 77 行 `VFS..D mjpeg`；实跑 `-c:v mjpeg -f image2@@ 产出合法 JPEG（SOI/EOI 均 True） | ✅ |
| 0.2 | **该 ffmpeg 已被打包** | `apps/desktop/electron-builder.yml:15-19` → `to: ffmpeg/win-x64`；`electron/main/index.ts:917-918` 传路径 | ✅ |
| 0.3 | **PyAV 已被 collect_all 收进打包链** | **构建用的是 `services/core/aivs-core.spec`**（`tools/packaging/build-sidecar.ps1:9`），其 `:13-27` 对 `av@@` 等 6 包跑 `collect_all` 并写入 `binaries`，`tests/unit/test_bootstrap.py:71` 锁定；`.venv/Lib/site-packages/av.libs/` 实有 **25 个 dll**（`avcodec-62` 等）。根目录 `/aivs-core.spec` **被 `.gitignore:40` 忽略、不参与构建** | ✅（**本门更正**） |
| 0.4 | `ErrorCode` 是开放联合 | `packages/contracts/src/index.ts:155` `typeof ERROR_CODES[number] \| (string & {})` ⇒ 新增失败码**零契约变更** | ✅ |
| 0.5 | `JobKind` 封闭，**且运行期另有 `JOB_KINDS` 常量数组** | `index.ts:65` union（18 成员）＋ `:1425 JOB_KINDS` ＋ `:1521 isJobKind` ＋ `:1877 parseJob` ⇒ **新增 kind 必须同时改 union 与数组**，否则 `parseJob` 直接拒绝 | ✅ |
| 0.6 | 既有抽帧是 ffmpeg 子进程范式 | `semantic_service.py:102-118` `rgb_frames_args()`；`:497 _decode_frames` | ✅ |
| 0.7 | v39 注册方式 | `database.py:39 / :89 / :962` | ✅ |
| 0.8 | **既有 egress preview 一律不可变 + 无 CASCADE** | `database.py:332-333` `egress_previews_no_update/no_delete` 触发器；`:325 idx_previews_expiry`（`expires_at` 建了索引）；`database_v28.py:8/13` `provider_config_id REFERENCES provider_configs(id)` 且 `payload_sha256 NOT NULL` | ✅ |
| 0.9 | **`provider_invocations` 无 keyframe 归属列** | `database.py:307-317` 只有 `candidate_generation_id`；`A10` 要求「`provider_invocations` 行数 = 调用次数」，须加列才能断言 | ✅ |
| 0.10 | **`derived_cache` 的 KINDS 硬编码 4 类 + LRU 会独立删字节** | `media/derived_cache.py:27` `KINDS=("video_proxy","waveform","audio_pcm_chunk","reverse_chunk")`；`:319-340 enforce_disk_budget` 按 LRU 清理 | ✅ |

### 0.11 ⚠️ 更正记录：两处「把截断/合成结果当全量结论」

**其一（本门自曝）**：查 ffmpeg 编码器时用了 `-encoders | grep -iE 'mjpeg|jpeg' | head -5`，`mjpeg` 排在第 6 位被截断 ⇒ 误判「无 mjpeg」。

**其二（评审查出，比其一更严重）**：事实 0.3 原写「PyAV `bundled libs=0`、spec 未声明」——但**我看的是根目录 `/aivs-core.spec`，而它被 `.gitignore:40` 忽略、根本不参与构建**。真正的构建 spec 对 av 跑 `collect_all`，`av.libs/` 有 25 个 dll。**我据此写出的 R12/A13 立论整体是错的。**

**教训**：两次都是「只看了手边的那个文件/那几行，就下了全局结论」。前者是输出截断，后者是**看错了对象**。本仓同类前科：P159（注释推算当实测）、P65（正文复述绕过校验）、P116（347MB 读数当单模型占用）。

**处置**：0.3 已重写；**ffmpeg 编码方案的结论不变，但理由换了**——不再是「PyAV 打包会挂」，而是「ffmpeg 已在打包链且实测可用、与既有抽帧范式一致」。

### 0.12 帧字节的真实量级（更正 R3 的量级假设）

| 输入 | 输出 |
|---|---|
| 1920×1080 → 长边 768 | **24,411 B** |
| 1280×720 → 768×432 | **25,947 B** |
| 1080×1920（竖屏）→ 长边 768 | **29,986 B** |
| 纯色 64×64（合成） | 248 B（**即本门旧稿引用的数字**） |

**结论**：真实关键帧约 **24–30 KB/帧**，24 帧 ≈ **0.6 MB/素材**。旧稿「24 帧 × 768px 数 MB 级」**高估一个量级**。但 **248 B 是纯色合成帧**，不代表真实素材——引用它本身是「合成结果当全量结论」的第三种形态，一并更正。

---

## 1. 编码路径（D9，**已在规划门 §10 追加裁决**）

**裁决：走 ffmpeg 子进程编码，不实现 PyAV 编码路径。**

| 选项 | 结论 | 依据 |
|---|---|---|
| ffmpeg 子进程 | ✅ **采用** | 0.1 实测可用 + 0.2 已打包 + 0.6 与既有抽帧范式一致 |
| PyAV 进程内 | ❌ 不采用 | **不是**因为打包会挂（0.3 已证伪该理由），而是：与既有抽帧范式不一致、需额外维护进程内编码路径、且 ffmpeg 方案的证据链更短 |
| 双路可切换 | ❌ 不采用 | 翻倍工作量，本仓无先例；YAGNI |

> **纪律遵守**：规划门 §6 写明「新分叉须回本门追加裁决，不得就地拍板」。本裁决**已作为 §10 追加项回填到规划门**，不在 Design Gate 内自行生效。

**A13 证据形态**：打包产物中 `ffmpeg/win-x64/ffmpeg.exe` 存在、`-encoders` 含 mjpeg、且编码成功。**仍须实测**（不得因源码树通过而推断）。

---

## 2. 数据模型（迁移 v40）

**版本号**：当前 `MIGRATIONS` 最大 v39；`v40` 未被占用。**实现前须重查**，冲突即顺延并同步 STATUS §1。

### 2.1 `keyframe_egress_previews`

```sql
CREATE TABLE IF NOT EXISTS keyframe_egress_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),   -- 评审#6①：补 FK
  source_fingerprint TEXT NOT NULL,
  model_id TEXT,
  model_revision TEXT,
  payload_sha256 TEXT NOT NULL,                                      -- 评审#6③：NOT NULL
  frames_json TEXT NOT NULL DEFAULT '[]',
  excluded_frames_json TEXT NOT NULL DEFAULT '[]',
  sampling_mode TEXT NOT NULL CHECK(sampling_mode IN ('scene_cut','interval_only')),
  covered_scene_cuts INTEGER NOT NULL DEFAULT 0,
  total_frame_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  payloads_purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyframe_previews_asset
  ON keyframe_egress_previews(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyframe_previews_expiry

  ON keyframe_egress_previews(expires_at);                           -- 评审#6②：purge 不全表扫
```

**关键语义（评审 #7 后重定）**：

- **不设 **`ON DELETE CASCADE`**：既有外传审计表一律「不可变 + 无 CASCADE」（0.8）。外传审计**不得**随素材删除而消失。
- 但 P102 的「分析行阻塞素材删除」陷阱必须避开 ⇒ **外传审计的持久证据写进 **`provider_invocations`**（无 CASCADE，同既有审计表），本表只是**载荷载体**：
  - 素材删除时本表行**保留**（`NO ACTION`），但 `purge_expired` 会在到期后清掉字节；
  - **素材删除路径必须显式处理本表**（见 §3.6 `detach_asset`），把 `asset_id` 置 NULL 并落 `detached_at`，从而既不丢审计、也不阻塞删除。
- `excluded_frames_json` 只增不改（D4 审计）。
- `payloads_purged_at` 支撑 A14。

```sql
-- 追加列（评审 #7 配套）
ALTER TABLE keyframe_egress_previews ADD COLUMN detached_at TEXT;
```

> 实现时并入上面的 CREATE TABLE（迁移里不写 ALTER，此处仅为语义展示）。

### 2.2 `asset_frame_tags`

```sql
CREATE TABLE IF NOT EXISTS asset_frame_tags (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  vocabulary_id TEXT NOT NULL,
  vocabulary_version INTEGER NOT NULL CHECK(vocabulary_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable','failed')),
  reason TEXT,
  frame_index INTEGER NOT NULL,
  timestamp_us INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  provider_config_id TEXT REFERENCES provider_configs(id),
  generation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_frame_tags_asset
  ON asset_frame_tags(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_frame_tags_ready
  ON asset_frame_tags(asset_id, source_fingerprint, algorithm_version, vocabulary_version, frame_index)
  WHERE status = 'ready';
```

- **CASCADE 保留**：打标结果是**派生分析数据**（与 `asset_semantic_index` 同类，非外传审计），随素材删除正确（P102 的正确处置形态）。
- `source_fingerprint` **与 `asset_semantic_index` 同源**，禁止第三套口径。

### 2.3 `provider_invocations` 增列（评审 #10）

```sql
ALTER TABLE provider_invocations ADD COLUMN keyframe_generation_id TEXT;
```

**理由**：A10 要求「`provider_invocations` 行数 = 调用次数」可断言，而现有表只有 `candidate_generation_id`（0.9）。不加列则该验收项**无法机器判定**。

### 2.4 帧字节存放（评审 #12 后重定）

**不落库 BLOB**，落**独立目录 **``data/keyframe-cache/<preview_id>/`````（**不复用 `derived_media_cache`**）。

**为什么不用既有 derived_cache**（评审 #12）：
1. `KINDS` 硬编码 4 类（0.10），扩类要改既有模块契约；
2. `enforce_disk_budget` 的 **LRU 会独立删字节**（0.10）⇒ 「到期后字节数 >0 即红」的 A14 断言会**因 LRU 抢先清理而假绿**。

**独立目录的清理责任单一**：只有 `purge_expired` 会删它，因此 A14 的断言**不会假绿**。目录纳入安装包卸载清理范围，另在 Core 启动期做一次孤儿目录清扫。

### 2.5 与 STATUS.md 联动（Rule 2）

`latest_migration` **39 → 40**，同一变更内完成。**不新增 TimelinePatch op** ⇒ `patch_operations` / `ai_patch_operations` 不变。

---

## 3. 模块与服务签名

### 3.1 `media/keyframe_encode.py`（纯本地）

```python
JPEG_LONG_EDGE = 768
JPEG_QUALITY = 3          # ffmpeg -q:v 3（≈ JPEG q85）
MAX_FRAMES = 24

def select_frame_timestamps(
    scene_cuts_us: list[int], duration_us: int, *, interval_us: int, limit: int = MAX_FRAMES,
) -> tuple[list[tuple[int, str]], str, int]:
    """返回 ([(timestamp_us, source_reason)], sampling_mode, covered_scene_cuts)。
    D7/规划门 §3.3 冻结：k<=limit 全切点+间隔补齐；k>limit 取前 limit 个切点不做补齐；无切点 interval_only。
    纯函数无 I/O ⇒ A5 边界可直接构造（k=0/1/24/25/100）。
    """

def jpeg_args(input_path: str, timestamp_us: int) -> list[str]:
    """ffmpeg argv：单帧 → JPEG、长边 768 → stdout。
    scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'  （-2 保偶数且保宽高比）
    实测：1920x1080→24411B；1280x720→768x432/25947B；1080x1920→29986B。
    """

async def encode_frames(ffmpeg: Path, input_path: Path, plan, *, cancel_event=None) -> list[EncodedFrame]:
    """EncodedFrame: payload_bytes / payload_sha256 / width / height / thumbnail_bytes / thumbnail_sha256 / timestamp_us / reason。"""
```

**编码确定性**（评审建议）：`jpeg_args` 的输出**必须**与 ffmpeg 版本、`-q:v` 值、scale 表达式一起计入 `payload_sha256` 的复算依据；A3 的两轮复算须固定同一 ffmpeg 二进制（实测同参两次同 sha256）。

### 3.2 `keyframe_egress.py`（服务层）

```python
class KeyframeEgressService:
    def prepare(self, project_id, asset_id, provider_config_id, *, interval_us) -> dict:  # 无网络
    def exclude_frames(self, project_id, preview_id, frame_indices) -> dict:             # 无网络，重算哈希
    def create(self, project_id, preview_id, payload_sha256, jobs=None) -> dict:         # 原子四件套
    def claim_for_runner(self, project_id, generation_id) -> dict:                       # 原子消费 consent
    def purge_expired(self) -> int:                # 到期删字节、留元数据
    def detach_asset(self, asset_id) -> int:       # 素材删除时置 asset_id=NULL + detached_at
```

**不变量映射**：

| 不变量 | 落点 |
|---|---|
| I-1 未消费 consent 不得发网络 | `claim_for_runner` 是唯一放行点；**能力探测（`vision-capability`）同样是网络调用，必须走 prepare→create→claim 三段式**（评审 #4） |
| I-2 payload 可复算 | `prepare` 与 `exclude_frames` 均重算，**含帧字节**，且绑定编码参数（§3.1） |
| I-3 移除生效于真实载荷 | `create` 依 `excluded_frames_json` 过滤后再算最终载荷 |
| I-4 审计保真 | `frames_json` 的 `payload_sha256` / `payload_bytes` 由**实际外传字节**计算 |

### 3.3 `providers.py`：`VISION_ADAPTER_IDS`

```python
VISION_ADAPTER_IDS = ("openai_chat_completions_image_url_v1",)
VISION_ADAPTER_ID = "openai_chat_completions_image_url_v1"
def vision_adapter_supported(adapter_id: str | None) -> bool: ...
```

内容块：`{"role":"user","content":[{"type":"text",...},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}]}`

**0.13 处置**：S3 首要交付即实测「图片 + strict `json_schema`」能否并用。不可用 ⇒ 增第二档 `..._text_v1`（无 `response_format`，词表后处理），并必报违规率。

### 3.4 失败码（`ErrorCode` 开放联合，零契约变更，0.4）

`VISION_PROVIDER_UNSUPPORTED` / `VISION_FRAMES_UNMAPPED` / `KEYFRAME_PREVIEW_EXPIRED` / `KEYFRAME_EGRESS_CONSENT_REQUIRED` / `VISION_VOCABULARY_VIOLATION`

### 3.5 作业分派（评审 #8 + 建议）

新增 kind `"keyframe_tagging"`。**三处必须同时改**：
1. `contracts/index.ts:65` `JobKind` union ＋ **`:1425 JOB_KINDS` 数组**（漏改则 `parseJob:1877` 拒绝）；
2. `jobs.py` 分派（照 `semantic_index` 的 `if row["kind"] == ...` 形态，**是 `if` 不是 `elif`**）；
3. `job_scheduler.py` `KIND_POLICIES` 显式登记 `JobPolicy("keyframe_tagging", ("light",), 2)`——**未登记即落 unknown ⇒ 保守独占 heavy**，与同类派生作业档位不一致。

### 3.6 清理（R10 / 评审 #12）

- `purge_expired()`：`expires_at < now AND payloads_purged_at IS NULL` ⇒ 删独立目录字节、置 `payloads_purged_at`、**保留元数据与哈希**。触发：启动期一次 + 每次 `prepare` 后。
- `detach_asset(asset_id)`：素材删除前调用，置 `asset_id=NULL` + `detached_at` ⇒ 不阻塞删除（避开 P102），审计留存。

---

## 4. 契约增量

**逐帧必须有「两套」字节字段**（评审 #5）——否则规划门 §3.2「缩略图 ≠ 外传 JPEG」无法表达，A12 的负向对照**没有可变红的字段**：

```ts
export type KeyframeEgressPreviewId = string & { readonly __brand: "keyframe_egress_preview_id" };
export type KeyframeGenerationId    = string & { readonly __brand: "keyframe_generation_id" };

export interface KeyframePreviewFrame {
  frame_index: number; timestamp_us: number;
  source_reason: "scene_cut" | "interval";
  // 将外传的载荷（A12 比对基准）
  payload_width: number; payload_height: number;
  payload_bytes: number; payload_sha256: string;
  // 仅用于展示的缩略图（必须 ≠ 载荷）
  thumbnail_width: number; thumbnail_height: number;
  thumbnail_bytes: number; thumbnail_sha256: string; thumbnail_ref: string;
}

export interface KeyframeEgressPreview {
  keyframe_egress_preview_id: KeyframeEgressPreviewId;
  provider: { display_name: string; origin: string; model: string };
  frames: KeyframePreviewFrame[];
  excluded_frames: number[];
  sampling_mode: "scene_cut" | "interval_only";
  covered_scene_cuts: number;
  total_frame_bytes: number;          // 实测外传字节合计（A6）
  payload_sha256: string; expires_at: string;
}

export interface FrameTag { frame_index: number; timestamp_us: number; labels: string[]; notes: string | null; }
export interface AssetFrameTagsSummary {
  asset_id: AssetId; status: "ready" | "unavailable" | "failed" | "stale" | null;
  reason: string | null; vocabulary_version: number | null;
  tags: FrameTag[]; vocabulary_violations: number;
}
```

**改契约的两处**：`JobKind` union ＋ **`JOB_KINDS` 数组**（评审 #8）。两者都是**新增成员**，不改既有成员 ⇒ 旧客户端不受影响。
**校验函数**：照 `parseSemanticIndexSummary` 范式各配 `parse*`。

---

## 5. API / IPC

### 5.1 Core 路由

| 方法 | 路径 | 网络 | 是否须先 claim |
|---|---|---|---|
| POST | `/api/v1/projects/{p}/assets/{a}/keyframe-preview` | ❌ | — |
| POST | `/api/v1/projects/{p}/keyframe-preview/{id}/exclude` | ❌ | — |
| POST | `/api/v1/projects/{p}/keyframe-preview/{id}/create` | ❌ | — |
| GET | `/api/v1/projects/{p}/assets/{a}/frame-tags` | ❌ | — |
| GET | `/api/v1/projects/{p}/frame-tags?label=&limit=` | ❌ | — |
| POST | `/api/v1/providers/{id}/vision-capability` | ✅ | **✅ 必须先 prepare→create→claim**（评审 #4） |

### 5.2 Desktop IPC（照 `semantic:index` 范式，`stage2b-ipc.ts:303`）

`keyframe:preview` / `keyframe:exclude` / `keyframe:create` / `keyframe:tags` / `keyframe:filter` / `provider:vision-capability`

### 5.3 UI（D1 最小可见面）

`SemanticSearchPanel.tsx`：①「按标签过滤」下拉；② 命中帧标签 chip。**不新增面板**（避免 P156「做了但没挂载」）。

---

## 6. 受控词表（D5）

`resources/keyframe-vocab/v1.json`，`vocabulary_id` + `vocabulary_version` 单调递增，**禁止原地改已发布版本**。
违规处理（M3 冻结）：一律改道 `notes`、计数 `vocabulary_violations`、`>0` 落 `VISION_VOCABULARY_VIOLATION`、**不阻断落库**。
**边界**：v1 未经验证，不声称覆盖充分（R4）。

---

## 7. 切片与验收映射（**评审 #3/#11 后重数**）

| 切片 | 交付 | 网络 | 映射（可关门） |
|---|---|---|---|
| S1a | `jpeg_args` + ffmpeg 编码 + 缩略图/载荷分离 + **帧规格实测** | ❌ | A6、A13 |
| S1b | `select_frame_timestamps` + 降级 | ❌ | A5 |
| S2 | v40 三处 DDL + 三段式 + 契约 + 路由/IPC（mock runner）+ `purge_expired` + `detach_asset` | ❌ | A1、A2、A3、**A8**、A12、A14 |
| S3 | `VISION_ADAPTER_IDS` + 六列探测 + 失败码 + **0.13 实测**（探测走三段式） | ✅ | A4 |
| S4 | 打标作业（三处登记）+ 落库 + 词表 + stale + `provider_invocations` 归属列 | ✅ | A7、A10、A11 |
| S5a | 面板标签过滤 | ❌ | A9? 否 → A10 后半 |
| S5b | 盲评包 + 预登记 | ❌ | A9 |

**口径重算（评审 #11）**：验收共 **14** 项（A1–A14）。
- **不触网可关门：12 项**（A1–A3、A5–A9、A11–A14）
- **需真实网关：2 项**（A4 能力探测、A10 端到端打标）

A8 的落点：S2（契约与分派均为增量，回归锁在此切片断言）。

---

## 8. 测试清单

| 测试文件 | 覆盖 | 负向对照（必须真变红） |
|---|---|---|
| `test_keyframe_encode.py` | A5 边界 k=0/1/24/25/100 + `covered_scene_cuts` | 去封顶 ⇒ 25 帧红；忽略切点 ⇒ covered 不符红 |
| `test_keyframe_encode_ffmpeg.py` | A6 实测 768/q85；**A13** 编码成功**且音视频解码路径不受影响** | 改 scale 不钉长边 ⇒ 尺寸红；破坏解码器 ⇒ 红 |
| `test_keyframe_preview.py` | A1 移除生效、A2 零调用、A3 哈希可复算（固定 ffmpeg 参数） | 移除只改 UI ⇒ 载荷仍含红；去 claim ⇒ 调用数 >0 红 |
| `test_keyframe_audit_fidelity.py` | **A12**：展示的 thumbnail ≠ payload 且 payload 逐帧等于外传字节 | 展示 payload 冒充 thumbnail（或反之）⇒ 红 |
| `test_keyframe_purge.py` | **A14**：到期删字节留元数据；**用独立目录 ⇒ 不受 LRU 干扰** | 只置标记不删 ⇒ 字节数 >0 红 |
| `test_keyframe_detach.py` | 素材删除不阻塞（P102 回归）+ 审计留存 | 改成 CASCADE ⇒ 审计丢红；改回 FK 阻塞 ⇒ 删除失败红 |
| `test_vision_adapters.py` | A4 fail-closed；**探测须先 claim** | 探测失败仍放行 ⇒ 红；探测绕过 claim ⇒ 红 |
| `test_frame_tags.py` | A7 改道+计数、A11 CASCADE + 指纹同源、A10 `provider_invocations` 归属列 | 丢弃违规标签 ⇒ 红；不加归属列 ⇒ A10 不可断言红 |
| `test_contract_job_kinds.py` | **A8**：`JOB_KINDS` 与 union 一致、旧 kind 行为不变 | 只改 union 不改数组 ⇒ `parseJob` 拒绝新 kind 红 |
| `test_status_doc_consistency.py` | Rule 2：`latest_migration` 39→40 | 忘改 §1 ⇒ **`test_status_facts_match_code`** 红（注：该套件共 7 个 test 函数 + 1 个 parametrize(4)，**不是「10 项独立断言」**） |

**每条负向对照须在实施记录中给出「还原后红、恢复后绿」实跑输出。**

---

## 9. 风险

| # | 风险 | 处置 |
|---|---|---|
| **R12**（**重写**） | 打包形态未证 | ~~PyAV 打包会挂~~ **该立论已证伪**（0.3）。真实处置：A13 仍要求在**打包产物**内实跑 ffmpeg 编码 + 解码不受影响；**不得以源码树通过推断** |
| **R13** | 0.13 若不成立 ⇒ 词表退化后处理、违规率高 | S3 首要交付即实测；降级档显式且必报违规率 |
| **R14** | `frames_json` 与磁盘字节双写不一致 | A12 逐帧比对；缺失即 fail-closed `VISION_FRAMES_UNMAPPED` |
| **R15** | 迁移 v40 撞号 | 实现前重查 `MIGRATIONS`，冲突顺延并同步 STATUS §1 |
| **R16**（新） | 独立缓存目录**不被任何 LRU 管辖** ⇒ 若不清理会无限增长 | `purge_expired` 是唯一清理者（这也是 A14 不假绿的前提）；启动期孤儿清扫兜底 |
| **R17**（新） | 外传审计依赖 `detach_asset` 被正确调用，**漏调即阻塞素材删除** | `test_keyframe_detach.py` 锁；并在 `delete_asset` 路径显式调用（与 P102 同款回归） |

---

## 10. 待裁决

**无。** D9 已作为追加项回填规划门 §10 并获批（见该文件）。

---

## 11. 门禁状态

- **Design Gate：修订完成，待用户批准**；未批准前不得写实现代码。
- 契约变更：**两处新增成员**（`JobKind` union + `JOB_KINDS` 数组）+ 新类型，**既有成员零变更**（A8 锁）。
- 迁移：v40（三处：两新表 + `provider_invocations` 增列）⇒ 触发 STATUS §1 同步。
- 新增 egress 面：一处（帧级，规划门已批准）。
- 默认行为变更：无。

---

## 12. 独立评审处置对照（LiuKeAi，2026-10-21）

**评审结论**：需修改后批准；第 1–9 条改完可批，第 10–13 条可并入实施记录。**本轮：13 条全部处置**（未按「可延后」处理，因为其中 3 条实质改变了数据模型）。

| # | 问题 | 处置 |
|---|---|---|
| 1 | 0.3 立论错（看了被 gitignore 的 spec） | ✅ 事实 0.3 重写；R12 重写；§0.11 记录「看错对象」教训；**ffmpeg 方案结论不变但理由更换** |
| 2 | A13 被改弱（丢了「解码路径不受影响」） | ✅ §8 测试表恢复完整 A13 判据 |
| 3 | **A8 整体丢失** | ✅ §7 S2 映射 + §8 `test_contract_job_kinds.py` 双处补回 |
| 4 | I-1 被挖洞（探测不走 claim） | ✅ §5.1 表格明列「须先 claim」+ §8 负向对照 |
| 5 | 契约缺字段，A12 无字段可变红 | ✅ §4 拆成 `payload_*` 与 `thumbnail_*` 两套 |
| 6 | DDL 三处硬伤 | ✅ `provider_config_id` 补 FK；`expires_at` 补索引；`payload_sha256` 改 NOT NULL |
| 7 | CASCADE 与外传审计冲突 | ✅ 取消 CASCADE，改 `detach_asset` + `detached_at`；审计持久证据落 `provider_invocations` |
| 8 | 契约增量非纯增（漏 `JOB_KINDS`） | ✅ §3.5 三处登记 + §4 明写 + §8 专测 |
| 9 | Rule 3 零登记 | ✅ 已在 STATUS §4 登记（P166–P169） |
| 10 | A10 不可断言（`provider_invocations` 无归属列） | ✅ §2.3 增列 `keyframe_generation_id` |
| 11 | §7「11 条」无口径 | ✅ 重数为 **14 项 / 不触网 12 / 需网关 2** |
| 12 | purge 测试可假绿（LRU 抢先删） | ✅ §2.4 改用**独立目录**，不受 LRU 管辖；R16 登记 |
| 13 | 248 字节未复算 | ✅ §0.12 实跑四组数字；**248 B 可复现但属纯色合成帧**，真实帧 24–30 KB |
| — | D9 该回规划门追加 | ✅ 已回填规划门 §10，不在本门自行生效 |
| — | `elif` vs `if`；`KIND_POLICIES` 未登记；测试计数 | ✅ §3.5 / §8 逐条修正 |

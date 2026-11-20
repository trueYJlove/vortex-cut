# W3.3 S5a 实施记录 · 按画面标签过滤（D1 最小可见面）

> **切片**：S5a（Design Gate §7）
> **上游**：规划门 D1（内置最小可见面）/ Design Gate §5.3（UI）
> **日期**：2026-10-21
> **验收归属**：本文的 A10 后半（按落库标签过滤）由 **`W3_3_VERIFICATION_GATE_2026-10-21.md`** 汇总复核。

---

## 1. 交付

| 文件 | 变更 |
|---|---|
| `frame_tags.py` | 新增 130 行：读侧服务（summary / by_label / 校验） |
| `app.py` | 2 个 GET 路由 + FrameTagService 装配 |
| `packages/contracts` | +`FrameTagHit` / `FrameTagFilterResponse` + `parse*` |
| `stage2b-ipc.ts` | 2 个通道 |
| `preload/index.ts` | 2 个方法 |
| `SemanticSearchPanel.tsx` | 「按画面标签过滤」区块 |
| `test_frame_tags.py` | **14 项** |
| `semantic-frame-tags.test.tsx` | **5 项** |

---

## 2. 为什么读侧可以现在做、写侧不行

写侧（S4）需要真实 vision 网关；但 **v40 的 `asset_frame_tags` 表已经存在**，
所以读侧语义可以完整实现并**用真实写入的行**验收——测试直接 INSERT 行，再断言读侧行为。
这不是「先用 mock 顶着」，读路径本身是完整的。

---

## 3. 三条读侧纪律（都在测试里钉住）

| 纪律 | 用例 |
|---|---|
| **stale 在读侧算**，不写库、不删行 | `test_fingerprint_change_makes_summary_stale` / `test_stale_summary_still_returns_tags` |
| **指纹与 `asset_semantic_index` 同源**（都用 `assets.fingerprint`） | 同上 |
| **标签过滤在 SQL 侧、精确匹配、绝不跨项目** | `test_by_label_is_project_scoped` / `test_by_label_is_exact_match` |

**额外一条**：`by_label` **不看 stale 行**——旧标签描述的是旧内容，参与过滤会给出错误结果，
与检索侧同款纪律（`test_by_label_excludes_stale_rows`）。

---

## 4. 词表违规数的算法（没有新增列）

规划门 §3.4 规定「词表外标签一律改道 `notes`」。因此：

```
vocabulary_violations = 有 notes 的帧数
```

**为什么不加 `violations` 列**：那会让同一事实存两处，而两处必然漂移——
这正是本仓 P65 记录的失败模式（正文复述绕过机器校验）。
由 `notes` 反推是可算的实测值，不是估计。

---

## 5. 负向对照（实跑，5 组全部精准变红）

### Python 读侧（4 组）

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **NC1** | 不把指纹变化标成 stale | **2 failed** / 12 passed |
| **NC2** | 过滤不限定项目（跨项目泄漏） | **1 failed** / 13 passed |
| **NC3** | 过滤包含 stale 行 | **1 failed** / 13 passed |
| **NC4** | 空标签不拒绝（退化成「返回全部」） | **1 failed** / 13 passed |

### 面板（3 组，其中 NC1 是 D1 的验收核心）

| 对照 | 改坏什么 | 结果 |
|---|---|---|
| **面板 NC1** | 标签改成**硬编码**而不是读端点返回 | **2 failed** / 3 passed |
| **面板 NC3** | 泄漏上游错误细节（含路径） | **2 failed** / 3 passed |
| **面板 NC4** | 去掉「需要你显式开启并逐张审阅」说明 | **2 failed** / 3 passed |

> **面板 NC1 是 D1 的关键**：它的验收口径是「面板按**落库**标签过滤」，
> 若面板读硬编码或本地伪造数据，用例必须红——实测确实红了。
> 这正是为 `BeatGridService` 零调用方那种失败守的门。

---

## 6. ⚠️ 本轮暴露的一个流程问题（如实记录）

跑面板负向对照时我用 Python 脚本临时改源码再还原，**有两次还原失败把变异留在了文件里**：

1. 一次留下 `setLabelHits([{ asset_id: "fake", ... }])`（硬编码变异）——
   被后续测试 **2 failed** 抓到；
2. 一次留下 `if (false) { .... }`（空标签变异）——
   被后续测试 **1 failed** 抓到。

**两次都是测试抓住了变异，而不是我自查发现。** 说明：

- 负向对照的「还原」步骤本身是**不受保护的操作**，必须当成有风险的动作对待；
- 反过来，这也**正面证明**了这些用例有区分力：残留的变异立刻让测试变红，没有静默通过。

**改进（已做）**：最终状态用 `grep` 扫描 `if (false)` / `String(e)` / `自动产生` / `"fake"` 四类残留，
结果为 CLEAN，并重跑全量确认。

---

## 7. 质量门

| 项 | 结果 |
|---|---|
| `pytest test_frame_tags.py` | **14 passed** |
| 关键帧 + 标签 + 状态源 Python 子集 | **43 passed** |
| `vitest run`（桌面全量） | **887 passed**（105 文件） |
| `tsc --noEmit`（contracts + desktop） | **通过** |
| 残留扫描 | **CLEAN** |

---

## 8. 未完成

| 项 | 归属 / 阻塞 |
|---|---|
| 打标写入（S4） | **需真实 vision 网关** |
| vision 适配器 + 能力探测（S3） | **需真实 vision 网关** |
| 盲评包 + 预登记（S5b） | 无阻塞，但需 S4 产出真实标签才有意义 |
| 逐张审阅 UI（preview 的帧列表 + 移除） | 无阻塞；本切片只做了标签过滤，审阅面板属后续 |

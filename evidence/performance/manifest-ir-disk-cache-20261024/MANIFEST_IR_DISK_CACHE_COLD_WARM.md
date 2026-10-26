# manifest IR 磁盘缓存 冷/热实测（PERFORMANCE_MANIFEST_IR_DISK_CACHE §3.3）

> 被执行日期：2026-10-24 ｜ 分支 `liuwei-dev` @ `d0752ca` ｜ 本机 Windows
> Python 3.13.1 ／ httpx 0.28.1 ／ 随包 ffmpeg（`resources/ffmpeg/win-x64`）

## 0. 这份记录回答什么

规划门 §3 第 3 条要求：“冷启动（删缓存目录）vs 二次启动（磁盘命中）各 1 轮，
ready 段 ② 对比留证，**命中轮 manifest 请求 <100ms**”。本目录是该条的实测留证。
此前 `ir_disk_cache.py` 已接线并有 9 项单测，但从未有过真实冷/热测量——单测里
投影是 mock，耗时是毫秒级，不能拿来充当本门要求的数字。

## 1. 口径定义（本系统里“冷/热”到底指什么）

| 术语 | 定义 | 依据 |
|---|---|---|
| 缓存位置 | `data_dir/cache/preview-ir/<manifest_id 前2字符>/<sha256>.json` | `ir_disk_cache.py:33,37` |
| 谁写 | 投影完成后 `preview_ir` / `_ir_v2_bundle` 原子写盘（tmp + `os.replace`） | `rendering/service.py:362-363, 459-460` |
| 谁读 | 进程缓存未命中时查盘；命中则跳过 ffprobe 与投影 | `rendering/service.py:337-348, 444-450` |
| 命中判据 | 条目存在 **且** `projector_version` 相同 **且** 素材指纹集一致 | `ir_disk_cache.py:46-58` |
| 冷 | 缓存目录不存在（首投影 + 写盘） | 门 §3.3 |
| 热 | 同一 `data_dir`、**新进程**（进程内存缓存必空）、缓存目录保留 | 门 §0：对应“用户次日重开” |

**为什么热轮必须换进程**：v2 进程缓存（LRU 2）在 Core 常驻期间就能命中，
同进程第二次请求根本走不到磁盘层，测出来的不是磁盘缓存收益。

## 2. 方法（可复现）

测量不 mock 任何东西：真实 `create_app(Settings)`、真实 100 素材项目、
真实 `ffprobe` + IR 投影、真实磁盘读写。用 `fastapi.testclient.TestClient`
直接打 `GET /api/v1/projects/proj-taskd/preview-ir-v2/manifest`（该端点即
`preview_ir_manifest`，渲染端 ready 段的同一入口）。

```
# 1) 夹具：100 个 2s 短片，每个时长/音调不同 -> 内容指纹唯一（导入侧按指纹去重）
uv run --locked --extra dev python .tmp/taskd/make_clips.py .tmp/taskd/media

# 2) 建项目（只建库，不请求 manifest -> 不产生缓存目录）
uv run --locked --extra dev python .tmp/taskd/seed.py .tmp/taskd/data .tmp/taskd/media

# 3) 冷轮（缓存目录不存在）与 热轮（同 data_dir、新进程）各跑一次
uv run --locked --extra dev python .tmp/taskd/measure.py .tmp/taskd/data
```

口径与规划门“100 素材级 ≈1.8s 首投影”一致：100 素材 / 100 段 / 6000 帧 /
条目 1.86MB。测量脚本与夹具是临时件（`.tmp/`，已被 `.gitignore` 忽略），
跑完即删，只有本记录入库。

## 3. 结果

### 3.1 冷 vs 热（各 1 轮，门要求的最小口径）

| 轮次 | 缓存条目前→后 | manifest 请求耗时 | 判定 |
|---|---|---|---|
| 冷启动（删缓存目录） | 0 → 1 | **9410.7 ms** | 未命中：ffprobe + 全量投影 + 写盘 |
| 二次启动（缓存保留，新进程） | 1 → 1 | **39.8 ms** | 命中：跳过 ffprobe 与投影 |

**命中轮 39.8ms < 100ms 门限，通过（余量约 2.5x）。**

### 3.2 热轮重复性（同一缓存、各自新进程）

| 第 n 次 | 耗时 | 缓存条目 |
|---|---|---|
| 1 | 39.8 ms | 1 |
| 2 | 39.4 ms | 1 |
| 3 | 42.6 ms | 1 |
| 4 | 43.9 ms | 1 |
| 5（恢复备份后复测） | 41.2 ms | 1 |

热轮稳定在 **39.4–43.9 ms**，无异常离群。

## 4. 负向对照（证明这 9.3s 差值确实来自磁盘缓存）

只有冷/热两组数字不足以排除“DB 或 OS 文件缓存导致第二次变快”。三组对照：

| 对照 | 操作 | 结果 | 结论 |
|---|---|---|---|
| A | **同一个 DB**，只删 `cache/preview-ir/` | 8701.4 ms | 变慢与 DB/OS 缓存无关，只跟缓存目录有关 |
| B | 恢复缓存后复测 | 41.2 ms | 恢复即回快，可逆 |
| C | 把条目 `projector_version` 改为 999 | 8798.0 ms | 失效键真实生效：版本不符 → 不命中（并删陈旧文件），**不会读错缓存** |

对照 A + C 一起排除了“热轮快是因为别的原因”和“缓存陈旧会被误消费”两种误读。

## 5. 诚实的边界（这份证据**不**证明什么）

- **不是真机 ready 段计时**：本测量直接打 manifest 端点，不含 Electron
  启动、renderer 加载、`ready` 事件与首帧上屏。门 §3.3 的“ready 段 ②”若指
  端到端 ready，需要 F02/B00 完整 harness + 真机 App，**本次未执行**。
  本记录证明的是“manifest 请求本身”的冷/热差值，这恰是缓存层的责任边界。
- **未经 F02 完整场景装配**：`tools/performance` 的 F02 是 900s/640x360 单素材
  场景，且 `run_editor_benchmark.mjs` 的完整 App 测量需要 Electron 启动与
  打包构建。本次用 100 素材工程对应门里的“100 素材级”收益口径，不是 F02
  场景本身。
- **本机单次**：非多机、非多轮统计。冷轮 9410.7ms 与本仓历史记载的
  “≈1.8s 首投影”不同量级，差异来自素材数量与 ffprobe 次数（100 个独立文件
  首轮全量探测），不作为回归基线，只作冷/热对照。
- **LRU 8 条未在真实数据下压测**：单测覆盖淘汰逻辑，本次只有 1 条条目。

## 6. 结论

规划门 §3 第 3 条的“命中轮 manifest 请求 <100ms”**已达成并留证**：
冷 9410.7ms → 热 39.8ms（≈236x），热轮四次复测 39.4–43.9ms，负向对照三组
证明差值来自磁盘缓存且失效键有效。**端到端 ready 段计时仍缺真机 F02 运行**，
该项如实标注为未执行，不以本记录冒充。
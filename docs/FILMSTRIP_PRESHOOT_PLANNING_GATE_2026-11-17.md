# WP-P232 素材级缩略图预抽（filmstrip）Planning Gate

> 角色：LiuWei（架构师）
> 日期：2026-11-17
> 状态：Planning Gate 完成，Design 与实现合一（切片式）
> 来源：用户需求「显示流畅（含放大/缩小时间线）」+ P230-②a 遗留首格延迟

## 0. 用户问题（2026-11-17 原话）

「OpenFilm 和 Concat 都是导入素材时就抽帧了吗？」——回答（已实证）：
- **OpenFilm**：服务端 ffmpeg 按需抽帧 + **磁盘 JPEG 缓存**
  （`server/derived.mjs frame()` → `cached(root,'frames',key.jpg)`，HTTP
  `cache-control: max-age=86400`）。首抽运行时，之后永远读文件。
- **Concat**：**导入/命令应用即触发**（`studio/edit.rs after_change →
  request_media_art`）+ 统一调度器（poster 优先于 filmstrip，导入 20 文件
  = 20 个排队任务而非 20 个解码器）+ **磁盘 JPEG 缓存**（项目目录，
  项目重开直接读图，注释明言这是他们修过的老问题）。
- 共同点：**缓存落盘 + 导入即抽 + 永不空格**。

## 1. 方案裁决：结合两参照之长，贴合本仓资产

| 层 | 采纳 | 理由 |
|---|---|---|
| 生成 | **Concat 的时机 + 本仓 Core 作业系统** | 导入/转录完成即登记作业（jobs.py 既有分派形态，与 waveform 同构）；Core 拥有素材文件，Renderer 不必开着 |
| 工具 | **Core ffmpeg tile 一次 pass** | OpenFilm 逐帧 `-ss` 每格一进程太贵；ffmpeg `select+tile` 单进程产整条 sprite（Concat「一次线性 pass」语义的 ffmpeg 等价物） |
| 存储 | **OpenFilm 的磁盘缓存 + 本仓 derived_media_cache** | kind=`filmstrip` 条目（B10 派生缓存既有基建：内容寻址键/状态机/disk budget/refs 授权全复用）；产物 = sprite JPEG + JSON 元数据 |
| 消费 | **时间线查表优先 + 运行时补抽兜底** | 画布格位 (step 档, 源时间) → 命中 sprite 直接贴（ImageBitmap 一次解码常驻，格采样零成本）；未命中走现有运行时路径并登记缺格，Core 按需补抽 |
| 调度 | **Concat 的低优先级语义** | 生成作业 jobs 队列天然低优先（waveform/beat 同队）；不阻塞前台 |

**否决项**：渲染端 WebCodecs 预抽（需 Renderer 常驻、票据 TTL 管理复杂、
与 Core 派生缓存授权模型相悖）——只保留它作为**运行时补抽**的既有路径。

## 2. 产物契约（filmstrip sprite）

- **params**：`{ step_ms }`——源时间阶梯档位（对齐 OpenFilm ladder：
  1·2·2.5·5×10ⁿ ms）。时间线 80px 格宽 × 当前 pps → 原始步长 → 阶梯取整：
  同档内缩放不重抽（cells ≤2.5× 稀疏仍可覆盖，参照 thumb-cache.ts ladderStepMs）。
- **sprite**：单列 JPEG，格宽 160px（现有 video seek 路径同宽），格高按素材
  显示宽高比；元数据 JSON：`{ step_ms, cell_w, cell_h, count, duration_us }`。
- **条目**：`derived_media_cache kind='filmstrip'`，params_json = step_ms 档位。

## 3. 切片

- **Slice 1（Core）**：`media/filmstrip.py`——`FFMPEG select+tile` 生成
  sprite；`run_filmstrip_job`（run_waveform_job 同构：stat 校验 →
  begin_build → ffmpeg → commit_ready）；jobs.py 分派分支
  `kind == "filmstrip"`；`KINDS` 加 `"filmstrip"`；`app.py` 两条路由
  （create/lookup + internal/media）。迁移 v44：无（复用 B10 表）。
- **Slice 2（contracts）**：JobKind 加 `"filmstrip"`；FilmstripRequest/
  Response DTO；**不改 PROTOCOL_VERSION**（纯增量类型）。
- **Slice 3（Desktop）**：App `filmstripMediaUrl` 接线（performance-ipc
  `filmstrip:media` handler，同 waveform:media 模板）；导入成功回调和
  转录完成回调里 fire `ensureFilmstrip(assetId, stepLadder)`（pending
  轮询对齐 WaveformCache 的退避重查形态）。
- **Slice 4（时间线画布查表）**：`ThumbnailLoader` 增 sprite 源
  （`SpriteFrameSource`：ImageBitmap 常驻 + 格采样），request 路径先查
  sprite 表再走 filmstrip worker；格命中打点（perf-metrics）。

## 4. 与 P230-②a 的关系

二轮修复（busy 重排/余量放宽/失败降级）保留——它们是**运行时补抽**路径的
正确性基础。预抽上线后运行时路径退居兜底（换到未预抽档位的即时格）。

## 5. 验收

自动化：filmstrip.py 生成纯函数单测（阶梯档位/tile 参数/元数据）；
jobs 分派分支测试；contracts parse 往返。真机：导入 20 素材 → 任务页
出现 filmstrip 批量作业；拖素材上轨**立刻有帧**（sprite 命中）；放大
时间线跨档位时新档位后台生成期间旧档位 sprite 顶着（永不空格）。

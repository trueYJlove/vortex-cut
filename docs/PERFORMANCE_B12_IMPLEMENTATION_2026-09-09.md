# B12 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B12(MP4 Range demux,禁止伪流式)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B12 与
第 6.1 节跨进程契约规则,在 B11(`fbc94ee` 及此前提交)之上实施,按
"Range 源 → BMFF demux → decode-worker 接入 → 回归"三个可审查提交推进。

三个提交(单一目标,均本地,未 push):
- `1a9867c` B12-A Range 源(range-source.ts + 13 单测)
- `9305740` B12-B BMFF demux(bmff-demux.ts + 11 单测 + 真实夹具)
- `7cd72b6` B12-C decode-worker 改造(整文件下载移除 + 续票接入)

## 2. 修改单(模板)

```text
修改单:B12 MP4 Range demux,禁止伪流式
基线HEAD / 工作树标识:fbc94ee(B11-D 收官);三个本地提交
目标与不修改范围:
  目标——decode-worker 从整文件 arrayBuffer 下载改为 Range 源按需读取:
  初始化 bytes=0-65535 探测 + moov-only 解析(顶层 box 跳扫定位,moov 在
  尾部也按 box 偏移),解码期按 sample 区间读取(字节 LRU 合并),并发≤2,
  媒体票据 TTL 受控续票(有限一次,相同 range 重发);BMFF 64 位/co64
  安全整数校验,box/采样数上限,fragmented(moof)/无 moov/非 AVC 明确
  回退(不冒充已支持)。
  不修改——restricted-media 协议层(HEAD/Range/416/后缀语义已由 B10 前
  既有测试覆盖)、WebCodecs 解码器生命周期(GOP 锚/中间帧环/close 规避
  语义逐字保留)、A03 采样索引、compositor/音频路径(音频 arrayBuffer
  属 B14 波形职责)。
实际修改文件(绝对路径):
  apps/desktop/src/app/preview/range-source.ts(新增)
  apps/desktop/src/app/preview/bmff-demux.ts(新增)
  apps/desktop/src/app/preview/decode-worker.worker.ts(初始化 + 喂包改造;
    旧整缓冲 demux/findBox/findU32Tag 移除——解析逻辑移植至 bmff-demux)
  apps/desktop/src/app/preview/decode-worker.ts(续票参数 + close 消息)
  apps/desktop/src/app/preview/preview-session.ts(refreshTicket 注入)
  test-assets/test-faststart.mp4、test-tail-moov.mp4(真实 FFmpeg 夹具)
  测试:apps/desktop/tests/range-source.test.ts(13)、
    bmff-demux.test.ts(11,含真实夹具等价性金标准)。
前置Gate与接口版本:B11 完整(代理与源选择就绪);restricted-media
  协议既有语义(Range 206/416/suffix)——B12 只做客户端消费侧。
算法/状态机变化:
  - HttpRangeSource:初始化探测(206 解析 Content-Range 总长;200 大文件
    >16MiB 拒绝 RANGE_UNSUPPORTED——不冒充;小文件整读)→ read 区间
    校验 → 字节 LRU 覆盖查找(块起点 ≤ offset 且块尾 ≥ offset+length)
    → 未命中合并 chunk(窗口头起,初值 1MiB,钳 16MiB)→ 并发闸门 ≤2
    (FIFO 排队)→ 401/403 有限一次续票(相同 range 重发,二次拒绝)。
  - demuxRange:walkTopBoxes 只读 box header(16 字节)按声明 size 跳
    (size=0 延伸到文件尾;size=1 → largesize 安全整数校验)定位 moov;
    moov payload 一次读(≤64MiB 上限)→ parseMoov(trak/mdhd/stbl 八表
    解析,与旧 demux 逐字段等价)。moof → BMFF_FRAGMENTED;无 moov →
    BMFF_NO_MOOV;非 avc1 → BMFF_CODEC_UNSUPPORTED。
  - decode-worker init:HttpRangeSource.create(ticket, fetch, refreshTicket)
    → demuxRange(source) → buildSampleIndex;喂包逐 sample 经
    rangeSource.read(offset, size)(字节缓存合并连续读);GOP 锚/中间环/
    reset 重建/冷启 pendingAnchorPts 语义不变。
授权、取消、资源所有权、缓存失效规则:
  - 票据续票:worker 无法 IPC——refreshTicket 回调由会话注入(经
    window.desktop.refreshAsset → Main 重发同资产新票据;不改变 source
    fingerprint);HttpRangeSource 有限一次,续票后仍 401/403 拒绝。
  - close:terminate 先发 close 消息(源关字节缓存/在途)再 terminate
    worker;会话 dispose 路径既有。
  - 缓存:字节 LRU 8MiB(块级,不长期持有整文件);帧缓存语义不变。
新增/修改测试与命令:
  Desktop:pnpm typecheck / lint / test(60 文件 508 项)
  夹具:resources/ffmpeg(win-x64 n8.0.1)生成 640x360@30 2s
    libopenh264 GOP15 无 B 帧;faststart 与尾 moov 两份。
功能回归结果(含跳过):
  Desktop 全量 60 文件 508 项(B11 时 58/485);typecheck/lint 通过。
  Core 无改动(B12 为 Renderer 侧)——不重跑(见下偏差说明)。
before / after / 同机环境:
  行为等价:bmff-demux 对两份真实夹具与旧整缓冲 demux 金标准逐字段
  一致(samples/timescale/width/height/codec);moov-only 断言:尾 moov
  夹具的任何读取不落进 mdat payload 区间(读取量 ≤ moov + 顶层 header)。
  长源收益(读取字节数随目标窗口而非文件总长)的量化验收归 F03 场景
  复测(见已知限制)。
质量与失败路径验证:
  - 206 字节数不符/Content-Range 总长漂移:RANGE_BODY_MISMATCH/
    RANGE_LENGTH_CHANGED 拒绝。
  - 200 大文件:RANGE_UNSUPPORTED(调用方走代理/错误,不伪流式)。
  - fragmented/无 moov/非 AVC/64 位越界:结构化错误码,明确回退。
  - 续票链:401 → refresh → 相同 range 重发;失败/二次 401 上抛。
开关、兼容与回退:
  - 单一行为替换:所有视频输入统一 Range 路径(小文件 200 整读兼容);
    音频输入不经 decode-worker(不受影响)。
  - 回退语义:Range/BMFF 不支持错误码上抛至会话(现有错误路径显示/
    回退交互预览),代理生成入口由 B11 preview-source 提供。
已知限制、未解决问题:
  - decode 队列请求纪元(seek 替换取消在途 range):Range 源的并发闸门
    + close 释放已覆盖会话级替换;帧级请求纪元的精细取消留待 B13
    活跃输入池(与 generation 机制一起做,计划同段)。
  - 音频/waveform 的 arrayBuffer 加载(TimelineCanvas 波形 + 预览音频
    fetch)不在 B12 范围(计划归 B14/B15)。
  - F03(末尾 10 秒读取字节随目标增长)端到端数字:需 Electron 实机
    (jsdom 无 Worker/WebCodecs);单元级等价性与 moov-only 已覆盖,
    实机复测列入 F 场景验收轮。
  - proxy 产物经 faststart(moov 前),Range 读取天然最小化;原源尾 moov
    同样按偏移定位(等价路径已测)。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:B13(活跃输入与 GPU 资源预算)或 F 场景复测轮
  (B10-B12 三件套:代理/源选择/Range demux 已就绪,F01-F04 量化验收
  可启动;按计划 B13 先行——活跃输入池是 F04 显存预算的前置)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| Range 源 | range-source.test.ts | 13 | 探测/206-200 语义、区间校验、跨窗口合并、字节 LRU 覆盖查找、并发≤2、续票有限一次、body 数不符、Content-Range 解析 |
| BMFF demux | bmff-demux.test.ts | 11 | readBoxHeader(8/16/size<8/64 位越界)、真实夹具等价性(faststart+尾 moov 逐字段 vs 旧整缓冲金标准)、moov-only 读取断言(mdat 零读取)、IDR NAL 采样可读、moof/无 moov/非 AVC 回退、组合路径(HttpRangeSource+demuxRange) |
| 既有 | restricted-media.test.ts | (B10 前已有) | 协议层 206/416/suffix/HEAD/过期语义(B12 客户端消费的基础) |

- Desktop 全量:`pnpm test` → 60 文件 / 508 项;`pnpm lint`(=tsc)通过。
- 夹具来源:`resources/ffmpeg/win-x64`(n8.0.1)真实转码,入库
  `test-assets/`(各 255KB)。
- Core 侧零改动(B12 为 Renderer/Worker 侧单)。

## 4. 与实施计划的偏差

- 计划第 5 条"request epoch,seek 替换时取消尚未消费 range;陈旧返回
  只释放":本单实现到源级(并发闸门 + close 释放 + 闸门内检查 closed);
  帧级请求纪元与 B13 的 generation 机制合并实施(登记于已知限制)。
- 计划第 7 条"HEAD 不打开读流;客户端 abort 销毁底层 stream":
  restricted-media 既有实现已满足(HEAD 无 body;Response 流由
  Electron 协议层生命周期管理),本单未改协议层——测试既有。
- 计划"chunk 初值 1MiB,合并连续 range":实现为向后扩展 1MiB 对齐
  (从请求区或窗口头起),钳 16MiB;未做跨请求前瞻合并(B13 输入池
  预读窗口可再优化)。
- demux 与 decode-worker 的职责拆分:计划新增 bmff-demux.ts——解析
  逻辑从 worker 移出为可测模块(等价性金标准即移植证明)。

## 5. 复现命令

```powershell
pnpm --filter @aivideo/desktop test     # 60 文件 508 项
npx vitest run tests/range-source.test.ts tests/bmff-demux.test.ts
pnpm --filter @aivideo/desktop lint
```

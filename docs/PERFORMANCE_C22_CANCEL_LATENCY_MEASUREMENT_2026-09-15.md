# C22 取消延迟实测报告(2026-09-15)

**性质**:性能专题审查(2026-09-15)处置建议第 2 项落地——补齐计划第 8 节
验收矩阵"取消"行的真实测量。C22 实施报告
(`docs/PERFORMANCE_C22_IMPLEMENTATION_2026-09-10.md`)原文登记"端到端取消
延迟(≤2s/≤5s)与真实 FFmpeg 停滞注入**未实测**——列 F 场景复测轮",该复测
轮此前从未执行;本文件即该复测轮的交付。

## 1. 结论

**矩阵行达标**:

| 矩阵行口径 | 门 | 实测 | 判定 |
|---|---|---|---|
| 取消响应(正常 I/O 下) | ≤2s | **1,307ms**(600s 真实媒体解码 1s 后取消) | 达标 |
| 取消响应(最快路径:启动前已取消) | ≤2s | **448ms** | 达标 |
| 进程树强制回收(停滞进程) | ≤5s | **180ms**(stdin 管道停滞注入) | 达标 |

测量方式:被测路径 = `decode_validate`(C22 落地的可取消解码校验,
`rendering/ffmpeg.py`),真实 FFmpeg 子进程 + 真实媒体。计时口径:
`cancel_event.set()` → `JOB_CANCELLED` 异常抛出的墙钟(包含
terminate_process_tree 的 taskkill /T /F 同步 await——即异常抛出时进程树
已回收,同一测量覆盖两个门)。

## 2. 测量设计(三个取消时点)

1. **启动前已取消**(最快路径):进程起后首个 50ms 主循环轮询即终止——
   验证轮询检查本身的响应下界;
2. **正常 I/O 解码中途取消**(矩阵行原文口径):600s 真实 h264 媒体
   (libopenh264 编码,decode_validate 全量解码中)1s 后取消——进程处于
   持续读文件/解码的正常 I/O 形态;
3. **停滞进程树回收**(最重路径):FFmpeg 从 stdin 管道读输入、写端停写
   不关(65536 字节后阻塞)——进程阻塞在管道 read 上,模拟"不可中断
   I/O 等待"形态,直接测 `terminate_process_tree` 的强制回收时效
   (taskkill /T /F 的价值场景;decode_validate 的取消分支内部调用同一
   函数)。

## 3. 可复现

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_render_cancel_real.py -v
# 3 passed(FFMPEG 缺失时按仓库惯例 skip:bundled ffmpeg unavailable)
```

测试文件:`services/core/tests/integration/test_render_cancel_real.py`
(新增;集成层真实 FFmpeg,夹具同 `test_pcm_chunks_real.py` 惯例:
`resources/ffmpeg/win-x64/ffmpeg.exe` 存在性守卫 + skip)。

单次数字复现(独立脚本口径,2026-09-15 本机):
- cancel mid-decode(600s 媒体,delay 1.0s):1,307ms;
- cancel before start:448ms;
- stalled(管道停滞 1s 后)terminate_process_tree:180ms。

环境:与 G0 冻结同一台机(i7-1165G7/32GiB/Win10 26200);本测量为单次
墙钟(取消路径为确定性系统调用序列:taskkill+wait,不设统计口径——
与矩阵行"正常 I/O 下 ≤2 秒响应"的单值语义一致)。

## 4. 已知限制

- 停滞形态的注入点是 stdin 管道而非"媒体文件读停滞"(文件读停滞在
  Windows 本地盘上难以确定性注入);管道 read 阻塞是同一类"不可中断
  系统调用等待",taskkill /F 对两者等价(进程级强杀,不依赖协作退出)。
- 绝对上限/停滞超时(RENDER_VALIDATION_TIMEOUT)路径的触发时效由单测
  `test_render_cancel_validation.py` 的时钟注入覆盖,不在本实测范围
  (矩阵行只问取消与回收)。

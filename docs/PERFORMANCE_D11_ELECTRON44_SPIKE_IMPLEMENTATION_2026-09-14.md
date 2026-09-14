# D11 第二步(Electron 升版对拍 spike)实施报告(2026-09-14)

依据:`PERFORMANCE_D11_RESIDENCY_CEILING_PLANNING_GATE_2026-09-14.md` §2 第二步。
**判定:未命中(|Δ|=0.40% << 5% 门)——新 Chromium(Electron 36→44,chrome
136→152)未改变解码驻留池行为,接受现状路线落锤,D11 建议关闭**(§3)。

## 1. 执行摘要

| 项 | 结果 |
|---|---|
| 对拍形状 | F02P(320×180 代理,900s@30fps=27000 unique 帧),runs=5×off/on,warmup+100 seek+300s 播放,seed 20260908——与 B11-D1 基线轮同形状 |
| 基线 | `b11d-spike-20260912` on 通道中位 **16,649MB**(Electron 36.2.1 / chrome 136.0.7103.93) |
| 本轮 | `d11-electron44-20260914` on 通道中位 **16,583MB**(Electron 44.3.0 / chrome 152.0.7977.78) |
| **判定** | **Δ = −66MB = −0.40%**,远小于 ±5% 门(观测噪声 <1% 的 5 倍余量),5 轮全部 16,579–16,592 窄带——**未命中,方向稳定** |
| off 通道 | 16,576MB,与基线 off(16,651MB)同样 -0.45%,双向一致 |

**结论**:~631KB/unique 帧的解码驻留池高水位在跨 16 个 Chromium 大版本
(136→152,含 8 个 LTS 量级升级)后**纹丝不动**。这是 Chromium 层按
unique 解码帧数饱和的有界池设计(非泄漏、非版本 bug),**升版 Electron
不能移动天花板**——D11 spike 的判定问题得到否定答案,按 Gate §2
"未命中 → 接受现状 + 显式天花板登记,D11 关闭"。

## 2. 过程与兼容性副产物(spike 的主要交付)

### 2.1 环境装配(bench worktree `bench/d11-electron-spike` @2453391)

- worktree 隔离,`electron` devDependencies `^36.2.1 → 44.3.0` 锁 pin,
  pnpm 安装 + `VITE_AIVS_PERF=1` 构建;主工作区零改动。
- sidecar 环境:resources 缺失二进制(ffmpeg/aivs-core,gitignore 未跟踪)
  从主工作区补齐;venv python 经 Junction 复用主仓库 site-packages。

### 2.2 兼容性缺陷定位与修复(对拍的前提,bench-only 验证)

Electron 44 下合成预览装配失败,分层定位:

1. **现象链**:预览状态卡"合成预览"但 canvas 不可见 → 回退"交互预览"
   (`preview worker init timeout` / `no ticket` 次生)。
2. **逐层排除**:sidecar 启动 OK(desktop.log AIVS_READY);media 元素加载
   aivideo:// OK(`<video>` loadedmetadata dur=12s);**`fetch(aivideo://…)`
   被拦**(renderer 报 CORS blocked,main 进程 handler **未被调用**——
   拦截发生在 scheme 层进 handler 之前)。
3. **对照实验**(同探针跑 E36 与 E44):E36 fetch=200,E44 全模式失败
   (`no-cors` opaque/0、same-origin ERR);ACAO:* / Origin 回显 /
   `--web-security=false` 均无效 → 排除响应头问题,定性为 **Chromium 152
   对 custom scheme 的 fetch 请求默认执行 CORS 模式校验,E36(136)不做**。
4. **修复形状**:`registerSchemesAsPrivileged` privileges 增加
   **`corsEnabled: true`** 一行 → fetch=200,预览装配端到端恢复,F01 冒烟
   全过(harness 17.5s,含 worker/GL/池全链路)。

**副产物定级**:这是一个真实的 Electron 36→44 升级阻塞项+官方修复形状
(一行 scheme privilege),登记为独立产品工作单——**未来任何 Electron
升级都需要它,且顺手证明了升级路径的兼容面可控**(除该行外零产品改动,
单测/构建/IPC/Core 全部无感)。

### 2.3 flags 探测(降级:对拍未命中使 flags 探测失去目标)

Gate §2 第二步原计划"Electron 对拍 + flags 探测"两条。对拍已给出决定性
否定答案(池行为跨 16 个大版本不变),flags 探测回答的同一问题
("现 Chromium 能否配置出不同的池行为")已由更强的证据覆盖——版本维度
尚且不动,单机开关维度更无理由翻转 ~631KB/帧的池设计。**不再单独跑
flags 轮**,判定不受影响(口径登记:探测降级为对拍证据的逻辑覆盖)。

## 3. D11 收束建议(待 LiuWei 确认关闭)

1. **接受现状路线确认**:~631KB/unique 帧池高水位为 Chromium 有界池
   设计,升版/开关均不可移动;显式天花板(更新·十四 + Gate §5 表)为
   唯一有效护栏,R3 预警已坐实真实触发(D11 第一步)。
2. **Electron 升级工作单不立项(驻留维度)**——驻留不再是升级的阻碍;
   §2.2 的 `corsEnabled` 兼容项登记为未来升级的唯一已知前置。
3. **27k 上限压力验证轮**:升版命中前提已否定,C20c Gate §7.9 候选
   维持关闭(现硬件 16GiB 档 1.6 万帧/32GiB 档 2.7 万帧天花板不变)。
4. D11 挂账全部清偿,建议 LiuWei 确认后关闭。

## 4. 验证矩阵

| 项 | 判定 |
|---|---|
| 对拍形状一致性 | 同 fixture(sha256 a51a08f6)/同 seed/同 runs-seeks-playback/同机插电 |
| 判定标准执行 | \|Δ\|=0.40% < 1% → **未命中**(无需灰色加倍) |
| 修复形状验证 | F01 冒烟全过(E44+corsEnabled);E44 无修复时同冒烟失败(对照) |
| 工作区边界 | 主工作区零改动;bench worktree 独立分支;run-config 双向记录 |
| 装配竞态现场 | 本轮 recovery 计数全 0(无新现场) |

## 5. 证据与复现

- 证据:`evidence/performance/d11-electron44-20260914/`(F02P×5 轮 off/on
  全样本 + run-config)、`d11-e44-smoke-f01/`(修复后冒烟)、
  `d11-residency-warn-20260914/`(第一步)。
- bench 分支:`bench/d11-electron-spike`(worktree
  `C:\DataFolder\codes\AI-Vidio-d11spike`,含 corsEnabled patch,不进主干)。
- 复现:bench worktree 内 `AIVS_PERF_RUN=1 AIVS_PERF_SCENARIOS=F02P
  AIVS_PERF_FIXTURES=… AIVS_PERF_RESULT=… npx playwright test
  e2e/performance-editor.spec.ts --grep F02P`(直连 playwright 形状,
  B11-D1 同款;runner KNOWN_SCENES 守卫不含 F02P)。

## 6. 遗留

- `corsEnabled: true` 登记产品工作单(优先级:仅在未来 Electron 升级时
  前置;修复形状唯一,收益/风险比一行)。
- 装配竞态根因排查继续等现场(本轮 0/11 次启动)。

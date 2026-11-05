# iPhone HEVC 素材两类阻塞缺陷（2026-11-01）

> 状态源引用 `docs/STATUS.md` §4（本文登记为 **P203 / P204**）。
> 本文只记录实测事实与证据等级。

## 0. 素材

用户提供：`C:/Users/trueY/Videos/20261101/c992c92d118565174369652bc4215fc3_raw.mp4`
（iPhone 13 Pro 拍摄）

| 属性 | 值 |
|---|---|
| 容器 / 编码 | MP4 / **HEVC Main 10** |
| 位深 | **10-bit**（`yuv420p10le`） |
| 色彩 | **HDR：bt2020nc / bt2020 / arib-std-b67（HLG）** |
| 分辨率 | 3840×2160，**rotation=-90**（竖拍） |
| 帧率 | **VFR**：`r_frame_rate=24`（名义）/ `avg_frame_rate=176300/7347≈23.996` |
| B 帧 | 2 |
| 时长 / 帧数 | 146.94s / 3526 |
| 额外轨 | **3 条 `mebx` 数据轨**（iPhone 空间/时间元数据） |

## 1. 缺陷 A（P203）：10-bit HDR HEVC 点「播放」即挂死渲染进程

### 1.1 现象（观测）

在真实 App 内导入该素材：导入成功、落轨成功、指标条正常出现（**6.7s**），
但**点击「播放」按钮后渲染进程挂死**。

Playwright 的点击日志证明**不是渲染慢，是主线程堵死**：

```
- locator resolved to <button title="播放" class="pb-play" aria-label="播放">…</button>
- waiting for element to be visible, enabled and stable
- element is visible, enabled and stable
- scrolling into view if needed
- done scrolling
- performing click action                    ← 卡在这里，30s 不返回
```

四次运行全部复现（超时 900s / 780s / 840s / 30s）。进程侧证据：
一个 renderer 进程**吃掉 780s CPU**（约等于全部墙钟），即**满负荷空转**。

### 1.2 已排除的变量（观测）

**去掉 3 条 `mebx` 数据轨**（`-map 0:v:0 -map 0:a:0 -c copy`，同码流不重编码）
⇒ **仍然挂死**。**数据轨不是成因。**

### 1.3 关键对照：转 8-bit SDR 后不挂死（观测）

用随包 ffmpeg 转码（`zscale` HLG→BT.709 tonemap + `libkvazaar`）：

```bash
ffmpeg -i <原片> -map 0:v:0 -map 0:a:0 \
  -vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,\
       tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" \
  -c:v libkvazaar -preset ultrafast -c:a copy -tag:v hvc1 -y <out>
```

产物：HEVC **Main**（8-bit）/ `yuv420p` / bt709 / **2160×3840**（旋转已应用）。
**⇒ 同一素材转 8-bit SDR 后：不挂死，播放能启动。**

### 1.4 因此（相容，非成立）

挂死与该素材的 **10-bit / HDR** 属性高度相关。但**未确定是哪一个**：
10-bit 位深、HLG 色彩管理、10-bit 纹理上传路径，三者本轮均未单独分离。

**一条相关代码事实（相容，未证因果）**：`decode-capability.ts:26` 的能力探测只用
**8-bit** codec string：

```ts
hevc: ["hvc1.1.6.L120.B0", "hev1.1.6.L120.B0"],
```

而该素材是 **Main 10 / Level 150**。探测判「支持」、实际配置是 10-bit——二者错位。
这与该文件注释自述的「profile/tier/level 可能与实配 hvcC 错位」属同型问题，
**但本轮未验证该探测是否真的导致挂死路径**。

### 1.5 影响面（须同读）

iPhone 13 Pro 的默认视频编码即 **HEVC 10-bit HLG**。若本缺陷对
iPhone HDR 素材普遍成立，则**所有 iPhone HDR 视频在本产品内都无法播放**——
影响面远大于 P200 的「长时线冻结」。**但本轮只测了 1 条素材，不能外推。**

---

## 2. 缺陷 B（P204）：demuxer 不应用 edit list ⇒ 全帧 `no sample`

### 2.1 现象（观测）

用**转码后的 8-bit SDR 版**（不挂死）播放，指标条正常，但：

```
play#0  tc=00:00:00:00  err="解码失败 I0#1: no sample for frame 1 (best diff 591666.6666666666us)"
play#1  tc=00:00:00:00  err="解码失败 I0#2: no sample for frame 2 (best diff 558333.3333333334us)"
play#3  tc=00:00:00:00  err="解码失败 I0#0: no sample for frame 0 (best diff 625000us)"
```

**时间码全程停在 `00:00:00:00`。**

### 2.2 根因（成立）：edit list 偏移未被应用

该素材 st:0 的 `elst`：

```
Processing st: 0, edit list 0 - media time: 7680, duration: 1805820
```

`media_time=7680` / timescale `12288` = **0.625000s = 625000us**。

`bmff-demux.ts:345` 附近用 `ptsUs = (dts + ctsOffset)/timescale * 1e6` 计算 PTS，
**未减去 `media_time`** ⇒ 全体样本 PTS 相对真实呈现时间**整体后移 0.625s**。
而客户端请求从 0 开始，`locateByPts` 只能返回 0.625s 的首样本，
`bestDiff` 即整个偏移量。

### 2.3 决定性证据：两处逐位吻合

1. 实测 `best diff` = **625000us**；`media_time/timescale` = **0.625000s** = 625000us。
2. frame0→frame1→frame2 的 diff **每帧恰好减少 33333.33us（=1/30s）**，
   正是「最近样本恒为 0.625s、`targetUs` 按 `canvas.fps=30` 递增」的必然结果。

### 2.4 ⚠️ 更正前一版（本条初稿写错了）

初稿把根因写成「**VFR 网格不均匀**」。**该说法错误**：

- 若是网格非均匀，`frameN=0` 的误差应接近 0；实测 frame 0 就差 0.625s。
- 真正的解释是**整段常量偏移**，与 VFR 无关。
- `avg_frame_rate=176300/7347≈23.996` 确实说明有轻微 VFR，但它
  **不是**本缺陷的成因。

### 2.5 为什么这个缺陷一直没被发现（观测）

| 素材 | st:0 `media_time` | 结果 |
|---|---|---|
| `p200-long.mp4`（我此前的 H.264 夹具） | **0** | 不减也不产生偏移 ⇒ **缺陷静默** |
| 本条素材转码版 | **7680（0.625s）** | 全帧 `no sample` |

**⇒ 只有 `media_time ≠ 0` 的素材才暴露。** 此前所有夹具恰好都是 0，
所以这条缺陷在既有测试覆盖面之外。

x265/libkvazaar 在引入 B 帧重排时常写出非零 `media_time`，
这解释了为什么**转码**之后才暴露。

### 2.6 全仓确认

`elst`/`edts` **只出现在** `bmff-demux.ts:8` 的「不支持」注释里，**0 处处理逻辑**。

### 2.7 未证（不得越读）

- **未**验证「所有含 `elst` 偏移的素材都失败」——只测了这一条。
- **未**测 `media_time` 小于 33ms 容差时是否被吞掉而不报错。
- **未**在真正的 VFR 素材上对照 ⇒ **本缺陷与 VFR 无关**；
  VFR 素材是否另有问题，本轮未测。
- 原片（10-bit HDR）因 P203 挂死，**无法**验证同类偏移下的行为。

## 3. 证据等级汇总

| 断言 | 等级 |
|---|---|
| 原片点播放即挂死渲染进程（四次复现） | **观测** |
| 去掉 mebx 数据轨仍挂死 | **观测** |
| 转 8-bit SDR 后不挂死 | **观测** |
| 8-bit SDR 版全帧 `no sample`、时间码恒 0 | **观测** |
| `elst media_time=7680/12288=0.625s` 与 `best diff=625000us` 逐位吻合 | **观测** |
| `elst`/`edts` 全仓 0 处处理逻辑 | **观测** |
| 旧夹具 `media_time=0` ⇒ 缺陷静默 | **观测** |
| **P204 根因 = demuxer 不应用 edit list 偏移** | **成立**（两处独立数值吻合 + 代码路径 + 静默解释） |
| 挂死由 10-bit 或 HDR 导致 | **相容**（未分离二者） |
| iPhone HDR 素材普遍播不了 | **未证**（n=1，不得外推） |
| VFR 与本缺陷有关 | **已证伪**（初稿错误，见 §2.4） |

## 4. 复现

```bash
cd apps/desktop && pnpm build:e2e

# 缺陷 A：挂死（约 30s 即可判定「点不动」）
AIVS_PROBE_MEDIA="<原片>" AIVS_PROBE_LABEL=hevc10bit \
  npx playwright test --config=tests/playwright.config.ts \
  e2e/probe-media-accept.electron.spec.ts --reporter=line

# 缺陷 B：全帧 no sample（用转码后的 8-bit 版）
AIVS_PROBE_MEDIA="<8bit-sdr.mp4>" AIVS_PROBE_LABEL=hevc8bit \
  npx playwright test --config=tests/playwright.config.ts \
  e2e/probe-media-accept.electron.spec.ts --reporter=line
```

探针 `e2e/probe-media-accept.electron.spec.ts` 为本轮新增的最小复现载体：
逐步打点（app ready → 建项目 → 导入 → 落轨 → 出指标 → 点播放 → 采样时间码），
**用于把「挂在哪一步」与「播出什么」分开**，不依赖 `p33-user-drop` 的长流程。

---

## 5. 2026-11-01 追加：根因经 worker 实测索引定案 + 回归锁落地

### 5.1 决定性实测（本轮新增诊断取得）

在 worker 内新增 `sample_index_built` 诊断 trace（`VERIFY_TRACE` 门控，生产零开销），
对 P204 素材取得：

```
count = 3526   timescale = 12288   srcSampleCount = 3526
firstPtsUs  = 625000us
first10     = [625000, 666667, 708333, 750000, 791667, 833333, ...]
medianGapApprox = 41667us   (24fps)
```

**⇒ `buildSampleIndex` 产出的首帧 PTS 就是 0.625s**，而客户端请求从 0 起
⇒ `locateByPts` 只能返回该首样本 ⇒ `bestDiff` 恒为 625000us（与 frame0 实测**逐位一致**）。

### 5.2 数值闭合

`(0 + 7680) / 12288 × 1e6 = 625000us`

即原始 dts 起点 0 + ctsOffset 7680；而 `elst media_time = 7680` 本应抵消它。
**demuxer 不应用 `media_time` ⇒ 偏移留存。**

### 5.3 本轮我在同一问题上错了两次（记下以免重犯）

| 次序 | 错误假说 | 被什么推翻 |
|---|---|---|
| ① | 「VFR 网格不均匀」 | frame0 就报 625000us ⇒ 非网格非均匀 |
| ② | 「未减 media_time 也不成立」（我用 ffprobe 的 `dts=-7680` 手算得首帧应为 0） | **ffprobe 的 pts/dts 已应用 edit list**；demux 读的是原始 stbl 表（原始 dts 起点 0）。实测索引证明首帧就是 625000us |

**教训**：验证 demux 行为必须用 **demux 自己的输出**，不能用 ffprobe 的呈现值代替。

**更一般的规则（本轮起对 P200/P203/P204 一律适用）**：
标「成立」前必须有 **≥2 条独立数值/代码路径收敛**，且能解释「为何以前不显现」；
只有 1 条 = 最多标「相容」。

### 5.4 回归锁（已落地）

`apps/desktop/tests/p204-elst-offset.test.ts` + 夹具
`test-assets/generated/hevc-elst-offset-640x360.mp4`（274KB，`libkvazaar` 生成，
`media_time=7680 / timescale=15360 = 0.5s`，60 帧，`has_b_frames=15`）。

**设计要点（踩过两次坑后定型）**：

1. **用 `it.fails` 描述目标行为**，不是"锁住缺陷形态"。
   初版断言"首帧 PTS === media_time"，**变异验证时发现模拟修复后反而变红**——
   那会**阻止**正确改动，属假守卫。改为断言目标（`toBeCloseTo(0)`）+ `it.fails`
   ⇒ 修复实现后该用例转红并提示"已知缺陷已修复，请升级用例"。
2. **不硬编码具体 µs**。初版写死 `625000`，在合成夹具（timescale=15360 ⇒ 0.5s）上
   立即假红。改为与 `media_time/timescale` 的相对关系。
3. **必须有对照用例**（无偏移素材首帧 PTS = 0），证明锁不是恒真。

**变异验证（两组，还原后 `git diff` 为空）**：

| 变异 | 结果 |
|---|---|
| 粗暴：所有文件 dts 减 7680 | elst 用例红 **+ 对照用例也红** ⇒ 变异设计问题（不是锁的问题） |
| 条件化：仅对首包 `ctsOffset≠0` 的流减 | **只有 elst 用例红，对照保持绿** ⇒ 锁有精确区分力 |

**当前状态**：3/3 通过（其中 1 例为 `it.fails` 预期失败），
与既有 `bmff-demux.test.ts` 合计 **20 passed**。

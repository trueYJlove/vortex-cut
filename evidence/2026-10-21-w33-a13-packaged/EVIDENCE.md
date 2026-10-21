# W3.3 · A13 打包产物取证（PyInstaller 构建）

- 日期：2026-10-21（UTC 09:09 前后）
- 分支：`liuwei-dev`，被取证提交 **`e023f4aaaee2d6280913544185fe640dfe9836c4`**（2026-10-21 16:31:36 +0800）
- 结论：**A13 通过**（判据为"打包产物内实跑 mjpeg 编码成功 + 解码路径不受影响"，未触发"改用替代编码路径"条款）

---

## 0. 为什么不是"源码树通过"，以及构建隔离

规划门 §4 原文：**仅凭开发环境通过 ⇒ 红（必须打包环境证据）**。因此本次所有断言都针对
`pkg-resources/` 下**打包产物内的二进制**执行，源码树/仓库内二进制只作为**对照列**并列（见 §5）。

工作区当时有另两个执行者在改 `services/core/src/**` 与 `apps/desktop/**`，直接在工作区构建会打到半改状态的树上。
故用 **HEAD 的干净导出**构建：

```bash
git -C <repo> archive --format=tar HEAD | tar -x -C <tmp>/src
```

**实际使用的完整命令序列**（可复现）：

```bash
TMP=/c/Users/trueY/AppData/Local/Temp/a13-w33-packaged   # 行文用 MSYS 路径；实际传参用 C:/... 形式
mkdir -p "$TMP/src"
git -C /c/DataFolder/codes/AI-Vidio archive --format=tar HEAD | tar -x -C "$TMP/src"

# 随包 ffmpeg 被 .gitignore 忽略（.gitignore:29 resources/ffmpeg/win-x64/），
# 不在 git archive 里 —— 必须单独暂存，否则打包会缺 ffmpeg（这正是 build-sidecar.ps1 的第 3 步）
mkdir -p "$TMP/src/resources/ffmpeg/win-x64"
cp /c/DataFolder/codes/AI-Vidio/resources/ffmpeg/win-x64/ffmpeg.exe  "$TMP/src/resources/ffmpeg/win-x64/"
cp /c/DataFolder/codes/AI-Vidio/resources/ffmpeg/win-x64/ffprobe.exe "$TMP/src/resources/ffmpeg/win-x64/"

# 权威构建入口（package-win.mjs:223 调的就是它）
cd "$TMP/src"
powershell -NoProfile -ExecutionPolicy Bypass -File tools/packaging/build-sidecar.ps1 \
  -OutputRoot "C:/Users/trueY/AppData/Local/Temp/a13-w33-packaged/pkg-resources"
```

`build-sidecar.ps1` 内部执行（非本报告杜撰，见该脚本源文）：

```
uv run --locked --extra dev pyinstaller --version
uv run --locked --extra dev pyinstaller --clean --noconfirm \
    --distpath <导出>/dist/aivs-core --workpath <导出>/build/aivs-core \
    <导出>/services/core/aivs-core.spec
```

要点：
- `uv run --locked` **在导出目录里自建 `.venv`**（`Installed 53 packages in 4.12s`），
  未使用也未污染仓库根的 `.venv`。**不需要** `uv sync`，也**不需要**网络前置之外的人工干预（uv 缓存命中）。
- 构建走的是 `services/core/aivs-core.spec`（对 `av` 跑 `collect_all`），**不是**根目录被
  `.gitignore` 忽略的 `/aivs-core.spec`。产物 `_internal/av.libs/` 实有 **25 个 dll**，
  与任务书所述"早先错误立论已被证伪"一致。
- **未**打 Electron/NSIS 安装包（A13 判据只要求 PyInstaller 产物）。但 `build-sidecar.ps1` 的产物目录
  结构**与 electron-builder `extraResources` 完全一致**（`pkg-resources/{core/aivs-core, ffmpeg/win-x64, licenses, manifests}`），
  故 §1 的路径判据在生产安装包里同样成立。

### 运行时路径对得上（这条决定上面测的位置是不是"生产会用的那个文件"）
- `apps/desktop/electron/main/index.ts:917`：`ffmpegPath: join(resourcesPath, "ffmpeg", "win-x64", "ffmpeg.exe")`，
  `resourcesPath` = `app.isPackaged ? process.resourcesPath : ...`（`index.ts:906-910`）。
- `apps/desktop/electron/main/sidecar-supervisor.ts:56`：`"--ffmpeg", this.options.ffmpegPath, ...` 传给 sidecar。
- `services/core/src/aivs_core/bootstrap.py:29`：`--ffmpeg` 落到 `config.py:41`，即 keyframe 编码用的那个路径。

---

## 1. 产物存在性 ✅

| 文件 | 打包产物内路径 | 字节 | sha256 |
|---|---|---|---|
| ffmpeg.exe | `<pkg-resources>/ffmpeg/win-x64/ffmpeg.exe` | 169,719,296 | `a9eb7fb296bb7a7d140038f65064feb7a71fd79911f3341071c0fa8250db93ad` |
| ffprobe.exe | `<pkg-resources>/ffmpeg/win-x64/ffprobe.exe` | 169,523,200 | `08bae3206890afd5bd0a57f1e17c3d00527f464276f217f70d2625521f9adf52` |
| aivs-core.exe（sidecar） | `<pkg-resources>/core/aivs-core/aivs-core.exe` | 157,058,757 | `f82944ecc40868bd5761e5da436c5721d5fb27559b2866111798801013880a57` |

- 随包 ffmpeg sha256 **等于** `resources/manifests/components.json` 里登记的 pin（`a9eb7fb2…`，version `8.0.1-20260228`）。
- `matches_source_ffmpeg = true`：产物内 ffmpeg 与仓库 `resources/ffmpeg/win-x64/ffmpeg.exe` 同一份字节。
- `ffmpeg -version` 首行：`ffmpeg version n8.0.1-66-g27b8d1a017-20260228`。
- 尺寸总览：`core/aivs-core` 476M，`ffmpeg` 324M。

## 2. 编码器清单 ✅

对**产物内** ffmpeg 实跑 `-encoders`：

- 总行数：**237**
- `mjpeg` 命中行原文（第 77 行，`grep -n ' mjpeg ' raw/packaged-ffmpeg-encoders.txt`）：

```
77: VFS..D mjpeg                MJPEG (Motion JPEG)
```

其余两条附带命中（不是判据，列出以免误读）：
```
     V..... mjpeg_qsv            MJPEG (Intel Quick Sync Video acceleration) (codec mjpeg)
     V....D mjpeg_vaapi          MJPEG (VAAPI) (codec mjpeg)
```

- 判据是**精确行** `VFS..D mjpeg`（软件编码器，非 hwaccel）：`encoders.exact_mjpeg_encoder_line` 命中 1 条。
- 顺带记录：产物内 ffmpeg **无 libx264**（`--disable-libx264`，仅 `--enable-libopenh264`），
  与既有记录一致；本功能用 mjpeg，不受影响。

## 3. 编码成功 ✅

参数**逐字节复刻** `services/core/src/aivs_core/media/keyframe_encode.py` 的 `jpeg_args()`（HEAD 版）：
`-ss <t> -i <in> -frames:v 1 -vf scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)' -c:v mjpeg -q:v 3 -f image2 -`
（`JPEG_LONG_EDGE=768`、`JPEG_QSCALE=3`）。JPEG 尺寸用**独立自解析 SOF 段**得到，不调用 ffprobe。

| 夹具 | t=0.5s 产物内 | t=0.5s 源码树 | t=1.5s 产物内 | t=1.5s 源码树 | 字节相同 |
|---|---|---|---|---|---|
| test-faststart.mp4 (640×360, 255,341B) | 28,695B · 768×432 | 28,695B · 768×432 | 28,413B · 768×432 | 28,413B · 768×432 | ✅ 两组都 true |
| cfr-landscape-av.mp4 (640×360, 1,060,910B) | 29,082B · 768×432 | 29,082B · 768×432 | 28,997B · 768×432 | 28,997B · 768×432 | ✅ |
| av-440hz.mp4 (640×360, 275,090B) | 28,695B · 768×432 | 28,695B · 768×432 | 28,413B · 768×432 | 28,413B · 768×432 | ✅ |

- 每个输出都是合法 JPEG：SOI `FFD8` ✅、EOI `FFD9` ✅、SOF 可解析 ✅。
- **长边 = 768**，全部命中；短边按 `-2` 保持偶数（432）。
- **产物内与源码树字节完全一致（sha256 相同）**——不是"同尺寸"，是同一份字节。
  ⚠️ 这不构成"两条路径各有区分力"的强断言：两边 ffmpeg 是**同一份二进制**（§1 sha256 相等），
  所以该列证明的是"打进去的就是能跑的那份"，**不是**"两份独立实现对得上"。真正有区分力的是
  「打包这一动作是否损坏/遗漏了 ffmpeg」——由 §1 sha256==pin 与 §2 实跑 `-encoders` 杀掉。

## 4. 解码路径不受影响 ✅

全部用**产物内** `ffmpeg.exe` / `ffprobe.exe`，断言是自算的字节数/头签名，不采信工具自报。

**4a 视频解码（NV12 裸帧）** — `-frames:v 5 -f rawvideo -pix_fmt nv12 -`，期望字节 = 640×360×3/2×5：

| 夹具 | 解出帧数 | 实测字节 | 期望字节 | 相符 |
|---|---|---|---|---|
| test-faststart.mp4 | 5 | 1,728,000 | 1,728,000 | ✅ |
| cfr-landscape-av.mp4 | 5 | 1,728,000 | 1,728,000 | ✅ |
| av-440hz.mp4 | 5 | 1,728,000 | 1,728,000 | ✅ |

**4b 视频解码 → PNG**（`-c:v png`），断言 PNG 签名 + IHDR 尺寸与流尺寸一致：

| 夹具 | 字节 | IHDR | 与流尺寸一致 |
|---|---|---|---|
| test-faststart.mp4 | 48,158 | 640×360 | ✅ |
| cfr-landscape-av.mp4 | 52,012 | 640×360 | ✅ |
| av-440hz.mp4 | 48,158 | 640×360 | ✅ |

**4c 音频解码（PCM s16le @48k）** — 音频是 A13 原文点名的另一半：

| 夹具 | 音频流 | 实测字节 | 折合秒数 | 非空 |
|---|---|---|---|---|
| test-faststart.mp4 | **无** | 0 | — | 不适用（见下） |
| cfr-landscape-av.mp4 | aac 48k mono | 288,768 | 3.008s（容器 3.000s） | ✅ |
| av-440hz.mp4 | aac 48k mono | 192,512 | 2.005s（容器 2.000s） | ✅ |

- ⚠️ **如实说明（一次被自己纠正的误判）**：初次跑测把 `test-faststart.mp4` 纳入音频断言并判红。
  复核后确认是**我的断言写错**，不是产物问题：该夹具**本身就没有音频流**
  （`ffprobe` 只报 `index=0 h264 video`），ffmpeg 报 `Output file does not contain any stream`。
  仓库里**没有任何入库媒体带音频流**（`git ls-files` 的 mp4/mkv/mov 全部只有 h264；也无 wav/mp3/m4a）。
  故音频路径改用两份**确实含 aac 流**的夹具验证：`test-assets/generated/cfr-landscape-av.mp4`（本地产物）
  与 `av-440hz.mp4`（我用产物内 ffmpeg 现造：`-c:v copy` 直接复制入库视频流、加 440Hz 正弦音轨，
  视频侧未重编码，不影响视频判据）。

## 5. 独立性说明：哪几条只有"产物内"才能验

| 断言 | 源码树能否验 | 只有产物内才能验的理由 |
|---|---|---|
| ① 产物存在性 + sha256==pin | ❌ | 源码树里 ffmpeg 只是个普通文件；"它是否**被正确打进**产物"只有产物内有意义 |
| ② 产物内 `-encoders` 含 mjpeg | ❌ | 要证明的是**打包这一动作**没弄丢/弄坏编码器；测仓库副本测不到打包步骤 |
| ③ 产物内 mjpeg 编码成功、长边 768 | ❌ | 同上；且 §3 的对照列**不具独立区分力**（两边同一份二进制，见 §3 说明） |
| ④ 解码路径不受影响（视频 NV12/PNG + 音频 PCM） | ❌ | 同上 |
| （对照列）源码树同参同值 | ✅ | 仅作并列对照，**不作为 A13 通过的依据** |

**判据落点**：②③④ 全部在 `<pkg-resources>/ffmpeg/win-x64/` 下的二进制上执行；
源码树那组数字只是"同参同值"的旁证。A13 的绿**只由产物内那三条**支撑。

---

## 6. 复现

```bash
# 1) 干净导出 + 暂存随包 ffmpeg（见 §0）
# 2) 构建产物
cd <tmp>/src && powershell -NoProfile -ExecutionPolicy Bypass -File tools/packaging/build-sidecar.ps1 \
  -OutputRoot "<tmp>/pkg-resources"
# 3) 断言（脚本随本目录入库：verify_a13_v2.py）
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1   # 防 Git Bash 把 C:/ 路径改写成 //c/...
<repo>/.venv/Scripts/python.exe verify_a13_v2.py \
  "<tmp>/pkg-resources" \
  "<repo>/resources/ffmpeg/win-x64/ffmpeg.exe" \
  "<repo>/test-assets/test-faststart.mp4|<repo>/test-assets/generated/cfr-landscape-av.mp4|<tmp>/audio-fixture/av-440hz.mp4"
```

`verify_a13_v2.py` 只依赖标准库（`hashlib/json/struct/subprocess/pathlib`），自解析 JPEG SOF 与 PNG IHDR。

## 7. 原始输出清单

- `raw/a13-report.json` —— 完整机器可读结果（含 summary 全部 true）
- `raw/packaged-ffmpeg-encoders.txt` —— 产物内 `-encoders` 全文（237 行）
- `raw/packaged-ffmpeg-decoders.txt` —— 产物内 `-decoders` 全文（550 行）
- `raw/packaged-ffmpeg-version.txt` —— 产物内 `-version` 全文（含 build configuration）
- `raw/pkg-sha256.txt` —— 产物三件套 sha256
- `raw/build-log.txt` —— 构建日志**摘录**（完整日志未持久化，见该文件头部的诚实说明）
- `verify_a13_v2.py` —— 断言脚本

## 8. 未做到 / 存疑（明说）

1. **构建日志只有摘录**。PyInstaller 全量输出在后台作业缓冲里被消费掉，未落盘；
   事后**没有**重跑构建去补齐（重跑会得到不同 sha256 的 sidecar，反而破坏唯一性）。
   产物本身及其哈希是可复核的；日志不完整不影响 §1-§4 的断言，但"构建过程零警告"这类主张我**没有**证据，也不主张。
2. **未构建 Electron/NSIS 安装包**。A13 判据只要求 PyInstaller 产物；`extraResources` 布局已核，
   但"安装器装完之后文件还在"这一层**没有**被本次证据覆盖。
3. **未跑 Electron 主进程端到端**（未启动 Electron 去驱动 sidecar 编帧）。§4 证明的是 ffmpeg 解码路径正常，
   以及 §0 里 3 行代码把同一路径接到 sidecar——但"应用里点一下真的出图"没有实测。
4. **音频夹具是现造的**（`av-440hz.mp4`），因为仓库无带音轨的入库媒体；视频流为 `-c:v copy`
   （未重编码），音轨为合成正弦波。它能验证"音频解码路径不被影响"，但**不是**真实语音素材。
5. §3 的"产物内 vs 源码树字节相同"**区分力有限**（同一份二进制），已在 §5 明确标注，不当作强证据使用。

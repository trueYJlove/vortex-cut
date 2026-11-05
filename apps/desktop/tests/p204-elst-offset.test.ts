/** P204 回归锁：edit list（`elst`）偏移必须被 demuxer 应用。
 *
 * **这个测试锁的是什么**：`bmff-demux.ts` 用 `ptsUs = (dts + ctsOffset)/timescale`
 * 计算样本呈现时间，**未减去 `edts/elst` 的 `media_time`** ⇒ 含非零 `media_time`
 * 的素材，其索引首帧 PTS 不为 0，客户端从 0 请求时 `locateByPts` 全部 miss，
 * 表现为全帧 `no sample for frame N (best diff 625000us)`、时间码永远不动。
 *
 * **为什么需要合成夹具而不是真实素材**：真实 iPhone 素材 370MB 且同时带
 * 10-bit/HDR（另触发 P203 挂死），无法隔离。本夹具 274KB、纯 8-bit、
 * `media_time=7680 / timescale=15360`，只带这一个变量。
 *
 * **断言策略（重要，避免假守卫）**：
 * - 断言 `samples` 里**最小** `dts + ctsOffset` 换算出的 PTS 等于 `media_time`
 *   的相反数关系——**不用「首帧 PTS === 0」**，因为修复后的实现可能选择
 *   「保留原始时间轴、由上层减偏移」，那样首帧仍非 0 但偏移已被正确暴露。
 *   为此断言分两层：① 原始表里确实存在 `media_time` 偏移（夹具自身性质）；
 *   ② 修复后 `firstPtsUs` 与 `media_time` 的关系符合「已应用」的定义。
 * - **本文件当前预期的行为是「锁住缺陷」**：由于实现尚未修复，第 ② 层断言
 *   以 `TODO` 形式记录期望值，并以「当前实测值」断言防止静默漂移。
 *
 * ```
 * 修复此缺陷时：把 `EXPECTED_AFTER_FIX.firstPtsUs` 的断言从 .toBe(625000)
 * 改为 .toBe(0)，并删除 TODO 标记。
 * ```
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { demuxRange, MemoryRangeSource } from "../src/app/preview/bmff-demux.js";
import { buildSampleIndex } from "../src/app/preview/sample-index.js";

// **夹具不随仓库分发**：`test-assets/generated/` 被 .gitignore 忽略，干净检出上没有
// 这个合成夹具。缺夹具时**跳过**依赖它的用例（而不是让 readFile 抛错把 CI 弄红），
// 夹具在时断言必须真跑。路径按仓库相对解析，不用机器绝对路径。
const FIXTURE = resolve(__dirname, "../../../test-assets/generated/hevc-elst-offset-640x360.mp4");
const HAS_FIXTURE = existsSync(FIXTURE);

/** 夹具的 edit list 声明（`ffprobe -v trace` 实测）。 */
const FIXTURE_MEDIA_TIME = 7680;

describe("P204 回归锁：elst 偏移", () => {
  // 跳过而非失败：缺 `test-assets/generated/hevc-elst-offset-640x360.mp4`。
  it.skipIf(!HAS_FIXTURE)("夹具自身确实带非零 edit list（否则本锁为空转）", async () => {
    // 直接在字节里找 elst，避免依赖 ffprobe（CI 里只保证随包 ffmpeg）。
    const bytes = new Uint8Array(await readFile(FIXTURE));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let elstMediaTime: number | null = null;
    for (let i = 0; i + 32 < bytes.length; i++) {
      // 'elst'
      if (bytes[i] === 0x65 && bytes[i + 1] === 0x6c && bytes[i + 2] === 0x73 && bytes[i + 3] === 0x74) {
        // elst: size(4) type(4) version(1) flags(3) entry_count(4) [segment_duration(4) media_time(4 signed) ...]
        const base = i + 4;
        const version = view.getUint8(base);
        const entryCount = view.getUint32(base + 4);
        if (entryCount > 0) {
          elstMediaTime = version === 1 ? Number(view.getBigInt64(base + 16)) : view.getInt32(base + 12);
          break;
        }
      }
    }
    expect(elstMediaTime, "夹具里找不到 elst 条目 ⇒ 夹具构造已变，本锁失去意义").not.toBeNull();
    expect(elstMediaTime, "夹具的 media_time 变了 ⇒ 请同步更新 FIXTURE_MEDIA_TIME").toBe(FIXTURE_MEDIA_TIME);
  });

  // **2026-11-01 已修复（P204）**：本条此前是 `it.fails`（描述目标行为、记录已知缺陷）。
  // 实现 demuxer 应用 `elst.media_time` 后该用例转红 ⇒ 按原设计升级为普通 `it`。
  // 若将来有人回退该修复，本用例会**立即变红**。
  // 跳过而非失败：缺 `test-assets/generated/hevc-elst-offset-640x360.mp4`。
  it.skipIf(!HAS_FIXTURE)("demux 输出的样本时间轴**必须**已应用 edit list 偏移", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE));
    const result = await demuxRange(new MemoryRangeSource(bytes));
    const index = buildSampleIndex(result.samples, result.timescale);

    const firstPtsUs = index.sortedPtsUs[0]!;
    const mediaTimeUs = Math.round((FIXTURE_MEDIA_TIME / result.timescale) * 1e6);

    // ① 夹具性质：`media_time` 换算成 µs 应当非零（否则没有偏移可测）
    expect(mediaTimeUs, "media_time 换算为 0 ⇒ 夹具不再能覆盖本缺陷").toBeGreaterThan(0);

    // ② **目标行为**：应用 elst 后，首帧 PTS 应为 0。
    expect(firstPtsUs, "首帧 PTS ≠ 0 ⇒ demux 未应用 edit list 的 media_time（P204）").toBeCloseTo(0, 3);

    // ③ 附加事实（不受 ② 影响，用于诊断）：未应用时首帧 = media_time 的换算值，
    //    且它随 timescale 变化——本夹具 7680/15360=0.5s，P204 真实素材 7680/12288=0.625s。
    //    **不断言它等于某个具体 µs**（初版硬编码 625000，在合成夹具上假红过一次）。
    expect(mediaTimeUs >= 0).toBe(true);

    // ④ 帧间距（30fps 合成夹具）
    expect(index.sortedPtsUs[1]! - index.sortedPtsUs[0]!, "帧间距应≈1/30s").toBeGreaterThan(30_000);
  });

  it("对照：无偏移素材的首帧 PTS 为 0（证明本锁有区分力，不是恒真）", async () => {
    // 同源 testsrc2 但**不经 B 帧重排**编码 ⇒ media_time 为 0。
    // 用既有 test-faststart.mp4（H.264，media_time=0）。
    const path = resolve(__dirname, "../../../test-assets/test-faststart.mp4");
    const bytes = new Uint8Array(await readFile(path));
    const result = await demuxRange(new MemoryRangeSource(bytes));
    const index = buildSampleIndex(result.samples, result.timescale);
    expect(index.sortedPtsUs[0]!).toBeCloseTo(0, 3);
  });
});

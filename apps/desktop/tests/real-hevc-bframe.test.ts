import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { demuxRange, MemoryRangeSource } from "../src/app/preview/bmff-demux.js";
import { buildSampleIndex, locateByPts } from "../src/app/preview/sample-index.js";

// 真机素材不入库（13MB），只存在于开发者本机 ⇒ 位置不固定。
// 原先硬编码单一绝对路径，素材一挪目录（整理进子文件夹）本测试就 ENOENT 变红，
// 而它要验证的是 demux/PTS 网格逻辑，不是文件在哪。改为按候选路径探测，
// 全部缺失时显式 skip 并说明原因——避免"素材没放对 ⇒ 看起来像代码坏了"。
const CANDIDATES = [
  "C:/Users/trueY/Videos/fdf0f0e269126269ed686f208b3063e3.mp4",
  "C:/Users/trueY/Videos/20261020/fdf0f0e269126269ed686f208b3063e3.mp4",
];
const REAL = CANDIDATES.find(candidate => existsSync(candidate));

describe("real fdf0f0e2 HEVC", () => {
  it("demux + PTS 网格 + B 帧 cts", async () => {
    if (!REAL) {
      // 真机素材需本机自备：缺它就跳过，不以红代偿。
      console.warn("[skip] 未找到 fdf0f0e2 真机素材，候选路径：" + CANDIDATES.join(" | "));
      return;
    }
    const buf = await readFile(REAL);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const r = await demuxRange(new MemoryRangeSource(data));
    console.log("codec", r.codec, "desc_len", r.description.length, "size", r.width, r.height, "samples", r.samples.length, "ts", r.timescale);
    const first = r.samples.slice(0, 8).map(s => ({ dts: s.dts, cts: s.ctsOffset, sync: s.sync, pts: s.dts + s.ctsOffset }));
    console.log("first8", first);
    const idx = buildSampleIndex(r.samples, r.timescale);
    const fps = 30;
    for (const n of [0, 1, 2, 3, 30, 66, 87, 368]) {
      const targetUs = (n / fps) * 1e6;
      const hit = locateByPts(idx, targetUs);
      console.log(`n=${n} targetUs=${targetUs.toFixed(0)} hit=${hit.sample} pts=${idx.ptsUs[hit.sample]} diff=${hit.diffUs}`);
    }
    // 非零 cts 数量
    const nonzero = r.samples.filter(s => s.ctsOffset !== 0).length;
    console.log("nonzero_cts", nonzero, "/", r.samples.length);
    expect(r.codec.startsWith("hvc1") || r.codec.startsWith("hev1")).toBe(true);
    expect(r.samples.length).toBeGreaterThan(100);
    // 真机素材必须含非零 ctts（B 帧重排）——否则本回归覆盖不到顺序误判冷启
    expect(nonzero).toBeGreaterThan(100);
    // 呈现序采样号必须非单调（frameN 递增时 sample index 会回跳）
    const hits = [0, 1, 2, 3, 4, 5].map(n => locateByPts(idx, (n / fps) * 1e6).sample);
    const monotonic = hits.every((v, i) => i === 0 || v >= hits[i - 1]!);
    expect(monotonic).toBe(false);
  }, 60000);
});

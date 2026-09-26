import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { demuxRange, MemoryRangeSource } from "../src/app/preview/bmff-demux.js";
import { buildSampleIndex, locateByPts } from "../src/app/preview/sample-index.js";

const REAL = "C:/Users/trueY/Videos/fdf0f0e269126269ed686f208b3063e3.mp4";

describe("real fdf0f0e2 HEVC", () => {
  it("demux + PTS 网格 + B 帧 cts", async () => {
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

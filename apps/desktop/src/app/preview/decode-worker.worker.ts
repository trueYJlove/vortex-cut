/**
 * M3-0 P3 WebCodecs 寻址 Worker：手写 BMFF(MP4) demuxer + VideoDecoder。
 *
 * demuxer 决策（冻结方案 §7.3"开工时定并写入报告"）：**手写 BMFF 解析**，
 * 不引入 mp4box.js —— 探针素材为自产 faststart 单视频轨 H.264（无 B 帧，
 * openh264），仅需 stsd/stts/stss/stsc/stsz/stco/co64/ctts 八张表；
 * ctts 仍按规范解析以兼容生产 proxy 产物。
 * 长帧缓存模式：LRU 缓存已解码 VideoFrame（close() 纪律 + 内存记账）。
 */

interface Sample {
  offset: number;
  size: number;
  dts: number;        // 媒体 timescale 单位
  ctsOffset: number;
  sync: boolean;
}

interface DemuxResult {
  samples: Sample[];
  timescale: number;
  width: number;
  height: number;
  avcC: Uint8Array;
  codec: string;
}

type Outbound =
  | { type: "ready"; sampleCount: number; durationUs: number; timescale: number; keyframes: number[]; width: number; height: number; hardware: string | null; cacheEnabled: boolean; cacheCap: number }
  | { type: "frame"; id: number; frameN: number; timestampUs: number; fromCache: boolean; samplesFed: number; fromKeyframe: number; allocationSize: number; frame: VideoFrame }
  | { type: "done"; id: number | null; note: string }
  | { type: "error"; id: number | null; message: string };

const post = (message: Outbound, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

function findBox(buffer: DataView, start: number, end: number, path: string[]): Array<{ start: number; end: number }> {
  // 返回 path 全部命中（取最后一个用于 stsd 单例、stss 等可能多处者取各自语义）
  let results: Array<{ start: number; end: number }> = [{ start, end }];
  for (const name of path) {
    const next: Array<{ start: number; end: number }> = [];
    for (const span of results) {
      let offset = span.start;
      while (offset + 8 <= span.end) {
        let size = buffer.getUint32(offset);
        const type = String.fromCharCode(buffer.getUint8(offset + 4), buffer.getUint8(offset + 5), buffer.getUint8(offset + 6), buffer.getUint8(offset + 7));
        let headerSize = 8;
        if (size === 1) {
          size = Number(buffer.getBigUint64(offset + 8));
          headerSize = 16;
        } else if (size === 0) {
          size = span.end - offset;
        }
        if (size < headerSize) break;
        if (type === name) next.push({ start: offset + headerSize, end: Math.min(offset + size, span.end) });
        offset += size;
      }
    }
    results = next;
    if (results.length === 0) return [];
  }
  return results;
}

function findU32Tag(u8: Uint8Array, start: number, end: number, tag: number): number {
  for (let offset = start; offset + 4 <= end; offset++) {
    if (u8[offset] === (tag >>> 24) && u8[offset + 1] === ((tag >>> 16) & 0xff)
      && u8[offset + 2] === ((tag >>> 8) & 0xff) && u8[offset + 3] === (tag & 0xff)) {
      return offset - 4; // 盒起始（size 字段）
    }
  }
  return -1;
}

function demux(bytes: ArrayBuffer): DemuxResult {
  const view = new DataView(bytes);
  const u8 = new Uint8Array(bytes);
  const moov = findBox(view, 0, bytes.byteLength, ["moov"]);
  if (!moov.length) throw new Error("moov not found");
  const trak = findBox(view, moov[0].start, moov[0].end, ["trak"]);
  let chosen: { start: number; end: number } | null = null;
  for (const candidate of trak) {
    const hdlr = findBox(view, candidate.start, candidate.end, ["mdia", "hdlr"]);
    if (hdlr.length) {
      const handler = String.fromCharCode(view.getUint8(hdlr[0].start + 8), view.getUint8(hdlr[0].start + 9), view.getUint8(hdlr[0].start + 10), view.getUint8(hdlr[0].start + 11));
      if (handler === "vide") { chosen = candidate; break; }
    }
  }
  if (!chosen) throw new Error("video trak not found");
  const mdhd = findBox(view, chosen.start, chosen.end, ["mdia", "mdhd"])[0];
  const timescale = view.getUint32(mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12));
  const stblStart = findBox(view, chosen.start, chosen.end, ["mdia", "minf", "stbl"])[0];
  if (!stblStart) throw new Error("stbl not found");

  const stsd = findBox(view, stblStart.start, stblStart.end, ["stsd"])[0];
  // stsd payload: [0..4) version+flags, [4..8) entry_count, [8..) sample entry。
  // 不同 muxer 的 VisualSampleEntry 固定区宽度有差异（qt 风格 dpi/compressorname），
  // 故子盒（avcC）用字节扫描定位并校验盒长。
  const entrySize = view.getUint32(stsd.start + 8);
  const entryType = String.fromCharCode(
    view.getUint8(stsd.start + 12), view.getUint8(stsd.start + 13),
    view.getUint8(stsd.start + 14), view.getUint8(stsd.start + 15));
  if (entryType !== "avc1") throw new Error(`unsupported sample entry ${entryType} (only AVC supported in probe)`);
  const entryStart = stsd.start + 16; // avc1 payload（width/height 在 +24/+26）
  const entryEndAbs = stsd.start + 8 + entrySize;
  const avcCStart = findU32Tag(u8, entryStart + 60, entryEndAbs, 0x61766343); // "avcC"
  if (avcCStart < 0) throw new Error("avcC not found (only AVC supported in probe)");
  const avcCSize = view.getUint32(avcCStart);
  if (avcCSize < 8 || avcCStart + avcCSize > entryEndAbs) throw new Error("avcC box size invalid");
  const avcC = { start: avcCStart + 8, end: avcCStart + avcCSize };
  const avcCBytes = u8.slice(avcC.start, avcC.end);
  const profile = avcCBytes[1];
  const compat = avcCBytes[2];
  const level = avcCBytes[3];
  const codec = `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
  const width = view.getUint16(entryStart + 24);
  const height = view.getUint16(entryStart + 26);

  const stts = findBox(view, stblStart.start, stblStart.end, ["stts"])[0];
  const stssList = findBox(view, stblStart.start, stblStart.end, ["stss"]);
  const stsc = findBox(view, stblStart.start, stblStart.end, ["stsc"])[0];
  const stsz = findBox(view, stblStart.start, stblStart.end, ["stsz"])[0];
  const stco = findBox(view, stblStart.start, stblStart.end, ["stco"]);
  const co64 = findBox(view, stblStart.start, stblStart.end, ["co64"]);
  const cttsList = findBox(view, stblStart.start, stblStart.end, ["ctts"]);

  // stsz payload: [0..4) version+flags, [4..8) default sample_size, [8..12) sample_count
  const defaultSize = view.getUint32(stsz.start + 4);
  const sampleCount = view.getUint32(stsz.start + 8);
  const sizes: number[] = [];
  let sizesOffset = stsz.start + 12;
  for (let index = 0; index < sampleCount; index++) {
    sizes.push(defaultSize > 0 ? defaultSize : view.getUint32(sizesOffset + index * 4));
  }
  // stts → 解码时间戳
  const dts: number[] = new Array(sampleCount);
  let time = 0;
  let sampleIndex = 0;
  let entryCount = view.getUint32(stts.start + 4);
  let cursor = stts.start + 8;
  for (let entry = 0; entry < entryCount && sampleIndex < sampleCount; entry++) {
    const runCount = view.getUint32(cursor);
    const delta = view.getUint32(cursor + 4);
    cursor += 8;
    for (let run = 0; run < runCount && sampleIndex < sampleCount; run++) {
      dts[sampleIndex++] = time;
      time += delta;
    }
  }
  // stco/stsc → 采样偏移
  const chunkOffsets: number[] = [];
  if (co64.length) {
    const count = view.getUint32(co64[0].start + 4);
    for (let index = 0; index < count; index++) chunkOffsets.push(Number(view.getBigUint64(co64[0].start + 8 + index * 8)));
  } else if (stco.length) {
    const count = view.getUint32(stco[0].start + 4);
    for (let index = 0; index < count; index++) chunkOffsets.push(view.getUint32(stco[0].start + 8 + index * 4));
  } else {
    throw new Error("no chunk offset box");
  }
  const offsets = new Array<number>(sampleCount);
  entryCount = view.getUint32(stsc.start + 4);
  cursor = stsc.start + 8;
  let chunkIndex = 0;
  let sampleInChunk = 0;
  let samplesSoFar = 0;
  let nextEntry = 0;
  const entries: Array<{ firstChunk: number; perChunk: number; }> = [];
  for (let entry = 0; entry < entryCount; entry++) {
    entries.push({ firstChunk: view.getUint32(cursor), perChunk: view.getUint32(cursor + 4) });
    cursor += 12;
  }
  while (samplesSoFar < sampleCount && chunkIndex < chunkOffsets.length) {
    while (nextEntry + 1 < entries.length && entries[nextEntry + 1]!.firstChunk === chunkIndex + 1) nextEntry += 1;
    const perChunk = entries[nextEntry]!.perChunk;
    let offset = chunkOffsets[chunkIndex]!;
    for (let run = 0; run < perChunk && samplesSoFar < sampleCount; run++) {
      offsets[samplesSoFar] = offset;
      offset += sizes[samplesSoFar]!;
      samplesSoFar += 1;
      sampleInChunk += 1;
    }
    chunkIndex += 1;
  }
  if (samplesSoFar !== sampleCount) throw new Error(`stsc expansion short: ${samplesSoFar}/${sampleCount}`);
  // stss → 关键帧集合
  const syncSet = new Set<number>();
  if (stssList.length) {
    const count = view.getUint32(stssList[0]!.start + 4);
    for (let index = 0; index < count; index++) syncSet.add(view.getUint32(stssList[0]!.start + 8 + index * 4) - 1);
  } else {
    for (let index = 0; index < sampleCount; index++) syncSet.add(index); // 全关键帧
  }
  // ctts → 合成偏移（version 0 unsigned / version 1 signed）
  const ctsOffsets = new Array<number>(sampleCount).fill(0);
  for (const ctts of cttsList) {
    const version = view.getUint8(ctts.start);
    entryCount = view.getUint32(ctts.start + 4);
    cursor = ctts.start + 8;
    let index = 0;
    for (let entry = 0; entry < entryCount && index < sampleCount; entry++) {
      const runCount = view.getUint32(cursor);
      const raw = view.getInt32(cursor + 4);
      cursor += 8;
      for (let run = 0; run < runCount && index < sampleCount; run++) {
        ctsOffsets[index++] = version === 0 ? raw >>> 0 : raw;
      }
    }
  }
  const samples: Sample[] = [];
  for (let index = 0; index < sampleCount; index++) {
    samples.push({ offset: offsets[index]!, size: sizes[index]!, dts: dts[index]!, ctsOffset: ctsOffsets[index]!, sync: syncSet.has(index) });
  }
  return { samples, timescale, width, height, avcC: avcCBytes, codec };
}

let demuxResult: DemuxResult | null = null;
let dataBytes: Uint8Array | null = null;
let decoder: VideoDecoder | null = null;
let decoderConfig: VideoDecoderConfig | null = null;
let hardware: string | null = null;

let cacheEnabled = false;
let cacheCap = 0;
const cache = new Map<number, VideoFrame>(); // LRU：key = sample index
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;
let cacheBytes = 0;
let pendingResolve: ((frame: VideoFrame) => void) | null = null;
let fedIndex = -1; // 解码器已馈送的最后一个采样索引（热态顺序解码游标）
let targetTimestampUs = 0;
let samplesFed = 0;
let fromKeyframe = -1;

async function init(url: string, cacheFrames: number): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  dataBytes = new Uint8Array(await response.arrayBuffer());
  demuxResult = demux(dataBytes.buffer);
  cacheEnabled = cacheFrames > 0;
  cacheCap = cacheFrames;
  const config: VideoDecoderConfig = {
    codec: demuxResult.codec,
    codedWidth: demuxResult.width,
    codedHeight: demuxResult.height,
    description: demuxResult.avcC,
    optimizeForLatency: true,
    // 色彩矩阵钉死 BT.709（冻结方案 §7.2 比对口径；texImage2D(VideoFrame) 转换依此）
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  };
  decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      if (pendingResolve && Math.abs(frame.timestamp - targetTimestampUs) <= 33_334) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(frame);
      } else {
        frame.close();
      }
    },
    error: (error: DOMException) => {
      const resolve = pendingResolve;
      pendingResolve = null;
      post({ type: "error", id: null, message: `decoder error: ${error.message}` });
      resolve?.(null as unknown as VideoFrame);
    },
  });
  const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" });
  if (support.supported) {
    decoderConfig = { ...config, hardwareAcceleration: "prefer-hardware" };
    hardware = "prefer-hardware";
  } else {
    decoderConfig = config;
    hardware = "no-preference";
  }
  decoder.configure(decoderConfig);
  const last = demuxResult.samples.at(-1)!;
  post({
    type: "ready",
    sampleCount: demuxResult.samples.length,
    durationUs: Math.round(((last.dts + last.ctsOffset) / demuxResult.timescale) * 1e6),
    timescale: demuxResult.timescale,
    keyframes: demuxResult.samples.map((sample, index) => (sample.sync ? index : -1)).filter(index => index >= 0),
    width: demuxResult.width, height: demuxResult.height,
    hardware, cacheEnabled, cacheCap,
  });
}

function cachePut(sampleIndex: number, frame: VideoFrame): void {
  if (!cacheEnabled) return;
  if (cache.has(sampleIndex)) return;
  while (cache.size >= cacheCap) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest)!;
    cacheBytes -= evicted.allocationSize();
    evicted.close();
    cache.delete(oldest);
    cacheEvictions += 1;
  }
  cache.set(sampleIndex, frame);
  cacheBytes += frame.allocationSize();
}

function decodeFrame(id: number, frameN: number, fps: number): void {
  if (!demuxResult || !decoder || !dataBytes) throw new Error("worker not initialized");
  const { samples, timescale } = demuxResult;
  const targetUs = (frameN / fps) * 1e6;
  // 找 PTS 最接近目标的采样（PTS = dts + ctsOffset）：取最小 |pts−target|，
  // 避免容差窗口命中前一帧（实测曾致合成内容系统性早一帧）。
  let target = -1;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length; index++) {
    const ptsUs = ((samples[index]!.dts + samples[index]!.ctsOffset) / timescale) * 1e6;
    const diff = Math.abs(ptsUs - targetUs);
    if (diff < bestDiff) { bestDiff = diff; target = index; }
    if (ptsUs > targetUs + 100_000) break;
  }
  if (target < 0 || bestDiff > 33_334) throw new Error(`no sample for frame ${frameN} (best diff ${bestDiff}us)`);
  // 缓存命中先行（不触碰解码器状态）
  if (cacheEnabled && cache.has(target)) {
    cacheHits += 1;
    const cached = cache.get(target)!.clone();
    post({ type: "frame", id, frameN, timestampUs: cached.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: cached.allocationSize(), frame: cached }, [cached]);
    return;
  }
  cacheMisses += cacheEnabled ? 1 : 0;
  // 热态顺序解码（M3-2 播放架构）：目标 == 已馈送位置 + 1 时不 reset——每帧只喂
  // 下一个样本（无 B 帧，解码序 = 显示序，~2-5ms/帧）；跳转才 reset + 关键帧重解。
  // reset 会清空配置且可能长时间阻塞硬件解码器——scrub 逐帧 reset 是 M3-0 后期
  // "decode timeout" 的根因，播放路径严禁。
  const sequential = fedIndex >= 0 && target === fedIndex + 1;
  let startSample = sequential ? fedIndex + 1 : target;
  if (!sequential) {
    startSample = target;
    while (startSample > 0 && !samples[startSample]!.sync) startSample -= 1; // 回退最近关键帧
  }
  if (!sequential) {
    decoder.reset(); // reset 清空配置且可能长时间阻塞硬件解码器——播放路径严禁逐帧 reset
    decoder.configure(decoderConfig as VideoDecoderConfig);
    fedIndex = -1;
  }
  pendingResolve = null;
  const promise = new Promise<VideoFrame>(resolve => { pendingResolve = resolve; });
  targetTimestampUs = targetUs;
  samplesFed = 0;
  fromKeyframe = sequential ? fedIndex + 1 : startSample;
  for (let index = startSample; index <= target; index++) {
    const sample = samples[index]!;
    const chunkData = dataBytes.subarray(sample.offset, sample.offset + sample.size);
    const chunk = new EncodedVideoChunk({
      type: sample.sync ? "key" : "delta",
      timestamp: ((sample.dts + sample.ctsOffset) / timescale) * 1e6,
      data: chunkData,
    });
    decoder.decode(chunk);
    samplesFed += 1;
    fedIndex = index;
  }
  void promise.then(frame => {
    if (!frame) {
      post({ type: "error", id, message: "decode timeout/no matching frame" });
      return;
    }
    cachePut(target, frame);
    const clone = frame.clone();
    post({ type: "frame", id, frameN, timestampUs: clone.timestamp, fromCache: false, samplesFed, fromKeyframe: fromKeyframe, allocationSize: clone.allocationSize(), frame: clone }, [clone]);
  });
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { type: string; url?: string; cacheFrames?: number; id?: number; frameN?: number; fps?: number };
  try {
    if (data.type === "init" && data.url) {
      void init(data.url, data.cacheFrames ?? 0);
    } else if (data.type === "decode" && typeof data.id === "number" && typeof data.frameN === "number") {
      decodeFrame(data.id, data.frameN, data.fps ?? 30);
    } else if (data.type === "stats") {
      post({ type: "done", id: null, note: JSON.stringify({ hits: cacheHits, misses: cacheMisses, evictions: cacheEvictions, size: cache.size, bytes: cacheBytes }) });
    }
  } catch (error) {
    post({ type: "error", id: (data as { id?: number }).id ?? null, message: error instanceof Error ? error.message : String(error) });
  }
};

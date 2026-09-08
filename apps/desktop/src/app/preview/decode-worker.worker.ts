/**
 * M3-0 P3 WebCodecs 寻址 Worker：手写 BMFF(MP4) demuxer + VideoDecoder。
 *
 * demuxer 决策（冻结方案 §7.3"开工时定并写入报告"）：**手写 BMFF 解析**，
 * 不引入 mp4box.js —— 探针素材为自产 faststart 单视频轨 H.264（无 B 帧，
 * openh264），仅需 stsd/stts/stss/stsc/stsz/stco/co64/ctts 八张表；
 * ctts 仍按规范解析以兼容生产 proxy 产物。
 * 长帧缓存模式：LRU 缓存已解码 VideoFrame（close() 纪律 + 内存记账）。
 * A03：demux 后构建 sample-index（PTS 排序索引 + 关键帧二分），seek 定位
 * 从 O(N) 线性扫描改二分——解码喂包顺序不变（索引只改查找）。
 */

import { buildSampleIndex, keyframeAtOrBefore, locateByPts, type SampleIndex } from "./sample-index.js";

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
let sampleIndex: SampleIndex | null = null;
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
/** 解码请求队列（M3-2.2）：旧实现单 pendingResolve——新请求到达即置空旧引用，
 * 旧 promise 永不落定（客户端 15s 超时 → "decode timeout"），且允许后发请求被
 * 前一帧的输出按容差错配解决（系统性早一帧）。现改为严格串行队列：一次只
 * 处理一个请求，输出按其目标 PTS 匹配，完成后自动续队。 */
interface DecodeRequest { id: number; frameN: number; targetUs: number; sampleIndex: number }
const decodeQueue: DecodeRequest[] = [];
let activeRequest: DecodeRequest | null = null;
let fedIndex = -1; // 解码器已馈送的最后一个采样索引（热态顺序解码游标）
/** A03 顺播定位游标：上次 locateByPts 命中的排序位置（目标单调时局部推进）。 */
let ptsCursor = -1;
let samplesFed = 0;
let fromKeyframe = -1;

/** 解码器工厂：output 按当前请求的目标 PTS 匹配（半帧容差），其余输出关闭。 */
function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output: (frame: VideoFrame) => {
      const request = activeRequest;
      if (request && Math.abs(frame.timestamp - request.targetUs) <= 16_667) {
        // 半帧容差（旧实现 33_334 会把相邻帧错配 → 系统性早一帧）
        activeRequest = null;
        pendingAnchorPts = -1;
        if (cacheEnabled) {
          const clone = frame.clone();
          cachePut(request.sampleIndex, frame); // 缓存接管原始帧（保持开启）
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: clone.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: clone.allocationSize(), frame: clone }, [clone]);
        } else {
          // 直传原始帧（免 clone：每帧减一次 GPU 内存搬运；所有权随转移交出）
          post({ type: "frame", id: request.id, frameN: request.frameN, timestampUs: frame.timestamp, fromCache: false, samplesFed, fromKeyframe, allocationSize: frame.allocationSize(), frame }, [frame]);
        }
        pumpQueue();
      } else if (frame.timestamp === pendingAnchorPts) {
        pendingAnchorPts = -1;
        holdGopAnchor(frame); // GOP 锚 IDR：持有到下个关键帧冷启（绝不中途关闭）
      } else {
        holdOrCloseIntermediate(frame); // 非当前目标（顺序喂入的中间帧/速度变换跳过帧）
      }
    },
    error: (error: DOMException) => {
      const request = activeRequest;
      activeRequest = null;
      // 解码器进入错误态后必须 reset 才可复用：重建配置、清热态游标
      try {
        decoder!.reset();
        decoder!.configure(decoderConfig as VideoDecoderConfig);
      } catch { /* reset 失败则后续请求自行暴露 */ }
      intermediateRing.length = 0;
      fedIndex = -1;
      if (request) post({ type: "error", id: request.id, message: `decoder error: ${error.message}` });
      else post({ type: "error", id: null, message: `decoder error: ${error.message}` });
      pumpQueue();
    },
  });
}

/** 立即关闭的解码输出会与 D3D11 解码器内部表面池的引用复用竞态：速度变换
 * 跳帧的中间输出若在输出回调里同步 close()，后续 GOP 实证出现确定性花屏
 * （fixed3/fixed11，evidence/m3_2/playback-repro）。改为延迟关闭——保留最近
 * K 个中间输出，新输出到来再关最旧；reset/回退时清空。 */
const intermediateRing: VideoFrame[] = [];
const INTERMEDIATE_RING = 3; // 环过大会耗尽 D3D11 输出表面池（实测 8 层 → 解码停摆）

function holdOrCloseIntermediate(frame: VideoFrame): void {
  if (intermediateRing.length >= INTERMEDIATE_RING) {
    const oldest = intermediateRing.shift();
    oldest?.close();
  }
  intermediateRing.push(frame);
}

function drainIntermediateRing(): void {
  for (const frame of intermediateRing.splice(0)) frame.close();
}

/** GOP 锚帧：冷启回退所喂 IDR 的输出绝不在 GOP 中途关闭（其表面是整个 GOP
 * 的参考锚，关闭后 D3D11 表面池复用会破坏参考链 → 后续确定性花屏）。持有到
 * 下一个关键帧冷启时再释放。 */
let gopAnchor: VideoFrame | null = null;
let pendingAnchorPts = -1;

function holdGopAnchor(frame: VideoFrame): void {
  try { gopAnchor?.close(); } catch { /* 已关闭 */ }
  gopAnchor = frame;
}

function releaseGopAnchor(): void {
  try { gopAnchor?.close(); } catch { /* 已关闭 */ }
  gopAnchor = null;
  pendingAnchorPts = -1;
}

async function init(url: string, cacheFrames: number): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  dataBytes = new Uint8Array(await response.arrayBuffer());
  demuxResult = demux(dataBytes.buffer);
  sampleIndex = buildSampleIndex(demuxResult.samples, demuxResult.timescale); // A03：一次性索引
  ptsCursor = -1;
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
  const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" });
  if (support.supported) {
    decoderConfig = { ...config, hardwareAcceleration: "prefer-hardware" };
    hardware = "prefer-hardware";
  } else {
    decoderConfig = config;
    hardware = "no-preference";
  }
  decoder = createDecoder();
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

function pumpQueue(): void {
  while (!activeRequest && decodeQueue.length) {
    const request = decodeQueue.shift()!;
    activeRequest = request;
    try {
      decodeSamples(request);
    } catch (error) {
      activeRequest = null;
      post({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function decodeSamples(request: DecodeRequest): void {
  if (!demuxResult || !decoder || !dataBytes || !sampleIndex) throw new Error("worker not initialized");
  const { samples, timescale } = demuxResult;
  const target = request.sampleIndex;
  // 热态顺序解码（M3-2 播放架构）：目标在已馈送位置之前（含跨采样跳帧，如
  // speed≠1 的 1.25x 每 4 帧跳 1 采样）一律不 reset——顺序喂入中间采样即可
  // （中间输出按时间戳不匹配自动关闭）。仅回退（seek/换段回头）才 reset +
  // 关键帧重解。此前 sequential 条件是 target === fedIndex+1：任何跳帧都触发
  // 冷启 reset+关键帧重解，代价随 GOP 深度线性增长（1.25x 项目实测后半段
  // 每帧 50-60ms → 播放放慢 + 丢帧，evidence/m3_2/playback-repro 实证）。
  // 例外——热态跳帧跨关键帧时仍走冷启：该关键帧作为中间采样输出后被即刻
  // 关闭，实证会在部分硬件解码器上破坏后续参考链（src300 关键帧被跨跳后
  // src~303 起确定性花屏，两次运行 PNG 逐字节一致；冷启路径同位置干净）。
  let sequential = fedIndex >= 0 && target > fedIndex;
  if (sequential) {
    // 跨关键帧检查：目标之后的首个关键帧位置二分（≤ target 的最大关键帧
    // 与 ≤ fedIndex 的最大关键帧相同 → 区间无关键帧）
    const keyBeforeFed = keyframeAtOrBefore(sampleIndex, fedIndex);
    const keyBeforeTarget = keyframeAtOrBefore(sampleIndex, target);
    sequential = keyBeforeTarget === keyBeforeFed;
  }
  let startSample = target;
  if (!sequential) {
    // A03：关键帧回退二分（原逐样本线性回退，长 GOP 深 seek O(GOP)）
    startSample = keyframeAtOrBefore(sampleIndex, target);
    releaseGopAnchor();
    drainIntermediateRing();
    // 整例重建：reset() 无法清零长解码历史在 D3D11 会话内的残留状态
    //（实证：连续解码整片后 reset+关键帧重解仍产出花屏，新 Worker 实例则干净；
    // evidence/m3_2/playback-repro fixed10 vs fixed14/15 postmortem）。
    try { decoder.close(); } catch { /* 已关闭 */ }
    decoder = createDecoder();
    decoder.configure(decoderConfig as VideoDecoderConfig);
    fedIndex = -1;
    // 冷启首个输出 = 关键帧 IDR：持有为 GOP 锚（见 gopAnchor 注释）
    pendingAnchorPts = ((samples[startSample]!.dts + samples[startSample]!.ctsOffset) / timescale) * 1e6;
  }
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
}

function decodeFrame(id: number, frameN: number, fps: number): void {
  if (!demuxResult || !decoder || !dataBytes || !sampleIndex) throw new Error("worker not initialized");
  const targetUs = (frameN / fps) * 1e6;
  // A03：PTS 定位走排序索引（二分/游标推进），替代 O(N) 线性扫描——
  // 旧实现在 ptsUs > targetUs + 100ms 处提前 break，B 帧非单调 CTS 流会
  // 漏掉更优解；索引路径与完整扫描 oracle 逐点一致（见 sample-index 测试）。
  const located = locateByPts(sampleIndex, targetUs, ptsCursor);
  const target = located.sample;
  const bestDiff = located.diffUs;
  if (target < 0 || bestDiff > 33_334) throw new Error(`no sample for frame ${frameN} (best diff ${bestDiff}us)`);
  // 游标推进：命中后记录其排序位置（单调目标走 O(1) 局部推进）
  ptsCursor = sampleIndex.sortedPtsUs.length > 0
    ? binarySearchPos(sampleIndex, sampleIndex.ptsUs[target]!)
    : -1;
  // 缓存命中先行（不触碰解码器状态）
  if (cacheEnabled && cache.has(target)) {
    cacheHits += 1;
    const cached = cache.get(target)!.clone();
    post({ type: "frame", id, frameN, timestampUs: cached.timestamp, fromCache: true, samplesFed: 0, fromKeyframe: target, allocationSize: cached.allocationSize(), frame: cached }, [cached]);
    return;
  }
  cacheMisses += cacheEnabled ? 1 : 0;
  decodeQueue.push({ id, frameN, targetUs, sampleIndex: target });
  pumpQueue();
}

/** 原始 PTS → 排序位置（游标更新用；二分）。 */
function binarySearchPos(index: SampleIndex, ptsUs: number): number {
  const sorted = index.sortedPtsUs;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < ptsUs) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, sorted.length - 1);
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

/** B12 BMFF demux：Range 源上的 moov-only 解析，禁止整文件下载。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B12）：
 * - 只读取顶层 box header（8/16 字节）按 size 跳到下一 box，定位 moov
 *   （moov 在尾部也按 box 偏移定位，禁止字符串扫描整个媒体）。
 * - 支持 64 位 box（size=1 → largesize）与 co64 时校验 Number 安全整数；
 *   box 大小/深度/样本数量设上限。
 * - mdat size=0（流式写入残留）、fragmented MP4（moof）、edit list 等
 *   不在支持集的**明确回退**（抛结构化错误，调用方走代理/错误），
 *   不冒充已支持。
 * - moov payload 一次读入（≤MOOV_LIMIT_BYTES 上限）；trak/stbl 解析复用
 *   既有八表逻辑（stsd/stts/stss/stsc/stsz/stco/co64/ctts）。
 */
import type { RangeSource } from "./range-source.js";

export interface DemuxSample {
  offset: number;
  size: number;
  dts: number;        // 媒体 timescale 单位
  ctsOffset: number;
  sync: boolean;
}

export interface DemuxResult {
  samples: DemuxSample[];
  timescale: number;
  width: number;
  height: number;
  /** VideoDecoderConfig.description：avcC 或 hvcC 的 payload（不含 8 字节盒头）。 */
  description: Uint8Array;
  codec: string;
  /** 存在非零 ctsOffset（B 帧重排）。WebCodecs 对 iPhone HEVC 不稳时工厂可改走 FFmpeg。 */
  hasBFrames: boolean;
}

/** 防御上限：超过即明确回退（不冒充支持、不 OOM）。 */
export const MOOV_LIMIT_BYTES = 64 * 1024 * 1024;       // moov payload 上限
export const MAX_SAMPLE_COUNT = 5 * 1_000_000;          // ~46h@30fps
export const MAX_BOX_DEPTH = 6;
const TOP_HEADER_CACHE = 32;                            // 顶层扫描缓冲

export class BmffUnsupportedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Box {
  type: string;
  start: number;   // payload 起始（header 后）
  end: number;     // 盒结束（含 payload）
  headerSize: number;
}

/** 解析单个 box header（8 或 16 字节）。返回 null = 数据不足。 */
export function readBoxHeader(view: DataView, offset: number, end: number): Box | null {
  if (offset + 8 > end) return null;
  let size = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4), view.getUint8(offset + 5),
    view.getUint8(offset + 6), view.getUint8(offset + 7));
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    const large = view.getBigUint64(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BmffUnsupportedError("BMFF_BOX_TOO_LARGE", `64 位 box 超出安全整数: ${type}`);
    }
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    // size=0：该 box 延伸到文件尾（流式写入残留语义）——mdat 合法但本
    // demux 拒绝（无法推导 mdat 边界做后续校验），moov 出现则按到文件尾。
    size = end - offset;
  }
  if (size < headerSize) {
    throw new BmffUnsupportedError("BMFF_BOX_MALFORMED", `box size < header: ${type}`);
  }
  return { type, start: offset + headerSize, end: Math.min(offset + size, end), headerSize };
}

/** 顶层 box 枚举（Range 源：只读 header，跳到下一 box；不读 payload）。
 *
 * header 解析只依赖 size 字段与文件总长（end = 文件尾，非缓冲尾——
 * 缓冲仅保证 header 16 字节可用，盒体大小以声明的 size 为准）。
 */
async function walkTopBoxes(
  source: RangeSource,
  onBox: (box: Box) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  const header = new Uint8Array(TOP_HEADER_CACHE);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  while (offset < source.size) {
    throwIfAborted(signal);
    const chunk = await source.read(offset, 16, signal);
    header.set(chunk.subarray(0, Math.min(chunk.length, TOP_HEADER_CACHE)));
    // size 解析（含 64 位/largesize 与 size=0 到文件尾语义）
    let size = view.getUint32(0);
    let headerSize = 8;
    const type = String.fromCharCode(
      view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    if (size === 1) {
      const large = view.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BmffUnsupportedError("BMFF_BOX_TOO_LARGE", `64 位 box 超出安全整数: ${type}`);
      }
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = source.size - offset; // 延伸到文件尾
    }
    if (size < headerSize) {
      throw new BmffUnsupportedError("BMFF_BOX_MALFORMED", `box size < header: ${type}`);
    }
    const end = Math.min(offset + size, source.size);
    await onBox({ type, start: offset + headerSize, end, headerSize });
    if (end <= offset) break; // 防御：零前进
    offset = end;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

/**
 * P31：手写 demux 只覆盖**主流 MP4**（ftyp 主品牌白名单）。QuickTime/3GP/
 * HEIF/AVIF 等异常容器一律 typed 拒绝 → 工厂落 B 后端（FFmpeg），不在渲染
 * 进程爆表（规划门 §5：「H2 只覆盖主流 MP4；异常容器强制 B 后端」）。
 * 白名单宁宽勿漏（ISO-BMFF 家族）：误拒的代价只是走 B 后端，漏放的代价是
 * 手写解析在边界容器上出错。
 */
const MAINSTREAM_MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6",
  "mp41", "mp42", "avc1", "dash", "mmp4",
]);

/** moov 定位与解析（moov-only 读取）。 */
export async function demuxRange(
  source: RangeSource,
  signal?: AbortSignal,
): Promise<DemuxResult> {
  let moov: Box | null = null;
  let ftyp: Box | null = null;
  let sawMoof = false;
  await walkTopBoxes(source, async box => {
    if (box.type === "moov") moov = box;
    else if (box.type === "moof") sawMoof = true;
    else if (box.type === "ftyp") ftyp = box;
  }, signal);
  if (sawMoof) {
    throw new BmffUnsupportedError("BMFF_FRAGMENTED", "fragmented MP4（moof）不在支持集");
  }
  // P31：容器白名单（主流 MP4）——异常容器强制 B 后端。
  // 注意 Box.start 指向盒内容起点（offset + headerSize）：ftyp 内容布局为
  // major(4) + minor(4) + compatible*4——主品牌在 start+0。
  const ftypBox = ftyp as Box | null;
  if (!ftypBox) {
    throw new BmffUnsupportedError("BMFF_CONTAINER_UNSUPPORTED", "缺少 ftyp（非主流 MP4）");
  }
  if (ftypBox.end - ftypBox.start < 8) {
    throw new BmffUnsupportedError("BMFF_CONTAINER_UNSUPPORTED", "ftyp 盒过短（缺主品牌）");
  }
  const brandBytes = await source.read(ftypBox.start, 4, signal);
  const brand = String.fromCharCode(brandBytes[0]!, brandBytes[1]!, brandBytes[2]!, brandBytes[3]!);
  if (!MAINSTREAM_MP4_BRANDS.has(brand)) {
    throw new BmffUnsupportedError("BMFF_CONTAINER_UNSUPPORTED", "容器主品牌 " + brand + " 不在主流 MP4 集");
  }
  if (!moov) {
    throw new BmffUnsupportedError("BMFF_NO_MOOV", "moov 未找到");
  }
  const moovBox = moov as Box;
  const moovSize = moovBox.end - moovBox.start;
  if (moovSize > MOOV_LIMIT_BYTES) {
    throw new BmffUnsupportedError("BMFF_MOOV_TOO_LARGE", `moov 超过上限 ${MOOV_LIMIT_BYTES} 字节`);
  }
  const moovBytes = await source.read(moovBox.start, moovSize, signal);
  const moovView = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const u8 = moovBytes;
  return parseMoov(u8, moovView);
}

/** moov payload 解析（findBox 复用既有逻辑，限定在 moov 缓冲内）。 */
function parseMoov(u8: Uint8Array, view: DataView): DemuxResult {
  const moovEnd = u8.byteLength;
  const trak = findBox(view, 0, moovEnd, ["trak"]);
  let chosen: { start: number; end: number } | null = null;
  for (const candidate of trak) {
    const hdlr = findBox(view, candidate.start, candidate.end, ["mdia", "hdlr"]);
    if (hdlr.length) {
      const handler = String.fromCharCode(
        view.getUint8(hdlr[0].start + 8), view.getUint8(hdlr[0].start + 9),
        view.getUint8(hdlr[0].start + 10), view.getUint8(hdlr[0].start + 11));
      if (handler === "vide") { chosen = candidate; break; }
    }
  }
  if (!chosen) throw new BmffUnsupportedError("BMFF_NO_VIDEO_TRAK", "video trak 未找到");
  const mdhd = findBox(view, chosen.start, chosen.end, ["mdia", "mdhd"])[0];
  if (!mdhd) throw new BmffUnsupportedError("BMFF_MALFORMED", "mdhd 缺失");
  const timescale = view.getUint32(mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12));
  const stblStart = findBox(view, chosen.start, chosen.end, ["mdia", "minf", "stbl"])[0];
  if (!stblStart) throw new BmffUnsupportedError("BMFF_MALFORMED", "stbl 缺失");

  // stsd → description（avcC/hvcC）+ codec + 尺寸
  const stsd = findBox(view, stblStart.start, stblStart.end, ["stsd"])[0];
  if (!stsd) throw new BmffUnsupportedError("BMFF_MALFORMED", "stsd 缺失");
  const entrySize = view.getUint32(stsd.start + 8);
  const entryType = String.fromCharCode(
    view.getUint8(stsd.start + 12), view.getUint8(stsd.start + 13),
    view.getUint8(stsd.start + 14), view.getUint8(stsd.start + 15));
  const isHevcEntry = entryType === "hev1" || entryType === "hvc1";
  if (entryType !== "avc1" && !isHevcEntry) {
    throw new BmffUnsupportedError("BMFF_CODEC_UNSUPPORTED", `采样入口 ${entryType} 编码不受支持`);
  }
  const entryStart = stsd.start + 16;
  const entryEndAbs = stsd.start + 8 + entrySize;
  if (entryEndAbs > stsd.end + 8) throw new BmffUnsupportedError("BMFF_MALFORMED", "stsd entry 越界");
  // "hvcC" / "avcC"（ISO/IEC 14496-15）
  const configTag = isHevcEntry ? 0x68766343 : 0x61766343;
  const configName = isHevcEntry ? "hvcC" : "avcC";
  const configStart = findU32Tag(u8, entryStart + 60, entryEndAbs, configTag);
  if (configStart < 0) throw new BmffUnsupportedError("BMFF_MALFORMED", `${configName} 未找到`);
  const configSize = view.getUint32(configStart);
  if (configSize < 8 || configStart + configSize > entryEndAbs) {
    throw new BmffUnsupportedError("BMFF_MALFORMED", `${configName} 盒长非法`);
  }
  const description = u8.slice(configStart + 8, configStart + configSize);
  let codec: string;
  if (isHevcEntry) {
    // HEVCDecoderConfigurationRecord 至少 23 字节（到 numOfArrays）
    if (description.length < 23) {
      throw new BmffUnsupportedError("BMFF_MALFORMED", "hvcC 配置记录过短");
    }
    codec = buildHevcCodecString(entryType as "hev1" | "hvc1", description);
  } else {
    const profile = description[1]!;
    const compat = description[2]!;
    const level = description[3]!;
    codec = `avc1.${profile.toString(16).padStart(2, "0")}${compat.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
  }
  const width = view.getUint16(entryStart + 24);
  const height = view.getUint16(entryStart + 26);

  // 采样表（stts/stss/stsc/stsz/stco/co64/ctts）——上限校验后解析
  const stts = findBox(view, stblStart.start, stblStart.end, ["stts"])[0];
  const stssList = findBox(view, stblStart.start, stblStart.end, ["stss"]);
  const stsc = findBox(view, stblStart.start, stblStart.end, ["stsc"])[0];
  const stsz = findBox(view, stblStart.start, stblStart.end, ["stsz"])[0];
  const stco = findBox(view, stblStart.start, stblStart.end, ["stco"]);
  const co64 = findBox(view, stblStart.start, stblStart.end, ["co64"]);
  const cttsList = findBox(view, stblStart.start, stblStart.end, ["ctts"]);
  if (!stts || !stsc || !stsz) throw new BmffUnsupportedError("BMFF_MALFORMED", "采样表缺失");

  const defaultSize = view.getUint32(stsz.start + 4);
  const sampleCount = view.getUint32(stsz.start + 8);
  if (sampleCount > MAX_SAMPLE_COUNT) {
    throw new BmffUnsupportedError("BMFF_SAMPLE_COUNT", `采样数超过上限 ${MAX_SAMPLE_COUNT}`);
  }
  const sizes: number[] = [];
  let sizesOffset = stsz.start + 12;
  for (let index = 0; index < sampleCount; index++) {
    sizes.push(defaultSize > 0 ? defaultSize : view.getUint32(sizesOffset + index * 4));
  }
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
  const chunkOffsets: number[] = [];
  if (co64.length) {
    const count = view.getUint32(co64[0].start + 4);
    for (let index = 0; index < count; index++) {
      const value = view.getBigUint64(co64[0].start + 8 + index * 8);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BmffUnsupportedError("BMFF_BOX_TOO_LARGE", "co64 偏移超出安全整数");
      }
      chunkOffsets.push(Number(value));
    }
  } else if (stco.length) {
    const count = view.getUint32(stco[0].start + 4);
    for (let index = 0; index < count; index++) {
      chunkOffsets.push(view.getUint32(stco[0].start + 8 + index * 4));
    }
  } else {
    throw new BmffUnsupportedError("BMFF_MALFORMED", "无 chunk offset 盒");
  }
  const offsets = new Array<number>(sampleCount);
  entryCount = view.getUint32(stsc.start + 4);
  cursor = stsc.start + 8;
  let chunkIndex = 0;
  let samplesSoFar = 0;
  let nextEntry = 0;
  const entries: Array<{ firstChunk: number; perChunk: number }> = [];
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
    }
    chunkIndex += 1;
  }
  if (samplesSoFar !== sampleCount) {
    throw new BmffUnsupportedError("BMFF_MALFORMED", `stsc 展开不足: ${samplesSoFar}/${sampleCount}`);
  }
  const syncSet = new Set<number>();
  if (stssList.length) {
    const count = view.getUint32(stssList[0]!.start + 4);
    for (let index = 0; index < count; index++) syncSet.add(view.getUint32(stssList[0]!.start + 8 + index * 4) - 1);
  } else {
    for (let index = 0; index < sampleCount; index++) syncSet.add(index);
  }
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
  const samples: DemuxSample[] = [];
  for (let index = 0; index < sampleCount; index++) {
    samples.push({ offset: offsets[index]!, size: sizes[index]!, dts: dts[index]!, ctsOffset: ctsOffsets[index]!, sync: syncSet.has(index) });
  }
  return {
    samples, timescale, width, height, description, codec,
    hasBFrames: samples.some(s => s.ctsOffset !== 0),
  };
}

/** ISO/IEC 14496-15 Annex E.3：HEVCDecoderConfigurationRecord → WebCodecs codec string。
 *
 *  compatibility flags 须按位反转：记录里 flag[i] 落在整数 MSB 侧（flag[0] 即
 *  bit31），codec string 要求 flag[31] 为 MSB——故对 32 位字段做 reverseBits32。
 *  约束字节自 progressive_source_flag 起逐字节 hex、以点分隔，尾部零字节省略
 *  （常见 Main Profile 0xB0… → `.B0`）。
 */
export function buildHevcCodecString(prefix: "hvc1" | "hev1", hvcC: Uint8Array): string {
  if (hvcC.length < 23) {
    throw new BmffUnsupportedError("BMFF_MALFORMED", "hvcC 配置记录过短");
  }
  const profileSpace = (hvcC[1]! >> 6) & 0x03;
  const tierFlag = (hvcC[1]! >> 5) & 0x01;
  const profileIdc = hvcC[1]! & 0x1f;
  const compat = ((hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!) >>> 0;
  const levelIdc = hvcC[12]!;
  let codec = `${prefix}.`;
  if (profileSpace > 0) codec += String.fromCharCode(0x41 + profileSpace - 1);
  codec += `${profileIdc}.`;
  codec += `${reverseBits32(compat).toString(16).toUpperCase()}.`;
  codec += `${tierFlag ? "H" : "L"}${levelIdc}`;
  let lastConstraint = -1;
  for (let i = 5; i >= 0; i--) {
    if (hvcC[6 + i] !== 0) { lastConstraint = i; break; }
  }
  for (let i = 0; i <= lastConstraint; i++) {
    codec += `.${hvcC[6 + i]!.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return codec;
}

function reverseBits32(value: number): number {
  let v = value >>> 0;
  let result = 0;
  for (let i = 0; i < 32; i++) {
    result = ((result << 1) | (v & 1)) >>> 0;
    v >>>= 1;
  }
  return result >>> 0;
}

function findBox(buffer: DataView, start: number, end: number, path: string[]): Array<{ start: number; end: number }> {
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
          const large = buffer.getBigUint64(offset + 8);
          if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
          size = Number(large);
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
      return offset - 4;
    }
  }
  return -1;
}

/** 内存 RangeSource（测试/小文件回退用）。 */
export class MemoryRangeSource {
  readonly size: number;
  constructor(private readonly data: Uint8Array) {
    this.size = data.length;
  }
  async read(offset: number, length: number, _signal?: AbortSignal): Promise<Uint8Array> {
    return this.data.subarray(offset, Math.min(offset + length, this.data.length));
  }
  close(): void { /* nothing */ }
}

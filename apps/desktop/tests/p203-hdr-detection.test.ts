/** P203 回归锁：demux 必须能识别 HDR 素材（colr 盒 transfer characteristics）。
 *
 * **为什么需要**：Chromium 136 的 WebCodecs HEVC 路径解 10-bit HLG 会产出
 * `format === null` 的不可用帧并让渲染进程永久堵死。产品此前**连素材是不是
 * HDR 都不知道**，因此无法提示用户。本锁守住「能识别」这一前提。
 *
 * 判据：transfer = 16 (PQ) 或 18 (HLG) ⇒ hdr=true；无 colr 或其余值 ⇒ false。
 * **保守性要求**：宁可漏报（把 HDR 当 SDR），不可误报（把 SDR 当 HDR）——
 * 误报会让正常素材被提示「可能无法预览」，那是虚假告警。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { demuxRange, MemoryRangeSource } from "../src/app/preview/bmff-demux.js";

// **夹具不随仓库分发**：`/.tmp/`（.gitignore:45）与 `test-assets/generated/`（.gitignore:16）
// 都被忽略，干净检出上没有这两个夹具。路径按仓库相对解析，缺夹具时**跳过该用例**
// （而不是让 readFile 抛错把 CI 弄红）；夹具在时断言必须真跑。
const HDR_FIXTURE = resolve(__dirname, "../../../.tmp/hevc/raw-remux.mp4");
const SDR_FIXTURE = resolve(__dirname, "../../../test-assets/generated/hevc-elst-offset-640x360.mp4");
const HAS_HDR_FIXTURE = existsSync(HDR_FIXTURE);
const HAS_SDR_FIXTURE = existsSync(SDR_FIXTURE);

describe("P203 demux HDR 识别", () => {
  // 跳过而非失败：缺 `.tmp/hevc/raw-remux.mp4`（10-bit HLG 原始素材，/.tmp/ 被 .gitignore 忽略）。
  it.skipIf(!HAS_HDR_FIXTURE)("10-bit HLG 素材：认定 hdr=true，transfer=18", async () => {
    const bytes = new Uint8Array(await readFile(HDR_FIXTURE));
    const r = await demuxRange(new MemoryRangeSource(bytes));
    // ffprobe 实测：color_transfer=arib-std-b67（HLG）= 18
    expect(r.colorTransfer, "未读到 colr 的 transfer 字段").toBe(18);
    expect(r.hdr, "HLG 素材应判定为 HDR").toBe(true);
  });

  // 跳过而非失败：缺 `test-assets/generated/hevc-elst-offset-640x360.mp4`（整个 generated/ 被 .gitignore 忽略）。
  it.skipIf(!HAS_SDR_FIXTURE)("8-bit SDR 素材：认定 hdr=false（不误报）", async () => {
    const bytes = new Uint8Array(await readFile(SDR_FIXTURE));
    const r = await demuxRange(new MemoryRangeSource(bytes));
    // 合成夹具无 colr 或为 bt709；两种都不应判为 HDR
    expect(r.hdr, "SDR 素材被误判为 HDR 会产生虚假告警").toBe(false);
  });

  it("H.264 SDR 素材：认定 hdr=false", async () => {
    const bytes = new Uint8Array(await readFile(resolve(__dirname, "../../../test-assets/test-faststart.mp4")));
    const r = await demuxRange(new MemoryRangeSource(bytes));
    expect(r.hdr).toBe(false);
  });
});
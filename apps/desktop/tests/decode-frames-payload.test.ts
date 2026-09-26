import { describe, expect, it } from "vitest";
import { unpackNv12Response } from "../src/app/preview/decode-capability.js";

function packFixture(): ArrayBuffer {
  const y = new Uint8Array([1, 2, 3, 4]);
  const uv = new Uint8Array([9, 8]);
  const note = new TextEncoder().encode("ok");
  const header = new Uint8Array(12 + 2 + note.length + 28 + y.length + uv.length);
  const view = new DataView(header.buffer);
  header.set([0x41, 0x49, 0x56, 0x31], 0); // AIV1
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint16(12, note.length, true);
  header.set(note, 14);
  let o = 14 + note.length;
  view.setUint32(o, 7, true);
  view.setUint32(o + 4, 2, true);
  view.setUint32(o + 8, 2, true);
  view.setUint32(o + 12, 2, true);
  view.setUint32(o + 16, 2, true);
  view.setUint32(o + 20, y.length, true);
  view.setUint32(o + 24, uv.length, true);
  o += 28;
  header.set(y, o);
  header.set(uv, o + y.length);
  return header.buffer;
}

describe("unpackNv12Response", () => {
  it("解出平面与帧号（与 Core pack_nv12_response 对齐）", () => {
    const frames = unpackNv12Response(packFixture());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ frameN: 7, width: 2, height: 2, strideY: 2, strideUv: 2 });
    expect(Array.from(frames[0]!.y)).toEqual([1, 2, 3, 4]);
    expect(Array.from(frames[0]!.uv)).toEqual([9, 8]);
  });

  it("坏 magic 明确失败", () => {
    const bad = new Uint8Array(12).buffer;
    expect(() => unpackNv12Response(bad)).toThrow(/bad magic/);
  });
});

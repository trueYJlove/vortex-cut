import { describe, expect, it } from "vitest";
import { parseSubtitleFile } from "../src/app/subtitleImport.js";

const SRT = `1
00:00:01,000 --> 00:00:02,500
第一句

2
00:00:03,000 --> 00:00:04,200
<i>第二句</i>
第二行
`;

const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:06.50,Default,,0,0,0,,{\\pos(1,1)}第三句
Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,第四句\\N第二行
`;

const LRC = `[00:10.00]第五句
[00:20.50]第六句
`;

describe("subtitle import", () => {
  it("parses SRT blocks with inline tags stripped and multi-line text", () => {
    const entries = parseSubtitleFile("a.srt", SRT);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ start_us: 1_000_000, end_us: 2_500_000, text: "第一句" });
    expect(entries[1].text).toBe("第二句\n第二行");
    expect(entries[1].start_us).toBe(3_000_000);
  });

  it("parses ASS dialogue lines stripping override tags and honoring Format order", () => {
    const entries = parseSubtitleFile("a.ass", ASS);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("第三句");
    expect(entries[0].start_us).toBe(5_000_000);
    expect(entries[1].text).toBe("第四句\n第二行");
  });

  it("parses LRC stamps and fills end times from the next line", () => {
    const entries = parseSubtitleFile("a.lrc", LRC);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ start_us: 10_000_000, end_us: 20_500_000, text: "第五句" });
    expect(entries[1].end_us - entries[1].start_us).toBe(5_000_000); // 尾条兜底 5s
  });

  it("rejects unsupported extensions and empty files with friendly errors", () => {
    expect(() => parseSubtitleFile("a.txt", "hello")).toThrow("仅支持");
    expect(() => parseSubtitleFile("a.srt", "没有块")).toThrow("没有可识别");
  });

  it("sorts entries by start time regardless of file order", () => {
    const shuffled = SRT.replace("1\n00:00:01,000", "1\n00:00:03,000");
    const entries = parseSubtitleFile("b.srt", shuffled);
    expect(entries.map((e) => e.start_us)).toEqual([...entries.map((e) => e.start_us)].sort((a, b) => a - b));
  });
});

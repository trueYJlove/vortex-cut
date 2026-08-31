/**
 * 本地字幕文件解析（剪映式"导入本地字幕"）：支持 SRT / ASS / LRC。
 * 输出统一为 { start_us, end_us, text } 条目（µs），供 import_captions
 * patch 操作批量落库。解析失败抛 Error（message 面向用户）。
 */

export interface SubtitleEntry {
  start_us: number;
  end_us: number;
  text: string;
}

/** 00:00:01,250 / 0:01:02.5 → µs（秒部分允许小数）。 */
function parseClock(raw: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) throw new Error(`无法解析时间：${raw}`);
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  if (minutes > 59 || seconds > 59) throw new Error(`时间数值越界：${raw}`);
  return (((hours * 60 + minutes) * 60 + seconds) * 1000 + millis) * 1000;
}

/** SRT：块之间空行分隔；块内序号行 + "start --> end" 行 + 文本行。 */
function parseSrt(source: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const blocks = source.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue; // 纯序号/杂项块跳过
    const [rawStart, rawEnd] = lines[timingIndex].split("-->");
    if (!rawStart || !rawEnd) throw new Error("SRT 时间行不合法");
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // 去除 <i> 等内联标签
      .trim();
    if (text.length === 0) continue;
    entries.push({ start_us: parseClock(rawStart), end_us: parseClock(rawEnd), text });
  }
  if (entries.length === 0) throw new Error("SRT 文件中没有可识别的字幕");
  return entries;
}

/** ASS/SSA Dialogue 行：Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text。 */
function parseAss(source: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  let format: string[] | null = null;
  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.toLowerCase().startsWith("format:")) {
      const section = source.slice(0, source.toLowerCase().indexOf(line.toLowerCase())).toLowerCase();
      if (section.includes("[events]")) {
        format = line.slice(7).split(",").map((part) => part.trim().toLowerCase());
      }
      continue;
    }
    if (!line.toLowerCase().startsWith("dialogue:")) continue;
    const body = line.slice(9).trim();
    const parts = body.split(",");
    const textIndex = format ? format.indexOf("text") : 9;
    if (parts.length < 10 || textIndex < 0) continue;
    const start = parseClock(parts[format ? format.indexOf("start") : 1]);
    const end = parseClock(parts[format ? format.indexOf("end") : 2]);
    const text = parts
      .slice(textIndex)
      .join(",")
      .replace(/\{[^}]*\}/g, "") // 去除 {\pos...} 等覆盖标签
      .replace(/\\N|\\n/g, "\n")
      .trim();
    if (text.length === 0 || end <= start) continue;
    entries.push({ start_us: start, end_us: end, text });
  }
  if (entries.length === 0) throw new Error("ASS 文件中没有可识别的 Dialogue 行");
  return entries;
}

/** LRC：[mm:ss.xx] 行内可多时间标签；无结束时间 → 结束 = 下一条开始（兜底 5s）。 */
function parseLrc(source: string): SubtitleEntry[] {
  const timed: Array<{ at: number; text: string }> = [];
  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;
    const text = rawLine.replace(/\[[^\]]*\]/g, "").trim();
    if (text.length === 0) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const centis = stamp[3] ? Number(stamp[3].padEnd(2, "0")) : 0;
      if (seconds > 59) throw new Error(`LRC 时间越界：${stamp[0]}`);
      timed.push({ at: ((minutes * 60 + seconds) * 1000 + centis * 10) * 1000, text });
    }
  }
  timed.sort((a, b) => a.at - b.at);
  if (timed.length === 0) throw new Error("LRC 文件中没有可识别的时间标签");
  return timed.map((item, index) => {
    const next = timed[index + 1];
    const end = next ? Math.max(next.at, item.at + 200_000) : item.at + 5_000_000;
    return { start_us: item.at, end_us: end, text: item.text };
  });
}

/** 按扩展名分发解析；条目按开始时间升序返回。 */
export function parseSubtitleFile(fileName: string, content: string): SubtitleEntry[] {
  const lower = fileName.toLowerCase();
  const entries =
    lower.endsWith(".srt")
      ? parseSrt(content)
      : lower.endsWith(".ass") || lower.endsWith(".ssa")
        ? parseAss(content)
        : lower.endsWith(".lrc")
          ? parseLrc(content)
          : throwUnsupported(fileName);
  return [...entries].sort((a, b) => a.start_us - b.start_us);
}

function throwUnsupported(fileName: string): never {
  throw new Error("仅支持 SRT / ASS / SSA / LRC 字幕文件");
}

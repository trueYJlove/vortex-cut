import { describe, expect, it } from "vitest";
import { formatLocalDateTime, formatLocalStamp } from "../src/app/localTime.js";

describe("本地时间显示（UTC → 本地时区）", () => {
  it("把 UTC ISO 串转为本地时间，而不是直接截字符串", () => {
    // 回归（2026-10-06 现场）：Core 落库 11:25Z，用户本地为 UTC+8，
    // 旧实现 slice(5,16) 直接显示 "10-06 11:25"（错），应为本地 19:25。
    const utc = "2026-10-06T11:25:39.989Z";
    const expected = new Date(utc);
    const stamp = formatLocalStamp(utc);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(stamp).toBe(
      `${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ${pad(expected.getHours())}:${pad(expected.getMinutes())}`,
    );
    // 断言与 UTC 直读不同（在非 UTC 时区下必然不同，证明确实做了转换）
    const offsetMinutes = expected.getTimezoneOffset();
    if (offsetMinutes !== 0) {
      expect(stamp).not.toBe("10-06 11:25");
    }
  });

  it("formatLocalDateTime 输出 YYYY-MM-DD HH:mm", () => {
    const utc = "2026-10-06T11:25:39.989Z";
    expect(formatLocalDateTime(utc)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("空值与不可解析串安全降级，不抛异常", () => {
    expect(formatLocalStamp("")).toBe("");
    expect(formatLocalStamp(null)).toBe("");
    expect(formatLocalStamp(undefined)).toBe("");
    // 不可解析：退回原始串的安全截断（不显示 "Invalid Date"）
    expect(formatLocalStamp("not-a-time")).toBe("-time");
    expect(formatLocalDateTime("not-a-time")).toBe("not-a-time");
  });
});

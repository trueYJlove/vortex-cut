import { describe, expect, it } from "vitest";
import { safeErrorMessage, safeTaskErrorMessage } from "../src/app/safeErrors.js";

const DEFAULT_FALLBACK = "操作未完成，请刷新后重试。";
const TASK_FALLBACK = "任务未完成；请检查任务状态或刷新后重试。";

const SAFE_STRINGS = new Set([
  "时间线已发生变化，请刷新后重试。",
  "草稿已发生变化，请刷新后重试。",
  "当前项目还没有时间线。",
  "该 Provider 尚未完成 AI 修改兼容性测试。",
  "该 Provider 不支持当前 AI 修改响应格式。",
  "当前 Provider 尚未配置完成。",
  "当前 Provider 不支持此操作。",
  "确认已过期，请重新准备外传内容。",
  DEFAULT_FALLBACK,
  TASK_FALLBACK,
]);

describe("safeErrors", () => {
  it("renders a known code from a { code, message } object", () => {
    expect(safeErrorMessage({ code: "TIMELINE_CONFLICT", message: "conflict" })).toBe("时间线已发生变化，请刷新后重试。");
  });

  it("renders a known code carried in Error.message", () => {
    expect(safeErrorMessage(new Error("TIMELINE_PATCH_PROVIDER_UNTESTED"))).toBe("该 Provider 尚未完成 AI 修改兼容性测试。");
  });

  it("extracts a bracketed code from IPC-stripped errors ([CODE] message)", () => {
    // Electron IPC 剥掉自定义 .code 属性；主进程 fetchWithUi 以 "[CODE] message" 传递业务码。
    expect(safeErrorMessage(new Error("[TIMELINE_NOT_FOUND] 项目尚未创建时间线"))).toBe("当前项目还没有时间线。");
    expect(safeErrorMessage(new Error("[TIMELINE_CONFLICT] conflict"))).toBe("时间线已发生变化，请刷新后重试。");
    expect(safeErrorMessage(new Error("[404] Core request failed"))).toBe(DEFAULT_FALLBACK);
  });

  it("falls back for an unknown error", () => {
    expect(safeErrorMessage(new Error("SOME_OTHER_THING"))).toBe(DEFAULT_FALLBACK);
  });

  it("safeTaskErrorMessage falls back for unknown codes and nullish input", () => {
    expect(safeTaskErrorMessage(new Error("JOB_INTERRUPTED"))).toBe(TASK_FALLBACK);
    expect(safeTaskErrorMessage(undefined)).toBe(TASK_FALLBACK);
  });

  it("never leaks stack, trace_id, or credential fields", () => {
    const outputs = [
      safeErrorMessage(Object.assign(new Error("TIMELINE_CONFLICT"), { stack: "at App.tsx:1:1", trace_id: "trace-123", api_key: "SECRET_API_KEY" })),
      safeErrorMessage({ code: "PROVIDER_NOT_CONFIGURED", message: "http://user:supersecret@host.invalid", stack: "stack", trace_id: "trace-456" }),
      safeTaskErrorMessage(Object.assign(new Error("JOB_INTERRUPTED"), { stack: "at worker", trace_id: "trace-789", password: "p@ss" })),
    ];
    for (const output of outputs) {
      expect(SAFE_STRINGS.has(output)).toBe(true);
      expect(output).not.toContain("SECRET_API_KEY");
      expect(output).not.toContain("supersecret");
      expect(output).not.toContain("p@ss");
      expect(output).not.toContain("trace-");
      expect(output).not.toContain("at ");
    }
  });
});

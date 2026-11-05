import { describe, expect, it } from "vitest";
import { errorCode, safeErrorMessage, safeTaskErrorMessage } from "../src/app/safeErrors.js";

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
  "该 Provider 不支持所需的响应格式（可能静默忽略了结构化输出要求）。下一步：改用支持 JSON 结构化输出的 Provider 或模型后重试。",
  "确认已过期，请重新准备外传内容。",
  DEFAULT_FALLBACK,
  TASK_FALLBACK,
]);

describe("safeErrors", () => {
  it("renders a known code from a { code, message } object", () => {
    expect(safeErrorMessage({ code: "TIMELINE_CONFLICT", message: "conflict" })).toBe("时间线已发生变化，请刷新后重试。");
  });

  it("PROVIDER_CAPABILITY_UNSUPPORTED 指向换 Provider，而不是让用户去查凭据", () => {
    // 网关可静默忽略 response_format（实测 200 + 自由文本）。若这条退化为「检查凭据」，
    // 用户会朝错误方向排查——文案指错方向比没有文案更糟。
    const text = safeErrorMessage({ code: "PROVIDER_CAPABILITY_UNSUPPORTED", message: "x" });
    expect(text).toContain("不支持所需的响应格式");
    expect(text).toContain("Provider");
    expect(text).not.toContain("凭据");
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

  it("extracts code from Electron IPC-wrapped messages", () => {
    // ipcRenderer.invoke 抛错时 message 被包成
    // "Error invoking remote method 'x': Error: [CODE] msg"，不能只靠 ^ 锚定。
    const wrapped = new Error(
      "Error invoking remote method 'editing-grammar:prepare': Error: [EDITING_GRAMMAR_NO_SPEECH] 无有效语音信号"
    );
    expect(errorCode(wrapped)).toBe("EDITING_GRAMMAR_NO_SPEECH");
    expect(errorCode(new Error("[EDITING_GRAMMAR_NO_WORDS] 缺少词级时间戳"))).toBe("EDITING_GRAMMAR_NO_WORDS");
  });

  it("缺失素材相关的错误码不再落到兜底文案，且不误导用户去刷新", () => {
    // 2026-10 事故：删片段/删素材两条路都会抛这三个码，此前全部落到
    // 「操作未完成，请刷新后重试」——刷新根本解决不了，把用户指向无效动作。
    const sourceInvalid = safeErrorMessage({ code: "TIMELINE_SOURCE_INVALID", message: "x" });
    expect(sourceInvalid).not.toBe(DEFAULT_FALLBACK);
    expect(sourceInvalid).toContain("缺失");
    expect(sourceInvalid).not.toContain("刷新后重试");

    const inUse = safeErrorMessage({ code: "ASSET_IN_USE", message: "x" });
    expect(inUse).not.toBe(DEFAULT_FALLBACK);
    expect(inUse).toContain("引用");

    const missing = safeErrorMessage({ code: "ASSET_MISSING", message: "x" });
    expect(missing).not.toBe(DEFAULT_FALLBACK);
    expect(missing).toContain("缺失");
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

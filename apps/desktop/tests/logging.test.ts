import { describe, expect, it } from "vitest";
import { redact, sanitizeErrorDetail } from "../electron/main/logging.js";

describe("desktop log redaction", () => {
  it("redacts tokens, paths, complete URIs and transcript content", () => {
    const value = redact('Bearer secret AIVS_ADMIN_TOKEN=admin-secret path=C:\\Users\\demo\\clip.mp4 uri=file:///C:/Users/demo/clip.mp4 text="原始转录" segments=[{"text":"second"}]');
    expect(value).not.toContain("secret");
    expect(value).not.toContain("admin-secret");
    expect(value).not.toContain("C:\\Users\\demo");
    expect(value).not.toContain("file:///C:/Users/demo");
    expect(value).not.toContain("原始转录");
    expect(value).not.toContain("second");
  });

  it("redacts unlabelled Unix paths and transcript field variants", () => {
    const value = redact("failed /Users/demo/project/app.db raw_transcript='敏感正文' authorization: Bearer another-secret");
    expect(value).not.toContain("/Users/demo/project/app.db");
    expect(value).not.toContain("敏感正文");
    expect(value).not.toContain("another-secret");
  });

  it("redacts restricted-media tickets as URIs", () => {
    const value = redact("decode failed for restricted-media://media/Ab12cd34Ef56gh78Ij90kl45Mn--__ cannot demux");
    expect(value).not.toContain("Ab12cd34Ef56gh78Ij90kl45Mn--__");
    expect(value).toContain("[uri-redacted]");
  });
});

describe("sanitizeErrorDetail (runner failure.json)", () => {
  it("strips tickets/paths from message and keeps error name", () => {
    const detail = sanitizeErrorDetail(new Error("demux restricted-media://media/Ab12cd34Ef56gh78Ij90kl45Mn--__ at C:\\Users\\demo\\clip.mp4"));
    expect(detail.name).toBe("Error");
    expect(detail.message).not.toContain("Ab12cd34Ef56gh78Ij90kl45Mn--__");
    expect(detail.message).not.toContain("C:\\Users\\demo");
    expect(detail.message).not.toContain("clip.mp4");
  });

  it("truncates message/stack and falls back for non-Error", () => {
    expect(sanitizeErrorDetail(new Error("x".repeat(5000))).message).toHaveLength(600);
    const withStack = new Error("boom");
    withStack.stack = "Error: boom\n    at C:\\Users\\demo\\app\\out\\main.js:1:1";
    const detail = sanitizeErrorDetail(withStack);
    expect(detail.stack).toContain("[path-redacted]");
    expect(detail.stack).not.toContain("C:\\Users\\demo");
    expect(sanitizeErrorDetail("boom")).toEqual({ name: "unknown", message: "", stack: undefined });
  });
});

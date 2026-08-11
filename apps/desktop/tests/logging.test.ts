import { describe, expect, it } from "vitest";
import { redact } from "../electron/main/logging.js";

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
});

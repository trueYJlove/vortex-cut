import { describe, expect, it } from "vitest";
import { normalizeJob } from "../electron/main/ipc/job-normalize.js";

describe("normalizeJob", () => {
  it("normalizes legacy jobs without exposing paths", () => {
    const job = normalizeJob({
      job_id: "job_1",
      type: "proxy",
      status: "queued",
      stage: "queued",
      progress: 0,
      input: { media_id: "media_1", path: "C:\\private\\clip.mp4" },
    });
    expect(job.kind).toBe("proxy");
    expect(job.input).not.toHaveProperty("path");
  });
});

import { describe, expect, it } from "vitest";
import { isJobStatus, isSidecarReady, parseSidecarReadyLine } from "@aivideo/contracts";

describe("Stage 0 contract", () => {
  it("accepts exactly the AIVS_READY payload", () => {
    expect(parseSidecarReadyLine('AIVS_READY {"protocol_version":1,"port":43123,"pid":99,"build_version":"0.0.1"}')).toEqual({ protocol_version: 1, port: 43123, pid: 99, build_version: "0.0.1" });
    expect(isSidecarReady({ protocol_version: 2, port: 43123, pid: 99, build_version: "0.0.1" })).toBe(false);
  });
  it("keeps the task state vocabulary closed", () => {
    expect(isJobStatus("interrupted")).toBe(true);
    expect(isJobStatus("retry_wait")).toBe(false);
  });
});

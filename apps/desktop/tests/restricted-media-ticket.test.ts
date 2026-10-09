import { describe, expect, it } from "vitest";
import { RestrictedMediaRegistry, requireAssetTicket } from "../electron/main/restricted-media.js";

/**
 * P30（§2.5）：decode-frames 的票据鉴权复用 restricted-media 面——
 * 票据必须存在、未过期、purpose 匹配、且属于该实体。
 */
describe("P30 restricted-media 票据鉴权", () => {
  it("本实体的有效票据通过", () => {
    const registry = new RestrictedMediaRegistry();
    registry.register("asset_1", "C:\\media\\a.mp4");
    const ticket = registry.issue("asset_1", "asset");
    expect(() => requireAssetTicket(registry, ticket, "asset_1")).not.toThrow();
  });

  it("他实体的票据拒绝（横向越权）", () => {
    const registry = new RestrictedMediaRegistry();
    registry.register("asset_1", "C:\\media\\a.mp4");
    registry.register("asset_2", "C:\\media\\b.mp4");
    const ticket = registry.issue("asset_1", "asset");
    expect(() => requireAssetTicket(registry, ticket, "asset_2")).toThrow("DECODE_TICKET_INVALID");
  });

  it("过期票据拒绝", () => {
    let nowMs = 1_000;
    const registry = new RestrictedMediaRegistry(60_000, () => nowMs);
    registry.register("asset_1", "C:\\media\\a.mp4");
    const ticket = registry.issue("asset_1", "asset");
    nowMs += 60_001;
    expect(() => requireAssetTicket(registry, ticket, "asset_1")).toThrow("DECODE_TICKET_INVALID");
  });

  it("purpose 不符拒绝（artifact 票据不解码 asset）", () => {
    const registry = new RestrictedMediaRegistry();
    registry.register("artifact_1", "C:\\media\\out.mp4", "artifact");
    const ticket = registry.issue("artifact_1", "artifact");
    expect(() => requireAssetTicket(registry, ticket, "artifact_1", "asset")).toThrow("DECODE_TICKET_INVALID");
  });

  it("缺失/非字符串/伪造票据一律拒绝", () => {
    const registry = new RestrictedMediaRegistry();
    registry.register("asset_1", "C:\\media\\a.mp4");
    for (const bogus of [undefined, null, 42, "", "aivideo://media/../../etc", "file:///etc/passwd"]) {
      expect(() => requireAssetTicket(registry, bogus, "asset_1")).toThrow("DECODE_TICKET_INVALID");
    }
  });
});

import { describe, expect, it } from "vitest";
import { syntheticFallbackNotice } from "../src/app/preview/fallback-notice.js";

describe("syntheticFallbackNotice", () => {
  it("TOO_LARGE 映射为长度上限人话 + 恢复指引（不再裸抛英文错误码）", () => {
    const notice = syntheticFallbackNotice(
      "Error invoking remote method 'preview-ir-v2:manifest': Error: PREVIEW_IR_TOO_LARGE",
      "PREVIEW_IR_TOO_LARGE",
    );
    expect(notice).toContain("长度上限");
    expect(notice).toContain("已回退交互预览");
    expect(notice).not.toContain("PREVIEW_IR_TOO_LARGE");
    expect(notice).not.toContain("remote method");
  });

  it("UNSUPPORTED 映射为内容子集提示（不列出已支持效果）", () => {
    const notice = syntheticFallbackNotice("段 clip_x: mask（蒙版）超出实时合成子集", "PREVIEW_IR_UNSUPPORTED");
    expect(notice).toContain("实时合成暂不支持的内容");
    expect(notice).not.toContain("图片素材");
    expect(notice).toContain("已回退交互预览");
  });

  it("未知原因保留原始细节（诊断价值 + App no-ticket 自动恢复按子串匹配依赖）", () => {
    const reason = "no ticket for asset_8869eeb";
    expect(syntheticFallbackNotice(reason, null)).toContain(reason);
    expect(syntheticFallbackNotice("WebGL2 unavailable", null)).toContain("WebGL2 unavailable");
  });

  it("BMFF_CODEC_UNSUPPORTED 映射为编码不支持人话（去「仅 AVC」）", () => {
    const notice = syntheticFallbackNotice(
      "BMFF_CODEC_UNSUPPORTED: 采样入口 hev1 编码不受支持",
      "BMFF_CODEC_UNSUPPORTED",
    );
    expect(notice).toContain("该视频编码暂不支持实时合成预览");
    expect(notice).not.toContain("仅 AVC");
    expect(notice).not.toContain("BMFF_CODEC_UNSUPPORTED");
  });
});

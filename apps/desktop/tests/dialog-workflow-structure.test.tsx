import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 工作流 / AI 对话框统一到共享 Dialog 骨架的结构回归（设计稿 §4、§8）。
 *
 * 视觉统一的前提是骨架统一：标题区 / 内容区 / 固定底栏由 Dialog 提供，
 * 各面板不再手写 .modal-heading、.modal-header 或直系 .modal-actions 底栏。
 * 本文件对源码做结构扫描——用真实渲染去断言每个面板需要为 14 个面板各造一套
 * IPC 假件，而回归点在结构而非行为；行为由各自的面板用例覆盖。
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/app");

/** 边界内所有工作流 / AI 对话框面板。 */
const PANELS = [
  "angle-sync/AngleSyncPanel.tsx",
  "agent-session/AgentSessionPanel.tsx",
  "captions-provider/CaptionsProviderPanel.tsx",
  "editing-grammar/EditingGrammarPanel.tsx",
  "editing-grammar/EditingToolsPanel.tsx",
  "keyframe-review/KeyframeReviewPanel.tsx",
  "media-generation/MediaGenerationWorkbench.tsx",
  "provider-image-generation/ProviderImageGenerationWorkbench.tsx",
  "semantic-search/SemanticSearchPanel.tsx",
  "worklist/WorklistPanel.tsx",
  "shot-requirements/ShotRequirementWorkbench.tsx",
  "shot-requirements/ShotRequirementTimelineAssemblyPanel.tsx",
  "shot-requirements/ShotRequirementImageFulfillmentPanel.tsx",
  "shot-requirements/ShotRequirementTimelineBatchAssemblyPanel.tsx",
];

function source(panel: string): string {
  return readFileSync(resolve(appDir, panel), "utf8");
}

/** 取出每个 <Dialog ...> 开标签的属性区（花括号内与字符串内的 > 不算结束）。 */
function dialogPropBlocks(text: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("<Dialog", from);
    if (start === -1) break;
    let depth = 0;
    let quote: string | null = null;
    let index = start + "<Dialog".length;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "{") { depth += 1; continue; }
      if (char === "}") { depth -= 1; continue; }
      if (char === ">" && depth === 0) break;
    }
    blocks.push(text.slice(start, index + 1));
    from = index + 1;
  }
  return blocks;
}

/** 该面板里 Dialog 是否都拿到了 title（缺 title 就退回旧结构，标题区不会渲染）。 */
function dialogCount(panel: string): number {
  return dialogPropBlocks(source(panel)).length;
}

describe("工作流对话框：共享骨架取代手写头/尾", () => {
  it.each(PANELS)("%s 的每个 Dialog 都提供 title", (panel) => {
    const blocks = dialogPropBlocks(source(panel));
    expect(blocks.length, `${panel} 没有 Dialog`).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block, `${panel} 存在缺 title 的 Dialog：${block.slice(0, 80)}`).toMatch(/\btitle="/);
    }
  });

  it.each(PANELS)("%s 不再手写 modal-heading / modal-header", (panel) => {
    const text = source(panel);
    expect(text, panel).not.toContain("modal-heading");
    expect(text, panel).not.toContain("modal-header");
  });

  it("标题与副标题逐字取自原 modal-heading（无改写）", () => {
    const expectations: Array<[string, string[]]> = [
      ["angle-sync/AngleSyncPanel.tsx", ["机位同步", "本地音频互相关对齐（零外传）：算出每个机位相对参考机位的时间偏移，供多机位剪辑复用。"]],
      ["agent-session/AgentSessionPanel.tsx", ["AI 助手", "多步任务会话：每一步都会先校验再落为版本，失败步骤不产生任何修改。"]],
      ["captions-provider/CaptionsProviderPanel.tsx", ["AI 字幕优化", "把选中的转录文本改写成更短的字幕；时间码与字幕归属由本地决定，Provider 只能改文字。"]],
      ["editing-grammar/EditingGrammarPanel.tsx", ["剪辑语法", "本地确定性规划：零外传。提案不会自动修改正式 Timeline，采纳后才落新 Revision。"]],
      ["editing-grammar/EditingToolsPanel.tsx", ["剪辑手法", "{meta.desc}"]],
      ["keyframe-review/KeyframeReviewPanel.tsx", ["关键帧外传审阅"]],
      ["media-generation/MediaGenerationWorkbench.tsx", ["生成验证（模拟）", "验证生成请求、任务状态和恢复链路，不执行真实生成。"]],
      ["provider-image-generation/ProviderImageGenerationWorkbench.tsx", ["真实图片生成（受控）", "纯文本生成单张 PNG；成功后仅注册为项目受管图片素材，不写入 Timeline。"]],
      ["semantic-search/SemanticSearchPanel.tsx", ["素材语义检索"]],
      ["worklist/WorklistPanel.tsx", ["AI 工作单", "当前切片只启用本地剪辑语法步骤；每一步需显式应用。"]],
      ["shot-requirements/ShotRequirementWorkbench.tsx", ["镜头与资产需求清单"]],
    ];
    for (const [panel, fragments] of expectations) {
      const block = dialogPropBlocks(source(panel))[0];
      for (const fragment of fragments) expect(block, panel).toContain(fragment);
    }
  });

  it("四个紧凑确认弹窗用标签文案作标题，关闭钮由组件提供", () => {
    const cases: Array<[string, string]> = [
      ["shot-requirements/ShotRequirementTimelineAssemblyPanel.tsx", "确认时间线装配"],
      ["shot-requirements/ShotRequirementTimelineBatchAssemblyPanel.tsx", "确认批量时间线装配"],
      ["shot-requirements/ShotRequirementImageFulfillmentPanel.tsx", "确认重试图片生成"],
      ["shot-requirements/ShotRequirementImageFulfillmentPanel.tsx", "确认采用图片结果"],
    ];
    for (const [panel, title] of cases) {
      const blocks = dialogPropBlocks(source(panel));
      const match = blocks.filter(block => block.includes(`title="${title}"`));
      expect(match.length, `${panel} 缺少标题「${title}」`).toBe(1);
      // 紧凑确认没有可见副标题，也不该自己塞关闭按钮。
      expect(match[0]).not.toContain("subtitle=");
      expect(match[0]).not.toContain("icon-btn");
    }
  });

  it("保留既有关闭钮可访问名称", () => {
    const cases: Array<[string, string]> = [
      ["angle-sync/AngleSyncPanel.tsx", "关闭机位同步"],
      ["agent-session/AgentSessionPanel.tsx", "关闭 AI 助手"],
      ["captions-provider/CaptionsProviderPanel.tsx", "关闭 AI 字幕优化"],
      ["editing-grammar/EditingGrammarPanel.tsx", "关闭剪辑语法"],
      ["editing-grammar/EditingToolsPanel.tsx", "关闭剪辑手法"],
      ["keyframe-review/KeyframeReviewPanel.tsx", "关闭关键帧外传审阅"],
      ["media-generation/MediaGenerationWorkbench.tsx", "关闭生成验证"],
      ["provider-image-generation/ProviderImageGenerationWorkbench.tsx", "关闭真实图片生成"],
      ["semantic-search/SemanticSearchPanel.tsx", "关闭素材语义检索"],
      ["worklist/WorklistPanel.tsx", "关闭 AI 工作单"],
      ["shot-requirements/ShotRequirementWorkbench.tsx", "关闭镜头需求工作台"],
    ];
    for (const [panel, label] of cases) {
      const block = dialogPropBlocks(source(panel))[0];
      expect(block, `${panel} 丢失关闭名称「${label}」`).toContain(`closeLabel="${label}"`);
    }
  });

  it("根级操作行搬进 footer，仅剩的操作行都是内容区内的局部操作", () => {
    // 剩下的 .modal-actions 是内容区内的局部操作行（不属于对话框底栏），
    // 位置约束见设计稿 §4.2：局部操作跟随所属字段，不模拟第二个底栏。
    const localRegions: Record<string, string[]> = {
      "angle-sync/AngleSyncPanel.tsx": ["angle-sync-create"],
      "provider-image-generation/ProviderImageGenerationWorkbench.tsx": ["OS 加密凭据"],
      "shot-requirements/ShotRequirementImageFulfillmentPanel.tsx": ["shot-fulfillment-confirmation"],
    };
    for (const panel of PANELS) {
      const text = source(panel);
      const occurrences = text.split("modal-actions").length - 1;
      if (occurrences === 0) continue;
      const allowed = localRegions[panel];
      expect(allowed, `${panel} 出现了未登记的 .modal-actions`).toBeDefined();
      expect(occurrences, `${panel} 的局部操作行数量`).toBe(allowed.length);
      for (const marker of allowed) expect(text, panel).toContain(marker);
    }
    expect(Object.keys(localRegions).every(panel => PANELS.includes(panel))).toBe(true);
  });

  it("每个面板都通过 footer 交付底栏（无底栏的面板除外）", () => {
    const withFooter = PANELS.filter(panel => dialogPropBlocks(source(panel)).some(block => block.includes("footer=")));
    // 只读 / 分支里的确认弹窗可以不带底栏，其余面板必须交出 footer。
    expect(withFooter.length).toBe(PANELS.length);
  });
});

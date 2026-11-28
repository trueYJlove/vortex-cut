import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = resolve(HELPERS_DIR, "../..");
export const STYLES_ENTRY_PATH = resolve(DESKTOP_ROOT, "src/styles.css");

const LOCAL_IMPORT_RE = /^[ \t]*@import\s+["'](\.[^"']+)["']\s*;\s*$/;

function isModularStyleImport(specifier: string, currentFile: string): boolean {
  if (specifier.startsWith("./styles/") || specifier.startsWith("../styles/")) return true;
  return currentFile.replace(/\\/g, "/").includes("/src/styles/");
}

function expandStylesFile(filePath: string, seen = new Set<string>()): string {
  const absolutePath = resolve(filePath);
  if (seen.has(absolutePath)) {
    throw new Error(`Circular CSS @import detected: ${absolutePath}`);
  }
  seen.add(absolutePath);
  const content = readFileSync(absolutePath, "utf8");
  const baseDir = dirname(absolutePath);
  return content
    .split(/\r?\n/)
    .map(line => {
      const match = LOCAL_IMPORT_RE.exec(line);
      if (!match || !isModularStyleImport(match[1], absolutePath)) return line;
      return expandStylesFile(resolve(baseDir, match[1]), seen);
    })
    .join("\n");
}

/**
 * Read the complete desktop stylesheet text in exact cascade order.
 * Supports both monolithic `src/styles.css` and `@import "./styles/..."` entrypoints.
 */
export function readDesktopStyles(): string {
  return expandStylesFile(STYLES_ENTRY_PATH);
}

export type CssRule = {
  selector: string;
  selectors: string[];
  body: string;
  order: number;
  inMedia: boolean;
  atRule: string | null;
};

/** Parse expanded CSS into top-level and at-rule-scoped rules, stripping comments first. */
export function parseCssRules(source: string): CssRule[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const stack: string[] = [];
  let buffer = "";
  let order = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === "{") {
      const prelude = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        continue;
      }
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < clean.length && depth > 0) {
        if (clean[j] === "{") depth += 1;
        else if (clean[j] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += clean[j];
        j += 1;
      }
      order += 1;
      out.push({
        selector: prelude,
        selectors: prelude.split(",").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean),
        body,
        order,
        inMedia: stack.some(item => item.startsWith("@media")),
        atRule: stack.find(item => item.startsWith("@media")) ?? null,
      });
      i = j;
      continue;
    }
    if (ch === ";" && stack.length === 0) {
      buffer = "";
      continue;
    }
    if (ch === "}") {
      stack.pop();
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  return out;
}

/** Extract flat selector/body blocks skipping at-rule preludes. */
export function extractCssBlocks(source: string): Array<{ selector: string; body: string }> {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    const selector = match[1].trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

/** Compute CSS selector specificity [id, class/attr/pseudo-class, type], unwrapping :not(...). */
export function cssSpecificity(selector: string): [number, number, number] {
  let expanded = selector;
  let previous = "";
  while (previous !== expanded) {
    previous = expanded;
    expanded = expanded.replace(/:not\(([^)]*)\)/g, " $1 ");
  }
  return [
    (expanded.match(/#[\w-]+/g) ?? []).length,
    (expanded.match(/\.[\w-]+/g) ?? []).length
      + (expanded.match(/\[[^\]]+\]/g) ?? []).length
      + (expanded.match(/:(?!not\()[\w-]+/g) ?? []).length,
    (expanded.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
}

export function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

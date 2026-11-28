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

export function expandStylesFile(filePath: string, visiting = new Set<string>()): string {
  const absolutePath = resolve(filePath);
  if (visiting.has(absolutePath)) {
    throw new Error(`Circular CSS @import detected: ${absolutePath}`);
  }
  visiting.add(absolutePath);
  try {
    const content = readFileSync(absolutePath, "utf8");
    const baseDir = dirname(absolutePath);
    return content
      .split(/\r?\n/)
      .map(line => {
        const match = LOCAL_IMPORT_RE.exec(line);
        if (!match || !isModularStyleImport(match[1], absolutePath)) return line;
        return expandStylesFile(resolve(baseDir, match[1]), visiting);
      })
      .join("\n");
  } finally {
    visiting.delete(absolutePath);
  }
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

/** Parse expanded CSS into top-level and at-rule-scoped rules, stripping comments and keyframes. */
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
        if (/^@(?:-webkit-)?keyframes\b/i.test(prelude)) {
          let depth = 1;
          let j = i + 1;
          while (j < clean.length && depth > 0) {
            if (clean[j] === "{") depth += 1;
            else if (clean[j] === "}") depth -= 1;
            j += 1;
          }
          i = j - 1;
          continue;
        }
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

/** Extract flat selector/body blocks skipping at-rule preludes and keyframe stops. */
export function extractCssBlocks(source: string): Array<{ selector: string; body: string }> {
  return parseCssRules(source).map(rule => ({ selector: rule.selector, body: rule.body }));
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(selectorList: string): string[] {
  const parts: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selectorList.length; i += 1) {
    const ch = selectorList[i];
    if (quote) {
      if (ch === "\\" && i + 1 < selectorList.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
      const part = selectorList.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = selectorList.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Compute CSS Selectors Level 4 specificity `[id, class/attr/pseudo-class, type/pseudo-element]`.
 * - `:where(...)` contributes `[0, 0, 0]`.
 * - `:not(...)`, `:is(...)`, `:has(...)` take the highest specificity among their arguments.
 * - Double-colon pseudo-elements (`::before`, `::after`, `::placeholder`, etc.) count in column 3.
 * - Attribute selectors `[...]` are extracted before ID/class/pseudo tokens to avoid double-counting.
 */
export function cssSpecificity(selector: string): [number, number, number] {
  let ids = 0;
  let classes = 0;
  let types = 0;

  let rest = "";
  let i = 0;
  let quote: string | null = null;
  let inAttr = false;

  while (i < selector.length) {
    const ch = selector[i];
    if (quote) {
      if (ch === "\\" && i + 1 < selector.length) {
        rest += ch + selector[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      rest += ch;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      rest += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      inAttr = true;
      rest += ch;
      i += 1;
      continue;
    }
    if (ch === "]" && inAttr) {
      inAttr = false;
      rest += ch;
      i += 1;
      continue;
    }
    if (!inAttr && ch === ":" && selector[i - 1] !== ":") {
      const match = /^:([a-z-]+)\(/i.exec(selector.slice(i));
      if (match) {
        const fn = match[1].toLowerCase();
        const openIdx = i + match[0].length - 1;
        const closeIdx = findMatchingParen(selector, openIdx);
        if (closeIdx !== -1) {
          const inner = selector.slice(openIdx + 1, closeIdx);
          if (fn === "where") {
            rest += " ";
            i = closeIdx + 1;
            continue;
          }
          if (fn === "not" || fn === "is" || fn === "has") {
            let best: [number, number, number] = [0, 0, 0];
            for (const branch of splitTopLevelCommas(inner)) {
              const branchSpec = cssSpecificity(branch);
              if (compareSpecificity(branchSpec, best) > 0) best = branchSpec;
            }
            ids += best[0];
            classes += best[1];
            types += best[2];
            rest += " ";
            i = closeIdx + 1;
            continue;
          }
          if (
            fn === "nth-child" || fn === "nth-last-child"
            || fn === "nth-of-type" || fn === "nth-last-of-type"
            || fn === "lang" || fn === "dir"
          ) {
            classes += 1;
            if ((fn === "nth-child" || fn === "nth-last-child") && /\bof\b/i.test(inner)) {
              const ofMatch = /\bof\s+([\s\S]+)$/i.exec(inner);
              if (ofMatch) {
                let best: [number, number, number] = [0, 0, 0];
                for (const branch of splitTopLevelCommas(ofMatch[1])) {
                  const branchSpec = cssSpecificity(branch);
                  if (compareSpecificity(branchSpec, best) > 0) best = branchSpec;
                }
                ids += best[0];
                classes += best[1];
                types += best[2];
              }
            }
            rest += " ";
            i = closeIdx + 1;
            continue;
          }
        }
      }
    }
    rest += ch;
    i += 1;
  }

  rest = rest.replace(/\[(?:"[^"]*"|'[^']*'|[^\]])*\]/g, () => {
    classes += 1;
    return " ";
  });

  rest = rest.replace(/::[\w-]+/g, () => {
    types += 1;
    return " ";
  });

  rest = rest.replace(/#[\w-]+/g, () => {
    ids += 1;
    return " ";
  });

  rest = rest.replace(/\.[\w-]+/g, () => {
    classes += 1;
    return " ";
  });

  rest = rest.replace(/:[\w-]+/g, () => {
    classes += 1;
    return " ";
  });

  types += (rest.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;

  return [ids, classes, types];
}

export function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

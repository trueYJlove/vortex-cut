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

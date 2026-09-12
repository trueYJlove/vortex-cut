#!/usr/bin/env node
/**
 * M3-0 探针四层隔离 · 第 4 层校验（冻结方案 §7.1）：
 * `pnpm build` 后于 out/renderer（与 out/preload）内 grep 探针标记字符串应零命中。
 * out/main 允许包含 AIVS_M3_PROBE 字符串（第 1 层主进程钩子为冻结方案明文设计，
 * 运行时双重门控），但 m3p1/m3p2/m3p3 探针名仍应零命中。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const outDir = join(desktopRoot, "out");

// out/renderer：全净（冻结方案 §7.1 原文要求——生产构建不打包探针代码）。
// out/preload / out/main：探针名禁止；env 变量串与桥标记属第 1/1.5 层
// dev-only 门控壳（运行时双门控），允许存在并写入报告说明。
const MARKERS_RENDERER = ["m3p1", "m3p2", "m3p3", "m3p4", "probeDesktop", "AIVS_M3_PROBE"];
const MARKERS_INFRA = ["m3p1", "m3p2", "m3p3", "m3p4"];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

let failures = 0;
for (const sub of ["renderer", "preload"]) {
  const target = join(outDir, sub);
  let files;
  try {
    statSync(target);
    files = walk(target);
  } catch {
    console.error(`[probe-isolation] FAIL: ${target} missing — run "pnpm build" first`);
    failures += 1;
    continue;
  }
  const markers = sub === "renderer" ? MARKERS_RENDERER : MARKERS_INFRA;
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const marker of markers) {
      if (text.includes(marker)) hits.push(`${file} :: ${marker}`);
    }
  }
  if (hits.length > 0) {
    failures += 1;
    console.error(`[probe-isolation] FAIL out/${sub} contains probe markers:`);
    for (const hit of hits) console.error(`  - ${hit}`);
  } else {
    console.log(`[probe-isolation] ok: out/${sub} clean (${files.length} files scanned)`);
  }
}

const mainFiles = walk(join(outDir, "main"));
const mainProbeNames = [];
for (const file of mainFiles) {
  const text = readFileSync(file, "utf8");
  for (const marker of ["m3p1", "m3p2", "m3p3"]) {
    if (text.includes(marker)) mainProbeNames.push(`${file} :: ${marker}`);
  }
}
if (mainProbeNames.length > 0) {
  failures += 1;
  console.error(`[probe-isolation] FAIL out/main contains probe names (env string is allowed, names are not):`);
  for (const hit of mainProbeNames) console.error(`  - ${hit}`);
} else {
  console.log(`[probe-isolation] ok: out/main has no probe names (${mainFiles.length} files scanned)`);
}

if (failures > 0) process.exit(1);
console.log("[probe-isolation] PASS: probe code is absent from production bundles");

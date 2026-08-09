import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const packageJson = require("electron-builder/package.json");
const builderRoot = dirname(require.resolve("electron-builder/package.json"));
const electronGet = require.resolve("@electron/get", { paths: [builderRoot] });
const indexFile = electronGet;
const source = readFileSync(indexFile, "utf8");
const marker = "exports.ElectronDownloadCacheMode";
if (!source.includes(marker)) {
  writeFileSync(indexFile, source + "\nexports.ElectronDownloadCacheMode = { ReadOnly: 0, ReadWrite: 1, WriteOnly: 2 };\n");
}
if (!existsSync(indexFile)) throw new Error("electron-builder dependency is incomplete (" + packageJson.version + ")");
console.log(`electron-builder dependency ready: electron-builder ${packageJson.version}, @electron/get ${indexFile}`);

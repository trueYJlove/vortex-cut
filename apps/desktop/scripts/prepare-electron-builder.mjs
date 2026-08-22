import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("electron-builder/package.json");
const builderRoot = import.meta.dirname;
const electronGet = require.resolve("@electron/get", { paths: [builderRoot] });
readFileSync(electronGet, "utf8");
if (!existsSync(electronGet)) throw new Error("electron-builder dependency is incomplete (" + packageJson.version + ")");
const electronGetExports = require(electronGet);
if (!electronGetExports.ElectronDownloadCacheMode) {
  throw new Error("@electron/get ElectronDownloadCacheMode export is missing; expected @electron/get 3.1.0");
}
console.log(`electron-builder dependency ready: electron-builder ${packageJson.version}, @electron/get ${electronGet}`);
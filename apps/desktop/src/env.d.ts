import type { DesktopApi } from "../electron/preload/index.js";

declare global {
  interface Window { desktop: DesktopApi }

  /* CSS Modules（2026-11-16）：随 OpenFilm 原语移植进来一个 .module.css
     （InspectorWorkspace.module.css）。Vite 原生支持 CSS Modules，缺的只是
     TS 侧的类型声明——没有它 tsc 报「找不到模块」。
     必须是 global 内的 module 声明：本文件已是模块（有 import/export），
     顶层的 declare module 只做增强而不做新声明，通配模块因此不生效（实测踩中）。 */
  module "*.module.css" {
    const classes: Record<string, string>;
    export default classes;
  }
}
export {};

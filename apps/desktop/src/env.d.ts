import type { DesktopApi } from "../electron/preload/index.js";

declare global { interface Window { desktop: DesktopApi } }
export {};

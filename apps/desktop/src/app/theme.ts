/**
 * 主题系统（2026-11-10，参照 OpenFilm 的 settings/theme.ts）。
 *
 * 三态：light / dark / system；system 实时跟随系统外观变化，不只在启动时判定。
 * 选择存 localStorage；通过 <html data-theme> 生效——CSS 里用
 * [data-theme="light"] 覆盖令牌即可整体换肤。
 *
 * **首帧无闪白**：index.html 里有一段同逻辑的内联脚本，在样式表求值前
 * 就把 data-theme 写好。本模块是运行期的权威实现，两者必须保持一致
 * （键名、回退规则、system 判定），改一处要同步另一处。
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

/** localStorage 键：与 index.html 的内联脚本共用。 */
export const THEME_STORAGE_KEY = "vortexcut.theme";

const media = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function savedMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "system") return value;
  } catch {
    /* 隐私模式/存储被禁：按默认深色，不抛 */
  }
  return "dark";
}

/** 实际生效的外观（把 system 解析成 light/dark）。 */
export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return media()?.matches ? "dark" : "light";
}

function apply(mode: ThemeMode): void {
  const resolved = resolvedTheme(mode);
  // documentElement 上不写 dataset.theme 的旧值残留：直接赋值即覆盖
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  // 让浏览器原生控件（滚动条、表单）跟随
  document.documentElement.style.colorScheme = resolved;
}

const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/* system 态：系统外观变化时实时重解析（OpenFilm 同款行为）。 */
if (typeof window !== "undefined") {
  const mq = media();
  mq?.addEventListener?.("change", () => {
    if (savedMode() === "system") { apply("system"); emit(); }
  });
  // 兄弟窗口改了主题：本窗口跟随（studio 多窗口场景）
  window.addEventListener("storage", event => {
    if (event.key !== THEME_STORAGE_KEY) return;
    apply(savedMode());
    emit();
  });
}

export function setThemeMode(mode: ThemeMode): void {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* 不持久化也要当次生效 */ }
  apply(mode);
  emit();
}

/** 当前选择的模式 + 切换函数；所有使用方共享同一状态。 */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(
    on => { listeners.add(on); return () => { listeners.delete(on); }; },
    savedMode,
    () => "dark" as ThemeMode,
  );
  return [mode, setThemeMode];
}

/** 当前实际生效的外观（system 已解析）。 */
export function useResolvedTheme(): "light" | "dark" {
  const [mode] = useThemeMode();
  return resolvedTheme(mode);
}

/** 启动时调用一次：把已保存的选择写进 DOM（内联脚本已抢先做过，这里是幂等兜底）。 */
export function initTheme(): void {
  apply(savedMode());
}

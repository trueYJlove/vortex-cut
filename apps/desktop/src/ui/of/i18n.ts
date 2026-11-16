/**
 * i18n 适配层（2026-11-16，配合 OpenFilm 原语移植）。
 *
 * 移植过来的 `inspector-fields` / `ColorPicker` / `MenuSelect` / `InspectorWorkspace`
 * 调用 `useT()(path)` 取文案。参照的实现是一张 2900 行的翻译表（i18n/{en,zh-CN}.ts），
 * 那套表绑定它自己的整套 UI 文案，我们只用到其中 8 个 key——
 * 拖 2900 行进仓库属于用不上的重量，故这里只补这 8 个。
 *
 * 行为契约与参照一致：`useT()` 返回 `(path) => string`，取不到时**回退到 path 本身**
 * （参照 i18n/index.ts 同款），因此漏配一个 key 不会渲染成空白，而是显示 key 名，
 * 便于肉眼发现。
 */

const MESSAGES: Record<string, string> = {
  // 数值框
  "inspector.mixed": "混合",
  "inspector.auto": "自动",
  // 颜色选择器
  "colorPicker.close": "关闭",
  "colorPicker.eyedropper": "取色",
  "colorPicker.hex": "十六进制",
  "colorPicker.recent": "最近使用",
  // 属性面板
  "inspector.trackLocked": "此轨道已锁定，编辑已禁用。",
  "inspector.workspace.categories": "属性分类",
};

/** 取文案；未配的 key 回退为 path 本身（与参照一致，不会渲染成空）。 */
export function t(path: string): string {
  return MESSAGES[path] ?? path;
}

/** 参照的 hook 形态：让移植来的组件无需改动调用方式。 */
export function useT(): (path: string) => string {
  return t;
}

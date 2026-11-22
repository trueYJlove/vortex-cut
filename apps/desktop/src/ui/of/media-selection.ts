// Adapted from OpenFilm (MIT), studio/ui/src/lib/media-selection.ts.
export function pickMedia<T extends string>(
  picked: readonly T[],
  key: T,
  order: readonly T[],
  anchor: T | null,
  { toggle, range }: { toggle: boolean; range: boolean }
): T[] {
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(key);
  if (range && from >= 0 && to >= 0) {
    const run = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return toggle ? [...new Set([...picked, ...run])] : run;
  }
  if (toggle) return picked.includes(key) ? picked.filter(item => item !== key) : [...picked, key];
  return [key];
}

/** Clamp `value` inclusively between `min` and `max`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp `value` inclusively between 0 and 1. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

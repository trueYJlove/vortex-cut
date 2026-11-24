/** Browser media rates supported by OpenFilm's preview contract. */
export const MEDIA_RATE_MIN = 1 / 16;
export const MEDIA_RATE_MAX = 16;

export function mediaRateIsPlayable(rate: number): boolean {
  return Number.isFinite(rate) && rate >= MEDIA_RATE_MIN - 1e-9 && rate <= MEDIA_RATE_MAX + 1e-9;
}

export function clampMediaRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MEDIA_RATE_MAX, Math.max(MEDIA_RATE_MIN, rate));
}

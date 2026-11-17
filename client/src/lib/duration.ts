/**
 * Access-window labels for timed paid content — the number of minutes the
 * creator sold, rendered the way buyers and wallets talk about it.
 *
 * `null`/`undefined` only appears on rows created before timed access existed;
 * those were permanent purchases and keep that shape.
 */
export function accessLabel(minutes: number | null | undefined): string {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 'Permanent access';
  if (m < 60) return `${Math.round(m)}-minute access`;
  const hours = m / 60;
  if (m % 60 === 0) {
    const h = Math.round(hours);
    return h === 24 ? '24-hour access' : `${h}-hour access`;
  }
  return `${Math.round(hours * 10) / 10}-hour access`;
}

/**
 * Country centroids + great-circle distance, and the set of codes that make up
 * the Europe board.
 *
 * Purpose-built for one thing: putting a straight line between two flags on the
 * shareable post-call card ("🇵🇱 Poland ↔ 🇵🇹 Portugal, 1,900 km apart") and
 * grouping the live presence counts by continent. Approximate centroids (the
 * country's centre, not its capital) are plenty for a card that says "≈".
 *
 * Countries missing from the table simply produce `null` — the card then omits
 * the distance instead of guessing. Matching is NEVER filtered by any of this:
 * anyone can be matched with anyone.
 */

/** [latitude, longitude] of each country's centre. */
const CENTROIDS: Record<string, [number, number]> = {
  // ── Europe ────────────────────────────────────────────────────────────────
  AL: [41.15, 20.17],
  AD: [42.51, 1.52],
  AT: [47.52, 14.55],
  BY: [53.71, 27.95],
  BE: [50.5, 4.47],
  BA: [43.92, 17.68],
  BG: [42.73, 25.49],
  HR: [45.1, 15.2],
  CY: [35.13, 33.43],
  CZ: [49.82, 15.47],
  DK: [56.26, 9.5],
  EE: [58.6, 25.01],
  FI: [61.92, 25.75],
  FR: [46.23, 2.21],
  DE: [51.17, 10.45],
  GR: [39.07, 21.82],
  HU: [47.16, 19.5],
  IS: [64.96, -19.02],
  IE: [53.14, -7.69],
  IT: [41.87, 12.57],
  LV: [56.88, 24.6],
  LI: [47.17, 9.56],
  LT: [55.17, 23.88],
  LU: [49.82, 6.13],
  MT: [35.94, 14.38],
  MD: [47.41, 28.37],
  MC: [43.74, 7.42],
  ME: [42.71, 19.37],
  NL: [52.13, 5.29],
  MK: [41.61, 21.75],
  NO: [60.47, 8.47],
  PL: [51.92, 19.15],
  PT: [39.4, -8.22],
  RO: [45.94, 24.97],
  RU: [55.75, 37.62], // European part — what a "Europe" row means for Russia.
  SM: [43.94, 12.46],
  RS: [44.02, 21.01],
  SK: [48.67, 19.7],
  SI: [46.15, 14.99],
  ES: [40.46, -3.75],
  SE: [60.13, 18.64],
  CH: [46.82, 8.23],
  TR: [39.93, 32.86],
  UA: [48.38, 31.17],
  GB: [55.38, -3.44],
  VA: [41.9, 12.45],
  XK: [42.6, 20.9],
  // ── Everywhere else the app already ships (so cross-continent matches get a
  //    distance too) ────────────────────────────────────────────────────────
  US: [39.83, -98.58],
  CA: [56.13, -106.35],
  MX: [23.63, -102.55],
  BR: [-14.24, -51.93],
  AR: [-38.42, -63.62],
  CL: [-35.68, -71.54],
  CO: [4.57, -74.3],
  PE: [-9.19, -75.02],
  NG: [9.08, 8.68],
  GH: [7.95, -1.02],
  KE: [-0.02, 37.91],
  UG: [1.37, 32.29],
  TZ: [-6.37, 34.89],
  ZA: [-30.56, 22.94],
  EG: [26.82, 30.8],
  MA: [31.79, -7.09],
  DZ: [28.03, 1.66],
  SA: [23.89, 45.08],
  AE: [23.42, 53.85],
  IL: [31.05, 34.85],
  IR: [32.43, 53.69],
  IQ: [33.22, 43.68],
  IN: [20.59, 78.96],
  PK: [30.38, 69.35],
  BD: [23.68, 90.36],
  KZ: [48.02, 66.92],
  CN: [35.86, 104.2],
  JP: [36.2, 138.25],
  KR: [35.91, 127.77],
  TW: [23.7, 120.96],
  SG: [1.35, 103.82],
  MY: [4.21, 101.98],
  TH: [15.87, 100.99],
  ID: [-0.79, 113.92],
  PH: [12.88, 121.77],
  VN: [14.06, 108.28],
  GE: [42.32, 43.36],
  AM: [40.07, 45.04],
  AZ: [40.14, 47.59],
  AU: [-25.27, 133.78],
  NZ: [-40.9, 174.89],
};

/**
 * Codes shown on the Europe board. Transcontinental entries (RU, TR, GE, AM,
 * AZ) are included on purpose: they play in Europe's competitions and their
 * users are exactly the audience the board speaks to.
 */
export const EUROPE_CODES = new Set([
  'AL', 'AD', 'AT', 'AM', 'AZ', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ',
  'DK', 'EE', 'FI', 'FR', 'GE', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'XK',
  'LV', 'LI', 'LT', 'LU', 'MT', 'MD', 'MC', 'ME', 'NL', 'MK', 'NO', 'PL',
  'PT', 'RO', 'RU', 'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH', 'TR', 'UA',
  'GB', 'VA',
]);

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle ("as the crow flies") distance between two countries' centres.
 * `null` when either country is unknown to this table — callers must drop the
 * distance rather than invent one. Returns `0` for the same country.
 */
export function distanceKm(from: string, to: string): number | null {
  const a = CENTROIDS[(from || '').toUpperCase()];
  const b = CENTROIDS[(to || '').toUpperCase()];
  if (!a || !b) return null;

  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

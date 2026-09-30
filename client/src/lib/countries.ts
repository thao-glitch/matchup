/**
 * ISO-3166-1 alpha-2 codes. Kept as a compact string (no 250-line array) and
 * rendered through `Intl.DisplayNames`, so labels stay localized and correct
 * without a dependency.
 */
const REGION_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

export interface CountryOption {
  code: string;
  label: string;
}

let cached: CountryOption[] | null = null;

export function countryOptions(): CountryOption[] {
  if (cached) return cached;

  const codes = REGION_CODES.split(' ');
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    names = null;
  }

  cached = codes
    .map((code) => ({
      code,
      label: names ? (names.of(code) ?? code) : code,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return cached;
}

/** Best-effort country guess so the form opens pre-filled. */
export function guessCountry(): string {
  try {
    const locale = navigator.language || 'en';
    const region = new Intl.Locale(locale).region;
    if (region && /^[A-Z]{2}$/.test(region)) return region;
  } catch {
    /* ignore */
  }
  return '';
}

/** ISO code → display name ("KE" → "Kenya"), falling back to the raw code. */
export function countryName(code: string): string {
  const c = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return c || '—';
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(c) ?? c;
  } catch {
    return c;
  }
}

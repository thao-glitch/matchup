const { GENDERS, PREFERENCES } = require('./protocol');

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * True for characters that should never appear in a display name: C0/C1
 * control characters, zero-width characters, bidi overrides and line
 * separators. Written as explicit code-point ranges instead of a regular
 * expression so the source file stays pure ASCII.
 */
function isUnsafeChar(code) {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true; // control chars
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width + LRM/RLM
  if (code === 0x2028 || code === 0x2029) return true; // line / paragraph sep
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding/override
  if (code === 0xfeff) return true; // byte-order mark used as invisible space
  return false;
}

function sanitizeUsername(value) {
  let out = '';
  for (const ch of String(value)) {
    if (!isUnsafeChar(ch.codePointAt(0))) out += ch;
  }
  return out.trim().slice(0, 24);
}

/**
 * Validate + normalize an incoming profile. Everything here came off the
 * network, so nothing is trusted.
 *
 * Returns `null` when the payload is unusable; otherwise returns a clean
 * profile object (the age range always includes the user's own age, and an
 * empty preference list normalizes to "any").
 */
function validateProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const username = sanitizeUsername(raw.username || '');
  if (username.length < 2) return null;

  const age = clampInt(raw.age, 18, 99, NaN);
  if (!Number.isFinite(age)) return null;

  const gender = GENDERS.includes(raw.gender) ? raw.gender : null;
  if (!gender) return null;

  const country = String(raw.country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;

  let preferredGenders = Array.isArray(raw.preferredGenders)
    ? raw.preferredGenders.filter((p) => PREFERENCES.includes(p)).slice(0, 4)
    : [];
  if (preferredGenders.length === 0 || preferredGenders.includes('any')) {
    // "Any" is the default, and mixing it with explicit choices is redundant.
    preferredGenders = ['any'];
  }

  // A range that excludes yourself guarantees you can never be matched (the
  // rule is symmetric), so clamp it around the user's own age.
  const ageMin = Math.min(clampInt(raw.ageMin, 18, 99, 18), age);
  const ageMax = Math.max(clampInt(raw.ageMax, 18, 99, 99), age);

  return { username, age, gender, country, preferredGenders, ageMin, ageMax };
}

/** What the other side is allowed to see (never the age range / internal ids). */
function publicProfile(profile) {
  return {
    username: profile.username,
    age: profile.age,
    gender: profile.gender,
    country: profile.country,
  };
}

/**
 * Symmetric match rule - BOTH sides must accept the other:
 *   - gender preference (either "any" or an explicit list), and
 *   - each person's age falls inside the other's preferred range.
 */
function isMatch(a, b) {
  const genderOk = (who, whom) =>
    who.preferredGenders.includes('any') || who.preferredGenders.includes(whom.gender);

  const agesOk =
    b.age >= a.ageMin && b.age <= a.ageMax && a.age >= b.ageMin && a.age <= b.ageMax;

  return agesOk && genderOk(a, b) && genderOk(b, a);
}

module.exports = { validateProfile, publicProfile, isMatch, sanitizeUsername };

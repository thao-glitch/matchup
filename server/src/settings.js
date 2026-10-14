/**
 * App settings — everything the owner can change without a redeploy:
 *
 *   • `payment`  — the paybill the app tells people to pay into (bank, number,
 *                  account-number format, price, premium length, wording).
 *   • `features` — feature switches (ads, sign-ups, payments, maintenance).
 *
 * Stored as two JSON documents in the `settings` table, served read-only to
 * every client through `GET /api/config`, and edited only by an admin through
 * `PUT /api/admin/settings`. The cache matters: the lobby fetches the config
 * on every load, and a database round-trip per page view would be silly.
 *
 * Every value is treated as hostile input on the way in (strings trimmed,
 * control characters stripped, lengths capped, numbers clamped) because it is
 * rendered straight back into the UI.
 */
const mariaStore = require('./mariaStore');

/**
 * Defaults the app boots with, and the fallback whenever a key is missing.
 *
 * `accountFormat` is a template rendered against the signed-in account:
 * `{id}` → the numeric account id, `{username}` → their username. DTB shows
 * this as the "Account Number" on the payment confirmation, which is exactly
 * how a payment gets matched back to a user.
 */
const DEFAULTS = {
  payment: {
    enabled: true,
    bank: 'Diamond Trust Bank (DTB)',
    paybill: '',
    accountFormat: 'MU{id}',
    amount: 500,
    currency: 'KES',
    productName: 'Matchup Premium',
    premiumDays: 30,
    instructions:
      'Pay with the paybill above using your bank app or M-PESA. Enter your unique ' +
      'account number, then come back and confirm — an admin releases your access ' +
      'once the money shows on the statement.',
    supportContact: '',
  },
  features: {
    signup: true,
    ads: true,
    premium: true,
    maintenance: false,
  },
};

/** Longest string a setting may hold — anything more is truncated, not rejected. */
const MAX_TEXT = 600;
const MAX_KEY_TEXT = 48;

/** Remove control characters + zero-width junk and cap the length. */
function cleanText(value, max = MAX_TEXT) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x2028 && code !== 0x2029 && code !== 0xfeff) out += ch;
  }
  return out.trim().slice(0, max);
}

function cleanInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

/**
 * Normalize a partial `payment` patch against the defaults.
 * Unknown keys are dropped; missing keys keep their current/default value.
 */
function sanitizePayment(raw, current) {
  const base = { ...(current || DEFAULTS.payment) };
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: cleanBool(src.enabled, base.enabled),
    bank: cleanText(src.bank ?? base.bank, 80) || DEFAULTS.payment.bank,
    // Paybill numbers are digits (Safaricom) or digits+letters (some banks).
    paybill: cleanText(src.paybill ?? base.paybill, 24).replace(/[^A-Za-z0-9-]/g, ''),
    accountFormat: cleanText(src.accountFormat ?? base.accountFormat, 48).replace(
      /[^A-Za-z0-9{_}\-]/g,
      '',
    ) || DEFAULTS.payment.accountFormat,
    amount: cleanInt(src.amount ?? base.amount, 1, 1_000_000, DEFAULTS.payment.amount),
    currency: (cleanText(src.currency ?? base.currency, 3) || 'KES').toUpperCase(),
    productName: cleanText(src.productName ?? base.productName, 60) || DEFAULTS.payment.productName,
    premiumDays: cleanInt(src.premiumDays ?? base.premiumDays, 1, 3650, DEFAULTS.payment.premiumDays),
    instructions: cleanText(src.instructions ?? base.instructions, MAX_TEXT) || DEFAULTS.payment.instructions,
    supportContact: cleanText(src.supportContact ?? base.supportContact, 120),
  };
}

function sanitizeFeatures(raw, current) {
  const base = { ...(current || DEFAULTS.features) };
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    signup: cleanBool(src.signup, base.signup),
    ads: cleanBool(src.ads, base.ads),
    premium: cleanBool(src.premium, base.premium),
    maintenance: cleanBool(src.maintenance, base.maintenance),
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** @type {{payment: object, features: object}} */
let cache = {
  payment: { ...DEFAULTS.payment },
  features: { ...DEFAULTS.features },
};
let loaded = false;

/** Read both documents back from the database (defaults fill any gap). */
async function load() {
  try {
    const rows = await mariaStore.getSettings();
    cache = {
      payment: sanitizePayment(rows.payment, DEFAULTS.payment),
      features: sanitizeFeatures(rows.features, DEFAULTS.features),
    };
  } catch (err) {
    console.error('[settings] load failed:', err.message);
    cache = {
      payment: { ...DEFAULTS.payment },
      features: { ...DEFAULTS.features },
    };
  }
  loaded = true;
  return cache;
}

/** The cached copy — synchronous, for hot request paths. */
function get() {
  return cache;
}

function isLoaded() {
  return loaded;
}

/** Persist a patch and refresh the cache in the same call. */
async function save({ payment, features } = {}) {
  const next = { payment: cache.payment, features: cache.features };
  if (payment !== undefined) next.payment = sanitizePayment(payment, cache.payment);
  if (features !== undefined) next.features = sanitizeFeatures(features, cache.features);

  if (payment !== undefined) await mariaStore.putSetting('payment', next.payment);
  if (features !== undefined) await mariaStore.putSetting('features', next.features);

  cache = next;
  return cache;
}

/**
 * What every client may read from `GET /api/config`.
 * Nothing sensitive lives in here — it is the same information the lobby
 * renders on screen, plus the switches that decide what the lobby shows.
 */
function publicConfig() {
  const { payment, features } = cache;
  return {
    features: { ...features },
    payment: {
      enabled: Boolean(payment.enabled && features.premium),
      bank: payment.bank,
      paybill: payment.paybill,
      accountFormat: payment.accountFormat,
      amount: payment.amount,
      currency: payment.currency,
      productName: payment.productName,
      premiumDays: payment.premiumDays,
      instructions: payment.instructions,
      supportContact: payment.supportContact,
    },
  };
}

/**
 * Render `accountFormat` for one account: `MU{id}` → `MU1042`.
 * Unknown placeholders are removed rather than leaked as literal braces.
 */
function renderAccountNo(format, { id, username }) {
  const template = format || DEFAULTS.payment.accountFormat;
  const out = template
    .replace(/\{id\}/g, String(Number(id) || 0))
    .replace(/\{username\}/g, String(username || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24));
  return out.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || `MU${Number(id) || 0}`;
}

module.exports = {
  DEFAULTS,
  load,
  get,
  isLoaded,
  save,
  publicConfig,
  renderAccountNo,
  sanitizePayment,
  sanitizeFeatures,
};

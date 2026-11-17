/**
 * App settings — everything the owner can change without a redeploy:
 *
 *   • `payment`  — the premium subscription: price, period, product name and
 *                  the wording shown on the pay screen.
 *   • `features` — feature switches (ads, sign-ups, payments, maintenance).
 *   • `commerce` — the social platform: which tabs exist, what a post costs,
 *                  and the commission ("tax") the house keeps on every sale.
 *   • `mpesa`    — Daraja STK push credentials (secrets: masked on read).
 *
 * Every payment on the platform is an M-PESA STK push: the buyer's phone
 * prompts for its PIN and the Daraja callback settles the charge. There is no
 * paybill to read off a bank statement and nothing for the owner to approve,
 * so this document holds no account numbers or bank names any more — the only
 * bank-side detail that matters is the shortcode, and that lives in `mpesa`.
 *
 * Stored as JSON documents in the `settings` table, served read-only to
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
 * `payment` is the subscription the STK prompt collects: price, period, and
 * the name printed on the button. The `Account Number` template that used to
 * live here is gone — nothing matches a statement by hand any more.
 */
const DEFAULTS = {
  payment: {
    enabled: true,
    amount: 500,
    currency: 'KES',
    productName: 'Matchup Premium',
    premiumDays: 30,
    instructions:
      'Press pay and your phone prompts you for the M-PESA PIN. Premium switches ' +
      'on the moment you confirm — there is nothing to send us afterwards.',
    supportContact: '',
  },
  features: {
    signup: true,
    ads: true,
    premium: true,
    maintenance: false,
  },
  /** The social platform: who may post, what it costs, what the house keeps. */
  commerce: {
    enabled: true,
    social: true,
    groups: true,
    adult: true,
    commissionRate: 15,
    minPrice: 5,
    maxPrice: 15000,
    currency: 'KES',
    /**
     * Manual payment review — for owners whose M-PESA is not on Daraja yet
     * (or never will be). Every purchase opens a pending charge WITHOUT an
     * STK push; the buyer sends the money by any M-PESA route and the owner
     * confirms the SMS in `/admin` → Earnings. Approval settles the charge
     * exactly like an STK callback (split, wallet, entitlement), so the
     * platform cut and every creator payout behave identically.
     */
    manualEnabled: false,
    manualDestination: '',
    manualInstructions: '',
  },
  /**
   * M-PESA Daraja (STK push) — secrets stay in this document, never public.
   *
   * `shortcode` + `passkey` are the pair that makes a prompt possible at all:
   * Safaricom bills against the shortcode and signs the request with the
   * Lipa na M-PESA passkey. The owner settles that shortcode's balance to
   * their own M-PESA number on Safaricom's side.
   */
  mpesa: {
    enabled: false,
    consumerKey: '',
    consumerSecret: '',
    shortcode: '',
    /**
     * Which rail the shortcode sits on. STK push has to name it in every
     * request — `CustomerPayBillOnline` bills a Paybill, `CustomerBuyGoodsOnline`
     * bills a Buy Goods till — and Safaricom rejects the mismatch outright, so
     * this is a choice the owner makes once, next to the shortcode itself.
     */
    shortcodeType: 'paybill',
    passkey: '',
    baseUrl: 'https://sandbox.safaricom.co.ke',
    callbackUrl: '',
    description: 'Matchup',
  },
};

/** Fields in `mpesa` that are secrets: masked on read, ignored when masked. */
const MPESA_SECRETS = ['consumerKey', 'consumerSecret', 'passkey'];
const MASK = '••••••••';

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

/**
 * The social platform's economics. `commissionRate` is the house cut on every
 * paid view — 0–50% is the sane band; beyond that creators simply leave.
 */
function sanitizeCommerce(raw, current) {
  const base = { ...(current || DEFAULTS.commerce) };
  const src = raw && typeof raw === 'object' ? raw : {};
  const minPrice = cleanInt(src.minPrice ?? base.minPrice, 0, 1_000_000, DEFAULTS.commerce.minPrice);
  return {
    enabled: cleanBool(src.enabled, base.enabled),
    social: cleanBool(src.social, base.social),
    groups: cleanBool(src.groups, base.groups),
    adult: cleanBool(src.adult, base.adult),
    commissionRate: cleanInt(src.commissionRate ?? base.commissionRate, 0, 50, DEFAULTS.commerce.commissionRate),
    minPrice,
    maxPrice: Math.max(
      minPrice,
      cleanInt(src.maxPrice ?? base.maxPrice, 1, 1_000_000, DEFAULTS.commerce.maxPrice),
    ),
    currency: (cleanText(src.currency ?? base.currency, 3) || 'KES').toUpperCase(),
    // Manual payment review — destination is shown to the buyer verbatim, so
    // it is stored exactly as typed (trimmed, capped).
    manualEnabled: cleanBool(src.manualEnabled, base.manualEnabled),
    manualDestination: cleanText(src.manualDestination ?? base.manualDestination, 80),
    manualInstructions: cleanText(src.manualInstructions ?? base.manualInstructions, MAX_TEXT),
  };
}

/**
 * Daraja credentials. Two rules make the dashboard safe to use:
 *   • secrets read back as `••••••••` so a screen share never leaks a key;
 *   • a write whose value still contains the mask is dropped (the stored
 *     secret wins), so saving the form without retyping keys is a no-op.
 */
function sanitizeMpesa(raw, current) {
  const base = { ...(current || DEFAULTS.mpesa) };
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, max) => {
    const incoming = src[key];
    if (incoming === undefined) return base[key];
    const text = cleanText(incoming, max);
    if (MPESA_SECRETS.includes(key) && text.includes(MASK)) return base[key];
    return text;
  };
  return {
    enabled: cleanBool(src.enabled, base.enabled),
    consumerKey: pick('consumerKey', 120),
    consumerSecret: pick('consumerSecret', 120),
    shortcode: pick('shortcode', 24).replace(/[^A-Za-z0-9]/g, ''),
    // Anything but `till` means Paybill — a stored document predating this
    // field loads as the paybill behaviour it always had.
    shortcodeType: (src.shortcodeType ?? base.shortcodeType) === 'till' ? 'till' : 'paybill',
    passkey: pick('passkey', 200),
    baseUrl: normalizeBaseUrl(cleanText(src.baseUrl ?? base.baseUrl, 120) || DEFAULTS.mpesa.baseUrl),
    callbackUrl: cleanText(src.callbackUrl ?? base.callbackUrl, 240),
    description: cleanText(src.description ?? base.description, 40) || DEFAULTS.mpesa.description,
  };
}

/** The stored document with its secrets masked — what the dashboard reads. */
function maskMpesa(doc) {
  const out = { ...doc };
  for (const key of MPESA_SECRETS) {
    if (out[key]) out[key] = MASK;
  }
  return out;
}

/** Only http(s) may reach an outbound fetch — a `javascript:` base would not. */
function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text.replace(/^\/+/, '')}`;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** @type {{payment: object, features: object, commerce: object, mpesa: object}} */
let cache = {
  payment: { ...DEFAULTS.payment },
  features: { ...DEFAULTS.features },
  commerce: { ...DEFAULTS.commerce },
  mpesa: { ...DEFAULTS.mpesa },
};
let loaded = false;

/** Read all four documents back from the database (defaults fill any gap). */
async function load() {
  try {
    const rows = await mariaStore.getSettings();
    cache = {
      payment: sanitizePayment(rows.payment, DEFAULTS.payment),
      features: sanitizeFeatures(rows.features, DEFAULTS.features),
      commerce: sanitizeCommerce(rows.commerce, DEFAULTS.commerce),
      mpesa: sanitizeMpesa(rows.mpesa, DEFAULTS.mpesa),
    };
  } catch (err) {
    console.error('[settings] load failed:', err.message);
    cache = {
      payment: { ...DEFAULTS.payment },
      features: { ...DEFAULTS.features },
      commerce: { ...DEFAULTS.commerce },
      mpesa: { ...DEFAULTS.mpesa },
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
async function save({ payment, features, commerce, mpesa } = {}) {
  const next = {
    payment: cache.payment,
    features: cache.features,
    commerce: cache.commerce,
    mpesa: cache.mpesa,
  };
  if (payment !== undefined) next.payment = sanitizePayment(payment, cache.payment);
  if (features !== undefined) next.features = sanitizeFeatures(features, cache.features);
  if (commerce !== undefined) next.commerce = sanitizeCommerce(commerce, cache.commerce);
  if (mpesa !== undefined) next.mpesa = sanitizeMpesa(mpesa, cache.mpesa);

  if (payment !== undefined) await mariaStore.putSetting('payment', next.payment);
  if (features !== undefined) await mariaStore.putSetting('features', next.features);
  if (commerce !== undefined) await mariaStore.putSetting('commerce', next.commerce);
  if (mpesa !== undefined) await mariaStore.putSetting('mpesa', next.mpesa);

  cache = next;
  return cache;
}

/** What the dashboard reads back: everything, with the Daraja secrets masked. */
function adminView() {
  return {
    payment: { ...cache.payment },
    features: { ...cache.features },
    commerce: { ...cache.commerce },
    mpesa: maskMpesa(cache.mpesa),
  };
}

/**
 * What every client may read from `GET /api/config`.
 * Nothing sensitive lives in here — it is the same information the pay screen
 * renders, plus the switches that decide what the lobby shows.
 */
function publicConfig() {
  const { payment, features, commerce, mpesa } = cache;
  return {
    features: { ...features },
    payment: {
      enabled: Boolean(payment.enabled && features.premium),
      amount: payment.amount,
      currency: payment.currency,
      productName: payment.productName,
      premiumDays: payment.premiumDays,
      instructions: payment.instructions,
      supportContact: payment.supportContact,
    },
    /**
     * The social platform as the app renders it: which tabs exist, what the
     * house keeps, and whether M-PESA can actually take money right now.
     *
     * `mpesaReady` is the honest gate — every payment is an STK push, so a
     * missing shortcode means the Pay button has to explain itself instead of
     * firing a prompt Safaricom will refuse.
     */
    commerce: {
      enabled: Boolean(commerce.enabled),
      social: Boolean(commerce.enabled && commerce.social),
      groups: Boolean(commerce.enabled && commerce.groups),
      adult: Boolean(commerce.enabled && commerce.adult),
      commissionRate: commerce.commissionRate,
      minPrice: commerce.minPrice,
      maxPrice: commerce.maxPrice,
      currency: commerce.currency,
      mpesaReady: Boolean(
        mpesa.enabled &&
          mpesa.consumerKey &&
          mpesa.consumerSecret &&
          mpesa.shortcode &&
          mpesa.passkey,
      ),
      /**
       * Manual review mode — the buyer needs to know where to send the
       * money and why the charge is not a PIN prompt. `destination` is a
       * public M-PESA address by design; the owner controls what it says.
       */
      manualPayments: {
        enabled: Boolean(commerce.manualEnabled),
        destination: String(commerce.manualDestination || '').trim(),
        instructions: String(commerce.manualInstructions || '').trim(),
      },
    },
  };
}

module.exports = {
  DEFAULTS,
  MPESA_SECRETS,
  load,
  get,
  isLoaded,
  save,
  adminView,
  publicConfig,
  sanitizePayment,
  sanitizeFeatures,
  sanitizeCommerce,
  sanitizeMpesa,
  maskMpesa,
};

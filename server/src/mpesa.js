/**
 * M-PESA Daraja — STK push (Lipa na M-PESA Online).
 *
 * This is the "press Pay → your phone prompts you → type your PIN" half of
 * the platform. The flow, end to end:
 *
 *   1. `stkPush()`  → Daraja returns a `CheckoutRequestID` and the user's
 *      phone immediately shows the PIN prompt. We persist that id on the
 *      charge row BEFORE calling, so a callback that races the response can
 *      still find its row (the id is unique-indexed).
 *   2. The phone confirms → Safaricom POSTs to `POST /api/mpesa/callback`
 *      with `ResultCode 0` and the `MpesaReceiptNumber` → we settle.
 *   3. Callbacks get lost (firewalls, restarts), so the client also polls the
 *      charge and, while it is pending, `queryStatus()` asks Daraja directly —
 *      three independent ways to reach `paid`.
 *
 * Credentials come from the `mpesa` settings document (edited in
 * `/admin` → Settings), not from the environment: the owner can rotate a key
 * without a redeploy, and nothing here is ever exposed to a client.
 *
 * There is no dependency on `@safaricom/*` SDKs — Daraja is three plain JSON
 * POSTs, and Node 20 ships `fetch`.
 */
const settings = require('./settings');

const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // Daraja timestamps are East Africa Time

class MpesaError extends Error {
  constructor(message, code = 'mpesa') {
    super(message);
    this.name = 'MpesaError';
    this.code = code;
  }
}

/** The stored Daraja config (never the masked admin view). */
function config() {
  return settings.get().mpesa;
}

function isConfigured() {
  const cfg = config();
  return Boolean(
    cfg.enabled &&
      cfg.mode === 'stk' &&
      cfg.consumerKey &&
      cfg.consumerSecret &&
      cfg.shortcode &&
      cfg.passkey,
  );
}

function baseUrl() {
  return String(config().baseUrl || 'https://sandbox.safaricom.co.ke').replace(/\/+$/, '');
}

/** `0712 345 678`, `+254712345678`, `254712345678` → `254712345678`. */
function normalizePhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

function isValidPhone(value) {
  return /^254(7|1)\d{8}$/.test(normalizePhone(value));
}

/** `YYYYMMDDHHmmss` in EAT — must match the one used to build the password. */
function timestamp() {
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

// ── OAuth token ──────────────────────────────────────────────────────────────

/** @type {{ token: string, expiresAt: number } | null} */
let tokenCache = null;

async function getAuthToken({ force = false } = {}) {
  if (!force && tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  const cfg = config();
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
  }).catch((err) => {
    throw new MpesaError(`Could not reach M-PESA (${err.message}).`, 'network');
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new MpesaError(
      'M-PESA rejected the credentials — check the consumer key and secret in Settings.',
      'auth',
    );
  }
  // Daraja reports `expires_in` in seconds (3590 is the usual value).
  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3590) * 1000,
  };
  return tokenCache.token;
}

/** Called after a settings save so a rotated key takes effect immediately. */
function invalidateToken() {
  tokenCache = null;
}

// ── STK push ─────────────────────────────────────────────────────────────────

/**
 * Prompt a phone for payment. Returns the ids the callback will echo back.
 *
 * @param {{ phone: string, amount: number, accountRef: string, description: string }} opts
 * @returns {Promise<{ checkoutRequestId: string, merchantRequestId: string }>}
 */
async function stkPush({ phone, amount, accountRef, description }) {
  const cfg = config();
  const msisdn = normalizePhone(phone);
  if (!isValidPhone(msisdn)) {
    throw new MpesaError('Enter a valid Safaricom number, e.g. 0712 345 678.', 'invalid-phone');
  }
  const shillings = Math.max(1, Math.round(Number(amount) || 0));
  const ts = timestamp();
  const password = Buffer.from(`${cfg.shortcode}${cfg.passkey}${ts}`).toString('base64');

  const payload = {
    BusinessShortCode: cfg.shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline',
    // Daraja takes whole shillings only — round here so the charge row, the
    // wallet split and the prompt all agree on the same number.
    Amount: shillings,
    PartyA: msisdn,
    PartyB: cfg.shortcode,
    PhoneNumber: msisdn,
    CallBackURL: cfg.callbackUrl,
    AccountReference: String(accountRef || 'Matchup').slice(0, 12),
    TransactionDesc: String(description || 'Matchup').slice(0, 13),
  };

  const token = await getAuthToken();
  const res = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    throw new MpesaError(`Could not reach M-PESA (${err.message}).`, 'network');
  });

  let body = await res.json().catch(() => ({}));
  // An expired token is the one auth failure worth retrying once.
  if (res.status === 401) {
    await getAuthToken({ force: true });
    const retry = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await getAuthToken()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (retry) body = await retry.json().catch(() => ({}));
  }

  if (String(body.ResponseCode) !== '0' || !body.CheckoutRequestID) {
    const message =
      body.errorMessage ||
      body.ResponseDescription ||
      body.ResponseCode && `M-PESA refused the request (${body.ResponseCode}).` ||
      'M-PESA did not accept the request — try again in a moment.';
    throw new MpesaError(String(message), 'rejected');
  }

  return {
    checkoutRequestId: String(body.CheckoutRequestID),
    merchantRequestId: String(body.MerchantRequestID || ''),
  };
}

/**
 * Ask Daraja where a push got to — the fallback when the callback never
 * arrives (the client polls this through the charge status endpoint).
 *
 * @returns {Promise<{ complete: boolean, resultCode: number|null, receipt: string|null, description: string|null }>}
 */
async function queryStatus(checkoutRequestId) {
  const cfg = config();
  const ts = timestamp();
  const password = Buffer.from(`${cfg.shortcode}${cfg.passkey}${ts}`).toString('base64');
  const token = await getAuthToken();

  const res = await fetch(`${baseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: cfg.shortcode,
      Password: password,
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  }).catch(() => null);
  if (!res) return { complete: false, resultCode: null, receipt: null, description: null };

  const body = await res.json().catch(() => ({}));
  const code = body.ResultCode === undefined ? null : Number(body.ResultCode);
  if (code === null) return { complete: false, resultCode: null, receipt: null, description: null };
  return {
    complete: true,
    resultCode: code,
    // ResultCode 0 carries the receipt in ResultDesc on some sandboxes; the
    // callback is the authoritative source, so this only unblocks pending rows.
    receipt: code === 0 ? String(body.ResultDesc || '').match(/\b[A-Z0-9]{10}\b/)?.[0] || null : null,
    description: body.ResultDesc ? String(body.ResultDesc) : null,
  };
}

/**
 * Normalize the callback Daraja POSTs to `/api/mpesa/callback`.
 * Accepts both the current shape and the older wrapped one, so a sandbox
 * account on either version still settles.
 *
 * @returns {{ checkoutRequestId: string, merchantRequestId: string, resultCode: number,
 *             description: string, amount: number|null, receipt: string|null } | null}
 */
function parseCallback(raw) {
  const stk =
    raw?.Body?.stkCallback ||
    raw?.stkCallback ||
    raw?.CallbackMetadata ||
    null;
  if (!stk || !stk.CheckoutRequestID) return null;

  const items = stk.CallbackMetadata?.Item || [];
  const find = (name) => items.find((item) => item.Name === name)?.Value ?? null;

  return {
    checkoutRequestId: String(stk.CheckoutRequestID),
    merchantRequestId: String(stk.MerchantRequestID || ''),
    resultCode: Number(stk.ResultCode) || 0,
    description: String(stk.ResultDesc || ''),
    amount: find('Amount') == null ? null : Number(find('Amount')),
    receipt: find('MpesaReceiptNumber') == null ? null : String(find('MpesaReceiptNumber')),
  };
}

/** Daraja expects an immediate ack or it keeps retrying the POST. */
const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };
const NACK = { ResultCode: 1, ResultDesc: 'Rejected' };

module.exports = {
  MpesaError,
  config,
  isConfigured,
  normalizePhone,
  isValidPhone,
  getAuthToken,
  invalidateToken,
  stkPush,
  queryStatus,
  parseCallback,
  ACK,
  NACK,
};

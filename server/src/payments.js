/**
 * Premium — the subscription, taken entirely by M-PESA STK push.
 *
 * There is no paybill ledger here any more. The old flow ("here is your
 * Account Number, pay it from a bank app, press I have paid, wait for the
 * owner to match it against a statement") is gone, because Daraja tells us
 * the answer itself the moment the buyer enters their PIN:
 *
 *   1. `createIntent(user, { phone })` opens a `purpose: 'premium'` charge and
 *      fires the STK push — the phone prompts immediately. Reusing an open
 *      charge means a double-tap can never start two prompts.
 *   2. They confirm → Safaricom POSTs `/api/mpesa/callback` →
 *      `commerce.settle()` stamps `premium_until` on their account.
 *   3. The panel polls `status()` meanwhile, so a callback lost to a firewall
 *      still resolves: `chargeStatus` asks Daraja directly once the callback
 *      has had a head start.
 *
 * The money lands in the Daraja shortcode's collection account, which the
 * owner settles to their own M-PESA number on Safaricom's side — no business
 * bank account is involved anywhere in this file.
 *
 * Everything here is the signed-in user's own: a charge is only ever readable
 * by its buyer, and `premiumUntil` is always read fresh from the database
 * rather than the session, because the callback may have just changed it.
 */
const mariaStore = require('./mariaStore');
const socialStore = require('./socialStore');
const settings = require('./settings');
const accounts = require('./accounts');
const commerce = require('./commerce');

const { AuthError } = accounts;

/** `maria` = premium can be sold, `memory` = payments are off. */
let backend = 'memory';

function init(storeMode) {
  backend = storeMode === 'maria' ? 'maria' : 'memory';
}

function requireDb() {
  if (backend !== 'maria') {
    throw new AuthError(
      'storage',
      'Payments need the database — MARIADB_* is not configured on this server.',
      503,
    );
  }
}

function requireUser(user) {
  if (!user || typeof user.id !== 'number') {
    throw new AuthError('unauthorized', 'Please sign in to pay.', 401);
  }
  return user;
}

/**
 * Premium charges have no "thing" to point at, so they share one ref id. The
 * uniqueness that matters is (purpose, ref, buyer): one open prompt per buyer.
 */
const PREMIUM_REF = 0;

/** What the lobby renders (the safe subset of the settings — see `settings.js`). */
function config() {
  return settings.publicConfig();
}

/** The buyer's live entitlement, straight from the row that settles it. */
async function premiumUntilOf(user) {
  const account = await mariaStore.getUser(user.id).catch(() => null);
  return account?.premiumUntil ?? user.premiumUntil ?? null;
}

/**
 * The panel's view of one premium charge — the charge plus the entitlement it
 * will produce, so the UI never has to join two requests to draw itself.
 */
function toClient(charge, premiumUntil) {
  if (!charge) return null;
  return {
    id: charge.id,
    status: charge.status,
    amount: charge.amount,
    currency: charge.currency,
    premiumDays: charge.premiumDays,
    phone: charge.phone,
    mpesaRef: charge.mpesaRef,
    error: charge.status === 'failed' ? charge.error : null,
    createdAt: charge.createdAt,
    paidAt: charge.paidAt,
    premiumUntil,
  };
}

/**
 * Open the premium charge and prompt the phone.
 *
 * Safe to call twice: an already-open charge for this buyer is returned after
 * being re-prompted, so a reload, a retry or a second tab can never leave two
 * live STK prompts against one account.
 *
 * @param {{id:number, username:string}} user authenticated account
 * @param {{phone?: string}} extra the M-PESA number to prompt
 */
async function createIntent(user, { phone } = {}) {
  requireDb();
  requireUser(user);
  const { charge } = await commerce.createCharge(user, {
    purpose: 'premium',
    refId: PREMIUM_REF,
    phone,
  });
  return toClient(charge, await premiumUntilOf(user));
}

/**
 * One premium charge, settled on the way out if Daraja already knows the
 * answer. The client polls this every 3s while the phone shows the prompt.
 */
async function status(user, id) {
  requireDb();
  requireUser(user);
  const { charge } = await commerce.chargeStatus(user, id);
  return toClient(charge, await premiumUntilOf(user));
}

/** The signed-in user's own receipts + when premium (if any) runs out. */
async function mine(user) {
  requireDb();
  requireUser(user);
  const [rows, premiumUntil] = await Promise.all([
    socialStore.listChargesForBuyer({ purpose: 'premium', buyerId: user.id, size: 10 }),
    premiumUntilOf(user),
  ]);
  return {
    premiumUntil,
    // The still-open charge is what a returning payer needs: it is the prompt
    // their phone may still be showing.
    open: rows.find((row) => row.status === 'pending') ?? null,
    payments: rows,
  };
}

module.exports = { init, config, createIntent, status, mine, backend: () => backend };

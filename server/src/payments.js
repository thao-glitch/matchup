/**
 * Paybill payments (client side of the ledger).
 *
 * How money actually moves:
 *
 *   1. The user asks for a reference  → `POST /api/payments/intent`
 *      The app renders their unique Account Number (`MU1042` by default) plus
 *      the configured DTB paybill number and price.
 *   2. They pay into the paybill from their own bank app / M-PESA, entering
 *      that Account Number — the bank credits the business account and shows
 *      the number on the statement (and, for M-PESA, in the confirmation SMS).
 *   3. They press "I have paid" (the same endpoint — the row already exists).
 *   4. The owner opens `/admin` → Payments, matches the row against the bank
 *      statement and approves it. Approval stamps `premium_until` on the
 *      account and the user's lobby flips to "Premium active".
 *
 * There is no bank callback to wait for: a plain paybill notifies by SMS /
 * e-mail / statement, so reconciliation is a human step by design. The ledger
 * exists so that step takes seconds instead of digging through a statement.
 *
 * Everything here is read-only for the public — the only mutation is "create
 * (or re-fetch) my own pending intent". Approving lives in `admin.js`.
 */
const mariaStore = require('./mariaStore');
const settings = require('./settings');
const accounts = require('./accounts');

const { AuthError } = accounts;

/** `maria` = the ledger lives in the database, `memory` = payments are off. */
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

/** What the lobby renders (safe subset of the settings — see `settings.js`). */
function config() {
  return settings.publicConfig();
}

/** Everything the payment screen shows for this user, from one intent row. */
function toClient(payment, paymentSettings) {
  if (!payment) return null;
  return {
    id: payment.id,
    status: payment.status,
    // Bank + amount are read live from the settings: the owner may change the
    // price or move to another paybill and every open intent follows.
    bank: paymentSettings.bank,
    paybill: paymentSettings.paybill,
    accountNo: payment.accountNo,
    amount: payment.amount,
    currency: payment.currency,
    productName: paymentSettings.productName,
    premiumDays: payment.premiumDays ?? paymentSettings.premiumDays,
    providerRef: payment.providerRef,
    note: payment.note,
    instructions: paymentSettings.instructions,
    supportContact: paymentSettings.supportContact,
    createdAt: payment.createdAt,
    reviewedAt: payment.reviewedAt,
  };
}

/**
 * Create (or return the already open) payment intent for a signed-in account.
 * Reusing the pending row means a reload, a retry or a second tab can never
 * hand the same person two different account numbers.
 *
 * @param {{id:number, username:string}} user authenticated account
 * @param {{providerRef?: string}} extra the transaction code they saw
 */
async function createIntent(user, { providerRef } = {}) {
  requireDb();
  const cfg = settings.get();
  if (!cfg.features.premium || !cfg.payment.enabled) {
    throw new AuthError(
      'payments-disabled',
      'Payments are currently disabled — try again a little later.',
      409,
    );
  }
  if (!user || typeof user.id !== 'number') {
    throw new AuthError('unauthorized', 'Please sign in to get a payment reference.', 401);
  }

  const accountNo = settings.renderAccountNo(cfg.payment.accountFormat, {
    id: user.id,
    username: user.username,
  });

  const existing = await mariaStore.findPendingPayment(user.id);
  if (existing) {
    // Refresh the reference itself — the format may have been edited since.
    if (existing.accountNo !== accountNo) {
      const updated = await mariaStore.updatePaymentAccountNo(existing.id, accountNo);
      return toClient(updated || existing, cfg.payment);
    }
    return toClient(existing, cfg.payment);
  }

  const payment = await mariaStore.insertPayment({
    accountId: user.id,
    username: user.username,
    amount: cfg.payment.amount,
    currency: cfg.payment.currency,
    paybill: cfg.payment.paybill,
    accountNo,
    providerRef,
    premiumDays: cfg.payment.premiumDays,
  });
  return toClient(payment, cfg.payment);
}

/** The signed-in user's own ledger + entitlement — never anyone else's. */
async function mine(user) {
  requireDb();
  if (!user || typeof user.id !== 'number') {
    throw new AuthError('unauthorized', 'Please sign in again.', 401);
  }
  const [rows, account] = await Promise.all([
    mariaStore.listPaymentsForAccount(user.id),
    mariaStore.findAccountByUsername(user.username),
  ]);
  const cfg = settings.get().payment;
  return {
    payments: rows.map((row) => toClient(row, cfg)),
    premiumUntil: account?.premiumUntil ?? user.premiumUntil ?? null,
  };
}

module.exports = { init, config, createIntent, mine, backend: () => backend };

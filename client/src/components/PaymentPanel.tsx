/**
 * Paybill payment panel — the lobby's "support the app / go premium" card.
 *
 * It does exactly three things, and deliberately nothing more:
 *
 *   1. shows the configured DTB paybill + the person's unique Account Number
 *      (the value that ties an incoming bank payment to their account),
 *   2. lets them copy the transaction code they saw after paying, and
 *   3. keeps their ledger status on screen — pending / approved / rejected.
 *
 * There is no card form, no redirect and no bank API here on purpose: a plain
 * paybill has no callback, so a human confirms payment in `/admin`. The panel
 * only has to make that manual match trivial — same Account Number, on both
 * sides.
 *
 * Everything is read from the public `/api/config` block the owner edits in
 * the dashboard, so changing the paybill or the price takes effect for every
 * visitor without a redeploy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountUser, PaymentIntent } from '../types';
import type { PublicConfig } from '../lib/config';
import { PaymentError, createPaymentIntent, fetchMyPayments } from '../lib/payments';
import { SpinnerIcon } from './icons';

interface Props {
  /** Signed-in account — payments are tied to an account, never to a device. */
  account: AccountUser | null;
  config: PublicConfig;
  /** Reports a new entitlement so the lobby can react without a reload. */
  onPremiumChange?: (premiumUntil: string | null) => void;
}

/** `2026-11-13T…` → "13 Nov 2026" — no date library, no locale surprises. */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A premium that has not expired yet. */
function premiumActive(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const until = new Date(iso).getTime();
  return Number.isFinite(until) && until > Date.now();
}

export default function PaymentPanel({ account, config, onPremiumChange }: Props) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [premiumUntil, setPremiumUntil] = useState<string | null>(account?.premiumUntil ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [refInput, setRefInput] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { payment } = config;

  /** Pull the existing ledger so a returning payer sees their status. */
  const refresh = useCallback(async () => {
    if (!account) {
      setIntent(null);
      return;
    }
    try {
      const data = await fetchMyPayments();
      setPremiumUntil(data.premiumUntil);
      onPremiumChange?.(data.premiumUntil);
      // The newest row is the one that matters — the user only ever has one
      // open reference, and history lives on the server until they need it.
      setIntent(data.payments[0] ?? null);
      if (data.payments[0]) setRefInput(data.payments[0].providerRef ?? '');
    } catch {
      /* silent: the panel still works, it just starts from "no reference" */
    }
  }, [account, onPremiumChange]);

  useEffect(() => {
    void refresh();
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [refresh]);

  if (!payment.enabled) return null;

  const active = premiumActive(premiumUntil);

  /** Ask for (or re-open) the reference — the same one every time. */
  async function ensureIntent() {
    setBusy(true);
    setError(null);
    try {
      const created = await createPaymentIntent(refInput.trim() || undefined);
      setIntent(created);
    } catch (err) {
      setError(err instanceof PaymentError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  /** "I have paid" — re-attaches the transaction code to the same intent. */
  async function confirmPaid() {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const created = await createPaymentIntent(refInput.trim() || undefined);
      setIntent(created);
      setFlash(
        'Thanks — your payment is in the queue. Access is released as soon as the money shows on the statement.',
      );
    } catch (err) {
      setError(err instanceof PaymentError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function copyAccountNo() {
    if (!intent) return;
    try {
      await navigator.clipboard.writeText(intent.accountNo);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the number is on screen anyway */
    }
  }

  const statusPill =
    intent?.status === 'approved' ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2.5 py-1 text-xs font-semibold text-ok">
        ✓ Approved
      </span>
    ) : intent?.status === 'rejected' ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2.5 py-1 text-xs font-semibold text-danger">
        ✕ Not matched
      </span>
    ) : intent ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2.5 py-1 text-xs font-semibold text-warn">
        ◔ Waiting for confirmation
      </span>
    ) : null;

  return (
    <div className="mt-5 rounded-xl border border-white/10 bg-surface-3/60 p-4 text-left">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {active ? `${payment.productName} — active` : `Support Matchup · ${payment.productName}`}
          </p>
          <p className="text-xs text-muted">
            {active
              ? `Premium until ${formatDate(premiumUntil)} — no ads, and you keep the app online.`
              : `${payment.currency} ${payment.amount} / ${payment.premiumDays} days · ${payment.bank}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
        >
          {open ? 'Hide' : active ? 'Manage' : 'Pay by paybill'}
        </button>
      </div>

      {statusPill && <div className="mt-3">{statusPill}</div>}

      {open && (
        <div className="mt-4 space-y-4">
          {!account ? (
            <p className="text-xs leading-relaxed text-muted">
              Sign in above first — the payment reference is tied to your account, so your
              access follows you to any device.
            </p>
          ) : (
            <>
              {/* ── Step 1: the reference ─────────────────────────────────── */}
              <div className="rounded-xl border border-accent/30 bg-accent/5 p-3.5">
                <p className="label mb-1">Your account number</p>
                <div className="flex items-center justify-between gap-3">
                  <p className="font-mono text-2xl font-bold tracking-wider text-ink">
                    {intent?.accountNo ?? '—'}
                  </p>
                  <button
                    type="button"
                    onClick={() => void (intent ? copyAccountNo() : ensureIntent())}
                    disabled={busy}
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                  >
                    {busy ? <SpinnerIcon className="h-3.5 w-3.5" /> : copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  Pay <span className="font-semibold text-ink">{payment.currency} {payment.amount}</span> to{' '}
                  <span className="font-semibold text-ink">
                    {payment.paybill ? `Paybill ${payment.paybill}` : payment.bank}
                  </span>{' '}
                  and enter the account number above. Any bank app or M-PESA works.
                </p>
              </div>

              {payment.instructions && (
                <p className="text-xs leading-relaxed text-muted">{payment.instructions}</p>
              )}

              {/* ── Step 2: proof of payment ──────────────────────────────── */}
              <div>
                <label className="label" htmlFor="providerRef">
                  Transaction code (optional)
                </label>
                <input
                  id="providerRef"
                  className="field"
                  value={refInput}
                  maxLength={64}
                  onChange={(e) => setRefInput(e.target.value)}
                  placeholder="e.g. SJ42K91LMN from the confirmation SMS"
                />
              </div>

              <button
                type="button"
                onClick={() => void confirmPaid()}
                disabled={busy || !intent}
                className="btn btn-primary w-full"
              >
                {busy ? (
                  <>
                    <SpinnerIcon className="h-4 w-4" /> Sending…
                  </>
                ) : intent ? (
                  'I have paid'
                ) : (
                  'Get my payment reference'
                )}
              </button>

              {intent?.status === 'rejected' && (
                <p className="text-xs leading-relaxed text-danger">
                  {intent.note || 'We could not match that payment to the statement.'}{' '}
                  {payment.supportContact && <>Contact {payment.supportContact}.</>}
                </p>
              )}

              {intent?.status === 'pending' && (
                <p className="text-xs leading-relaxed text-muted">
                  Confirmation usually happens the same day. This panel updates itself as soon
                  as you reload the page.
                </p>
              )}

              {flash && <p className="text-xs leading-relaxed text-ok">{flash}</p>}
            </>
          )}

          {error && (
            <p className="text-xs leading-relaxed text-warn" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

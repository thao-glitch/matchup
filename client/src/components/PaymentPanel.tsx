/**
 * Premium panel — the lobby's "support the app / go premium" card.
 *
 * It does exactly four things, and deliberately nothing more:
 *
 *   1. shows the price and how much premium is already running,
 *   2. takes an M-PESA number and fires an STK push,
 *   3. waits on the phone's PIN prompt, and
 *   4. flips to "active" the moment the callback settles the charge.
 *
 * There is no account number to copy, no transaction code to type in and no
 * "I have paid" button: Daraja answers for itself the moment the PIN lands,
 * so the panel's only job after that point is to watch `charge.status`.
 *
 * A reload mid-prompt is safe — the server still holds the open charge, so
 * this panel picks the wait back up instead of prompting the phone twice.
 *
 * Everything is read from the public `/api/config` block the owner edits in
 * the dashboard, so changing the price or the period takes effect for every
 * visitor without a redeploy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountUser, PremiumPayment } from '../types';
import type { PublicConfig } from '../lib/config';
import {
  PaymentError,
  createPaymentIntent,
  fetchMyPayments,
  waitForPayment,
} from '../lib/payments';
import { formatKes, isValidPhone, lastPhone, rememberPhone } from '../lib/social';
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

type Phase = 'idle' | 'form' | 'sending' | 'waiting' | 'error';

export default function PaymentPanel({ account, config, onPremiumChange }: Props) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [phone, setPhone] = useState(() => lastPhone());
  const [charge, setCharge] = useState<PremiumPayment | null>(null);
  const [premiumUntil, setPremiumUntil] = useState<string | null>(account?.premiumUntil ?? null);
  const [error, setError] = useState<string | null>(null);
  /** Guards against setting state after the panel has been dismissed. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { payment, commerce } = config;
  const manual = Boolean(commerce.manualPayments?.enabled);
  const destination = commerce.manualPayments?.destination ?? '';
  const manualInstructions = commerce.manualPayments?.instructions ?? '';
  const active = premiumActive(premiumUntil);
  /** Double-tapping Pay must not open two STK prompts. */
  const busy = phase === 'sending' || phase === 'waiting';

  const applyPremium = useCallback(
    (iso: string | null) => {
      setPremiumUntil(iso);
      onPremiumChange?.(iso);
    },
    [onPremiumChange],
  );

  /**
   * Pull the buyer's own state so a returning payer sees what is already
   * running — and, if their phone is still showing a prompt from before the
   * reload, pick that wait back up rather than prompting them twice.
   */
  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      const data = await fetchMyPayments();
      if (!alive.current) return;
      applyPremium(data.premiumUntil);
      if (data.open) {
        setCharge(data.open);
        setPhase('waiting');
        void watch(data.open.id);
      }
    } catch {
      /* silent: the panel still works, it just starts from "not paid yet" */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, applyPremium]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!payment.enabled) return null;

  /** Poll until the charge resolves, then hand the entitlement over. */
  async function watch(id: number) {
    try {
      const settled = await waitForPayment(id, {
        // Manual review can take minutes — do not time out a payment the
        // owner has only just seen on their SMS.
        timeoutMs: manual ? 30 * 60 * 1000 : undefined,
        onTick: (next) => {
          if (alive.current) setCharge(next);
        },
      });
      if (!alive.current) return;
      if (settled.status === 'paid') {
        // The charge carries the entitlement the callback just granted.
        applyPremium(settled.premiumUntil ?? premiumUntil);
        setPhase('idle');
        setCharge(settled);
      } else {
        setError(settled.error ?? 'The payment did not go through — try again.');
        setPhase('error');
      }
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : 'Lost contact while waiting for the payment.');
      setPhase('error');
    }
  }

  /** Fire the prompt. The phone asks for its PIN the moment this returns. */
  async function pay() {
    if (busy) return;
    if (!account) return;
    if (!isValidPhone(phone)) {
      setError('Enter a valid Safaricom number, e.g. 0712 345 678.');
      setPhase('form');
      return;
    }
    setPhase('sending');
    setError(null);
    try {
      rememberPhone(phone);
      const opened = await createPaymentIntent(phone);
      if (!alive.current) return;
      setCharge(opened);
      setPhase('waiting');
      await watch(opened.id);
    } catch (err) {
      if (!alive.current) return;
      // Already premium (another tab, a previous session) — that is a success,
      // not a failure: the entitlement they came for is already running.
      if (err instanceof PaymentError && err.code === 'already-owned') {
        setError(null);
        setPhase('idle');
        return;
      }
      setError(err instanceof PaymentError ? err.message : 'The payment could not be started.');
      setPhase('error');
    }
  }

  const statusPill = active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2.5 py-1 text-xs font-semibold text-ok">
      ✓ Premium active
    </span>
  ) : charge?.status === 'pending' ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2.5 py-1 text-xs font-semibold text-warn">
      {manual ? '◔ Waiting for confirmation' : '◔ Waiting for your PIN'}
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
              : `${formatKes(payment.amount)} / ${payment.premiumDays} days · paid by M-PESA`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
        >
          {open ? 'Hide' : active ? 'Manage' : 'Pay with M-PESA'}
        </button>
      </div>

      {statusPill && <div className="mt-3">{statusPill}</div>}

      {open && (
        <div className="mt-4 space-y-4">
          {!account ? (
            <p className="text-xs leading-relaxed text-muted">
              Sign in above first — premium is tied to your account, so your access follows you to
              any device.
            </p>
          ) : (
            <>
              {/* ── The prompt ────────────────────────────────────────────── */}
              {phase === 'idle' && (
                <>
                  <div>
                    <label className="label" htmlFor="premium-phone">
                      {manual ? 'The M-PESA number you will pay from' : 'M-PESA number'}
                    </label>
                    <input
                      id="premium-phone"
                      className="field"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="0712 345 678"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                    />
                  </div>

                  {!commerce.mpesaReady && !manual ? (
                    <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
                      M-PESA is not accepting payments yet — the owner is still finishing the
                      Daraja setup.
                    </p>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted">
                      {manual
                        ? 'Send the exact amount from this number. The owner matches your SMS and confirms the charge manually — no prompt will appear on your phone.'
                        : 'Press pay and your phone prompts you for the M-PESA PIN. Premium switches on the moment you confirm.'}
                    </p>
                  )}

                  {payment.instructions && (
                    <p className="text-xs leading-relaxed text-muted">{payment.instructions}</p>
                  )}

                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    onClick={() => void pay()}
                    disabled={!commerce.mpesaReady && !manual}
                  >
                    {manual ? `I'll send ${formatKes(payment.amount)} — get instructions` : `Pay ${formatKes(payment.amount)}`}
                  </button>
                </>
              )}

              {phase === 'sending' && (
                <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-muted">
                  <SpinnerIcon className="h-4 w-4" />
                  {manual ? 'Opening your payment request…' : 'Sending the request to M-PESA…'}
                </div>
              )}

              {/* ── Waiting for the PIN (or the owner's OK) ───────────────── */}
              {phase === 'waiting' && manual && (
                <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4">
                  <p className="text-sm font-semibold text-ink">Send the money now</p>
                  <dl className="mt-2 space-y-1.5 text-xs text-ink">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Amount</dt>
                      <dd className="font-semibold tabular-nums">
                        {formatKes(charge?.amount ?? payment.amount)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Send to</dt>
                      <dd className="break-all text-right font-medium">
                        {destination || 'the number the owner gave you'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">From</dt>
                      <dd className="font-medium tabular-nums">{charge?.phone || phone}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Reference</dt>
                      <dd className="font-mono font-medium">MU{charge?.id}</dd>
                    </div>
                  </dl>
                  {manualInstructions && (
                    <p className="mt-2 rounded-lg bg-black/20 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                      {manualInstructions}
                    </p>
                  )}
                  <p className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                    <SpinnerIcon className="h-3 w-3" />
                    Waiting for the owner to confirm — usually a few minutes. Premium activates the
                    moment they approve it.
                  </p>
                </div>
              )}
              {phase === 'waiting' && !manual && (
                <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4">
                  <div className="flex items-center gap-3">
                    <SpinnerIcon className="h-3.5 w-3.5" />
                    <p className="text-sm font-semibold text-ink">Check your phone</p>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    An M-PESA prompt for {formatKes(charge?.amount ?? payment.amount)} was sent to{' '}
                    {charge?.phone || phone}. Enter your PIN to complete the payment.
                  </p>
                  <p className="mt-2 text-[11px] text-muted/70">
                    {charge?.mpesaRef ? `Receipt ${charge.mpesaRef} · ` : ''}
                    Do not close this screen until it confirms.
                  </p>
                </div>
              )}

              {charge?.status === 'paid' && (
                <p className="rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-xs leading-relaxed text-ok">
                  Paid — {formatKes(charge.amount)}
                  {charge.mpesaRef ? ` · receipt ${charge.mpesaRef}` : ''}. Premium is active until{' '}
                  {formatDate(premiumUntil)}.
                </p>
              )}

              {error && (
                <p className="text-xs leading-relaxed text-warn" role="alert">
                  {error}
                </p>
              )}

              {phase === 'error' && (
                <button
                  type="button"
                  className="btn btn-ghost w-full"
                  onClick={() => {
                    setError(null);
                    setPhase('idle');
                  }}
                >
                  Try again
                </button>
              )}

              {payment.supportContact && (
                <p className="text-[11px] leading-relaxed text-muted/70">
                  Trouble with a payment? Contact {payment.supportContact}.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

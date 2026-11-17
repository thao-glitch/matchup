/**
 * The M-PESA pay sheet — "put in your number, press Pay, your phone prompts
 * you, type your PIN". One component serves every paid thing on the platform
 * (a locked post, a room entry) because the money flow is identical.
 *
 * Daraja pushes the prompt immediately; the sheet waits on `waitForPayment()`,
 * which polls the charge until the callback settles it (usually 1–3 s after
 * the PIN lands). The only truth here is `charge.status` — the moment it
 * reads `paid`, `onPaid` unlocks the content.
 *
 * There is no paybill fallback: every payment is an STK push, so a missing
 * Daraja setup is a disabled Pay button with an explanation, not a second
 * way to pay that someone has to reconcile by hand.
 */
import { useEffect, useRef, useState } from 'react';
import type { AccountUser } from '../types';
import type { Charge, PayTarget } from '../types/social';
import type { PublicConfig } from '../lib/config';
import {
  SocialError,
  createCharge,
  isValidPhone,
  lastPhone,
  rememberPhone,
  waitForPayment,
  formatKes,
} from '../lib/social';

export interface PaySheetProps {
  target: PayTarget;
  config: PublicConfig;
  account: AccountUser | null;
  /** Opened while signed out — the page's sign-in card. */
  onRequireAuth?: () => void;
  /** Fired exactly once, when the charge reads `paid`. */
  onPaid: (charge: Charge) => void;
  onClose: () => void;
}

type Phase = 'form' | 'sending' | 'waiting' | 'error';

export default function PaySheet({
  target,
  config,
  account,
  onRequireAuth,
  onPaid,
  onClose,
}: PaySheetProps) {
  const [phase, setPhase] = useState<Phase>('form');
  const [phone, setPhone] = useState(() => lastPhone());
  const [error, setError] = useState<string | null>(null);
  const [charge, setCharge] = useState<Charge | null>(null);
  /** Guards against setting state after the sheet has been dismissed. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const manual = Boolean(config.commerce.manualPayments?.enabled);
  const destination = config.commerce.manualPayments?.destination ?? '';
  const manualInstructions = config.commerce.manualPayments?.instructions ?? '';
  const amount = Math.round(target.amount);
  /** Double-tapping Pay must not open two STK pushes. */
  const busy = phase === 'sending' || phase === 'waiting';

  /** Open the charge, then watch the STK prompt until it settles. */
  async function start() {
    if (busy) return;
    if (!account) {
      onRequireAuth?.();
      return;
    }
    if (!isValidPhone(phone)) {
      setError('Enter a valid Safaricom number, e.g. 0712 345 678.');
      setPhase('form');
      return;
    }
    setPhase('sending');
    setError(null);
    try {
      rememberPhone(phone);
      const opened = await createCharge({ purpose: target.purpose, refId: target.refId, phone });
      if (!alive.current) return;
      setCharge(opened.charge);
      setPhase('waiting');
      await watch(opened.charge.id);
    } catch (err) {
      if (!alive.current) return;
      const message =
        err instanceof SocialError ? err.message : 'The payment could not be started.';
      // Already paid for (another tab, a previous session) — treat as success.
      if (err instanceof SocialError && err.code === 'already-owned') {
        onPaid({
          id: 0,
          purpose: target.purpose,
          refId: target.refId,
          amount,
          currency: target.currency,
          commission: 0,
          net: amount,
          status: 'paid',
          phone,
          mpesaRef: null,
          checkoutRequestId: null,
          error: null,
          premiumDays: null,
          periodDays: target.periodDays ?? null,
          createdAt: new Date().toISOString(),
          paidAt: new Date().toISOString(),
        });
        return;
      }
      setError(message);
      setPhase('error');
    }
  }

  /** Poll until the charge resolves, then hand the content over. */
  async function watch(id: number) {
    try {
      const settled = await waitForPayment(id, {
        // Manual confirmation can take minutes (the owner sees the SMS and
        // approves in the dashboard) — the default 3-minute window would
        // time out every manual payment, so manual mode waits much longer.
        timeoutMs: manual ? 30 * 60 * 1000 : undefined,
        onTick: (next) => {
          if (alive.current) setCharge(next);
        },
      });
      if (!alive.current) return;
      if (settled.status === 'paid') {
        setPhase('waiting');
        onPaid(settled);
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

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Pay for ${target.title}`}
    >
      <div className="card w-full max-w-md p-6 animate-pop">
        {/* ── Header: what and how much ─────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">
              {target.purpose === 'room'
                ? 'Room entry'
                : target.purpose === 'sub'
                  ? 'Creator subscription'
                  : 'Unlock content'}
            </p>
            <h2 className="mt-1 text-base font-semibold leading-snug text-ink">
              {target.title || 'Paid content'}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost px-2.5 py-1.5 text-xs"
            onClick={onClose}
            disabled={false}
          >
            Close
          </button>
        </div>

        <div className="mt-4 flex items-baseline justify-between rounded-xl border border-white/10 bg-surface-3/60 px-4 py-3">
          <span className="text-sm text-muted">Amount</span>
          <span className="text-xl font-bold text-ink">
            {formatKes(amount)}{' '}
            <span className="text-xs font-medium text-muted">
              {target.purpose === 'sub' ? `for ${target.periodDays ?? 30} days` : 'one-off'}
            </span>
          </span>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
            {error}
          </p>
        )}

        {/* ── Form ──────────────────────────────────────────────────────── */}
        {phase === 'form' && (
          <>
            <label className="label mt-4" htmlFor="pay-phone">
              {manual ? 'The M-PESA number you will pay from' : 'M-PESA number'}
            </label>
            <input
              id="pay-phone"
              className="field"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0712 345 678"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {manual
                ? 'Send the exact amount from this number. The owner matches your SMS against the request and sets the charge — no prompt will appear on your phone.'
                : config.commerce.mpesaReady
                  ? 'Press Pay and your phone will prompt you — enter your M-PESA PIN to confirm.'
                  : 'M-PESA is not accepting payments right now — the owner is still finishing the setup.'}
            </p>
            {!account && (
              <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                Sign in first — payments are tied to your account.
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              onClick={() => void start()}
              disabled={!account || (!manual && !config.commerce.mpesaReady)}
            >
              {!account
                ? 'Sign in to pay'
                : manual
                  ? `Reserve ${formatKes(amount)} — I'll send it`
                  : `Pay ${formatKes(amount)}`}
            </button>
            {!account && onRequireAuth && (
              <button type="button" className="btn btn-ghost mt-2 w-full" onClick={onRequireAuth}>
                Sign in / create account
              </button>
            )}
          </>
        )}

        {/* ── Opening the request ───────────────────────────────────────── */}
        {phase === 'sending' && (
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-muted">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            Sending the request to M-PESA…
          </div>
        )}

        {/* ── Waiting for the PIN ───────────────────────────────────────── */}
        {phase === 'waiting' && manual && (
          <div className="mt-5 rounded-xl border border-accent/30 bg-accent/10 px-4 py-4">
            <p className="text-sm font-semibold text-ink">Send the money now</p>
            <dl className="mt-2 space-y-1.5 text-xs text-ink">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Amount</dt>
                <dd className="font-semibold tabular-nums">{formatKes(amount)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Send to</dt>
                <dd className="break-all text-right font-medium">{destination || 'the number the owner gave you'}</dd>
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
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              Waiting for the owner to confirm — usually a few minutes. This screen
              unlocks the moment they approve it.
            </p>
          </div>
        )}
        {phase === 'waiting' && !manual && (
          <div className="mt-5 rounded-xl border border-accent/30 bg-accent/10 px-4 py-4">
            <div className="flex items-center gap-3">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <p className="text-sm font-semibold text-ink">Check your phone</p>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              An M-PESA prompt for {formatKes(amount)} was sent to {charge?.phone || phone}. Enter
              your PIN to complete the payment.
            </p>
            <p className="mt-2 text-[11px] text-muted/70">
              {charge?.mpesaRef ? `Receipt ${charge.mpesaRef} · ` : ''}
              Do not close this screen until it confirms.
            </p>
          </div>
        )}

        {/* ── Error: try again ──────────────────────────────────────────── */}
        {phase === 'error' && (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-primary flex-1"
              onClick={() => {
                setError(null);
                setPhase('form');
              }}
            >
              Try again
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

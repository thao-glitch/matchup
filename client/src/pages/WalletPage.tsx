/**
 * Wallet — the creator's money: what is available, what came in, what was
 * paid out, and the M-PESA payout form.
 *
 * The balance semantics worth knowing: a payout *reserves* its amount the
 * moment it is requested (`balance >= amount` is part of the server's
 * UPDATE), so it shows up below as `pending` while the owner approves it
 * from `/admin` → Earnings — a rejection refunds the reservation. Signed out
 * this screen is a sign-in card, because the wallet endpoint is keyed by the
 * account.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Wallet, WalletEntry } from '../types/social';
import {
  SocialError,
  formatKes,
  getWallet,
  isValidPhone,
  lastPhone,
  netOf,
  timeAgo,
  withdraw,
} from '../lib/social';
import { Link } from '../lib/router';
import { PlusIcon, SpinnerIcon, WalletIcon } from '../components/icons';

/** Daraja moves whole shillings and the server enforces the same floor. */
/** 0 = Sunday … 6 = Saturday — shown to creators so they know when to expect money. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MIN_PAYOUT = 100;

const KIND_META: Record<WalletEntry['kind'], { label: string; className: string }> = {
  sale: { label: 'Sale', className: 'border-ok/40 bg-ok/10 text-ok' },
  adjustment: { label: 'Adjustment', className: 'border-warn/40 bg-warn/10 text-warn' },
  withdrawal: { label: 'Payout', className: 'border-accent/40 bg-accent/10 text-accent' },
};

const STATUS_META: Record<WalletEntry['status'], { label: string; className: string }> = {
  posted: { label: 'Posted', className: 'text-ok' },
  pending: { label: 'Pending', className: 'text-warn' },
  approved: { label: 'Approved', className: 'text-ok' },
  rejected: { label: 'Rejected', className: 'text-danger' },
};

export default function WalletPage({ account, config, requireAuth }: PageProps) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Refresh bumps this — one effect owns every reload of the statement. */
  const [nonce, setNonce] = useState(0);

  // Payout form
  const [phone, setPhone] = useState(() => lastPhone());
  const [amount, setAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  // Signed out owns the screen outright — no request is worth a 401.
  useEffect(() => {
    if (!account) {
      setWallet(null);
      setEntries([]);
      setLoading(false);
      return;
    }
    let dead = false;
    setLoading(true);
    setError(null);
    getWallet()
      .then((res) => {
        if (dead) return;
        setWallet(res.wallet);
        setEntries(res.entries);
      })
      .catch((err: unknown) => {
        if (dead) return;
        setError(
          err instanceof SocialError ? err.message : 'Your wallet is unavailable right now.',
        );
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [account, nonce]);

  const commissionRate = config.commerce.commissionRate;
  const payoutDay = WEEKDAY_NAMES[config.commerce.payouts?.dayOfWeek ?? 5] ?? 'Friday';
  const balance = wallet?.balance ?? 0;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (withdrawing) return; // one STK-adjacent request at a time
    setFormError(null);

    if (!isValidPhone(phone)) {
      setFormError('Enter a valid Safaricom number, e.g. 0712 345 678.');
      return;
    }
    const value = Math.round(Number(amount) || 0);
    if (value < MIN_PAYOUT) {
      setFormError(`The smallest payout is ${formatKes(MIN_PAYOUT)}.`);
      return;
    }
    if (value > balance) {
      setFormError('That is more than your available balance.');
      return;
    }

    setWithdrawing(true);
    setRequested(false);
    try {
      await withdraw({ phone, amount: value });
      if (!wallet) return;
      setAmount('');
      setRequested(true);
      setNonce((n) => n + 1); // the reservation is already on the statement
    } catch (err) {
      setFormError(
        err instanceof SocialError ? err.message : 'The payout could not be requested.',
      );
    } finally {
      setWithdrawing(false);
    }
  }

  // ── Signed out ───────────────────────────────────────────────────────────
  if (!account) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ok/15 text-ok">
            <WalletIcon className="h-6 w-6" />
          </span>
          <h1 className="mt-3 text-lg font-semibold text-ink">Your wallet</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Post something people pay for and it lands here: the platform keeps{' '}
            {commissionRate}% of every sale, you keep the rest, and you cash out to M-PESA
            whenever you like.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-5 w-full"
            onClick={() => requireAuth('Sign in to see your wallet.')}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  if (loading && !wallet) {
    return (
      <div className="card flex items-center gap-2.5 px-4 py-6 text-sm text-muted">
        <SpinnerIcon className="h-4 w-4 text-accent" />
        Loading your wallet…
      </div>
    );
  }

  if (error && !wallet) {
    return (
      <div className="card flex flex-wrap items-center gap-3 border-danger/30 px-4 py-4">
        <p className="min-w-0 flex-1 text-sm leading-relaxed text-danger">{error}</p>
        <button
          type="button"
          className="btn btn-ghost px-3 py-1.5 text-xs"
          onClick={() => setNonce((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  const split = netOf(100, commissionRate);

  return (
    <div className="space-y-5">
      {/* ── Balance ──────────────────────────────────────────────────────── */}
      <section className="card relative overflow-hidden p-5 sm:p-6">
        <div
          className="pointer-events-none absolute -right-14 -top-16 h-48 w-48 rounded-full bg-ok/15 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="label">Available balance</p>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums text-ink">
            {formatKes(balance)}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-surface-3/50 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-muted">Lifetime earned</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-ok">
                {formatKes(wallet?.lifetimeIn ?? 0)}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-surface-3/50 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-muted">Paid out</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
                {formatKes(wallet?.lifetimeOut ?? 0)}
              </p>
            </div>
          </div>

          <p className="mt-4 rounded-xl border border-white/10 bg-surface-3/40 px-3 py-2.5 text-xs leading-relaxed text-muted">
            The platform keeps <span className="font-semibold text-warn">{commissionRate}%</span>{' '}
            of every sale — of KES 100 paid for your content,{' '}
            <span className="font-semibold text-ink">{formatKes(split.net)}</span> reaches this
            wallet.
          </p>
        </div>
      </section>

      {error && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          {error}
        </p>
      )}

      {/* ── Withdraw ─────────────────────────────────────────────────────── */}
      <section className="card p-5">
        <h2 className="text-base font-semibold text-ink">Withdraw to M-PESA</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Payouts are sent once a week, every {payoutDay}. The owner confirms every request from
          the dashboard — request it any time and it is paid on the next payout day.
        </p>

        {requested && (
          <p
            className="mt-4 flex items-start gap-2 rounded-xl border border-ok/30 bg-ok/10 px-3 py-2.5 text-xs leading-relaxed text-ok"
            role="status"
          >
            Payout requested — the owner will send it on {payoutDay}.
          </p>
        )}
        {formError && (
          <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-relaxed text-danger">
            {formError}
          </p>
        )}

        <form onSubmit={(event) => void submit(event)}>
          <label className="label mt-4" htmlFor="withdraw-phone">
            M-PESA number
          </label>
          <input
            id="withdraw-phone"
            className="field"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0712 345 678"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />

          <label className="label mt-4" htmlFor="withdraw-amount">
            Amount (KES)
          </label>
          <input
            id="withdraw-amount"
            className="field"
            type="number"
            inputMode="numeric"
            min={MIN_PAYOUT}
            max={balance}
            placeholder={String(MIN_PAYOUT)}
            value={amount}
            onChange={(event) => {
              setRequested(false);
              setFormError(null);
              setAmount(event.target.value);
            }}
          />
          <p className="mt-1.5 text-[11px] text-muted">
            Available: {formatKes(balance)} · smallest payout {formatKes(MIN_PAYOUT)}
          </p>

          <button
            type="submit"
            className="btn btn-primary mt-4 w-full"
            disabled={withdrawing || balance < MIN_PAYOUT}
          >
            {withdrawing ? (
              <>
                <SpinnerIcon className="h-4 w-4" />
                Requesting…
              </>
            ) : balance < MIN_PAYOUT ? (
              `Earn at least ${formatKes(MIN_PAYOUT)} to cash out`
            ) : (
              'Withdraw'
            )}
          </button>
        </form>
      </section>

      {/* ── Transactions ─────────────────────────────────────────────────── */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <h2 className="text-base font-semibold text-ink">Transactions</h2>
          <span className="text-xs text-muted">{entries.length} total</span>
        </div>

        {entries.length === 0 ? (
          <p className="border-t border-white/10 px-5 py-6 text-sm text-muted">
            No transactions yet — your first sale will show up here.
          </p>
        ) : (
          <ul className="border-t border-white/10">
            {entries.map((entry) => {
              const kind = KIND_META[entry.kind];
              const status = STATUS_META[entry.status];
              const positive = entry.amount >= 0;
              return (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 border-t border-white/10 px-5 py-3 first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${kind.className}`}
                      >
                        {kind.label}
                      </span>
                      <span className={`text-[11px] font-semibold ${status.className}`}>
                        {status.label}
                      </span>
                      <span className="text-[11px] text-muted">{timeAgo(entry.createdAt)}</span>
                    </div>
                    {entry.memo && (
                      <p className="mt-1 truncate text-xs text-muted">{entry.memo}</p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-sm font-bold tabular-nums ${
                      positive ? 'text-ok' : 'text-ink'
                    }`}
                  >
                    {positive ? '+' : ''}
                    {formatKes(entry.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Quick action ─────────────────────────────────────────────────── */}
      <Link
        to="/create"
        className="card flex items-center gap-3 p-4 transition-colors hover:border-accent/40"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <PlusIcon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">Post something to earn</span>
          <span className="block truncate text-xs text-muted">
            Set a price and every sale credits this wallet
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * Authenticate — the owner's live payment desk for manual review mode.
 *
 * Built for one specific job: the owner keeps this tab open, reads each
 * M-PESA SMS as it lands, matches it against the pending row on screen
 * (number + amount + what the buyer is buying), and taps Approve or
 * Reject. The buyer's screen polls and flips open the moment the owner
 * approves — no reload, no bounce.
 *
 * Decisions this tab makes on the owner's behalf, deliberately:
 *   • it polls every 2 s (readLimiter is 300/min, so 30/min is polite — the
 *      point is a payment appearing *while the owner watches*, not during
 *      three refreshes a minute);
 *   • rows highlight as they age (amber ≥ 5 min, red ≥ 10 min) so no SMS
 *      ever sits unread under the fold;
 *   • Approve is a single tap — the SMS is the source of truth. Reject
 *      requires a confirmation step (it permanently locks the buyer out);
 *   • sound is OFF by default — labels must not surprise people who share
 *      screens, but it's one tap to enable.
 *
 * Charges this screen shows are manual-mode charges only when there's no
 * Daraja; every STK-originated charge skips straight to settled and lands in
 * the Earnings ledger instead. This tab is the human settlement lane.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  errorMessage,
  formatKes,
  formatDateTime,
  request,
  timeAgo,
  type AdminCharge,
  type Paged,
} from './api';
import { ErrorBanner, Loading, Panel, Pill } from './ui';

/** Refresh cadence — the point is to see the SMS row while the owner reads it. */
const POLL_MS = 2_000;
/** Above this age (sec) a pending row turns amber; above the next it turns red. */
const AMBER_AT_MS = 5 * 60_000;
const RED_AT_MS = 10 * 60_000;

const PURPOSE_LABEL: Record<AdminCharge['purpose'], string> = {
  post: 'Post',
  room: 'Room',
  premium: 'Premium',
  sub: 'Subscription',
};

function ageMs(row: AdminCharge): number {
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? Date.now() - t : 0;
}

function toneOf(row: AdminCharge): 'ok' | 'warn' | 'danger' {
  const ms = ageMs(row);
  if (ms >= RED_AT_MS) return 'danger';
  if (ms >= AMBER_AT_MS) return 'warn';
  return 'ok';
}

export default function AuthenticateTab() {
  const [pending, setPending] = useState<AdminCharge[]>([]);
  const [recentlyPaid, setRecentlyPaid] = useState<AdminCharge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [sound, setSound] = useState(false);
  /** Ids that were pending at some point — used to detect *new* arrivals. */
  const known = useRef<Set<number>>(new Set());
  const audioRef = useRef<AudioContext | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      try {
        const [pendingRes, paidRes] = await Promise.all([
          request<Paged<AdminCharge>>(
            `/charges?status=pending&page=1&size=50`,
            { signal: controller.signal },
          ),
          request<Paged<AdminCharge>>(
            `/charges?status=paid&page=1&size=10`,
            { signal: controller.signal },
          ),
        ]);
        if (disposed) return;
        setPending(pendingRes.items);
        setRecentlyPaid(paidRes.items);
        setError(null);
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [reload]);

  // A new charge arrived while the tab was open — nudge the owner once per id.
  useEffect(() => {
    if (!sound) return;
    for (const charge of pending) {
      if (known.current.has(charge.id)) continue;
      known.current.add(charge.id);
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      try {
        audioRef.current ??= new AudioCtx();
        const ctx = audioRef.current;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.36);
      } catch {
        /* ignore — sound is a nicety, not an obligation */
      }
    }
  }, [pending, sound]);

  const pendingCount = pending.length;
  const newestAge = useMemo(
    () => (pending.length ? Math.min(...pending.map(ageMs)) : null),
    [pending],
  );

  async function decide(id: number, status: 'paid' | 'failed') {
    setBusyId(id);
    setError(null);
    try {
      await request(`/charges/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note: 'SMS seen', mpesaRef: undefined }),
      });
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">
            Authenticate payments <span className="tabular-nums text-accent">· {pendingCount}</span>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Buyers send money by M-PESA; you match the SMS <span className="whitespace-nowrap">number → amount → purpose</span>{' '}
            and approve. Approval unlocks the paid content instantly on the buyer's screen.
          </p>
        </div>
        <button
          type="button"
          className={`btn shrink-0 px-3 py-1.5 text-xs ${sound ? 'btn-primary' : 'btn-ghost'}`}
          aria-pressed={sound}
          onClick={() => setSound((v) => !v)}
        >
          {sound ? 'Sound on' : 'Sound off'}
        </button>
      </header>

      {loading ? (
        <Loading what="pending payments" />
      ) : pending.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ok/10">
            <span className="h-4 w-4 animate-ping rounded-full border-2 border-ok" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-ink">Listening for payments</h3>
          <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted">
            {newestAge === null
              ? 'Nothing waiting on you. Keep this tab open — new charges float to the top here the moment M-PESA lands.'
              : `Everything is done. Next payment will appear here — last seen ${timeAgo(newestAge ?? 0)}.`}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {pending.map((charge) => {
            const age = ageMs(charge);
            const tone = toneOf(charge);
            return (
              <article
                key={charge.id}
                className="card overflow-hidden"
                aria-live="polite"
              >
                <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[1fr_auto] sm:gap-6">
                  {/* ── Left: who and what ─────────────────────────────────── */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'danger'}>
                        {PURPOSE_LABEL[charge.purpose]}
                      </Pill>
                      <span className="text-[11px] tabular-nums text-muted">
                        #{charge.id} · {formatDateTime(charge.createdAt)}
                      </span>
                      {age > RED_AT_MS && (
                        <span className="text-[11px] font-semibold text-danger">⚠ over 10 min</span>
                      )}
                      {age > AMBER_AT_MS && age <= RED_AT_MS && (
                        <span className="text-[11px] font-semibold text-warn">5+ min</span>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <p className="text-2xl font-black tabular-nums text-ink">
                        {formatKes(charge.amount)}
                      </p>
                      <p className="break-all font-mono text-lg font-bold text-ink">
                        {charge.phone}
                      </p>
                    </div>

                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      <span className="font-semibold text-ink">@{charge.buyerUsername}</span> →{' '}
                      <span className="font-semibold text-ink">@{charge.payeeUsername}</span>
                      {charge.refId > 0 && (
                        <>
                          {' · '}unlock #{charge.refId}
                        </>
                      )}
                      {' · '}platform keeps {formatKes(charge.commission)}, creator nets{' '}
                      {formatKes(charge.net)}
                    </p>
                  </div>

                  {/* ── Right: the decision ──────────────────────────────── */}
                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      className="btn btn-primary w-full sm:w-auto"
                      disabled={busyId === charge.id}
                      onClick={() => void decide(charge.id, 'paid')}
                    >
                      {busyId === charge.id ? 'Approving…' : 'Approve — unlock access'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost w-full sm:w-auto"
                      disabled={busyId === charge.id}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Reject ${formatKes(charge.amount)} from ${charge.phone}? The buyer stays locked. This cannot be undone.`,
                          )
                        )
                          void decide(charge.id, 'failed');
                      }}
                    >
                      Reject — keep locked
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Panel
        title="Recently authenticated"
        hint="The last 10 approvals — a receipt for your confidence check, straight off the live ledger."
      >
        {recentlyPaid.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nothing approved yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">When</th>
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Paid</th>
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Number</th>
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Buyer</th>
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">What</th>
                  <th className="py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentlyPaid.map((charge) => (
                  <tr key={charge.id} className="border-b border-white/5 last:border-0">
                    <td className="py-2 pr-3 text-muted">{charge.paidAt ? timeAgo(charge.paidAt) : '—'}</td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-ink">
                      {charge.mpesaRef ?? <span className="text-muted">—</span>}
                    </td>
                    <td className="break-all py-2 pr-3 font-mono text-[11px] text-ink">{charge.phone}</td>
                    <td className="py-2 pr-3 font-semibold text-ink">@{charge.buyerUsername}</td>
                    <td className="py-2 pr-3 text-muted">{PURPOSE_LABEL[charge.purpose]} #{charge.refId}</td>
                    <td className="py-2 pr-3 tabular-nums text-ink">{formatKes(charge.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

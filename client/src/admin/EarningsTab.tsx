/**
 * Earnings — the money screen for the social platform.
 *
 * It answers, in order, the four questions an owner has after a day of
 * sales: how much came in, how much the house kept, what creators are owed,
 * and which payouts still need a click. The layout follows that order:
 * summary cards → the daily gross/commission series → the three queues that
 * need action (charges, payout requests, wallet balances).
 *
 * All four sections refetch off ONE `reload` counter: a mutation in one
 * section (approving a charge, say) moves numbers in the others too —
 * the summary, the ledger and the creator's wallet all change server-side,
 * so re-reading everything is both simpler and safer than patching rows.
 */
import { Fragment, useEffect, useState } from 'react';
import {
  errorMessage,
  formatDateTime,
  formatKes,
  request,
  timeAgo,
  type AdminCharge,
  type EarningsData,
  type Paged,
  type WalletEntryRow,
  type WalletRow,
} from './api';
import { ErrorBanner, Loading, Panel, Pill, Stat, TD, TH } from './ui';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 300;
const EARNINGS_DAYS = 30;

/** Empty string = every value (the server treats it as "no filter"). */
type AnyStatus = '' | 'pending' | 'paid' | 'failed' | 'expired';
type PurposeFilter = '' | 'premium' | 'post' | 'room' | 'sub';

const CHARGE_STATUSES: { id: AnyStatus; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'paid', label: 'Paid' },
  { id: 'failed', label: 'Failed' },
  { id: 'expired', label: 'Expired' },
];

const PURPOSES: { id: PurposeFilter; label: string }[] = [
  { id: '', label: 'Any purpose' },
  { id: 'premium', label: 'Premium' },
  { id: 'post', label: 'Posts' },
  { id: 'room', label: 'Rooms' },
  { id: 'sub', label: 'Subscriptions' },
];

interface LedgerParams {
  q: string;
  status: AnyStatus;
  purpose: PurposeFilter;
  page: number;
}

export default function EarningsTab() {
  const [summary, setSummary] = useState<EarningsData | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  /** Shared refresh trigger — every mutation bumps it, every section listens. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoadingSummary(true);
      try {
        const next = await request<EarningsData>(`/earnings?days=${EARNINGS_DAYS}`, {
          signal: controller.signal,
        });
        if (!disposed) {
          setSummary(next);
          setSummaryError(null);
        }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setSummaryError(errorMessage(err));
      } finally {
        if (!disposed) setLoadingSummary(false);
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [reload]);

  return (
    <div className="space-y-4">
      <ErrorBanner message={summaryError} onDismiss={() => setSummaryError(null)} />

      {summary && !loadingSummary ? (
        <SummaryCards data={summary} />
      ) : loadingSummary ? (
        <Loading what="earnings" />
      ) : null}

      {summary && <EarningsChart byDay={summary.byDay} />}

      <ChargesLedger onMutated={() => setReload((n) => n + 1)} />

      <PayoutRequests onMutated={() => setReload((n) => n + 1)} />

      <WalletsPanel onMutated={() => setReload((n) => n + 1)} />
    </div>
  );
}

// ── Summary + chart ──────────────────────────────────────────────────────────

function SummaryCards({ data }: { data: EarningsData }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel title="Collected" hint={`${data.count} settled charges · last ${EARNINGS_DAYS} days`}>
        {/* 2 columns under `sm`: "Ksh 1,250,000" overflows a 4-up cell on a
            phone — the same reason Overview's payment panel does it. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Gross collected" value={formatKes(data.gross)} />
          <Stat label="Commission / tax kept" value={formatKes(data.commission)} tone="accent" hint={`${data.paid} paid`} />
          <Stat label="Paid to creators" value={formatKes(data.net)} tone="ok" hint="credited to wallets" />
        </div>
      </Panel>

      <Panel title="Wallets" hint={`${data.wallets.wallets} wallets · ${data.wallets.pendingPayouts} payout requests waiting`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label="Pending payouts"
            value={`${data.wallets.pendingPayouts}`}
            tone={data.wallets.pendingPayouts > 0 ? 'warn' : undefined}
            hint={formatKes(data.wallets.pendingAmount)}
          />
          <Stat label="Held in wallets" value={formatKes(data.wallets.held)} hint="owed to creators" />
          <Stat label="Paid out lifetime" value={formatKes(data.wallets.paidOut)} />
        </div>
      </Panel>

      <Panel className="md:col-span-2" title={`Charge outcomes · last ${EARNINGS_DAYS} days`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Paid" value={data.paid} tone="ok" />
          <Stat label="Pending" value={data.pending} tone={data.pending > 0 ? 'warn' : undefined} hint="manual approval" />
          <Stat label="Failed" value={data.failed} tone={data.failed > 0 ? 'danger' : undefined} />
          <Stat label="Expired" value={data.expired} hint="STK push timed out" />
        </div>
      </Panel>
    </div>
  );
}

/**
 * 30-day gross vs commission bars — the same plain-divs-in-percent technique
 * as the Overview charts (no chart library; prints, copies and themes itself).
 * Zero-fills gaps anchored on the server's own day keys, because the admin's
 * browser timezone need not match the server's grouping.
 */
function EarningsChart({ byDay }: { byDay: EarningsData['byDay'] }) {
  const days = chartDays(byDay, EARNINGS_DAYS);
  const total = byDay.reduce((sum, day) => sum + day.gross, 0);

  if (days.every((day) => day.gross === 0)) {
    return (
      <Panel title="Daily gross vs commission" hint={`Last ${EARNINGS_DAYS} days`}>
        <p className="py-6 text-center text-xs text-muted">No paid charges yet.</p>
      </Panel>
    );
  }

  const max = Math.max(1, ...days.map((day) => day.gross));
  return (
    <Panel title="Daily gross vs commission" hint={`Last ${EARNINGS_DAYS} days · ${formatKes(total)} gross`}>
      <div className="flex h-28 items-end gap-[3px]">
        {days.map((day) => {
          // The commission bar is drawn inside the same 100%-scaled column,
          // so the house cut is always visibly a slice of that day's gross.
          const grossHeight = day.gross > 0 ? Math.max(6, (day.gross / max) * 100) : 2;
          const commissionHeight = day.gross > 0 ? (day.commission / day.gross) * grossHeight : 0;
          return (
            <div
              key={day.day}
              className="relative min-w-0 flex-1 rounded-t-sm bg-ok/50 transition-colors hover:bg-ok/70"
              style={{ height: `${grossHeight}%` }}
              title={`${day.day}: gross ${formatKes(day.gross)} · commission ${formatKes(day.commission)}`}
            >
              <div
                className="absolute inset-x-0 bottom-0 rounded-b-sm bg-accent/80"
                style={{ height: `${commissionHeight}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted">
        <span>{shortDay(days[0].day)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-ok/50" /> gross
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-accent/80" /> commission
          </span>
        </span>
        <span>{shortDay(days[days.length - 1].day)}</span>
      </div>
    </Panel>
  );
}

// ── Payments ledger ──────────────────────────────────────────────────────────

function ChargesLedger({ onMutated }: { onMutated: () => void }) {
  /** Raw search input — per keystroke, no request attached. */
  const [query, setQuery] = useState('');
  const [params, setParams] = useState<LedgerParams>({ q: '', status: '', purpose: '', page: 1 });
  const [data, setData] = useState<Paged<AdminCharge> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Local refresh trigger so the ledger reloads after its own mutations
   *  without re-mounting every other section. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const next = query.trim();
    const timer = window.setTimeout(() => {
      setParams((prev) => (prev.q === next ? prev : { ...prev, q: next, page: 1 }));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      const search = new URLSearchParams({
        status: params.status,
        purpose: params.purpose,
        q: params.q,
        page: String(params.page),
        size: String(PAGE_SIZE),
      });
      try {
        const next = await request<Paged<AdminCharge>>(`/charges?${search}`, { signal: controller.signal });
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [params, reload]);

  async function decide(charge: AdminCharge, body: Record<string, unknown>) {
    setBusyId(charge.id);
    setError(null);
    try {
      await request(`/charges/${charge.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setReload((n) => n + 1);
      // Approving settles the creator's wallet server-side — the summary
      // cards must reflect that too, not just this table.
      onMutated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function approve(charge: AdminCharge) {
    const confirmed = window.confirm(
      `Mark charge #${charge.id} (${formatKes(charge.amount)} for ${charge.purpose} #${charge.refId}) as PAID?\n\n` +
        `This credits ${formatKes(charge.net)} to @${charge.payeeUsername}'s wallet and records the platform ` +
        `commission of ${formatKes(charge.commission)}. Only do this when the money is visibly on the statement.`,
    );
    if (!confirmed) return;
    void decide(charge, { status: 'paid' });
  }

  function reject(charge: AdminCharge) {
    // The note lands on the charge (and in the audit trail) — `prompt`'s
    // cancel is a natural "no, I changed my mind", so one dialog suffices.
    const note = window.prompt(`Reject charge #${charge.id} — reason (optional, kept on the record):`);
    if (note === null) return;
    const trimmed = note.trim();
    void decide(charge, trimmed ? { status: 'failed', note: trimmed } : { status: 'failed' });
  }

  const total = data?.total ?? 0;
  const size = data?.size ?? PAGE_SIZE;
  const page = params.page;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const range = total === 0 ? '0 of 0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`;

  return (
    <Panel
      title="Payments ledger"
      hint={
        <>
          Every payment on the platform — post purchases, room entry and premium. With STK mode the
          Daraja callback settles these automatically (the button below is only for a callback
          that never arrived); in Manual review mode every pending charge waits for your manual
          approval — the buyer's phone number, amount and purpose are shown so you can match the
          SMS.
        </>
      }
    >
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="field sm:max-w-xs"
          type="search"
          placeholder="Search @username, phone or M-PESA ref…"
          aria-label="Search charges"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="field sm:w-36"
          aria-label="Filter charges by status"
          value={params.status}
          onChange={(event) =>
            setParams((prev) => ({ ...prev, status: event.target.value as AnyStatus, page: 1 }))
          }
        >
          {CHARGE_STATUSES.map((item) => (
            <option key={item.id || 'all'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          className="field sm:w-40"
          aria-label="Filter charges by purpose"
          value={params.purpose}
          onChange={(event) =>
            setParams((prev) => ({ ...prev, purpose: event.target.value as PurposeFilter, page: 1 }))
          }
        >
          {PURPOSES.map((item) => (
            <option key={item.id || 'any'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted sm:ml-auto" aria-live="polite">
          {loading ? 'Loading…' : range}
        </p>
      </div>

      {data && total > 0 ? (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            <table className="w-full min-w-[1120px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>ID</th>
                  <th className={TH}>What</th>
                  <th className={TH}>Buyer → payee</th>
                  <th className={TH}>Phone</th>
                  <th className={TH}>Amount</th>
                  <th className={TH}>Commission</th>
                  <th className={TH}>Net</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>M-PESA receipt</th>
                  <th className={TH}>Created / paid</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((charge) => (
                  <tr key={charge.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/5">
                    <td className={`${TD} tabular-nums text-muted`}>{charge.id}</td>
                    <td className={TD}>
                      <Pill tone={charge.purpose === 'room' ? 'accent' : 'muted'}>{charge.purpose}</Pill>
                      <span className="ml-1.5 text-xs text-muted">#{charge.refId}</span>
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <span className="font-semibold text-ink">@{charge.buyerUsername}</span>
                      <span className="px-1 text-muted">→</span>
                      <span className="font-semibold text-ink">@{charge.payeeUsername}</span>
                    </td>
                    <td className={`${TD} whitespace-nowrap font-mono text-xs`}>{charge.phone}</td>
                    <td className={`${TD} whitespace-nowrap tabular-nums font-semibold`}>{formatKes(charge.amount)}</td>
                    <td className={`${TD} whitespace-nowrap tabular-nums text-accent`}>{formatKes(charge.commission)}</td>
                    <td className={`${TD} whitespace-nowrap tabular-nums text-ok`}>{formatKes(charge.net)}</td>
                    <td className={TD}>
                      <Pill tone={chargeTone(charge.status)}>{charge.status}</Pill>
                      {charge.error && <span className="mt-1 block max-w-[160px] truncate text-[11px] text-danger" title={charge.error}>{charge.error}</span>}
                      {charge.note && <span className="mt-1 block max-w-[160px] truncate text-[11px] italic text-muted" title={charge.note}>{charge.note}</span>}
                    </td>
                    <td className={`${TD} whitespace-nowrap font-mono text-xs`}>
                      {charge.mpesaRef ?? <span className="text-muted">—</span>}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>
                      {formatDateTime(charge.createdAt)}
                      {charge.paidAt && <span className="block text-[11px]">paid {formatDateTime(charge.paidAt)}</span>}
                    </td>
                    <td className={TD}>
                      {charge.status === 'pending' ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            className="btn btn-primary px-2.5 py-1.5 text-xs"
                            disabled={busyId === charge.id}
                            onClick={() => approve(charge)}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger px-2.5 py-1.5 text-xs"
                            disabled={busyId === charge.id}
                            onClick={() => reject(charge)}
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-muted">
                          {timeAgo(charge.paidAt ?? charge.createdAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">{range}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page <= 1 || loading}
                onClick={() => setParams((prev) => ({ ...prev, page: prev.page - 1 }))}
              >
                Prev
              </button>
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page >= totalPages || loading}
                onClick={() => setParams((prev) => ({ ...prev, page: prev.page + 1 }))}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : loading ? (
        <Loading what="charges" />
      ) : (
        <p className="py-8 text-center text-sm text-muted">No charges match this filter.</p>
      )}
    </Panel>
  );
}

// ── Payout requests ──────────────────────────────────────────────────────────

function PayoutRequests({ onMutated }: { onMutated: () => void }) {
  const [data, setData] = useState<Paged<WalletEntryRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      const search = new URLSearchParams({ status: 'pending', page: '1', size: String(PAGE_SIZE) });
      try {
        const next = await request<Paged<WalletEntryRow>>(`/wallet-entries?${search}`, {
          signal: controller.signal,
        });
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [reload]);

  async function decide(entry: WalletEntryRow, status: 'approved' | 'rejected') {
    setBusyId(entry.id);
    setError(null);
    try {
      await request(`/wallet-entries/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setReload((n) => n + 1);
      onMutated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function act(entry: WalletEntryRow, status: 'approved' | 'rejected') {
    const verb = status === 'approved' ? 'Approve' : 'Reject';
    const effect =
      status === 'approved'
        ? `marks the ${formatKes(entry.amount)} withdrawal as paid out`
        : 'cancels the request and returns the reserved amount to the creator’s wallet';
    const confirmed = window.confirm(
      `${verb} payout #${entry.id} — ${formatKes(entry.amount)} for @${entry.username}?\n\nThis ${effect}.`,
    );
    if (!confirmed) return;
    void decide(entry, status);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <Panel title="Payout requests" hint="Withdrawals reserved from creator wallets — approve after the M-PESA send lands, reject to refund.">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {loading ? (
        <Loading what="payout requests" />
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No pending payout requests.</p>
      ) : (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>Creator</th>
                  <th className={TH}>Amount</th>
                  <th className={TH}>Memo</th>
                  <th className={TH}>Requested</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/5">
                    <td className={TD}>
                      <span className="font-semibold text-ink">@{entry.username}</span>
                      <span className="block text-[11px] text-muted">#{entry.accountId} · entry #{entry.id}</span>
                    </td>
                    <td className={`${TD} whitespace-nowrap tabular-nums font-semibold text-ink`}>
                      {formatKes(entry.amount)}
                    </td>
                    {/* The creator's withdrawal memo carries the destination
                        phone number — the only place it is visible to the owner. */}
                    <td className={`${TD} text-xs text-muted`}>{entry.memo ?? '—'}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`} title={formatDateTime(entry.createdAt)}>
                      {timeAgo(entry.createdAt)}
                    </td>
                    <td className={TD}>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          className="btn btn-primary px-2.5 py-1.5 text-xs"
                          disabled={busyId === entry.id}
                          onClick={() => act(entry, 'approved')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger px-2.5 py-1.5 text-xs"
                          disabled={busyId === entry.id}
                          onClick={() => act(entry, 'rejected')}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <p className="mt-3 text-right text-[11px] text-muted">
              Showing the first {items.length} of {total} — older requests are already decided.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

// ── Wallets ──────────────────────────────────────────────────────────────────

function WalletsPanel({ onMutated }: { onMutated: () => void }) {
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<WalletRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** Wallet whose adjust form is open — only one at a time, inline. */
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustMemo, setAdjustMemo] = useState('');
  const [adjustBusy, setAdjustBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ((prev) => (prev === query.trim() ? prev : query.trim()));
      setPage(1);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      const search = new URLSearchParams({ q, page: String(page), size: String(PAGE_SIZE) });
      try {
        const next = await request<Paged<WalletRow>>(`/wallets?${search}`, { signal: controller.signal });
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [q, page, reload]);

  async function adjust(wallet: WalletRow) {
    const amount = Number(adjustAmount);
    // Validate here only to skip a pointless round-trip; the server is the
    // authority (it refuses debits above the balance) and its message wins.
    if (!Number.isFinite(amount) || amount === 0) {
      setError('Adjustment must be a non-zero number — positive credits, negative debits.');
      return;
    }
    setAdjustBusy(true);
    setError(null);
    try {
      await request('/wallets/adjust', {
        method: 'POST',
        body: JSON.stringify({ accountId: wallet.accountId, amount, memo: adjustMemo.trim() }),
      });
      setAdjusting(null);
      setAdjustAmount('');
      setAdjustMemo('');
      setReload((n) => n + 1);
      onMutated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdjustBusy(false);
    }
  }

  const total = data?.total ?? 0;
  const size = data?.size ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / size));

  return (
    <Panel title="Wallets" hint="Creator balances. Adjust with a signed amount: positive credits, negative debits (memo kept in the ledger).">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="field sm:max-w-xs"
          type="search"
          placeholder="Search by @username…"
          aria-label="Search wallets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="text-xs text-muted sm:ml-auto" aria-live="polite">
          {loading
            ? 'Loading…'
            : total === 0
              ? '0 of 0'
              : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total} wallets`}
        </p>
      </div>

      {data && total > 0 ? (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>Creator</th>
                  <th className={TH}>Balance</th>
                  <th className={TH}>Lifetime in</th>
                  <th className={TH}>Lifetime out</th>
                  <th className={TH}>Updated</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((wallet) => (
                  <Fragment key={wallet.accountId}>
                    <tr className="border-b border-white/5 transition-colors hover:bg-white/5">
                      <td className={TD}>
                        <span className="font-semibold text-ink">@{wallet.username}</span>
                        <span className="block text-[11px] text-muted">#{wallet.accountId}</span>
                      </td>
                      <td className={`${TD} whitespace-nowrap tabular-nums font-semibold text-ink`}>
                        {formatKes(wallet.balance)}
                      </td>
                      <td className={`${TD} whitespace-nowrap tabular-nums text-ok`}>{formatKes(wallet.lifetimeIn)}</td>
                      <td className={`${TD} whitespace-nowrap tabular-nums text-muted`}>{formatKes(wallet.lifetimeOut)}</td>
                      <td className={`${TD} whitespace-nowrap text-muted`}>{timeAgo(wallet.updatedAt)}</td>
                      <td className={TD}>
                        <div className="flex items-center justify-end">
                          <button
                            type="button"
                            className="btn btn-ghost px-2.5 py-1.5 text-xs"
                            disabled={adjustBusy}
                            onClick={() => {
                              // Toggling closes the form and forgets its draft.
                              setAdjusting((prev) => (prev === wallet.accountId ? null : wallet.accountId));
                              setAdjustAmount('');
                              setAdjustMemo('');
                            }}
                          >
                            {adjusting === wallet.accountId ? 'Cancel' : 'Adjust'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {adjusting === wallet.accountId && (
                      <tr className="bg-white/5">
                        <td className={`${TD} text-xs text-muted`} colSpan={6}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <div className="sm:w-40">
                              <span className="label">Amount (±KES)</span>
                              <input
                                className="field py-2"
                                type="number"
                                step="any"
                                placeholder="e.g. 500 or -200"
                                value={adjustAmount}
                                onChange={(event) => setAdjustAmount(event.target.value)}
                                disabled={adjustBusy}
                              />
                            </div>
                            <div className="flex-1">
                              <span className="label">Memo</span>
                              <input
                                className="field py-2"
                                placeholder="Why — goodwill, correction, fee refund…"
                                value={adjustMemo}
                                onChange={(event) => setAdjustMemo(event.target.value)}
                                disabled={adjustBusy}
                              />
                            </div>
                            <button
                              type="button"
                              className="btn btn-primary px-4 py-2 text-sm"
                              disabled={adjustBusy || !adjustAmount}
                              onClick={() => void adjust(wallet)}
                            >
                              {adjustBusy ? 'Saving…' : 'Post adjustment'}
                            </button>
                          </div>
                          <p className="mt-1.5 text-[11px] text-muted">
                            A debit larger than {formatKes(wallet.balance)} will be refused by the server.
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {total === 0 ? '0 of 0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : loading ? (
        <Loading what="wallets" />
      ) : (
        <p className="py-8 text-center text-sm text-muted">No wallets match this search.</p>
      )}
    </Panel>
  );
}

// ── Chart + tone helpers ─────────────────────────────────────────────────────

/** Zero-fill the window around the newest server day, like Overview does —
 *  anchored on the server's day keys, not the browser clock. */
function chartDays(byDay: EarningsData['byDay'], span: number): EarningsData['byDay'] {
  const map = new Map(byDay.map((d) => [d.day, d]));
  const anchor = byDay.length ? byDay[byDay.length - 1].day : localDayKey(new Date());
  // `T00:00:00` without a zone parses as local time — matching the server's
  // `DATE_FORMAT(created_at, '%Y-%m-%d')` grouping.
  const end = new Date(`${anchor}T00:00:00`);
  if (Number.isNaN(end.getTime())) return byDay;

  for (let back = span - 1; back >= 0; back--) {
    const day = new Date(end);
    day.setDate(end.getDate() - back);
    const key = localDayKey(day);
    if (!map.has(key)) map.set(key, { day: key, count: 0, gross: 0, commission: 0 });
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shortDay(key: string): string {
  const parsed = new Date(`${key}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return key;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parsed);
}

function chargeTone(status: AdminCharge['status']): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'paid') return 'ok';
  if (status === 'pending') return 'warn';
  if (status === 'failed') return 'danger';
  return 'muted';
}

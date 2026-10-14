/**
 * Payments — the manual paybill review queue.
 *
 * A paybill never sends a callback, so the ledger only fills up with rows an
 * admin has to match against the bank statement by hand. The whole screen is
 * built around that one job:
 *
 *   • the account number is the matching key, so it is the largest element on
 *     every card and one click away from the clipboard;
 *   • pending rows carry their Approve / Reject controls inline (with an
 *     optional note for the audit trail), decided rows become read-only —
 *     history is not editable, the audit log already records who did what;
 *   • the cards (not a table) keep the layout usable on a phone, where the
 *     admin is most likely standing in front of the statement.
 *
 * Approving grants premium server-side for `premiumDays`, which is spelled out
 * under the buttons so nobody has to remember the price/length combo.
 */
import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime, formatKes, request, type Paged, type PaymentRow } from './api';
import { ErrorBanner, Loading, Panel, Pill } from './ui';

const PAGE_SIZE = 25;

/** Empty string = all statuses (the server treats it as "no filter"). */
type StatusFilter = 'pending' | 'approved' | 'rejected' | '';

/**
 * Counts per tab would need one request per status on every visit — the
 * per-page `total` below already answers "how many am I looking at", so the
 * tabs stay label-only.
 */
const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: '', label: 'All' },
];

export default function PaymentsTab() {
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<PaymentRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  /** Draft note per payment id, kept until the row is reviewed or reloaded. */
  const [notes, setNotes] = useState<Record<number, string>>({});
  /** Id whose account number was just copied — flips the button label. */
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      const search = new URLSearchParams({ status, page: String(page), size: String(PAGE_SIZE) });
      try {
        const next = await request<Paged<PaymentRow>>(`/payments?${search}`, { signal: controller.signal });
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
  }, [status, page, reload]);

  async function review(row: PaymentRow, next: 'approved' | 'rejected') {
    setBusyId(row.id);
    setError(null);
    const note = (notes[row.id] ?? '').trim();
    try {
      await request(`/payments/${row.id}`, {
        method: 'PATCH',
        // Omitting `note` entirely keeps the existing one server-side;
        // sending an empty string would wipe it.
        body: JSON.stringify(note ? { status: next, note } : { status: next }),
      });
      setReload((n) => n + 1);
      setNotes((prev) => {
        // Drop the draft note: the row is decided, the saved note now lives
        // on the server and renders on the read-only side of the card.
        const rest = { ...prev };
        delete rest[row.id];
        return rest;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function copyAccount(row: PaymentRow) {
    try {
      await navigator.clipboard.writeText(row.accountNo);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((current) => (current === row.id ? null : current)), 1500);
    } catch {
      // Clipboard API needs a secure context; fall back to telling the admin.
      setError('Could not copy automatically — select the account number and copy it manually.');
    }
  }

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.size ?? PAGE_SIZE)));
  const currentTab = STATUS_TABS.find((item) => item.id === status)?.label ?? 'All';

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <Panel
        title="Payment ledger"
        hint="Match the account number against the bank statement, then approve or reject."
        right={
          <div className="flex rounded-xl border border-white/10 bg-white/5 p-1">
            {STATUS_TABS.map((item) => (
              <button
                key={item.id || 'all'}
                type="button"
                onClick={() => {
                  // Both setters run in the same event → one batched render
                  // → exactly one fetch with status + page already reset.
                  setStatus(item.id);
                  setPage(1);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  status === item.id ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      >
        {data && total > 0 ? (
          <>
            <ul className={`space-y-3 ${loading ? 'opacity-60' : ''} transition-opacity`}>
              {data.items.map((row) => (
                <PaymentCard
                  key={row.id}
                  row={row}
                  busy={busyId === row.id}
                  note={notes[row.id] ?? ''}
                  copied={copiedId === row.id}
                  onNote={(text) => setNotes((prev) => ({ ...prev, [row.id]: text }))}
                  onReview={(next) => void review(row, next)}
                  onCopy={() => void copyAccount(row)}
                />
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-muted" aria-live="polite">
                {loading ? 'Loading…' : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total} ${currentTab.toLowerCase()}`}
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
          <Loading what="payments" />
        ) : (
          <p className="py-8 text-center text-sm text-muted">No {currentTab.toLowerCase()} payments.</p>
        )}
      </Panel>
    </div>
  );
}

interface CardProps {
  row: PaymentRow;
  busy: boolean;
  note: string;
  copied: boolean;
  onNote: (text: string) => void;
  onReview: (next: 'approved' | 'rejected') => void;
  onCopy: () => void;
}

function PaymentCard({ row, busy, note, copied, onNote, onReview, onCopy }: CardProps) {
  const pending = row.status === 'pending';

  return (
    <li className="card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          {/* The account number IS the workflow — biggest text on the card. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xl font-bold tracking-wide text-ink">{row.accountNo || '—'}</span>
            <button
              type="button"
              className="btn btn-ghost gap-1 px-2 py-1 text-[11px]"
              onClick={onCopy}
              title="Copy account number"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <Pill tone={statusTone(row.status)}>{row.status}</Pill>
            {!row.accountExists && <Pill tone="warn">account deleted</Pill>}
          </div>

          <p className="mt-2 text-sm">
            <span className="text-base font-semibold text-ink">{formatKes(row.amount)}</span>
            <span className="text-muted">
              {' '}
              · {row.method}
              {row.paybill ? ` ${row.paybill}` : ''} · {row.currency}
            </span>
          </p>

          <p className="mt-1 text-xs text-muted">
            @{row.username} (#{row.accountId}) · created {formatDateTime(row.createdAt)}
            {row.providerRef ? ` · transaction ${row.providerRef}` : ''}
          </p>
        </div>

        {pending ? (
          <div className="flex w-full flex-col gap-2 lg:w-80">
            <input
              className="field py-2 text-xs"
              placeholder="Optional note (bank ref, reason…)"
              aria-label={`Note for payment ${row.id}`}
              value={note}
              onChange={(event) => onNote(event.target.value)}
              disabled={busy}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1 px-3 py-2 text-xs"
                disabled={busy}
                onClick={() => onReview('approved')}
              >
                {busy ? 'Saving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="btn btn-danger flex-1 px-3 py-2 text-xs"
                disabled={busy}
                onClick={() => onReview('rejected')}
              >
                Reject
              </button>
            </div>
            {row.premiumDays > 0 && (
              <p className="text-[11px] text-muted">
                Approving grants <span className="font-semibold text-ok">{row.premiumDays} days</span> of premium to @
                {row.username}.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-1 lg:w-64 lg:items-end lg:text-right">
            <Pill tone={statusTone(row.status)}>{row.status}</Pill>
            <span className="text-xs text-muted">
              reviewed {formatDateTime(row.reviewedAt)}
              {row.reviewedBy ? ` · admin #${row.reviewedBy}` : ''}
            </span>
            {row.note && <span className="text-xs italic text-ink">“{row.note}”</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function statusTone(status: PaymentRow['status']): 'ok' | 'warn' | 'danger' {
  if (status === 'approved') return 'ok';
  if (status === 'rejected') return 'danger';
  return 'warn';
}

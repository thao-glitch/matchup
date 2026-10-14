/**
 * Users — searchable, filterable account list with the four destructive-ish
 * actions an owner needs: ban, unban, grant/revoke premium, delete.
 *
 * Two details drive the shape of this screen:
 *
 *   • The search box is debounced (300 ms) and folded into the SAME state as
 *     `page`, so typing resets the page and fires exactly one request per
 *     pause instead of one per keystroke or two racing fetches.
 *   • Every mutation re-fetches the current page rather than patching the row
 *     in place: bans and premium grants change server-side columns this table
 *     shows (bannedAt, premiumUntil, payments*), and re-reading is cheaper
 *     than reasoning about which of them moved.
 *
 * Deleting an account is the one action behind `window.confirm` — it destroys
 * a profile permanently, unlike a ban which can be lifted.
 */
import { useEffect, useState } from 'react';
import {
  errorMessage,
  flagEmoji,
  formatDate,
  formatDateTime,
  formatKes,
  request,
  timeAgo,
  type AdminUser,
  type Paged,
} from './api';
import { ErrorBanner, Loading, Pill, TD, TH } from './ui';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 300;

type UserFilter = 'all' | 'banned' | 'premium';

const FILTERS: { id: UserFilter; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'banned', label: 'Banned' },
  { id: 'premium', label: 'Premium' },
];

/** Query state travels as one object: `q` and `page` must change together
 *  (a new search always starts at page 1) or the effects race each other. */
interface UserParams {
  q: string;
  filter: UserFilter;
  page: number;
}

export default function UsersTab() {
  /** Raw input value — updates per keystroke, no request attached. */
  const [query, setQuery] = useState('');
  const [params, setParams] = useState<UserParams>({ q: '', filter: 'all', page: 1 });
  const [data, setData] = useState<Paged<AdminUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Id of the row being mutated — every other action button stays usable. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  // Debounced search: one request per typing pause, never per keystroke.
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
        q: params.q,
        filter: params.filter,
        page: String(params.page),
        size: String(PAGE_SIZE),
      });
      try {
        const next = await request<Paged<AdminUser>>(`/users?${search}`, { signal: controller.signal });
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        // A superseded request is aborted on purpose — that is not an error.
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

  async function run(user: AdminUser, path: string, init: RequestInit) {
    setBusyId(user.id);
    setError(null);
    try {
      await request(path, init);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function patch(user: AdminUser, body: Record<string, unknown>) {
    void run(user, `/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }

  function remove(user: AdminUser) {
    const confirmed = window.confirm(
      `Delete @${user.username} (#${user.id}) permanently?\n\n` +
        'Their profile, passport and sessions are destroyed and cannot be recovered. ' +
        'Payment records are kept.',
    );
    if (!confirmed) return;
    void run(user, `/users/${user.id}`, { method: 'DELETE' });
  }

  const total = data?.total ?? 0;
  const size = data?.size ?? PAGE_SIZE;
  const page = params.page;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const range =
    total === 0 ? '0 of 0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`;

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="field sm:max-w-xs"
          type="search"
          placeholder="Search by username…"
          aria-label="Search users"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="field sm:w-44"
          aria-label="Filter users"
          value={params.filter}
          onChange={(event) =>
            setParams((prev) => ({ ...prev, filter: event.target.value as UserFilter, page: 1 }))
          }
        >
          {FILTERS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted sm:ml-auto" aria-live="polite">
          {loading ? 'Loading…' : `${range} users`}
        </p>
      </div>

      {data && total > 0 ? (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            {/* min-width keeps the columns readable; below that the wrapper
                scrolls horizontally instead of crushing the actions. */}
            <table className="w-full min-w-[920px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>User</th>
                  <th className={TH}>Age</th>
                  <th className={TH}>Last seen</th>
                  <th className={TH}>Countries</th>
                  <th className={TH}>Paid</th>
                  <th className={TH}>Premium</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    busy={busyId === user.id}
                    onPatch={patch}
                    onRemove={remove}
                  />
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
        <Loading what="users" />
      ) : (
        <p className="py-10 text-center text-sm text-muted">No users match this search.</p>
      )}
    </div>
  );
}

interface RowProps {
  user: AdminUser;
  busy: boolean;
  onPatch: (user: AdminUser, body: Record<string, unknown>) => void;
  onRemove: (user: AdminUser) => void;
}

function UserRow({ user, busy, onPatch, onRemove }: RowProps) {
  const premium = isPremiumActive(user);
  const expired = !premium && user.premiumUntil !== null;
  const pending = user.paymentsPending > 0;
  const ip = user.lastIp && user.lastIp !== 'null' ? user.lastIp : '';

  return (
    <tr className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/5">
      <td className={TD}>
        <span
          className="font-semibold text-ink"
          title={`Joined ${formatDateTime(user.createdAt)}${ip ? ` · last IP ${ip}` : ''}`}
        >
          {flagEmoji(user.country)} {user.username}
        </span>
        <span className="block text-[11px] text-muted">
          #{user.id} · joined {formatDate(user.createdAt)}
        </span>
      </td>
      <td className={`${TD} tabular-nums`}>{user.age}</td>
      <td className={`${TD} whitespace-nowrap text-muted`} title={`Last seen ${formatDateTime(user.lastSeen)}`}>
        {timeAgo(user.lastSeen)}
      </td>
      <td className={`${TD} tabular-nums`}>{user.countries}</td>
      <td className={TD}>
        <span className="tabular-nums">{formatKes(user.paymentsTotal)}</span>
        {pending && <span className="block text-[11px] text-warn">{user.paymentsPending} pending</span>}
      </td>
      <td className={TD}>
        {premium ? (
          <>
            <Pill tone="ok">Premium active</Pill>
            <span className="mt-1 block text-[11px] text-muted">until {formatDate(user.premiumUntil)}</span>
          </>
        ) : expired ? (
          <span className="text-xs text-muted">expired {formatDate(user.premiumUntil)}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className={TD}>
        {user.banned ? (
          <>
            <Pill tone="danger">Banned</Pill>
            <span className="mt-1 block text-[11px] text-muted">{formatDate(user.bannedAt)}</span>
          </>
        ) : (
          <Pill tone="ok">Active</Pill>
        )}
      </td>
      <td className={TD}>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            className={`btn px-2.5 py-1.5 text-xs ${user.banned ? 'btn-ghost' : 'btn-ghost text-danger'}`}
            disabled={busy}
            onClick={() => onPatch(user, { banned: !user.banned })}
          >
            {user.banned ? 'Unban' : 'Ban'}
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2.5 py-1.5 text-xs"
            disabled={busy}
            title={premium ? 'Take premium away' : 'Grant 30 days of premium'}
            onClick={() => onPatch(user, premium ? { premiumDays: null } : { premiumDays: 30 })}
          >
            {premium ? 'Revoke' : 'Grant 30d'}
          </button>
          <button
            type="button"
            className="btn btn-danger px-2.5 py-1.5 text-xs"
            disabled={busy}
            onClick={() => onRemove(user)}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Premium counts only while `premiumUntil` is in the future — a stored date
 *  in the past is an expired membership and must render as such. */
function isPremiumActive(user: AdminUser): boolean {
  if (!user.premiumUntil) return false;
  const until = Date.parse(user.premiumUntil);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Content — the moderation queue for creator posts.
 *
 * Follows the UsersTab mechanics (debounced search folded into the same
 * param object as `page`, refetch-after-mutation instead of optimistic row
 * patches) because the same reasons apply: the server is the source of truth
 * for every column this table shows, and a stale "active" badge after a
 * hide would be worse than a spinner.
 *
 * Removal is the one action behind `window.confirm` — hiding is reversible
 * from this same screen, removal is not (the row stays in the ledger but
 * disappears for everyone).
 */
import { useEffect, useState } from 'react';
import {
  errorMessage,
  flagEmoji,
  formatDateTime,
  formatKes,
  request,
  type AdminPost,
  type Paged,
} from './api';
import { ErrorBanner, Loading, Pill, TD, TH } from './ui';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 300;

/** Empty string = every status (the server treats it as "no filter"). */
type StatusFilter = '' | 'active' | 'hidden' | 'removed';

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'hidden', label: 'Hidden' },
  { id: 'removed', label: 'Removed' },
];

/** `q` and `page` change together (a new search always restarts at page 1)
 *  or the debounced-search effect and the paging buttons race each other. */
interface ContentParams {
  q: string;
  status: StatusFilter;
  page: number;
}

export default function ContentTab() {
  /** Raw input — updates per keystroke, no request attached. */
  const [query, setQuery] = useState('');
  const [params, setParams] = useState<ContentParams>({ q: '', status: '', page: 1 });
  const [data, setData] = useState<Paged<AdminPost> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Id of the row being mutated — every other action button stays usable. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  // One request per typing pause, never per keystroke.
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
        q: params.q,
        page: String(params.page),
        size: String(PAGE_SIZE),
      });
      try {
        const next = await request<Paged<AdminPost>>(`/posts?${search}`, { signal: controller.signal });
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        // A superseded request is aborted on purpose — not an error.
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

  async function setStatus(post: AdminPost, status: AdminPost['status']) {
    setBusyId(post.id);
    setError(null);
    try {
      // The server audits the change; we only need its verdict. A failure
      // surfaces the server's own wording (e.g. "post not found").
      await request(`/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function remove(post: AdminPost) {
    const confirmed = window.confirm(
      `Remove post #${post.id} by @${post.creatorName}?\n\n` +
        'The post disappears for everyone and its media stops being served. ' +
        'Purchases already made are not refunded. This cannot be undone from this screen.',
    );
    if (!confirmed) return;
    void setStatus(post, 'removed');
  }

  const total = data?.total ?? 0;
  const size = data?.size ?? PAGE_SIZE;
  const page = params.page;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const range = total === 0 ? '0 of 0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`;

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          className="field sm:max-w-xs"
          type="search"
          placeholder="Search by caption or @username…"
          aria-label="Search posts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="field sm:w-44"
          aria-label="Filter posts by status"
          value={params.status}
          onChange={(event) =>
            setParams((prev) => ({ ...prev, status: event.target.value as StatusFilter, page: 1 }))
          }
        >
          {FILTERS.map((item) => (
            <option key={item.id || 'all'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted sm:ml-auto" aria-live="polite">
          {loading ? 'Loading…' : `${range} posts`}
        </p>
      </div>

      {data && total > 0 ? (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            <table className="w-full min-w-[1080px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>ID</th>
                  <th className={TH}>Creator</th>
                  <th className={TH}>Caption</th>
                  <th className={TH}>Type</th>
                  <th className={TH}>Price</th>
                  <th className={TH}>Views</th>
                  <th className={TH}>Likes</th>
                  <th className={TH}>Comments</th>
                  <th className={TH}>Sold</th>
                  <th className={TH}>Created</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((post) => (
                  <tr key={post.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/5">
                    <td className={`${TD} tabular-nums text-muted`}>{post.id}</td>
                    <td className={`${TD} whitespace-nowrap font-semibold text-ink`}>
                      {flagEmoji(post.creatorCountry)} @{post.creatorName}
                    </td>
                    <td className={`${TD} max-w-[260px]`}>
                      <span className="block truncate" title={post.caption}>
                        {post.caption || <span className="text-muted">(no caption)</span>}
                      </span>
                      {post.isAdult && (
                        <span className="mt-1 inline-block">
                          <Pill tone="danger">18+</Pill>
                        </span>
                      )}
                    </td>
                    <td className={`${TD} text-muted`}>{post.type}</td>
                    {/* A price of 0 means free — showing "KES 0" would read
                        like a broken paywall instead of an intentional freebie. */}
                    <td className={`${TD} whitespace-nowrap tabular-nums`}>
                      {post.price > 0 ? formatKes(post.price) : <span className="text-muted">Free</span>}
                    </td>
                    <td className={`${TD} tabular-nums`}>{post.views}</td>
                    <td className={`${TD} tabular-nums`}>{post.likes}</td>
                    <td className={`${TD} tabular-nums`}>{post.comments}</td>
                    <td className={`${TD} tabular-nums font-semibold text-ok`}>{post.purchases}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{formatDateTime(post.createdAt)}</td>
                    <td className={TD}>
                      <Pill tone={statusTone(post.status)}>{post.status}</Pill>
                    </td>
                    <td className={TD}>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {post.status !== 'hidden' && post.status !== 'removed' && (
                          <button
                            type="button"
                            className="btn btn-ghost px-2.5 py-1.5 text-xs"
                            disabled={busyId === post.id}
                            onClick={() => void setStatus(post, 'hidden')}
                          >
                            Hide
                          </button>
                        )}
                        {post.status !== 'active' && (
                          <button
                            type="button"
                            className="btn btn-ghost px-2.5 py-1.5 text-xs"
                            disabled={busyId === post.id}
                            onClick={() => void setStatus(post, 'active')}
                          >
                            Restore
                          </button>
                        )}
                        {post.status !== 'removed' && (
                          <button
                            type="button"
                            className="btn btn-danger px-2.5 py-1.5 text-xs"
                            disabled={busyId === post.id}
                            onClick={() => remove(post)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
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
        <Loading what="posts" />
      ) : (
        <p className="py-10 text-center text-sm text-muted">No posts match this filter.</p>
      )}
    </div>
  );
}

function statusTone(status: AdminPost['status']): 'ok' | 'warn' | 'danger' {
  if (status === 'active') return 'ok';
  if (status === 'hidden') return 'warn';
  return 'danger';
}

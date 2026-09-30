import { useCallback, useEffect, useState } from 'react';
import { fetchPresence, type GeoPresence } from '../lib/api';
import { EUROPE_CODES } from '../lib/geo';
import { countryName } from '../lib/countries';
import { flagFromCountry, SpinnerIcon } from './icons';

interface Props {
  onClose: () => void;
}

/** Refetch cadence while the panel is open — cheap, in-memory aggregation. */
const POLL_MS = 10_000;

/**
 * The live board: how many people are online right now, split by country.
 *
 * This is the distribution surface, not a filter — it answers "is anyone awake
 * in my corner of the world?" for a visitor deciding whether to press Start,
 * while matchmaking itself pairs anyone with anyone regardless of where they
 * are. Every number on this panel comes from `GET /api/presence`, which only
 * ever returns sums, so no individual user is identifiable from it.
 *
 * Open it from the lobby button or by loading the page with `#europe`.
 */
export default function EuropeBoard({ onClose }: Props) {
  const [data, setData] = useState<GeoPresence | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    fetchPresence(signal)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        // An aborted request (panel closed) is not a failure worth showing.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError('Live counts are unavailable right now.');
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = window.setInterval(() => load(), POLL_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [load, onClose]);

  const europe = (data?.byCountry ?? []).filter((row) => EUROPE_CODES.has(row.code));
  const elsewhere = (data?.byCountry ?? []).filter((row) => !EUROPE_CODES.has(row.code));
  const peak = Math.max(1, ...(data?.byCountry ?? []).map((row) => row.online));

  const rows = (list: { code: string; online: number }[]) => (
    <ul className="mt-2 space-y-2.5">
      {list.map((row) => (
        <li key={row.code} className="flex items-center gap-3">
          <span className="w-7 text-center text-lg leading-none" aria-hidden="true">
            {flagFromCountry(row.code)}
          </span>
          <span className="w-40 shrink-0 truncate text-sm font-medium text-ink">
            {countryName(row.code)}
          </span>
          <span
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(6, Math.round((row.online / peak) * 100))}%` }}
            />
          </span>
          <span className="w-8 text-right text-sm font-semibold tabular-nums text-ink">
            {row.online}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="card max-h-[85vh] w-full max-w-lg overflow-y-auto p-6 text-left"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Live across Europe"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink">Live across Europe</h2>
            <p className="mt-1 text-sm text-muted">
              {data ? (
                <>
                  <span className="font-semibold text-ink">{data.online}</span> online now ·{' '}
                  <span className="font-semibold text-ink">{data.looking}</span> looking for a
                  match
                </>
              ) : error ? (
                error
              ) : (
                'Counting…'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
            autoFocus
          >
            Close
          </button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-warn">{error} — retrying automatically.</p>
        )}

        {!data && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted">
            <SpinnerIcon className="h-5 w-5" /> Loading live counts…
          </div>
        )}

        {data && (
          <>
            <div className="mt-5">
              <p className="label">In Europe</p>
              {europe.length ? (
                rows(europe)
              ) : (
                <p className="mt-2 text-sm text-muted">
                  Nobody from Europe is online at this moment — start the app and put your
                  country on the board.
                </p>
              )}
            </div>

            {elsewhere.length > 0 && (
              <div className="mt-5">
                <p className="label">Elsewhere in the world</p>
                {rows(elsewhere)}
              </div>
            )}

            <p className="mt-6 rounded-xl border border-white/10 bg-surface-3/60 p-3 text-xs leading-relaxed text-muted">
              This board shows <span className="font-semibold text-ink">how many</span> people are
              online, never who they are — and it changes nothing about matching: anyone can be
              paired with anyone, from anywhere.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

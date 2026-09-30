/**
 * The Passport — linkable via `#passport`, opened from the lobby button.
 *
 * A passport book rendered as a grid: stamped countries light up with their
 * flag and call count, un-stamped ones stay dim "not yet" entries. Above it,
 * the three numbers that make people come back tomorrow — distinct countries,
 * total calls and the day-streak — plus the six achievements.
 *
 * Everything is read from `lib/passport` (localStorage), so it renders
 * instantly, works signed-out and needs no network.
 */
import { useEffect } from 'react';
import { badges, passportState, totalMatches, uniqueCountries } from '../lib/passport';
import { countryOptions } from '../lib/countries';
import { flagFromCountry } from './icons';
import { getToken } from '../lib/auth';

interface Props {
  onClose: () => void;
}

export default function PassportOverlay({ onClose }: Props) {
  const state = passportState();
  const unique = uniqueCountries();
  const total = totalMatches();

  // Every ISO region code the form can produce — stamped ones first, so the
  // book "fills up" from the top instead of the wins hiding in a sea of gray.
  const options = countryOptions();
  const sorted = [...options].sort(
    (a, b) =>
      Number(Boolean(state.stamps[b.code])) - Number(Boolean(state.stamps[a.code])) ||
      a.label.localeCompare(b.label),
  );

  const signedIn = Boolean(getToken());
  const achieved = badges();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6 text-left"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Your passport"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink">Your Passport</h2>
            <p className="mt-1 text-sm text-muted">
              <span className="font-semibold text-ink">{unique}</span> of{' '}
              {options.length} countries stamped ·{' '}
              <span className="font-semibold text-ink">{total}</span> call
              {total === 1 ? '' : 's'}
              {state.streak > 0 && (
                <>
                  {' '}
                  · <span className="font-semibold text-accent">🔥 {state.streak}-day streak</span>
                </>
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

        {/* Progress toward the whole collection — the completionist hook. */}
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent to-ok transition-all"
            style={{ width: `${Math.min(100, (unique / Math.max(1, options.length)) * 100)}%` }}
          />
        </div>

        {/* Achievements */}
        <div className="mt-5 grid grid-cols-3 gap-2">
          {achieved.map((badge) => (
            <div
              key={badge.id}
              className={`rounded-xl border px-2 py-2 text-center ${
                badge.earned
                  ? 'border-accent/40 bg-accent/10'
                  : 'border-white/5 bg-surface-3/30 opacity-50'
              }`}
              title={`${badge.label} — ${badge.hint}`}
            >
              <div className="text-lg">{badge.earned ? badge.icon : '🔒'}</div>
              <div className="mt-0.5 truncate text-[11px] font-medium text-ink">
                {badge.earned ? badge.label : badge.hint}
              </div>
            </div>
          ))}
        </div>

        {/* The book itself */}
        <p className="mt-5 text-xs uppercase tracking-wide text-muted">
          Every connected conversation stamps a country — keep going
        </p>
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {sorted.map((option) => {
            const count = state.stamps[option.code];
            const stamped = Boolean(count);
            return (
              <div
                key={option.code}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                  stamped
                    ? 'border-accent/40 bg-accent/10'
                    : 'border-white/5 bg-surface-3/30 opacity-45'
                }`}
              >
                <span className="text-base">{flagFromCountry(option.code)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink">{option.label}</span>
                {stamped && (
                  <span className="shrink-0 text-[10px] font-semibold tabular-nums text-accent">
                    ×{count}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {!signedIn && unique > 0 && (
          <p className="mt-4 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            🔒 Your {unique} stamp{unique === 1 ? '' : 's'} live on this device only — create an
            account and the passport follows you to every phone.
          </p>
        )}

        <p className="mt-4 text-center text-xs text-muted">
          Only you can see this book — the live board shows aggregate country counts, never who
          is in them.
        </p>
      </div>
    </div>
  );
}

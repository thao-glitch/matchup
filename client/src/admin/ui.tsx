/**
 * Shared visual primitives for the admin dashboard.
 *
 * Everything here is built from the app's existing design tokens (`.card`,
 * `.btn`, `text-ink`, `bg-surface-2`, …) so `/admin` looks like the same
 * product as the lobby — just denser. Each tab composes these instead of
 * re-deciding paddings and pill colors, which is what keeps the five screens
 * visually consistent.
 */
import type { ReactNode } from 'react';

/** Shared table cell classes — exported so every table aligns to the same grid. */
export const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';
export const TD = 'px-3 py-2.5 align-middle text-sm';

type Tone = 'ok' | 'danger' | 'warn' | 'accent' | 'muted';

const PILL_TONE: Record<Tone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  accent: 'border-accent/30 bg-accent/10 text-accent',
  muted: 'border-white/10 bg-white/5 text-muted',
};

/**
 * Small status pill. Color-coding is the whole point: green = healthy/paid,
 * red = banned/rejected, amber = needs attention, blue = informational.
 */
export function Pill({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Inline error strip. Always renders the server's own wording (see `api.ts`)
 * and never throws — an admin action failing must leave the page usable.
 */
export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-xs font-semibold text-danger/80 hover:text-danger"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Card with a title row and an optional right-hand control (refresh, count…). */
export function Panel({
  title,
  hint,
  right,
  children,
  className = '',
}: {
  title: string;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted/80">{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** Value colors as complete class strings — template-built class names would
 *  be invisible to Tailwind's scanner and silently render as plain ink. */
const STAT_TONE: Record<string, string> = {
  ok: 'text-ok',
  danger: 'text-danger',
  warn: 'text-warn',
  accent: 'text-accent',
};

/** One number in a stat group. `tone` highlights the value itself. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'danger' | 'warn' | 'accent';
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-bold leading-tight ${tone ? STAT_TONE[tone] : 'text-ink'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

/** Centered placeholder for a list that is still loading. */
export function Loading({ what }: { what: string }) {
  return <p className="py-10 text-center text-sm text-muted">Loading {what}…</p>;
}

/**
 * Toggle row used by Settings. The whole row is the switch (one target, one
 * tab stop) and `danger` turns it red — maintenance mode pauses matchmaking
 * for everyone, so it must never look like the other three switches.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  danger = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
  danger?: boolean;
}) {
  const active = danger && checked;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
        active
          ? 'border-danger/40 bg-danger/10'
          : 'border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10'
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border px-[2px] transition-colors ${
          checked ? (active ? 'border-danger/50 bg-danger/70' : 'border-accent/50 bg-accent') : 'border-white/15 bg-surface-3'
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
        />
      </span>
      <span className="min-w-0">
        <span className={`block text-sm font-semibold ${active ? 'text-danger' : 'text-ink'}`}>{label}</span>
        <span className={`block text-xs ${danger ? 'text-danger/80' : 'text-muted'}`}>{hint}</span>
      </span>
    </button>
  );
}

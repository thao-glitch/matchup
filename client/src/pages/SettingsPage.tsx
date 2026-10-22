/**
 * Settings — account facts, the 18+ acknowledgement, how money works here,
 * and the session.
 *
 * Everything on this screen is read-only apart from two actions (the
 * acknowledgement and sign-out): profile editing lives in the video app's
 * lobby, and there is deliberately no "un-acknowledge" API — the flag only
 * ever says *this device* has been told, so the card reflects that state and
 * stops there.
 */
import { useState, type ReactNode } from 'react';
import type { PageProps } from '../shell/pageProps';
import { signOutAccount } from '../lib/auth';
import { Link, navigate } from '../lib/router';
import { formatKes } from '../lib/social';
import { countryName } from '../lib/countries';
import {
  CheckIcon,
  CompassIcon,
  FlameIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  VideoIcon,
  WalletIcon,
} from '../components/icons';

export default function SettingsPage({
  account,
  config,
  requireAuth,
  onAccountChange,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const [signingOut, setSigningOut] = useState(false);

  const commerce = config.commerce;
  const age = Number(account?.profile?.age);
  const canAck = Boolean(commerce.adult && account && age >= 18 && !adultOk);

  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    await signOutAccount();
    onAccountChange(null);
    navigate('/');
  }

  return (
    <div className="space-y-5">
      {/* ── Account ──────────────────────────────────────────────────────── */}
      <section className="card p-5">
        <h2 className="text-base font-semibold text-ink">Account</h2>

        {!account ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Sign in to see who you are on Matchup — your username, profile and sessions all
              live here.
            </p>
            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              onClick={() => requireAuth('Sign in to manage your account.')}
            >
              Sign in
            </button>
          </>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/20 text-base font-bold text-accent">
                {account.username.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">@{account.username}</p>
                <p className="truncate text-xs text-muted">
                  {age >= 18 ? 'Adult account' : 'Under 18 account'}
                  {account.createdAt ? ` · Member since ${memberSince(account.createdAt)}` : ''}
                </p>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
              <Fact label="Age" value={String(age)} />
              <Fact label="Gender" value={cap(account.profile.gender)} />
              <Fact
                label="Country"
                value={
                  account.profile.country ? countryName(account.profile.country) : '—'
                }
              />
            </dl>

            <p className="mt-4 text-xs leading-relaxed text-muted">
              These details were set in the video app's lobby — that is where you change them.
            </p>
          </>
        )}
      </section>

      {/* ── Adult content ────────────────────────────────────────────────── */}
      {commerce.adult && (
        <section className="card p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-surface-2 text-danger">
              <FlameIcon className="h-4 w-4" />
            </span>
            <h2 className="text-base font-semibold text-ink">Adult content</h2>
          </div>

          {adultOk ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-ok/30 bg-ok/10 px-3.5 py-3">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Acknowledged on this device</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  18+ posts, rooms and conferences are visible here. The platform also checks
                  your account age on every request — nothing is shown to anyone under 18.
                </p>
              </div>
            </div>
          ) : canAck ? (
            <>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                There is an 18+ section on this platform — sensitive content. Confirm that you
                are 18 or over to see it.
              </p>
              <button
                type="button"
                className="btn btn-primary mt-4 w-full"
                onClick={acknowledgeAdult}
              >
                I'm 18 or over
              </button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {account
                ? '18+ sections are for accounts aged 18 and over.'
                : 'Sign in with an account aged 18 or over to confirm and see the adult sections.'}
            </p>
          )}
        </section>
      )}

      {/* ── Payments & earnings ──────────────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-surface-2 text-ok">
            <WalletIcon className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold text-ink">Payments &amp; earnings</h2>
        </div>

        <dl className="mt-3 space-y-2.5 text-sm">
          <Row label="Platform fee">
            <span className="font-semibold text-warn">{commerce.commissionRate}%</span>
            <span className="text-muted"> of every sale</span>
          </Row>
          <Row label="Payment method">
            <span className="font-medium text-ink">
              {commerce.payMode === 'stk' ? 'M-PESA prompt (STK push)' : 'Manual confirmation'}
            </span>
          </Row>
          <Row label="Price range">
            <span className="font-medium tabular-nums text-ink">
              {formatKes(commerce.minPrice)} – {formatKes(commerce.maxPrice)}
            </span>
          </Row>
        </dl>

        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            You set the price; the platform takes its cut when the money lands and the rest is
            yours to withdraw.
          </span>
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Link to="/wallet" className="btn btn-ghost">
            <WalletIcon className="h-4 w-4" />
            Open your wallet
          </Link>
          <Link to="/create" className="btn btn-ghost">
            <PlusIcon className="h-4 w-4" />
            Create paid content
          </Link>
        </div>
      </section>

      {/* ── Session ──────────────────────────────────────────────────────── */}
      <section className="card p-5">
        <h2 className="text-base font-semibold text-ink">Session</h2>
        {account ? (
          <>
            <p className="mt-2 text-sm text-muted">
              You are signed in as{' '}
              <span className="font-semibold text-ink">@{account.username}</span>
            </p>
            <button
              type="button"
              className="btn btn-ghost mt-4 w-full"
              onClick={() => void signOut()}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            No session on this device — sign in from any page to pick one up.
          </p>
        )}
      </section>

      {/* ── About / quick links ──────────────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-surface-2 text-accent">
            <GlobeIcon className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold text-ink">About</h2>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Link to="/match" className="btn btn-ghost">
            <VideoIcon className="h-4 w-4" />
            1v1 video chat
          </Link>
          <Link to="/live" className="btn btn-ghost">
            <VideoIcon className="h-4 w-4" />
            Live rooms
          </Link>
          <Link to="/explore" className="btn btn-ghost">
            <CompassIcon className="h-4 w-4" />
            Explore
          </Link>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          Privacy and terms are read inside the video app, so these links open it with the right
          panel shown.
        </p>
        <div className="mt-2 flex gap-4 text-xs">
          <a
            href="/match#privacy"
            className="text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Privacy
          </a>
          <a
            href="/match#terms"
            className="text-accent underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Terms
          </a>
        </div>
      </section>

    </div>
  );
}

// ── Local building blocks ────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-surface-3/50 px-2 py-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-2.5 last:border-b-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
}

/** `2025-03-04…` → "Mar 2025" — a joining date needs no finer resolution. */
function memberSince(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

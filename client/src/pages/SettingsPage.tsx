/**
 * Settings — profile photos, account facts, the 18+ acknowledgement, how
 * money works here, and the session.
 *
 * The photo card is the one screen that writes: a profile picture and a
 * background photo are what other people actually see, so they belong to the
 * account rather than to the video lobby. Everything else here is read-only
 * apart from two actions (the acknowledgement and sign-out): profile editing
 * lives in the video app's lobby, and there is deliberately no
 * "un-acknowledge" API — the flag only ever says *this device* has been told,
 * so the card reflects that state and stops there.
 */
import { useRef, useState, type ReactNode } from 'react';
import type { PageProps } from '../shell/pageProps';
import { signOutAccount } from '../lib/auth';
import { Link, navigate } from '../lib/router';
import { formatKes, removePhoto, SocialError, uploadPhoto, type PhotoKind } from '../lib/social';
import { countryName } from '../lib/countries';
import { mediaSrc } from '../lib/mediaUrl';
import Avatar from '../components/Avatar';
import {
  CamIcon,
  CheckIcon,
  CompassIcon,
  FlameIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  SpinnerIcon,
  VideoIcon,
  WalletIcon,
} from '../components/icons';

/** Photos are validated server-side too — this just fails faster in the UI. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export default function SettingsPage({
  account,
  config,
  requireAuth,
  onAccountChange,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const [signingOut, setSigningOut] = useState(false);

  // Profile photos — one shared busy flag so avatar and banner cannot be
  // swapped while the other request is still in flight.
  const [photoBusy, setPhotoBusy] = useState<PhotoKind | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

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

  async function pickPhoto(kind: PhotoKind, file: File | undefined): Promise<void> {
    if (!file || !account) return;
    setPhotoError(null);
    if (!PHOTO_TYPES.includes(file.type)) {
      setPhotoError('Choose a JPEG, PNG, WebP or GIF image.');
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError('That photo is over 4 MB — pick a smaller one.');
      return;
    }
    setPhotoBusy(kind);
    try {
      const { url } = await uploadPhoto(kind, file);
      // The account object is the only place these URLs live; patching it
      // makes every avatar on the site (including this page's) refresh at once.
      onAccountChange({
        ...account,
        ...(kind === 'avatar' ? { avatarUrl: url } : { bannerUrl: url }),
      });
    } catch (err) {
      setPhotoError(
        err instanceof SocialError ? err.message : 'That upload did not go through — try again.',
      );
    } finally {
      setPhotoBusy(null);
      const input = kind === 'avatar' ? avatarInput : bannerInput;
      if (input.current) input.current.value = '';
    }
  }

  async function clearPhoto(kind: PhotoKind): Promise<void> {
    if (!account || photoBusy) return;
    setPhotoError(null);
    setPhotoBusy(kind);
    try {
      await removePhoto(kind);
      onAccountChange({
        ...account,
        ...(kind === 'avatar' ? { avatarUrl: null } : { bannerUrl: null }),
      });
    } catch (err) {
      setPhotoError(
        err instanceof SocialError ? err.message : 'Could not remove that photo — try again.',
      );
    } finally {
      setPhotoBusy(null);
    }
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
              <Avatar
                username={account.username}
                src={account.avatarUrl}
                className="h-11 w-11"
                letterClass="text-base"
              />
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

      {/* ── Profile photos ──────────────────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-surface-2 text-accent">
            <CamIcon className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold text-ink">Profile photos</h2>
        </div>

        {!account ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Sign in to add a profile picture and a background — these are what other people see
            on your profile and next to everything you post.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Your picture shows on your profile, your posts and your comments. The background
              sits behind your name on your profile page. JPEG, PNG, WebP or GIF, up to 4 MB.
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {/* Picture */}
              <div className="rounded-xl border border-white/10 bg-surface-2/60 p-3.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Profile picture
                </p>
                <div className="mt-2.5 flex items-center gap-3">
                  <Avatar
                    username={account.username}
                    src={account.avatarUrl}
                    className="h-14 w-14"
                    letterClass="text-xl"
                  />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <button
                      type="button"
                      className="btn btn-ghost px-3 py-1.5 text-xs"
                      disabled={photoBusy !== null}
                      onClick={() => avatarInput.current?.click()}
                    >
                      {photoBusy === 'avatar' ? 'Uploading…' : account.avatarUrl ? 'Replace' : 'Upload'}
                    </button>
                    {account.avatarUrl ? (
                      <button
                        type="button"
                        className="btn btn-ghost px-3 py-1.5 text-xs text-danger"
                        disabled={photoBusy !== null}
                        onClick={() => clearPhoto('avatar')}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                <input
                  ref={avatarInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  aria-label="Choose a profile picture"
                  onChange={(event) => pickPhoto('avatar', event.target.files?.[0])}
                />
              </div>

              {/* Background */}
              <div className="rounded-xl border border-white/10 bg-surface-2/60 p-3.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Background photo
                </p>
                <div
                  className="mt-2.5 h-14 w-full overflow-hidden rounded-lg border border-white/10 bg-cover bg-center"
                  style={{
                    backgroundImage: account.bannerUrl
                      ? `url("${mediaSrc(account.bannerUrl)}")`
                      : 'linear-gradient(120deg, rgba(255,255,255,.06), rgba(255,255,255,.02))',
                  }}
                  aria-hidden="true"
                />
                <div className="mt-2.5 flex gap-1.5">
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                    disabled={photoBusy !== null}
                    onClick={() => bannerInput.current?.click()}
                  >
                    {photoBusy === 'banner'
                      ? 'Uploading…'
                      : account.bannerUrl
                        ? 'Replace'
                        : 'Upload'}
                  </button>
                  {account.bannerUrl ? (
                    <button
                      type="button"
                      className="btn btn-ghost px-3 py-1.5 text-xs text-danger"
                      disabled={photoBusy !== null}
                      onClick={() => clearPhoto('banner')}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  ref={bannerInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  aria-label="Choose a background photo"
                  onChange={(event) => pickPhoto('banner', event.target.files?.[0])}
                />
              </div>
            </div>

            {photoBusy ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted">
                <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                Saving your photo…
              </p>
            ) : null}
            {photoError ? (
              <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {photoError}
              </p>
            ) : null}
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
            <span className="font-medium text-ink">M-PESA prompt (STK push)</span>
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

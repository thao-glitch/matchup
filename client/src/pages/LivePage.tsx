/**
 * LivePage — the "happening now" screen: the 1v1 Match entry point, the live
 * group-call board, the 18+ conference board, and the form that opens a room
 * of your own.
 *
 * The two room lists poll every 15 s under the same rules as the admin
 * Overview: one request in flight at a time, nothing while the tab is
 * hidden, and an immediate refresh when it comes back — so the live
 * headcounts never sit stale on screen. Leaving the page kills the interval
 * (Shell unmounts inactive pages), so no traffic runs behind another screen.
 *
 * Creating a room is a socket call, not an HTTP one: the host is dropped
 * straight into the room they just opened (`room:created` → `/room/:slug`),
 * which is why the button briefly owns a connection of its own.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Room } from '../types/social';
import { LOBBY_FEATURES } from '../lib/callFeatures';
import { createRoom } from '../lib/rooms';
import { Link, navigate } from '../lib/router';
import { SocialError, formatKes, listRooms, timeAgo } from '../lib/social';
import {
  AlertIcon,
  FlameIcon,
  PlusIcon,
  SpinnerIcon,
  UserIcon,
  UsersIcon,
  VideoIcon,
  WalletIcon,
} from '../components/icons';

/** Refresh cadence — slow enough to be invisible in the access log. */
const POLL_MS = 15_000;

export default function LivePage({
  account,
  config,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const [groups, setGroups] = useState<Room[] | null>(null);
  const [conferences, setConferences] = useState<Room[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Bumping this re-runs the listing effect (the Retry buttons below). */
  const [reload, setReload] = useState(0);

  // ── Room listings ────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    async function refresh(): Promise<void> {
      if (disposed || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        // Adult rows are filtered server-side unless the viewer may see them,
        // so re-asking after an acknowledgement is what reveals them.
        const [g, c] = await Promise.all([
          listRooms({ kind: 'group', adult: adultOk }),
          listRooms({ kind: 'conference', adult: adultOk }),
        ]);
        if (!disposed) {
          setGroups(g.items);
          setConferences(c.items);
          setListError(null);
        }
      } catch (err) {
        if (!disposed) {
          setListError(
            err instanceof SocialError ? err.message : 'Live rooms are unavailable right now.',
          );
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [adultOk, reload]);

  // ── Start-a-room form ────────────────────────────────────────────────────
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'group' | 'conference'>('group');
  const [price, setPrice] = useState('');
  const [max, setMax] = useState('6');
  const [isAdult, setIsAdult] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** StrictMode unmounts effects — never navigate (or setState) after that. */
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const adultCan = config.commerce.adult && adultOk;

  function openForm(): void {
    // Nothing is replayed after a sign-in: the form only opens once auth is
    // actually there, so the socket request always carries a live token.
    if (!requireAuth('Sign in to host a room.')) return;
    setCreateError(null);
    setShowForm(true);
  }

  function pickKind(next: 'group' | 'conference'): void {
    setKind(next);
    // Conferences are the adult stage by default — turning the flag off
    // for a mixed-age panel stays a checkbox click away.
    setIsAdult(next === 'conference' && adultCan);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // State alone lags a re-render, so the in-flight controller is what
    // actually stops a double tap from opening two sockets.
    if (creating || abortRef.current) return;

    const trimmed = title.trim();
    if (!trimmed) {
      setCreateError('Give the room a title.');
      return;
    }

    // Mirror the server's clamp so the price on screen is the price charged.
    const raw = Math.round(Number(price) || 0);
    const amount =
      raw <= 0 ? 0 : Math.min(config.commerce.maxPrice, Math.max(config.commerce.minPrice, raw));
    const cap = Math.min(12, Math.max(2, Math.round(Number(max) || (kind === 'conference' ? 8 : 6))));

    setCreating(true);
    setCreateError(null);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const room = await createRoom(
        { title: trimmed, price: amount, isAdult: adultCan && isAdult, max: cap, kind },
        { signal: controller.signal },
      );
      if (!aliveRef.current) return;
      navigate(`/room/${room.slug}`);
    } catch (err) {
      if (!aliveRef.current) return;
      setCreateError(err instanceof Error ? err.message : 'The room could not be created.');
      setCreating(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const reloadLists = () => setReload((n) => n + 1);

  return (
    <div className="space-y-7">
      {/* ── Hero: the 1v1 entry point ─────────────────────────────────────── */}
      <section className="card relative overflow-hidden p-6 sm:p-8">
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-accent/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
            <VideoIcon className="h-4 w-4" />
            Random 1v1 video chat
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            One tap, one stranger, one call
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            A private peer-to-peer video call with someone new — no schedule, no lobby list.
            Spark, duel and chat ride along with it.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-5 w-full px-6 py-3 text-base sm:w-auto"
            onClick={() => navigate('/match')}
          >
            <VideoIcon className="h-5 w-5" />
            Start a random 1v1
          </button>

          <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {LOBBY_FEATURES.map((feature) => (
              <li
                key={feature.id}
                className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-surface-3/50 px-3 py-2.5"
              >
                <span className="text-base leading-none" aria-hidden="true">
                  {feature.emoji}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-ink">{feature.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                    {feature.blurb}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Group calls ───────────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          icon={<UsersIcon className="h-4.5 w-4.5" />}
          title="Group calls"
          hint="Live rooms you can drop into"
        />
        {listError && <ErrorNote message={listError} onRetry={reloadLists} />}
        {groups === null && !listError && <LoadingRow what="live rooms" />}
        {groups !== null && groups.length === 0 && !listError && (
          <EmptyCard text="No group calls live right now. Open one and invite your people." />
        )}
        {groups !== null && groups.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {groups.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
          </div>
        )}
      </section>

      {/* ── 18+ conferences ───────────────────────────────────────────────── */}
      {config.commerce.adult && (
        <section>
          <SectionHeader
            icon={<FlameIcon className="h-4.5 w-4.5" />}
            title="18+ Conferences"
            hint="Adults only — sensitive content"
          />
          {!adultOk ? (
            <AdultGateCard onAcknowledge={acknowledgeAdult} />
          ) : (
            <>
              {listError && <ErrorNote message={listError} onRetry={reloadLists} />}
              {conferences === null && !listError && <LoadingRow what="conferences" />}
              {conferences !== null && conferences.length === 0 && !listError && (
                <EmptyCard text="No conferences live right now." />
              )}
              {conferences !== null && conferences.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {conferences.map((room) => (
                    <RoomCard key={room.id} room={room} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Start a room ──────────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          icon={<PlusIcon className="h-4.5 w-4.5" />}
          title="Start a room"
          hint={account ? 'Open a group call or a conference' : 'Sign in to host'}
        />
        {!showForm ? (
          <div className="card p-5">
            <p className="text-sm leading-relaxed text-muted">
              Host your own room: pick a title, a headcount and — if you like — an entry price.
              You keep{' '}
              <span className="font-semibold text-ink">
                {100 - config.commerce.commissionRate}%
              </span>{' '}
              of every entry; the platform keeps {config.commerce.commissionRate}%. The room
              opens straight into the call, and only people you share the link with can find it.
            </p>
            <button type="button" className="btn btn-primary mt-4" onClick={openForm}>
              <PlusIcon className="h-4 w-4" />
              Start a room
            </button>
            {!account && (
              <p className="mt-2 text-xs text-muted">You will be asked to sign in first.</p>
            )}
          </div>
        ) : (
          <form className="card space-y-4 p-5" onSubmit={(event) => void submit(event)}>
            <div>
              <label className="label" htmlFor="room-title">
                Title
              </label>
              <input
                id="room-title"
                className="field"
                maxLength={80}
                placeholder="Friday night Q&A"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div>
              <span className="label">Kind</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={kind === 'group' ? 'btn btn-primary w-full' : 'btn btn-ghost w-full'}
                  aria-pressed={kind === 'group'}
                  onClick={() => pickKind('group')}
                >
                  <UsersIcon className="h-4 w-4" />
                  Group call
                </button>
                <button
                  type="button"
                  className={
                    kind === 'conference' ? 'btn btn-primary w-full' : 'btn btn-ghost w-full'
                  }
                  aria-pressed={kind === 'conference'}
                  onClick={() => pickKind('conference')}
                >
                  <FlameIcon className="h-4 w-4" />
                  Conference
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="room-price">
                  Entry price (KES)
                </label>
                <input
                  id="room-price"
                  className="field"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={config.commerce.maxPrice}
                  placeholder="0 = free"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
                <p className="mt-1 text-[11px] leading-snug text-muted">
                  0 is free; otherwise it lands between {formatKes(config.commerce.minPrice)} and{' '}
                  {formatKes(config.commerce.maxPrice)}.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="room-max">
                  Max people
                </label>
                <input
                  id="room-max"
                  className="field"
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={12}
                  value={max}
                  onChange={(event) => setMax(event.target.value)}
                />
                <p className="mt-1 text-[11px] leading-snug text-muted">Between 2 and 12.</p>
              </div>
            </div>

            {config.commerce.adult && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-surface-3/50 px-3.5 py-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[#ff5b6e]"
                  checked={isAdult}
                  disabled={!adultCan}
                  onChange={(event) => setIsAdult(event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-ink">18+ room</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    {adultCan
                      ? 'Only accounts aged 18 and over can enter.'
                      : 'Confirm you are 18 or over in the 18+ section above first.'}
                  </span>
                </span>
              </label>
            )}

            {createError && (
              <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
                {createError}
              </p>
            )}

            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary flex-1" disabled={creating}>
                {creating ? (
                  <>
                    <SpinnerIcon className="h-4 w-4" />
                    Opening…
                  </>
                ) : (
                  'Open the room'
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setShowForm(false);
                  setCreateError(null);
                }}
                disabled={creating}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ── Quick links ───────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          to="/wallet"
          className="card flex items-center gap-3 p-4 transition-colors hover:border-accent/40"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ok/15 text-ok">
            <WalletIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">Wallet</span>
            <span className="block truncate text-xs text-muted">
              Balance, earnings and M-PESA payouts
            </span>
          </span>
        </Link>
        <Link
          to="/profile"
          className="card flex items-center gap-3 p-4 transition-colors hover:border-accent/40"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <UserIcon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">Your profile</span>
            <span className="block truncate text-xs text-muted">Posts, stats and identity</span>
          </span>
        </Link>
      </div>
    </div>
  );
}

// ── Local building blocks ────────────────────────────────────────────────────

function SectionHeader({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-surface-2 text-accent">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-tight text-ink">{title}</h2>
        {hint && <p className="truncate text-xs text-muted">{hint}</p>}
      </div>
    </div>
  );
}

function RoomCard({ room }: { room: Room }) {
  return (
    <button
      type="button"
      onClick={() => navigate(`/room/${room.slug}`)}
      className="card group w-full p-4 text-left transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{room.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted">
            @{room.hostName} · {timeAgo(room.createdAt)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${
            room.price > 0
              ? 'border-ok/40 bg-ok/10 text-ok'
              : 'border-white/15 bg-white/5 text-muted'
          }`}
        >
          {room.price > 0 ? formatKes(room.price) : 'Free'}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-muted">
          <UsersIcon className="h-3.5 w-3.5" />
          <span className="tabular-nums">
            {room.participants}/{room.maxParticipants}
          </span>
          <span>live</span>
        </span>
        {room.isAdult && (
          <span className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 font-semibold text-danger">
            <FlameIcon className="h-3.5 w-3.5" />
            18+
          </span>
        )}
        <span className="ml-auto font-semibold text-accent opacity-0 transition-opacity group-hover:opacity-100">
          Join →
        </span>
      </div>
    </button>
  );
}

/** Shown in place of the conference list until this device is acknowledged. */
function AdultGateCard({ onAcknowledge }: { onAcknowledge: () => void }) {
  return (
    <div className="card p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn/15 text-warn">
          <AlertIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Adults only — sensitive content</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            What follows is 18+ material. Confirm that you are 18 or over to see the conferences
            live on this platform. The acknowledgement is remembered on this device only.
          </p>
        </div>
      </div>
      <button type="button" className="btn btn-primary mt-4 w-full" onClick={onAcknowledge}>
        I'm 18 or over
      </button>
    </div>
  );
}

function LoadingRow({ what }: { what: string }) {
  return (
    <div className="card flex items-center gap-2.5 px-4 py-5 text-sm text-muted">
      <SpinnerIcon className="h-4 w-4 text-accent" />
      Loading {what}…
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return <div className="card px-4 py-6 text-sm text-muted">{text}</div>;
}

function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-3 border-danger/30 px-4 py-3">
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-danger">{message}</p>
      <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

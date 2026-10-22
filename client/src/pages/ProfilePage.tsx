/**
 * Profile — "You": identity, the three numbers a creator cares about (money,
 * posts, likes), their own posts including the hidden ones, and the exits
 * (create, wallet, settings, 1v1, sign out).
 *
 * The stats come from two endpoints that can fail independently — a wallet
 * hiccup must not hide the posts — so each result is taken on its own and the
 * first failure is reported verbatim instead of swallowed. "Likes received"
 * is a sum over the posts actually loaded, labelled as such: there is no
 * server-side aggregate and a precise-looking number would be a lie.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Post, Wallet } from '../types/social';
import { SocialError, formatKes, getWallet, listMyPosts, timeAgo } from '../lib/social';
import { signOutAccount } from '../lib/auth';
import { Link, navigate } from '../lib/router';
import {
  AlertIcon,
  CamIcon,
  HeartIcon,
  LockIcon,
  PlusIcon,
  SettingsIcon,
  SpinnerIcon,
  WalletIcon,
  flagFromCountry,
} from '../components/icons';
import HeroBanner from '../components/HeroBanner';

interface ErrState {
  message: string;
  code: string;
}

function toError(err: unknown): ErrState {
  return err instanceof SocialError
    ? { message: err.message, code: err.code }
    : { message: 'Something went wrong — please try again.', code: 'client' };
}

/** `account.createdAt` predates some accounts being required to have it. */
function memberSince(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export default function ProfilePage({
  account,
  config,
  requireAuth,
  onAccountChange,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrState | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const canAck = Boolean(
    config.commerce.adult && account && Number(account.profile?.age) >= 18 && !adultOk,
  );

  useEffect(() => {
    if (!account) {
      setPosts([]);
      setTotal(0);
      setWallet(null);
      setLoading(false);
      return;
    }
    let dead = false;
    setLoading(true);
    setError(null);

    (async () => {
      // The count deliberately asks for a single row: only `total` is wanted,
      // the grid below fetches its own page of full posts.
      const [balance, count, mine] = await Promise.allSettled([
        getWallet(),
        listMyPosts({ size: 1 }),
        listMyPosts(),
      ]);
      if (dead) return;

      const failed = [balance, count, mine].find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') setError(toError(failed.reason));

      if (balance.status === 'fulfilled') setWallet(balance.value.wallet);
      if (mine.status === 'fulfilled') {
        setPosts(mine.value.items);
        setTotal(mine.value.total);
      } else if (count.status === 'fulfilled') {
        setTotal(count.value.total);
      }
      setLoading(false);
    })();
    return () => {
      dead = true;
    };
  }, [account]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOutAccount();
    onAccountChange(null);
    navigate('/');
  }

  // ── Signed out ────────────────────────────────────────────────────────────
  if (!account) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <HeroBanner
          img="/img/hero-profile.webp"
          eyebrow="You on Matchup"
          title="Your profile"
          text="Sign in to see your posts, your earnings and everything you have shared."
        />
        <div className="card p-6">
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => requireAuth('Sign in to see your profile.')}
          >
            Sign in / create account
          </button>
        </div>
        <div className="card space-y-3 p-5 text-sm">
          <p className="label">What an account gives you</p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Post &amp; earn</span> — sell photos, clips,
            links or text in KES and watch the fee split before you set a price.
          </p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Wallet</span> — every sale lands in your
            balance and withdraws straight to M-PESA.
          </p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Group calls</span> — live rooms and
            conferences, alongside the 1v1 video chat.
          </p>
        </div>
      </div>
    );
  }

  const since = memberSince(account.createdAt);
  const likesReceived = posts.reduce((sum, post) => sum + post.likes, 0);
  const gender = account.profile?.gender ? account.profile.gender : null;

  return (
    <div className="space-y-4">
      {/* The banner is the page's identity line — `@name` is the h1 here, so
          the card below keeps its own heading out of the way. */}
      <HeroBanner
        img="/img/hero-profile.webp"
        eyebrow="You on Matchup"
        title={`@${account.username}`}
        text="Your posts, your earnings and everything you have shared live on this page."
      />

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {error.message}
        </div>
      )}

      {/* ── Identity ────────────────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex items-center gap-4">
          <span className="relative block h-14 w-14 shrink-0">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/20 text-xl font-black text-accent">
              {account.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="absolute -bottom-1 -right-1 text-lg leading-none">
              {flagFromCountry(account.profile?.country ?? 'KE')}
            </span>
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {account.profile?.age ?? '—'} years old
              {gender ? ` · ${gender}` : ''}
            </p>
            {since && <p className="text-xs text-muted">Member since {since}</p>}
          </div>
        </div>

        {canAck && (
          <button
            type="button"
            className="btn btn-ghost mt-4 w-full text-xs"
            onClick={acknowledgeAdult}
          >
            I&apos;m 18 or over — show adult posts
          </button>
        )}
      </div>

      {/* ── Creator stats ───────────────────────────────────────────────── */}
      {/* Stacked under `sm`: "KES 1,500,000" does not fit a 90px cell. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide text-muted">Balance</p>
          {/* A missing wallet is "unknown", not "zero" — never fake a balance. */}
          <p className="mt-1 text-lg font-bold tabular-nums text-ok">
            {wallet ? formatKes(wallet.balance) : '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {wallet ? `${formatKes(wallet.lifetimeIn)} lifetime in` : 'wallet'}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide text-muted">My posts</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-ink">
            {loading ? '—' : error && posts.length === 0 ? '—' : total}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">published</p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide text-muted">Likes</p>
          {/* Sum of the rows actually loaded — no server-side aggregate exists,
              so the hint keeps the number honest instead of implying "all time". */}
          <p className="mt-1 text-lg font-bold tabular-nums text-danger">
            {loading ? '—' : error && posts.length === 0 ? '—' : likesReceived}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">on posts shown</p>
        </div>
      </div>

      {/* ── My posts ────────────────────────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label">My posts</p>
          {posts.length > 0 && (
            <p className="text-[11px] text-muted">
              {posts.length} of {total} loaded
            </p>
          )}
        </div>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card animate-pulse space-y-3 p-4">
                <div className="h-28 rounded-xl bg-white/10" />
                <div className="h-3 w-2/3 rounded bg-white/10" />
              </div>
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm font-semibold text-ink">
              {error ? 'Your posts could not be loaded' : 'You have not posted yet'}
            </p>
            <p className="mt-1 text-xs text-muted">
              {error
                ? error.message
                : 'Your posts will appear here — free or paid, they are yours to manage.'}
            </p>
            {!error && (
              <Link to="/create" className="btn btn-primary mt-4">
                Create your first post
              </Link>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <article
                key={post.id}
                className="card cursor-pointer overflow-hidden transition-colors hover:border-white/20"
                onClick={() => navigate(`/post/${post.id}`)}
              >
                {(post.type === 'image' || post.type === 'video') && post.mediaUrl ? (
                  post.type === 'image' ? (
                    <img
                      src={post.mediaUrl}
                      alt={post.caption || 'Your post'}
                      loading="lazy"
                      className="photo h-28 w-full"
                    />
                  ) : (
                    <video
                      src={post.mediaUrl}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-28 w-full bg-black object-contain"
                    />
                  )
                ) : (
                  <div className="flex h-14 items-center justify-center gap-2 bg-white/5 text-[11px] uppercase tracking-wide text-muted">
                    {post.type === 'text' ? 'Text' : post.type === 'link' ? 'Link' : 'Media'}
                  </div>
                )}

                <div className="p-3">
                  <p className="line-clamp-2 text-sm leading-snug text-ink">
                    {post.caption || 'Untitled post'}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                    <span>{timeAgo(post.createdAt)}</span>
                    <span className="inline-flex items-center gap-1">
                      <HeartIcon className="h-3.5 w-3.5" />
                      {post.likes}
                    </span>
                    {post.price > 0 && (
                      <span className="inline-flex items-center gap-1 text-accent">
                        <LockIcon className="h-3.5 w-3.5" />
                        {formatKes(post.price)}
                      </span>
                    )}
                    <span
                      className={`ml-auto rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        post.status === 'active'
                          ? 'border-ok/30 bg-ok/10 text-ok'
                          : post.status === 'hidden'
                            ? 'border-warn/30 bg-warn/10 text-warn'
                            : 'border-danger/30 bg-danger/10 text-danger'
                      }`}
                    >
                      {post.status}
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {!loading && posts.length > 0 && posts.some((p) => p.status !== 'active') && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Hidden posts stay on this page only — nobody else can open them, not even in search.
          </p>
        )}
      </div>

      {/* ── Quick actions ───────────────────────────────────────────────── */}
      <div>
        <p className="label">Quick actions</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ActionCard to="/create" icon={PlusIcon} title="Create post" text="Photo, video, link or text" />
          <ActionCard
            to="/wallet"
            icon={WalletIcon}
            title="Earnings"
            text={wallet ? `${formatKes(wallet.balance)} available` : 'Balance and withdrawals'}
          />
          <ActionCard to="/settings" icon={SettingsIcon} title="Settings" text="Account and adult content" />
          <ActionCard to="/match" icon={CamIcon} title="Start a 1v1 match" text="Video chat with a stranger" />
        </div>

        <button
          type="button"
          className="btn btn-ghost mt-3 w-full text-danger"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut && <SpinnerIcon className="h-4 w-4" />}
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {error && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted">
            <AlertIcon className="h-3.5 w-3.5" />
            Some numbers above could not be loaded.
          </p>
        )}
      </div>
    </div>
  );
}

interface ActionCardProps {
  to: string;
  icon: (props: { className?: string }) => ReactNode;
  title: string;
  text: string;
}

function ActionCard({ to, icon: Icon, title, text }: ActionCardProps) {
  return (
    <Link
      to={to}
      className="card flex items-center gap-3 p-4 transition-colors hover:border-accent/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{text}</span>
      </span>
    </Link>
  );
}

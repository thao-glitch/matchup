/**
 * Creator — one public profile: audience counts, follow, and the creator's
 * subscription offer (free or paid, decided by the creator in their own
 * profile settings).
 *
 * The server is the only authority on access: a paid post's `owned` flag is
 * already true for an active subscriber, so this page never decides what is
 * locked — it renders what the wire says. A priced subscription reuses the
 * same M-PESA sheet as posts and rooms.
 */
import { useEffect, useState } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Creator, PayTarget, Post } from '../types/social';
import {
  SocialError,
  cancelCreatorSubscription,
  followCreator,
  formatKes,
  getCreator,
  listPosts,
  subscribeToCreator,
  timeAgo,
} from '../lib/social';
import { Link, navigate } from '../lib/router';
import { mediaSrc } from '../lib/mediaUrl';
import MediaImg from '../components/MediaImg';
import Avatar from '../components/Avatar';
import PaySheet from '../components/PaySheet';
import {
  ArrowLeftIcon,
  HeartIcon,
  LockIcon,
  SpinnerIcon,
  flagFromCountry,
} from '../components/icons';

interface ErrState {
  message: string;
  code: string;
}

function toError(err: unknown): ErrState {
  return err instanceof SocialError
    ? { message: err.message, code: err.code }
    : { message: 'Something went wrong — please try again.', code: 'client' };
}

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

function expiry(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export default function CreatorPage({
  account,
  config,
  params,
  requireAuth,
  adultOk,
}: PageProps) {
  const id = Number(params.id);
  const [creator, setCreator] = useState<Creator | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrState | null>(null);
  const [busy, setBusy] = useState(false);
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);

  const load = () => {
    if (!Number.isFinite(id) || id <= 0) {
      setLoading(false);
      setError({ message: 'That creator does not exist.', code: 'not-found' });
      return () => undefined;
    }
    let dead = false;
    setLoading(true);
    setError(null);
    Promise.all([getCreator(id), listPosts({ creatorId: id, size: 20, adult: adultOk })])
      .then(([card, feed]) => {
        if (dead) return;
        setCreator(card.creator);
        setPosts(feed.items);
      })
      .catch((err: unknown) => {
        if (!dead) setError(toError(err));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  };

  useEffect(load, [id, adultOk]);

  async function toggleFollow() {
    if (!creator || busy) return;
    if (!requireAuth('Sign in to follow creators.')) return;
    const next = !creator.viewer.following;
    const before = creator;
    setBusy(true);
    setCreator({
      ...creator,
      followers: Math.max(0, creator.followers + (next ? 1 : -1)),
      viewer: { ...creator.viewer, following: next },
    });
    try {
      const res = await followCreator(creator.id, next);
      setCreator((current) =>
        current
          ? {
              ...current,
              followers: res.followers,
              viewer: { ...current.viewer, following: res.following },
            }
          : current,
      );
    } catch (err) {
      setCreator(before);
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  }

  async function subscribeFree() {
    if (!creator || busy) return;
    if (!requireAuth('Sign in to subscribe.')) return;
    setBusy(true);
    setError(null);
    try {
      await subscribeToCreator(creator.id);
      const card = await getCreator(creator.id);
      setCreator(card.creator);
      const feed = await listPosts({ creatorId: creator.id, size: 20, adult: adultOk });
      setPosts(feed.items);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSubscription() {
    if (!creator || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelCreatorSubscription(creator.id);
      const card = await getCreator(creator.id);
      setCreator(card.creator);
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  }

  function startPaidSubscription() {
    if (!creator) return;
    if (!requireAuth('Sign in to subscribe.')) return;
    setPayTarget({
      purpose: 'sub',
      refId: creator.id,
      amount: creator.subscription.price,
      currency: creator.subscription.currency,
      title: `Subscribe to @${creator.username}`,
      periodDays: creator.subscription.periodDays,
    });
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-3" aria-hidden="true">
        <div className="card h-36 animate-pulse" />
        <div className="card h-24 animate-pulse" />
      </div>
    );
  }

  if (!creator) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <div className="card p-6 text-center">
          <p className="text-sm font-semibold text-ink">
            {error?.code === 'not-found' ? 'Creator not found' : 'Could not load this creator'}
          </p>
          <p className="mt-1 text-xs text-muted">
            {error?.message ?? 'The profile may have been removed.'}
          </p>
          <button type="button" className="btn btn-ghost mt-4" onClick={() => navigate('/')}>
            Back to the feed
          </button>
        </div>
      </div>
    );
  }

  const offer = creator.subscription;
  const subscribed = creator.viewer.subscribed;
  const activeUntil = creator.viewer.subscription?.expiresAt ?? null;
  const since = memberSince(creator.createdAt);
  const isSelf = creator.viewer.isSelf;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button
        type="button"
        className="btn btn-ghost -ml-1 inline-flex items-center gap-1.5 px-2 py-1 text-xs"
        onClick={() => navigate('/')}
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back
      </button>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {error.message}
        </div>
      )}

      {creator.banned && (
        <div className="rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-sm text-warn">
          This account is unavailable. You cannot follow or subscribe to it.
        </div>
      )}

      {/* ── Identity + actions ──────────────────────────────────────────── */}
      <section className="card overflow-hidden p-0">
        {/* The creator's own background, then their face over it — the same
            two photos the feed cards and this page's header share. */}
        <div
          className="h-32 w-full bg-cover bg-center"
          style={{
            backgroundImage: creator.bannerUrl
              ? `url("${mediaSrc(creator.bannerUrl)}")`
              : 'linear-gradient(120deg, rgba(109,153,255,.22), rgba(106,59,216,.18))',
          }}
          aria-hidden="true"
        />
        <div className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar
            username={creator.username}
            src={creator.avatarUrl}
            className="-mt-12 h-16 w-16 ring-4 ring-[#10121c]"
            letterClass="text-2xl"
          >
            <span className="text-xl leading-none">{flagFromCountry(creator.country || 'KE')}</span>
          </Avatar>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-ink">@{creator.username}</h1>
            <p className="mt-0.5 text-xs text-muted">
              {since ? `Member since ${since}` : 'Matchup creator'}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span>
                <strong className="tabular-nums text-ink">{creator.followers}</strong> followers
              </span>
              <span>
                <strong className="tabular-nums text-ink">{creator.following}</strong> following
              </span>
              <span>
                <strong className="tabular-nums text-ink">{creator.posts}</strong> posts
              </span>
              {offer.enabled && (
                <span>
                  <strong className="tabular-nums text-ink">{creator.subscribers}</strong>{' '}
                  subscribers
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {!isSelf && !creator.banned && (
              <button
                type="button"
                className={`btn ${creator.viewer.following ? 'btn-ghost' : 'btn-primary'} px-4 py-2 text-xs`}
                onClick={() => void toggleFollow()}
                disabled={busy}
              >
                {busy && <SpinnerIcon className="h-4 w-4" />}
                {creator.viewer.following ? 'Following' : 'Follow'}
              </button>
            )}

            {creator.banned ? null : isSelf ? (
              <Link to="/profile" className="btn btn-ghost px-4 py-2 text-xs">
                Manage subscription
              </Link>
            ) : subscribed ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs font-semibold text-ok">
                  Subscribed{activeUntil ? ` · until ${expiry(activeUntil)}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost px-3 py-1.5 text-xs"
                  onClick={() => void cancelSubscription()}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            ) : offer.enabled ? (
              <button
                type="button"
                className="btn btn-primary px-4 py-2 text-xs"
                onClick={() => (offer.price > 0 ? startPaidSubscription() : void subscribeFree())}
                disabled={busy}
              >
                {busy && <SpinnerIcon className="h-4 w-4" />}
                {offer.price > 0
                  ? `Subscribe · ${formatKes(offer.price)}`
                  : 'Subscribe free'}
              </button>
            ) : (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted">
                Subscriptions off
              </span>
            )}
          </div>
        </div>

        {offer.enabled && !creator.banned && (
          <div className="mt-4 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">
              {offer.price > 0
                ? `${formatKes(offer.price)} · every ${offer.periodDays} days`
                : `Free · every ${offer.periodDays} days`}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-ink">
              {offer.perk || 'Subscribers unlock this creator’s paid posts.'}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              An active subscription unlocks every paid post from @{creator.username}.
            </p>
          </div>
        )}
        </div>
      </section>

      {/* ── Posts ───────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between gap-2">
          <p className="label">Posts</p>
          <p className="text-[11px] text-muted">{creator.posts} published</p>
        </div>

        {posts.length === 0 ? (
          <div className="card p-6 text-center text-sm text-muted">
            @{creator.username} has not posted yet.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {posts.map((post) => (
              <article
                key={post.id}
                className="card cursor-pointer overflow-hidden transition-colors hover:border-white/20"
                onClick={() => navigate(`/post/${post.id}`)}
              >
                {(post.type === 'image' || post.type === 'video') && post.mediaUrl ? (
                  post.type === 'image' ? (
                    <MediaImg
                      src={mediaSrc(post.mediaUrl)}
                      alt={post.caption || 'Post'}
                      className="photo h-36 w-full"
                    />
                  ) : (
                    <video
                      src={mediaSrc(post.mediaUrl)}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-36 w-full bg-black object-contain"
                    />
                  )
                ) : (
                  <div className="flex h-16 items-center justify-center gap-2 bg-white/5 text-[11px] uppercase tracking-wide text-muted">
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
                        {post.owned ? 'Unlocked' : formatKes(post.price)}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {payTarget && (
        <PaySheet
          target={payTarget}
          config={config}
          account={account}
          onRequireAuth={() => requireAuth('Sign in to subscribe.')}
          onPaid={() => {
            setPayTarget(null);
            const card = getCreator(creator.id);
            const feed = listPosts({ creatorId: creator.id, size: 20, adult: adultOk });
            void Promise.all([card, feed]).then(([c, f]) => {
              setCreator(c.creator);
              setPosts(f.items);
            });
          }}
          onClose={() => setPayTarget(null)}
        />
      )}

    </div>
  );
}

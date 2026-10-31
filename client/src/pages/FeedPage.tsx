/**
 * Feed — the platform's front page: newest posts first, ten at a time, with
 * the 18+ switch that decides whether the server includes adult rows at all.
 *
 * Reading is open to anyone (the API allows it signed out), so nothing here
 * forces a sign-in — only liking does, because a like is a row keyed by
 * account. Refresh and the adult switch both restart from page 1: a changed
 * filter makes every already-loaded page stale.
 */
import { useEffect, useState } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Post } from '../types/social';
import { SocialError, formatKes, likePost, listPosts, timeAgo } from '../lib/social';
import { Link, navigate } from '../lib/router';
import { mediaSrc } from '../lib/mediaUrl';
import MediaImg from '../components/MediaImg';
import CreatorActions from '../components/CreatorActions';
import {
  CommentIcon,
  GlobeIcon,
  HeartIcon,
  LockIcon,
  SpinnerIcon,
  flagFromCountry,
} from '../components/icons';

/** Two screens of scrolling per request — big enough to feel instant. */
const PAGE_SIZE = 10;

interface ErrState {
  message: string;
  code: string;
}

/** Server messages are written for humans — show them verbatim. */
function toError(err: unknown): ErrState {
  return err instanceof SocialError
    ? { message: err.message, code: err.code }
    : { message: 'Something went wrong — please try again.', code: 'client' };
}

export default function FeedPage({
  account,
  config,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const social = config.commerce.social;
  const [items, setItems] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ErrState | null>(null);
  const [adult, setAdult] = useState(false);
  /** Refresh bumps this — one effect owns every reload of page 1. */
  const [nonce, setNonce] = useState(0);

  // The server rejects adult rows for the same viewers this gate rejects, so
  // the acknowledge button is only rendered where it can actually unblock.
  const canAck = Boolean(
    config.commerce.adult && account && Number(account.profile?.age) >= 18 && !adultOk,
  );

  useEffect(() => {
    if (!social) return;
    let dead = false;
    setLoading(true);
    setError(null);
    listPosts({ page: 1, size: PAGE_SIZE, adult })
      .then((res) => {
        if (dead) return;
        setItems(res.items);
        setTotal(res.total);
        setPage(1);
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
  }, [social, adult, nonce]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listPosts({ page: page + 1, size: PAGE_SIZE, adult });
      // Dedupe: rows shift forward while the viewer scrolls, so a page
      // boundary can hand back something already on screen.
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...res.items.filter((p) => !seen.has(p.id))];
      });
      setPage(res.page);
    } catch (err) {
      setError(toError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  /** Optimistic: the heart flips now, the server reply is the final word. */
  function toggleLike(post: Post) {
    if (!requireAuth('Sign in to like posts.')) return;
    const next = !post.liked;
    const settle = (liked: boolean, likes: number) =>
      setItems((prev) =>
        prev.map((p) => (p.id === post.id ? { ...p, liked, likes } : p)),
      );
    settle(next, Math.max(0, post.likes + (next ? 1 : -1)));
    likePost(post.id, next)
      .then((res) => settle(res.liked, res.likes))
      .catch((err: unknown) => {
        settle(post.liked, post.likes); // roll back to what the server has
        setError(toError(err));
      });
  }

  if (!social) {
    return (
      <div className="card p-6">
        <h1 className="text-lg font-bold text-ink">Feed</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Posts are switched off on this platform for now — the feed is paused, but 1v1 video
          chat still works.
        </p>
        <Link to="/match" className="btn btn-ghost mt-4">
          Open 1v1 video chat
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Hero: a photographic banner over the crowd shot, scrimmed so the
             type stays readable at every width. Purely presentational — the
             controls live in the header right below it. */}
      <section className="relative overflow-hidden rounded-3xl border border-white/10" aria-hidden="true">
        <img
          src="/img/hero-feed.webp"
          alt=""
          loading="eager"
          className="photo h-40 w-full sm:h-56"
        />
        <div className="absolute inset-0 photo-scrim" />
        <div className="absolute inset-0 flex flex-col justify-end p-5 sm:p-7">
          <p className="animate-rise-in text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            Creators · Fans · M-PESA
          </p>
          <h1 className="animate-rise-in mt-1.5 max-w-xl text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Something is always happening here
          </h1>
          <p className="animate-rise-in mt-1 max-w-md text-sm leading-relaxed text-muted">
            Free posts, paid drops and everything in between — unlock what you like with one tap.
          </p>
        </div>
      </section>

      {/* ── Header: count, adult switch, refresh ─────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Feed</h2>
          <p className="text-xs text-muted">
            {loading ? 'Loading…' : `${total} post${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {config.commerce.adult &&
            (canAck ? (
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                onClick={acknowledgeAdult}
              >
                I&apos;m 18 or over — show adult posts
              </button>
            ) : adultOk ? (
              <button
                type="button"
                className={`btn px-3 py-1.5 text-xs ${adult ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={adult}
                onClick={() => setAdult((on) => !on)}
              >
                18+ posts {adult ? 'on' : 'off'}
              </button>
            ) : null)}
          <button
            type="button"
            className="btn btn-ghost px-3 py-1.5 text-xs"
            disabled={loading}
            onClick={() => setNonce((n) => n + 1)}
          >
            {loading && <SpinnerIcon className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          <p>{error.message}</p>
          {error.code === 'adult-only' && canAck && (
            <button
              type="button"
              className="btn btn-ghost mt-2 px-3 py-1.5 text-xs"
              onClick={() => {
                acknowledgeAdult();
                setError(null);
                setNonce((n) => n + 1);
              }}
            >
              I&apos;m 18 or over — show adult posts
            </button>
          )}
        </div>
      )}

      {/* ── Loading: pulse skeletons shaped like the real cards ─────────── */}
      {loading && (
        <div className="space-y-4" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card animate-pulse space-y-3 p-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-white/10" />
                <div className="h-3 w-28 rounded bg-white/10" />
              </div>
              <div className="h-44 rounded-xl bg-white/10" />
              <div className="h-3 w-2/3 rounded bg-white/10" />
            </div>
          ))}
        </div>
      )}

      {/* ── Empty ───────────────────────────────────────────────────────── */}
      {!loading && items.length === 0 && !error && (
        <div className="card overflow-hidden text-center">
          <div className="relative">
            <img
              src="/img/empty-feed.webp"
              alt=""
              loading="lazy"
              className="photo h-40 w-full sm:h-52"
            />
            <div className="absolute inset-0 photo-scrim" />
          </div>
          <div className="p-6 pt-4">
            <p className="text-sm font-semibold text-ink">Nothing here yet — be the first to post</p>
            <p className="mt-1 text-xs text-muted">Photos, videos, links or plain text — free or paid.</p>
            <Link to="/create" className="btn btn-primary mt-4">
              Create a post
            </Link>
          </div>
        </div>
      )}

      {/* ── Posts ───────────────────────────────────────────────────────── */}
      {!loading && items.length > 0 && (
        <>
          <div className="space-y-4">
            {items.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                account={account}
                config={config}
                requireAuth={requireAuth}
                onLike={toggleLike}
                onComment={(p) => navigate(`/post/${p.id}`)}
              />
            ))}
          </div>

          <div className="flex items-center justify-center gap-3 pt-1">
            {items.length < total ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore && <SpinnerIcon className="h-4 w-4" />}
                Load more ({items.length} of {total})
              </button>
            ) : (
              <p className="text-xs text-muted">That&apos;s every post — {total} in total.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

interface PostCardProps {
  post: Post;
  account: PageProps['account'];
  config: PageProps['config'];
  requireAuth: PageProps['requireAuth'];
  onLike: (post: Post) => void;
  onComment: (post: Post) => void;
}

/**
 * One feed row. The whole card opens the detail page (the media behind a
 * paywall never carries its own link — the paywall lives on the detail page),
 * so anything interactive inside stops propagation.
 */
function PostCard({ post, account, config, requireAuth, onLike, onComment }: PostCardProps) {
  const locked = post.price > 0 && !post.owned;
  const hideMedia = post.type === 'image' || post.type === 'video';
  const open = () => navigate(`/post/${post.id}`);
  const showActions = !post.creatorBanned && account?.id !== post.creatorId;
  const offer = post.creatorSubscription ?? {
    enabled: false,
    price: 0,
    currency: post.currency,
    periodDays: 30,
  };

  return (
    <article
      className="card cursor-pointer overflow-hidden transition-colors hover:border-white/20"
      onClick={open}
    >
      {/* Creator row */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <span className="relative block h-9 w-9 shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-accent/40 to-accent-2/40 ring-2 ring-accent/30 text-sm font-bold text-ink">
            {post.creatorName.slice(0, 1).toUpperCase()}
          </span>
          <span className="absolute -bottom-1 -right-1 text-xs leading-none">
            {flagFromCountry(post.creatorCountry)}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/creator/${post.creatorId}`}
            onClick={(event) => event.stopPropagation()}
            className="block truncate text-sm font-semibold text-ink hover:underline"
          >
            @{post.creatorName}
          </Link>
          <p className="text-xs text-muted">{timeAgo(post.createdAt)}</p>
          {showActions && (
            <div className="mt-1.5">
              <CreatorActions
                creatorId={post.creatorId}
                creatorName={post.creatorName}
                creatorBanned={post.creatorBanned}
                following={Boolean(post.creatorFollowing)}
                subscribed={Boolean(post.creatorSubscribed)}
                offer={offer}
                account={account}
                config={config}
                requireAuth={requireAuth}
                compact
              />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {post.isAdult && (
            <span className="rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold text-warn">
              18+
            </span>
          )}
          {locked && (
            <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">
              <LockIcon className="h-3 w-3" />
              {formatKes(post.price)} to view
            </span>
          )}
        </div>
      </div>

      {/* Media — the card's overflow-hidden does the rounding */}
      {hideMedia && (
        <div className="mt-3">
          {post.mediaUrl && post.type === 'image' && (
            <MediaImg
              src={mediaSrc(post.mediaUrl)}
              alt={post.caption || 'Post image'}
              className="photo max-h-[70vh] w-full"
            />
          )}
          {post.mediaUrl && post.type === 'video' && (
            /* Controls stay clickable in the feed: without this the play
               button's click would bubble into the card's navigation. */
            <video
              src={mediaSrc(post.mediaUrl)}
              controls
              playsInline
              preload="metadata"
              onClick={(event) => event.stopPropagation()}
              className="max-h-[70vh] w-full bg-black object-contain"
            />
          )}
          {!post.mediaUrl && locked && (
            <div className="flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-accent/30 to-accent-2/20 px-4 py-10 text-center">
              <LockIcon className="h-6 w-6 text-ink" />
              <p className="text-sm font-semibold text-ink">Unlock for {formatKes(post.price)}</p>
              <p className="text-xs text-muted">Open the post to pay with M-PESA</p>
            </div>
          )}
          {!post.mediaUrl && !locked && (
            <div className="flex items-center justify-center gap-2 bg-white/5 px-4 py-8 text-xs text-muted">
              Media unavailable
            </div>
          )}
        </div>
      )}

      {post.type === 'link' && post.linkUrl && (
        <a
          href={post.linkUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="mx-4 mt-3 inline-flex max-w-full items-center gap-2 rounded-xl border border-white/10 bg-surface-3/60 px-3 py-2 text-xs text-accent transition-colors hover:bg-white/10"
        >
          <GlobeIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{post.linkUrl}</span>
        </a>
      )}

      {post.type === 'text' ? (
        <p className="line-clamp-6 whitespace-pre-line px-4 pt-3 text-base leading-relaxed text-ink">
          {post.caption}
        </p>
      ) : (
        post.caption && (
          <p className="line-clamp-3 px-4 pt-3 text-sm leading-relaxed text-muted">{post.caption}</p>
        )
      )}

      {/* Footer */}
      <div className="mt-3 flex items-center gap-1 border-t border-white/10 px-2 py-2 text-xs text-muted">
        <button
          type="button"
          aria-pressed={post.liked}
          aria-label={post.liked ? 'Unlike this post' : 'Like this post'}
          className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/5 ${
            post.liked ? 'text-danger' : ''
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onLike(post);
          }}
        >
          <HeartIcon className={`h-4.5 w-4.5 ${post.liked ? 'fill-danger' : ''}`} />
          <span className="tabular-nums">{post.likes}</span>
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/5"
          onClick={(event) => {
            event.stopPropagation();
            onComment(post);
          }}
        >
          <CommentIcon className="h-4.5 w-4.5" />
          <span className="tabular-nums">{post.comments}</span>
        </button>
        <span className="px-2 py-1.5 tabular-nums">
          {post.views} view{post.views === 1 ? '' : 's'}
        </span>
        <Link
          to={`/post/${post.id}`}
          className="ml-auto rounded-lg bg-white/5 px-2.5 py-1.5 font-semibold text-accent transition-colors hover:bg-accent/20"
          onClick={(event) => event.stopPropagation()}
        >
          {locked ? 'Unlock' : 'View'}
        </Link>
      </div>
    </article>
  );
}

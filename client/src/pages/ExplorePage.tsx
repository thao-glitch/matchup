/**
 * Explore — search the public post index, then narrow it with client-side
 * chips (All / Free / Paid) over whatever has already loaded.
 *
 * The page browses on arrival (no query = newest posts) so it is never an
 * empty box, and the quick-link cards at the bottom are pure navigation: the
 * social feed, the live rooms and the original 1v1 chat all live one tap away
 * from here. No invented "top creators" — the API has no such ranking and a
 * fabricated one would be worse than none.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Post } from '../types/social';
import { SocialError, formatKes, likePost, listPosts, timeAgo } from '../lib/social';
import { Link, navigate } from '../lib/router';
import { mediaSrc } from '../lib/mediaUrl';
import MediaImg from '../components/MediaImg';
import Avatar from '../components/Avatar';
import CreatorActions from '../components/CreatorActions';
import {
  CommentIcon,
  GlobeIcon,
  HeartIcon,
  LockIcon,
  SearchIcon,
  SpinnerIcon,
  flagFromCountry,
} from '../components/icons';

const PAGE_SIZE = 12;

type Filter = 'all' | 'free' | 'paid';

interface ErrState {
  message: string;
  code: string;
}

function toError(err: unknown): ErrState {
  return err instanceof SocialError
    ? { message: err.message, code: err.code }
    : { message: 'Something went wrong — please try again.', code: 'client' };
}

export default function ExplorePage({
  account,
  config,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const social = config.commerce.social;
  const [query, setQuery] = useState('');
  /** The submitted search, kept apart from the input so results change on Enter only. */
  const [active, setActive] = useState('');
  const [adult, setAdult] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<Post[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ErrState | null>(null);
  const [nonce, setNonce] = useState(0);

  const canAck = Boolean(
    config.commerce.adult && account && Number(account.profile?.age) >= 18 && !adultOk,
  );

  useEffect(() => {
    if (!social) return;
    let dead = false;
    setLoading(true);
    setError(null);
    listPosts({ page: 1, size: PAGE_SIZE, q: active || undefined, adult })
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
  }, [social, active, adult, nonce]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setActive(query.trim());
    setNonce((n) => n + 1);
  }

  function clearSearch() {
    setQuery('');
    setActive('');
    setNonce((n) => n + 1);
  }

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listPosts({
        page: page + 1,
        size: PAGE_SIZE,
        q: active || undefined,
        adult,
      });
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

  /** Optimistic — the heart flips now and the server reply is the final word. */
  function toggleLike(post: Post) {
    if (!requireAuth('Sign in to like posts.')) return;
    const next = !post.liked;
    const settle = (liked: boolean, likes: number) =>
      setItems((prev) => prev.map((p) => (p.id === post.id ? { ...p, liked, likes } : p)));
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
        <h1 className="text-lg font-bold text-ink">Explore</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Searching posts is switched off on this platform right now.
        </p>
        <Link to="/match" className="btn btn-ghost mt-4">
          Open 1v1 video chat
        </Link>
      </div>
    );
  }

  // The chips only re-cut what is already on screen — cheap, and the header
  // count stays the server's number, never a guess.
  const visible =
    filter === 'free'
      ? items.filter((p) => p.price === 0)
      : filter === 'paid'
        ? items.filter((p) => p.price > 0)
        : items;

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'free', label: 'Free' },
    { key: 'paid', label: 'Paid' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Explore</h1>
          <p className="text-xs text-muted">
            {loading
              ? 'Searching…'
              : `${total} post${total === 1 ? '' : 's'}${active ? ` for “${active}”` : ''}`}
          </p>
        </div>
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
      </div>

      {/* ── Search + filters ────────────────────────────────────────────── */}
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            className="field pl-9"
            type="search"
            placeholder="Search captions and creators"
            aria-label="Search posts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary px-4">
          Search
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            aria-pressed={filter === chip.key}
            className={`btn px-3 py-1.5 text-xs ${filter === chip.key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilter(chip.key)}
          >
            {chip.label}
          </button>
        ))}
        {active && (
          <button
            type="button"
            className="btn btn-ghost max-w-[60vw] truncate px-3 py-1.5 text-xs"
            onClick={clearSearch}
          >
            Clear “{active}”
          </button>
        )}
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

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card animate-pulse space-y-3 p-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-white/10" />
                <div className="h-3 w-24 rounded bg-white/10" />
              </div>
              <div className="h-32 rounded-xl bg-white/10" />
            </div>
          ))}
        </div>
      )}

      {!loading && visible.length > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {visible.map((post) => (
              <ExploreCard
                key={post.id}
                post={post}
                account={account}
                config={config}
                requireAuth={requireAuth}
                onLike={toggleLike}
              />
            ))}
          </div>
          <div className="flex justify-center">
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
              <p className="text-xs text-muted">
                End of the results — {items.length} of {total} shown.
              </p>
            )}
          </div>
        </>
      )}

      {/* Chips hide rows client-side, so "nothing matches" here means the
          filter, not the server — word it that way. */}
      {!loading && visible.length === 0 && items.length > 0 && (
        <div className="card p-6 text-center text-sm text-muted">
          No {filter === 'free' ? 'free' : 'paid'} posts in these results yet — try the All chip.
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-ink">
            {active ? `No posts match “${active}”.` : 'Nothing has been posted yet.'}
          </p>
          <p className="mt-1 text-xs text-muted">
            {active
              ? 'Try a shorter word — search looks at captions and creator names.'
              : 'Be the first — a photo, a clip, a link or a few words.'}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {active && (
              <button type="button" className="btn btn-ghost" onClick={clearSearch}>
                Clear search
              </button>
            )}
            <Link to="/create" className="btn btn-primary">
              Create a post
            </Link>
          </div>
        </div>
      )}

      {/* ── Quick links: the rest of the platform, one tap away ─────────── */}
      <div>
        <p className="label">Jump to</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <PhotoLinkCard
            to="/live"
            img="/img/link-live.webp"
            title="Live rooms"
            text="Group calls and 18+ conferences"
          />
          <PhotoLinkCard
            to="/create"
            img="/img/link-create.webp"
            title="Post content"
            text="Photo, video, link or text"
          />
          <PhotoLinkCard
            to="/match"
            img="/img/link-match.webp"
            title="Random 1v1"
            text="Video chat with a stranger"
          />
        </div>
      </div>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

interface CardProps {
  post: Post;
  account: PageProps['account'];
  config: PageProps['config'];
  requireAuth: PageProps['requireAuth'];
  onLike: (post: Post) => void;
}

/** Compact result tile — same paywall rules as the feed, half the height. */
function ExploreCard({ post, account, config, requireAuth, onLike }: CardProps) {
  const locked = post.price > 0 && !post.owned;
  const hasMedia = (post.type === 'image' || post.type === 'video') && post.mediaUrl;
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
      onClick={() => navigate(`/post/${post.id}`)}
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <Avatar
          username={post.creatorName}
          src={post.creatorAvatarUrl}
          className="h-8 w-8 ring-2 ring-accent/30"
          letterClass="text-xs"
        >
          <span className="text-[11px] leading-none">{flagFromCountry(post.creatorCountry)}</span>
        </Avatar>
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
              {formatKes(post.price)}
            </span>
          )}
        </div>
      </div>

      {post.type !== 'text' && (
        <div className="mt-3">
          {hasMedia && post.type === 'image' && (
            <MediaImg
              src={mediaSrc(post.mediaUrl)}
              alt={post.caption || 'Post image'}
              className="photo max-h-52 w-full"
            />
          )}
          {hasMedia && post.type === 'video' && (
            <video
              src={mediaSrc(post.mediaUrl)}
              preload="metadata"
              muted
              playsInline
              className="max-h-52 w-full bg-black object-contain"
            />
          )}
          {!hasMedia && locked && (
            <div className="flex items-center justify-center gap-2 bg-gradient-to-br from-accent/30 to-accent-2/20 px-4 py-7 text-center text-sm font-semibold text-ink">
              <LockIcon className="h-4 w-4" />
              Unlock for {formatKes(post.price)}
            </div>
          )}
          {!hasMedia && !locked && post.type === 'link' && post.linkUrl && (
            <a
              href={post.linkUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="mx-4 inline-flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border border-white/10 bg-surface-3/60 px-3 py-2 text-xs text-accent transition-colors hover:bg-white/10"
            >
              <GlobeIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{post.linkUrl}</span>
            </a>
          )}
          {!hasMedia && !locked && post.type === 'link' && !post.linkUrl && (
            <div className="px-4 text-xs text-muted">Link post</div>
          )}
          {!hasMedia && !locked && (post.type === 'video' || post.type === 'image') && (
            <div className="flex items-center justify-center gap-2 bg-white/5 px-4 py-6 text-xs text-muted">
              Media unavailable
            </div>
          )}
        </div>
      )}

      {post.caption && (
        <p
          className={`line-clamp-2 px-4 pt-3 ${
            post.type === 'text' ? 'text-sm text-ink' : 'text-sm text-muted'
          }`}
        >
          {post.caption}
        </p>
      )}

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
          <HeartIcon className={`h-4 w-4 ${post.liked ? 'fill-danger' : ''}`} />
          <span className="tabular-nums">{post.likes}</span>
        </button>
        <span className="flex items-center gap-1.5 px-2 py-1.5">
          <CommentIcon className="h-4 w-4" />
          <span className="tabular-nums">{post.comments}</span>
        </span>
        <span className="px-2 py-1.5 tabular-nums">{post.views} views</span>
        <span className="ml-auto rounded-lg bg-white/5 px-2.5 py-1.5 font-semibold text-accent">
          {locked ? 'Unlock' : 'View'}
        </span>
      </div>
    </article>
  );
}

interface PhotoLinkCardProps {
  to: string;
  img: string;
  title: string;
  text: string;
}

/**
 * Photo tile — a real image under a scrim, title bottom-left. The whole tile
 * is the link; `.group` + `.photo-link` give the slow zoom on hover.
 */
function PhotoLinkCard({ to, img, title, text }: PhotoLinkCardProps) {
  return (
    <Link
      to={to}
      className="group relative block h-36 overflow-hidden rounded-2xl border border-white/10 transition-colors hover:border-accent/40"
    >
      <img src={img} alt="" loading="lazy" className="photo-link absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 photo-scrim" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <span className="block text-sm font-bold text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{text}</span>
      </div>
      <span className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        Open
      </span>
    </Link>
  );
}

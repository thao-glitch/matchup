/**
 * PostDetail — one post behind its paywall, plus the conversation under it.
 *
 * The paywall is entirely server-driven: `GET /api/posts/:id` hands back
 * `mediaUrl: null` until a paid charge exists for this viewer, so the page
 * never decides what is locked — it only renders the locked card the wire
 * describes. Unlocking opens `PaySheet`, and `onPaid` simply refetches: if the
 * charge settled, the same endpoint now returns the media.
 *
 * `payment-required` on a refetch is therefore not an error worth a red box —
 * the row we already hold (locked) is still the truth, so we keep showing it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Comment, Post } from '../types/social';
import {
  SocialError,
  addComment,
  deletePost,
  formatKes,
  getPost,
  likePost,
  listComments,
  timeAgo,
} from '../lib/social';
import { Link, navigate } from '../lib/router';
import { accessLabel } from '../lib/duration';
import { mediaSrc } from '../lib/mediaUrl';
import MediaImg from '../components/MediaImg';
import Avatar from '../components/Avatar';
import PaySheet from '../components/PaySheet';
import CreatorActions from '../components/CreatorActions';
import {
  AlertIcon,
  ArrowLeftIcon,
  CommentIcon,
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

export default function PostDetailPage({
  account,
  config,
  params,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const id = Number(params.id);
  const [post, setPost] = useState<Post | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<ErrState | null>(null);
  const [nonce, setNonce] = useState(0);

  const [payOpen, setPayOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [body, setBody] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = () => setNonce((n) => n + 1);
  /** The newest row we successfully rendered — a fallback during refetches. */
  const heldPost = useRef<Post | null>(null);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) {
      setStatus('missing');
      return;
    }
    let dead = false;
    setStatus('loading');
    setError(null);
    getPost(id)
      .then(({ post: next }) => {
        if (dead) return;
        heldPost.current = next;
        setPost(next);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (dead) return;
        const problem = toError(err);
        if (problem.code === 'payment-required' && heldPost.current) {
          // 402 while re-opening a post we already have: the locked card we
          // hold is the truth, so keep it instead of blanking the screen.
          setPost(heldPost.current);
          setStatus('ready');
          return;
        }
        setError(problem);
        setStatus(problem.code === 'not-found' ? 'missing' : 'error');
      });
    return () => {
      dead = true;
    };
  }, [id, nonce]);

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) return;
    let dead = false;
    setCommentsLoading(true);
    listComments(id)
      .then((res) => {
        if (!dead) setComments(res.items);
      })
      .catch(() => {
        // Comments are secondary — a failure leaves an empty list, not a wall.
        if (!dead) setComments([]);
      })
      .finally(() => {
        if (!dead) setCommentsLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [id]);

  const canAck = Boolean(
    config.commerce.adult && account && Number(account.profile?.age) >= 18 && !adultOk,
  );
  const isOwner = Boolean(account && post && account.id === post.creatorId);

  async function toggleLike() {
    if (!post) return;
    if (!requireAuth('Sign in to like this post.')) return;
    const next = !post.liked;
    const optimistic: Post = {
      ...post,
      liked: next,
      likes: Math.max(0, post.likes + (next ? 1 : -1)),
    };
    setPost(optimistic);
    try {
      const res = await likePost(post.id, next);
      setPost((current) =>
        current ? { ...current, liked: res.liked, likes: res.likes } : current,
      );
    } catch (err) {
      setPost({ ...post, liked: post.liked, likes: post.likes });
      setError(toError(err));
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || commentBusy) return;
    if (!requireAuth('Sign in to comment.')) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const { comment } = await addComment(id, text);
      setComments((prev) => [comment, ...prev]);
      setBody('');
      setPost((current) => (current ? { ...current, comments: current.comments + 1 } : current));
    } catch (err) {
      setCommentError(toError(err).message);
    } finally {
      setCommentBusy(false);
    }
  }

  async function remove() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deletePost(id);
      navigate('/');
    } catch (err) {
      setDeleteError(toError(err).message);
      setDeleteBusy(false);
      setConfirmDelete(false);
    }
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (status === 'missing') {
    return (
      <div className="mx-auto max-w-md card p-6 text-center">
        <h1 className="text-base font-bold text-ink">This post is not here</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {error?.message ?? 'It may have been deleted by its creator.'}
        </p>
        <Link to="/" className="btn btn-primary mt-4">
          Back to the feed
        </Link>
      </div>
    );
  }

  // ── Load error ────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="mx-auto max-w-md card p-6 text-center">
        <AlertIcon className="mx-auto h-7 w-7 text-danger" />
        <p className="mt-3 text-sm leading-relaxed text-danger">{error?.message}</p>
        {error?.code === 'adult-only' && canAck && (
          <button
            type="button"
            className="btn btn-ghost mt-3"
            onClick={() => {
              acknowledgeAdult();
              load();
            }}
          >
            I&apos;m 18 or over — show adult posts
          </button>
        )}
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" className="btn btn-primary" onClick={load}>
            Try again
          </button>
          <Link to="/" className="btn btn-ghost">
            Back to the feed
          </Link>
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (status === 'loading' || !post) {
    return (
      <div className="mx-auto max-w-2xl space-y-4" aria-hidden="true">
        <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
        <div className="card animate-pulse space-y-3 p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/10" />
            <div className="h-3 w-32 rounded bg-white/10" />
          </div>
          <div className="h-64 rounded-xl bg-white/10" />
          <div className="h-3 w-2/3 rounded bg-white/10" />
        </div>
      </div>
    );
  }

  const locked = post.price > 0 && !post.owned;
  const showMedia = (post.type === 'image' || post.type === 'video') && post.mediaUrl;
  const hideable = post.type === 'image' || post.type === 'video';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-ink"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back to the feed
      </Link>

      <div className="card p-4">
        <div className="flex items-center gap-3">
          <Avatar
            username={post.creatorName}
            src={post.creatorAvatarUrl}
            className="h-10 w-10"
            letterClass="text-base"
          >
            <span className="text-xs leading-none">{flagFromCountry(post.creatorCountry)}</span>
          </Avatar>
          <div className="min-w-0 flex-1">
            <Link
              to={`/creator/${post.creatorId}`}
              className="block truncate text-sm font-semibold text-ink hover:underline"
            >
              @{post.creatorName}
            </Link>
            <p className="text-xs text-muted">{timeAgo(post.createdAt)}</p>
            {!post.creatorBanned && account?.id !== post.creatorId && (
              <div className="mt-2">
                <CreatorActions
                  creatorId={post.creatorId}
                  creatorName={post.creatorName}
                  creatorBanned={post.creatorBanned}
                  following={Boolean(post.creatorFollowing)}
                  subscribed={Boolean(post.creatorSubscribed)}
                  offer={
                    post.creatorSubscription ?? {
                      enabled: false,
                      price: 0,
                      currency: post.currency,
                      periodDays: 30,
                    }
                  }
                  account={account}
                  config={config}
                  requireAuth={requireAuth}
                  onChange={(state) => {
                    const wasSubscribed = Boolean(post.creatorSubscribed);
                    setPost((current) =>
                      current
                        ? {
                            ...current,
                            creatorFollowing: state.following,
                            creatorSubscribed: state.subscribed,
                          }
                        : current,
                    );
                    if (state.subscribed && !wasSubscribed) void load();
                  }}
                />
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {post.isAdult && (
              <span className="rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold text-warn">
                18+
              </span>
            )}
            {post.owned ? (
              <span className="rounded-md border border-ok/30 bg-ok/10 px-1.5 py-0.5 text-[10px] font-bold text-ok">
                Unlocked
              </span>
            ) : locked ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">
                <LockIcon className="h-3 w-3" />
                {formatKes(post.price)}
              </span>
            ) : (
              <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-muted">
                Free
              </span>
            )}
          </div>
        </div>

        {/* ── Media / paywall ─────────────────────────────────────────────── */}
        <div className="mt-4">
          {showMedia && post.type === 'image' && (
            <MediaImg
              src={mediaSrc(post.mediaUrl)}
              alt={post.caption || 'Post image'}
              className="photo max-h-[75vh] w-full rounded-2xl"
            />
          )}
          {showMedia && post.type === 'video' && (
            <video
              src={mediaSrc(post.mediaUrl)}
              controls
              playsInline
              preload="metadata"
              className="max-h-[75vh] w-full rounded-2xl bg-black object-contain"
            />
          )}
          {hideable && !post.mediaUrl && locked && (
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-gradient-to-br from-accent/30 to-accent-2/20 px-6 py-10 text-center">
              <LockIcon className="h-7 w-7 text-ink" />
              <p className="text-base font-semibold text-ink">This post is locked</p>
              <p className="max-w-xs text-sm leading-relaxed text-muted">
                Unlock it for {formatKes(post.price)} — your access window is{' '}
                {accessLabel(post.accessMinutes).replace(/ access$/, '')}.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setPayOpen(true)}>
                Unlock for {formatKes(post.price)}
              </button>
            </div>
          )}
          {hideable && !post.mediaUrl && !locked && (
            <div className="rounded-2xl bg-white/5 px-4 py-8 text-center text-xs text-muted">
              Media unavailable
            </div>
          )}
          {post.type === 'link' && post.linkUrl && (
            <a
              href={post.linkUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-2 rounded-xl border border-white/10 bg-surface-3/60 px-3 py-2 text-sm text-accent transition-colors hover:bg-white/10"
            >
              <span className="truncate">{post.linkUrl}</span>
            </a>
          )}
        </div>

        {post.caption && (
          <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink">
            {post.caption}
          </p>
        )}

        {/* ── Stats + actions ─────────────────────────────────────────────── */}
        <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-white/10 pt-2 text-xs text-muted">
          <button
            type="button"
            aria-pressed={post.liked}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/5 ${
              post.liked ? 'text-danger' : ''
            }`}
            onClick={() => void toggleLike()}
          >
            <HeartIcon className={`h-4.5 w-4.5 ${post.liked ? 'fill-danger' : ''}`} />
            <span className="tabular-nums">{post.likes}</span> likes
          </button>
          <span className="flex items-center gap-1.5 px-2 py-1.5">
            <CommentIcon className="h-4.5 w-4.5" />
            <span className="tabular-nums">{post.comments}</span> comments
          </span>
          <span className="px-2 py-1.5 tabular-nums">{post.views} views</span>
          <span className="px-2 py-1.5 tabular-nums">
            {post.purchases} purchase{post.purchases === 1 ? '' : 's'}
          </span>
        </div>

        {/* ── Owner controls ──────────────────────────────────────────────── */}
        {isOwner && (
          <div className="mt-3 rounded-xl border border-white/10 bg-surface-3/60 p-3">
            <p className="text-xs font-semibold text-ink">You own this post</p>
            {deleteError && (
              <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                {deleteError}
              </p>
            )}
            {confirmDelete ? (
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-danger px-3 py-2 text-xs"
                  disabled={deleteBusy}
                  onClick={() => void remove()}
                >
                  {deleteBusy && <SpinnerIcon className="h-4 w-4" />}
                  Yes, delete permanently
                </button>
                <button
                  type="button"
                  className="btn btn-ghost px-3 py-2 text-xs"
                  disabled={deleteBusy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-ghost mt-2.5 px-3 py-2 text-xs text-danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete post
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Comments ────────────────────────────────────────────────────── */}
      <div className="card p-4">
        <p className="label">Comments · {post.comments}</p>

        <form onSubmit={(event) => void submitComment(event)} className="flex gap-2">
          <input
            className="field"
            placeholder="Add a comment"
            aria-label="Add a comment"
            maxLength={500}
            value={body}
            disabled={commentBusy}
            onChange={(event) => {
              setBody(event.target.value);
              setCommentError(null);
            }}
          />
          <button type="submit" className="btn btn-primary px-4" disabled={commentBusy || !body.trim()}>
            {commentBusy ? <SpinnerIcon className="h-4 w-4" /> : 'Post'}
          </button>
        </form>

        {commentError && (
          <p className="mt-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {commentError}
          </p>
        )}
        {!account && (
          <p className="mt-2 text-[11px] text-muted">
            Reading is open to everyone — sign in to join the conversation.
          </p>
        )}

        <div className="mt-4 space-y-3">
          {commentsLoading ? (
            <div className="space-y-3" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="h-3 w-1/2 animate-pulse rounded bg-white/10" />
              ))}
            </div>
          ) : comments.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted">
              No comments yet — say something first.
            </p>
          ) : (
            comments.map((comment) => (
              <div key={comment.id} className="flex gap-3">
                <Avatar
                  username={comment.username}
                  src={comment.avatarUrl}
                  className="h-7 w-7"
                  letterClass="text-[11px]"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">
                    <span className="font-semibold text-ink">@{comment.username}</span>{' '}
                    <span className="text-muted">{timeAgo(comment.createdAt)}</span>
                  </p>
                  <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-ink">
                    {comment.body}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Pay sheet ───────────────────────────────────────────────────── */}
      {payOpen && (
        <PaySheet
          target={{
            purpose: 'post',
            refId: post.id,
            amount: post.price,
            currency: post.currency,
            title: post.caption || 'this post',
          }}
          config={config}
          account={account}
          onRequireAuth={() => requireAuth('Sign in to unlock this post.')}
          onPaid={() => {
            setPayOpen(false);
            void load(); // refetch: `owned` flips true and the media appears
          }}
          onClose={() => setPayOpen(false)}
        />
      )}
    </div>
  );
}

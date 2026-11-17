/**
 * Supervision inspectors — the "everything this account touched" views behind
 * the dashboard's Inspect buttons.
 *
 * One modal per entity (account, post, room) so the owner can drill from a
 * table row into the full footprint without leaving the tab:
 *
 *   • AccountInspector — profile, photos, every post (paid and adult
 *     included), comments, likes, follows both ways, subscriptions bought and
 *     sold, every charge as buyer and as payee, wallet and entries, session
 *     count, passport and hosted/live rooms.
 *   • PostInspector — the row, its media (fetched with the admin token past
 *     the paywall), every comment including removed ones, and who paid.
 *   • RoomInspector — the row, who is inside right now, and who paid to enter.
 *
 * The media itself is fetched as a blob because an `<img>` tag cannot send a
 * Bearer header — the object URL is revoked on unmount so a paid or 18+ file
 * does not linger in memory longer than the review takes.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchAdminPostMedia,
  formatDateTime,
  formatKes,
  getAccountDetail,
  getPostDetail,
  getRoomDetail,
  errorMessage,
  flagEmoji,
  timeAgo,
} from './api';
import { accessLabel } from '../lib/duration';
import { ErrorBanner, Modal, Pill } from './ui';

// ── Shared bits ─────────────────────────────────────────────────────────────

function useFetch<T>(load: () => Promise<T>): {
  data: T | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (!dead) setData(value);
      })
      .catch((err) => {
        if (!dead) setError(errorMessage(err));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
    // eslint-disable-line react-hooks/exhaustive-deps -- the loader is stable per mount
  }, []);
  return { data, error, loading };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

function Row({ children }: { children: ReactNode }) {
  return <div className="break-words text-sm text-ink">{children}</div>;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  if (rows.length === 0) return <Empty>Nothing here yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead>
          <tr className="border-b border-white/10">
            {head.map((col) => (
              <th key={col} className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              {cells.map((cell, j) => (
                <td key={j} className="py-1.5 pr-3 align-top text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const statusPill = (status: string) => {
  const tone =
    status === 'active' || status === 'paid' || status === 'live'
      ? 'ok'
      : status === 'pending'
        ? 'warn'
        : 'danger';
  return <Pill tone={tone}>{status}</Pill>;
};

// ── Account inspector ────────────────────────────────────────────────────────

export function AccountInspectorModal({
  accountId,
  onClose,
  onViewPost,
}: {
  accountId: number;
  onClose: () => void;
  /** Open a post inside this modal's parent (keeps one modal at a time). */
  onViewPost: (postId: number) => void;
}) {
  const { data, error, loading } = useFetch(() => getAccountDetail(accountId));

  const account = data?.account ?? null;
  const posts = data?.posts ?? [];
  const comments = data?.comments ?? [];
  const likes = data?.likes ?? [];
  const following = data?.following ?? [];
  const followers = data?.followers ?? [];
  const subsBought = data?.subscriptions.bought ?? [];
  const subsSold = data?.subscriptions.sold ?? [];
  const chargesBought = data?.charges.bought ?? [];
  const chargesEarned = data?.charges.earned ?? [];
  const wallet = data?.wallet ?? null;
  const walletEntries = data?.walletEntries ?? [];
  const sessions = data?.sessions ?? null;
  const stamps = data?.stamps ?? [];
  const roomsHosted = data?.rooms.hosted ?? [];
  const roomsLive = data?.rooms.live ?? [];

  return (
    <Modal
      title={account ? `@${account.username}` : `Account #${accountId}`}
      subtitle="Everything this account touches — supervised by the owner"
      onClose={onClose}
      wide={true}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">Loading account…</p>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : data && account ? (
        <>
          {account.avatarUrl ? (
            <div className="mb-3 flex items-center gap-3">
              <img
                src={account.avatarUrl}
                alt=""
                className="h-16 w-16 rounded-full object-cover ring-2 ring-white/10"
              />
              <div className="text-xs text-muted">
                <p className="text-sm font-semibold text-ink">
                  {flagEmoji(account.country)} @{account.username}
                </p>
                <p>
                  #{account.id} · age {account.age} · {account.gender} · joined{' '}
                  {formatDateTime(account.createdAt)}
                </p>
                {account.lastIp ? <p>last IP {account.lastIp}</p> : null}
                <p>
                  last seen {account.lastSeen ? formatDateTime(account.lastSeen) : 'never'} ·{' '}
                  {sessions?.live ?? 0} live session(s)
                </p>
                {account.banned && <Pill tone="danger">banned {formatDateTime(account.bannedAt)}</Pill>}
              </div>
            </div>
          ) : (
            <p className="mb-3 text-xs text-muted">
              #{account.id} · age {account.age} · {account.gender} · {flagEmoji(account.country)}{' '}
              {account.country} · joined {formatDateTime(account.createdAt)}
              {account.lastIp ? ` · last IP ${account.lastIp}` : ''}
            </p>
          )}
          {account.bannerUrl ? (
            <img
              src={account.bannerUrl}
              alt=""
              className="mb-3 h-24 w-full rounded-xl object-cover"
            />
          ) : null}

          <Section title="Activity">
            <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
              {[
                ['Posts', account.stats.posts],
                ['Comments', account.stats.comments],
                ['Likes', account.stats.likes],
                ['Followers', account.stats.followers],
                ['Sessions', account.stats.sessions],
                ['Rooms', account.stats.roomsHosted],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-xl border border-white/10 bg-surface-2/60 px-2 py-2"
                >
                  <p className="text-lg font-bold tabular-nums text-ink">{Number(value) || 0}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title={`Posts (${posts.length})`}>
            {posts.length === 0 ? (
              <Empty>This account has never posted.</Empty>
            ) : (
              <Table
                head={['#', 'Type', 'Access', 'Price', 'Status', 'Views', 'Likes', '']}
                rows={posts.map((post) => [
                  <span key="id" className="tabular-nums">#{post.id}</span>,
                  <span key="type" className="uppercase">{post.type}{post.isAdult ? ' · 18+' : ''}</span>,
                  <span key="access" className="text-muted">
                    {post.accessMinutes != null ? accessLabel(post.accessMinutes).replace(' access', '') : 'Forever'}
                  </span>,
                  post.price > 0 ? `${formatKes(post.price)}` : 'free',
                  statusPill(post.status),
                  <span key="views" className="tabular-nums">{post.views}</span>,
                  <span key="likes" className="tabular-nums">{post.likes}</span>,
                  <button
                    key="view"
                    type="button"
                    className="btn btn-ghost px-2.5 py-1 text-[11px]"
                    onClick={() => onViewPost(post.id)}
                  >
                    View
                  </button>,
                ])}
              />
            )}
          </Section>

          <Section title={`Comments (${comments.length})`}>
            {comments.length === 0 ? (
              <Empty>No comments from this account.</Empty>
            ) : (
              <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
                {comments.map((comment) => (
                  <li key={comment.id} className="rounded-lg border border-white/5 bg-white/5 px-2.5 py-1.5">
                    <p className="text-muted">
                      on post #{comment.postId} · {timeAgo(comment.createdAt)}{' '}
                      {comment.status !== 'active' ? ` · ${comment.status}` : ''}
                    </p>
                    <p className="mt-0.5 break-words text-ink">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Follows — ${followers.length} followers, ${following.length} following`}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Followed by
                </p>
                {followers.length === 0 ? (
                  <Empty>None yet.</Empty>
                ) : (
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                    {followers.map((f) => (
                      <li key={f.id} className="text-ink">@{f.username}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Following
                </p>
                {following.length === 0 ? (
                  <Empty>None yet.</Empty>
                ) : (
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                    {following.map((f) => (
                      <li key={f.id} className="text-ink">@{f.username}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {likes.length > 0 && (
              <p className="mt-2 text-[11px] text-muted">
                Liked {likes.length} post(s) — most recent:{' '}
                {likes.slice(0, 8).map((l) => `#${l.postId}`).join(', ')}
                {likes.length > 8 ? '…' : ''}
              </p>
            )}
          </Section>

          <Section title="Subscriptions">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-surface-2/60 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Bought ({subsBought.length})
                </p>
                {subsBought.length === 0 ? (
                  <Empty>No subscriptions bought.</Empty>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs">
                    {subsBought.map((sub) => (
                      <li key={sub.id} className="text-ink">
                        @{sub.otherUsername} · {formatKes(sub.price)}/mo-ish ·{' '}
                        {statusPill(sub.status)}{' '}
                        {sub.expiresAt ? `until ${formatDateTime(sub.expiresAt)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-xl border border-white/10 bg-surface-2/60 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Sold ({subsSold.length})
                </p>
                {subsSold.length === 0 ? (
                  <Empty>No subscribers yet.</Empty>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs">
                    {subsSold.map((sub) => (
                      <li key={sub.id} className="text-ink">
                        @{sub.otherUsername} · {formatKes(sub.price)} · {statusPill(sub.status)}
                      </li>
                    ))}
                  </ul>
                )}
                {data.subscriptions.offer ? (
                  <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-muted">
                    Offer:{' '}
                    {data.subscriptions.offer.enabled
                      ? `${formatKes(data.subscriptions.offer.price)} every ${data.subscriptions.offer.periodDays}d`
                      : 'off'}
                    {data.subscriptions.offer.perk ? ` — “${data.subscriptions.offer.perk}”` : ''}
                  </p>
                ) : null}
              </div>
            </div>
          </Section>

          <Section title="Money">
            <div className="rounded-xl border border-white/10 bg-surface-2/60 p-3">
              <Row>
                <span className="text-muted">Wallet balance:</span>{' '}
                <strong className="tabular-nums text-ink">
                  {wallet ? formatKes(wallet.balance) : '—'}
                </strong>
                {wallet ? (
                  <span className="ml-2 text-[11px] text-muted">
                    (earned {formatKes(wallet.lifetimeIn)} · paid out {formatKes(wallet.lifetimeOut)})
                  </span>
                ) : null}
              </Row>
              {walletEntries.length > 0 && (
                <Table
                  head={['When', 'Kind', 'Amount', 'Status']}
                  rows={walletEntries.slice(0, 10).map((entry) => [
                    timeAgo(entry.createdAt),
                    entry.kind,
                    <span key="a" className="tabular-nums">{formatKes(entry.amount)}</span>,
                    statusPill(entry.status),
                  ])}
                />
              )}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Bought ({chargesBought.length})
                  </p>
                  {chargesBought.length === 0 ? (
                    <Empty>No purchases.</Empty>
                  ) : (
                    <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                      {chargesBought.slice(0, 20).map((charge) => (
                        <li key={charge.id} className="text-ink">
                          #{charge.id} · {charge.purpose} · {formatKes(charge.amount)} ·{' '}
                          {statusPill(charge.status)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Earned ({chargesEarned.length})
                  </p>
                  {chargesEarned.length === 0 ? (
                    <Empty>No sales yet.</Empty>
                  ) : (
                    <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                      {chargesEarned.slice(0, 20).map((charge) => (
                        <li key={charge.id} className="text-ink">
                          #{charge.id} · {charge.purpose} · {formatKes(charge.net)} net ·{' '}
                          {statusPill(charge.status)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </Section>

          <Section title="Rooms hosted">
            {roomsHosted.length === 0 ? (
              <Empty>Never hosted a room.</Empty>
            ) : (
              <Table
                head={['#', 'Title', 'Status', 'Price', 'When']}
                rows={roomsHosted.map((room) => [
                  <span key="id" className="tabular-nums">#{room.id}</span>,
                  room.title,
                  statusPill(room.status),
                  room.price > 0 ? formatKes(room.price) : 'free',
                  timeAgo(room.createdAt),
                ])}
              />
            )}
            {roomsLive.length > 0 && (
              <p className="mt-2 text-[11px] text-ok">
                Currently inside {roomsLive.length} room(s):{' '}
                {roomsLive.map((r) => `${r.slug}`).join(', ')}
              </p>
            )}
          </Section>

          {stamps.length > 0 && (
            <Section title="Passport">
              <p className="text-xs text-ink">
                {stamps
                  .map((stamp) => `${flagEmoji(stamp.country)} ${stamp.country} ×${stamp.count}`)
                  .join(' · ')}
              </p>
            </Section>
          )}
        </>
      ) : null}
    </Modal>
  );
}

// ── Post inspector ───────────────────────────────────────────────────────────

export function PostInspectorModal({
  postId,
  onClose,
}: {
  postId: number;
  onClose: () => void;
}) {
  const { data, error, loading } = useFetch(() => getPostDetail(postId));
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);

  // Blob URLs must be revoked — a paid or 18+ file must not linger in memory.
  useEffect(() => {
    return () => {
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    };
  }, [mediaUrl]);

  const post = data?.post ?? null;
  const comments = data?.comments ?? [];
  const purchases = data?.purchases ?? [];

  // Fetch the media lazily once the post row is known to have one — the
  // endpoint 404s for text posts and would fill the console with noise.
  useEffect(() => {
    if (!post?.mediaUrl) return undefined;
    let dead = false;
    setMediaBusy(true);
    setMediaError(null);
    fetchAdminPostMedia(post.id)
      .then((url) => {
        if (!dead) setMediaUrl(url);
      })
      .catch((err) => {
        if (!dead) setMediaError(errorMessage(err));
      })
      .finally(() => {
        if (!dead) setMediaBusy(false);
      });
    return () => {
      dead = true;
    };
  }, [post?.mediaUrl, post?.id]);

  return (
    <Modal
      title={post ? `Post #${post.id} — @${post.creatorName}` : `Post #${postId}`}
      subtitle="Supervision view — media unlocked for the owner only"
      onClose={onClose}
      wide={true}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">Loading post…</p>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : post ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="uppercase">{post.type}</span>
            {post.isAdult && <Pill tone="warn">18+</Pill>}
            {statusPill(post.status)}
            <span>{post.price > 0 ? formatKes(post.price) : 'free'}</span>
            <span>{post.views} views · {post.likes} likes · {post.comments} comments</span>
            <span>{timeAgo(post.createdAt)}</span>
          </div>

          {post.caption && (
            <p className="mt-2 whitespace-pre-line break-words text-sm text-ink">
              {post.caption}
            </p>
          )}
          {post.linkUrl && (
            <a
              href={post.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block break-all text-xs text-accent hover:underline"
            >
              {post.linkUrl}
            </a>
          )}

          {post.mediaUrl ? (
            <div className="mt-3">
              {mediaBusy && !mediaUrl ? (
                <p className="py-8 text-center text-xs text-muted">Unlocking media…</p>
              ) : mediaError ? (
                <ErrorBanner message={mediaError} />
              ) : mediaUrl ? (
                post.type === 'video' ? (
                  <video
                    src={mediaUrl}
                    controls
                    playsInline
                    className="max-h-96 w-full rounded-xl bg-black"
                  />
                ) : (
                  <img
                    src={mediaUrl}
                    alt={post.caption || 'Post media'}
                    className="max-h-96 w-full rounded-xl object-contain"
                  />
                )
              ) : null}
            </div>
          ) : null}

          <Section title={`Purchases (${purchases.length})`}>
            <Table
              head={['Buyer', 'Amount', 'Status', 'When']}
              rows={purchases.map((purchase) => [
                `@${purchase.buyer}`,
                <span key="a" className="tabular-nums">{formatKes(purchase.amount)}</span>,
                statusPill(purchase.status),
                timeAgo(purchase.paidAt ?? purchase.createdAt),
              ])}
            />
          </Section>

          <Section title={`Comments (${comments.length})`}>
            {comments.length === 0 ? (
              <Empty>No comments.</Empty>
            ) : (
              <ul className="max-h-56 space-y-1.5 overflow-y-auto text-xs">
                {comments.map((comment) => (
                  <li key={comment.id} className="rounded-lg border border-white/5 bg-white/5 px-2.5 py-1.5">
                    <p className="text-muted">
                      @{comment.username} · {timeAgo(comment.createdAt)} · {comment.status}
                    </p>
                    <p className="mt-0.5 break-words text-ink">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </Modal>
  );
}

// ── Room inspector ───────────────────────────────────────────────────────────

export function RoomInspectorModal({
  roomId,
  onClose,
}: {
  roomId: number;
  onClose: () => void;
}) {
  const { data, error, loading } = useFetch(() => getRoomDetail(roomId));
  const room = data?.room ?? null;
  const participants = data?.participants ?? [];
  const purchases = data?.purchases ?? [];

  return (
    <Modal
      title={room ? room.title : `Room #${roomId}`}
      subtitle={room ? `${room.kind} · ${room.status} · hosted by @${room.hostName}` : 'Room'}
      onClose={onClose}
      wide={false}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">Loading room…</p>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : data && room ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="uppercase">{room.kind}</span>
            {statusPill(room.status)}
            {room.isAdult && <Pill tone="warn">18+</Pill>}
            <span>{room.price > 0 ? formatKes(room.price) : 'free'}</span>
            <span>max {room.maxParticipants} participants</span>
            <span>{room.createdAt ? `opened ${formatDateTime(room.createdAt)}` : ''}</span>
            {room.endedAt ? <span>ended {formatDateTime(room.endedAt)}</span> : null}
          </div>

          <Section title={`Inside right now (${participants.length})`}>
            {participants.length === 0 ? (
              <Empty>Nobody in the room at this moment.</Empty>
            ) : (
              <ul className="space-y-1 text-xs">
                {participants.map((p) => (
                  <li key={p.sid} className="text-ink">
                    @{p.username} {p.country ? `· ${flagEmoji(p.country)} ${p.country}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Purchases (${purchases.length})`}>
            <Table
              head={['Buyer', 'Amount', 'Status', 'When']}
              rows={purchases.map((purchase) => [
                `@${purchase.buyer}`,
                <span key="a" className="tabular-nums">{formatKes(purchase.amount)}</span>,
                statusPill(purchase.status),
                timeAgo(purchase.paidAt ?? purchase.createdAt),
              ])}
            />
          </Section>
        </>
      ) : null}
    </Modal>
  );
}

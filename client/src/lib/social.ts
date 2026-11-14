/**
 * Social platform API client — posts, payments, wallet, rooms.
 *
 * Same shape as `lib/auth.ts` / `lib/payments.ts`: plain `fetch` against the
 * signaling server, a bearer token from `localStorage`, and every failure
 * arriving as `{ error: { code, message } }` inside a `SocialError` whose
 * message is written for a human (the UI shows it verbatim).
 *
 * The M-PESA flow is two calls, never one: `createCharge()` opens the request
 * (and fires the STK push server-side), then the caller polls `getCharge()`
 * until the status leaves `pending` — callback, poll and manual approval all
 * converge on the same row, so the UI only ever watches that one status.
 */
import type {
  Charge,
  Comment,
  Creator,
  CreatorSubscriptionOffer,
  Paged,
  Post,
  Room,
  RoomAccess,
  Subscription,
  Wallet,
  WalletEntry,
} from '../types/social';
import type { Profile } from '../types';
import { SIGNALING_URL } from './iceServers';
import { getToken } from './auth';
import { upload as uploadToBlob } from '@vercel/blob/client';

const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api`;

export class SocialError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'social', status = 0) {
    super(message);
    this.name = 'SocialError';
    this.code = code;
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    throw new SocialError('Could not reach the server — check your connection.', 'network');
  }

  const text = await res.text();
  let data: { error?: { code?: string; message?: string } } | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body — fall through to the status message */
    }
  }
  if (!res.ok) {
    throw new SocialError(
      data?.error?.message ?? `Request failed (${res.status}).`,
      data?.error?.code ?? 'http',
      res.status,
    );
  }
  return data as T;
}

// ── Posts ────────────────────────────────────────────────────────────────────

export interface FeedQuery {
  page?: number;
  size?: number;
  q?: string;
  adult?: boolean;
  creatorId?: number;
}

export function listPosts(query: FeedQuery = {}): Promise<Paged<Post>> {
  const params = new URLSearchParams();
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.size) params.set('size', String(query.size));
  if (query.q) params.set('q', query.q);
  if (query.adult) params.set('adult', '1');
  if (query.creatorId) params.set('creatorId', String(query.creatorId));
  const qs = params.toString();
  return request<Paged<Post>>(`/posts${qs ? `?${qs}` : ''}`);
}

/** The creator's own posts (hidden rows included). */
export function listMyPosts(query: FeedQuery = {}): Promise<Paged<Post>> {
  const params = new URLSearchParams();
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.size) params.set('size', String(query.size));
  const qs = params.toString();
  return request<Paged<Post>>(`/posts/mine${qs ? `?${qs}` : ''}`);
}

export function getPost(id: number): Promise<{ post: Post }> {
  return request<{ post: Post }>(`/posts/${id}`);
}

export interface NewPost {
  caption: string;
  price: number;
  isAdult?: boolean;
  type: 'image' | 'video' | 'link' | 'text';
  mediaKey?: string;
  linkUrl?: string;
}

export function createPost(input: NewPost): Promise<{ post: Post }> {
  return request<{ post: Post }>('/posts', { method: 'POST', body: input });
}

export function deletePost(id: number): Promise<void> {
  return request<void>(`/posts/${id}`, { method: 'DELETE' });
}

export function likePost(id: number, liked: boolean): Promise<{ liked: boolean; likes: number }> {
  return request<{ liked: boolean; likes: number }>(`/posts/${id}/like`, {
    method: 'POST',
    body: { liked },
  });
}

export function listComments(id: number): Promise<{ items: Comment[] }> {
  return request<{ items: Comment[] }>(`/posts/${id}/comments`);
}

export function addComment(id: number, body: string): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(`/posts/${id}/comments`, { method: 'POST', body: { body } });
}

/**
 * Upload media bytes (image or short video) and get back the `mediaKey` to
 * put on a post. Raw body on purpose — the file never becomes base64 JSON.
 */
export async function uploadMedia(
  file: File,
  options: { directUpload?: boolean } = {},
): Promise<{ key: string }> {
  if (options.directUpload) {
    const ext = ({
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
    } as Record<string, string>)[file.type];
    if (!ext) {
      throw new SocialError(
        'Upload an image (JPEG, PNG, WebP, GIF) or a video (MP4, WebM).',
        'media-type',
        415,
      );
    }
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${ext}`;
    const token = getToken();
    const uploadUrl = BASE.startsWith('http')
      ? `${BASE}/media/direct`
      : `${window.location.origin}${BASE}/media/direct`;
    try {
      const result = await uploadToBlob(key, file, {
        access: 'private',
        handleUploadUrl: uploadUrl,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        contentType: file.type,
      });
      return { key: result.pathname };
    } catch (err) {
      throw new SocialError(
        err instanceof Error ? err.message : 'The upload failed — try again.',
        'upload',
      );
    }
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/media`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': file.type || 'application/octet-stream',
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: file,
    });
  } catch {
    throw new SocialError('Could not reach the server — check your connection.', 'network');
  }
  const data = (await res.json().catch(() => null)) as
    | { key?: string; error?: { code?: string; message?: string } }
    | null;
  if (!res.ok || !data?.key) {
    throw new SocialError(
      data?.error?.message ?? `Upload failed (${res.status}).`,
      data?.error?.code ?? 'upload',
      res.status,
    );
  }
  return { key: data.key };
}

// ── Creators: follow + subscribe ─────────────────────────────────────────────

export function getCreator(id: number): Promise<{ creator: Creator }> {
  return request<{ creator: Creator }>(`/creators/${id}`);
}

export function followCreator(
  id: number,
  following: boolean,
): Promise<{ following: boolean; followers: number }> {
  return request<{ following: boolean; followers: number }>(`/creators/${id}/follow`, {
    method: following ? 'POST' : 'DELETE',
  });
}

/**
 * Free offers activate immediately; a priced offer returns a `charge` that
 * must be watched with `waitForPayment()` exactly like a post or a room.
 */
export function subscribeToCreator(
  id: number,
  phone?: string,
): Promise<{ subscription: Subscription | null; charge: Charge | null }> {
  return request<{ subscription: Subscription | null; charge: Charge | null }>(
    `/creators/${id}/subscribe`,
    { method: 'POST', body: phone ? { phone } : {} },
  );
}

export function cancelCreatorSubscription(id: number): Promise<{ subscription: Subscription }> {
  return request<{ subscription: Subscription }>(`/creators/${id}/subscribe`, {
    method: 'DELETE',
  });
}

export function getMyCreatorSubscription(): Promise<{ subscription: CreatorSubscriptionOffer }> {
  return request<{ subscription: CreatorSubscriptionOffer }>('/creators/me/subscription');
}

export function saveMyCreatorSubscription(input: {
  enabled: boolean;
  price: number;
  periodDays: number;
  perk: string;
}): Promise<{ subscription: CreatorSubscriptionOffer }> {
  return request<{ subscription: CreatorSubscriptionOffer }>('/creators/me/subscription', {
    method: 'PUT',
    body: input,
  });
}

// ── Charges (M-PESA) ─────────────────────────────────────────────────────────

/** Open a payment request; in `stk` mode the phone prompts for the PIN now. */
export function createCharge(input: {
  purpose: 'post' | 'room' | 'sub';
  refId: number;
  phone: string;
}): Promise<{ charge: Charge }> {
  return request<{ charge: Charge }>('/charges', { method: 'POST', body: input });
}

/** Poll this until `status` leaves `pending` (see `waitForPayment`). */
export function getCharge(id: number): Promise<{ charge: Charge }> {
  return request<{ charge: Charge }>(`/charges/${id}`);
}

/**
 * Watch one charge until it resolves.
 *
 * The callback usually settles it in 1–3 s; the timeout is generous because a
 * Kenyan STK prompt on a weak network can take a while, and an abandoned
 * prompt resolves as `failed` (`Request cancelled by user`) rather than
 * hanging — so this returns `expired` instead of waiting forever.
 */
export async function waitForPayment(
  id: number,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (charge: Charge) => void } = {},
): Promise<Charge> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { charge } = await getCharge(id);
    opts.onTick?.(charge);
    if (charge.status !== 'pending') return charge;
    if (Date.now() >= deadline) {
      return { ...charge, status: 'expired', error: charge.error ?? 'Timed out waiting for the PIN prompt.' };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ── Wallet ───────────────────────────────────────────────────────────────────

export function getWallet(): Promise<{ wallet: Wallet; entries: WalletEntry[] }> {
  return request<{ wallet: Wallet; entries: WalletEntry[] }>('/wallet');
}

export function withdraw(input: { phone: string; amount: number }): Promise<{ entry: WalletEntry }> {
  return request<{ entry: WalletEntry }>('/wallet/withdraw', { method: 'POST', body: input });
}

// ── Rooms ────────────────────────────────────────────────────────────────────

export function listRooms(query: { kind?: 'group' | 'conference'; adult?: boolean } = {}): Promise<{
  items: Room[];
}> {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.adult) params.set('adult', '1');
  const qs = params.toString();
  return request<{ items: Room[] }>(`/rooms${qs ? `?${qs}` : ''}`);
}

export function getRoom(slug: string): Promise<RoomAccess> {
  return request<RoomAccess>(`/rooms/${encodeURIComponent(slug)}`);
}

// ── Profile photos ───────────────────────────────────────────────────────────

export type PhotoKind = 'avatar' | 'banner';

/**
 * Upload one profile photo (raw bytes, not JSON — same reason post media is
 * raw). The server proxies it because a photo is a few hundred KB, well
 * inside the function body limit, and one endpoint keeps the validation in
 * one place.
 */
export async function uploadPhoto(kind: PhotoKind, file: File): Promise<{ url: string }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/me/photo?kind=${kind}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': file.type || 'application/octet-stream',
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: file,
      cache: 'no-store',
    });
  } catch {
    throw new SocialError('Could not reach the server — check your connection.', 'network');
  }
  const text = await res.text();
  let data: { error?: { code?: string; message?: string }; url?: string } | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body — the status line carries the failure */
    }
  }
  if (!res.ok) {
    throw new SocialError(
      data?.error?.message ?? `Upload failed (${res.status}).`,
      data?.error?.code ?? 'http',
      res.status,
    );
  }
  return { url: data?.url ?? '' };
}

/** Drop the photo; the old file is deleted server-side in the same call. */
export function removePhoto(kind: PhotoKind): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/me/photo?kind=${kind}`, { method: 'DELETE' });
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const KES_FMT = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  maximumFractionDigits: 0,
});

/** `1500` → `KES 1,500` — one formatter so every page renders money alike. */
export function formatKes(amount: number): string {
  return KES_FMT.format(Number.isFinite(amount) ? amount : 0);
}

/** What the creator actually keeps, computed exactly like the server does. */
export function netOf(amount: number, commissionRate: number): { commission: number; net: number } {
  const gross = Math.max(0, Math.round(amount));
  const commission = Math.round((gross * commissionRate) / 100);
  return { commission, net: gross - commission };
}

/**
 * Remember the last M-PESA number used on this device so a second purchase
 * does not ask for it again (the creator still sees who paid — the server
 * stores the number on the charge row).
 */
export function lastPhone(): string {
  try {
    return localStorage.getItem('matchup.phone') ?? '';
  } catch {
    return '';
  }
}

export function rememberPhone(phone: string): void {
  try {
    localStorage.setItem('matchup.phone', phone);
  } catch {
    /* private mode — nothing to remember */
  }
}

/** `0712345678` / `2547…` → true. Mirrors the server's own check. */
export function isValidPhone(phone: string): boolean {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  const normalized = digits.startsWith('254')
    ? digits
    : digits.startsWith('0')
      ? `254${digits.slice(1)}`
      : digits.startsWith('7') || digits.startsWith('1')
        ? `254${digits}`
        : digits;
  return /^254(7|1)\d{8}$/.test(normalized);
}

/**
 * Hand-rolled relative time — no date library for four strings.
 * `2026-10-22T09:00:00Z` → "just now" / "4 h ago" / "3 d ago".
 */
export function timeAgo(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} y ago`;
}

export type { Profile };

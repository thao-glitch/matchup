/**
 * Admin API client — the one place that knows where the dashboard's endpoints
 * live, how the bearer token travels, and what a failure looks like on the wire.
 *
 * Two rules shape this file:
 *
 *   1. Every error arrives as `{"error": {code, message}}` and the message is
 *      written for a human, so the UI shows it verbatim instead of inventing
 *      its own wording. `ApiError` carries it up to a small inline banner.
 *   2. A 401 means the stored session is dead (expired or revoked). The token
 *      is dropped immediately and every mounted screen is told, so the app
 *      falls back to the login screen rather than rendering empty tables.
 *
 * No fetch wrapper library, no date library — plain `fetch` plus a few
 * formatters shared by all tabs so numbers and times look identical
 * everywhere.
 */
import { SIGNALING_URL } from '../lib/iceServers';

export const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api/admin`;

/** localStorage key — the host app never reads it; only this folder does. */
export const TOKEN_KEY = 'matchup.admin.token';

// ── Wire types ───────────────────────────────────────────────────────────────
// Shapes below were checked against a live `/api/admin/*` response, not guessed.

export interface AdminIdentity {
  id: number;
  username: string;
  role: string;
}

/** One calendar day of the approved-payment series behind the charts. */
export interface DayTotal {
  /** `YYYY-MM-DD` as the database produced it (local server day). */
  day: string;
  count: number;
  total: number;
}

export interface PaymentSettings {
  enabled: boolean;
  amount: number;
  currency: string;
  productName: string;
  premiumDays: number;
  instructions: string;
  supportContact: string;
}

export interface FeatureFlags {
  signup: boolean;
  ads: boolean;
  premium: boolean;
  maintenance: boolean;
}

/** One row of `calls.recent` — an in-memory room report, `at` is epoch ms. */
export interface CallReport {
  roomId: string;
  outcome: 'connected' | 'failed';
  path: string;
  rttMs: number | null;
  durationMs: number | null;
  attempts: number;
  iceSource: string;
  at: number;
}

/**
 * Several call stats are `null` until the first sample exists (a brand-new
 * server has no success rate yet) — every consumer must render `—` for that.
 */
export interface CallStats {
  since: string;
  rooms: number;
  reports: number;
  dropped: number;
  outcomes: { connected: number; failed: number; successRate: number | null };
  paths: { host: number; srflx: number; prflx: number; relay: number; unknown: number };
  iceSources: { relay: number; unknown: number };
  rttMs: { samples: number; avg: number | null };
  durationMs: { samples: number; avg: number | null };
  recent: CallReport[];
}

/** One calendar day of the settled-charge series behind the charts. */
export interface ChargeDay {
  /** `YYYY-MM-DD` as the database produced it (local server day). */
  day: string;
  count: number;
  gross: number;
  commission: number;
}

/**
 * The live money: every payment on the platform is a charge, so this — not
 * the legacy `payments` ledger — is what the dashboard's revenue tiles read.
 */
export interface CommerceSummary {
  charges: {
    count: number;
    gross: number;
    commission: number;
    net: number;
    pending: number;
    paid: number;
    failed: number;
    expired: number;
    byDay: ChargeDay[];
  };
  wallets: {
    held: number;
    earned: number;
    paidOut: number;
    wallets: number;
    pendingPayouts: number;
    pendingAmount: number;
  };
  rooms: { live: number; total: number; [key: string]: number };
}

export interface DatabaseTable {
  name: string;
  rows: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
}

export interface PoolStats {
  limit: number;
  total: number;
  free: number;
  queued: number;
}

export interface ReplicaStatus {
  configured: boolean;
  healthy: boolean;
  host: string;
  error: string | null;
  pool: PoolStats;
}

export interface DatabaseData {
  version: string;
  database: string;
  totalBytes: number;
  dataBytes: number;
  indexBytes: number;
  /** Disk budget used for the usage bar. Display-only; see MARIADB_STORAGE_LIMIT_MB. */
  capacityBytes: number;
  capacityLimitMb: number;
  usedPct: number;
  headroomBytes: number;
  tables: DatabaseTable[];
  connections: { current: number; running: number; max: number };
  pool: PoolStats;
  replica: ReplicaStatus;
  maxAllowedPacket: number;
  innodbPageSize: number;
  uptimeSec: number;
}

export interface MediaLifecycle {
  orphanGraceHours: number;
  retentionDays: number;
  cacheMaxAgeSec: number;
  nativeObjectTtl: boolean;
}

export interface MediaPruneResult {
  at: string;
  dryRun: boolean;
  orphanGraceHours: number;
  retentionDays: number;
  referencedKeys: number;
  blob: {
    backend: string;
    scanned: number;
    deleted: number;
    skipped: number;
    errors: number;
    dryRun: boolean;
  };
  database: { deleted: number; cutoff: string };
  local: { deleted: number };
}

export interface OverviewData {
  accounts: { total: number; new7d: number; active7d: number; banned: number; premium: number };
  /** The legacy paybill ledger — read-only, no new rows are ever written. */
  payments: {
    pending: number;
    approved: number;
    rejected: number;
    approvedTotal: number;
    byDay: DayTotal[];
  };
  live: { online: number; looking: number };
  calls: CallStats;
  commerce: CommerceSummary;
  store: { mode: string };
  database: DatabaseData | null;
  media: {
    backend: string;
    objectStorage: boolean;
    private: boolean;
    directUpload: boolean;
    lifecycle: MediaLifecycle;
  };
  config: { features: FeatureFlags; payment: PaymentSettings };
  server: { uptimeSec: number; node: string; now: string };
}

export interface AdminUser {
  id: number;
  username: string;
  age: number;
  gender: string;
  country: string;
  createdAt: string;
  lastSeen: string;
  /** The server sends `null`; older rows wrote the string "null" — tolerate both. */
  lastIp: string | null;
  banned: boolean;
  bannedAt: string | null;
  premiumUntil: string | null;
  countries: number;
  paymentsTotal: number;
  paymentsPending: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

// ── Social platform (posts, charges, rooms, wallets) ─────────────────────────

/** A creator's post as moderation sees it — no media URLs, just the record. */
export interface AdminPost {
  id: number;
  creatorId: number;
  creatorName: string;
  creatorCountry: string;
  type: 'image' | 'video' | 'link' | 'text';
  caption: string;
  linkUrl: string | null;
  price: number;
  currency: string;
  isAdult: boolean;
  status: 'active' | 'hidden' | 'removed';
  views: number;
  likes: number;
  comments: number;
  purchases: number;
  createdAt: string;
}

/** One paid-content transaction: gross, the house cut, and the creator's net. */
export interface AdminCharge {
  id: number;
  purpose: 'post' | 'room' | 'premium' | 'sub';
  refId: number;
  buyerId: number;
  buyerUsername: string;
  payeeId: number;
  payeeUsername: string;
  phone: string;
  amount: number;
  currency: string;
  commission: number;
  net: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  mpesaRef: string | null;
  checkoutRequestId: string | null;
  error: string | null;
  note: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** Group call / conference room with its live head-count. */
export interface AdminRoom {
  id: number;
  slug: string;
  title: string;
  kind: 'group' | 'conference';
  hostId: number;
  hostName: string;
  price: number;
  currency: string;
  isAdult: boolean;
  maxParticipants: number;
  status: 'live' | 'ended';
  participants: number;
  createdAt: string;
  endedAt: string | null;
}

export interface WalletRow {
  accountId: number;
  username: string;
  balance: number;
  lifetimeIn: number;
  lifetimeOut: number;
  updatedAt: string | null;
}

export interface WalletEntryRow {
  id: number;
  accountId: number;
  amount: number;
  kind: 'sale' | 'adjustment' | 'withdrawal';
  status: 'posted' | 'pending' | 'approved' | 'rejected';
  chargeId: number | null;
  memo: string | null;
  username: string;
  createdAt: string;
}

export interface EarningsData {
  count: number;
  gross: number;
  commission: number;
  net: number;
  pending: number;
  paid: number;
  failed: number;
  expired: number;
  byDay: { day: string; count: number; gross: number; commission: number }[];
  wallets: { held: number; earned: number; paidOut: number; wallets: number; pendingPayouts: number; pendingAmount: number };
  withdrawals: WalletEntryRow[];
}

// ── Settings (the four sections of PUT /api/admin/settings) ──────────────────

export interface CommerceSettings {
  enabled: boolean;
  social: boolean;
  groups: boolean;
  adult: boolean;
  commissionRate: number;
  minPrice: number;
  maxPrice: number;
  currency: string;
  /** Manual review mode — every charge waits for the owner's SMS approval. */
  manualEnabled: boolean;
  /** Where buyers are told to send the money (e.g. a Pochi number). */
  manualDestination: string;
  /** Free-text shown verbatim on the pay screen. */
  manualInstructions: string;
}

/** Secrets arrive masked as `••••••••`; writing a masked value back keeps
 *  the stored one, so an untouched form round-trips safely. */
export interface MpesaSettings {
  enabled: boolean;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  /** `'till'` bills a Buy Goods till (`CustomerBuyGoodsOnline`); `'paybill'`
   *  is the default rail and what a Lipa na M-PESA Paybill expects. */
  shortcodeType: 'paybill' | 'till';
  passkey: string;
  baseUrl: string;
  callbackUrl: string;
  description: string;
}

/**
 * One line of `POST /api/admin/mpesa/test`. `ok` is tri-state: `true` passed,
 * `false` is broken, `null` means an earlier requirement is still missing so
 * this one could not be judged.
 */
export interface MpesaCheck {
  name: string;
  ok: boolean | null;
  message: string;
}

export interface SettingsBundle {
  settings: { payment: PaymentSettings; features: FeatureFlags; commerce: CommerceSettings; mpesa: MpesaSettings };
}

export interface AuditItem {
  id: number;
  adminId: number;
  adminName: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  /** Server-provided `error.code` (`credentials`, `unauthorized`, …). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ApiError';
  }
}

/** Uniform way to surface any thrown value in a banner. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong — try again.';
}

// ── Session ──────────────────────────────────────────────────────────────────

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode browsers can throw on storage access; treat it as "signed out".
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Without storage the session dies with the tab — still usable until then.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to do: the token could not be stored in the first place.
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Subscribe to "session died" so the shell can drop back to the login screen. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function broadcastUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * Fetch one admin endpoint. `path` is relative to `/api/admin`, bodies are
 * pre-serialized JSON strings. Returns `undefined` for 204 responses.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch (err) {
    // Aborts and offline fetches land here; the caller decides whether the
    // failure was its own cancellation (it checks `signal.aborted`).
    throw new ApiError('network', err instanceof Error && err.message ? err.message : 'Network error');
  }

  if (res.status === 401) {
    // Stale/expired token: drop it before throwing so the login screen is
    // guaranteed to be back by the time the error reaches a component.
    clearToken();
    broadcastUnauthorized();
  }

  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body (proxy page, crash) — keep the generic message.
    }
    throw new ApiError(String(res.status), message);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// ── Supervision: one account / one post / one room, in full ──────────────────

/** Every subscription the account holds or sells, mapped camelCase server-side. */
export interface AdminSubscription {
  id: number;
  subscriberId: number;
  creatorId: number;
  otherUsername: string;
  status: 'active' | 'canceled' | 'expired';
  price: number;
  currency: string;
  periodDays: number;
  startedAt: string | null;
  expiresAt: string | null;
  canceledAt: string | null;
}

/** A row of one account's footprint, as `GET /api/admin/accounts/:id` sends it. */
export interface AdminAccountDetail {
  account: AdminUser & {
    avatarUrl: string | null;
    bannerUrl: string | null;
    stats: {
      posts: number;
      comments: number;
      likes: number;
      following: number;
      followers: number;
      subsBought: number;
      subsSold: number;
      chargesBought: number;
      chargesEarned: number;
      sessions: number;
      roomsHosted: number;
    };
  };
  posts: AdminPost[];
  comments: { id: number; postId: number; body: string; status: string; createdAt: string }[];
  likes: { postId: number; createdAt: string }[];
  following: { id: number; username: string; createdAt: string }[];
  followers: { id: number; username: string; createdAt: string }[];
  subscriptions: {
    bought: AdminSubscription[];
    sold: AdminSubscription[];
    offer: {
      enabled: boolean;
      price: number;
      currency: string;
      periodDays: number;
      perk: string;
    } | null;
  };
  charges: { bought: AdminCharge[]; earned: AdminCharge[] };
  wallet: WalletRow | null;
  walletEntries: WalletEntryRow[];
  sessions: { live: number; latest: string | null; first: string | null };
  stamps: { country: string; count: number; lastAt: string }[];
  rooms: {
    hosted: AdminRoom[];
    live: { slug: string; sid: string; country: string; at: number }[];
  };
}

/** Everything behind one post, including paid and 18+ rows. */
export interface AdminPostDetail {
  post: AdminPost & {
    creatorCountry: string;
    mediaUrl: string | null;
    createdAt: string;
  };
  comments: {
    id: number;
    accountId: number;
    username: string;
    body: string;
    status: string;
    createdAt: string;
  }[];
  purchases: {
    id: number;
    buyerId: number;
    buyer: string;
    amount: number;
    status: string;
    paidAt: string | null;
    createdAt: string;
  }[];
}

/** Everything behind one room, including its live roster and takings. */
export interface AdminRoomDetail {
  room: AdminRoom;
  participants: { sid: string; username: string; country: string; at: number }[];
  headcount: number;
  purchases: {
    id: number;
    buyerId: number;
    buyer: string;
    amount: number;
    status: string;
    paidAt: string | null;
    createdAt: string;
  }[];
}

// ── Formatting ───────────────────────────────────────────────────────────────

// One formatter instance per shape: Intl construction is comparatively slow
// and these run on every table cell render.
const KES_FMT = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  maximumFractionDigits: 0,
});
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const DATE_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const CLOCK_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatKes(amount: number): string {
  return KES_FMT.format(Number.isFinite(amount) ? amount : 0);
}

export function formatDate(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? DATE_FMT.format(t) : '—';
}

export function formatDateTime(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? DATE_TIME_FMT.format(t) : '—';
}

/** `17:52:04` for the "last updated" line. */
export function formatClock(at: Date): string {
  return CLOCK_FMT.format(at);
}

/**
 * Hand-rolled relative time — no date library for four strings.
 * Accepts an ISO string or epoch milliseconds (the call telemetry uses the
 * latter for its `at` field).
 */
export function timeAgo(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';

  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} y ago`;
}

/** `95000` → `1m 35s`, `45000` → `45s`, `3_700_000` → `1h 01m`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Server uptime in the same spirit: `4m`, `3h 12m`, `2d 4h`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * ISO 3166-1 alpha-2 → flag emoji via regional indicator symbols.
 * `KE` → 🇰🇪. Anything that is not exactly two letters gets an empty string,
 * so a missing or odd country code never renders a broken glyph.
 */
export function flagEmoji(code: string | null | undefined): string {
  if (!code) return '';
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(clean)) return '';
  return String.fromCodePoint(...Array.from(clean, (ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

// ── Supervision fetchers ──────────────────────────────────────────────────────

/** `GET /api/admin/accounts/:id` — the full account footprint. */
export function getAccountDetail(id: number): Promise<AdminAccountDetail> {
  return request<AdminAccountDetail>(`/accounts/${id}`);
}

/** `GET /api/admin/posts/:id` — the post plus every comment and buyer. */
export function getPostDetail(id: number): Promise<AdminPostDetail> {
  return request<AdminPostDetail>(`/posts/${id}`);
}

/** `GET /api/admin/rooms/:id` — the room plus its live roster and takings. */
export function getRoomDetail(id: number): Promise<AdminRoomDetail> {
  return request<AdminRoomDetail>(`/rooms/${id}`);
}

/**
 * Fetch the raw bytes of a paid or 18+ post with the admin token attached.
 * The media route authorizes with a Bearer header (an `<img>` tag cannot send
 * one), so the inspector pulls the file as a blob and hands back an object
 * URL — the paywall is bypassed for the owner, never for anyone else.
 */
export async function fetchAdminPostMedia(id: number): Promise<string> {
  const token = getToken();
  const res = await fetch(`${BASE}/posts/${id}/media`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiError(String(res.status), `Could not load this media (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Check the Daraja setup, optionally firing a real KES 1 prompt at `phone`.
 * The only way to tell "credentials are wrong" from "shortcode is missing"
 * without reading a stack trace.
 */
export async function testMpesa(phone?: string): Promise<{ ok: boolean; checks: MpesaCheck[] }> {
  return request<{ ok: boolean; checks: MpesaCheck[] }>('/mpesa/test', {
    method: 'POST',
    body: JSON.stringify(phone ? { phone } : {}),
  });
}

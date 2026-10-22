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
  bank: string;
  paybill: string;
  accountFormat: string;
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
  relayShare: number | null;
  iceSources: { twilio: number; 'rest-secret': number; 'static-turn': number; 'stun-only': number; unknown: number };
  rttMs: { samples: number; avg: number | null };
  durationMs: { samples: number; avg: number | null };
  recent: CallReport[];
}

export interface OverviewData {
  accounts: { total: number; new7d: number; active7d: number; banned: number; premium: number };
  payments: {
    pending: number;
    approved: number;
    rejected: number;
    approvedTotal: number;
    byDay: DayTotal[];
  };
  live: { online: number; looking: number };
  calls: CallStats;
  store: { mode: string };
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

export interface PaymentRow {
  id: number;
  accountId: number;
  username: string;
  amount: number;
  currency: string;
  method: string;
  paybill: string;
  /** What the payer typed as the account number — the matching key. */
  accountNo: string;
  providerRef: string | null;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  premiumDays: number;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  /** False when the account this payment points at was deleted meanwhile. */
  accountExists: boolean;
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
  purpose: 'post' | 'room';
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
}

/** Secrets arrive masked as `••••••••`; writing a masked value back keeps
 *  the stored one, so an untouched form round-trips safely. */
export interface MpesaSettings {
  enabled: boolean;
  mode: 'stk' | 'manual';
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  baseUrl: string;
  callbackUrl: string;
  paybill: string;
  accountFormat: string;
  description: string;
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

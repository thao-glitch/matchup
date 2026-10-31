/**
 * Wire types for the social platform — mirrored from `docs/PLATFORM.md`.
 *
 * Kept separate from `types.ts` (which is the signaling contract) so the video
 * app's frozen protocol file stays untouched by anything social.
 */

/** A post as any viewer sees it — `owned`/`liked` are per-viewer flags. */
export interface Post {
  id: number;
  creatorId: number;
  creatorName: string;
  creatorCountry: string;
  /** Banned creators are hidden from the action row; the server refuses too. */
  creatorBanned?: boolean;
  /** Viewer-specific follow state, annotated by the feed/detail endpoints. */
  creatorFollowing?: boolean;
  creatorSubscribed?: boolean;
  /** The creator's current offer, so a post can subscribe without a detour. */
  creatorSubscription?: CreatorSubscriptionOffer;
  type: 'image' | 'video' | 'link' | 'text';
  caption: string;
  /** `/api/posts/<id>/media` when the viewer may see it, otherwise null. */
  mediaUrl: string | null;
  linkUrl: string | null;
  price: number;
  currency: string;
  isAdult: boolean;
  status: 'active' | 'hidden' | 'removed';
  views: number;
  likes: number;
  comments: number;
  purchases: number;
  liked: boolean;
  owned: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

export interface Comment {
  id: number;
  postId: number;
  username: string;
  body: string;
  status: string;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** One STK push — `pending` → the phone has the prompt up; poll until it moves. */
export interface Charge {
  id: number;
  purpose: 'post' | 'room' | 'premium' | 'sub';
  refId: number;
  amount: number;
  currency: string;
  commission: number;
  net: number;
  /** `premium` only: the period stamped onto the charge when it was opened. */
  premiumDays: number | null;
  /** `sub` only: the subscription period quoted when the prompt was opened. */
  periodDays: number | null;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  phone: string;
  mpesaRef: string | null;
  checkoutRequestId: string | null;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface Wallet {
  accountId: number;
  username: string;
  balance: number;
  lifetimeIn: number;
  lifetimeOut: number;
  updatedAt: string | null;
}

export interface WalletEntry {
  id: number;
  accountId: number;
  amount: number;
  kind: 'sale' | 'adjustment' | 'withdrawal';
  status: 'posted' | 'pending' | 'approved' | 'rejected';
  chargeId: number | null;
  memo: string | null;
  username?: string;
  createdAt: string;
}

export interface Room {
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
}

/** Roster entry broadcast on `room:state` / returned by `room:joined`. */
export interface RoomPeer {
  id: number;
  username: string;
  country?: string;
}

/** What `GET /api/rooms/:slug` says about this viewer's right to enter. */
export interface RoomAccess {
  room: Room;
  entitled: boolean;
  canEnter: boolean;
  reason: string | null;
}

/** The public economics block from `GET /api/config`. */
export interface CommerceConfig {
  enabled: boolean;
  social: boolean;
  groups: boolean;
  adult: boolean;
  /** The house cut on every sale, in percent (0–50). */
  commissionRate: number;
  minPrice: number;
  maxPrice: number;
  currency: string;
  /**
   * Whether Daraja can actually take money right now (credentials + shortcode
   * + passkey all present). Every payment is an STK push, so this decides
   * whether a Pay button can promise a prompt at all.
   */
  mpesaReady: boolean;
}

/** Payment inputs shared by the pay sheet for posts, rooms and subscriptions. */
export interface PayTarget {
  purpose: 'post' | 'room' | 'sub';
  refId: number;
  amount: number;
  currency: string;
  title: string;
  /** `sub` only: shown as "for N days" under the amount. */
  periodDays?: number;
}

/** What a creator charges for access — `enabled: false` means no subscribers. */
export interface CreatorSubscriptionOffer {
  enabled: boolean;
  price: number;
  currency: string;
  periodDays: number;
  perk: string;
}

/** One subscriber/creator pair; renewals extend `expiresAt` in place. */
export interface Subscription {
  id: number;
  subscriberId: number;
  creatorId: number;
  status: 'active' | 'canceled' | 'expired';
  price: number;
  currency: string;
  periodDays: number;
  chargeId: number | null;
  startedAt: string;
  expiresAt: string | null;
  canceledAt: string | null;
}

/** The public creator card behind `/creator/:id`. */
export interface Creator {
  id: number;
  username: string;
  country: string;
  banned: boolean;
  createdAt: string;
  followers: number;
  following: number;
  posts: number;
  subscribers: number;
  subscription: CreatorSubscriptionOffer;
  viewer: {
    isSelf: boolean;
    following: boolean;
    subscribed: boolean;
    subscription: Subscription | null;
  };
}

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

/** One STK push / manual payment request. `pending` → poll until it moves. */
export interface Charge {
  id: number;
  purpose: 'post' | 'room';
  refId: number;
  amount: number;
  currency: string;
  commission: number;
  net: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  phone: string;
  mpesaRef: string | null;
  checkoutRequestId: string | null;
  error: string | null;
  /** Manual mode only: paybill + reference the payer must use. */
  instructions: string | null;
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
  /** `stk` = Daraja prompt for the PIN, `manual` = paybill + owner approval. */
  payMode: 'stk' | 'manual';
  paybill: string;
}

/** Payment inputs shared by the pay sheet for posts and room entry alike. */
export interface PayTarget {
  purpose: 'post' | 'room';
  refId: number;
  amount: number;
  currency: string;
  title: string;
}

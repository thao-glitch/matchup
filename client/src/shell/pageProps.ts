/**
 * The props every social page receives from `Shell`.
 *
 * Pages never own the session or the config: one silent login and one
 * `/api/config` fetch live in the shell, and everything else is passed down —
 * the same "no context providers" convention the video app already uses.
 */
import type { AccountUser } from '../types';
import type { PublicConfig } from '../lib/config';

export interface PageProps {
  /** The signed-in account, or null. */
  account: AccountUser | null;
  /** Feature switches + the platform's economics, from `GET /api/config`. */
  config: PublicConfig;
  /** Captured path params — `/post/:id` gives `{ id: '42' }`. */
  params: Record<string, string>;
  /**
   * Open the sign-in card when signed out. Returns `true` when the user is
   * already signed in, so a page can write `if (!requireAuth('…')) return;`.
   * After signing in mid-action the user repeats the action — nothing is
   * silently replayed.
   */
  requireAuth: (context?: string) => boolean;
  /** Replace the shell's account (sign-in / sign-out flows). */
  onAccountChange: (user: AccountUser | null) => void;
  /**
   * True when this viewer may see18+ content: the platform allows it, their
   * account is 18+, and they have acknowledged the adult section on this
   * device. The server enforces the same rules again on every request.
   */
  adultOk: boolean;
  /** Record the18+ acknowledgement for this device. */
  acknowledgeAdult: () => void;
}

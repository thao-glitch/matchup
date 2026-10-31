/**
 * Follow / subscribe controls attached to a post.
 *
 * The feed and explore tiles used to be pure navigation: seeing someone you
 * liked meant opening their profile before you could follow them. These
 * compact pills put both actions where the creator's name already is, while
 * keeping the card itself clickable. Paid offers open the same `PaySheet` the
 * creator page uses; free offers activate in one tap.
 */
import { useEffect, useState } from 'react';
import type { AccountUser } from '../types';
import type { CreatorSubscriptionOffer, PayTarget } from '../types/social';
import type { PublicConfig } from '../lib/config';
import {
  SocialError,
  followCreator,
  formatKes,
  subscribeToCreator,
} from '../lib/social';
import PaySheet from './PaySheet';
import { SpinnerIcon } from './icons';

export interface CreatorActionsProps {
  creatorId: number;
  creatorName: string;
  creatorBanned?: boolean;
  following: boolean;
  subscribed: boolean;
  offer: Pick<CreatorSubscriptionOffer, 'enabled' | 'price' | 'currency' | 'periodDays'>;
  account: AccountUser | null;
  config: PublicConfig;
  requireAuth: (context?: string) => boolean;
  compact?: boolean;
  onChange?: (state: { following: boolean; subscribed: boolean }) => void;
}

function messageOf(err: unknown): string {
  return err instanceof SocialError ? err.message : 'Something went wrong — try again.';
}

export default function CreatorActions({
  creatorId,
  creatorName,
  creatorBanned = false,
  following,
  subscribed,
  offer,
  account,
  config,
  requireAuth,
  compact = false,
  onChange,
}: CreatorActionsProps) {
  const [isFollowing, setIsFollowing] = useState(following);
  const [isSubscribed, setIsSubscribed] = useState(subscribed);
  const [followBusy, setFollowBusy] = useState(false);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);

  // A refetch on the parent (post detail after unlocking, creator page after a
  // renewal) is the authority; optimistic state only lives until that arrives.
  useEffect(() => {
    setIsFollowing(following);
    setIsSubscribed(subscribed);
  }, [creatorId, following, subscribed]);

  const isSelf = Boolean(account?.id && account.id === creatorId);
  if (creatorBanned || isSelf) return null;

  async function toggleFollow() {
    if (followBusy) return;
    if (!requireAuth('Sign in to follow creators.')) return;
    const next = !isFollowing;
    setFollowBusy(true);
    setError(null);
    setIsFollowing(next);
    try {
      const res = await followCreator(creatorId, next);
      setIsFollowing(res.following);
      onChange?.({ following: res.following, subscribed: isSubscribed });
    } catch (err) {
      setIsFollowing(!next);
      setError(messageOf(err));
    } finally {
      setFollowBusy(false);
    }
  }

  async function subscribeFree() {
    if (subscribeBusy) return;
    if (!requireAuth('Sign in to subscribe.')) return;
    setSubscribeBusy(true);
    setError(null);
    try {
      await subscribeToCreator(creatorId);
      setIsSubscribed(true);
      onChange?.({ following: isFollowing, subscribed: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubscribeBusy(false);
    }
  }

  function startPaid() {
    if (!requireAuth('Sign in to subscribe.')) return;
    setError(null);
    setPayTarget({
      purpose: 'sub',
      refId: creatorId,
      amount: offer.price,
      currency: offer.currency,
      title: `Subscribe to @${creatorName}`,
      periodDays: offer.periodDays,
    });
  }

  const pill = compact
    ? 'rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors'
    : 'btn px-3 py-1.5 text-xs';

  return (
    <div
      className={compact ? 'flex flex-wrap items-center gap-1.5' : 'flex flex-wrap items-center gap-2'}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`${pill} ${
          isFollowing
            ? 'border-white/15 bg-white/5 text-muted hover:bg-white/10'
            : 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
        }`}
        onClick={() => void toggleFollow()}
        disabled={followBusy}
        aria-pressed={isFollowing}
      >
        {followBusy ? <SpinnerIcon className={compact ? 'h-3 w-3' : 'h-4 w-4'} /> : null}
        {isFollowing ? 'Following' : 'Follow'}
      </button>

      {isSubscribed ? (
        <span
          className={`${pill} border-ok/30 bg-ok/10 text-ok`}
          title="An active subscription unlocks this creator's paid posts"
        >
          Subscribed
        </span>
      ) : offer.enabled ? (
        <button
          type="button"
          className={`${pill} border-accent/50 bg-accent text-black hover:bg-accent/90`}
          onClick={() => (offer.price > 0 ? startPaid() : void subscribeFree())}
          disabled={subscribeBusy}
        >
          {subscribeBusy ? <SpinnerIcon className={compact ? 'h-3 w-3' : 'h-4 w-4'} /> : null}
          {offer.price > 0 ? `Subscribe · ${formatKes(offer.price)}` : 'Subscribe free'}
        </button>
      ) : null}

      {error && <span className="text-[10px] text-danger">{error}</span>}

      {payTarget && (
        <PaySheet
          target={payTarget}
          config={config}
          account={account}
          onRequireAuth={() => requireAuth('Sign in to subscribe.')}
          onPaid={() => {
            setPayTarget(null);
            setIsSubscribed(true);
            onChange?.({ following: isFollowing, subscribed: true });
          }}
          onClose={() => setPayTarget(null)}
        />
      )}
    </div>
  );
}

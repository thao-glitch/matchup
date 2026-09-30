import { useEffect, useRef, useState } from 'react';
import { PhoneOffIcon, flagFromCountry } from './icons';
import { shareConnection } from '../lib/postcard';
import { countryName } from '../lib/countries';
import type { ShareMeta, StampInfo } from '../types';

interface Props {
  /** "Call ended" when you hung up, "Stranger disconnected" when they did. */
  title: string;
  detail: string;
  /** Straight back into the queue for a new stranger. */
  onNext: () => void;
  /** Back to the profile screen — stop matching for now. */
  onStop: () => void;
  /**
   * Present only when the call actually connected: what the card may show —
   * your two countries and how long you talked, nothing else. `null` after a
   * call that never got media (failed to connect), where there is nothing
   * honest to share.
   */
  share?: ShareMeta | null;
  /** The passport stamp this call produced — the celebration at the top. */
  stamp?: StampInfo | null;
  /** Chemistry score from the call's playground (>50 = real interaction). */
  compat?: number | null;
}

/**
 * The screen a call lands on when it finishes, whichever side ended it.
 *
 * This exists because hanging up used to leave people stuck: the old flow
 * re-queued automatically and the only way out was a "Cancel" on the waiting
 * screen. Now every call ends with an explicit choice — **Next** (keep going)
 * or **Stop matching** (done for now, profile stays editable) — plus, after a
 * real conversation, an optional **Share this connection** that turns the call
 * into a story-format card (see `lib/postcard.ts`).
 */
export default function PostCall({ title, detail, onNext, onStop, share, stamp, compat }: Props) {
  const [sharing, setSharing] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  // The object URL lives in a ref too, so a re-render (or unmount) can revoke
  // the previous card instead of leaking one blob URL per share.
  const cardUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (cardUrlRef.current) URL.revokeObjectURL(cardUrlRef.current);
    },
    [],
  );

  const showCard = (url: string | null) => {
    if (cardUrlRef.current && cardUrlRef.current !== url) {
      URL.revokeObjectURL(cardUrlRef.current);
    }
    cardUrlRef.current = url;
    setCardUrl(url);
  };

  const handleShare = async () => {
    if (!share || sharing) return;
    setSharing(true);
    try {
      // Never throws — always resolves to { status, cardUrl }.
      const result = await shareConnection(share);
      showCard(result.cardUrl);
      setShareStatus(result.status);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-10 text-center">
      <div className="card w-full p-7">
        {stamp && (
          <div className="mb-5 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-left" role="status">
            <p className="text-xs font-semibold uppercase tracking-widest text-accent">
              {stamp.isNew ? '🌍 New stamp!' : '🌍 Stamp collected'}
            </p>
            <p className="mt-1 text-lg font-semibold text-ink">
              {flagFromCountry(stamp.code)} {countryName(stamp.code)} · {stamp.unique}{' '}
              {stamp.unique === 1 ? 'country' : 'countries'} in your passport
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {stamp.streak > 1
                ? `🔥 ${stamp.streak}-day streak — stamp again tomorrow to keep it.`
                : '🔥 Your streak starts today — stamp again tomorrow.'}
            </p>
          </div>
        )}

        {/* Chemistry recap — only when the playground actually got used. */}
        {compat != null && compat > 50 && (
          <p className="mx-auto mb-5 w-fit rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-semibold text-accent" role="status">
            🧬 Chemistry {compat}%
            {compat >= 75 ? ' — you two really clicked' : ''}
          </p>
        )}

        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
          <PhoneOffIcon className="h-6 w-6" />
        </div>

        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{detail}</p>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={onNext}
            className="btn btn-primary px-8 py-3 text-base"
            autoFocus
          >
            Next
          </button>
          <button type="button" onClick={onStop} className="btn btn-ghost px-6 py-3 text-base">
            Stop matching
          </button>
        </div>

        <p className="mx-auto mt-6 max-w-md text-xs leading-relaxed text-muted">
          <span className="font-semibold text-ink">Next</span> puts you straight back in the queue
          for someone new.{' '}
          <span className="font-semibold text-ink">Stop matching</span> takes you back to your
          profile, where you can change anything before starting again.
        </p>

        {share && (
          <div className="mt-6 border-t border-white/10 pt-5">
            <button
              type="button"
              onClick={handleShare}
              disabled={sharing}
              className="btn btn-ghost mx-auto flex w-full items-center justify-center gap-2 py-3"
            >
              {sharing ? 'Building your card…' : '💌  Share this connection'}
            </button>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
              {shareStatus ? (
                <span role="status" className="break-words text-ink">
                  {shareStatus}
                </span>
              ) : (
                <>
                  A card with your two countries and how long you talked — no names, no faces,
                  sent straight to your phone&apos;s share sheet.
                </>
              )}
            </p>
            {cardUrl && (
              <img
                src={cardUrl}
                alt="Your connection card"
                className="mx-auto mt-4 max-h-72 rounded-2xl border border-white/10 shadow-lg"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

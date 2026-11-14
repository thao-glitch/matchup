/**
 * Avatar — the creator's photo with their first letter underneath.
 *
 * One component so every circle on the site behaves identically: the photo is
 * an ordinary `<img>` layered over the initial, and an error (no photo yet, a
 * deleted file, a slow API host) simply drops back to the letter instead of
 * showing a broken-image glyph. `onError` is the whole fallback strategy —
 * there is no pre-flight request for "does this user have an avatar", which
 * would double the round trips on a feed of twenty cards.
 *
 * The URL is passed through `mediaSrc()` because profile photos live on the
 * API host, not behind the SPA's origin (see `lib/mediaUrl.ts`).
 */
import { mediaSrc } from '../lib/mediaUrl';

export interface AvatarProps {
  username: string;
  /** Path from the API (`/api/profile/<name>/photo/avatar`) or null. */
  src?: string | null;
  /** Tailwind size classes — the caller owns the box. */
  className?: string;
  /** Font size for the fallback letter; match it to the box. */
  letterClass?: string;
  /** Flag badge pinned bottom-right, as on the creator card. */
  children?: React.ReactNode;
}

export default function Avatar({
  username,
  src,
  className = 'h-10 w-10',
  letterClass = 'text-base',
  children,
}: AvatarProps) {
  const url = mediaSrc(src);
  const letter = (username || '?').slice(0, 1).toUpperCase();

  return (
    <span className={`relative block shrink-0 ${className}`}>
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-accent/20 font-black text-accent">
        <span className={`${letterClass} leading-none`}>{letter}</span>
      </span>
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full rounded-full object-cover"
          onError={(event) => {
            // No photo (404) or the file is gone: the letter is already
            // underneath, so removing the broken image is the whole recovery.
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      {children ? (
        <span className="absolute -bottom-0.5 -right-0.5 leading-none">{children}</span>
      ) : null}
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';

/**
 * A post photo that shrugs off a flaky transport.
 *
 * A failed `<img>` load never retries on its own: the browser marks it broken
 * and only a full page reload brings the picture back. The signaling host sits
 * behind a Cloudflare quick tunnel, which drops individual connections now and
 * then (`ERR_TUNNEL_CONNECTION_FAILED`), so without this one blip leaves a
 * permanently broken card in the feed until someone hits refresh.
 *
 * So: a few spaced retries, then stand down and let the alt text stand. The
 * extra `retry=N` query param busts the cached failure, and signed `?t=`
 * claims ignore unknown parameters, so gated media keeps its entitlement.
 */
interface MediaImgProps {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}

const MAX_RETRIES = 3;
const BACKOFF_MS = 800;

export default function MediaImg({ src, alt, className, loading = 'lazy' }: MediaImgProps) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  // React reuses the same <img> between posts, so a new src is a fresh budget:
  // without this the retries spent on one photo would carry over to the next.
  useEffect(() => {
    setAttempt(0);
    return () => window.clearTimeout(timer.current);
  }, [src]);

  const scheduleRetry = () => {
    if (attempt >= MAX_RETRIES) return;
    timer.current = window.setTimeout(() => setAttempt((n) => n + 1), BACKOFF_MS * (attempt + 1));
  };

  const url = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`;

  return (
    <img
      src={url}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      onError={scheduleRetry}
    />
  );
}

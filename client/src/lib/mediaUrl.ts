import { SIGNALING_URL } from './iceServers';

/**
 * `mediaUrl` as the API hands it over is a path **on the signaling server**
 * (`/api/posts/23/media?t=…`), never a full URL.
 *
 * On this deployment the bundle is served by Vercel and the API lives on the
 * tunnel host, so an `<img src="/api/…">` resolves against the wrong origin:
 * Vercel's SPA rewrite answers `text/html` and the picture comes up broken.
 * The `<img>` element also cannot send a `Bearer` header, which is exactly why
 * paid media carries its `?t=` claim on the URL — so this prefix must leave the
 * query string untouched.
 *
 * Local dev (empty `SIGNALING_URL`, proxied by Vite) keeps the bare path.
 */
export function mediaSrc(url: string | null | undefined): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${SIGNALING_URL.replace(/\/$/, '')}${url}`;
}

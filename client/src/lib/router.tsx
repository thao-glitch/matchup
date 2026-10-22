/**
 * A ~90-line pathname router — the app has never needed a router library, and
 * the platform's eight pages are all top-level screens, not nested layouts.
 *
 * How it works:
 *   • `navigate('/wallet')` pushes state and notifies listeners synchronously;
 *   • `useRoute()` re-renders on `popstate` (back/forward) and on that notify;
 *   • `<Link>` is a real `<a href>` — middle-click, "open in new tab" and the
 *     browser's own history all keep working, because only a plain left click
 *     is intercepted.
 *
 * The server already serves `index.html` for any non-`/api` GET, so a deep
 * link like `/post/42` survives a reload without any server change.
 */
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

const NAV_EVENT = 'matchup:navigate';

/** Push a path and tell the app to re-render. No-op on the current path. */
export function navigate(to: string, { replace = false } = {}): void {
  const current = window.location.pathname;
  if (to === current) return;
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(NAV_EVENT));
  // A new page starts at the top — the old scroll position would land
  // somewhere random on a shorter page.
  window.scrollTo({ top: 0 });
}

/** The current pathname, kept live across clicks and history moves. */
export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);
  return path;
}

/**
 * Match `/post/42` against a pattern like `/post/:id`.
 * Returns the captured params, or `null` when the pattern does not fit.
 */
export function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

/** An `<a>` that navigates in-app on a plain click, like the browser intends. */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      rest.target === '_blank'
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

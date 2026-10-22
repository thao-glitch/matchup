import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './admin/AdminApp';
import Shell from './shell/Shell';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

/**
 * Three apps, one bundle:
 *
 *   `/admin`        → the owner's dashboard (own auth, own chrome);
 *   `/match`        → the original 1v1 video chat, full bleed (via `Shell`);
 *   everything else → the social shell (feed, posts, live, wallet, profile).
 *
 * `Shell` does the rest of the routing with the pathname hook in
 * `lib/router.tsx` — no router library, and the server's SPA fallback already
 * serves `index.html` for any non-`/api` GET, so deep links survive reloads.
 */
const isAdmin = window.location.pathname.startsWith('/admin');

createRoot(container).render(
  <StrictMode>{isAdmin ? <AdminApp /> : <Shell />}</StrictMode>,
);

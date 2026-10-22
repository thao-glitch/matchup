/**
 * Admin dashboard shell — auth gate, header, tab bar, screen switch.
 *
 * The host app mounts this component at `/admin` and knows nothing about it,
 * so everything the page needs (own container, own login screen, own header)
 * lives here. There are exactly three states:
 *
 *   checking  → we ask `/me` with the stored token (silent re-login);
 *   signed out→ the login form; a 401 anywhere in the dashboard lands here too
 *               via `onUnauthorized`, which already cleared the token;
 *   signed in → header + tabs; each tab fetches its own data on mount.
 *
 * Tabs render conditionally (not side by side) so an inactive Overview stops
 * polling the moment the admin switches away — a background tab must not
 * keep hammering the server every 15 seconds.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  clearToken,
  errorMessage,
  getToken,
  onUnauthorized,
  request,
  setToken,
  type AdminIdentity,
} from './api';
import { ErrorBanner, Pill } from './ui';
import OverviewTab from './OverviewTab';
import UsersTab from './UsersTab';
import PaymentsTab from './PaymentsTab';
import ContentTab from './ContentTab';
import EarningsTab from './EarningsTab';
import RoomsTab from './RoomsTab';
import SettingsTab from './SettingsTab';
import AuditTab from './AuditTab';

type TabId = 'overview' | 'users' | 'payments' | 'content' | 'earnings' | 'rooms' | 'settings' | 'audit';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'payments', label: 'Payments' },
  { id: 'content', label: 'Content' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'settings', label: 'Settings' },
  { id: 'audit', label: 'Audit' },
];

export default function AdminApp() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  /** Still asking `/me` — showing the login form for a moment would be a flash. */
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<TabId>('overview');

  // Silent re-login on mount: a reload mid-session must not ask for the
  // password again, but an expired token must drop straight to the login form.
  useEffect(() => {
    let disposed = false;
    if (!getToken()) {
      setChecking(false);
      return;
    }
    void (async () => {
      try {
        const data = await request<{ admin: AdminIdentity }>('/me');
        if (!disposed) setAdmin(data.admin);
      } catch (err) {
        // 401 is already handled globally (token cleared, listener fired);
        // any other failure means we simply start signed out rather than
        // trapping the admin on an eternal spinner.
        if (!(err instanceof ApiError)) console.warn('[admin] /me failed:', err);
      } finally {
        if (!disposed) setChecking(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // A dead session discovered by ANY tab (poll, save, page change) drops the
  // whole dashboard back to the login screen in one place.
  useEffect(
    () =>
      onUnauthorized(() => {
        setAdmin(null);
        setTab('overview');
      }),
    [],
  );

  async function signOut() {
    // Best effort: even if the network call fails the local token must go,
    // otherwise the next visit would loop on a dead session.
    try {
      await request('/logout', { method: 'POST' });
    } catch {
      // Token already invalid — the goal (local sign-out) is achieved anyway.
    }
    clearToken();
    setAdmin(null);
  }

  if (checking) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center px-4">
        <p className="text-sm text-muted">Checking session…</p>
      </div>
    );
  }

  if (!admin) return <LoginScreen onSignedIn={setAdmin} />;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-ink">Matchup Admin</h1>
          <p className="text-xs text-muted">Operations dashboard — users, payments and config</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-muted">
            @{admin.username}
            <Pill tone="accent">{admin.role}</Pill>
          </span>
          <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {/* Horizontal scroll instead of wrapping: a wrapped tab bar reflows the
          whole page every time the window narrows past a phone width. */}
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-white/10">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-current={tab === item.id ? 'page' : undefined}
            className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              tab === item.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'content' && <ContentTab />}
      {tab === 'earnings' && <EarningsTab />}
      {tab === 'rooms' && <RoomsTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

/**
 * Login card. A plain `<form>` so Enter submits natively — the admin signs in
 * from the keyboard, and hijacking that with a keydown handler would only
 * break paste/autofill edge cases.
 */
function LoginScreen({ onSignedIn }: { onSignedIn: (admin: AdminIdentity) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await request<{ token: string; admin: AdminIdentity }>('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      onSignedIn(data.admin);
    } catch (err) {
      // Server messages are written for humans ("That username or password is
      // incorrect.") — show them as-is instead of inventing wording.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4 py-10">
      <form onSubmit={(event) => void submit(event)} className="card w-full max-w-sm p-6 sm:p-7">
        <h1 className="text-lg font-bold text-ink">Matchup Admin</h1>
        <p className="mb-5 mt-1 text-xs text-muted">Sign in with an owner account to open the dashboard.</p>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        <label className="label" htmlFor="admin-username">
          Username
        </label>
        <input
          id="admin-username"
          className="field mb-4"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />

        <label className="label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          className="field mb-5"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button type="submit" className="btn btn-primary w-full" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

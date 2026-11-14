/**
 * Shell — the social app's chrome: session, config, navigation and routing.
 *
 * `main.tsx` mounts this for every path except `/admin`. It owns the two
 * things every page needs (the signed-in account and `/api/config`) and
 * renders exactly one page at a time — inactive pages unmount, so a feed
 * poll or a camera never keeps running behind another screen.
 *
 * Layout: a top bar (brand + compose + session) and a bottom tab bar (six
 * tabs, the thumb-reachable pattern on phones, with the 1v1 match — the
 * product's flagship — as the emphasised centre tab). Two routes opt out and
 * render full bleed, because navigation chrome over a live call is worse than
 * useless:
 *
 *   `/match`      → the original 1v1 video app
 *   `/room/:slug` → a group call / conference
 *
 * There is no router library: `lib/router.tsx` is a pathname hook, and the
 * table below is the whole site map. The server already serves `index.html`
 * for any non-`/api` GET, so every path above deep-links and reloads.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_CONFIG, loadConfig, type PublicConfig } from '../lib/config';
import { loadAccount, signOutAccount } from '../lib/auth';
import { Link, matchRoute, navigate, useRoute } from '../lib/router';
import type { AccountUser } from '../types';
import AuthDialog from '../components/AuthDialog';
import Avatar from '../components/Avatar';
import {
  AlertIcon,
  CamIcon,
  CompassIcon,
  HomeIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
  VideoIcon,
  WalletIcon,
} from '../components/icons';
import type { PageProps } from './pageProps';
import FeedPage from '../pages/FeedPage';
import ExplorePage from '../pages/ExplorePage';
import CreatePostPage from '../pages/CreatePostPage';
import PostDetailPage from '../pages/PostDetailPage';
import LivePage from '../pages/LivePage';
import RoomPage from '../pages/RoomPage';
import WalletPage from '../pages/WalletPage';
import ProfilePage from '../pages/ProfilePage';
import CreatorPage from '../pages/CreatorPage';
import SettingsPage from '../pages/SettingsPage';
import MatchPage from '../pages/MatchPage';

/** localStorage key: this device has been told the section is adults only. */
const ADULT_ACK_KEY = 'matchup.adult.ack';

interface Tab {
  to: string;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
  /** The flagship tab — rendered as a raised, gradient pill. */
  primary?: boolean;
}

const TABS: Tab[] = [
  { to: '/', label: 'Feed', icon: HomeIcon },
  { to: '/explore', label: 'Explore', icon: CompassIcon },
  { to: '/live', label: 'Live', icon: VideoIcon },
  { to: '/match', label: 'Match', icon: CamIcon, primary: true },
  { to: '/wallet', label: 'Wallet', icon: WalletIcon },
  { to: '/profile', label: 'You', icon: UserIcon },
];

/** Routes where the tab bar would sit on top of a live call. */
const FULL_BLEED = ['/match'];

function readAdultAck(): boolean {
  try {
    return localStorage.getItem(ADULT_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Shell() {
  const path = useRoute();
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_CONFIG);
  /** Non-null = the sign-in card is open, with the reason that opened it. */
  const [authPrompt, setAuthPrompt] = useState<string | null>(null);
  const [adultAck, setAdultAck] = useState(readAdultAck);

  // Silent re-login: a returning visitor lands already signed in.
  useEffect(() => {
    let cancelled = false;
    void loadAccount().then((user) => {
      if (!cancelled && user) setAccount(user);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Feature switches + the platform's economics, once per page load.
  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((cfg) => {
      if (!cancelled) setConfig(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyAccount = useCallback((user: AccountUser | null) => setAccount(user), []);

  const requireAuth = useCallback((context?: string) => {
    if (account) return true;
    setAuthPrompt(context ?? 'Sign in to continue.');
    return false;
  }, [account]);

  const acknowledgeAdult = useCallback(() => {
    try {
      localStorage.setItem(ADULT_ACK_KEY, '1');
    } catch {
      /* private mode — the session-local flag below still applies */
    }
    setAdultAck(true);
  }, []);

  const adultOk = Boolean(
    config.commerce.adult && account && Number(account.profile?.age) >= 18 && adultAck,
  );

  const pageProps: PageProps = useMemo(
    () => ({
      account,
      config,
      params: {},
      requireAuth,
      onAccountChange: applyAccount,
      adultOk,
      acknowledgeAdult,
    }),
    [account, config, requireAuth, applyAccount, adultOk, acknowledgeAdult],
  );

  const withParams = (params: Record<string, string>): PageProps => ({ ...pageProps, params });

  // ── Route table ───────────────────────────────────────────────────────────
  let content: ReactNode;
  let params: Record<string, string> | null = null;
  let fullBleed = FULL_BLEED.includes(path);

  if ((params = matchRoute(path, '/post/:id'))) {
    content = <PostDetailPage {...withParams(params)} />;
  } else if ((params = matchRoute(path, '/creator/:id'))) {
    content = <CreatorPage {...withParams(params)} />;
  } else if ((params = matchRoute(path, '/room/:slug'))) {
    content = <RoomPage {...withParams(params)} />;
    fullBleed = true;
  } else if (path === '/explore') {
    content = <ExplorePage {...pageProps} />;
  } else if (path === '/create') {
    content = <CreatePostPage {...pageProps} />;
  } else if (path === '/live') {
    content = <LivePage {...pageProps} />;
  } else if (path === '/wallet') {
    content = <WalletPage {...pageProps} />;
  } else if (path === '/profile') {
    content = <ProfilePage {...pageProps} />;
  } else if (path === '/settings') {
    content = <SettingsPage {...pageProps} />;
  } else if (path === '/match') {
    content = <MatchPage />;
  } else if (path === '/') {
    content = <FeedPage {...pageProps} />;
  } else {
    // Unknown path → the feed, without a history rewrite: the address bar
    // keeps what the user typed so a typo is obvious and fixable.
    content = <FeedPage {...pageProps} />;
  }

  const maintenance = config.features.maintenance;

  return (
    <div className="app-bg relative flex min-h-full flex-col">
      {!fullBleed && (
        <header className="sticky top-0 z-40 border-b border-white/10 bg-surface/80 backdrop-blur supports-[backdrop-filter]:bg-surface/65">
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" aria-hidden="true" />
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3">
            <Link to="/" className="flex items-center gap-2" aria-label="Matchup home">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-xs font-black text-white shadow-[0_6px_16px_-6px_rgba(91,140,255,0.9)]">
                M
              </span>
              <span className="text-sm font-bold tracking-tight text-ink">Matchup</span>
            </Link>

            <nav className="flex items-center gap-1.5 text-xs">
              <Link
                to="/create"
                className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-ink"
                aria-label="Create post"
              >
                <PlusIcon className="h-4.5 w-4.5" />
              </Link>
              <Link
                to="/settings"
                className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-ink"
                aria-label="Settings"
              >
                <SettingsIcon className="h-4.5 w-4.5" />
              </Link>
              {account ? (
                <Link
                  to="/profile"
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-ink transition-colors hover:bg-white/10"
                >
                  <Avatar
                    username={account.username}
                    src={account.avatarUrl}
                    className="h-6 w-6"
                    letterClass="text-[11px]"
                  />
                  <span className="max-w-[9rem] truncate font-medium">{account.username}</span>
                </Link>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary px-3 py-1.5 text-xs"
                  onClick={() => setAuthPrompt('Sign in to post, pay and call.')}
                >
                  Sign in
                </button>
              )}
            </nav>
          </div>
        </header>
      )}

      <main className={`flex-1 ${fullBleed ? '' : 'mx-auto w-full max-w-5xl px-4 pb-24 pt-5 sm:px-6'}`}>
        {content}
      </main>

      {!fullBleed && (
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-surface/90 backdrop-blur">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" aria-hidden="true" />
          <div className="mx-auto grid w-full max-w-5xl grid-cols-6">
            {TABS.map((tab) => {
              const active = tab.to === path;
              const Icon = tab.icon;
              if (tab.primary) {
                // The 1v1 match is the product's flagship: a raised pill, not a
                // flat icon, so it reads instantly among the plain tabs.
                return (
                  <Link
                    key={tab.to}
                    to={tab.to}
                    aria-current={active ? 'page' : undefined}
                    className="flex flex-col items-center gap-1 py-1.5 text-[10px] font-semibold transition-colors"
                  >
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-full shadow-lg shadow-accent/30 transition-colors ${
                        active
                          ? 'bg-gradient-to-br from-accent to-accent-2 text-white'
                          : 'bg-white/10 text-ink'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className={active ? 'text-accent' : 'text-muted'}>{tab.label}</span>
                  </Link>
                );
              }
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors ${
                    active ? 'text-accent' : 'text-muted hover:text-ink'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {authPrompt !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <AuthDialog
            context={authPrompt}
            onSignedIn={(user) => {
              applyAccount(user);
              setAuthPrompt(null);
            }}
            onDismiss={() => setAuthPrompt(null)}
          />
        </div>
      )}

      {maintenance && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-warn/15 px-4 py-2 text-xs font-medium text-warn backdrop-blur">
          <AlertIcon className="h-4 w-4" />
          Some features are paused for maintenance — check back shortly.
        </div>
      )}
    </div>
  );
}

/** Shared sign-out used by the settings and profile pages. */
export async function signOut(account: AccountUser | null): Promise<void> {
  if (!account) return;
  await signOutAccount();
  navigate('/');
}

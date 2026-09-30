/**
 * Account API client — username + password, token kept in localStorage.
 *
 * Everything talks to the signaling server (`VITE_SIGNALING_URL`), the same
 * origin that serves `/api/ice`, so CORS is already pinned to the app's
 * origins on the server side.
 *
 * The token is a 32-byte bearer string: the server only stores its SHA-256,
 * so a stolen database row cannot be replayed. Losing the token (clearing
 * site data) just means signing in again — nothing is destroyed.
 */
import type { AccountUser, Profile } from '../types';
import { SIGNALING_URL } from './iceServers';

const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api/auth`;
const TOKEN_KEY = 'matchup.token';

export class AuthError extends Error {
  readonly code: string;
  constructor(message: string, code = 'auth') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode / storage disabled — the session simply won't persist */
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    throw new AuthError('Could not reach the server — check your connection.', 'network');
  }

  const text = await res.text();
  let data: { error?: { code?: string; message?: string } } | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error body — fall through to the status message */
    }
  }

  if (!res.ok) {
    const code = data?.error?.code ?? 'http';
    // An expired/revoked session is not worth retrying — drop the token now so
    // the UI flips back to "sign in" instead of failing silently later.
    if (res.status === 401) setToken(null);
    throw new AuthError(data?.error?.message ?? `Request failed (${res.status}).`, code);
  }

  return data as T;
}

/** Create an account from the lobby profile. Returns the user + session token. */
export async function registerAccount(
  username: string,
  password: string,
  profile: Profile,
): Promise<AccountUser> {
  const data = await request<{ token: string; user: AccountUser }>('/register', {
    method: 'POST',
    body: { username, password, profile },
  });
  setToken(data.token);
  return data.user;
}

/** Sign in with an existing username + password. */
export async function loginAccount(username: string, password: string): Promise<AccountUser> {
  const data = await request<{ token: string; user: AccountUser }>('/login', {
    method: 'POST',
    body: { username, password },
  });
  setToken(data.token);
  return data.user;
}

/**
 * Silent re-login on page load: `null` means "not signed in" for any reason
 * (no token, expired token, server unreachable) — never throws, so boot can't
 * be broken by an auth problem.
 */
export async function loadAccount(): Promise<AccountUser | null> {
  if (!getToken()) return null;
  try {
    const data = await request<{ user: AccountUser }>('/me');
    return data.user;
  } catch {
    return null;
  }
}

/** Persist the (fully editable) profile onto the signed-in account. */
export async function saveAccountProfile(profile: Profile): Promise<AccountUser> {
  const data = await request<{ user: AccountUser }>('/profile', {
    method: 'PUT',
    body: { profile },
  });
  return data.user;
}

/** Revoke the session server-side, then drop the local token. Never throws. */
export async function signOutAccount(): Promise<void> {
  try {
    await request('/logout', { method: 'POST' });
  } catch {
    /* best effort — the local token is cleared either way */
  }
  setToken(null);
}

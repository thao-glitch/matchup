/**
 * Sign-in / sign-up card used by every social page.
 *
 * The lobby already has its own inline auth (`LobbyForm`) for the video app —
 * this is the standalone version for pages that hit a 401 mid-flow, e.g.
 * pressing **Pay** or **Publish** while signed out. It renders in place
 * (the page decides where) rather than as a modal, so a phone keyboard never
 * fights a backdrop.
 *
 * One field set, two outcomes: the server decides whether the username already
 * exists (`register` → "That username is taken", then the page can offer to
 * sign in instead), so the toggle here is a convenience, not a gate.
 */
import { useState, type FormEvent } from 'react';
import { AuthError, loginAccount, registerAccount } from '../lib/auth';
import type { AccountUser } from '../types';

export interface AuthDialogProps {
  /** What the user was doing — "Sign in to unlock this post". */
  context?: string;
  onSignedIn: (user: AccountUser) => void;
  /** A quiet way out ("not now") — omit to force the sign-in. */
  onDismiss?: () => void;
}

export default function AuthDialog({ context, onSignedIn, onDismiss }: AuthDialogProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The profile carries the minimum the account row requires — social
      // pages never ask for the matchmaking preferences.
      const profile = {
        username: username.trim(),
        age: 25,
        gender: 'other' as const,
        country: 'KE',
        preferredGenders: ['any'] as const,
        ageMin: 18,
        ageMax: 99,
      };
      const user =
        mode === 'signin'
          ? await loginAccount(username.trim(), password)
          : await registerAccount(username.trim(), password, profile as never);
      onSignedIn(user);
    } catch (err) {
      const message =
        err instanceof AuthError ? err.message : 'Something went wrong — please try again.';
      // "That username is taken" during sign-up is the one error worth
      // re-framing: the obvious next step is signing in instead.
      if (mode === 'signup' && /taken|exists/i.test(message)) {
        setError(message);
        setMode('signin');
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = username.trim().length >= 2 && password.length >= 6;

  return (
    <form onSubmit={(event) => void submit(event)} className="card w-full max-w-sm overflow-hidden p-0">
      <div className="relative" aria-hidden="true">
        <img
          src="/img/link-match.webp"
          alt=""
          loading="lazy"
          className="photo h-24 w-full"
        />
        <div className="absolute inset-0 photo-scrim" />
        <p className="absolute bottom-2.5 left-4 text-xs font-bold tracking-tight text-ink">
          Matchup
        </p>
      </div>
      <div className="p-6 pt-4">
      <h2 className="text-base font-bold text-ink">Sign in to Matchup</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {context ?? 'One account for posting, paying and calling.'}
      </p>

      {error && (
        <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <label className="label mt-4" htmlFor="auth-username">
        Username
      </label>
      <input
        id="auth-username"
        className="field"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />

      <label className="label mt-3" htmlFor="auth-password">
        Password
      </label>
      <input
        id="auth-password"
        className="field"
        type="password"
        autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      <button type="submit" className="btn btn-primary mt-5 w-full" disabled={busy || !canSubmit}>
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>

      <div className="mt-3 flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
        >
          {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
        {onDismiss && (
          <button type="button" className="text-muted hover:text-ink" onClick={onDismiss}>
            Not now
          </button>
        )}
      </div>
      </div>
    </form>
  );
}

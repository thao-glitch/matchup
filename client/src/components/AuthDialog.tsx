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
import { useMemo, useState, type FormEvent } from 'react';
import { AuthError, loginAccount, registerAccount } from '../lib/auth';
import { countryOptions, guessCountry } from '../lib/countries';
import {
  GENDERS,
  PREFERENCES,
  type AccountUser,
  type Gender,
  type Preference,
  type Profile,
} from '../types';

const AGES = Array.from({ length: 82 }, (_, i) => 18 + i); // 18 … 99

const GENDER_LABEL: Record<Gender, string> = {
  female: 'Female',
  male: 'Male',
  nonbinary: 'Non-binary',
  other: 'Other',
};

const PREF_LABEL: Record<Preference, string> = {
  any: 'Any gender',
  female: 'Women',
  male: 'Men',
  nonbinary: 'Non-binary',
  other: 'Other',
};

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
  const [age, setAge] = useState(25);
  const [gender, setGender] = useState<Gender>('female');
  const [country, setCountry] = useState(() => guessCountry());
  const [prefs, setPrefs] = useState<Preference[]>(['any']);
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countries = useMemo(() => countryOptions(), []);

  function togglePref(pref: Preference) {
    setPrefs((current) => {
      if (pref === 'any') return ['any'];
      const withoutAny = current.filter((p) => p !== 'any');
      const next = current.includes(pref)
        ? withoutAny.filter((p) => p !== pref)
        : [...withoutAny, pref];
      return next.length === 0 ? ['any'] : next;
    });
  }

  function changeAge(next: number) {
    setAge(next);
    setAgeMin((min) => Math.min(min, next));
    setAgeMax((max) => Math.max(max, next));
  }

  /** Everything the server needs for a new account; null when it is invalid. */
  function profileProblem(): string | null {
    if (username.trim().length < 2) return 'Pick a username with at least 2 characters.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (!Number.isFinite(age) || age < 18 || age > 99) return 'You must be 18 or older.';
    if (!country) return 'Select your country.';
    if (ageMin > ageMax) return 'Minimum age must be lower than maximum age.';
    if (age < ageMin || age > ageMax) {
      return 'Your preferred age range has to include your own age.';
    }
    return null;
  }

  function signupProfile(): Profile {
    return {
      username: username.trim(),
      age,
      gender,
      country,
      preferredGenders: prefs.length ? prefs : ['any'],
      ageMin,
      ageMax,
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === 'signup') {
      const problem = profileProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    try {
      const user =
        mode === 'signin'
          ? await loginAccount(username.trim(), password)
          : await registerAccount(username.trim(), password, signupProfile());
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

  const canSubmit =
    mode === 'signin'
      ? username.trim().length >= 2 && password.length >= 8
      : profileProblem() === null;

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="card max-h-[90dvh] w-full max-w-md overflow-y-auto p-0"
    >
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
      <h2 className="text-base font-bold text-ink">
        {mode === 'signin' ? 'Sign in to Matchup' : 'Create your Matchup account'}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {mode === 'signin'
          ? context ?? 'One account for posting, paying and calling.'
          : 'Your details power matching and your public profile. You can change them later.'}
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
        minLength={8}
        placeholder={mode === 'signup' ? 'At least 8 characters' : undefined}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      {mode === 'signup' && (
        <>
          <p className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            About you
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="auth-age">
                Age
              </label>
              <select
                id="auth-age"
                className="field"
                value={age}
                onChange={(event) => changeAge(Number(event.target.value))}
              >
                {AGES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="auth-gender">
                Gender
              </label>
              <select
                id="auth-gender"
                className="field"
                value={gender}
                onChange={(event) => setGender(event.target.value as Gender)}
              >
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABEL[g]}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="auth-country">
                Country
              </label>
              <select
                id="auth-country"
                className="field"
                value={country}
                onChange={(event) => setCountry(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select a country…
                </option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <span className="label mt-4">Connect me with</span>
          <div className="flex flex-wrap gap-2">
            {PREFERENCES.map((p) => {
              const active = prefs.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  onClick={() => togglePref(p)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-accent/70 bg-accent/20 text-ink'
                      : 'border-white/10 bg-white/5 text-muted hover:border-white/25 hover:text-ink'
                  }`}
                >
                  {PREF_LABEL[p]}
                </button>
              );
            })}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="auth-age-min">
                Age from
              </label>
              <select
                id="auth-age-min"
                className="field"
                value={ageMin}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setAgeMin(next);
                  if (next > ageMax) setAgeMax(next);
                }}
              >
                {AGES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="auth-age-max">
                Age to
              </label>
              <select
                id="auth-age-max"
                className="field"
                value={ageMax}
                onChange={(event) => setAgeMax(Number(event.target.value))}
              >
                {AGES.filter((n) => n >= ageMin).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}

      <button type="submit" className="btn btn-primary mt-5 w-full" disabled={busy || !canSubmit}>
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>

      <div className="mt-3 flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            if (mode === 'signin') setCountry((current) => current || guessCountry());
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

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  GENDERS,
  PREFERENCES,
  type AccountUser,
  type AppError,
  type Gender,
  type Preference,
  type Profile,
} from '../types';
import { countryOptions, guessCountry } from '../lib/countries';
import {
  AuthError,
  loginAccount,
  registerAccount,
  saveAccountProfile,
  signOutAccount,
} from '../lib/auth';
import { AlertIcon, GlobeIcon, SpinnerIcon } from './icons';
import AdSlot from './AdSlot';
import PaymentPanel from './PaymentPanel';
import type { PublicConfig } from '../lib/config';

interface Props {
  onStart: (profile: Profile) => void;
  /** Signed-in account — `null` means an anonymous visitor. */
  account: AccountUser | null;
  /** Last profile used on this device; pre-fills the form when not signed in. */
  draft: Profile | null;
  /** Fired after register / sign-in / save / sign-out so App can store it. */
  onAccountChange: (user: AccountUser | null) => void;
  /** Opens the live per-country board ("#europe") as an overlay. */
  onOpenBoard: () => void;
  /** Distinct passport countries stamped on this device. */
  passportUnique: number;
  /** Opens the Passport book ("#passport") as an overlay. */
  onOpenPassport: () => void;
  busy: boolean;
  error: AppError | null;
  /**
   * Server-side switches (ads / sign-ups / payments) the owner flips from
   * `/admin`. Fetching it is the caller's job — a missing config must simply
   * mean "everything on", which is what the defaults in `lib/config.ts` say.
   */
  config: PublicConfig;
}

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

export default function LobbyForm({
  onStart,
  account,
  draft,
  onAccountChange,
  onOpenBoard,
  passportUnique,
  onOpenPassport,
  busy,
  error,
  config,
}: Props) {
  const countries = useMemo(() => countryOptions(), []);

  // The signed-in profile wins, then the device-local draft, then defaults.
  const initial = account?.profile ?? draft ?? null;

  const [username, setUsername] = useState(initial?.username ?? '');
  const [age, setAge] = useState<number>(initial?.age ?? 25);
  const [gender, setGender] = useState<Gender>(initial?.gender ?? 'female');
  const [country, setCountry] = useState(() => initial?.country ?? guessCountry());
  const [prefs, setPrefs] = useState<Preference[]>(initial?.preferredGenders ?? ['any']);
  const [ageMin, setAgeMin] = useState(initial?.ageMin ?? 18);
  const [ageMax, setAgeMax] = useState(initial?.ageMax ?? 60);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Account panel state.
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Whenever a signed-in account appears — the silent re-login on page load,
  // or right after you sign in — its profile takes over the form. That is the
  // entire point of the account: arrive anywhere, everything is filled in.
  useEffect(() => {
    if (!account) return;
    const p = account.profile;
    setUsername(p.username);
    setAge(p.age);
    setGender(p.gender);
    setCountry(p.country);
    setPrefs(p.preferredGenders.length ? p.preferredGenders : ['any']);
    setAgeMin(p.ageMin);
    setAgeMax(p.ageMax);
    setFieldError(null);
  }, [account]);

  // "Profile saved" / "Welcome back" confirmations fade on their own.
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(id);
  }, [flash]);

  /** Exactly what gets queued, saved to the account, and stored as the draft. */
  function currentProfile(): Profile {
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

  /** Has the form drifted from what the account currently stores? */
  const dirty = useMemo(() => {
    if (!account) return false;
    const current = {
      username: username.trim(),
      age,
      gender,
      country,
      preferredGenders: prefs.length ? prefs : (['any'] as Preference[]),
      ageMin,
      ageMax,
    };
    return JSON.stringify(current) !== JSON.stringify(account.profile);
  }, [account, username, age, gender, country, prefs, ageMin, ageMax]);

  function togglePref(pref: Preference) {
    setPrefs((current) => {
      if (pref === 'any') return ['any'];
      const withoutAny = current.filter((p) => p !== 'any');
      const next = current.includes(pref)
        ? withoutAny.filter((p) => p !== pref)
        : [...withoutAny, pref];
      // Empty selection means "I don't mind" → normalize back to `any`.
      return next.length === 0 ? ['any'] : next;
    });
  }

  function validate(): string | null {
    const name = username.trim();
    if (name.length < 2) return 'Pick a username with at least 2 characters.';
    if (name.length > 24) return 'Username must be 24 characters or fewer.';
    if (!Number.isFinite(age) || age < 18 || age > 99) return 'You must be 18 or older.';
    if (ageMin > ageMax) return 'Minimum age must be lower than maximum age.';
    if (age < ageMin || age > ageMax) {
      return 'Your preferred age range has to include your own age.';
    }
    if (!country) return 'Select your country.';
    return null;
  }

  /** Shared wrapper for every account action: busy flag, error, confirmation. */
  async function runAuth(action: () => Promise<AccountUser>, success: (u: AccountUser) => string) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const user = await action();
      setPassword('');
      onAccountChange(user);
      setFlash(success(user));
    } catch (err) {
      setAuthError(err instanceof AuthError ? err.message : 'Something went wrong — try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  function handleRegister() {
    const problem = validate();
    setFieldError(problem);
    if (problem) return;
    if (password.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      return;
    }
    void runAuth(
      () => registerAccount(username.trim(), password, currentProfile()),
      (u) => `Account created — hi ${u.username}, your profile is saved.`,
    );
  }

  function handleSignIn() {
    const name = username.trim();
    if (name.length < 2) {
      setAuthError('Type your username above first.');
      return;
    }
    if (password.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      return;
    }
    void runAuth(
      () => loginAccount(name, password),
      (u) => `Welcome back, ${u.username} — your saved profile is loaded.`,
    );
  }

  function handleSave() {
    const problem = validate();
    setFieldError(problem);
    if (problem) return;
    void runAuth(
      () => saveAccountProfile(currentProfile()),
      () => 'Profile saved.',
    );
  }

  function handleSignOut() {
    setAuthBusy(true);
    setAuthError(null);
    setPassword('');
    void signOutAccount()
      .then(() => {
        onAccountChange(null);
        setFlash('Signed out — your details stay on this device.');
      })
      .finally(() => setAuthBusy(false));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validate();
    setFieldError(problem);
    if (problem || busy) return;

    setAuthError(null);
    onStart(currentProfile());
  }

  return (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-10">
      <header className="mb-7 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted">
          <GlobeIcon className="h-4 w-4" />
          Peer-to-peer · 1 on 1 · worldwide
        </div>
        <h1 className="bg-gradient-to-r from-accent via-accent-2 to-accent bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          Matchup
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-muted">
          Tell us who you are and who you’d like to meet. We’ll pair you with the first
          available person — the video never touches our servers.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="card p-6 sm:p-7" noValidate>
        {error && (
          <div
            role="alert"
            className="mb-5 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            <AlertIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">{error.title}</p>
              <p className="mt-0.5 text-danger/85">{error.message}</p>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. wanderlust_kay"
              maxLength={24}
              autoComplete="nickname"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="age">
              Your age
            </label>
            <select
              id="age"
              className="field"
              value={age}
              onChange={(e) => setAge(Number(e.target.value))}
            >
              {AGES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="gender">
              Gender
            </label>
            <select
              id="gender"
              className="field"
              value={gender}
              onChange={(e) => setGender(e.target.value as Gender)}
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {GENDER_LABEL[g]}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="country">
              Country of origin
            </label>
            <select
              id="country"
              className="field"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
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

          <div className="sm:col-span-2">
            <span className="label">Connect me with</span>
            <div className="flex flex-wrap gap-2">
              {PREFERENCES.map((p) => {
                const active = prefs.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={active}
                    onClick={() => togglePref(p)}
                    className={`rounded-full border px-3.5 py-2 text-sm font-medium transition-colors ${
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
          </div>

          <div>
            <label className="label" htmlFor="ageMin">
              Age from
            </label>
            <select
              id="ageMin"
              className="field"
              value={ageMin}
              onChange={(e) => setAgeMin(Number(e.target.value))}
            >
              {AGES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="ageMax">
              Age to
            </label>
            <select
              id="ageMax"
              className="field"
              value={ageMax}
              onChange={(e) => setAgeMax(Number(e.target.value))}
            >
              {AGES.filter((n) => n >= ageMin).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        {fieldError && (
          <p className="mt-4 text-sm text-warn" role="alert">
            {fieldError}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary mt-6 w-full py-3 text-base"
          disabled={busy}
        >
          {busy ? (
            <>
              <SpinnerIcon className="h-4 w-4" /> Starting camera…
            </>
          ) : (
            'Start matching'
          )}
        </button>

        {/* ── Account ─────────────────────────────────────────────────────── */}
        {account ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-surface-3/60 p-4 text-left">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">
                  Signed in as {account.username}
                </p>
                <p className="text-xs text-muted">
                  Saved to your account — change anything below and save it.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={authBusy}
                className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
              >
                Sign out
              </button>
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={authBusy || busy || !dirty}
              className="btn btn-ghost mt-3 w-full"
              title={dirty ? 'Save these details to your account' : 'Nothing changed yet'}
            >
              {authBusy ? (
                <>
                  <SpinnerIcon className="h-4 w-4" /> Saving…
                </>
              ) : dirty ? (
                'Save profile'
              ) : (
                'Profile saved'
              )}
            </button>
          </div>
        ) : config.features.signup ? (
          <div className="mt-6 rounded-xl border border-white/10 bg-surface-3/60 p-4 text-left">
            <label className="label" htmlFor="password">
              Keep this profile
            </label>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              Create an account and your details follow you to any device — sign in later and
              change any preference whenever you like.
            </p>
            <input
              id="password"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (8+ characters)"
              minLength={8}
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSignIn();
                }
              }}
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={handleRegister}
                disabled={authBusy || busy}
                className="btn btn-primary flex-1"
              >
                {authBusy ? (
                  <>
                    <SpinnerIcon className="h-4 w-4" /> Working…
                  </>
                ) : (
                  'Create account'
                )}
              </button>
              <button
                type="button"
                onClick={handleSignIn}
                disabled={authBusy || busy}
                className="btn btn-ghost flex-1"
              >
                Sign in
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">
              Both use the username above — pick one, pick a password, done.
            </p>
          </div>
        ) : (
          /* Sign-ups switched off from the dashboard (a burst of spam, a
             database migration): matching still works, only accounts pause. */
          <div className="mt-6 rounded-xl border border-white/10 bg-surface-3/60 p-4 text-left">
            <p className="text-xs leading-relaxed text-muted">
              New accounts are paused for a short while. You can still match as a guest —
              your passport stamps stay saved on this device until accounts are back.
            </p>
          </div>
        )}

        {authError && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {authError}
          </p>
        )}
        {flash && (
          <p className="mt-3 text-sm text-ok" role="status">
            {flash}
          </p>
        )}

        {/* Paybill panel: the reference + status, nothing more. Renders
            nothing at all while payments are switched off in /admin. */}
        <PaymentPanel account={account} config={config} />

        <p className="mt-4 text-center text-xs leading-relaxed text-muted">
          Camera & microphone access is requested next. Only people you are matched with
          receive your media.
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onOpenBoard}
            className="btn btn-ghost flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            <GlobeIcon className="h-4 w-4" />
            Who&apos;s online right now?
          </button>
          <button
            type="button"
            onClick={onOpenPassport}
            className="btn btn-ghost flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            <span aria-hidden="true">🌍</span>
            My passport · {passportUnique}
          </button>
        </div>

        {!account && passportUnique > 0 && (
          <p className="mt-2 text-center text-xs leading-relaxed text-warn">
            🔒 Create an account to keep your {passportUnique} stamp
            {passportUnique === 1 ? '' : 's'} on every device.
          </p>
        )}
      </form>

      {/* Renders nothing unless the build carries VITE_ADSENSE_* — localhost,
          the tests and pre-approval deployments stay completely ad-free.
          `features.ads` is the owner's kill switch in /admin, so a premium
          audience or a policy problem can be handled without a redeploy. */}
      {config.features.ads && <AdSlot className="mt-5" />}

      <p className="mt-4 text-center text-xs text-muted">
        <a
          href="#privacy"
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          Privacy
        </a>
        {' · '}
        <a href="#terms" className="underline decoration-dotted underline-offset-2 hover:text-ink">
          Terms
        </a>
      </p>
    </div>
  );
}

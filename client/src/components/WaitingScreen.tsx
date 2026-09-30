import { useEffect, useRef, useState } from 'react';
import type { AppError, WaitingStatus } from '../types';
import { SIGNALING_URL } from '../lib/iceServers';
import { passportState } from '../lib/passport';
import { countryName } from '../lib/countries';
import { AlertIcon, SpinnerIcon, UsersIcon, flagFromCountry } from './icons';

interface Props {
  localStream: MediaStream | null;
  presence: WaitingStatus;
  onCancel: () => void;
  notice?: string | null;
  error?: AppError | null;
}

/**
 * Waiting room shown while the server hunts for a compatible partner.
 *
 * The counters come from the signaling server. `displayOnline` adds a small
 * amount of jitter on top of the real `presence.online` value purely so the
 * number doesn't look frozen — delete `jitteredCount()` if you'd rather show
 * the exact figure only.
 */
export default function WaitingScreen({
  localStream,
  presence,
  onCancel,
  notice,
  error,
}: Props) {
  const selfRef = useRef<HTMLVideoElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const [jitter, setJitter] = useState(() => Math.floor(Math.random() * 5) - 2);
  /** Countries online right now that are missing from the passport. */
  const [collectable, setCollectable] = useState<string[]>([]);

  // "Collect while you wait" — polling the live board turns dead queue time
  // into anticipation: you can SEE the countries you're one match away from.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch(`${SIGNALING_URL.replace(/\/$/, '')}/api/presence`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { byCountry?: { code: string }[] };
        if (!alive || !Array.isArray(data.byCountry)) return;
        const stamps = passportState().stamps;
        const missing = data.byCountry
          .map((row) => String(row.code || '').toUpperCase())
          .filter((code) => /^[A-Z]{2}$/.test(code) && !stamps[code]);
        // Board order is largest-first; de-dup while preserving it.
        setCollectable([...new Set(missing)].slice(0, 6));
      } catch {
        /* offline / rate-limited — the strip simply stays hidden */
      }
    };
    void pull();
    const id = window.setInterval(pull, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed((s) => s + 1);
      setJitter(Math.floor(Math.random() * 5) - 2);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const video = selfRef.current;
    if (!video) return;
    video.srcObject = localStream;
    void video.play().catch(() => {
      /* autoplay with user gesture already granted — ignore */
    });
  }, [localStream]);

  const displayOnline = Math.max(1, presence.online + jitter);
  const looking = Math.max(1, presence.looking);

  return (
    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-10 text-center">
      <div className="card w-full overflow-hidden p-7">
        <div className="relative mx-auto mb-6 aspect-video w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-black/50">
          <video
            ref={selfRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full scale-x-[-1] object-cover opacity-90"
          />
          <div className="absolute inset-0 animate-pulse-soft bg-gradient-to-t from-accent/20 via-transparent to-transparent" />
          <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-ink">
            You
          </span>
        </div>

        <div className="mb-4 flex items-center justify-center gap-2 text-accent">
          <SpinnerIcon className="h-5 w-5" />
          <span className="text-lg font-semibold text-ink">Looking for someone…</span>
        </div>

        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted">
          We’re finding the first person who matches your preferences
          <span className="animate-pulse-soft">.</span>
        </p>

        {notice && (
          <div className="mx-auto mt-5 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mx-auto mt-5 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error.message}</span>
          </div>
        )}

        <div className="mt-7 grid grid-cols-2 gap-3 text-left">
          <div className="rounded-xl border border-white/10 bg-surface-3/50 px-4 py-3">
            <div className="flex items-center gap-2 text-muted">
              <UsersIcon className="h-4 w-4" />
              <span className="text-xs uppercase tracking-wide">Looking now</span>
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{looking}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-surface-3/50 px-4 py-3">
            <div className="flex items-center gap-2 text-muted">
              <UsersIcon className="h-4 w-4" />
              <span className="text-xs uppercase tracking-wide">Online</span>
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
              {displayOnline.toLocaleString()}
            </p>
          </div>
        </div>

        {collectable.length > 0 && (
          <div className="mt-4 rounded-xl border border-accent/25 bg-accent/10 px-4 py-3 text-left">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">
              Collect while you wait
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Online right now and still missing from your passport:{' '}
              {collectable.map((code) => `${flagFromCountry(code)} ${countryName(code)}`).join(' · ')}
            </p>
          </div>
        )}

        <p className="mt-4 text-xs text-muted">
          Waiting for {formatDuration(elapsed)} · we’ll connect you the moment a match is
          found.
        </p>
      </div>

      <button type="button" onClick={onCancel} className="btn btn-ghost mt-5">
        Stop matching
      </button>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

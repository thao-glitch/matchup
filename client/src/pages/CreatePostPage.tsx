/**
 * CreatePost — the earning screen: pick a type, attach media, set a price and
 * see exactly what the platform's cut leaves you before you publish.
 *
 * The order of operations matters for the wallet: the file is uploaded first
 * (one raw-bytes POST, no base64), and only a successful upload is turned into
 * a post — a failed upload never leaves a half-written row behind. Validation
 * runs entirely client-side so a typo costs no network round trip, and the
 * server error strings still come back verbatim if the server disagrees.
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { Post } from '../types/social';
import { SocialError, createPost, formatKes, netOf, uploadMedia } from '../lib/social';
import { Link, navigate } from '../lib/router';
import { AlertIcon, CheckIcon, LockIcon, SpinnerIcon } from '../components/icons';

type Kind = Post['type'];
const MAX_CAPTION = 2000;

const KINDS: { key: Kind; label: string }[] = [
  { key: 'image', label: 'Image' },
  { key: 'video', label: 'Video' },
  { key: 'link', label: 'Link' },
  { key: 'text', label: 'Text' },
];

export default function CreatePostPage({
  account,
  config,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const [type, setType] = useState<Kind>('image');
  const [caption, setCaption] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [priceRaw, setPriceRaw] = useState('0');
  const [isAdult, setIsAdult] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stage, setStage] = useState<'upload' | 'publish' | 'done' | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Object URLs are browser memory the state alone cannot free — track the
  // live one in a ref so unmount can revoke it even after several swaps.
  const previewRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  function swapPreview(next: string | null) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next;
    setPreview(next);
  }

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const commerce = config.commerce;
  const price = Math.max(0, Math.round(Number(priceRaw) || 0));
  const { commission, net } = netOf(price, commerce.commissionRate);
  const canAck = Boolean(
    commerce.adult && account && Number(account.profile?.age) >= 18 && !adultOk,
  );

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    setFieldError(null);
    swapPreview(chosen ? URL.createObjectURL(chosen) : null);
  }

  /** Every rule the server would also enforce, checked before any upload. */
  function validate(): string | null {
    if (!caption.trim()) return 'Write a caption before publishing.';
    if (caption.length > MAX_CAPTION) return `Caption is over ${MAX_CAPTION} characters.`;
    if ((type === 'image' || type === 'video') && !file) {
      return type === 'image' ? 'Choose a photo to upload.' : 'Choose a video to upload.';
    }
    if (type === 'link' && !/^https?:\/\/\S+$/i.test(linkUrl.trim())) {
      return 'The link must start with http:// or https://';
    }
    if (!Number.isFinite(Number(priceRaw)) || Number(priceRaw) < 0) {
      return 'Price must be zero or more.';
    }
    if (price > 0 && (price < commerce.minPrice || price > commerce.maxPrice)) {
      return `A paid post must cost between ${formatKes(commerce.minPrice)} and ${formatKes(
        commerce.maxPrice,
      )} — or 0 to publish it free.`;
    }
    if (isAdult && !commerce.adult) return 'Adult posts are not allowed on this platform.';
    if (isAdult && !adultOk) return 'Confirm you are 18 or over before posting adult content.';
    return null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (stage === 'upload' || stage === 'publish') return;
    setServerError(null);

    const problem = validate();
    setFieldError(problem);
    if (problem) return;
    if (!requireAuth('Sign in to start earning.')) return;

    try {
      let mediaKey: string | undefined;
      if (file) {
        setStage('upload');
        const uploaded = await uploadMedia(file);
        mediaKey = uploaded.key;
      }
      setStage('publish');
      const { post } = await createPost({
        caption: caption.trim(),
        price,
        isAdult,
        type,
        ...(mediaKey ? { mediaKey } : {}),
        ...(type === 'link' ? { linkUrl: linkUrl.trim() } : {}),
      });
      setStage('done');
      // A beat of "Published" so the button press does not feel swallowed.
      timerRef.current = window.setTimeout(() => navigate(`/post/${post.id}`), 900);
    } catch (err) {
      setServerError(
        err instanceof SocialError ? err.message : 'The post could not be published.',
      );
      setStage(null);
    }
  }

  // ── Signed out ────────────────────────────────────────────────────────────
  if (!account) {
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-6 text-center">
          <h1 className="text-lg font-bold text-ink">Start earning on Matchup</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Sign in to publish posts, set prices in KES and get paid to your M-PESA wallet.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-4 w-full"
            onClick={() => requireAuth('Sign in to start earning.')}
          >
            Sign in to post
          </button>
        </div>
        <div className="card mt-4 space-y-3 p-5 text-sm">
          <p className="label">What an account gives you</p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Post &amp; earn</span> — sell photos, clips,
            links or text from {formatKes(commerce.minPrice)} up to {formatKes(commerce.maxPrice)}.
          </p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Wallet</span> — every sale lands in your
            balance and withdraws to your M-PESA number.
          </p>
          <p className="leading-relaxed text-muted">
            <span className="font-semibold text-ink">Group calls</span> — host live rooms and
            conferences alongside the 1v1 chat.
          </p>
        </div>
      </div>
    );
  }

  // ── Published ─────────────────────────────────────────────────────────────
  if (stage === 'done') {
    return (
      <div className="mx-auto max-w-md card p-8 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-ok/15 text-ok">
          <CheckIcon className="h-6 w-6" />
        </span>
        <p className="mt-3 text-base font-bold text-ink">Your post is live</p>
        <p className="mt-1 text-sm text-muted">Opening it now…</p>
      </div>
    );
  }

  const busy = stage === 'upload' || stage === 'publish';
  const needsMedia = type === 'image' || type === 'video';

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink">Create a post</h1>
        <p className="text-xs text-muted">
          Free or paid — you keep {100 - commerce.commissionRate}% of every sale.
        </p>
      </div>

      {/* ── Type ────────────────────────────────────────────────────────── */}
      <div>
        <p className="label">Type</p>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((kind) => (
            <button
              key={kind.key}
              type="button"
              aria-pressed={type === kind.key}
              disabled={busy}
              className={`btn px-4 py-2 text-xs ${type === kind.key ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                // Re-selecting the current type must not throw away the file
                // the user already picked.
                if (kind.key === type) return;
                setType(kind.key);
                setFieldError(null);
                setFile(null);
                swapPreview(null);
              }}
            >
              {kind.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Media / link ────────────────────────────────────────────────── */}
      {needsMedia && (
        <div>
          <label className="label" htmlFor="post-file">
            {type === 'image' ? 'Photo' : 'Video'}
          </label>
          <input
            id="post-file"
            type="file"
            accept={type === 'image' ? 'image/*' : 'video/mp4'}
            disabled={busy}
            onChange={pickFile}
            className="block w-full text-xs text-muted file:mr-3 file:cursor-pointer file:rounded-xl file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink hover:file:bg-white/15"
          />
          {file && (
            <p className="mt-1.5 truncate text-xs text-muted">
              {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
            </p>
          )}
          {preview && (
            <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
              {type === 'image' ? (
                <img src={preview} alt="Preview" className="photo max-h-64 w-full" />
              ) : (
                <video src={preview} controls playsInline className="max-h-64 w-full bg-black" />
              )}
            </div>
          )}
        </div>
      )}

      {type === 'link' && (
        <div>
          <label className="label" htmlFor="post-link">
            Link
          </label>
          <input
            id="post-link"
            className="field"
            type="url"
            inputMode="url"
            placeholder="https://example.com/video"
            disabled={busy}
            value={linkUrl}
            onChange={(event) => {
              setLinkUrl(event.target.value);
              setFieldError(null);
            }}
          />
          <p className="mt-1.5 text-xs text-muted">Opens in a new tab for everyone who sees it.</p>
        </div>
      )}

      {/* ── Caption ─────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-baseline justify-between">
          <label className="label" htmlFor="post-caption">
            Caption
          </label>
          <span
            className={`text-[11px] tabular-nums ${
              caption.length > MAX_CAPTION ? 'text-danger' : 'text-muted'
            }`}
          >
            {caption.length}/{MAX_CAPTION}
          </span>
        </div>
        <textarea
          id="post-caption"
          className="field min-h-28 resize-y"
          placeholder={type === 'text' ? 'Say something worth paying for…' : 'What is this post about?'}
          disabled={busy}
          value={caption}
          onChange={(event) => {
            setCaption(event.target.value);
            setFieldError(null);
          }}
        />
      </div>

      {/* ── Price + fee preview ─────────────────────────────────────────── */}
      <div>
        <label className="label" htmlFor="post-price">
          Price (KES)
        </label>
        <input
          id="post-price"
          className="field"
          type="number"
          inputMode="numeric"
          min={0}
          max={commerce.maxPrice}
          step={1}
          disabled={busy}
          value={priceRaw}
          onChange={(event) => {
            setPriceRaw(event.target.value);
            setFieldError(null);
          }}
        />
        <p className="mt-1.5 text-xs text-muted">
          0 = free · accepted range {formatKes(commerce.minPrice)}–{formatKes(commerce.maxPrice)}{' '}
          per view.
        </p>

        <div className="mt-3 rounded-xl border border-white/10 bg-surface-3/60 px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted">Price</span>
            <span className="font-semibold tabular-nums text-ink">{formatKes(price)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="text-muted">Platform fee ({commerce.commissionRate}%)</span>
            <span className="tabular-nums text-warn">− {formatKes(commission)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-white/10 pt-2">
            <span className="font-semibold text-ink">You receive</span>
            <span className="font-bold tabular-nums text-ok">{formatKes(net)}</span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            The fee is charged only when someone actually pays — a post nobody buys costs nothing.
          </p>
        </div>
      </div>

      {/* ── 18+ ─────────────────────────────────────────────────────────── */}
      {commerce.adult ? (
        canAck ? (
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-3.5">
            <p className="text-xs leading-relaxed text-warn">
              Adult posts exist on this platform — confirm you are 18 or over before you can flag
              a post as 18+.
            </p>
            <button
              type="button"
              className="btn btn-ghost mt-2.5 px-3 py-1.5 text-xs"
              onClick={acknowledgeAdult}
            >
              I&apos;m 18 or over — show adult posts
            </button>
          </div>
        ) : (
          <label className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-surface-3/60 px-4 py-3">
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <LockIcon className="h-4 w-4" /> Mark as 18+
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                Only viewers who passed the adult check will see this post.
              </span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0 accent-accent"
              disabled={!adultOk}
              checked={isAdult}
              onChange={(event) => setIsAdult(event.target.checked)}
            />
          </label>
        )
      ) : null}

      {/* ── Errors ──────────────────────────────────────────────────────── */}
      {fieldError && (
        <p className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-xs leading-relaxed text-danger">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          {fieldError}
        </p>
      )}
      {serverError && (
        <p className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-xs leading-relaxed text-danger">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          {serverError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {stage === 'upload' && <SpinnerIcon className="h-4 w-4" />}
          {stage === 'publish' && <SpinnerIcon className="h-4 w-4" />}
          {stage === 'upload'
            ? 'Uploading media…'
            : stage === 'publish'
              ? 'Publishing…'
              : price > 0
                ? `Publish for ${formatKes(price)}`
                : 'Publish'}
        </button>
        <Link to="/" className="btn btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}

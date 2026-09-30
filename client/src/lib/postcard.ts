/**
 * "Crossed" — the shareable artifact a call leaves behind.
 *
 * After a real, connected call the post-call screen offers one button:
 * **Share this connection**. It renders a story-format card (two flags, the
 * distance between them, how long you actually talked, the URL) and hands it
 * to the phone's native share sheet — one tap into Instagram / WhatsApp /
 * Telegram, where every story becomes a link back here.
 *
 * Privacy by construction:
 *   • nothing is rendered unless the user presses the button, and pressing it
 *     again on their own screen is all the consent that is needed;
 *   • only country codes + duration go on the card — no name, handle, age or
 *     face, on either side;
 *   • nothing is uploaded: the card is drawn in this browser's canvas and
 *     shared from memory.
 *
 * Fallback ladder: native share sheet → clipboard copy → show the text to copy
 * by hand, so the button is never a dead end (and always reports which rung it
 * landed on, which is what the E2E asserts).
 */
import { countryName } from './countries';
import { distanceKm } from './geo';
import { flagFromCountry } from '../components/icons';
import type { ShareMeta } from '../types';

/** Every success status starts with this line — stable text for the E2E. */
export const SHARE_READY = 'Connection card ready';

const W = 1080;
const H = 1350;

/** "41 min" / "under a minute" — never rounds a 5-second call up to a claim. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function label(code: string): string {
  return countryName(code) || (code || '').toUpperCase();
}

/** One line of honest copy: flags, countries, distance, duration, link. */
export function shareSummary(meta: ShareMeta): string {
  const mine = label(meta.myCountry);
  const theirs = label(meta.peerCountry);
  const km = distanceKm(meta.myCountry, meta.peerCountry);
  const where = km && km > 0 ? `${km.toLocaleString('en')} km apart` : 'somewhere new';
  const pair =
    mine === theirs
      ? `${flagFromCountry(meta.peerCountry)} ${theirs}`
      : `${flagFromCountry(meta.myCountry)} ${mine} ↔ ${flagFromCountry(meta.peerCountry)} ${theirs}`;
  const passport =
    meta.passport && meta.passport > 0
      ? ` Passport: ${meta.passport} ${meta.passport === 1 ? 'country' : 'countries'} collected.`
      : '';
  return `I matched with a stranger on Matchup — ${pair}, ${where}, ${formatDuration(
    meta.seconds,
  )} on video.${passport} Talk to anyone:`;
}

// ── Canvas rendering ─────────────────────────────────────────────────────────

function centeredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  letterSpacing?: string,
): void {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Chrome-only, harmless elsewhere — letterspaced brand text looks deliberate.
  if (letterSpacing) {
    try {
      (ctx as unknown as { letterSpacing: string }).letterSpacing = letterSpacing;
    } catch {
      /* unsupported */
    }
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Draw the card. Returns `null` if the browser has no 2D canvas (ancient
 * device) — the caller then shares plain text instead of failing.
 */
export function renderCard(meta: ShareMeta): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);

  // Background: the app's dark navy, with a soft glow behind the pair.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0f1e');
  bg.addColorStop(0.55, '#121a33');
  bg.addColorStop(1, '#0a0f1e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, 560, 40, W / 2, 560, 520);
  glow.addColorStop(0, 'rgba(99, 132, 255, 0.35)');
  glow.addColorStop(1, 'rgba(99, 132, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Hairline frame — the card reads as a card, not as a screenshot.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  centeredText(ctx, 'MATCHUP', W / 2, 140, '800 54px system-ui, sans-serif', '#a9bcff', '16px');
  centeredText(
    ctx,
    'ONE TAP · ONE STRANGER · LIVE VIDEO',
    W / 2,
    205,
    '600 26px system-ui, sans-serif',
    'rgba(255,255,255,0.55)',
    '6px',
  );

  // The two sides of the match.
  const mine = label(meta.myCountry);
  const theirs = label(meta.peerCountry);
  const same = mine === theirs;
  const top = `${flagFromCountry(meta.myCountry)} ${same ? 'You' : mine}`;
  const bottom = `${flagFromCountry(meta.peerCountry)} ${theirs}`;

  centeredText(ctx, top.toUpperCase(), W / 2, 430, '800 74px system-ui, sans-serif', '#ffffff');
  centeredText(ctx, bottom.toUpperCase(), W / 2, 760, '800 74px system-ui, sans-serif', '#ffffff');

  // Dashed line with dots, broken by the distance in the middle.
  const lineY = 595;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.setLineDash([4, 16]);
  ctx.beginPath();
  ctx.moveTo(150, lineY);
  ctx.lineTo(W - 150, lineY);
  ctx.stroke();
  ctx.restore();

  const km = distanceKm(meta.myCountry, meta.peerCountry);
  const distance = km && km > 0 ? `${km.toLocaleString('en')} KM APART` : 'MATCHED BY CHANCE';
  ctx.save();
  ctx.font = '800 40px system-ui, sans-serif';
  const chipW = ctx.measureText(distance).width + 96;
  ctx.restore();
  ctx.fillStyle = '#121a33';
  ctx.fillRect(W / 2 - chipW / 2, lineY - 44, chipW, 88);
  centeredText(ctx, distance, W / 2, lineY, '800 40px system-ui, sans-serif', '#ffd479', '4px');

  for (const x of [150, W - 150]) {
    ctx.beginPath();
    ctx.fillStyle = '#6384ff';
    ctx.arc(x, lineY, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  // What actually happened: how long two strangers talked.
  centeredText(
    ctx,
    `${formatDuration(meta.seconds)} together`,
    W / 2,
    950,
    '700 52px system-ui, sans-serif',
    '#c9d4f5',
  );
  centeredText(
    ctx,
    'your stranger could be next',
    W / 2,
    1020,
    '500 30px system-ui, sans-serif',
    'rgba(255,255,255,0.55)',
  );

  // The collector's brag — only when there is something to brag about.
  if (meta.passport && meta.passport > 0) {
    centeredText(
      ctx,
      `🌍 ${meta.passport} ${meta.passport === 1 ? 'COUNTRY' : 'COUNTRIES'} IN MY PASSPORT`,
      W / 2,
      1105,
      '700 28px system-ui, sans-serif',
      'rgba(255,255,255,0.6)',
      '4px',
    );
  }

  // Link back. Hostname only — the origin may carry a path in dev.
  const host = (() => {
    try {
      return new URL(window.location.href).host;
    } catch {
      return 'matchup-mu.vercel.app';
    }
  })();
  centeredText(ctx, host, W / 2, 1215, '800 46px system-ui, sans-serif', '#ffffff');

  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

// ── Sharing ──────────────────────────────────────────────────────────────────

const aborted = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

/** What a share attempt produced: the status line + the card to show back. */
export interface ShareResult {
  /** Status line to display under the button — starts with `SHARE_READY` on success. */
  status: string;
  /** Object URL of the rendered card, so the user can see (and keep) it. */
  cardUrl: string | null;
}

/**
 * Run the fallback ladder and return the status line to show under the button.
 * Never throws: a failed share must leave the user on the post-call screen with
 * something to read, not a blank error.
 */
export async function shareConnection(meta: ShareMeta): Promise<ShareResult> {
  const text = shareSummary(meta);
  const url = (() => {
    try {
      return window.location.origin;
    } catch {
      return 'https://matchup-mu.vercel.app';
    }
  })();

  let cardUrl: string | null = null;

  // 1) Image + native share sheet — the real story-format share on mobile.
  //    Either way the card is kept, because on desktop there is no sheet and
  //    the picture itself is what the user came for.
  try {
    const blob = await renderCard(meta);
    if (blob) cardUrl = URL.createObjectURL(blob);
    if (blob && typeof navigator.share === 'function' && navigator.canShare) {
      const file = new File([blob], 'matchup-connection.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `${text} ${url}` });
        return { status: `${SHARE_READY} — share sheet opened.`, cardUrl };
      }
    }
  } catch (err) {
    // Cancelled on purpose is a legitimate outcome, not a failure.
    if (aborted(err)) {
      return {
        status: 'Share cancelled — your card is right here whenever you want it.',
        cardUrl,
      };
    }
    // Anything else (unsupported platform, blocked permission) → fall through.
  }

  // 2) Clipboard: the story text, ready to paste.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${text} ${url}`);
      return { status: `${SHARE_READY} — copied, paste it into your story.`, cardUrl };
    }
  } catch {
    /* fall through to the visible fallback */
  }

  // 3) Last rung: show the text so it can be copied by hand.
  return {
    status: `${SHARE_READY} — copy it into your story: ${text} ${url}`,
    cardUrl,
  };
}

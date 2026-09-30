/**
 * Ad slot — an AdSense `<ins>` that renders *nothing* unless the build was
 * given an ad client, so development, tests and localhost stay ad-free:
 *
 *   Vercel → Settings → Environment Variables → Redeploy:
 *     VITE_ADSENSE_CLIENT = ca-pub-XXXXXXXXXXXXXXXX
 *     VITE_ADSENSE_SLOT   = 1234567890          (the unit's slot id)
 *
 * Other networks (Adsterra, Monetag, PropellerAds …) ship their own snippet
 * instead — paste it into `index.html` rather than these two variables
 * (README → "Ads"). Nothing here ever throws: an ad blocker or a rejected
 * creative must never break the lobby.
 */
import { useEffect } from 'react';

const CLIENT = import.meta.env.VITE_ADSENSE_CLIENT;
const SLOT = import.meta.env.VITE_ADSENSE_SLOT;

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

let requested = false;

function ensureScript(client: string): void {
  if (requested || document.querySelector('script[data-matchup-ads]')) return;
  requested = true;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.setAttribute('data-matchup-ads', 'true');
  script.src =
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' +
    encodeURIComponent(client);
  document.head.appendChild(script);
}

export default function AdSlot({ className = '' }: { className?: string }) {
  useEffect(() => {
    if (!CLIENT || !SLOT) return;
    ensureScript(CLIENT);
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* blocked or script not ready yet — the slot simply stays empty */
    }
  }, []);

  if (!CLIENT || !SLOT) return null;

  return (
    <ins
      className={`adsbygoogle ${className}`}
      data-ad-client={CLIENT}
      data-ad-slot={SLOT}
      data-ad-format="auto"
      data-full-width-responsive="true"
      style={{ display: 'block' }}
    />
  );
}

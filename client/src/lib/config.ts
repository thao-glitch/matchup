/**
 * Public app configuration — `GET /api/config`.
 *
 * Two groups of values, both edited by the owner in the admin dashboard and
 * read by every visitor on load:
 *
 *   • `features` — the switches that decide what the lobby shows at all
 *     (ads, sign-ups, payments) plus the maintenance kill switch.
 *   • `payment`  — the premium subscription: price, period, product name and
 *     the wording shown on the pay screen.
 *   • `commerce` — the social platform: which tabs exist, the commission the
 *     house keeps on a sale, and whether Daraja can take a payment at all.
 *
 * The endpoint is public on purpose: none of it is a secret (it is rendered
 * on screen for everyone), and caching it in this module keeps the lobby from
 * paying a round-trip per render. A failed fetch degrades to permissive
 * defaults with payments off — the app must never brick itself over config.
 */
import { SIGNALING_URL } from './iceServers';
import type { CommerceConfig } from '../types/social';

export interface PaymentConfig {
  /** False when payments are switched off OR the premium feature is off. */
  enabled: boolean;
  amount: number;
  currency: string;
  productName: string;
  premiumDays: number;
  instructions: string;
  supportContact: string;
}

export interface PublicConfig {
  features: {
    signup: boolean;
    ads: boolean;
    premium: boolean;
    maintenance: boolean;
  };
  payment: PaymentConfig;
  /** The social platform's switches and economics (posts, rooms, commission). */
  commerce: CommerceConfig;
  /** Where uploads go. `directUpload` means the browser talks to Blob directly. */
  media: {
    backend: string;
    objectStorage: boolean;
    private: boolean;
    directUpload: boolean;
  };
}

const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api/config`;

/** Permissive defaults: the app behaves as it did before config existed. */
export const DEFAULT_CONFIG: PublicConfig = {
  features: { signup: true, ads: true, premium: true, maintenance: false },
  payment: {
    enabled: false,
    amount: 0,
    currency: 'KES',
    productName: 'Premium',
    premiumDays: 30,
    instructions: '',
    supportContact: '',
  },
  commerce: {
    enabled: true,
    social: true,
    groups: true,
    adult: true,
    commissionRate: 15,
    minPrice: 5,
    maxPrice: 15000,
    currency: 'KES',
    mpesaReady: false,
  },
  media: { backend: 'database', objectStorage: false, private: false, directUpload: false },
};

let cached: PublicConfig | null = null;
let inflight: Promise<PublicConfig> | null = null;

function normalize(data: Partial<PublicConfig> | null): PublicConfig {
  const src = data ?? {};
  return {
    features: { ...DEFAULT_CONFIG.features, ...(src.features ?? {}) },
    payment: { ...DEFAULT_CONFIG.payment, ...(src.payment ?? {}) },
    commerce: { ...DEFAULT_CONFIG.commerce, ...(src.commerce ?? {}) },
    media: { ...DEFAULT_CONFIG.media, ...(src.media ?? {}) },
  };
}

/** Fetch (once per page load) and cache the configuration. Never throws. */
export async function loadConfig(): Promise<PublicConfig> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(BASE, {
        headers: { accept: 'application/json' },
        // The switches change without a redeploy — never serve a stale copy.
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`config endpoint returned ${res.status}`);
      cached = normalize((await res.json()) as Partial<PublicConfig>);
    } catch {
      // Offline / old server / proxy hiccup: the lobby still has to render.
      cached = DEFAULT_CONFIG;
    } finally {
      inflight = null;
    }
    return cached;
  })();

  return inflight;
}

/** Test seam — forces the next `loadConfig()` to hit the network again. */
export function resetConfigCache(): void {
  cached = null;
}

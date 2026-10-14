/**
 * Public app configuration — `GET /api/config`.
 *
 * Two groups of values, both edited by the owner in the admin dashboard and
 * read by every visitor on load:
 *
 *   • `features` — the switches that decide what the lobby shows at all
 *     (ads, sign-ups, payments) plus the maintenance kill switch.
 *   • `payment`  — the paybill block: bank, number, unique account-number
 *     format, price, premium length and the wording of the instructions.
 *
 * The endpoint is public on purpose: none of it is a secret (it is rendered
 * on screen for everyone), and caching it in this module keeps the lobby from
 * paying a round-trip per render. A failed fetch degrades to permissive
 * defaults with payments off — the app must never brick itself over config.
 */
import { SIGNALING_URL } from './iceServers';

export interface PaymentConfig {
  /** False when payments are switched off OR the premium feature is off. */
  enabled: boolean;
  bank: string;
  paybill: string;
  accountFormat: string;
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
}

const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api/config`;

/** Permissive defaults: the app behaves as it did before config existed. */
export const DEFAULT_CONFIG: PublicConfig = {
  features: { signup: true, ads: true, premium: true, maintenance: false },
  payment: {
    enabled: false,
    bank: '',
    paybill: '',
    accountFormat: 'MU{id}',
    amount: 0,
    currency: 'KES',
    productName: 'Premium',
    premiumDays: 30,
    instructions: '',
    supportContact: '',
  },
};

let cached: PublicConfig | null = null;
let inflight: Promise<PublicConfig> | null = null;

function normalize(data: Partial<PublicConfig> | null): PublicConfig {
  const src = data ?? {};
  return {
    features: { ...DEFAULT_CONFIG.features, ...(src.features ?? {}) },
    payment: { ...DEFAULT_CONFIG.payment, ...(src.payment ?? {}) },
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

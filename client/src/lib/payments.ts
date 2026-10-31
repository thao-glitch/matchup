/**
 * Premium payment client — the buyer's half of the M-PESA prompt.
 *
 * The flow (the server side is `server/src/payments.js`):
 *
 *   1. `createPaymentIntent(phone)` → the phone prompts for the M-PESA PIN
 *      immediately. There is no reference number, no account number and no
 *      "I have paid" button: Safaricom tells us the answer itself.
 *   2. `waitForPayment(id)` polls the charge until the callback settles it —
 *      usually 1–3 s after the PIN lands. A callback lost to a firewall still
 *      resolves, because the server asks Daraja directly once it has had a
 *      head start.
 *   3. `fetchMyPayments()` reads the buyer's own receipts and their live
 *      entitlement, straight from the row that grants it.
 *
 * Nothing here ever talks to a bank. All of it is the signed-in user's own —
 * the server refuses a charge that belongs to someone else.
 */
import type { PremiumPayment } from '../types';
import { getToken } from './auth';
import { SIGNALING_URL } from './iceServers';

const BASE = `${SIGNALING_URL.replace(/\/$/, '')}/api/payments`;

/** Thrown for every failure, with the server's human-readable message. */
export class PaymentError extends Error {
  readonly code: string;
  constructor(message: string, code = 'payment') {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

async function request<T>(path: string, opts: { method?: 'GET' | 'POST'; body?: unknown } = {}) {
  const token = getToken();
  if (!token) throw new PaymentError('Please sign in to pay.', 'unauthorized');

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${token}`,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    throw new PaymentError('Could not reach the server — check your connection.', 'network');
  }

  const text = await res.text();
  let data: { error?: { code?: string; message?: string } } | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body — the status message below covers it */
    }
  }
  if (!res.ok) throw new PaymentError(data?.error?.message ?? `Request failed (${res.status}).`, data?.error?.code ?? 'http');

  return data as T;
}

/**
 * Prompt the phone for the premium price. Safe to call twice: the server
 * returns the SAME open charge instead of starting a second prompt, so a
 * reload or an impatient double-tap can never prompt twice for one payment.
 */
export async function createPaymentIntent(phone: string): Promise<PremiumPayment> {
  const data = await request<{ payment: PremiumPayment }>('/intent', {
    method: 'POST',
    body: { phone },
  });
  return data.payment;
}

/** The signed-in user's own receipts + when premium (if any) runs out. */
export async function fetchMyPayments(): Promise<{
  premiumUntil: string | null;
  open: PremiumPayment | null;
  payments: PremiumPayment[];
}> {
  const data = await request<{
    premiumUntil: string | null;
    open: PremiumPayment | null;
    payments: PremiumPayment[];
  }>('/mine');
  return {
    premiumUntil: data?.premiumUntil ?? null,
    open: data?.open ?? null,
    payments: Array.isArray(data?.payments) ? data.payments : [],
  };
}

/** One charge, straight from the poll that settles it. */
export async function fetchPaymentStatus(id: number): Promise<PremiumPayment> {
  const data = await request<{ payment: PremiumPayment }>(`/status/${id}`);
  return data.payment;
}

/**
 * Poll until the charge leaves `pending`, calling `onTick` with each read so
 * the UI can show the live state (receipt, failure reason) as it comes in.
 *
 * Stops polling the moment the charge settles or the STK window expires, so
 * a forgotten tab does not poll a dead charge forever.
 */
export async function waitForPayment(
  id: number,
  { intervalMs = 3000, timeoutMs = 5 * 60_000, onTick }: {
    intervalMs?: number;
    timeoutMs?: number;
    onTick?: (payment: PremiumPayment) => void;
  } = {},
): Promise<PremiumPayment> {
  const started = Date.now();
  for (;;) {
    const payment = await fetchPaymentStatus(id);
    onTick?.(payment);
    if (payment.status !== 'pending') return payment;
    if (Date.now() - started > timeoutMs) {
      return { ...payment, status: 'expired', error: payment.error ?? 'The request timed out.' };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

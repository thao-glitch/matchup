/**
 * Paybill payment client — the user's half of the ledger.
 *
 * The flow this file implements (the server side is `server/src/payments.js`):
 *
 *   1. `createPaymentIntent()` → the app shows *their* unique Account Number,
 *      the configured DTB paybill and the price.
 *   2. They pay into the paybill from their bank app / M-PESA, typing that
 *      Account Number, optionally copying the transaction code into the form.
 *   3. The owner approves the row in `/admin` and premium starts.
 *
 * Nothing here ever talks to the bank: a plain paybill has no callback, so
 * confirmation is a human step by design. All this client does is show the
 * reference and keep the user's own ledger on screen.
 */
import type { PaymentIntent } from '../types';
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
  if (!token) throw new PaymentError('Please sign in to get a payment reference.', 'unauthorized');

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
 * Ask for a payment reference. Safe to call twice: the server returns the
 * SAME open intent (same Account Number) instead of creating a second one,
 * so a reload or an impatient double-tap can never fork the reference.
 */
export async function createPaymentIntent(providerRef?: string): Promise<PaymentIntent> {
  const data = await request<{ payment: PaymentIntent }>('/intent', {
    method: 'POST',
    body: providerRef ? { providerRef } : {},
  });
  return data.payment;
}

/** The signed-in user's own ledger + when premium (if any) runs out. */
export async function fetchMyPayments(): Promise<{
  payments: PaymentIntent[];
  premiumUntil: string | null;
}> {
  const data = await request<{ payments: PaymentIntent[]; premiumUntil: string | null }>('/mine');
  return {
    payments: Array.isArray(data?.payments) ? data.payments : [],
    premiumUntil: data?.premiumUntil ?? null,
  };
}

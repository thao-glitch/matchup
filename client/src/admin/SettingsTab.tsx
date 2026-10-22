/**
 * Settings — the owner's configuration form: payment instructions, the
 * feature switches that shape the whole app, the social-platform economy
 * (commerce) and the Daraja M-PESA credentials.
 *
 * Saving follows the API contract strictly: only the sections (and within
 * `payment`, only the keys) that actually changed are PUT. The server merges
 * partial patches against its current values, so sending just `{"paybill":…}`
 * both minimizes the payload and protects a second admin's concurrent edit of
 * a different field from being clobbered by a stale full-document write.
 *
 * The account-format preview matters because it is user-visible copy: the
 * format is a template (`MU{id}`) rendered for every buyer, and the preview
 * mirrors the server's `renderAccountNo()` so what the admin sees here is
 * exactly what the payer will be asked to type.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  errorMessage,
  formatKes,
  request,
  type CommerceSettings,
  type FeatureFlags,
  type MpesaSettings,
  type PaymentSettings,
  type SettingsBundle,
} from './api';
import { ErrorBanner, Loading, Panel, Pill, Toggle } from './ui';

/** All payment values start as text: an empty `<input type="number">` must
 *  not force `0` into state while the admin is mid-edit. */
interface PaymentForm {
  enabled: boolean;
  bank: string;
  paybill: string;
  accountFormat: string;
  amount: string;
  currency: string;
  productName: string;
  premiumDays: string;
  instructions: string;
  supportContact: string;
}

interface FeatureMeta {
  key: keyof FeatureFlags;
  label: string;
  hint: string;
  danger?: boolean;
}

/** Numbers start as text (same reason as `PaymentForm.amount`), booleans keep
 *  their real type so the toggles diff directly against the server value. */
interface CommerceForm {
  enabled: boolean;
  social: boolean;
  groups: boolean;
  adult: boolean;
  commissionRate: string;
  minPrice: string;
  maxPrice: string;
  currency: string;
}

interface MpesaForm {
  enabled: boolean;
  mode: 'stk' | 'manual';
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  baseUrl: string;
  callbackUrl: string;
  paybill: string;
  accountFormat: string;
  description: string;
}

/** Daraja secrets arrive masked as `••••••••` and the server keeps the stored
 *  value when a masked string is written back — so an untouched password
 *  input round-trips safely, and the mask must never be "completed" with a
 *  guess. */

const MPESA_MODES: { id: MpesaSettings['mode']; label: string; hint: string }[] = [
  { id: 'stk', label: 'STK push', hint: 'Prompts the phone for the M-PESA PIN; the callback settles charges automatically.' },
  { id: 'manual', label: 'Manual', hint: 'Paybill + owner approval in Earnings — needs no Daraja credentials at all.' },
];

/** One-line explanations shown under each switch. `maintenance` is flagged
 *  dangerous: it stops matchmaking for everyone the moment it is saved. */
const FEATURE_META: FeatureMeta[] = [
  { key: 'signup', label: 'Sign-ups', hint: 'New accounts can register from the lobby.' },
  { key: 'ads', label: 'Ads', hint: 'Show ad slots in the app between matches.' },
  { key: 'premium', label: 'Premium purchases', hint: 'Users can buy the paid upgrade.' },
  {
    key: 'maintenance',
    label: 'Maintenance mode',
    hint: 'Pauses matchmaking for everyone immediately.',
    danger: true,
  },
];

export default function SettingsTab() {
  const [remote, setRemote] = useState<SettingsBundle['settings'] | null>(null);
  const [form, setForm] = useState<PaymentForm | null>(null);
  const [features, setFeatures] = useState<FeatureFlags | null>(null);
  const [commerceForm, setCommerceForm] = useState<CommerceForm | null>(null);
  const [mpesaForm, setMpesaForm] = useState<MpesaForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const bundle = await request<SettingsBundle>('/settings');
        if (disposed) return;
        setRemote(bundle.settings);
        setForm(toForm(bundle.settings.payment));
        setFeatures(bundle.settings.features);
        setCommerceForm(toCommerceForm(bundle.settings.commerce));
        setMpesaForm(toMpesaForm(bundle.settings.mpesa));
        setError(null);
      } catch (err) {
        if (!disposed) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // "Unsaved changes" indicator — recomputed from the same diffs the save
  // button will send, so the label can never disagree with the payload.
  const dirty = useMemo(() => {
    if (!remote || !form || !features || !commerceForm || !mpesaForm) return false;
    const changed =
      Object.keys(diffPayment(form, remote.payment)).length +
      Object.keys(diffFeatures(features, remote.features)).length +
      Object.keys(diffCommerce(commerceForm, remote.commerce)).length +
      Object.keys(diffMpesa(mpesaForm, remote.mpesa)).length;
    return changed > 0;
  }, [remote, form, features, commerceForm, mpesaForm]);

  if (loading) return <Loading what="settings" />;

  if (!remote || !form || !features || !commerceForm || !mpesaForm) {
    return (
      <div>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <p className="py-10 text-center text-sm text-muted">Settings could not be loaded.</p>
      </div>
    );
  }

  const amount = Math.round(Number(form.amount));
  const days = Math.round(Number(form.premiumDays));
  const rate = Math.round(Number(commerceForm.commissionRate));
  const minPrice = Math.round(Number(commerceForm.minPrice));
  const maxPrice = Math.round(Number(commerceForm.maxPrice));

  // Arrow consts (not hoisted `function` declarations) so TypeScript keeps the
  // null-guards from the early returns inside these closures.
  const setPayment = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const setCommerce = <K extends keyof CommerceForm>(key: K, value: CommerceForm[K]) => {
    setCommerceForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const setMpesa = <K extends keyof MpesaForm>(key: K, value: MpesaForm[K]) => {
    setMpesaForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    // Validate before diffing: garbage that parses to NaN must produce a
    // readable error, not a silently ignored field.
    if (!Number.isFinite(amount) || amount < 1) {
      setError('Price must be a whole number of at least 1 KES.');
      return;
    }
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      setError('Premium days must be a whole number between 1 and 3650.');
      return;
    }
    if (!form.accountFormat.trim()) {
      setError('The account-number format cannot be empty.');
      return;
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 50) {
      setError('The commission rate must be a whole percentage between 0 and 50.');
      return;
    }
    if (!Number.isFinite(minPrice) || minPrice < 0 || !Number.isFinite(maxPrice) || maxPrice < 1) {
      setError('Prices must be whole numbers — minimum at least 0, maximum at least 1 KES.');
      return;
    }
    if (minPrice > maxPrice) {
      setError('The minimum price cannot exceed the maximum price.');
      return;
    }

    const paymentPatch = diffPayment(form, remote.payment);
    const featurePatch = diffFeatures(features, remote.features);
    const commercePatch = diffCommerce(commerceForm, remote.commerce);
    // Only changed keys travel — the server keeps the stored value for any
    // absent key, which is also what makes masked secrets round-trip.
    const mpesaPatch = diffMpesa(mpesaForm, remote.mpesa);
    const body: {
      payment?: Partial<PaymentSettings>;
      features?: Partial<FeatureFlags>;
      commerce?: Partial<CommerceSettings>;
      mpesa?: Partial<MpesaSettings>;
    } = {};
    if (Object.keys(paymentPatch).length > 0) body.payment = paymentPatch;
    if (Object.keys(featurePatch).length > 0) body.features = featurePatch;
    if (Object.keys(commercePatch).length > 0) body.commerce = commercePatch;
    if (Object.keys(mpesaPatch).length > 0) body.mpesa = mpesaPatch;
    if (!body.payment && !body.features && !body.commerce && !body.mpesa) {
      setError('There are no changes to save.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const next = await request<SettingsBundle>('/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      // Re-seed the form from the server's answer: it trims and clamps what
      // was sent, and the form must show those normalized values, not ours.
      setRemote(next.settings);
      setForm(toForm(next.settings.payment));
      setFeatures(next.settings.features);
      setCommerceForm(toCommerceForm(next.settings.commerce));
      setMpesaForm(toMpesaForm(next.settings.mpesa));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(toForm(remote.payment));
    setFeatures(remote.features);
    setCommerceForm(toCommerceForm(remote.commerce));
    setMpesaForm(toMpesaForm(remote.mpesa));
    setError(null);
  };

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <Panel title="Payment" hint="Everything the lobby shows a buyer before they pay.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paybill number">
            <input
              className="field"
              value={form.paybill}
              inputMode="numeric"
              placeholder="247247"
              onChange={(event) => setPayment('paybill', event.target.value)}
            />
          </Field>

          <Field label="Account-number format">
            <input
              className="field font-mono"
              value={form.accountFormat}
              placeholder="MU{id}"
              onChange={(event) => setPayment('accountFormat', event.target.value)}
            />
            {/* Live preview with a sample account — the template's braces are
                the kind of typo nobody catches in a saved-settings screen. */}
            <p className="mt-1.5 text-xs text-muted">
              Preview: <span className="font-mono font-semibold text-ink">{previewAccountNo(form.accountFormat)}</span>
            </p>
          </Field>

          <Field label="Price in KES">
            <input
              className="field"
              type="number"
              min={1}
              inputMode="numeric"
              value={form.amount}
              onChange={(event) => setPayment('amount', event.target.value)}
            />
          </Field>

          <Field label="Premium days granted">
            <input
              className="field"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={form.premiumDays}
              onChange={(event) => setPayment('premiumDays', event.target.value)}
            />
          </Field>

          <Field label="Bank name">
            <input
              className="field"
              value={form.bank}
              placeholder="Diamond Trust Bank (DTB)"
              onChange={(event) => setPayment('bank', event.target.value)}
            />
          </Field>

          <Field label="Currency">
            <input
              className="field uppercase"
              value={form.currency}
              maxLength={3}
              placeholder="KES"
              onChange={(event) => setPayment('currency', event.target.value.toUpperCase())}
            />
          </Field>

          <Field label="Product name">
            <input
              className="field"
              value={form.productName}
              onChange={(event) => setPayment('productName', event.target.value)}
            />
          </Field>

          <Field label="Support contact">
            <input
              className="field"
              value={form.supportContact}
              placeholder="support@matchup.app"
              onChange={(event) => setPayment('supportContact', event.target.value)}
            />
          </Field>

          <Field label="Payment instructions" className="sm:col-span-2">
            <textarea
              className="field min-h-28 resize-y"
              rows={4}
              value={form.instructions}
              onChange={(event) => setPayment('instructions', event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4">
          <Toggle
            checked={form.enabled}
            onChange={(next) => setPayment('enabled', next)}
            label="Payments enabled"
            hint="Show the paywall and payment instructions in the app."
          />
        </div>
      </Panel>

      <Panel title="Feature switches" hint="Saved instantly to every connected client on the next config fetch.">
        <div className="grid gap-3 sm:grid-cols-2">
          {FEATURE_META.map((meta) => (
            <Toggle
              key={meta.key}
              checked={features[meta.key]}
              danger={meta.danger ?? false}
              label={meta.label}
              hint={meta.hint}
              onChange={(next) =>
                setFeatures((prev) => (prev ? { ...prev, [meta.key]: next } : prev))
              }
            />
          ))}
        </div>
      </Panel>

      <Panel
        title="Social & commissions"
        hint="The paid-content economy: which surfaces sell, and what the platform keeps on every sale."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            checked={commerceForm.enabled}
            onChange={(next) => setCommerce('enabled', next)}
            label="Paid content enabled"
            hint="Master switch — off, and nothing in the platform can be sold."
          />
          <Toggle
            checked={commerceForm.social}
            onChange={(next) => setCommerce('social', next)}
            label="Paid posts"
            hint="Creators can put a price on feed posts."
          />
          <Toggle
            checked={commerceForm.groups}
            onChange={(next) => setCommerce('groups', next)}
            label="Paid group calls"
            hint="Group calls and conferences can charge entry."
          />
          <Toggle
            checked={commerceForm.adult}
            onChange={(next) => setCommerce('adult', next)}
            label="18+ content allowed"
            hint="Creators may flag posts and rooms as adult."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Commission rate (%)"
            hint={
              Number.isFinite(rate)
                ? previewCommission(rate)
                : 'The percentage the platform keeps on every sale (0–50).'
            }
          >
            <input
              className="field"
              type="number"
              min={0}
              max={50}
              inputMode="numeric"
              value={commerceForm.commissionRate}
              onChange={(event) => setCommerce('commissionRate', event.target.value)}
            />
          </Field>

          <Field label="Currency">
            {/* Read-only: the platform is KES/M-PESA end to end; letting this
                drift from the payment section would split every price screen. */}
            <input className="field uppercase opacity-70" value={commerceForm.currency} readOnly />
          </Field>

          <Field label="Minimum price (KES)">
            <input
              className="field"
              type="number"
              min={0}
              inputMode="numeric"
              value={commerceForm.minPrice}
              onChange={(event) => setCommerce('minPrice', event.target.value)}
            />
          </Field>

          <Field label="Maximum price (KES)">
            <input
              className="field"
              type="number"
              min={1}
              inputMode="numeric"
              value={commerceForm.maxPrice}
              onChange={(event) => setCommerce('maxPrice', event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="M-PESA (Daraja)"
        hint="How paid posts and room entry collect money. Callback URL must be the public https://<host>/api/mpesa/callback. Secrets arrive masked and are kept when saved untouched."
      >
        <div className="mt-3">
          <Toggle
            checked={mpesaForm.enabled}
            onChange={(next) => setMpesa('enabled', next)}
            label="M-PESA payments"
            hint="Off, and every paywall button says payments are disabled."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Payment mode"
            hint={MPESA_MODES.find((mode) => mode.id === mpesaForm.mode)?.hint}
            className="sm:col-span-2"
          >
            <select
              className="field"
              value={mpesaForm.mode}
              onChange={(event) => setMpesa('mode', event.target.value === 'manual' ? 'manual' : 'stk')}
            >
              {MPESA_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.id === 'stk' ? 'STK push — prompts the phone for the PIN' : 'Manual — paybill + owner approval'}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Consumer key" hint="Daraja — masked on read; saving keeps the stored value.">
            <input
              className="field font-mono"
              type="password"
              autoComplete="off"
              value={mpesaForm.consumerKey}
              onChange={(event) => setMpesa('consumerKey', event.target.value)}
            />
          </Field>

          <Field label="Consumer secret" hint="Daraja — masked on read; saving keeps the stored value.">
            <input
              className="field font-mono"
              type="password"
              autoComplete="off"
              value={mpesaForm.consumerSecret}
              onChange={(event) => setMpesa('consumerSecret', event.target.value)}
            />
          </Field>

          <Field label="Shortcode" hint="e.g. 174379 in the sandbox.">
            <input
              className="field font-mono"
              inputMode="numeric"
              value={mpesaForm.shortcode}
              onChange={(event) => setMpesa('shortcode', event.target.value)}
            />
          </Field>

          <Field label="Passkey" hint="Daraja — masked on read; saving keeps the stored value.">
            <input
              className="field font-mono"
              type="password"
              autoComplete="off"
              value={mpesaForm.passkey}
              onChange={(event) => setMpesa('passkey', event.target.value)}
            />
          </Field>

          <Field label="Base URL" hint="https://sandbox.safaricom.co.ke or the production host.">
            <input
              className="field font-mono"
              value={mpesaForm.baseUrl}
              onChange={(event) => setMpesa('baseUrl', event.target.value)}
            />
          </Field>

          <Field label="Callback URL" hint="Must be the public https://<host>/api/mpesa/callback — Safaricom cannot reach localhost.">
            <input
              className="field font-mono"
              placeholder="https://matchup.example.com/api/mpesa/callback"
              value={mpesaForm.callbackUrl}
              onChange={(event) => setMpesa('callbackUrl', event.target.value)}
            />
          </Field>

          <Field label="Paybill number (manual mode)" hint="The number creators' buyers pay into; no Daraja account required for manual mode.">
            <input
              className="field font-mono"
              inputMode="numeric"
              value={mpesaForm.paybill}
              onChange={(event) => setMpesa('paybill', event.target.value)}
            />
          </Field>

          <Field label="Account-number format" hint="Manual-mode reference template, e.g. MU{id}.">
            <input
              className="field font-mono"
              placeholder="MU{id}"
              value={mpesaForm.accountFormat}
              onChange={(event) => setMpesa('accountFormat', event.target.value)}
            />
          </Field>

          <Field label="Description" hint="Statement description shown to the payer.">
            <input
              className="field"
              value={mpesaForm.description}
              onChange={(event) => setMpesa('description', event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-surface-2/70 px-4 py-3">
        <p className="text-xs text-muted">{dirty ? 'Unsaved changes' : 'Matches the saved configuration.'}</p>
        <div className="flex items-center gap-2">
          {saved && <Pill tone="ok">Saved</Pill>}
          <button
            type="button"
            className="btn btn-ghost px-3 py-1.5 text-xs"
            disabled={saving || !dirty}
            onClick={discard}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary px-4 py-2 text-sm"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─

function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <span className="label">{label}</span>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function toForm(payment: PaymentSettings): PaymentForm {
  return {
    enabled: payment.enabled,
    bank: payment.bank,
    paybill: payment.paybill,
    accountFormat: payment.accountFormat,
    amount: String(payment.amount),
    currency: payment.currency,
    productName: payment.productName,
    premiumDays: String(payment.premiumDays),
    instructions: payment.instructions,
    supportContact: payment.supportContact,
  };
}

/**
 * Only the payment keys whose value actually changed — the server fills the
 * absent ones from its current document. A number that fails to parse is
 * reported as "changed" so the Save button stays clickable and `save()` can
 * raise a validation error instead of silently doing nothing.
 */
function diffPayment(form: PaymentForm, remote: PaymentSettings): Partial<PaymentSettings> {
  const out: Partial<PaymentSettings> = {};
  if (form.enabled !== remote.enabled) out.enabled = form.enabled;

  const bank = form.bank.trim();
  if (bank !== remote.bank) out.bank = bank;
  const paybill = form.paybill.trim();
  if (paybill !== remote.paybill) out.paybill = paybill;
  const format = form.accountFormat.trim();
  if (format !== remote.accountFormat) out.accountFormat = format;
  const currency = form.currency.trim().toUpperCase();
  if (currency !== remote.currency) out.currency = currency;
  const productName = form.productName.trim();
  if (productName !== remote.productName) out.productName = productName;
  const instructions = form.instructions.trim();
  if (instructions !== remote.instructions) out.instructions = instructions;
  const support = form.supportContact.trim();
  if (support !== remote.supportContact) out.supportContact = support;

  const amount = Math.round(Number(form.amount));
  if (!Number.isFinite(amount) || amount !== remote.amount) out.amount = Number.isFinite(amount) ? amount : remote.amount;
  const days = Math.round(Number(form.premiumDays));
  if (!Number.isFinite(days) || days !== remote.premiumDays) out.premiumDays = Number.isFinite(days) ? days : remote.premiumDays;
  return out;
}

function diffFeatures(next: FeatureFlags, remote: FeatureFlags): Partial<FeatureFlags> {
  const out: Partial<FeatureFlags> = {};
  for (const meta of FEATURE_META) {
    if (next[meta.key] !== remote[meta.key]) out[meta.key] = next[meta.key];
  }
  return out;
}

/**
 * Render `accountFormat` for a sample account — the same substitution and
 * character strip the server applies (`settings.renderAccountNo`), so the
 * preview cannot promise something the payment flow will not produce.
 */
function previewAccountNo(format: string): string {
  const rendered = format.replace(/\{id\}/g, '1042').replace(/\{username\}/g, 'demo');
  return rendered.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'MU1042';
}

function toCommerceForm(commerce: CommerceSettings): CommerceForm {
  return {
    enabled: commerce.enabled,
    social: commerce.social,
    groups: commerce.groups,
    adult: commerce.adult,
    commissionRate: String(commerce.commissionRate),
    minPrice: String(commerce.minPrice),
    maxPrice: String(commerce.maxPrice),
    currency: commerce.currency,
  };
}

function toMpesaForm(mpesa: MpesaSettings): MpesaForm {
  return {
    enabled: mpesa.enabled,
    mode: mpesa.mode,
    consumerKey: mpesa.consumerKey,
    consumerSecret: mpesa.consumerSecret,
    shortcode: mpesa.shortcode,
    passkey: mpesa.passkey,
    baseUrl: mpesa.baseUrl,
    callbackUrl: mpesa.callbackUrl,
    paybill: mpesa.paybill,
    accountFormat: mpesa.accountFormat,
    description: mpesa.description,
  };
}

/** Same contract as `diffPayment`: only changed keys travel; an unparsable
 *  number reports as changed so `save()` gets to raise a validation error
 *  instead of the button silently doing nothing. */
function diffCommerce(form: CommerceForm, remote: CommerceSettings): Partial<CommerceSettings> {
  const out: Partial<CommerceSettings> = {};
  if (form.enabled !== remote.enabled) out.enabled = form.enabled;
  if (form.social !== remote.social) out.social = form.social;
  if (form.groups !== remote.groups) out.groups = form.groups;
  if (form.adult !== remote.adult) out.adult = form.adult;

  const currency = form.currency.trim().toUpperCase();
  if (currency !== remote.currency) out.currency = currency;

  const rate = Math.round(Number(form.commissionRate));
  if (!Number.isFinite(rate) || rate !== remote.commissionRate) out.commissionRate = Number.isFinite(rate) ? rate : remote.commissionRate;
  const min = Math.round(Number(form.minPrice));
  if (!Number.isFinite(min) || min !== remote.minPrice) out.minPrice = Number.isFinite(min) ? min : remote.minPrice;
  const max = Math.round(Number(form.maxPrice));
  if (!Number.isFinite(max) || max !== remote.maxPrice) out.maxPrice = Number.isFinite(max) ? max : remote.maxPrice;
  return out;
}

/**
 * Secrets are ordinary strings here on purpose: the server sends them masked
 * and ignores any value still containing the mask, so an untouched field
 * diffs as "unchanged" and never travels — while a retyped value does.
 */
function diffMpesa(form: MpesaForm, remote: MpesaSettings): Partial<MpesaSettings> {
  const out: Partial<MpesaSettings> = {};
  if (form.enabled !== remote.enabled) out.enabled = form.enabled;
  if (form.mode !== remote.mode) out.mode = form.mode;

  const consumerKey = form.consumerKey.trim();
  if (consumerKey !== remote.consumerKey) out.consumerKey = consumerKey;
  const consumerSecret = form.consumerSecret.trim();
  if (consumerSecret !== remote.consumerSecret) out.consumerSecret = consumerSecret;
  const shortcode = form.shortcode.trim();
  if (shortcode !== remote.shortcode) out.shortcode = shortcode;
  const passkey = form.passkey.trim();
  if (passkey !== remote.passkey) out.passkey = passkey;
  const baseUrl = form.baseUrl.trim();
  if (baseUrl !== remote.baseUrl) out.baseUrl = baseUrl;
  const callbackUrl = form.callbackUrl.trim();
  if (callbackUrl !== remote.callbackUrl) out.callbackUrl = callbackUrl;
  const paybill = form.paybill.trim();
  if (paybill !== remote.paybill) out.paybill = paybill;
  const accountFormat = form.accountFormat.trim();
  if (accountFormat !== remote.accountFormat) out.accountFormat = accountFormat;
  const description = form.description.trim();
  if (description !== remote.description) out.description = description;
  return out;
}

/** "Creators keep 85% on a KES 100 sale" — the split every creator will ask
 *  about, computed from the rate being typed, not from the saved one. */
function previewCommission(rate: number): string {
  const keep = 100 - rate;
  return `Creators keep ${keep}% on a KES 100 sale — ${formatKes(100 * (keep / 100))} to them, ${formatKes(100 - 100 * (keep / 100))} to the platform.`;
}

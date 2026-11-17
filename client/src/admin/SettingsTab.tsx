/**
 * Settings — the owner's configuration form: the premium subscription, the
 * feature switches that shape the whole app, the social-platform economy
 * (commerce) and the Daraja M-PESA credentials.
 *
 * Saving follows the API contract strictly: only the sections (and within a
 * section, only the keys) that actually changed are PUT. The server merges
 * partial patches against its current values, so sending just `{"shortcode":…}`
 * both minimizes the payload and protects a second admin's concurrent edit of
 * a different field from being clobbered by a stale full-document write.
 *
 * Every payment on the platform is an STK push, so the M-PESA section is the
 * one that decides whether money can be taken at all — hence the "Test
 * connection" button, which reports each requirement separately and can fire
 * a real KES 1 prompt at a phone you choose.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  errorMessage,
  formatKes,
  request,
  testMpesa,
  type CommerceSettings,
  type FeatureFlags,
  type MpesaCheck,
  type MpesaSettings,
  type PaymentSettings,
  type SettingsBundle,
} from './api';
import { ErrorBanner, Loading, Panel, Pill, Toggle } from './ui';

/** 0 = Sunday … 6 = Saturday — shown on the Settings payout panel and to creators. */
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

/** All payment values start as text: an empty `<input type="number">` must
 *  not force `0` into state while the admin is mid-edit. */
interface PaymentForm {
  enabled: boolean;
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
  manualEnabled: boolean;
  manualDestination: string;
  manualInstructions: string;
  payoutDayOfWeek: string;
}

interface MpesaForm {
  enabled: boolean;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  shortcodeType: 'paybill' | 'till';
  passkey: string;
  baseUrl: string;
  callbackUrl: string;
  description: string;
}

/** Daraja secrets arrive masked as `••••••••` and the server keeps the stored
 *  value when a masked string is written back — so an untouched password
 *  input round-trips safely, and the mask must never be "completed" with a
 *  guess. */

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
  /** The Daraja self-check: the checks last run, if any. */
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; checks: MpesaCheck[] } | null>(null);

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
    setTestResult(null);
  };

  /**
   * Ask Daraja what is actually wrong.
   *
   * The endpoint reads the SAVED configuration, not this form — so an
   * unsaved edit is not what gets tested. That is deliberate: testing values
   * that only exist in the browser would report "working" for a setup the
   * server cannot actually use.
   */
  const runTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const phone = testPhone.trim();
      setTestResult(await testMpesa(phone || undefined));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <Panel
        title="Premium subscription"
        hint="What a buyer is charged when their phone prompts them for the M-PESA PIN."
      >
        <div className="grid gap-4 sm:grid-cols-2">
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
            label="Premium enabled"
            hint="Show the pay button in the app."
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

      {/* Manual review mode — for when there is no Daraja at all. Every
          purchase opens a pending charge; the buyer sends the money by any
          M-PESA route; the owner confirms the SMS in Earnings. Approval
          settles the charge exactly as an STK callback would. */}
      <Panel
        title="Manual payments"
        hint="No Daraja? Every pay button becomes a pending request you approve by hand after the SMS lands. The split, wallet credit and entitlement all work exactly as an STK payment. Remember to press Save changes."
      >
        <div className="mt-3">
          <Toggle
            checked={commerceForm.manualEnabled}
            onChange={(next) => setCommerce('manualEnabled', next)}
            label="Manual payment review"
            hint="On, every purchase waits for your approval in Earnings → Charges instead of an STK prompt."
          />
        </div>

        <div className="mt-4 space-y-3">
          <Field
            label="Where buyers send the money"
            hint="Shown verbatim to every buyer on the pay screen — e.g. a Pochi la Biashara number, or the line the owner checks for SMS."
          >
            <input
              className="field"
              type="text"
              value={commerceForm.manualDestination}
              maxLength={80}
              placeholder="e.g. 0712 345 678 (Pochi la Biashara)"
              onChange={(event) => setCommerce('manualDestination', event.target.value)}
            />
          </Field>

          <Field
            label="Instructions shown to the buyer"
            hint="Exact wording shown on the pay screen — keep it short. The amount and the buyer's phone number always come first."
          >
            <textarea
              className="field min-h-[4.5rem]"
              maxLength={600}
              value={commerceForm.manualInstructions}
              placeholder="Send the exact amount from the number you entered. We confirm it within a few minutes and unlock it instantly."
              onChange={(event) => setCommerce('manualInstructions', event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Creator payouts"
        hint="Creators request a withdrawal at any time; you pay them all out once a week on this day — when it arrives, send what the ledger says is owed and approve each request."
      >
        <div className="mt-3">
          <Field
            label="Payout day (once a week)"
            hint="Creators see this day on the wallet page so they know when to expect their money."
          >
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  className={`btn px-3 py-1.5 text-xs ${
                    Number(commerceForm.payoutDayOfWeek) === day.value ? 'btn-primary' : 'btn-ghost'
                  }`}
                  onClick={() => setCommerce('payoutDayOfWeek', String(day.value))}
                >
                  {day.label}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Panel>

      <Panel
        title="M-PESA (Daraja)"
        hint="Every payment on the platform is an STK push: the buyer's phone prompts for the PIN and the callback settles the charge. Callback URL must be the public https://<host>/api/mpesa/callback. Secrets arrive masked and are kept when saved untouched."
      >
        <div className="mt-3">
          <Toggle
            checked={mpesaForm.enabled}
            onChange={(next) => setMpesa('enabled', next)}
            label="M-PESA payments"
            hint="Off, and every pay button says payments are disabled."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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

          <Field
            label="Shortcode"
            hint={
              mpesaForm.shortcode
                ? 'Bills the buyer; settle its balance to your own M-PESA number on Safaricom’s side.'
                : 'Required — Safaricom rejects an STK push without one. Register a Paybill and tell ' +
                  'Safaricom to settle it to your M-PESA number: that is what makes your number the ' +
                  'one that receives the cash. The sandbox uses 174379.'
            }
          >
            <input
              className="field font-mono"
              inputMode="numeric"
              placeholder="174379"
              value={mpesaForm.shortcode}
              onChange={(event) => setMpesa('shortcode', event.target.value)}
            />
          </Field>

          <Field
            label="Shortcode type"
            hint={
              mpesaForm.shortcodeType === 'till'
                ? 'Prompts go out as CustomerBuyGoodsOnline — what a Buy Goods till expects. Money collects on the till and you withdraw it to your own number from there.'
                : 'Prompts go out as CustomerPayBillOnline — the Lipa na M-PESA Paybill rail, and the default. Switch to Till if your shortcode is a Buy Goods number: Safaricom rejects the mismatch.'
            }
          >
            <select
              className="field"
              aria-label="Shortcode type"
              value={mpesaForm.shortcodeType}
              onChange={(event) =>
                setMpesa('shortcodeType', event.target.value as 'paybill' | 'till')
              }
            >
              <option value="paybill">Paybill (CustomerPayBillOnline)</option>
              <option value="till">Buy Goods till (CustomerBuyGoodsOnline)</option>
            </select>
          </Field>

          <Field label="Passkey" hint="The Lipa na M-PESA Online passkey — issued with the shortcode, not your account password.">
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

          <Field label="Description" hint="Statement description shown to the payer.">
            <input
              className="field"
              value={mpesaForm.description}
              onChange={(event) => setMpesa('description', event.target.value)}
            />
          </Field>
        </div>

        {/* ── The self-check ────────────────────────────────────────────── */}
        <div className="mt-5 rounded-xl border border-white/10 bg-surface-3/60 p-4">
          <p className="text-sm font-semibold text-ink">Test the connection</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Checks each requirement separately and, with a phone number, fires a real KES 1 prompt
            at it — the only way Safaricom will validate the shortcode and passkey for you. This
            reads what is <span className="font-semibold text-ink">saved</span> above, so save first.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="label" htmlFor="mpesa-test-phone">
                Phone (optional)
              </label>
              <input
                id="mpesa-test-phone"
                className="field"
                inputMode="tel"
                placeholder="0712 345 678"
                value={testPhone}
                onChange={(event) => setTestPhone(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary px-4 py-2 text-sm"
              disabled={testing}
              onClick={() => void runTest()}
            >
              {testing ? 'Checking…' : 'Test connection'}
            </button>
          </div>

          {testResult && (
            <ul className="mt-3 space-y-1.5">
              {testResult.checks.map((check) => (
                <li key={check.name} className="flex gap-2 text-xs leading-relaxed">
                  <span
                    className={
                      check.ok === true
                        ? 'text-ok'
                        : check.ok === false
                          ? 'text-danger'
                          : 'text-muted'
                    }
                    aria-hidden="true"
                  >
                    {check.ok === true ? '✓' : check.ok === false ? '✕' : '·'}
                  </span>
                  <span className={check.ok === false ? 'text-danger' : 'text-muted'}>
                    {check.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
    manualEnabled: commerce.manualEnabled,
    manualDestination: commerce.manualDestination,
    manualInstructions: commerce.manualInstructions,
    payoutDayOfWeek: String(commerce.payoutDayOfWeek),
  };
}

function toMpesaForm(mpesa: MpesaSettings): MpesaForm {
  return {
    enabled: mpesa.enabled,
    consumerKey: mpesa.consumerKey,
    consumerSecret: mpesa.consumerSecret,
    shortcode: mpesa.shortcode,
    shortcodeType: mpesa.shortcodeType,
    passkey: mpesa.passkey,
    baseUrl: mpesa.baseUrl,
    callbackUrl: mpesa.callbackUrl,
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

  if (form.manualEnabled !== remote.manualEnabled) out.manualEnabled = form.manualEnabled;
  const destination = form.manualDestination.trim();
  if (destination !== remote.manualDestination) out.manualDestination = destination;
  const instructions = form.manualInstructions.trim();
  if (instructions !== remote.manualInstructions) out.manualInstructions = instructions;
  const day = Math.trunc(Number(form.payoutDayOfWeek));
  if (!Number.isFinite(day) || day !== remote.payoutDayOfWeek) {
    out.payoutDayOfWeek = Number.isFinite(day) ? Math.min(6, Math.max(0, day)) : remote.payoutDayOfWeek;
  }
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

  const consumerKey = form.consumerKey.trim();
  if (consumerKey !== remote.consumerKey) out.consumerKey = consumerKey;
  const consumerSecret = form.consumerSecret.trim();
  if (consumerSecret !== remote.consumerSecret) out.consumerSecret = consumerSecret;
  const shortcode = form.shortcode.trim();
  if (shortcode !== remote.shortcode) out.shortcode = shortcode;
  if (form.shortcodeType !== remote.shortcodeType) out.shortcodeType = form.shortcodeType;
  const passkey = form.passkey.trim();
  if (passkey !== remote.passkey) out.passkey = passkey;
  const baseUrl = form.baseUrl.trim();
  if (baseUrl !== remote.baseUrl) out.baseUrl = baseUrl;
  const callbackUrl = form.callbackUrl.trim();
  if (callbackUrl !== remote.callbackUrl) out.callbackUrl = callbackUrl;
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

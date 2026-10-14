/**
 * Settings — the owner's configuration form: payment instructions and the
 * feature switches that shape the whole app.
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
  request,
  type FeatureFlags,
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
    if (!remote || !form || !features) return false;
    const paymentKeys = Object.keys(diffPayment(form, remote.payment)).length;
    const featureKeys = Object.keys(diffFeatures(features, remote.features)).length;
    return paymentKeys + featureKeys > 0;
  }, [remote, form, features]);

  if (loading) return <Loading what="settings" />;

  if (!remote || !form || !features) {
    return (
      <div>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <p className="py-10 text-center text-sm text-muted">Settings could not be loaded.</p>
      </div>
    );
  }

  const amount = Math.round(Number(form.amount));
  const days = Math.round(Number(form.premiumDays));

  // Arrow consts (not hoisted `function` declarations) so TypeScript keeps the
  // null-guards from the early returns inside these closures.
  const setPayment = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
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

    const paymentPatch = diffPayment(form, remote.payment);
    const featurePatch = diffFeatures(features, remote.features);
    const body: { payment?: Partial<PaymentSettings>; features?: Partial<FeatureFlags> } = {};
    if (Object.keys(paymentPatch).length > 0) body.payment = paymentPatch;
    if (Object.keys(featurePatch).length > 0) body.features = featurePatch;
    if (!body.payment && !body.features) {
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

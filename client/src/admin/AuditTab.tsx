/**
 * Audit — newest-first trail of every dashboard action: who reviewed which
 * payment, who banned whom, which setting key changed.
 *
 * Kept deliberately dumb: one fetch, one table, raw JSON detail. This screen
 * is read during incidents ("who approved #4?") when nobody wants filters —
 * the `limit=100` server cap already bounds the payload.
 */
import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime, request, timeAgo, type AuditItem } from './api';
import { ErrorBanner, Loading, Panel, Pill, TD, TH } from './ui';

const LIMIT = 100;

export default function AuditTab() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      try {
        const next = await request<{ items: AuditItem[] }>(`/audit?limit=${LIMIT}`, {
          signal: controller.signal,
        });
        if (!disposed) {
          setItems(next.items);
          setError(null);
        }
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [reload]);

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <Panel
        title="Audit trail"
        hint={`Last ${LIMIT} dashboard actions, newest first`}
        right={
          <button
            type="button"
            className="btn btn-ghost px-3 py-1.5 text-xs"
            disabled={loading}
            onClick={() => setReload((n) => n + 1)}
          >
            Refresh
          </button>
        }
      >
        {items && items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>Time</th>
                  <th className={TH}>Admin</th>
                  <th className={TH}>Action</th>
                  <th className={TH}>Target</th>
                  <th className={TH}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/5">
                    <td className={`${TD} whitespace-nowrap text-muted`}>
                      {formatDateTime(item.createdAt)}
                      <span className="block text-[11px] text-muted/70">{timeAgo(item.createdAt)}</span>
                    </td>
                    <td className={TD}>
                      <span className="font-semibold text-ink">{item.adminName}</span>
                      <span className="block text-[11px] text-muted">#{item.adminId}</span>
                    </td>
                    <td className={TD}>
                      <Pill tone={actionTone(item.action)}>{item.action}</Pill>
                    </td>
                    <td className={`${TD} text-sm text-ink`}>{item.target || '—'}</td>
                    <td className={TD}>
                      {item.detail ? (
                        <pre className="max-w-md whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted">
                          {JSON.stringify(item.detail, null, 2)}
                        </pre>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loading ? (
          <Loading what="audit entries" />
        ) : (
          <p className="py-8 text-center text-sm text-muted">No audit entries yet.</p>
        )}
      </Panel>
    </div>
  );
}

/**
 * Color by meaning, not by string: destructive actions read red, approvals
 * green, configuration changes blue, anything else (logins, bootstrap) plain.
 */
function actionTone(action: string): 'ok' | 'danger' | 'warn' | 'accent' | 'muted' {
  if (action.startsWith('payment.approved')) return 'ok';
  if (action.startsWith('payment.rejected')) return 'danger';
  if (action.includes('.delete') || action.endsWith('.ban')) return 'danger';
  if (action.includes('.unban') || action.includes('revoke')) return 'warn';
  if (action.startsWith('settings') || action === 'bootstrap') return 'accent';
  return 'muted';
}

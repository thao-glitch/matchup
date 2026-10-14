/**
 * Overview — the front page: account health, ledger totals, live queue and
 * call telemetry, refreshed on a 15-second poll while the tab is visible.
 *
 * Polling rules that matter:
 *   • one request in flight at a time (`busy`), so a slow server cannot queue
 *     up overlapping refreshes;
 *   • nothing runs while the browser tab is hidden, and returning to it
 *     refreshes immediately instead of showing numbers frozen from before;
 *   • the interval dies with the component — switching tabs in the dashboard
 *     unmounts this screen and stops the traffic.
 *
 * Charts are plain divs sized in percent: 14 bars do not justify a chart
 * library, and a canvas would not print, copy or theme itself.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  errorMessage,
  formatClock,
  formatDurationMs,
  formatKes,
  formatUptime,
  request,
  timeAgo,
  type DayTotal,
  type OverviewData,
} from './api';
import { ErrorBanner, Loading, Panel, Pill, Stat, TH, TD } from './ui';

/** Refresh cadence — slow enough to be invisible in the access log, fast
 *  enough that "online now" feels live. */
const POLL_MS = 15_000;

export default function OverviewTab() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  /** Bumping this re-runs the effect — wired to the manual Refresh button. */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    async function refresh() {
      if (disposed || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const next = await request<OverviewData>('/overview');
        if (!disposed) {
          setData(next);
          setError(null);
          setUpdatedAt(new Date());
        }
      } catch (err) {
        // 401 is handled globally (the shell flips to the login screen);
        // everything else becomes a banner above still-usable last data.
        if (!disposed) setError(errorMessage(err));
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  const days = useMemo(() => (data ? chartDays(data.payments.byDay) : []), [data]);
  const revenue14 = useMemo(() => days.reduce((sum, day) => sum + day.total, 0), [days]);

  if (!data && !error) return <Loading what="overview" />;

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {data && (
        <>
          {data.config.features.maintenance && (
            <div className="rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-sm font-semibold text-warn">
              Maintenance mode is on — matchmaking is paused for everyone right now.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              Last updated <span className="tabular-nums text-ink">{updatedAt ? formatClock(updatedAt) : '—'}</span>
            </p>
            <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={() => setReload((n) => n + 1)}>
              Refresh now
            </button>
          </div>

          {/* Four stat cards: grouped by what they answer, not by which
              endpoint produced them. */}
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Accounts">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Total" value={data.accounts.total} />
                <Stat label="New 7d" value={data.accounts.new7d} />
                <Stat label="Active 7d" value={data.accounts.active7d} />
                <Stat label="Premium" value={data.accounts.premium} tone={data.accounts.premium > 0 ? 'ok' : undefined} />
                <Stat label="Banned" value={data.accounts.banned} tone={data.accounts.banned > 0 ? 'danger' : undefined} />
              </div>
            </Panel>

            <Panel title="Payments" hint={`Approved total ${formatKes(data.payments.approvedTotal)}`}>
              {/* 2 columns under `sm`: a wide "Ksh 1,250,000" value would
                  overflow an 80px cell in a 4-up grid on a phone. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Pending"
                  value={data.payments.pending}
                  tone={data.payments.pending > 0 ? 'warn' : undefined}
                  hint="awaiting review"
                />
                <Stat label="Approved" value={data.payments.approved} />
                <Stat label="Rejected" value={data.payments.rejected} />
                <Stat label="Revenue" value={formatKes(data.payments.approvedTotal)} tone="ok" />
              </div>
            </Panel>

            <Panel title="Live now">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Online" value={data.live.online} />
                <Stat label="Looking" value={data.live.looking} hint="in queue" />
                <Stat label="Rooms" value={data.calls.rooms} hint="since restart" />
              </div>
            </Panel>

            <Panel title="Calls" hint={`${data.calls.reports} reports · counters reset ${timeAgo(data.calls.since)}`}>
              <div className="grid grid-cols-3 gap-3">
                <Stat
                  label="Success rate"
                  value={fmtPct(data.calls.outcomes.successRate)}
                  tone={toneForRate(data.calls.outcomes.successRate)}
                  hint={`${data.calls.outcomes.connected} connected`}
                />
                <Stat
                  label="Relay share"
                  value={fmtPct(data.calls.relayShare)}
                  tone={toneForRelay(data.calls.relayShare)}
                  hint="TURN usage"
                />
                <Stat
                  label="Avg RTT"
                  value={data.calls.rttMs.avg === null ? '—' : `${data.calls.rttMs.avg} ms`}
                  hint={`${data.calls.rttMs.samples} samples`}
                />
                <Stat
                  label="Avg duration"
                  value={data.calls.durationMs.avg === null ? '—' : formatDurationMs(data.calls.durationMs.avg)}
                  hint={`${data.calls.durationMs.samples} samples`}
                />
                <Stat label="Failed" value={data.calls.outcomes.failed} tone={data.calls.outcomes.failed > 0 ? 'danger' : undefined} />
                <Stat label="Dropped" value={data.calls.dropped} hint="malformed reports" />
              </div>
            </Panel>
          </div>

          {/* The two series come from the same `payments.byDay` rows: count of
              approved payments per day, and the money that day brought in. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Approvals per day" hint="Last 14 days">
              <DayBars days={days} pick={(d) => d.count} label={(d) => `${d.day}: ${d.count} approved`} barClass="bg-accent/70 hover:bg-accent" />
            </Panel>
            <Panel title="Revenue per day" hint={`14-day total ${formatKes(revenue14)}`}>
              <DayBars days={days} pick={(d) => d.total} label={(d) => `${d.day}: ${formatKes(d.total)}`} barClass="bg-ok/60 hover:bg-ok" />
            </Panel>
          </div>

          {data.calls.recent.length > 0 && (
            <Panel title="Recent calls" hint="Newest first · room reports since the last restart">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead className="border-b border-white/10">
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Outcome</th>
                      <th className={TH}>Path</th>
                      <th className={TH}>ICE source</th>
                      <th className={TH}>RTT</th>
                      <th className={TH}>Duration</th>
                      <th className={TH}>Room</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls.recent.map((report) => (
                      <tr key={report.roomId} className="border-b border-white/5 last:border-0">
                        <td className={`${TD} whitespace-nowrap text-muted`} title={formatClock(new Date(report.at))}>
                          {timeAgo(report.at)}
                        </td>
                        <td className={TD}>
                          <Pill tone={report.outcome === 'connected' ? 'ok' : 'danger'}>{report.outcome}</Pill>
                        </td>
                        <td className={TD}>{report.path}</td>
                        <td className={`${TD} text-muted`}>{report.iceSource}</td>
                        <td className={`${TD} tabular-nums`}>{report.rttMs === null ? '—' : `${report.rttMs} ms`}</td>
                        <td className={`${TD} tabular-nums`}>
                          {report.durationMs === null ? '—' : formatDurationMs(report.durationMs)}
                        </td>
                        <td className={`${TD} font-mono text-xs text-muted`}>{report.roomId.slice(0, 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="text-[11px] text-muted">
            Store {data.store.mode}
            {data.store.mode !== 'maria' && ' — database not connected, payments and settings are disabled'} · Node{' '}
            {data.server.node} · uptime {formatUptime(data.server.uptimeSec)} · server time{' '}
            {formatClock(new Date(data.server.now))}
          </p>
        </>
      )}
    </div>
  );
}

// ── Chart helpers ────────────────────────────────────────────────────────────

/**
 * Rebuild the last 14 calendar days around the newest server day, zero-filling
 * gaps. Anchoring on the server's own `day` keys (not on the browser clock)
 * keeps the x-axis honest when the admin's machine sits in another timezone —
 * the server's "today" and the browser's "today" can differ by a day.
 */
function chartDays(byDay: DayTotal[]): DayTotal[] {
  const map = new Map(byDay.map((d) => [d.day, d]));
  const anchor = byDay.length ? byDay[byDay.length - 1].day : localDayKey(new Date());
  // `T00:00:00` without a zone parses as local time — matching the server's
  // `DATE_FORMAT(created_at, '%Y-%m-%d')` day grouping.
  const end = new Date(`${anchor}T00:00:00`);
  if (Number.isNaN(end.getTime())) return byDay;

  for (let back = 13; back >= 0; back--) {
    const day = new Date(end);
    day.setDate(end.getDate() - back);
    const key = localDayKey(day);
    if (!map.has(key)) map.set(key, { day: key, count: 0, total: 0 });
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shortDay(key: string): string {
  const parsed = new Date(`${key}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return key;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parsed);
}

/** One bar per day. Height is a percentage of the panel, so the chart scales
 *  with the layout instead of a fixed pixel size. */
function DayBars({
  days,
  pick,
  label,
  barClass,
}: {
  days: DayTotal[];
  pick: (day: DayTotal) => number;
  label: (day: DayTotal) => string;
  barClass: string;
}) {
  if (days.length === 0) return <p className="py-6 text-center text-xs text-muted">No payment activity yet.</p>;

  const max = Math.max(1, ...days.map(pick));
  return (
    <div>
      <div className="flex h-28 items-end gap-1">
        {days.map((day) => {
          const value = pick(day);
          // Empty days keep a 2px stub so the axis never looks broken.
          const height = value > 0 ? Math.max(6, (value / max) * 100) : 2;
          return (
            <div
              key={day.day}
              className={`min-w-0 flex-1 rounded-t-sm transition-colors ${barClass}`}
              style={{ height: `${height}%` }}
              title={label(day)}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted">
        <span>{shortDay(days[0].day)}</span>
        <span>{shortDay(days[days.length - 1].day)}</span>
      </div>
    </div>
  );
}

// ── Small display formatters ─────────────────────────────────────────────────

function fmtPct(value: number | null): string {
  // `null` means "no samples yet" — show a dash, never a fabricated 0%.
  return value === null ? '—' : `${value}%`;
}

function toneForRate(rate: number | null): 'ok' | 'danger' | 'warn' | undefined {
  if (rate === null) return undefined;
  if (rate >= 80) return 'ok';
  if (rate >= 50) return 'warn';
  return 'danger';
}

function toneForRelay(share: number | null): 'ok' | 'warn' | undefined {
  // Relay traffic works but costs money; a rising share is worth noticing.
  if (share === null) return undefined;
  return share >= 30 ? 'warn' : undefined;
}

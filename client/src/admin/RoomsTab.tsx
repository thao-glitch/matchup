/**
 * Rooms — every group call / conference the platform has ever hosted.
 *
 * The one operation that matters here is **End room**: it closes the room
 * live for everyone connected (the socket layer kicks participants the
 * moment the server flips the status), so it sits behind a confirm. Reopen
 * exists for the accidental ending — a room with participants still gets
 * them back on the next `room:enter`.
 *
 * Entry fees land in the creator's wallet minus the platform commission;
 * the actual money lives in the Earnings tab, this screen only shows the
 * price each host set.
 */
import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime, formatKes, request, type AdminRoom, type Paged } from './api';
import { ErrorBanner, Loading, Pill, TD, TH } from './ui';
import { RoomInspectorModal } from './Inspector';

const PAGE_SIZE = 25;

/** Empty string = every room (the server treats it as "no filter"). */
type StatusFilter = '' | 'live' | 'ended';

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'ended', label: 'Ended' },
];

export default function RoomsTab() {
  const [status, setStatus] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<AdminRoom> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Id of the room being mutated — other rows stay clickable. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  /** Room being supervised — roster and takings, past the paywall. */
  const [viewingRoomId, setViewingRoomId] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    async function load() {
      setLoading(true);
      const search = new URLSearchParams({
        status,
        page: String(page),
        size: String(PAGE_SIZE),
      });
      try {
        const next = await request<Paged<AdminRoom>>(`/rooms?${search}`, { signal: controller.signal });
        if (!disposed) {
          setData(next);
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
  }, [status, page, reload]);

  async function setRoomStatus(room: AdminRoom, next: AdminRoom['status']) {
    setBusyId(room.id);
    setError(null);
    try {
      await request(`/rooms/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      setReload((n) => n + 1);
    } catch (err) {
      // Shown verbatim: "room not found", "room already ended", …
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function endRoom(room: AdminRoom) {
    const confirmed = window.confirm(
      `End "${room.title}" (${room.slug})?\n\n` +
        'The room closes immediately for everyone connected — calls drop and new entry is refused. ' +
        'Paid entry can be re-opened with Reopen while the room still has participants.',
    );
    if (!confirmed) return;
    void setRoomStatus(room, 'ended');
  }

  const total = data?.total ?? 0;
  const size = data?.size ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const range = total === 0 ? '0 of 0' : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`;

  return (
    <div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Money routing in one line so nobody has to open Earnings to know
          where the entry fee went. */}
      <p className="mb-4 rounded-xl border border-white/10 bg-surface-2/70 px-3.5 py-2.5 text-xs text-muted">
        Entry fees are charged per join and land in the host's wallet minus the platform commission — the full
        ledger lives in the <span className="font-semibold text-ink">Earnings</span> tab.
      </p>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex rounded-xl border border-white/10 bg-white/5 p-1">
          {FILTERS.map((item) => (
            <button
              key={item.id || 'all'}
              type="button"
              onClick={() => {
                // Both setters run in one event → one batched render →
                // exactly one fetch with the filter already reset.
                setStatus(item.id);
                setPage(1);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                status === item.id ? 'bg-accent text-white' : 'text-muted hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted sm:ml-auto" aria-live="polite">
          {loading ? 'Loading…' : `${range} rooms`}
        </p>
      </div>

      {data && total > 0 ? (
        <>
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''} transition-opacity`}>
            <table className="w-full min-w-[900px]">
              <thead className="border-b border-white/10">
                <tr>
                  <th className={TH}>Room</th>
                  <th className={TH}>Host</th>
                  <th className={TH}>Kind</th>
                  <th className={TH}>Price</th>
                  <th className={TH}>People</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Created</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((room) => (
                  <tr key={room.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/5">
                    <td className={TD}>
                      <span className="font-mono text-xs text-muted">/{room.slug}</span>
                      <span className="block max-w-[220px] truncate font-semibold text-ink" title={room.title}>
                        {room.title}
                      </span>
                    </td>
                    <td className={`${TD} whitespace-nowrap font-semibold text-ink`}>@{room.hostName}</td>
                    <td className={TD}>
                      <Pill tone={room.kind === 'conference' ? 'accent' : 'muted'}>{room.kind}</Pill>
                    </td>
                    <td className={`${TD} whitespace-nowrap tabular-nums`}>
                      {room.price > 0 ? formatKes(room.price) : <span className="text-muted">Free</span>}
                      {room.isAdult && (
                        <span className="ml-1.5 inline-block align-middle">
                          <Pill tone="danger">18+</Pill>
                        </span>
                      )}
                    </td>
                    {/* Live head-count straight from the socket layer — the
                        reason ending a room needs a confirm in the first place. */}
                    <td className={`${TD} whitespace-nowrap tabular-nums`}>
                      {room.status === 'live' ? room.participants : '—'}
                      <span className="text-muted"> / {room.maxParticipants}</span>
                    </td>
                    <td className={TD}>
                      <Pill tone={room.status === 'live' ? 'ok' : 'muted'}>{room.status}</Pill>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-muted`} title={formatDateTime(room.createdAt)}>
                      {room.status === 'ended' && room.endedAt
                        ? `ended ${formatDateTime(room.endedAt)}`
                        : formatDateTime(room.createdAt)}
                    </td>
                    <td className={TD}>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          className="btn btn-primary px-2.5 py-1.5 text-xs"
                          disabled={busyId === room.id}
                          onClick={() => setViewingRoomId(room.id)}
                        >
                          Inspect
                        </button>
                        {room.status === 'live' ? (
                          <button
                            type="button"
                            className="btn btn-danger px-2.5 py-1.5 text-xs"
                            disabled={busyId === room.id}
                            onClick={() => endRoom(room)}
                          >
                            End room
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost px-2.5 py-1.5 text-xs"
                            disabled={busyId === room.id}
                            title="Make the room joinable again"
                            onClick={() => void setRoomStatus(room, 'live')}
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted">{range}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="btn btn-ghost px-3 py-1.5 text-xs"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : loading ? (
        <Loading what="rooms" />
      ) : (
        <p className="py-10 text-center text-sm text-muted">No rooms match this filter.</p>
      )}

      {viewingRoomId !== null && (
        <RoomInspectorModal roomId={viewingRoomId} onClose={() => setViewingRoomId(null)} />
      )}
    </div>
  );
}

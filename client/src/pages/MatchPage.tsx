/**
 * MatchPage — the original 1v1 video app, untouched, as a full-screen page.
 *
 * `App.tsx` is a self-contained state machine (lobby → waiting → chat →
 * post-call) that owns its own socket, camera and account. Wrapping it here is
 * deliberately the thinnest possible seam: full-bleed container, a back
 * button, nothing else. The bottom tab bar is hidden by `Shell` for this route
 * so a live call is never interrupted by navigation chrome.
 */
import App from '../App';
import { navigate } from '../lib/router';
import { ArrowLeftIcon } from '../components/icons';

export default function MatchPage() {
  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-surface">
      <App />
      {/* The lobby's own header sits top-centre, so the exit lives top-left and
          never covers a control the call itself needs. */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="fixed left-3 top-3 z-[60] inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-surface-2/80 px-3 py-2 text-xs font-semibold text-muted backdrop-blur transition-colors hover:text-ink"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back
      </button>
    </div>
  );
}

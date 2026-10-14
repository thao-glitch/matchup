/**
 * The catalogue of everything a live call can do — the app's advertisement
 * copy, in one place.
 *
 * These entries feed the two surfaces that sell the experience *before* it
 * starts:
 *
 *   • the lobby grid ("More than a video call") — a visitor deciding whether
 *     to grant camera access sees what they are granting it for;
 *   • the waiting-screen rotator ("Your call comes with") — engaged queue
 *     time becomes a guided tour of the dock buttons they are about to get.
 *
 * Keeping the copy here (next to the real implementations in `callDeck.ts`
 * and `VideoChat.tsx`) is what stops the advert from drifting away from the
 * product: a feature that is removed from the call is removed from this list
 * in the same commit.
 */

export interface CallFeature {
  /** Stable key for React lists and the rotator's re-mount animation. */
  id: string;
  /** Rendered as a glyph everywhere — the call dock uses the same emoji. */
  emoji: string;
  /** Plain name, no emoji: `Spark`, not `✨ Spark`. */
  name: string;
  /** One-line pitch shown in the lobby grid. */
  blurb: string;
  /**
   * Waiting-screen rotator line (name is rendered separately there, so the
   * tip must read naturally after "Name — …"). Features without a tip do
   * not rotate in.
   */
  tip?: string;
}

export const CALL_FEATURES: readonly CallFeature[] = [
  {
    id: 'spark',
    emoji: '✨',
    name: 'Spark',
    blurb: 'Conversation starters you both draw at once — no awkward silences.',
    tip: 'Draw the same conversation starter on both screens — instant common ground.',
  },
  {
    id: 'duel',
    emoji: '✊',
    name: 'Duel',
    blurb: 'Rock-paper-scissors, first to two. Rematch as often as you like.',
    tip: 'Settle any debate on the spot — rock-paper-scissors, first to 2 wins.',
  },
  {
    id: 'react',
    emoji: '😊',
    name: 'Reactions',
    blurb: 'Floating emoji over the video — react without interrupting.',
    tip: 'Say it without saying it — reactions burst over the video.',
  },
  {
    id: 'chat',
    emoji: '💬',
    name: 'Chat',
    blurb: 'Text alongside the video: links, jokes, follow-ups after the call.',
    tip: 'Text alongside the video — send links your camera can’t show.',
  },
  {
    id: 'chemistry',
    emoji: '🧬',
    name: 'Chemistry',
    blurb: 'A live meter that climbs the more you two actually interact.',
    tip: 'Watch the live meter climb as you chat, spark and duel.',
  },
  {
    id: 'card',
    emoji: '💌',
    name: 'Connection card',
    blurb: 'After the call: a shareable card with both flags and how long you talked.',
    tip: 'Good calls end with a shareable card — both flags, total time.',
  },
  {
    id: 'milestones',
    emoji: '🏆',
    name: 'Milestones',
    blurb: 'Talk-time trophies at 1, 3, 5 and 10 minutes keep a good call going.',
    tip: 'The clock rewards staying: trophies pop at 1, 3, 5 and 10 minutes.',
  },
  {
    id: 'shortcuts',
    emoji: '⌨️',
    name: 'Shortcuts',
    blurb: 'S / D / C / R drive spark, duel, chat and reactions from the keyboard.',
    tip: 'Power move: press S / D / C / R — spark, duel, chat, react.',
  },
  {
    id: 'private',
    emoji: '🔒',
    name: 'Peer-to-peer',
    blurb: 'Video goes straight to your match — it never touches our servers.',
    tip: 'Your video is peer-to-peer — it never touches our servers.',
  },
];

/**
 * The subset shown as cards in the lobby: the six that best answer "what
 * happens when I press Start". The rest still rotate in on the waiting
 * screen, where the audience has already decided to press it.
 */
export const LOBBY_FEATURES: readonly CallFeature[] = CALL_FEATURES.filter((f) =>
  ['spark', 'duel', 'react', 'chat', 'chemistry', 'card'].includes(f.id),
);

/** Everything with a waiting-screen line, in catalogue order. */
export const WAITING_TIPS: readonly CallFeature[] = CALL_FEATURES.filter((f) => f.tip);

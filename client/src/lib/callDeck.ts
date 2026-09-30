/**
 * The in-call playground's content and rules.
 *
 * Everything here must be **deterministic across both clients**: sparks are
 * referenced by index into this shared deck (never by text over the wire),
 * duel outcomes derive from the two picks both sides observe, and the
 * chemistry score is a pure function of counts both sides have seen (own
 * sends + partner relays = the full room's history). That is what lets the
 * two screens agree without any shared server state.
 */

/** Conversation starters — sent as an index, rendered locally. */
export const SPARKS: readonly string[] = [
  "What's the most useless talent you have?",
  'Rate my hairstyle out of 10 — honest answers only.',
  "What's a song you'd play to describe your week?",
  'If you could wake up anywhere tomorrow, where?',
  "What's the weirdest food you've actually eaten?",
  'Show me the strangest object within arm’s reach.',
  "What's your go-to karaoke song — no judgement.",
  'Who was your first celebrity crush?',
  "What's the last thing that made you laugh out loud?",
  'Describe your day so far in exactly five words.',
  "What's a purchase you'll never regret?",
  'If we met in real life, what would we do first?',
  "What's your hidden talent — demonstrate it!",
  'What scares you more: spiders or public speaking?',
  'What did you want to be when you were eight?',
  "What's the best advice anyone ever gave you?",
  'Pick a superpower: flight or invisibility?',
  "What's on your bucket list this year?",
  'What is your comfort movie?',
  'Sing three seconds of your favourite song.',
  "What's the most embarrassing thing in your camera roll?",
  'Teach me one word in your language.',
  "What's your morning routine, honestly?",
  'If dinner were free anywhere tonight, where?',
  'What personality type are you — and is it accurate?',
  "What's a trend you secretly love?",
  'Show me your best party trick.',
  'What made you press Start today?',
  "What's the funniest name you can invent for me?",
  'Two truths and a lie — I’ll guess.',
  "What's your sleep schedule like — be honest.",
  'If your life had background music right now, what?',
  "What's the coolest place you've ever been?",
  'What skill should I learn first?',
  "What's a small thing that made you smile today?",
  'Swap: recommend me a series, I’ll recommend one.',
  'How would your best friend describe you?',
  "What's the worst haircut you've ever had?",
  'Pick an emoji that matches your mood — explain.',
  'If we start a band, what genre is it?',
  "What's your most irrational fear?",
  'What was your most awkward first impression?',
  'Show me your happiest photo — tell the story.',
  "What's the first app you open on your phone?",
  'Invent a holiday we should all celebrate.',
  'What would your autobiography be called?',
  "What's a food you'd happily eat every day?",
  'Dare: say your name like a game-show host.',
  "What's the closest call you've had this month?",
  'Where were you ten years ago — in one sentence?',
  'If we swap countries for a week, what shocks you first?',
];

/** The reaction palette — must mirror `REACTION_EMOJI` in `matchmaker.js`. */
export const REACTIONS: readonly string[] = ['👋', '😂', '❤️', '🔥', '👏', '😮', '🎉'];

export type DuelPick = 'rock' | 'paper' | 'scissors';

export const DUEL_PICKS: readonly DuelPick[] = ['rock', 'paper', 'scissors'];

export const PICK_EMOJI: Record<DuelPick, string> = {
  rock: '✊',
  paper: '✋',
  scissors: '✌️',
};

/** ✊ beats ✌️, ✌️ beats ✋, ✋ beats ✊ — returns the emoji line both sides show. */
export function duelRound(
  mine: DuelPick,
  theirs: DuelPick,
): { winner: 'me' | 'them' | 'draw'; line: string } {
  if (mine === theirs) {
    return { winner: 'draw', line: `Draw — ${PICK_EMOJI[mine]} vs ${PICK_EMOJI[theirs]}` };
  }
  const beats: Record<DuelPick, DuelPick> = {
    rock: 'scissors',
    scissors: 'paper',
    paper: 'rock',
  };
  const winner = beats[mine] === theirs ? 'me' : 'them';
  const w = winner === 'me' ? mine : theirs;
  const l = winner === 'me' ? theirs : mine;
  return { winner, line: `${PICK_EMOJI[w]} beats ${PICK_EMOJI[l]}` };
}

/**
 * The live **chemistry** meter — identical on both screens by construction
 * (every input is a count of room-wide events). Starts at 50% and grows with
 * real interaction; the caps keep one spammy channel from maxing it out.
 */
export interface ChemCounts {
  chat: number;
  spark: number;
  duel: number;
  react: number;
}

export function chemistry(c: ChemCounts): number {
  return Math.min(
    100,
    50 +
      Math.min(c.chat * 2, 12) +
      Math.min(c.spark * 8, 16) +
      Math.min(c.duel * 6, 18) +
      Math.min(c.react, 6),
  );
}

/** Talk-time milestones — the "stay a little longer" beat. Local by design. */
export const MILESTONES: readonly { at: number; text: string }[] = [
  { at: 60, text: '🏆 One minute in — hello, stranger!' },
  { at: 180, text: '💫 Three minutes together — you two are talking!' },
  { at: 300, text: '🔥 Five minutes! This is becoming a real conversation.' },
  { at: 600, text: '🏅 Ten-minute club — some people never get here.' },
];

/** "3:07" / "47:59" — never resets, never lies about the clock. */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

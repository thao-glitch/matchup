/**
 * Local draft profile — the anonymous fallback for "remember what I typed".
 *
 * Signed-in users get their profile from the account; everyone else still
 * gets their details back after a reload or a Stop matching, instead of an
 * empty form. Purely device-local and never sent anywhere on its own.
 */
import type { Profile } from '../types';

const DRAFT_KEY = 'matchup.draft';

export function loadDraft(): Profile | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    if (
      typeof parsed?.username !== 'string' ||
      typeof parsed?.age !== 'number' ||
      typeof parsed?.country !== 'string'
    ) {
      return null;
    }
    return parsed as Profile;
  } catch {
    return null;
  }
}

export function saveDraft(profile: Profile): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(profile));
  } catch {
    /* storage disabled — the draft is a convenience, not a requirement */
  }
}

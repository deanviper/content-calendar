// Matching posts found live on X or LinkedIn to the drafts written in the calendar, so a draft
// becomes "posted" once it has gone out. Kept apart from the collector so it can be tested offline.

export interface Draft {
  id: string;
  copy: string;
  hashtags: string[] | null;
  scheduledAt: string;
}

export interface Live {
  copy: string;
  publishedAt: string;
}

const DAY = 86_400_000;
// A post can go out up to two weeks before its planned day or a month after it.
const EARLY = 14 * DAY;
const LATE = 30 * DAY;
// How alike the words must be. Small edits before posting still match; a different post doesn't.
const THRESHOLD = 0.75;

// Words only: no links (X shortens them), no #, @ or punctuation, case folded.
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Share of words the two texts have in common (Dice coefficient over word sets).
export function similarity(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

// The draft a live post most likely is, or null. Each draft can match one live post only, so
// callers remove a matched draft from the list before matching the next post.
export function matchDraft<D extends Draft>(live: Live, drafts: D[]): D | null {
  const at = Date.parse(live.publishedAt);
  let best: D | null = null;
  let bestScore = THRESHOLD;
  for (const d of drafts) {
    const planned = Date.parse(d.scheduledAt);
    if (at < planned - EARLY || at > planned + LATE) continue;
    const text = d.hashtags?.length ? `${d.copy} ${d.hashtags.join(" ")}` : d.copy;
    const score = similarity(text, live.copy);
    if (score >= bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

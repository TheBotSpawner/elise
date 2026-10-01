/**
 * Client / Work Intelligence helpers (ADR-016 §15): the pieces of a work brief that must not
 * be invented — commitments are quoted sentences from the evidence, the timeline is derived
 * from source metadata, and the catch-up baseline is said for what it is.
 */

export type CommitmentDirection = "ours" | "theirs" | "waiting";

export interface CommitmentSource {
  kind: "email" | "recall" | "task";
  /** "Proposal v2 · Rod Smith", "Conversation · Sep 28", the task title. */
  label: string;
  date: string | null;
  /** Thread, interaction or task id, to open it. */
  ref: string | null;
  /** Who wrote it: the user ("us"), the other side ("them"), or unknown. */
  author: "us" | "them" | "unknown";
  /** Who the other side is, when known ("Rod Smith"). */
  counterpart: string | null;
}

export interface Commitment {
  /** The sentence itself, quoted (untrusted text). */
  text: string;
  /** ours: we promised · theirs: they asked us (we owe) · waiting: we're waiting on them. */
  direction: CommitmentDirection;
  who: string | null;
  source: Omit<CommitmentSource, "author" | "counterpart">;
}

const OURS =
  /\b(we'?ll|we will|i'?ll|i will|we are going to|i'?m going to|we'?re going to|let me|i can send|voy a|vamos a|te (mando|env[ií]o|paso|confirmo|aviso)|les (mando|env[ií]o|paso|confirmo)|quedamos en|qued[eé] en|me comprometo|nos comprometemos|lo tengo para|se los (mando|paso|env[ií]o)|te lo (mando|paso|env[ií]o))\b/i;
const THEIRS =
  /\b(can you|could you|would you|please (send|share|confirm|review|update|let)|need you to|asked (for|us|me)|podr[ií]as|pod[eé]s (mandar|enviar|pasar|confirmar|revisar)|por favor|necesito que|necesitamos que|nos pidi[oó]|me pidi[oó]|pidi[oó]|pidieron|solicit[oó])\b/i;
const WAITING =
  /\b(waiting (for|on)|still waiting|will get back|they'?ll send|he'?ll send|she'?ll send|to confirm|esperando|pendiente de|qued[oó] en (mandar|enviar|confirmar|pasar)|va a (mandar|enviar|confirmar|pasar)|nos va a|me va a (mandar|enviar|confirmar))\b/i;

const sentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 320);

/**
 * Commitment-like sentences from emails, earlier conversations and tasks, with their source.
 * Patterns, not judgment: each item is evidence to show and to check, never a new task.
 */
export function extractCommitments(
  items: { text: string; source: CommitmentSource }[],
  max = 8,
): Commitment[] {
  const out: Commitment[] = [];
  const seen = new Set<string>();
  for (const { text, source } of items) {
    // Earlier conversations: only the user's own words are commitments, not ELISE's.
    const lines =
      source.kind === "recall"
        ? text
            .split(/\n/)
            .filter((l) => l.startsWith("User:"))
            .map((l) => l.replace(/^User:\s*/, ""))
        : [text];
    for (const line of lines)
      for (const s of sentences(line)) {
        const direction: CommitmentDirection | null = WAITING.test(s)
          ? "waiting"
          : OURS.test(s) && source.author !== "them"
            ? "ours"
            : THEIRS.test(s)
              ? source.author === "us"
                ? null
                : "theirs"
              : OURS.test(s) && source.author === "them"
                ? "waiting"
                : null;
        if (!direction) continue;
        const key = s.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          text: s.slice(0, 240),
          direction,
          who: direction === "ours" ? null : source.counterpart,
          source: { kind: source.kind, label: source.label, date: source.date, ref: source.ref },
        });
        if (out.length >= max) return out;
      }
  }
  return out;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineEntry {
  at: string;
  kind: "meeting" | "email" | "task" | "document" | "interaction" | "record";
  title: string;
  detail: string | null;
  /** True for something still ahead (an upcoming meeting, a task due). */
  upcoming: boolean;
}

/** Newest first, the near future on top; bounded. Derived per request, never stored. */
export function buildTimeline(entries: TimelineEntry[], now: Date, max = 12): TimelineEntry[] {
  const t = now.getTime();
  const upcoming = entries
    .filter((e) => Date.parse(e.at) > t)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 3)
    .map((e) => ({ ...e, upcoming: true }));
  const past = entries
    .filter((e) => Date.parse(e.at) <= t)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((e) => ({ ...e, upcoming: false }));
  const seen = new Set<string>();
  return [...upcoming, ...past]
    .filter((e) => {
      const key = `${e.kind}:${e.title.toLowerCase()}:${e.at.slice(0, 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

// ── Catch-up baseline ("since when?") ────────────────────────────────────────

export type BaselineBasis = "user" | "last_interaction" | "last_meeting" | "default_window";

export interface Baseline {
  /** ISO timestamp the deltas are counted from. */
  since: string;
  basis: BaselineBasis;
}

/**
 * The comparison point for "put me up to date": the user's date, else the last interaction
 * known to belong to the context, else the last related meeting, else a 14-day window — and
 * the basis is always reported, so ELISE never claims a baseline it doesn't have.
 */
export function chooseBaseline(input: {
  explicit: string | null;
  lastInteraction: string | null;
  lastMeeting: string | null;
  now: Date;
  defaultDays?: number;
}): Baseline {
  if (input.explicit) return { since: input.explicit, basis: "user" };
  const recent = (iso: string | null) =>
    iso &&
    Date.parse(iso) < input.now.getTime() &&
    input.now.getTime() - Date.parse(iso) < 120 * 86_400_000;
  if (recent(input.lastInteraction))
    return { since: input.lastInteraction!, basis: "last_interaction" };
  if (recent(input.lastMeeting)) return { since: input.lastMeeting!, basis: "last_meeting" };
  return {
    since: new Date(input.now.getTime() - (input.defaultDays ?? 14) * 86_400_000).toISOString(),
    basis: "default_window",
  };
}

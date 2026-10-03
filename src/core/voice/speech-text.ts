/**
 * What ELISE says aloud (ADR-014 §spoken vs screen): the same answer as on screen, without
 * the parts that only make sense to read — markdown, links, lists of ids, code. The Live
 * Workspace carries the detail; the voice carries the synthesis.
 */
export function toSpeakable(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      // Citation markers [1], [2] belong to the screen.
      .replace(/\s*\[\d+\]/g, "")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/[*_~>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Speech segmenter (ADR-030): turns a streaming answer into units a voice can say naturally.
 * - The first unit goes out at the first sentence end (≥ 24 chars), so audio starts fast.
 * - Later units gather whole sentences until ~90 chars, so short sentences are said together
 *   with continuous intonation instead of one by one.
 * - A sentence longer than ~200 chars is cut at its last clause (a comma) — never inside a word,
 *   a number ("12.5", "23.500"), a time ("14:30") or after an abbreviation ("Dr.", "p. ej.").
 * ":" and ";" don't end a unit. What remains is said when the answer completes.
 */
export class SentenceChunker {
  private buffer = "";
  private units = 0;

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = sentenceEnd(this.buffer, this.units === 0 ? SEGMENT.first : SEGMENT.target);
      if (end < 0) break;
      out.push(...this.take(end));
    }
    while (this.buffer.length > SEGMENT.max) out.push(...this.take(clauseEnd(this.buffer)));
    return out;
  }

  /** The rest, once the answer is complete. */
  flush(): string[] {
    return this.take(this.buffer.length);
  }

  private take(end: number): string[] {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    const text = toSpeakable(raw);
    if (!/[\p{L}\p{N}]/u.test(text)) return [];
    this.units++;
    return [text];
  }
}

export const SEGMENT = {
  /** The first unit: as soon as one short sentence is complete. */
  first: 24,
  /** Later units: whole sentences up to about this size. */
  target: 90,
  /** A single sentence longer than this is cut at a clause. */
  max: 200,
} as const;

/** Words whose period is not a sentence end. */
const ABBREVIATION =
  /(?:^|\s)(?:sr|sra|srta|dr|dra|lic|ing|prof|av|etc|ej|p|vs|aprox|tel|nro|núm|mr|mrs|ms|st|no|approx|e\.g|i\.e)\.$/i;

/** End of the first sentence that brings the text to at least `min` chars, or -1. */
function sentenceEnd(text: string, min: number): number {
  // An end needs whitespace after it, so "12.5" or "23.500" split across deltas is never cut.
  const re = /[.!?…]+(?=\s)|\n{2,}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (end < min) continue;
    if (m[0] === "." && ABBREVIATION.test(text.slice(Math.max(0, end - 8), end))) continue;
    return end;
  }
  return -1;
}

/** Where to cut an over-long run: its last clause boundary, else its last space — never a word. */
function clauseEnd(text: string): number {
  const window = text.slice(0, SEGMENT.max);
  const comma = window.lastIndexOf(", ");
  if (comma >= 40) return comma + 1;
  const space = window.lastIndexOf(" ");
  if (space > 0) return space + 1;
  // One enormous token (a URL): the next space, so it is never split.
  const next = text.indexOf(" ", SEGMENT.max);
  return next > 0 ? next + 1 : text.length;
}

const OPEN = "<spoken>";
const CLOSE = "</spoken>";

/**
 * Separates a voice turn's two expressions of the same answer (ADR-019 §spoken vs display):
 * what ELISE says aloud, wrapped by the model in <spoken>…</spoken>, and what the screen shows
 * (everything else). Works on a stream: a tag split across deltas is held back until it is
 * complete. A reply without tags is display only (the caller falls back to speaking it).
 */
export class SpokenSplitter {
  spoken = "";
  display = "";
  private buffer = "";
  private inside = false;

  push(delta: string): { spoken: string; display: string } {
    this.buffer += delta;
    const out = { spoken: "", display: "" };
    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = this.buffer.indexOf(tag);
      if (at >= 0) {
        this.take(out, this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Hold back a possible start of the tag ("<spo") until the next delta decides it.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, this.buffer.length); n > 0; n--)
        if (tag.startsWith(this.buffer.slice(-n))) {
          keep = n;
          break;
        }
      this.take(out, this.buffer.slice(0, this.buffer.length - keep));
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return out;
    }
  }

  flush(): { spoken: string; display: string } {
    const out = { spoken: "", display: "" };
    this.take(out, this.buffer);
    this.buffer = "";
    return out;
  }

  private take(out: { spoken: string; display: string }, text: string) {
    if (!text) return;
    if (this.inside) {
      out.spoken += text;
      this.spoken += text;
    } else {
      // The display starts at its first real character (no blank lines left by the tag).
      const piece = this.display ? text : text.replace(/^\s+/, "");
      out.display += piece;
      this.display += piece;
    }
  }
}

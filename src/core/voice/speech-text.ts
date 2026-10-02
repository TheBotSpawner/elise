import { VOICE_LIMITS } from "./providers";

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
 * Splits a streaming answer into sentences as they complete, so speech can start after the
 * first sentence instead of the whole answer. Short fragments are merged to keep a natural
 * cadence; over-long sentences are cut at a comma or space.
 */
export class SentenceChunker {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      // A sentence ends only when whitespace follows, so "12.5" split across deltas is never cut.
      const match = /[.!?…:;](?=\s)|\n{2,}/.exec(this.buffer.slice(MIN_SENTENCE));
      if (!match) break;
      const end = MIN_SENTENCE + match.index + match[0].length;
      out.push(...this.emit(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
    if (this.buffer.length > VOICE_LIMITS.maxSpokenChars) {
      const cut = Math.max(
        this.buffer.lastIndexOf(",", VOICE_LIMITS.maxSpokenChars),
        this.buffer.lastIndexOf(" ", VOICE_LIMITS.maxSpokenChars),
      );
      const end = cut > 40 ? cut + 1 : VOICE_LIMITS.maxSpokenChars;
      out.push(...this.emit(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
    return out;
  }

  /** The rest, once the answer is complete. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return this.emit(rest);
  }

  private emit(raw: string): string[] {
    const text = toSpeakable(raw);
    return /[\p{L}\p{N}]/u.test(text) ? [text] : [];
  }
}

/** Sentences shorter than this wait for the next one ("Sí." + "Tenés una reunión…"). */
const MIN_SENTENCE = 12;

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

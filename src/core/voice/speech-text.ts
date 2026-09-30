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

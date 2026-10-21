/**
 * OpenAI's hosted tools can leave citation markers in a model's text: private-use characters
 * around a reference, e.g. "citeturn0search0". They mean nothing to a person
 * and showed up raw in a transcript ("citeturn0search0"). ELISE cites its own sources, so the
 * markers are removed — from streams as they arrive, and from text already stored.
 */
const OPEN = "";
const CLOSE = "";
/** Any leftover private-use marker character (U+E200–U+E2FF). */
const STRAY = /[-]/g;
const MARKER = /[^]{0,200}/g;
/** An unclosed marker longer than this is not one: what was held is let through, cleaned. */
const MAX_HELD = 240;

export function stripCitationMarkers(text: string): string {
  if (!/[-]/.test(text)) return text;
  return text.replace(MARKER, "").replace(STRAY, "");
}

/** Streaming version: a marker split across deltas is held until it closes. */
export class CitationMarkerFilter {
  private held = "";

  push(delta: string): string {
    const text = this.held + delta;
    this.held = "";
    const open = text.lastIndexOf(OPEN);
    if (open >= 0 && text.indexOf(CLOSE, open) < 0 && text.length - open <= MAX_HELD) {
      this.held = text.slice(open);
      return stripCitationMarkers(text.slice(0, open));
    }
    return stripCitationMarkers(text);
  }

  flush(): string {
    const rest = stripCitationMarkers(this.held);
    this.held = "";
    return rest;
  }
}

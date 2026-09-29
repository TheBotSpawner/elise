import type { ChunkDraft, NormalizedDocument } from "./model";

/**
 * Structure-aware chunking (docs/architecture/09 §27-28). Chunks follow headings and pages,
 * pack whole paragraphs up to a target size, split oversized paragraphs at sentence
 * boundaries, and overlap consecutive chunks of the same section so no sentence loses context.
 * Every chunk keeps the heading path and page it came from, for citations.
 */
export const CHUNKING = {
  version: "structure-v1",
  /** ~350 tokens: precise enough to cite, large enough to answer from. */
  targetChars: 1400,
  maxChars: 2000,
  /** Small sections are merged into the next one instead of becoming noise chunks. */
  minChars: 250,
  overlapChars: 200,
} as const;

export type ChunkingConfig = typeof CHUNKING;

const PARAGRAPH = "\n\n";
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function splitSentences(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*(\s+|$)|\n+/g) ?? [text];
  const parts: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      parts.push(current.trim());
      current = "";
    }
    // A single "sentence" longer than max (tables, URLs): hard split.
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max).trim());
      continue;
    }
    current += s;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** The last ~overlap characters of a chunk, starting at a sentence or word boundary. */
function tail(text: string, overlap: number): string {
  if (text.length <= overlap) return text;
  const slice = text.slice(-overlap);
  const sentence = slice.search(/[.!?]\s+\S/);
  if (sentence >= 0) return slice.slice(sentence + 1).trim();
  const space = slice.indexOf(" ");
  return (space >= 0 ? slice.slice(space + 1) : slice).trim();
}

type Meta = { headingPath: string[]; page: number | null };

export function chunkDocument(
  doc: NormalizedDocument,
  config: ChunkingConfig = CHUNKING,
): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let buffer: string[] = [];
  let length = 0;
  // Pieces added since the last flush: a carried overlap alone is never a chunk.
  let fresh = 0;
  let meta: Meta | null = null;

  const flush = (withOverlap: boolean) => {
    if (meta && fresh > 0) {
      const content = buffer.join(PARAGRAPH).trim();
      chunks.push({
        index: chunks.length,
        content,
        headingPath: meta.headingPath,
        page: meta.page,
        tokenCount: estimateTokens(content),
      });
      const carry = withOverlap ? tail(content, config.overlapChars) : "";
      buffer = carry ? [carry] : [];
      length = carry.length;
    } else {
      buffer = [];
      length = 0;
    }
    fresh = 0;
  };

  for (const section of doc.sections) {
    const blocks = section.blocks.map((b) => b.trim()).filter(Boolean);
    if (!blocks.length) continue;
    // A new section closes the previous chunk, unless that one is too small to stand alone.
    if (length >= config.minChars) flush(false);
    if (fresh === 0) {
      // Overlap never crosses a section boundary.
      buffer = [];
      length = 0;
      meta = { headingPath: section.headingPath, page: section.page };
    }

    for (const block of blocks) {
      const pieces =
        block.length > config.maxChars ? splitSentences(block, config.targetChars) : [block];
      for (const piece of pieces) {
        if (fresh > 0 && length + piece.length > config.targetChars) {
          flush(true);
          meta = { headingPath: section.headingPath, page: section.page };
        }
        buffer.push(piece);
        length += piece.length + PARAGRAPH.length;
        fresh++;
      }
    }
  }
  flush(false);
  return chunks;
}

/** Text that is embedded: the passage with its document and section context. */
export function embeddingText(title: string, chunk: Pick<ChunkDraft, "headingPath" | "content">) {
  const context = [title, ...chunk.headingPath].join(" › ");
  return `${context}${PARAGRAPH}${chunk.content}`;
}

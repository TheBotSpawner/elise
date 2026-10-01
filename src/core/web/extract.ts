import { keywordQuery } from "../knowledge/retrieval";

/**
 * Readable text from an HTML page (ADR-015): the article or main content, without navigation,
 * scripts, cookie banners, headers, footers or forms. Deterministic and dependency-free; the
 * result is untrusted data and only ever used as evidence.
 */

export interface ExtractedPage {
  title: string;
  siteName: string | null;
  description: string | null;
  publishedAt: string | null;
  canonicalUrl: string | null;
  text: string;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function meta(html: string, ...names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property|itemprop)=["']${name.replace(":", "\\:")}["'][^>]*>`,
      "i",
    );
    const tag = re.exec(html)?.[0];
    const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content?.trim()) return decodeEntities(content.trim());
  }
  return null;
}

/** Elements that are never content. */
const DROP =
  /<(script|style|noscript|svg|canvas|template|iframe|nav|header|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi;
/** Containers whose class or id says they're chrome, not content. */
const CHROME =
  /<(div|section|ul|p)\b[^>]*(?:class|id)=["'][^"']*\b(cookie|consent|gdpr|banner|newsletter|subscribe|share|social|breadcrumb|menu|navbar|sidebar|footer|header|advert|ads?|promo|related|comments?)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

function toText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(DROP, " ")
      .replace(CHROME, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<\/(p|div|section|article|tr|li|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, "\n")
      .replace(/<h[1-6]\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function largest(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let best: string | null = null;
  for (const m of html.matchAll(re)) if (!best || m[1]!.length > best.length) best = m[1]!;
  return best;
}

export function extractPage(html: string): ExtractedPage {
  const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 20_000);
  const title =
    meta(head, "og:title", "twitter:title") ??
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? "");
  const publishedAt =
    meta(
      head,
      "article:published_time",
      "article:modified_time",
      "og:updated_time",
      "datePublished",
      "dateModified",
      "date",
      "pubdate",
    ) ??
    /"date(?:Published|Modified)"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ??
    null;
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(head)?.[0];
  const body = /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  // Prefer the article, then main content; otherwise the whole body minus its chrome.
  const main = largest(body, "article") ?? largest(body, "main") ?? body;
  let text = toText(main);
  if (text.length < 400 && main !== body) text = toText(body);
  return {
    title: title.replace(/\s+/g, " ").slice(0, 300),
    siteName: meta(head, "og:site_name", "application-name"),
    description: meta(head, "description", "og:description"),
    publishedAt: normalizeDate(publishedAt),
    canonicalUrl: canonical ? (/href=["']([^"']+)["']/i.exec(canonical)?.[1] ?? null) : null,
    text,
  };
}

/** A date the page states, as ISO; anything unparseable is dropped (never guessed). */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 1995 && year <= 2100 ? new Date(t).toISOString() : null;
}

/**
 * The passages of a page that bear on the question — not the whole page. Paragraphs are
 * scored by how many of the question's words they contain; the page's opening stands in
 * when nothing matches (it usually states what the page is).
 */
export function selectPassages(
  text: string,
  focus: string | null,
  max: number,
  chars: number,
): string[] {
  const paragraphs = text
    .split(/\n{1,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40);
  if (!paragraphs.length) return text ? [text.slice(0, chars)] : [];
  const terms = focus
    ? keywordQuery(focus)
        .split(/\s*\|\s*/)
        .map((t) => t.replace(/[:*()&!]/g, "").toLowerCase())
        .filter((t) => t.length >= 3)
    : [];
  const scored = paragraphs.map((p, i) => {
    const lower = p.toLowerCase();
    const hits = terms.filter((t) => lower.includes(t)).length;
    return { p, i, score: hits * 10 - i * 0.01 };
  });
  const picked =
    terms.length && scored.some((s) => s.score > 0)
      ? scored
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, max)
          .sort((a, b) => a.i - b.i)
      : scored.slice(0, max);
  return picked.map(({ p }) => (p.length > chars ? `${p.slice(0, chars - 1)}…` : p));
}

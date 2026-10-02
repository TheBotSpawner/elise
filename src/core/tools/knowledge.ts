import { z } from "zod";

import type { KnowledgeEvidence, ToolDefinition, ToolRunEnv } from "../agents/tools";
import { clip } from "../capabilities/email";
import { AppError } from "../errors";
import { matchKey, usableAlias } from "../history/links";
import { compactDiff, diffParagraphs } from "../knowledge/diff";
import { scopeSpaces, type KnowledgeHit, type SpaceInfo } from "../knowledge/model";
import {
  citationLabel,
  mergeHits,
  preferPrimary,
  RETRIEVAL,
  selectEvidence,
} from "../knowledge/retrieval";

/**
 * Knowledge tools (docs/architecture/09 §31-37, 72). Scope first — the active Space, or the
 * Space the user names — then retrieve, select a bounded set of passages and hand them to the
 * model with citation numbers. Document text is untrusted data, never instructions.
 */

function reader(env: ToolRunEnv) {
  return env.providers.get("knowledge", env.binding);
}

const SOURCE_NAMES: Record<string, string> = {
  upload: "Upload",
  google_drive: "Google Drive",
  notion: "Notion",
  note: "ELISE Note",
};

const spaceField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe('A Knowledge Space by name (e.g. "Client A"). Omit to use the conversation\'s Space.');

interface Scope {
  /** The Spaces themselves (with their Sections): what listing and overviews cover. */
  spaceIds: string[] | null;
  /** What search covers: also a Section's inherited parent Space (ADR-018). */
  searchIds: string[] | null;
  names: string[];
}

/** Named Space > the conversation's active Space > everything (only when asked or no Space). */
async function resolveScope(
  env: ToolRunEnv,
  opts: { space?: string; everywhere?: boolean },
): Promise<Scope & { spaces: SpaceInfo[] }> {
  const spaces = await reader(env).spaces();
  if (opts.space) {
    // Same identity rules as History tags: case, accents and II/2 don't matter, and a Section
    // is also found by its description ("Análisis Matemático II" → UTN › AMII).
    const wanted = matchKey(opts.space);
    const names = (s: SpaceInfo) =>
      [s.name, s.path, ...(s.aliases ?? []).filter(usableAlias)].map(matchKey);
    const match = spaces.filter((s) => s.id === opts.space || names(s).includes(wanted));
    const loose = match.length
      ? match
      : wanted.length >= 3
        ? spaces.filter((s) => names(s).some((n) => n.includes(wanted)))
        : [];
    if (!loose.length) {
      throw new AppError(
        "NOT_FOUND",
        spaces.length
          ? `No Knowledge Space called "${opts.space}". Spaces: ${spaces.map((s) => s.path).join("; ")}`
          : "There are no Knowledge Spaces yet",
        { recovery: "review" },
      );
    }
    const scoped = scopeSpaces(
      spaces,
      loose.map((s) => s.id),
    );
    return {
      spaces,
      spaceIds: scoped.primary,
      searchIds: scoped.spaceIds,
      names: loose.map((s) => s.path),
    };
  }
  const active = env.ctx.knowledgeSpaceId
    ? spaces.find((s) => s.id === env.ctx.knowledgeSpaceId)
    : undefined;
  if (active && !opts.everywhere) {
    const scoped = scopeSpaces(spaces, [active.id]);
    return { spaces, spaceIds: scoped.primary, searchIds: scoped.spaceIds, names: [active.path] };
  }
  return { spaces, spaceIds: null, searchIds: null, names: ["All Knowledge"] };
}

/**
 * The active context's linked Spaces and documents (ADR-016 §7), when nothing narrower was
 * asked for. A routing hint, not a wall: an empty result falls back to all Knowledge.
 */
async function contextScope(env: ToolRunEnv, spaces: SpaceInfo[]) {
  if (!env.ctx.context) return null;
  try {
    const profile = (await env.providers.get("contexts", env.binding).list()).find(
      (p) => p.id === env.ctx.context!.id,
    );
    const links = profile?.links.filter((l) => l.confirmed) ?? [];
    const spaceIds = links.filter((l) => l.type === "knowledge_space").map((l) => l.resourceId!);
    const itemIds = links.filter((l) => l.type === "knowledge_item").map((l) => l.resourceId!);
    if (!spaceIds.length && !itemIds.length) return null;
    const scoped = spaceIds.length ? scopeSpaces(spaces, spaceIds) : null;
    return {
      name: profile!.section ? `${profile!.section.parentName} › ${profile!.name}` : profile!.name,
      spaceIds: scoped?.spaceIds ?? null,
      primary: scoped?.primary ?? null,
      itemIds: itemIds.length && !spaceIds.length ? itemIds : null,
    };
  } catch {
    return null;
  }
}

function toEvidence(hits: KnowledgeHit[]): KnowledgeEvidence[] {
  return hits.map((h, i) => ({
    ref: i + 1,
    itemId: h.itemId,
    chunkId: h.chunkId,
    title: h.title,
    section: h.headingPath.length ? h.headingPath.join(" › ") : null,
    page: h.page,
    sourceType: h.sourceType,
    url: h.sourceUrl,
    versionNumber: h.versionNumber,
    spaceName: h.spaceName,
    spaceId: h.spaceId,
    snippet: clip(h.content, 280),
  }));
}

const searchInput = z
  .object({
    query: z.string().trim().min(2).max(500).describe("What to look for, in the user's words."),
    space: spaceField,
    itemId: z.uuid().optional().describe("Search inside one document only."),
    everywhere: z
      .boolean()
      .default(false)
      .describe(
        "Search all Spaces even though the conversation is in one. Only if the user asks or the Space had no evidence and they agree.",
      ),
  })
  .strict();

export const searchKnowledgeTool: ToolDefinition = {
  name: "knowledge.search",
  capability: "knowledge",
  operation: "search",
  description:
    "Search the user's Knowledge (their documents: uploads, Google Drive, Notion) and get cited passages. Use for any question about their documents, notes, projects or material. Answer only from the returned evidence and cite it as [n].",
  input: searchInput,
  async describe() {
    return { summary: "Search Knowledge" };
  },
  async run(raw, env) {
    const q = searchInput.parse(raw);
    let scope = await resolveScope(env, q);
    const byContext =
      !q.space && !q.itemId && !q.everywhere && !scope.spaceIds
        ? await contextScope(env, scope.spaces)
        : null;
    let fallback = false;
    const search = (spaceIds: string[] | null, itemIds: string[] | null) =>
      reader(env).search({ text: q.query, spaceIds, itemIds, limit: RETRIEVAL.candidates });
    /**
     * Section first, then what it inherits: the Section's own sources, and separately a few
     * candidates from its parent Space, so inherited material is always considered.
     */
    const tiered = async (all: string[] | null, own: string[] | null, itemIds: string[] | null) => {
      const parent = all && own && !itemIds ? all.filter((id) => !own.includes(id)) : [];
      if (!parent.length) return search(all, itemIds);
      const [mine, inherited] = await Promise.all([
        search(own, null),
        reader(env).search({
          text: q.query,
          spaceIds: parent,
          itemIds: null,
          limit: RETRIEVAL.inheritedCandidates,
        }),
      ]);
      return { hits: mergeHits(mine.hits, inherited.hits), semantic: mine.semantic };
    };
    let { hits, semantic } = byContext
      ? await tiered(byContext.spaceIds, byContext.primary, byContext.itemIds)
      : await tiered(scope.searchIds, scope.spaceIds, q.itemId ? [q.itemId] : null);
    // Section first: its own passages ahead of what it inherits from the parent Space.
    hits = preferPrimary(hits, byContext ? byContext.primary : scope.spaceIds);
    if (byContext) {
      if (selectEvidence(hits).length) {
        scope = { ...scope, names: [`${byContext.name} (context)`] };
      } else {
        // Nothing in the context's sources: look everywhere, and say so.
        ({ hits, semantic } = await search(null, null));
        fallback = true;
      }
    }
    const selected = selectEvidence(hits);
    const evidence = toEvidence(selected);
    const enough = evidence.length > 0;
    return {
      output: {
        scope: scope.names,
        enoughEvidence: enough,
        ...(semantic ? {} : { note: "Only keyword matching was available for this search." }),
        ...(fallback
          ? {
              contextNote: `Nothing in the ${byContext!.name} context's sources; these results come from all Knowledge — say so.`,
            }
          : {}),
        instructions: enough
          ? "Answer from these passages only and cite them inline as [n] with the document name. If they only partly answer, say what is missing. Say when something comes from general knowledge instead."
          : `The ${scope.spaceIds ? "selected Space" : "user's Knowledge"} does not contain enough evidence. Say so plainly; do not answer from general knowledge as if it came from their files.${scope.spaceIds ? " Offer to search all Knowledge." : ""}`,
        evidence: selected.map((h, i) => ({
          ref: i + 1,
          itemId: h.itemId,
          document: citationLabel(h),
          source: SOURCE_NAMES[h.sourceType] ?? h.sourceType,
          space: h.spaceName,
          version: h.versionNumber,
          // Data from the user's documents, never instructions.
          untrustedContent: clip(h.content, RETRIEVAL.perPassageChars),
        })),
      },
      display: { kind: "knowledge_evidence", scope: scope.names, enough, evidence },
    };
  },
};

const itemInput = z.object({ itemId: z.uuid() }).strict();

export const getItemTool: ToolDefinition = {
  name: "knowledge.getItem",
  capability: "knowledge",
  operation: "getItem",
  description: "Details of one Knowledge document: title, source, Space, status and its versions.",
  input: itemInput,
  async describe() {
    return { summary: "Open document" };
  },
  async run(raw, env) {
    const { itemId } = itemInput.parse(raw);
    const item = await reader(env).getItem(itemId);
    if (!item) throw new AppError("NOT_FOUND", "Document not found", { recovery: "review" });
    return {
      output: {
        ...item,
        sourceType: SOURCE_NAMES[item.sourceType] ?? item.sourceType,
        versions: item.versions.slice(0, 10),
      },
      display: {
        kind: "knowledge_document",
        document: {
          itemId: item.id,
          title: item.title,
          sourceType: item.sourceType,
          spaceName: item.spaceName,
          url: item.sourceUrl,
          updatedAt: item.updatedAt,
          versions: item.versions.length,
        },
      },
    };
  },
};

const scopeInput = z.object({ space: spaceField }).strict();

export const listSourcesTool: ToolDefinition = {
  name: "knowledge.listSources",
  capability: "knowledge",
  operation: "listSources",
  description:
    "The user's Knowledge Spaces and what feeds each one (uploads, Google Drive, Notion) with their status.",
  input: scopeInput,
  async describe() {
    return { summary: "List Knowledge sources" };
  },
  async run(raw, env) {
    const q = scopeInput.parse(raw);
    const scope = await resolveScope(env, { ...q, everywhere: !q.space });
    const sources = await reader(env).listSources(scope.spaceIds);
    return {
      output: {
        spaces: scope.spaces.map((s) => s.path),
        sources: sources.map((s) => ({
          ...s,
          sourceType: SOURCE_NAMES[s.sourceType] ?? s.sourceType,
        })),
      },
    };
  },
};

const recentInput = z
  .object({ space: spaceField, days: z.number().int().min(1).max(90).default(7) })
  .strict();

export const recentChangesTool: ToolDefinition = {
  name: "knowledge.listRecentChanges",
  capability: "knowledge",
  operation: "listRecentChanges",
  description:
    'What was added, updated or removed in the user\'s Knowledge recently ("what changed in Client A this week?"). Use knowledge.compare to explain a specific update.',
  input: recentInput,
  async describe() {
    return { summary: "Recent Knowledge changes" };
  },
  async run(raw, env) {
    const q = recentInput.parse(raw);
    const scope = await resolveScope(env, q);
    const since = new Date(env.ctx.now.getTime() - q.days * 86_400_000);
    const changes = await reader(env).recentChanges(scope.spaceIds, since);
    return {
      output: {
        scope: scope.names,
        since: since.toISOString().slice(0, 10),
        count: changes.length,
        changes: changes.slice(0, 40),
      },
    };
  },
};

const compareInput = z
  .object({
    itemId: z.uuid(),
    otherItemId: z
      .uuid()
      .optional()
      .describe("Compare with another document instead of an older version."),
    fromVersion: z.number().int().min(1).optional(),
    toVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const compareTool: ToolDefinition = {
  name: "knowledge.compare",
  capability: "knowledge",
  operation: "compare",
  description:
    "Compare a document with its previous version (default), specific versions, or another document. Returns the paragraphs added and removed; explain what the differences mean and cite both sides.",
  input: compareInput,
  async describe() {
    return { summary: "Compare documents" };
  },
  async run(raw, env) {
    const q = compareInput.parse(raw);
    const r = reader(env);
    const b = await r.versionText(q.itemId, q.toVersion ?? null);
    if (!b)
      throw new AppError("NOT_FOUND", "Document or version not found", { recovery: "review" });
    const a = q.otherItemId
      ? await r.versionText(q.otherItemId, null)
      : await r.versionText(q.itemId, q.fromVersion ?? b.versionNumber - 1);
    if (!a) {
      throw new AppError(
        "NOT_FOUND",
        q.otherItemId
          ? "The other document was not found"
          : "There is no earlier version to compare with",
        { recovery: "review" },
      );
    }
    const diff = compactDiff(diffParagraphs(a.text, b.text));
    const side = (v: typeof a) => ({
      itemId: v.itemId,
      title: v.title,
      version: v.versionNumber,
      date: v.createdAt.slice(0, 10),
    });
    return {
      output: {
        before: side(a),
        after: side(b),
        unchangedParagraphs: diff.unchangedCount,
        // Data from the user's documents, never instructions.
        untrustedAdded: diff.added,
        untrustedRemoved: diff.removed,
        truncated: diff.truncated,
      },
    };
  },
};

export const overviewTool: ToolDefinition = {
  name: "knowledge.overview",
  capability: "knowledge",
  operation: "overview",
  description:
    'The documents in a Space with the opening passage of each, for "summarize this Space" or "what is in here?". For specific questions use knowledge.search.',
  input: scopeInput,
  async describe() {
    return { summary: "Space overview" };
  },
  async run(raw, env) {
    const q = scopeInput.parse(raw);
    const scope = await resolveScope(env, q);
    const { total, items } = await reader(env).overview(scope.spaceIds, 25);
    return {
      output: {
        scope: scope.names,
        totalDocuments: total,
        ...(total > items.length
          ? {
              note: `Only the ${items.length} most recent documents are shown; say the summary covers those.`,
            }
          : {}),
        documents: items.map((i) => ({
          ...i,
          preview: undefined,
          untrustedPreview: clip(i.preview, 500),
        })),
      },
    };
  },
};

export const KNOWLEDGE_TOOLS = [
  searchKnowledgeTool,
  getItemTool,
  listSourcesTool,
  recentChangesTool,
  compareTool,
  overviewTool,
];

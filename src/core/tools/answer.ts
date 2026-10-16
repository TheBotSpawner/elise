import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { knownSources } from "./visualize";
import { surfaceId, type Surface, type SurfaceSize, type WorkspaceState } from "../workspace/model";
import {
  ANSWER_INTENTS,
  draftDefaults,
  PAYLOADS,
  type SurfacePayloads,
} from "../workspace/registry";

/**
 * ui.answer (ADR-071): answer first, source second. Retrieval says where information came from;
 * this says what the user needs to see — the competitors, the ranking, the comparison, the key
 * figures — synthesized by the model in the SAME response as its words (no extra model call),
 * rendered by ELISE from a bounded vocabulary. Every item keeps its sources, and the evidence
 * Surfaces it was built from step back behind a "Sources · N" affordance.
 */

/** Evidence Surfaces an answer replaces on the Canvas (it keeps them as provenance). */
const EVIDENCE: ReadonlySet<string> = new Set([
  "knowledge_result",
  "knowledge_source",
  "web_results",
  "web_source",
  "web_research",
  "recall",
]);

const sourceList = z
  .array(z.string().trim().min(1).max(2000))
  .min(1)
  .max(6)
  .describe(
    'Where it comes from: a Knowledge citation "[2]", a Surface handle "S3", or a URL from your results.',
  );

const item = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe("One short line: why it matters, not the whole explanation you say aloud."),
    badge: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        'The source\'s own category for it ("Competidor directo", "Referente", "Alta"). Keep the distinctions the evidence makes; never flatten them.',
      ),
    group: z.string().trim().max(80).optional().describe("A heading to group items under."),
    value: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe('A figure exactly as the source gives it ("31 pts", "$12.400"). Never invented.'),
    rank: z.number().int().min(1).max(500).optional(),
    cells: z
      .record(z.string().max(40), z.string().trim().max(120))
      .optional()
      .describe("Comparison: this option's value per column key."),
    sources: sourceList,
  })
  .strict();

const answerInput = z
  .object({
    intent: z
      .enum(ANSWER_INTENTS)
      .describe(
        "The shape of the answer: entities (competitors, people, tools, clients), list, ranking (top N, ordered), comparison (options × criteria), metrics (a few key figures), checklist (steps to take), summary (grouped key points).",
      ),
    title: z.string().trim().min(1).max(120).describe('What it is: "Mapa competitivo · Firbot".'),
    summary: z
      .string()
      .trim()
      .max(400)
      .optional()
      .describe("At most one sentence of context; the items carry the answer."),
    items: z.array(item).max(50).optional(),
    columns: z
      .array(z.object({ key: z.string().trim().min(1).max(40), label: z.string().trim().max(60) }))
      .max(6)
      .optional()
      .describe("Comparison only: the criteria (2–6)."),
    metrics: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(60),
            value: z.string().trim().min(1).max(40),
            secondary: z.string().trim().max(80).optional(),
            sources: sourceList,
          })
          .strict(),
      )
      .max(8)
      .optional(),
    total: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .describe("How many exist in all, when you show only the most relevant ones."),
    keepSources: z
      .boolean()
      .default(false)
      .describe(
        'Keep the source documents on screen beside the answer ("¿qué dice este documento?" → its summary next to the document).',
      ),
  })
  .strict();

type AnswerSource = SurfacePayloads["answer"]["sources"][number];

interface Resolved {
  key: string;
  source: AnswerSource;
  /** The evidence Surface it came from (to step back behind the answer). */
  surfaceId: string | null;
}

const kindOf = (type: string): AnswerSource["kind"] =>
  type.startsWith("knowledge")
    ? "knowledge"
    : type.startsWith("web")
      ? "web"
      : type === "recall"
        ? "recall"
        : "other";

/** A source the model names → what ELISE holds on screen, or null (never a made-up source). */
export function resolveAnswerSource(state: WorkspaceState, raw: string): Resolved | null {
  const s = raw.trim();
  const cited = /^\[?(\d{1,2})\]?$/.exec(s);
  if (cited) {
    const ref = Number(cited[1]);
    // ponytail: refs are per search; the newest Knowledge Surface wins when two searches overlap.
    const docs = state.surfaces
      .filter((x) => x.type === "knowledge_result" || x.type === "knowledge_source")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const sf of docs) {
      const list =
        sf.type === "knowledge_result"
          ? (sf.payload as SurfacePayloads["knowledge_result"]).sources
          : [sf.payload as SurfacePayloads["knowledge_source"]];
      for (const d of list)
        if (d.passages.some((p) => p.ref === ref))
          return {
            key: `knowledge:${d.itemId}`,
            source: {
              title: d.title,
              url: `/knowledge/items/${d.itemId}`,
              kind: "knowledge",
              space: d.spaceName,
            },
            surfaceId: sf.id,
          };
    }
    return null;
  }
  const surface = state.surfaces.find((x) => x.handle.toLowerCase() === s.toLowerCase());
  if (surface) {
    const itemId = (surface.payload as { itemId?: unknown }).itemId;
    return {
      key: `surface:${surface.id}`,
      source: {
        title: surface.title || surface.handle,
        url: typeof itemId === "string" ? `/knowledge/items/${itemId}` : null,
        kind: kindOf(surface.type),
        ...(surface.source?.label ? { space: surface.source.label.slice(0, 200) } : {}),
      },
      surfaceId: surface.id,
    };
  }
  if (/^https:\/\//.test(s)) {
    const title = knownSources(state).get(s);
    if (!title) return null;
    const holder = state.surfaces.find((x) =>
      JSON.stringify(x.payload).includes(JSON.stringify(s)),
    );
    return {
      key: `url:${s}`,
      source: { title, url: s, kind: holder ? kindOf(holder.type) : "web" },
      surfaceId: holder?.id ?? null,
    };
  }
  return null;
}

const DIGIT = /\d/;

/** How much room the answer gets: compact unless its shape needs width. */
function sizeFor(payload: SurfacePayloads["answer"]): SurfaceSize {
  if (payload.intent === "comparison") return "large";
  if (payload.intent === "metrics" && !payload.items.length) return "small";
  return payload.items.length > 8 ? "large" : "medium";
}

function port(env: ToolRunEnv) {
  if (!env.ctx.workspace)
    throw new AppError("VALIDATION_ERROR", "There is no Live Workspace in this context", {
      recovery: "review",
    });
  return env.ctx.workspace;
}

const invalid = (message: string) =>
  new AppError("VALIDATION_ERROR", message, { recovery: "review" });

/** The answer Surface for a request; the model's input is validated and grounded here. */
export function buildAnswer(state: WorkspaceState, raw: unknown) {
  const q = answerInput.parse(raw);
  const items = q.items ?? [];
  const metrics = q.metrics ?? [];
  if (!items.length && !metrics.length) throw invalid("An answer needs items or metrics.");
  if (q.intent === "comparison") {
    if (!q.columns || q.columns.length < 2)
      throw invalid("A comparison needs 2–6 columns (the criteria).");
    const keys = new Set(q.columns.map((c) => c.key));
    if (items.some((i) => !i.cells || Object.keys(i.cells).some((k) => !keys.has(k))))
      throw invalid("Each compared option needs cells keyed by the columns.");
  }
  const sources: Resolved[] = [];
  const unknown: string[] = [];
  const indexes = (refs: readonly string[]) =>
    refs.flatMap((r) => {
      const found = resolveAnswerSource(state, r);
      if (!found) {
        unknown.push(r);
        return [];
      }
      let at = sources.findIndex((s) => s.key === found.key);
      if (at < 0 && sources.length < 12) at = sources.push(found) - 1;
      return at < 0 ? [] : [at];
    });
  const payload = PAYLOADS.answer.parse({
    intent: q.intent,
    ...(q.summary ? { summary: q.summary } : {}),
    items: items.map((i, n) => ({
      title: i.title,
      ...(i.description ? { description: i.description } : {}),
      ...(i.badge ? { badge: i.badge } : {}),
      ...(i.group ? { group: i.group } : {}),
      ...(i.value ? { value: i.value } : {}),
      ...(q.intent === "ranking" ? { rank: i.rank ?? n + 1 } : i.rank ? { rank: i.rank } : {}),
      ...(i.cells ? { cells: i.cells } : {}),
      sources: [...new Set(indexes(i.sources))],
    })),
    ...(q.columns ? { columns: q.columns } : {}),
    ...(metrics.length
      ? {
          metrics: metrics.map((m) => ({
            label: m.label,
            value: m.value,
            ...(m.secondary ? { secondary: m.secondary } : {}),
            sources: [...new Set(indexes(m.sources))],
          })),
        }
      : {}),
    sources: sources.map((s) => s.source),
    ...(q.total !== undefined ? { total: q.total } : {}),
  });
  if (unknown.length)
    throw invalid(
      `Unknown sources: ${[...new Set(unknown)].slice(0, 5).join(", ")}. Cite only [n] from your Knowledge results, a visible Surface handle, or a URL from your results.`,
    );
  // ponytail: provenance by citation — Surfaces keep only excerpts, so a figure can't be matched
  // against the full passage the model read. Every figure must at least name a resolved source.
  const unsourced = [
    ...payload.items
      .filter(
        (i) =>
          (DIGIT.test(i.value ?? "") || Object.values(i.cells ?? {}).some((c) => DIGIT.test(c))) &&
          !i.sources.length,
      )
      .map((i) => i.title),
    ...(payload.metrics ?? []).filter((m) => !m.sources.length).map((m) => m.label),
  ];
  if (unsourced.length)
    throw invalid(
      `Figures need the source they come from: ${unsourced.slice(0, 5).join(", ")}. Leave out any figure the evidence doesn't give.`,
    );
  const replaced = q.keepSources
    ? []
    : [
        ...new Set(
          sources
            .map((s) => s.surfaceId)
            .filter(
              (id): id is string =>
                id !== null && EVIDENCE.has(state.surfaces.find((x) => x.id === id)?.type ?? ""),
            ),
        ),
      ];
  return { q, payload, replaced };
}

export const answerTool: ToolDefinition = {
  name: "ui.answer",
  capability: "workspace",
  operation: "answer",
  description:
    'Show the ANSWER on the Live Canvas — not the documents it came from: the competitors, the top 10, the options compared, the key figures, the steps. You synthesize the items from your evidence, each with its sources; ELISE renders them and keeps the sources one tap away ("Fuentes · N"), replacing the evidence on screen. Call it in the same response as your answer. Not for one fact, for emails/events/tasks/finance (already shown as themselves), for dated schedules (ui.timeline) or charts (ui.visualize), or when the user asked for the document itself.',
  input: answerInput,
  async describe(raw) {
    const q = answerInput.safeParse(raw);
    return { summary: q.success ? `Show answer: ${q.data.title}` : "Show answer" };
  },
  async run(raw, env) {
    const w = port(env);
    const state = w.state();
    const { q, payload, replaced } = buildAnswer(state, raw);
    const at = env.ctx.now.toISOString();
    const intentKey = state.intent?.id ?? "none";
    const id = surfaceId("answer", `${intentKey}:${q.title.toLowerCase()}`);
    w.apply([
      ...replaced.map((r) => ({ op: "dismiss" as const, id: r, at })),
      {
        op: "present",
        at,
        surface: {
          id,
          type: "answer",
          title: q.title,
          state: "ready",
          source: {
            capability: "workspace",
            label:
              [...new Set(payload.sources.map((s) => s.space ?? s.title))]
                .join(" · ")
                .slice(0, 200) || null,
          },
          ref: null,
          payload,
          intentId: state.intent?.id ?? null,
          ...draftDefaults("answer", payload),
          size: sizeFor(payload),
        },
      },
      { op: "focus", id, item: null, at },
    ]);
    const shown = w.state().surfaces.find((s: Surface) => s.id === id);
    return {
      output: {
        shown: q.intent,
        handle: shown?.handle,
        items: payload.items.length,
        sources: payload.sources.length,
        ...(replaced.length ? { evidenceBehindAnswer: replaced.length } : {}),
        instructions:
          "The answer is on screen with its sources. In words give the insight (the key distinction, what matters most) in a few sentences — never read the list item by item.",
      },
    };
  },
};

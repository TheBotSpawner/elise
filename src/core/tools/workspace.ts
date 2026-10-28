import { z } from "zod";

import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import { AppError } from "../errors";
import { toLocalDateTime } from "../time";
import { answerTool } from "./answer";
import { timelineTool, visualizeTool } from "./visualize";
import {
  CALENDAR_VIEWS,
  calendarsOf,
  changeCalendar,
  nextSeq,
  visibleEvents,
  type CalendarPayload,
  type CalendarView,
} from "../workspace/calendar";
import { surfacesFromOutcome } from "../workspace/from-results";
import {
  activeCollection,
  datasetKey,
  lastAffected,
  memberIds,
  queryKey,
  representTasks,
} from "../workspace/lifecycle";
import { isImageUrl, MEDIA_KINDS, mediaPayload, videoEmbed } from "../workspace/media";
import { SURFACE_SIZES, surfaceId, type Surface, type WorkspaceState } from "../workspace/model";
import type { WorkspacePort } from "../workspace/port";
import {
  describeWorkspace,
  draftDefaults,
  PAYLOADS,
  surfaceDefinition,
  type SurfacePayloads,
} from "../workspace/registry";
import { SUMMARY_ICONS, type SummaryIcon } from "../workspace/summary-icons";
import { visualizationSpec } from "../workspace/visualization";

/**
 * Presentation tools (ADR-013). ELISE decides what deserves attention; the application owns
 * rendering, layout and lifecycle. No tool accepts markup, styles or components, and results
 * ELISE fetched are already presented — these only focus, dismiss, resize, clear, or add a
 * structured summary / links that already appear in the workspace's own sources.
 */

function port(env: ToolRunEnv): WorkspacePort {
  if (!env.ctx.workspace)
    throw new AppError("VALIDATION_ERROR", "There is no Live Workspace in this context", {
      recovery: "review",
    });
  return env.ctx.workspace;
}

function find(state: WorkspaceState, ref: string): Surface {
  const r = ref.trim().toLowerCase();
  const s = state.surfaces.find((x) => x.handle.toLowerCase() === r || x.id === ref);
  if (!s)
    throw new AppError(
      "NOT_FOUND",
      `No visible Surface "${ref}". Visible: ${state.surfaces.map((x) => x.handle).join(", ") || "none"}.`,
      { recovery: "review" },
    );
  return s;
}

const now = (env: ToolRunEnv) => env.ctx.now.toISOString();
const surfaceRef = z.string().trim().min(1).max(120).describe('A Surface handle, e.g. "S2".');

const digest = (env: ToolRunEnv) => ({
  surfaces: describeWorkspace(port(env).state(), env.ctx.timezone) ?? "The workspace is empty.",
});

export const listSurfacesTool: ToolDefinition = {
  name: "ui.listSurfaces",
  capability: "workspace",
  operation: "listSurfaces",
  description: "What the Live Workspace shows right now (handles, titles, item ids).",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Read workspace" };
  },
  async run(_raw, env) {
    return { output: digest(env) };
  },
};

/**
 * What the model writes is normalized here, never rejected for its shape: a card that fails
 * validation is a card the person never sees (the model rarely retries). A number where text goes,
 * {name, amount} for an ingredient, a step as an object, an icon name not in the set, a line too
 * long — all become the card's own format. Only provenance (links, photos) is strict, and an
 * unknown one is dropped, not the whole card.
 */
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
const words = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? String(v)
    : v && typeof v === "object"
      ? Object.values(v as Record<string, unknown>)
          .filter((x) => typeof x === "string" || typeof x === "number")
          .join(" ")
      : "";
const line = (max: number) =>
  z
    .union([z.string(), z.number(), z.record(z.string(), z.unknown())])
    .transform((v) => clip(words(v).replace(/\s+/g, " ").trim(), max));
const icon = z
  .string()
  .optional()
  .transform((v) =>
    v && (SUMMARY_ICONS as readonly string[]).includes(v) ? (v as SummaryIcon) : undefined,
  );
const lines = (max: number, most: number) =>
  z.array(line(max)).transform((a) => a.filter(Boolean).slice(0, most));
const credit = z
  .object({ label: line(80).optional(), url: z.string().max(2000) })
  .transform((c) => ({ label: c.label || c.url, url: c.url }));

const section = PAYLOADS.summary.shape.sections.element.extend({
  heading: line(120),
  items: lines(600, 8).pipe(z.array(z.string()).min(1)),
  icons: z
    .array(z.string())
    .optional()
    .transform((a) =>
      a
        ?.slice(0, 8)
        .map((v) =>
          (SUMMARY_ICONS as readonly string[]).includes(v) ? (v as SummaryIcon) : "info",
        ),
    ),
});

/** A step written as text, or as {title, text|detail|description}. */
const stepText = z
  .union([z.string(), z.number(), z.record(z.string(), z.unknown())])
  .transform((v) => {
    if (typeof v !== "object") return String(v);
    const o = v as Record<string, unknown>;
    const title = words(o.title ?? o.step ?? o.name ?? "");
    const detail = words(o.text ?? o.detail ?? o.description ?? o.instructions ?? "");
    return [title, detail].filter(Boolean).join(title && detail ? ": " : "");
  });

const recipeInput = z.object({
  prep: line(24).optional(),
  cook: line(24).optional(),
  total: line(24).optional(),
  servings: line(32).optional(),
  difficulty: line(32).optional(),
  ingredients: lines(120, 20).pipe(z.array(z.string()).min(1)),
  steps: z
    .array(stepText)
    .transform((a) =>
      a
        .map((x) => clip(x.trim(), 300))
        .filter(Boolean)
        .slice(0, 12),
    )
    .pipe(z.array(z.string()).min(1)),
  tip: line(240).optional(),
  image: z
    .object({ url: z.string().max(2000), alt: line(160).optional(), credit: z.string().nullish() })
    .optional(),
  source: credit.optional(),
});

const guideInput = z.object({
  icon,
  duration: line(32).optional(),
  difficulty: line(32).optional(),
  materials: z
    .array(
      z.union([
        z.string(),
        z.object({
          label: z.string().optional(),
          name: z.string().optional(),
          icon: z.string().optional(),
        }),
      ]),
    )
    .optional()
    .transform((a) =>
      a
        ?.map((m) =>
          typeof m === "string"
            ? clip(m, 100)
            : {
                label: clip(m.label ?? m.name ?? "", 100),
                icon: (SUMMARY_ICONS as readonly string[]).includes(m.icon ?? "")
                  ? (m.icon as SummaryIcon)
                  : undefined,
              },
        )
        .filter((m) => (typeof m === "string" ? m : m.label))
        .slice(0, 15),
    ),
  steps: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .transform((a) =>
      a
        .map((v) => {
          if (typeof v === "string") return { title: clip(v, 80) };
          const title = words(v.title ?? v.step ?? v.name ?? "");
          const text = words(v.text ?? v.detail ?? v.description ?? "");
          return title
            ? { title: clip(title, 80), ...(text ? { text: clip(text, 300) } : {}) }
            : { title: clip(text, 80) };
        })
        .filter((x) => x.title)
        .slice(0, 12),
    )
    .pipe(z.array(z.object({ title: z.string(), text: z.string().optional() })).min(1)),
  tip: line(240).optional(),
  source: credit.optional(),
});

const chips = z
  .array(z.object({ label: line(48), icon }))
  .transform((a) => a.filter((c) => c.label).slice(0, 6));
const keyFacts = z
  .array(z.object({ label: line(40), value: line(120), icon }))
  .transform((a) => a.filter((f) => f.label && f.value).slice(0, 8));

const presentInput = z
  .object({
    type: z.enum(["summary", "links", "visualization", "media"]),
    title: z.string().trim().min(1).max(120),
    sections: z
      .array(section)
      .max(7)
      .optional()
      .describe(
        'summary only. kinds: facts (verified data, e.g. from the calendar), context (retrieved from email/recall/documents — say where from), changes, open_items, questions, suggestions (your own ideas, clearly), material. Write each item as "Short title: one or two sentences" (the title shows in bold; **bold** a key figure), sources as markdown links [site](url) at its end, and give `icons` (one per item, by meaning: scale, dumbbell, building, money, calendar, map-pin, users, globe, chart, alert, check, lightbulb…) so each point is recognizable at a glance.',
      ),
    lead: line(200)
      .optional()
      .describe(
        'summary only. One line under the title: "Según el contexto, IAFS puede referirse a:".',
      ),
    badge: line(40)
      .optional()
      .describe('summary only. A short tag by the title: "2 significados", "3 opciones", "Hoy".'),
    tags: chips
      .optional()
      .describe(
        'summary only. 2–4 chips that place the subject: where, what kind, a status ("Nueva Zelanda" map-pin, "Asesoramiento financiero" briefcase, "Licenciada por FMA" shield).',
      ),
    recipe: recipeInput
      .optional()
      .describe(
        'summary only, for a recipe ("¿cómo se hace el pollo al verdeo?"): times (prep, cook, total: "10 min"), servings ("2 porciones"), difficulty ("Fácil"), ingredients with amounts ("200 g pasta"), steps one action each, an optional tip. Diet or style as tags ("Vegetariana" leaf). image: only a photo already shown by web.images in this workspace (its url, alt and credit) — omit it otherwise. source: the link to the recipe site when it came from the web. sections may then be empty.',
      ),
    guide: guideInput
      .optional()
      .describe(
        'summary only, for step-by-step instructions (assembling, installing, setting up, a how-to): icon for the task (wrench, hammer, drill, settings, plug…), duration ("25 min"), difficulty ("Dificultad baja"), materials and tools each as {label, icon} by kind (board → layers, screws → package, screwdriver → wrench, drill → drill, tape measure → ruler, paint → paintbrush, cables → cable, water → droplet), steps as {title: short action in imperative, text: one concrete detail line}, a practical tip, and source when it came from the web. sections may then be empty.',
      ),
    facts: keyFacts
      .optional()
      .describe(
        'summary only. Key facts at a glance for a person, company, place or product: label → short value ("Director" → "Rod Schubert", user; "Fundada" → "1957", calendar). Only facts from your sources.',
      ),
    links: z
      .array(z.object({ title: z.string().trim().min(1).max(200), url: z.string().max(2000) }))
      .min(1)
      .max(8)
      .optional()
      .describe("links only. Only URLs that appear in this workspace's own sources."),
    chart: z
      .unknown()
      .optional()
      .describe(
        'visualization only. A chart template filled with numbers taken from visible Surfaces — never invented. {type: "kpi"|"line"|"area"|"bar"|"hbar"|"distribution"|"diverging"|"progress"|"table", title, insight?, format: {kind: "number"|"currency"|"percent"|"hours"|"count", currency?}, ...}. line/area/bar: x (labels) + series [{name, values}] with one value per label; hbar/distribution/diverging: rows [{label, value}]; kpi: value, previous?, goodWhen; progress: rows [{label, value 0-1}]; table: columns [{label, numeric?}] + rows [[cells]].',
      ),
    basis: z
      .array(surfaceRef)
      .min(1)
      .max(4)
      .optional()
      .describe("visualization only. The visible Surfaces the numbers come from."),
    media: z
      .object({
        kind: z.enum(MEDIA_KINDS),
        items: z
          .array(z.object({ url: z.string().max(2000), title: z.string().trim().max(200) }))
          .min(1)
          .max(6),
        caption: z.string().trim().max(240).optional(),
      })
      .optional()
      .describe(
        "media only. Images, a video (YouTube/Vimeo) or link previews — only URLs that appear in this workspace's own sources.",
      ),
  })
  .strict();

/** URLs the workspace already holds (events, threads, documents, recall). */
function knownUrls(state: WorkspaceState): Set<string> {
  const urls = new Set<string>();
  const add = (u: unknown) => typeof u === "string" && u && urls.add(u);
  for (const s of state.surfaces) {
    for (const a of s.actions) add(a.href);
    const p = s.payload as Record<string, unknown>;
    if (s.type === "meeting" || s.type === "calendar_event") {
      const e = p as SurfacePayloads["meeting"];
      add(e.meetingUrl);
      add(e.htmlUrl);
      for (const m of (e.description ?? "").match(/https:\/\/[^\s<>"')\]]+/g) ?? []) add(m);
    }
    if (s.type === "calendar")
      for (const e of (p as SurfacePayloads["calendar"]).events) {
        add(e.meetingUrl);
        add(e.htmlUrl);
        for (const m of (e.description ?? "").match(/https:\/\/[^\s<>"')\]]+/g) ?? []) add(m);
      }
    if (s.type === "knowledge_result")
      for (const src of (p as SurfacePayloads["knowledge_result"]).sources) add(src.url);
    if (s.type === "knowledge_source" || s.type === "document") add(p.url);
    if (s.type === "links") for (const l of (p as SurfacePayloads["links"]).links) add(l.url);
    if (s.type === "web_source") add(p.url);
    if (s.type === "web_results")
      for (const r of (p as SurfacePayloads["web_results"]).results) add(r.url);
    if (s.type === "web_news")
      for (const e of (p as SurfacePayloads["web_news"]).events)
        for (const i of e.items) add(i.url);
    if (s.type === "web_research")
      for (const q of (p as SurfacePayloads["web_research"]).subquestions)
        for (const x of q.sources) add(x.url);
    if (s.type === "media")
      for (const m of (p as SurfacePayloads["media"]).items) {
        add(m.url);
        add(m.image);
      }
  }
  return urls;
}

/** Photos already shown in this workspace's galleries (a recipe may use one of them). */
function knownImages(state: WorkspaceState): Set<string> {
  const urls = new Set<string>();
  for (const s of state.surfaces)
    if (s.type === "image_gallery")
      for (const g of (s.payload as SurfacePayloads["image_gallery"]).groups)
        for (const im of g.images) {
          urls.add(im.thumbnailUrl);
          if (im.imageUrl) urls.add(im.imageUrl);
        }
  return urls;
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export const presentTool: ToolDefinition = {
  name: "ui.present",
  capability: "workspace",
  operation: "present",
  description:
    "Add a structured card to the Live Workspace: a summary (a meeting brief, the answer to a web question, any answer with a shape — options, key facts, a plan), a recipe, step-by-step instructions, or a set of links. Results you fetch with other tools are already shown — don't re-present them. Keep facts, retrieved context and your suggestions in separate sections.",
  input: presentInput,
  async describe() {
    return { summary: "Show in workspace" };
  },
  async run(raw, env) {
    const q = presentInput.parse(raw);
    const w = port(env);
    const state = w.state();
    const intentKey = state.intent?.id ?? "none";
    const at = now(env);
    if (q.type === "summary") {
      if (!q.sections?.length && !q.recipe && !q.guide)
        throw new AppError("VALIDATION_ERROR", "A summary needs sections", { recovery: "review" });
      // A recipe's photo is one ELISE already showed (a gallery), never a URL from nowhere.
      // Provenance stays strict, but an unknown link or photo is dropped — not the card.
      const known = knownUrls(state);
      const images = knownImages(state);
      const recipe = q.recipe && {
        ...q.recipe,
        source: q.recipe.source && known.has(q.recipe.source.url) ? q.recipe.source : undefined,
        image:
          q.recipe.image && images.has(q.recipe.image.url)
            ? {
                url: q.recipe.image.url,
                alt: q.recipe.image.alt || q.title,
                credit: q.recipe.image.credit ?? null,
              }
            : undefined,
      };
      const guide = q.guide && {
        ...q.guide,
        source: q.guide.source && known.has(q.guide.source.url) ? q.guide.source : undefined,
      };
      const payload = PAYLOADS.summary.parse({
        sections: q.sections ?? [],
        ...(recipe ? { recipe: JSON.parse(JSON.stringify(recipe)) } : {}),
        ...(!recipe && guide ? { guide: JSON.parse(JSON.stringify(guide)) } : {}),
        ...(q.lead ? { lead: q.lead } : {}),
        ...(q.badge ? { badge: q.badge } : {}),
        ...(q.tags?.length ? { tags: q.tags } : {}),
        ...(q.facts?.length ? { facts: q.facts } : {}),
      });
      w.apply([
        {
          op: "present",
          at,
          surface: {
            id: surfaceId("summary", intentKey),
            type: "summary",
            title: q.title,
            state: "ready",
            source: { capability: "workspace", label: "ELISE" },
            ref: null,
            payload,
            intentId: state.intent?.id ?? null,
            ...draftDefaults("summary", payload),
          },
        },
      ]);
    } else if (q.type === "links") {
      if (!q.links)
        throw new AppError("VALIDATION_ERROR", "Links are required", { recovery: "review" });
      const known = knownUrls(state);
      const unknown = q.links.filter((l) => !known.has(l.url));
      if (unknown.length)
        throw new AppError(
          "VALIDATION_ERROR",
          "Only links that appear in this workspace's sources can be shown.",
          { recovery: "review" },
        );
      const payload = PAYLOADS.links.parse({
        links: q.links.map((l) => ({ ...l, kind: "web" as const })),
      });
      w.apply([
        {
          op: "present",
          at,
          surface: {
            id: surfaceId("links", intentKey),
            type: "links",
            title: q.title,
            state: "ready",
            source: { capability: "workspace", label: "ELISE" },
            ref: null,
            payload,
            intentId: state.intent?.id ?? null,
            ...draftDefaults("links", payload),
          },
        },
      ]);
    } else if (q.type === "visualization") {
      // A chart is a template plus numbers from what the user already sees: grounded, typed,
      // validated — never markup, styles or code.
      if (!q.basis?.length)
        throw new AppError(
          "VALIDATION_ERROR",
          "A chart needs the visible Surfaces its numbers come from (basis).",
          { recovery: "review" },
        );
      const basis = q.basis.map((b) => find(state, b));
      const chart = q.chart && typeof q.chart === "object" ? q.chart : {};
      const parsed = visualizationSpec.safeParse({ ...chart, title: q.title });
      if (!parsed.success)
        throw new AppError(
          "VALIDATION_ERROR",
          `That chart isn't valid: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "chart"}: ${i.message}`)
            .join("; ")}`,
          { recovery: "review" },
        );
      const payload = PAYLOADS.visualization.parse({ spec: parsed.data });
      w.apply([
        {
          op: "present",
          at,
          surface: {
            id: surfaceId("visualization", `${intentKey}:${q.title.toLowerCase()}`),
            type: "visualization",
            title: q.title,
            state: "ready",
            source: {
              capability: "workspace",
              label: basis
                .map((b) => b.title || b.handle)
                .join(" · ")
                .slice(0, 200),
            },
            ref: null,
            payload,
            intentId: state.intent?.id ?? null,
            ...draftDefaults("visualization", payload),
          },
        },
      ]);
    } else {
      if (!q.media)
        throw new AppError("VALIDATION_ERROR", "Media items are required", { recovery: "review" });
      const known = knownUrls(state);
      if (q.media.items.some((m) => !known.has(m.url)))
        throw new AppError(
          "VALIDATION_ERROR",
          "Only media that appears in this workspace's sources can be shown.",
          { recovery: "review" },
        );
      if (q.media.kind === "video" && !videoEmbed(q.media.items[0]!.url))
        throw new AppError(
          "VALIDATION_ERROR",
          "Only YouTube or Vimeo videos can play here; show it as a link instead.",
          { recovery: "review" },
        );
      if (
        (q.media.kind === "image" || q.media.kind === "gallery") &&
        q.media.items.some((m) => !isImageUrl(m.url))
      )
        throw new AppError("VALIDATION_ERROR", "Those URLs aren't images.", {
          recovery: "review",
        });
      const payload = mediaPayload.parse({
        kind: q.media.kind,
        items: q.media.items.map((m) => ({
          url: m.url,
          title: m.title,
          domain: domainOf(m.url),
          image: q.media!.kind === "image" || q.media!.kind === "gallery" ? m.url : null,
          alt: m.title,
        })),
        ...(q.media.caption ? { caption: q.media.caption } : {}),
      });
      w.apply([
        {
          op: "present",
          at,
          surface: {
            id: surfaceId("media", `${intentKey}:${payload.items[0]!.url}`),
            type: "media",
            title: q.title,
            state: "ready",
            source: { capability: "workspace", label: payload.items[0]!.domain || null },
            ref: { resource: "web_page", id: payload.items[0]!.url },
            payload,
            intentId: state.intent?.id ?? null,
            ...draftDefaults("media", payload),
          },
        },
      ]);
    }
    return { output: { presented: q.type, ...digest(env) } };
  },
};

const oneInput = z.object({ surface: surfaceRef }).strict();

const focusInput = z
  .object({
    surface: surfaceRef.describe('A Surface handle ("S2"), or "none" to go back to everything.'),
    item: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("An item id inside that Surface (an email's thread id, a timeline entry)."),
    compareWith: surfaceRef.optional().describe("A second Surface to show beside it."),
  })
  .strict();

export const focusTool: ToolDefinition = {
  name: "ui.focus",
  capability: "workspace",
  operation: "focus",
  description:
    '"Open that document", "show me the second email", "compare these two": bring one visible Surface to the front (optionally one item inside it, or a second Surface beside it to compare). "Go back", "close that": surface "none".',
  input: focusInput,
  async describe() {
    return { summary: "Focus" };
  },
  async run(raw, env) {
    const q = focusInput.parse(raw);
    const w = port(env);
    if (q.surface.toLowerCase() === "none") {
      w.apply([{ op: "focus", id: null, at: now(env) }]);
      return { output: { focused: null } };
    }
    const s = find(w.state(), q.surface);
    const other = q.compareWith ? find(w.state(), q.compareWith) : null;
    w.apply([
      {
        op: "focus",
        id: s.id,
        item: q.item ?? null,
        compareWith: other?.id ?? null,
        at: now(env),
      },
    ]);
    return {
      output: { focused: s.handle, ...(other ? { comparedWith: other.handle } : {}) },
    };
  },
};

const pinInput = z.object({ surface: surfaceRef, pinned: z.boolean().default(true) }).strict();

export const pinTool: ToolDefinition = {
  name: "ui.pin",
  capability: "workspace",
  operation: "pin",
  description:
    '"Keep the meeting there", "pin that": keep a Surface visible while the work moves on (up to 3). pinned:false releases it.',
  input: pinInput,
  async describe() {
    return { summary: "Pin" };
  },
  async run(raw, env) {
    const q = pinInput.parse(raw);
    const w = port(env);
    const s = find(w.state(), q.surface);
    w.apply([{ op: "pin", id: s.id, pinned: q.pinned, at: now(env) }]);
    return { output: { [q.pinned ? "pinned" : "unpinned"]: s.handle } };
  },
};

const arrangeInput = z.object({ order: z.enum(["time", "relevance"]) }).strict();

export const arrangeTool: ToolDefinition = {
  name: "ui.arrange",
  capability: "workspace",
  operation: "arrange",
  description:
    '"What happened today?", "how did this evolve?", "walk me through it in order": show the visible results in time order (a timeline). "relevance" goes back to the usual arrangement.',
  input: arrangeInput,
  async describe() {
    return { summary: "Arrange" };
  },
  async run(raw, env) {
    const q = arrangeInput.parse(raw);
    port(env).apply([{ op: "arrange", order: q.order, at: now(env) }]);
    return { output: { arranged: q.order } };
  },
};

export const dismissTool: ToolDefinition = {
  name: "ui.dismiss",
  capability: "workspace",
  operation: "dismiss",
  description: "Remove one Surface the user no longer needs (only its display; no data changes).",
  input: oneInput,
  async describe() {
    return { summary: "Dismiss" };
  },
  async run(raw, env) {
    const w = port(env);
    const s = find(w.state(), oneInput.parse(raw).surface);
    w.apply([{ op: "dismiss", id: s.id, at: now(env) }]);
    return { output: { dismissed: s.handle } };
  },
};

const updateInput = z.object({ surface: surfaceRef, size: z.enum(SURFACE_SIZES) }).strict();

export const updateTool: ToolDefinition = {
  name: "ui.update",
  capability: "workspace",
  operation: "update",
  description: "Expand or collapse one Surface (size).",
  input: updateInput,
  async describe() {
    return { summary: "Resize" };
  },
  async run(raw, env) {
    const q = updateInput.parse(raw);
    const w = port(env);
    const s = find(w.state(), q.surface);
    if (!surfaceDefinition(s.type).sizes.includes(q.size))
      throw new AppError("VALIDATION_ERROR", `${s.type} can't be shown ${q.size}`, {
        recovery: "review",
      });
    w.apply([{ op: "update", id: s.id, patch: { size: q.size }, at: now(env) }]);
    return { output: { updated: s.handle, size: q.size } };
  },
};

export const clearTool: ToolDefinition = {
  name: "ui.clear",
  capability: "workspace",
  operation: "clear",
  description:
    "Clear the workspace when the user moves to an unrelated topic or asks to. Pending approvals and pinned Surfaces stay.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Clear workspace" };
  },
  async run(_raw, env) {
    port(env).apply([{ op: "clear", at: now(env) }]);
    return { output: { cleared: true } };
  },
};

// ── ui.show: the working set, in the form asked (ADR-031) ────────────────────

const showInput = z
  .object({
    what: z
      .enum(["last_changed", "collection"])
      .describe(
        '"Mostramelo" after creating/changing something → last_changed. "Mostralas", "esas tareas", "ponelas en una timeline" → collection (the one being discussed).',
      ),
    surface: surfaceRef
      .optional()
      .describe("Only when the user points at a specific one (S2, “the second list”)."),
    as: z
      .enum(["list", "timeline", "table", ...CALENDAR_VIEWS])
      .optional()
      .describe(
        'Another form for the SAME data. It replaces the current view. A calendar: day, week, month, year or agenda ("pasalo a vista mensual").',
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Calendar: the day the view moves to ("mostrame el miércoles", "la semana que viene" → a day in that week, "volvé a esta semana" → today). Missing days are read automatically.',
      ),
    calendars: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe(
        'Calendar: show only these calendars, by name ("solo trabajo" → ["Trabajo"]); [] shows all again.',
      ),
    keep: z
      .boolean()
      .default(false)
      .describe('Only if the user asks to keep both ("dejá la lista y mostrame también…").'),
  })
  .strict();

/** The visible calendar, in another view, date or calendar selection (ADR-033). */
async function showCalendar(
  surface: Surface,
  q: z.infer<typeof showInput>,
  env: ToolRunEnv,
  at: string,
): Promise<ToolRunResult<unknown>> {
  const p = surface.payload as CalendarPayload;
  const names = q.calendars?.map((n) => n.toLowerCase());
  const hidden = names
    ? names.length
      ? calendarsOf(p.events)
          .filter((c) => !names.some((n) => c.name.toLowerCase().includes(n)))
          .map((c) => c.id)
      : []
    : undefined;
  const view = CALENDAR_VIEWS.includes(q.as as CalendarView) ? (q.as as CalendarView) : undefined;
  const today = toLocalDateTime(env.ctx.now, env.ctx.timezone).slice(0, 10);
  const w = port(env);
  // The same path as the Surface's own controls: presentation first, only missing days read.
  const done = await changeCalendar({
    current: () =>
      (w.state().surfaces.find((s) => s.id === surface.id)?.payload as CalendarPayload) ?? null,
    change: { view, anchor: q.date, hidden },
    today,
    seq: nextSeq(p),
    read: async (args) => {
      if (!env.invoke) throw new AppError("PROVIDER_UNAVAILABLE", "Can't read the calendar here");
      return env.invoke("calendar.listEvents", args);
    },
  });
  const latest = w.state().surfaces.find((s) => s.id === surface.id)?.payload as
    CalendarPayload | undefined;
  if (!done || !latest) throw new AppError("NOT_FOUND", "That calendar is no longer shown");
  const { payload, query } = done.settle(latest);
  w.apply([
    { op: "update", id: surface.id, patch: { payload, query, state: "ready" }, at },
    { op: "focus", id: surface.id, item: null, at },
  ]);
  const shown = visibleEvents(payload);
  return {
    output: {
      shown: surface.handle,
      view: payload.view,
      date: payload.anchor,
      events: shown.length,
      ...(done.read === "failed"
        ? { note: "Couldn't read the missing days; what was already loaded is still shown." }
        : {}),
      instructions:
        "The calendar on screen moved there (same Surface). Answer briefly from it; don't list every event.",
    },
  };
}

export const showTool: ToolDefinition = {
  name: "ui.show",
  capability: "workspace",
  operation: "show",
  description:
    '"Mostramelo", "mostralas", "esas tareas como línea de tiempo / tabla": shows what the user is working with — the thing just created or changed, or the collection being discussed — focused, or in another form of the SAME data (the old view is replaced, never duplicated). ELISE resolves which one; no ids needed.',
  input: showInput,
  async describe() {
    return { summary: "Show" };
  },
  async run(raw, env) {
    const q = showInput.parse(raw);
    const w = port(env);
    const state = w.state();
    const target = q.surface
      ? find(state, q.surface)
      : q.what === "last_changed"
        ? (lastAffected(state) ?? activeCollection(state))
        : activeCollection(state);
    if (!target)
      throw new AppError(
        "VALIDATION_ERROR",
        "Nothing on screen matches: fetch it first (e.g. tasks.list), then show it.",
        { recovery: "review" },
      );
    const at = now(env);
    const calendarTarget =
      target.type === "calendar"
        ? target
        : (q.date || q.calendars || CALENDAR_VIEWS.includes(q.as as CalendarView)) && !q.surface
          ? state.surfaces.find((s) => s.type === "calendar")
          : undefined;
    if (calendarTarget) return showCalendar(calendarTarget, q, env, at);
    const as = q.as;
    if (as && as !== "list" && as !== "timeline" && as !== "table")
      throw new AppError(
        "VALIDATION_ERROR",
        "No calendar on screen: read it first (calendar.listEvents), then change its view.",
        { recovery: "review" },
      );
    const current = target.presentation ?? (target.type === "task_list" ? "list" : null);
    if (!as || as === current) {
      w.apply([
        {
          op: "focus",
          id: target.id,
          item: q.what === "last_changed" ? (target.focusItem ?? null) : null,
          at,
        },
      ]);
      return { output: { shown: target.handle, title: target.title } };
    }
    // Another form of the same data: from the collection's own items (refreshed if needed).
    if (!target.query?.tool.startsWith("tasks."))
      throw new AppError(
        "VALIDATION_ERROR",
        "This collection has no other built-in form: use ui.timeline / ui.visualize with its handle as the source (the new view replaces it).",
        { recovery: "review" },
      );
    let list =
      target.type === "task_list" ? (target.payload as SurfacePayloads["task_list"]) : null;
    if (!list && env.invoke) {
      const fresh = await env.invoke(target.query.tool, target.query.args);
      if (fresh.status === "succeeded" && fresh.display?.kind === "task_list")
        list = {
          items: surfacesFromOutcome(target.query.tool, fresh, { key: "x" })
            .filter((d) => d.type === "task_list")
            .flatMap((d) => (d.payload as SurfacePayloads["task_list"]).items),
          total: fresh.display.tasks.length,
        };
    }
    if (!list) throw new AppError("PROVIDER_UNAVAILABLE", "Couldn't read that collection again");
    const dataset = target.dataset ?? datasetKey(target.query.tool, target.query.args);
    const title = target.title || (env.ctx.locale === "es" ? "Tareas" : "Tasks");
    const common = {
      title,
      state: "ready" as const,
      source: target.source,
      ref: null,
      intentId: target.intentId,
      query: target.query,
      dataset,
    };
    if (as === "list") {
      const payload = PAYLOADS.task_list.parse(list);
      w.apply([
        {
          op: "present",
          keep: q.keep,
          at,
          surface: {
            id: surfaceId("task_list", queryKey(target.query.tool, target.query.args)),
            type: "task_list",
            ...common,
            payload,
            presentation: "list",
            ...draftDefaults("task_list", payload),
          },
        },
      ]);
      return { output: { shown: "list", items: list.items.length } };
    }
    const spec = representTasks(list, as, {
      title,
      locale: env.ctx.locale,
      today: toLocalDateTime(env.ctx.now, env.ctx.timezone).slice(0, 10),
    });
    if (!spec)
      throw new AppError(
        "VALIDATION_ERROR",
        env.ctx.locale === "es"
          ? "Estas tareas no tienen fechas para ubicarlas en el tiempo."
          : "These tasks have no dates to place in time.",
        { recovery: "review" },
      );
    const payload = PAYLOADS.visualization.parse({ spec });
    w.apply([
      {
        op: "present",
        keep: q.keep,
        at,
        surface: {
          id: surfaceId("visualization", `${dataset}:${as}`),
          type: "visualization",
          ...common,
          payload,
          presentation: as,
          members: memberIds(list),
          ...draftDefaults("visualization", payload),
          size: "large",
          priority: Math.max(target.priority, 80),
        },
      },
    ]);
    return {
      output: {
        shown: as,
        items: list.items.length,
        ...(q.keep ? {} : { replaced: target.handle }),
        instructions:
          "The same tasks are on screen in the new form (the previous view was replaced). Say it in one short sentence.",
      },
    };
  },
};

// ── ui.progress (ADR-126) ────────────────────────────────────────────────────

const progressInput = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        'The goal, stable across updates ("Repaso de Legislación"): the same title updates the same bar.',
      ),
    done: z.number().int().min(0).max(500),
    total: z.number().int().min(1).max(500),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .describe('What is counted, plural: "capítulos", "pasos", "temas".'),
    current: z.string().trim().max(160).optional().describe("What's being worked on now."),
    steps: z
      .array(z.string().trim().min(1).max(120))
      .max(30)
      .optional()
      .describe("The steps by name, in order, when they're known (done ones first)."),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export const progressTool: ToolDefinition = {
  name: "ui.progress",
  capability: "workspace",
  operation: "progress",
  description:
    "A progress bar toward a goal the conversation works through step by step — reviewing 13 chapters, going through a setup checklist, practicing a list of topics. Use it only when such a goal is explicit and tracking it helps; never for ordinary answers or chats. Show it when the plan starts (done 0) and call it again with the same title each time a step is completed, so the bar advances.",
  input: progressInput,
  async describe() {
    return { summary: "Show progress" };
  },
  async run(raw, env) {
    const q = progressInput.parse(raw);
    const done = Math.min(q.done, q.total);
    const w = port(env);
    const state = w.state();
    const steps = (q.steps ?? []).slice(0, q.total).map((label, i) => ({
      label,
      state:
        i < done ? ("done" as const) : i === done ? ("current" as const) : ("pending" as const),
    }));
    const payload = PAYLOADS.progress.parse({
      done,
      total: q.total,
      unit: q.unit,
      current: q.current ?? steps[done]?.label ?? null,
      steps,
      note: q.note ?? null,
    });
    w.apply([
      {
        op: "present",
        at: now(env),
        surface: {
          id: surfaceId("progress", q.title.toLowerCase()),
          type: "progress",
          title: q.title,
          state: "ready",
          source: { capability: "workspace", label: "ELISE" },
          ref: null,
          payload,
          intentId: state.intent?.id ?? null,
          ...draftDefaults("progress", payload),
        },
      },
    ]);
    return {
      output: {
        shown: true,
        progress: `${done}/${q.total} ${q.unit}`,
        instructions: "It's on screen: don't read the numbers back unless asked.",
      },
    };
  },
};

export const WORKSPACE_TOOLS = [
  listSurfacesTool,
  answerTool,
  presentTool,
  visualizeTool,
  timelineTool,
  showTool,
  focusTool,
  pinTool,
  arrangeTool,
  dismissTool,
  updateTool,
  clearTool,
  progressTool,
];

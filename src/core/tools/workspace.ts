import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { timelineTool, visualizeTool } from "./visualize";
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

const section = PAYLOADS.summary.shape.sections.element;

const presentInput = z
  .object({
    type: z.enum(["summary", "links", "visualization", "media"]),
    title: z.string().trim().min(1).max(120),
    sections: z
      .array(section)
      .min(1)
      .max(7)
      .optional()
      .describe(
        "summary only. kinds: facts (verified data, e.g. from the calendar), context (retrieved from email/recall/documents — say where from), changes, open_items, questions, suggestions (your own ideas, clearly), material.",
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
    "Add a structured summary (e.g. a meeting brief) or a set of links to the Live Workspace. Results you fetch with other tools are already shown — don't re-present them. Keep facts, retrieved context and your suggestions in separate sections.",
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
      if (!q.sections)
        throw new AppError("VALIDATION_ERROR", "A summary needs sections", { recovery: "review" });
      const payload = PAYLOADS.summary.parse({ sections: q.sections });
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

export const WORKSPACE_TOOLS = [
  listSurfacesTool,
  presentTool,
  visualizeTool,
  timelineTool,
  focusTool,
  pinTool,
  arrangeTool,
  dismissTool,
  updateTool,
  clearTool,
];

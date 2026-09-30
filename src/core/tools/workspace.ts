import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { SURFACE_SIZES, surfaceId, type Surface, type WorkspaceState } from "../workspace/model";
import type { WorkspacePort } from "../workspace/port";
import {
  describeWorkspace,
  draftDefaults,
  PAYLOADS,
  surfaceDefinition,
  type SurfacePayloads,
} from "../workspace/registry";

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
    type: z.enum(["summary", "links"]),
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
  }
  return urls;
}

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
    } else {
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
    }
    return { output: { presented: q.type, ...digest(env) } };
  },
};

const oneInput = z.object({ surface: surfaceRef }).strict();

export const focusTool: ToolDefinition = {
  name: "ui.focus",
  capability: "workspace",
  operation: "focus",
  description: '"Show me the meeting", "that document": bring one visible Surface to the front.',
  input: oneInput,
  async describe() {
    return { summary: "Focus" };
  },
  async run(raw, env) {
    const w = port(env);
    const s = find(w.state(), oneInput.parse(raw).surface);
    w.apply([{ op: "focus", id: s.id, at: now(env) }]);
    return { output: { focused: s.handle } };
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
    "Clear the workspace when the user moves to an unrelated topic or asks to. Pending approvals stay.",
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
  focusTool,
  dismissTool,
  updateTool,
  clearTool,
];

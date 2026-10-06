import "server-only";

import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import type { AnyToolDefinition, ToolDisplay } from "@/core/agents/tools";
import { getOperation } from "@/core/capabilities/registry";
import { AppError, toAppError, toPublicError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import { wellFormed } from "@/core/text";
import { todayIn } from "@/core/time";
import {
  changeCalendar,
  keepPresentation,
  nextSeq,
  rangeArgs,
  refreshRange,
  type CalendarChange,
  type CalendarPayload,
} from "@/core/workspace/calendar";
import {
  approvalDecidedOps,
  presentOps,
  reconcileOps,
  supersededOps,
  surfacesFromOutcome,
} from "@/core/workspace/from-results";
import {
  affectedSurfaces,
  changeOf,
  datasetKey,
  memberIds,
  queryKey,
  representTasks,
  type ResourceChange,
  type SurfaceQuery,
} from "@/core/workspace/lifecycle";
import { forStorage } from "@/core/workspace/location";
import {
  applyOps,
  emptyWorkspace,
  restoreWorkspace,
  SURFACE_SIZES,
  WORKSPACE_LIMITS,
  type ActionId,
  type SurfaceRef,
  type SurfaceSize,
  type WorkspaceOp,
  type WorkspaceState,
} from "@/core/workspace/model";
import type { ActivityStep, WorkspacePort } from "@/core/workspace/port";
import {
  parseWorkspace,
  surfaceDefinition,
  toolForAction,
  type SurfacePayloads,
} from "@/core/workspace/registry";
import { getEmbeddingProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";
import { SupabaseKnowledgeReader } from "@/infrastructure/supabase/repositories/knowledge";

import type { AuthContext } from "./auth-context";
import type { AssistantMessageMetadata, ClientToolOutcome } from "./chat-protocol";
import { associateInteraction } from "./contexts-service";
import { createExecutorPorts, toolContext } from "./elise";
import { ownSession } from "./interaction-thread";
import { webCapability } from "./web-service";

/**
 * Live Workspace persistence and operations (ADR-013). The row is the author's own (RLS); its
 * content is re-validated on every read, so a stored Surface can never carry markup, unsafe
 * links or authority. Every action a Surface offers runs through the normal executor.
 */

type Row = {
  intent: Json | null;
  surfaces: Json;
  focus_id: string | null;
  turn: number;
  next_handle: number;
  version: number;
};

const fromRow = (r: Row, context: WorkspaceState["context"] = null): WorkspaceState =>
  parseWorkspace({
    intent: r.intent,
    surfaces: r.surfaces,
    focusId: r.focus_id,
    turn: r.turn,
    nextHandle: r.next_handle,
    version: r.version,
    context,
  });

/**
 * The active context, read again from its profile (ADR-016 §6): a renamed profile shows its
 * new name, an archived or deleted one is simply no longer active.
 */
async function sectionParentName(auth: AuthContext, spaceId: string): Promise<string | null> {
  const { data: space } = await auth.db
    .from("knowledge_spaces")
    .select("parent_space_id")
    .eq("id", spaceId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!space?.parent_space_id) return null;
  const { data: parent } = await auth.db
    .from("knowledge_spaces")
    .select("name")
    .eq("id", space.parent_space_id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  return parent?.name ?? null;
}

async function activeContextOf(
  auth: AuthContext,
  id: string | null,
  turn: number,
): Promise<WorkspaceState["context"]> {
  if (!id) return null;
  const { data } = await auth.db
    .from("context_profiles")
    .select("id, name, kind, accent, status, knowledge_space_id")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!data || data.status !== "active") return null;
  // A Section's context reads "University › Mathematics" (ADR-018).
  const parent = data.knowledge_space_id
    ? await sectionParentName(auth, data.knowledge_space_id)
    : null;
  return {
    id: data.id,
    name: parent ? `${parent} › ${data.name}` : data.name,
    kind: data.kind,
    accent: data.accent,
    turn,
  };
}

/** A workspace belongs to a conversation or to a voice session (ADR-014). */
const column = (t: ThreadRef) => (t.kind === "conversation" ? "conversation_id" : "session_id");

/** The interaction's workspace, restored (stale snapshots marked, approvals reconciled). */
export async function loadWorkspace(
  auth: AuthContext,
  thread: ThreadRef,
  now = new Date(),
): Promise<WorkspaceState> {
  const { data } = await auth.db
    .from("live_workspaces")
    .select(
      "intent, surfaces, focus_id, turn, next_handle, version, expires_at, context_profile_id, context_turn",
    )
    .eq(column(thread), thread.id)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data || Date.parse(data.expires_at) <= now.getTime()) return emptyWorkspace();
  const context = await activeContextOf(auth, data.context_profile_id, data.context_turn);
  const state = restoreWorkspace(fromRow(data, context), now);
  return reconcileApprovals(auth, state, now);
}

/** Approvals decided elsewhere (Approval Center, another tab) show their current state. */
async function reconcileApprovals(auth: AuthContext, state: WorkspaceState, now: Date) {
  const pending = state.surfaces.filter((s) => s.type === "approval" && s.state === "attention");
  if (!pending.length) return state;
  const ids = pending.map((s) => (s.payload as SurfacePayloads["approval"]).approvalId);
  const { data } = await auth.db.from("approvals").select("id, status").in("id", ids);
  const ops = (data ?? []).flatMap((a) =>
    a.status === "pending"
      ? []
      : approvalDecidedOps(
          state,
          a.id,
          a.status === "approved" ? "approved" : "rejected",
          undefined,
          now.toISOString(),
        ),
  );
  return ops.length ? applyOps(state, ops) : state;
}

export async function saveWorkspace(auth: AuthContext, thread: ThreadRef, state: WorkspaceState) {
  const now = new Date();
  const { error } = await auth.db.from("live_workspaces").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      conversation_id: thread.kind === "conversation" ? thread.id : null,
      session_id: thread.kind === "session" ? thread.id : null,
      intent: wellFormed(state.intent ?? null) as unknown as Json,
      // The user's shared position never reaches storage (ADR-023).
      surfaces: wellFormed(state.surfaces.map(forStorage)) as unknown as Json,
      focus_id: state.focusId,
      turn: state.turn,
      next_handle: state.nextHandle,
      version: state.version,
      context_profile_id: state.context?.id ?? null,
      context_turn: state.context?.turn ?? 0,
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + WORKSPACE_LIMITS.ttlMs).toISOString(),
    },
    { onConflict: column(thread) },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the workspace", { cause: error });
}

/** Product analytics without content: types and counts only (docs/engineering/18 §841). */
function observe(before: WorkspaceState, after: WorkspaceState, thread: ThreadRef) {
  const at = { thread: thread.kind };
  const had = new Set(before.surfaces.map((s) => s.id));
  const has = new Set(after.surfaces.map((s) => s.id));
  const added = after.surfaces.filter((s) => !had.has(s.id));
  for (const s of added)
    logger.info("workspace.surface_presented", {
      ...at,
      type: s.type,
      ...(s.presentation ? { presentation: s.presentation } : {}),
    });
  for (const s of before.surfaces) {
    if (has.has(s.id)) continue;
    // Same data in another form (ADR-031): superseded, not merely removed. No content logged.
    const heir = s.dataset ? added.find((a) => a.dataset === s.dataset) : undefined;
    logger.info(heir ? "workspace.surface_replaced" : "workspace.surface_removed", {
      ...at,
      type: s.type,
      ...(heir ? { by: heir.type, presentation: heir.presentation ?? null } : {}),
    });
  }
  if (after.focusId && after.focusId !== before.focusId)
    logger.info("workspace.surface_focused", {
      ...at,
      type: after.surfaces.find((s) => s.id === after.focusId)?.type,
    });
  if (after.intent?.id !== before.intent?.id && after.intent)
    logger.info("workspace.intent_started", {
      ...at,
      kind: after.intent.kind,
    });
  if (after.context?.id !== before.context?.id)
    logger.info(after.context ? "context.activated" : "context.cleared", {
      ...at,
      ...(after.context ? { kind: after.context.kind } : {}),
    });
}

/**
 * The workspace during one chat turn: applies ops, streams them to the browser, and saves
 * after every change (serialized), so a refresh mid-turn keeps what already arrived.
 */
export class WorkspaceSession implements WorkspacePort {
  private saving: Promise<void> = Promise.resolve();
  private emit: ((ops: WorkspaceOp[], version: number) => void) | null = null;
  private onActivity: ((step: ActivityStep, parent: string | null) => void) | null = null;
  /** The top-level tool call running now (orchestration steps nest under it). */
  current: string | null = null;

  constructor(
    private readonly auth: AuthContext,
    private readonly thread: ThreadRef,
    private value: WorkspaceState,
  ) {}

  /** Ops applied before the stream opened (the turn's decay) are sent on attach. */
  private buffered: WorkspaceOp[] = [];

  attach(
    emit: (ops: WorkspaceOp[], version: number) => void,
    onActivity: (step: ActivityStep, parent: string | null) => void,
  ) {
    this.emit = emit;
    this.onActivity = onActivity;
    if (this.buffered.length) emit(this.buffered.splice(0), this.value.version);
  }

  state() {
    return this.value;
  }

  apply(ops: WorkspaceOp[]) {
    if (!ops.length) return;
    const before = this.value;
    const after = applyOps(before, ops);
    if (after === before) return;
    this.value = after;
    observe(before, after, this.thread);
    if (this.emit) this.emit(ops, after.version);
    else this.buffered.push(...ops);
    const snapshot = after;
    this.saving = this.saving
      .then(() => saveWorkspace(this.auth, this.thread, snapshot))
      .catch((error) => logger.warn("workspace.save_failed", { code: toAppError(error).code }));
  }

  activity(step: ActivityStep) {
    if (step.status === "failed" || step.status === "unavailable")
      logger.info("workspace.partial_failure", { tool: step.tool, status: step.status });
    this.onActivity?.(step, this.current);
  }

  /**
   * Presents a finished tool call's result; returns the Surface ids it produced. A read's
   * Surfaces remember their query (and take their id from it), so reading the same thing again
   * — or refreshing it after a write — updates them in place. `skip` presents nothing (a write
   * whose visible collections were already refreshed).
   */
  present(
    toolName: string,
    callId: string,
    outcome: ToolCallOutcome,
    query: SurfaceQuery | null = null,
    change: ResourceChange | null = null,
    /** How prominent ELISE wants it (a scheduled brief ranks its Surfaces, ADR-041). */
    priority?: number,
  ): string[] {
    const at = new Date().toISOString();
    // A change to something already shown updates it there instead of adding a duplicate.
    const reconciled = reconcileOps(this.value, outcome, at);
    // The written resource already appears in a (just refreshed) collection: that collection
    // is what "mostramelo" means now — no extra card. A deleted resource gets no card at all.
    const holder =
      change?.resourceId && change.operation !== "deleted"
        ? this.value.surfaces.find(
            (s) =>
              s.type !== "approval" &&
              s.query &&
              (s.members?.includes(change.resourceId!) ||
                JSON.stringify(s.payload).includes(change.resourceId!)),
          )
        : undefined;
    const raw =
      reconciled.length || holder || change?.operation === "deleted"
        ? []
        : surfacesFromOutcome(toolName, outcome, {
            key: query ? queryKey(query.tool, query.args) : callId,
            intentId: this.value.intent?.id ?? null,
            locale: this.auth.profile?.locale,
            timezone: this.auth.profile?.timezone,
          });
    // Free time asked about days a calendar already shows: emphasized there, not a 2nd calendar.
    const availability = raw.find(
      (d) => d.type === "calendar" && toolName.endsWith(".findAvailability"),
    );
    const shownCalendar = availability
      ? this.value.surfaces.find((s) => {
          if (s.type !== "calendar") return false;
          const p = s.payload as CalendarPayload;
          const a = (availability.payload as CalendarPayload).range;
          return p.events.some((e) => !e.busy) && p.range.from <= a.from && p.range.to >= a.to;
        })
      : undefined;
    if (shownCalendar && availability) {
      const a = availability.payload as CalendarPayload;
      this.apply([
        {
          op: "update",
          id: shownCalendar.id,
          patch: {
            payload: {
              ...(shownCalendar.payload as CalendarPayload),
              free: a.free,
              view: a.view === "day" ? "day" : (shownCalendar.payload as CalendarPayload).view,
              anchor: a.range.from,
            },
          },
          at,
        },
        { op: "focus", id: shownCalendar.id, item: null, at },
      ]);
      return [shownCalendar.id];
    }
    // A read's single Surface is that query's dataset; a resource card is that resource's.
    const drafts = raw.map((d) => ({
      ...d,
      ...(query && d.type !== "approval" ? { query } : {}),
      ...(query && raw.length === 1 && d.type !== "approval"
        ? {
            dataset:
              d.type === "calendar" ? calendarDataset(query) : datasetKey(query.tool, query.args),
            ...(d.type === "task_list" ? { presentation: "list" as const } : {}),
          }
        : {}),
      ...(!query && d.ref && d.type !== "approval"
        ? { dataset: `${d.ref.resource}:${d.ref.id}` }
        : {}),
      ...(change ? { changedAt: at } : {}),
      ...(priority !== undefined && d.type !== "approval" ? { priority } : {}),
      ...(d.type === "calendar" && query?.tool === "calendar.listEvents"
        ? calendarIdentity(d.payload as CalendarPayload, query)
        : {}),
    }));
    this.apply([
      ...reconciled,
      ...(holder
        ? [
            {
              op: "update" as const,
              id: holder.id,
              patch: { changedAt: at, focusItem: change!.resourceId! },
              at,
            },
          ]
        : []),
      ...supersededOps(this.value, drafts, at),
      ...presentOps(drafts, at),
    ]);
    return holder
      ? [holder.id]
      : reconciled.length
        ? reconciled.map((o) => (o.op === "update" ? o.id : "")).filter(Boolean)
        : drafts.map((d) => d.id);
  }

  /**
   * After a successful write (ADR-029): every visible Surface that shows the changed resource is
   * reconciled — its own read re-run and its payload replaced in place (same id, pins kept,
   * Focus kept); a deleted resource's card leaves (and Focus with it); a collection that is now
   * empty has done its job and leaves, unless pinned or focused. Returns how many updated.
   */
  async reconcile(change: ResourceChange, read: ReadRunner): Promise<number> {
    const affected = affectedSurfaces(this.value, change);
    if (!affected.length) return 0;
    const at = new Date().toISOString();
    const results = await Promise.all(
      affected.map(async ({ surface, decision }): Promise<WorkspaceOp | null> => {
        if (decision === "dismiss") return { op: "dismiss", id: surface.id, at };
        const q = surface.query!;
        const outcome = await read(q).catch(() => null);
        // A refresh that fails keeps what was shown (never blanks a Surface on an error).
        if (!outcome || outcome.status !== "succeeded") return null;
        const drafts = surfacesFromOutcome(q.tool, outcome, {
          key: queryKey(q.tool, q.args),
          intentId: surface.intentId,
          locale: this.auth.profile?.locale,
          timezone: this.auth.profile?.timezone,
        });
        // A collection shown as a timeline or table keeps that form when it refreshes.
        const list = drafts.find((d) => d.type === "task_list");
        if (surface.presentation && surface.presentation !== "list" && list) {
          const spec = representTasks(
            list.payload as SurfacePayloads["task_list"],
            surface.presentation,
            {
              title: surface.title || (this.auth.profile?.locale === "en" ? "Tasks" : "Tareas"),
              locale: this.auth.profile?.locale ?? "es",
              today: todayIn(this.auth.profile?.timezone ?? "UTC"),
            },
          );
          return spec
            ? {
                op: "update",
                id: surface.id,
                patch: { payload: { spec }, state: "ready", members: memberIds(list.payload) },
                at,
              }
            : null;
        }
        const same = drafts.filter((d) => d.type === surface.type);
        const fresh =
          drafts.find((d) => d.id === surface.id) ?? (same.length === 1 ? same[0] : null);
        if (fresh)
          return {
            op: "update",
            id: surface.id,
            patch: {
              // A calendar keeps the view, date and filter the user chose (ADR-033).
              payload:
                surface.type === "calendar" && fresh.type === "calendar"
                  ? keepPresentation(
                      fresh.payload as CalendarPayload,
                      surface.payload as CalendarPayload,
                    )
                  : fresh.payload,
              title: fresh.title,
              state: "ready",
            },
            at,
          };
        const keep = surface.pinned || this.value.focusId === surface.id;
        return keep ? null : { op: "dismiss", id: surface.id, at };
      }),
    );
    const ops = results.filter((o): o is WorkspaceOp => o !== null);
    this.apply(ops);
    logger.info("workspace.reconciled", {
      capability: change.capability,
      operation: change.operation,
      updated: ops.filter((o) => o.op === "update").length,
      dismissed: ops.filter((o) => o.op === "dismiss").length,
    });
    return ops.filter((o) => o.op === "update").length;
  }

  flush() {
    return this.saving;
  }
}

/** A registered read (never a write, never a screen tool): the only kind a refresh may replay. */
export function isReadTool(tool: AnyToolDefinition | undefined): boolean {
  return (
    !!tool &&
    tool.capability !== "workspace" &&
    getOperation(tool.capability, tool.operation)?.kind === "read"
  );
}

/** Runs a Surface's read again (same tool, same arguments, the user's own permissions). */
export type ReadRunner = (query: SurfaceQuery) => Promise<ToolCallOutcome>;

/**
 * A Surface query is replayed only if it is a read of the registered tool; anything else
 * (a tampered stored workspace, a write) is refused, so a refresh can never change data.
 */
export function readRunner(
  run: (call: { name: string; args: unknown }) => Promise<ToolCallOutcome>,
  isRead: (toolName: string) => boolean,
): ReadRunner {
  return async (q) => {
    if (!isRead(q.tool))
      throw new AppError("VALIDATION_ERROR", "Only reads refresh a Surface", { recovery: "none" });
    return run({ name: q.tool, args: q.args });
  };
}

export async function openWorkspaceSession(auth: AuthContext, thread: ThreadRef, isNew: boolean) {
  const state = isNew ? emptyWorkspace() : await loadWorkspace(auth, thread);
  return new WorkspaceSession(auth, thread, state);
}

// ── Operations requested by the UI (same validation, same persistence) ──────

async function ownThread(auth: AuthContext, thread: ThreadRef) {
  if (thread.kind === "session") {
    await ownSession(auth, thread.id);
    return;
  }
  const { data } = await auth.db
    .from("conversations")
    .select("id")
    .eq("id", thread.id)
    .eq("user_id", auth.userId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Conversation not found");
}

async function mutate(
  auth: AuthContext,
  thread: ThreadRef,
  ops: (s: WorkspaceState) => WorkspaceOp[],
) {
  await ownThread(auth, thread);
  const before = await loadWorkspace(auth, thread);
  const list = ops(before);
  const after = applyOps(before, list);
  if (after !== before) {
    observe(before, after, thread);
    await saveWorkspace(auth, thread, after);
  }
  return after;
}

export type UserWorkspaceOp =
  | { op: "focus"; id: string | null; item?: string | null; compareWith?: string | null }
  /** The Live Canvas (ADR-021): the same view operations ELISE uses. */
  | { op: "pin"; id: string; pinned: boolean }
  | { op: "arrange"; order: "time" | "relevance" }
  /** The context indicator: switch to another profile, or clear it. */
  | { op: "context"; contextId: string | null }
  | { op: "dismiss"; id: string }
  | { op: "resize"; id: string; size: SurfaceSize }
  | { op: "approval_decided"; approvalId: string; decision: "approved" | "rejected" };

export async function applyUserOp(auth: AuthContext, thread: ThreadRef, op: UserWorkspaceOp) {
  const at = new Date().toISOString();
  // A context is checked against this workspace's own active profiles before it is used.
  const context =
    op.op === "context" && op.contextId ? await activeContextOf(auth, op.contextId, 0) : null;
  if (op.op === "context" && op.contextId && !context)
    throw new AppError("NOT_FOUND", "Context not found");
  if (context && op.op === "context")
    await associateInteraction(auth, context.id, thread, "activated");
  return mutate(auth, thread, (s) => {
    switch (op.op) {
      case "focus":
        return [
          {
            op: "focus",
            id: op.id,
            item: op.item ?? null,
            compareWith: op.compareWith ?? null,
            at,
          },
        ];
      case "pin":
        return [{ op: "pin", id: op.id, pinned: op.pinned, at }];
      case "arrange":
        return [{ op: "arrange", order: op.order, at }];
      case "dismiss":
        return [{ op: "dismiss", id: op.id, at }];
      case "resize": {
        const surface = s.surfaces.find((x) => x.id === op.id);
        if (
          !surface ||
          !SURFACE_SIZES.includes(op.size) ||
          !surfaceDefinition(surface.type).sizes.includes(op.size)
        )
          return [];
        return [{ op: "update", id: op.id, patch: { size: op.size }, at }];
      }
      case "approval_decided":
        return approvalDecidedOps(s, op.approvalId, op.decision, undefined, at);
      case "context":
        return [
          {
            op: "context",
            context: context
              ? { id: context.id, name: context.name, kind: context.kind, accent: context.accent }
              : null,
            at,
          },
        ];
    }
  });
}

/** Brings back a result from earlier in the thread, from the server's own stored copy. */
export async function presentFromHistory(
  auth: AuthContext,
  thread: ThreadRef,
  messageId: string,
  callId: string,
) {
  const { data } =
    thread.kind === "conversation"
      ? await auth.db
          .from("messages")
          .select("metadata")
          .eq("id", messageId)
          .eq("conversation_id", thread.id)
          .eq("role", "assistant")
          .maybeSingle()
      : await auth.db
          .from("interaction_turns")
          .select("metadata")
          .eq("id", messageId)
          .eq("session_id", thread.id)
          .eq("role", "assistant")
          .maybeSingle();
  const trace = ((data?.metadata ?? {}) as AssistantMessageMetadata).tools?.find(
    (t) => t.callId === callId,
  );
  if (!trace?.outcome) throw new AppError("NOT_FOUND", "That result is no longer available");
  const outcome = trace.outcome;
  const at = new Date().toISOString();
  let focus: string | null = null;
  const state = await mutate(auth, thread, (s) => {
    const drafts = surfacesFromOutcome(trace.name, outcome, {
      key: callId,
      intentId: s.intent?.id ?? null,
      locale: auth.profile.locale,
      timezone: auth.profile.timezone,
    });
    focus = drafts[0]?.id ?? null;
    return [...presentOps(drafts, at), ...(focus ? [{ op: "focus" as const, id: focus, at }] : [])];
  });
  return state;
}

/**
 * Reconciles a saved workspace with changes made outside a turn (ADR-029): a Surface action,
 * another tab, the Approval Center, a background job. Each visible collection that depends on
 * a changed capability re-runs its own read; nothing else moves.
 */
export async function refreshWorkspace(
  auth: AuthContext,
  thread: ThreadRef,
  changes: ResourceChange[],
): Promise<WorkspaceState> {
  await ownThread(auth, thread);
  const session = new WorkspaceSession(auth, thread, await loadWorkspace(auth, thread));
  const ports = createExecutorPorts(auth);
  const read = readRunner(
    (call) =>
      executeToolCall(
        ports,
        {
          ...toolContext(auth, "user_ui", null, thread),
          workspace: { state: () => session.state(), apply: () => 0, activity: () => {} },
        },
        call,
      ),
    (name) => isReadTool(ports.registry.get(name)),
  );
  for (const change of changes) await session.reconcile(change, read);
  await session.flush();
  return session.state();
}

/** Runs a Surface's direct action: the registry builds the call, the executor decides. */
export async function runSurfaceAction(
  auth: AuthContext,
  thread: ThreadRef,
  surfaceId: string,
  action: ActionId,
  itemId: string | null,
): Promise<{ state: WorkspaceState; outcome: ClientToolOutcome }> {
  await ownThread(auth, thread);
  const current = await loadWorkspace(auth, thread);
  const surface = current.surfaces.find((s) => s.id === surfaceId);
  if (!surface) throw new AppError("NOT_FOUND", "That item is no longer shown");
  const call = toolForAction(surface, action, itemId);
  if (!call)
    throw new AppError("VALIDATION_ERROR", "That action isn't available here", {
      recovery: "review",
    });

  const ports = createExecutorPorts(auth);
  // Tools may present several Surfaces (a study answer updates the question and the
  // progress): collect them here and apply them with the result, like during a turn.
  const collected: WorkspaceOp[] = [];
  const port: WorkspacePort = {
    state: () => applyOps(current, collected),
    apply: (ops) => void collected.push(...ops),
    activity: () => undefined,
  };
  const outcome = await executeToolCall(
    ports,
    {
      ...toolContext(auth, "user_ui", null, thread),
      workspace: port,
      context: current.context
        ? { id: current.context.id, name: current.context.name, kind: current.context.kind }
        : null,
    },
    { name: call.name, args: call.args },
  );
  logger.info("workspace.surface_action", { type: surface.type, action, status: outcome.status });
  // The write is reflected in every visible collection that shows it, recomputed (ADR-029).
  const tool = ports.registry.get(call.name);
  const op = tool ? getOperation(tool.capability, tool.operation) : undefined;
  const change =
    tool && op ? changeOf(call.name, { name: tool.operation, kind: op.kind }, outcome) : null;
  const at = new Date().toISOString();
  const state = await mutate(auth, thread, (s) => {
    const reconciled = reconcileOps(s, outcome, at);
    return [
      ...collected,
      ...(reconciled.length
        ? reconciled
        : presentOps(
            surfacesFromOutcome(call.name, outcome, {
              key: `${surfaceId}:${action}`,
              intentId: s.intent?.id ?? null,
              locale: auth.profile.locale,
              timezone: auth.profile.timezone,
            }),
            at,
          )),
    ];
  });
  return {
    state: change ? await refreshWorkspace(auth, thread, [change]) : state,
    outcome: toClientOutcome(outcome),
  };
}

export function toClientOutcome(outcome: ToolCallOutcome): ClientToolOutcome {
  switch (outcome.status) {
    case "succeeded":
      return { status: "succeeded", display: outcome.display };
    case "approval_required":
      return {
        status: "approval_required",
        approvalId: outcome.approvalId,
        summary: outcome.summary,
        reason: outcome.reason,
        preview: outcome.preview,
      };
    case "clarification_required":
      return { status: "clarification_required" };
    case "rejected":
      return { status: "rejected" };
    case "failed":
      return { status: "failed", error: outcome.error };
  }
}

export type SurfaceDetail =
  | { kind: "display"; display: ToolDisplay }
  | { kind: "turns"; turns: { at: string; who: "user" | "ELISE"; text: string }[] }
  | { kind: "text"; text: string }
  | { kind: "error"; error: ReturnType<typeof toPublicError> };

/**
 * Detail loaded only when a Surface is opened (never stored): the full thread, the
 * conversation around a recalled moment, or a document's text. Reads go through the executor.
 */
export async function loadSurfaceDetail(
  auth: AuthContext,
  thread: ThreadRef,
  surfaceId: string,
  itemId: string | null,
): Promise<SurfaceDetail> {
  await ownThread(auth, thread);
  const state = await loadWorkspace(auth, thread);
  const surface = state.surfaces.find((s) => s.id === surfaceId);
  if (!surface) throw new AppError("NOT_FOUND", "That item is no longer shown");
  const ports = createExecutorPorts(auth);
  const ctx = toolContext(auth, "user_ui", null, thread);
  const read = async (name: string, args: unknown) => {
    const o = await executeToolCall(ports, ctx, { name, args });
    if (o.status !== "succeeded")
      throw o.status === "failed"
        ? new AppError(o.error.code, o.error.message)
        : new AppError("PERMISSION_DENIED", "Not allowed");
    return o;
  };
  try {
    const ref = pickRef(surface.type, surface.ref, surface.payload, itemId);
    if (ref?.resource === "email_thread") {
      const o = await read("email.getThread", { threadId: ref.id });
      if (o.status === "succeeded" && o.display) return { kind: "display", display: o.display };
    }
    if (ref?.resource === "interaction") {
      const o = await read("history.getContext", { interaction: ref.id, turns: 10 });
      const out = (o.status === "succeeded" ? o.output : null) as {
        untrustedTurns?: { at: string; who: "user" | "ELISE"; text: string }[];
      } | null;
      return { kind: "turns", turns: out?.untrustedTurns ?? [] };
    }
    if (ref?.resource === "web_page") {
      // Read again through the same safe fetcher (cached briefly); the text is untrusted.
      const page = await webCapability(auth).open(ref.id);
      return { kind: "text", text: page.text.slice(0, 6000) };
    }
    if (ref?.resource === "knowledge_item") {
      const reader = new SupabaseKnowledgeReader(auth.db, auth.workspaceId, getEmbeddingProvider);
      const version = await reader.versionText(ref.id, null);
      if (!version) throw new AppError("NOT_FOUND", "Document not found");
      return { kind: "text", text: version.text.slice(0, 6000) };
    }
    throw new AppError("VALIDATION_ERROR", "Nothing more to load");
  } catch (error) {
    return { kind: "error", error: toPublicError(error) };
  }
}

/** Which resource an item of a Surface refers to (validated against the Surface's own payload). */
function pickRef(
  type: string,
  ref: SurfaceRef | null,
  payload: unknown,
  itemId: string | null,
): SurfaceRef | null {
  if (type === "email_list") {
    const p = payload as SurfacePayloads["email_list"];
    const item = p.items.find((i) => i.threadId === itemId);
    return item ? { resource: "email_thread", id: item.threadId } : null;
  }
  if (type === "recall") {
    const p = payload as SurfacePayloads["recall"];
    const r = p.results.find((i) => i.interactionId === itemId) ?? p.results[0];
    return r ? { resource: "interaction", id: r.interactionId } : null;
  }
  if (type === "web_results" && itemId) {
    const p = payload as SurfacePayloads["web_results"];
    return p.results.some((r) => r.url === itemId) ? { resource: "web_page", id: itemId } : null;
  }
  if (type === "knowledge_result") {
    const p = payload as SurfacePayloads["knowledge_result"];
    const s = p.sources.find((i) => i.itemId === itemId);
    return s ? { resource: "knowledge_item", id: s.itemId } : null;
  }
  return ref;
}

/** Home's quiet "Resume" line: the latest workspace still active (not expired, with Surfaces). */
export async function activeWorkspace(auth: AuthContext) {
  const { data } = await auth.db
    .from("live_workspaces")
    .select("conversation_id, session_id, intent, surfaces, updated_at, expires_at")
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .gt("expires_at", new Date().toISOString())
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || Date.now() - Date.parse(data.updated_at) > 2 * 3_600_000) return null;
  const state = parseWorkspace({ intent: data.intent, surfaces: data.surfaces });
  if (!state.surfaces.length || !state.intent) return null;
  const thread: ThreadRef = data.conversation_id
    ? { kind: "conversation", id: data.conversation_id }
    : { kind: "session", id: data.session_id! };
  return {
    thread,
    description: state.intent.description,
    kind: state.intent.kind,
  };
}

/**
 * Background work finished (e.g. an approved Structured bulk change): Surfaces pointing to it
 * update in place; open browsers see it through Realtime.
 */
export async function markResourceSurfaces(
  workspaceId: string,
  resource: SurfaceRef["resource"],
  id: string,
  patch: (surface: WorkspaceState["surfaces"][number]) => {
    state: "ready" | "error";
    payload?: unknown;
  },
) {
  const db = createAdminClient();
  const { data } = await db
    .from("live_workspaces")
    .select("id, intent, surfaces, focus_id, turn, next_handle, version")
    .eq("workspace_id", workspaceId)
    .contains("surfaces", [{ ref: { resource, id } }])
    .limit(20);
  for (const row of data ?? []) {
    const state = fromRow(row);
    const at = new Date().toISOString();
    const next = applyOps(
      state,
      state.surfaces
        .filter((s) => s.ref?.resource === resource && s.ref.id === id)
        .map((s) => ({ op: "update" as const, id: s.id, patch: patch(s), at })),
    );
    if (next !== state)
      await db
        .from("live_workspaces")
        .update({
          surfaces: next.surfaces as unknown as Json,
          version: next.version,
          updated_at: at,
        })
        .eq("id", row.id)
        .eq("workspace_id", workspaceId);
  }
}

/**
 * One calendar on the Canvas (ADR-033): any range or calendar filter of the user's events is the
 * same dataset, so "la semana que viene" or "solo trabajo" replaces the visible calendar in place.
 * A text search ("cuándo tengo X") is its own result.
 */
export function calendarDataset(query: SurfaceQuery): string {
  return query.args.search ? datasetKey(query.tool, query.args) : "calendar";
}

/**
 * The Calendar Surface's own controls (view, date, previous/today/next, calendar filter):
 * presentation only, unless the new view needs days that aren't loaded — then the Surface's own
 * read runs again for exactly that range (never once per event) and updates it in place.
 */
export async function calendarViewOp(
  auth: AuthContext,
  thread: ThreadRef,
  op: { id: string } & CalendarChange,
): Promise<WorkspaceState> {
  await ownThread(auth, thread);
  const ports = createExecutorPorts(auth);
  const current = async () =>
    ((await loadWorkspace(auth, thread)).surfaces.find(
      (s) => s.id === op.id && s.type === "calendar",
    )?.payload as CalendarPayload | undefined) ?? null;
  const start = await current();
  if (!start) throw new AppError("NOT_FOUND", "That calendar is no longer shown");
  // The same path as "Ponelo en vista anual" (ui.show): one application state, not two.
  const done = await changeCalendar({
    current,
    change: op,
    today: todayIn(auth.profile.timezone),
    // Numbered on arrival: a later click always wins over an earlier one still reading.
    seq: nextSeq(start),
    read: (args) =>
      executeToolCall(
        ports,
        {
          ...toolContext(auth, "user_ui", null, thread),
          workspace: { state: () => emptyWorkspace(), apply: () => 0, activity: () => {} },
        },
        { name: "calendar.listEvents", args },
      ),
  });
  if (!done) throw new AppError("NOT_FOUND", "That calendar is no longer shown");
  // Settled against the state right before writing: a click answered late never undoes a newer
  // one already saved (ponytail: load→save is not atomic; a versioned write if it ever matters).
  const before = await loadWorkspace(auth, thread);
  const latest = before.surfaces.find((s) => s.id === op.id)?.payload as
    CalendarPayload | undefined;
  if (!latest) throw new AppError("NOT_FOUND", "That calendar is no longer shown");
  const { payload, query } = done.settle(latest);
  if (done.read !== "none")
    logger.info("calendar.range_read", {
      status: done.read,
      applied: payload.seq === latest.seq ? "data_only" : "presentation",
    });
  const after = applyOps(before, [
    {
      op: "update",
      id: op.id,
      patch: { payload, query, state: "ready" },
      at: new Date().toISOString(),
    },
  ]);
  await saveWorkspace(auth, thread, after);
  if (done.read === "failed")
    throw new AppError("PROVIDER_UNAVAILABLE", "Couldn't read those days of the calendar", {
      recovery: "retry",
    });
  return after;
}

/**
 * A calendar read on the Canvas (ADR-033): its data scope (one calendar or all) and the query
 * that refreshes everything it has loaded — at the read limit, never the tool's default.
 */
function calendarIdentity(p: CalendarPayload, query: SurfaceQuery) {
  const scope = typeof query.args.calendar === "string" ? query.args.calendar : "all";
  const payload = { ...p, scope };
  return {
    payload,
    query: { tool: query.tool, args: rangeArgs(refreshRange(payload), scope) },
  };
}

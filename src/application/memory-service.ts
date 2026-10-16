import "server-only";

import { AppError } from "@/core/errors";
import {
  activeFacts,
  editFact,
  forget,
  prune,
  remember,
  type MemoryFact,
  type RememberInput,
  type RememberResult,
} from "@/core/memory/model";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Memory (ADR-068): per person, in their own preferences rows (RLS: only they read them).
 * `memory.enabled` is the switch; `memory.facts` the facts with their provenance. Off means
 * ELISE neither reads nor adds facts — what's saved stays until they delete it.
 */
const ENABLED = "memory.enabled";
const FACTS = "memory.facts";

export interface MemoryState {
  enabled: boolean;
  facts: MemoryFact[];
}

async function read(auth: AuthContext): Promise<{ enabled: boolean; facts: MemoryFact[] }> {
  const { data, error } = await auth.db
    .from("user_preferences")
    .select("key, value_json")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .in("key", [ENABLED, FACTS]);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load memory", { cause: error });
  const row = (key: string) => data.find((r) => r.key === key)?.value_json;
  const enabled = row(ENABLED);
  const facts = row(FACTS);
  return {
    // On unless the person turned it off.
    enabled: typeof enabled === "boolean" ? enabled : true,
    facts: Array.isArray(facts) ? (facts as unknown as MemoryFact[]) : [],
  };
}

async function write(auth: AuthContext, key: string, value: Json) {
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key,
      value_json: value,
      source: "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save memory", { cause: error });
}

const saveFacts = (auth: AuthContext, facts: MemoryFact[]) =>
  write(auth, FACTS, facts as unknown as Json);

/** Conversations that still exist (not deleted) among those a fact cites. */
async function liveConversations(auth: AuthContext, facts: MemoryFact[]): Promise<Set<string>> {
  const ids = [...new Set(facts.flatMap((f) => f.sources))];
  if (!ids.length) return new Set();
  const { data } = await auth.db
    .from("conversations")
    .select("id")
    .in("id", ids)
    .is("archived_at", null);
  return new Set((data ?? []).map((r) => r.id));
}

/** The facts, with evidence from deleted conversations removed (and saved when it changed). */
export async function getMemory(auth: AuthContext): Promise<MemoryState> {
  const state = await read(auth);
  const pruned = prune(state.facts, await liveConversations(auth, state.facts));
  if (JSON.stringify(pruned) !== JSON.stringify(state.facts)) await saveFacts(auth, pruned);
  return { enabled: state.enabled, facts: activeFacts(pruned) };
}

/** What a turn may use: nothing when Memory is off. Never throws (a turn works without it). */
export async function memoryForContext(
  auth: AuthContext,
): Promise<{ key: string; value: string }[]> {
  try {
    const m = await getMemory(auth);
    return m.enabled ? m.facts.map(({ key, value }) => ({ key, value })) : [];
  } catch {
    return [];
  }
}

export async function setMemoryEnabled(auth: AuthContext, enabled: boolean) {
  await write(auth, ENABLED, enabled);
}

export async function rememberFact(
  auth: AuthContext,
  input: RememberInput,
): Promise<RememberResult> {
  const state = await read(auth);
  if (!state.enabled)
    throw new AppError(
      "PERMISSION_DENIED",
      "Memory is off in Settings › Memoria. Don't save it; offer to turn it on only if the user asks.",
      { recovery: "review" },
    );
  const result = remember(state.facts, input, new Date().toISOString(), crypto.randomUUID());
  if (!result.kept) await saveFacts(auth, result.facts);
  return result;
}

export async function editMemoryFact(auth: AuthContext, id: string, value: string) {
  const state = await read(auth);
  await saveFacts(auth, editFact(state.facts, id, value, new Date().toISOString()));
}

/** Removes a fact (by id or key); returns how many went. */
export async function forgetFact(auth: AuthContext, idOrKey: string): Promise<number> {
  const state = await read(auth);
  const next = forget(state.facts, idOrKey);
  if (next.length !== state.facts.length) await saveFacts(auth, next);
  return state.facts.length - next.length;
}

export async function clearMemory(auth: AuthContext) {
  await saveFacts(auth, []);
}

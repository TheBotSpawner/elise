import "server-only";

import { createHash, createHmac } from "node:crypto";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import {
  EXTRACTOR_VERSION,
  fingerprint,
  isSuppressed,
  type Hasher,
  type SuppressionPrint,
} from "@/core/memory/extraction";
import {
  activeFacts,
  editFact,
  learningConsent,
  liveProfile,
  MAX_ACTIVE_FACTS,
  memoryKey,
  prune,
  remember,
  selectContextFacts,
  type MemoryChange,
  type MemoryContext,
  type MemoryFact,
  type ProfileLine,
  type RememberInput,
} from "@/core/memory/model";
import { resolveProfiles } from "@/infrastructure/ai/profiles";
import { modelPrice } from "@/infrastructure/observability/usage";
import type { Json, MemoryFactRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Memory (ADR-068, ADR-107): per person, private (RLS), in `memory_facts`. One service for
 * every surface — chat, voice, Desktop, scheduled runs, Settings — and for both clients: the
 * person's own (RLS) and the server's (background learning, always scoped to one person).
 *
 * `memory.enabled` (user_preferences) is the switch: off means ELISE neither reads nor adds
 * facts. `memory.learning` is the separate opt-in to learn from conversations.
 */
const ENABLED = "memory.enabled";
const LEARNING = "memory.learning";
/** ADR-068's JSON copy, read only while migration 062 isn't applied yet. */
const LEGACY_FACTS = "memory.facts";

type Db = AuthContext["db"];

export interface LearningSettings {
  /** The person opted in (and since when: nothing before it is ever read). */
  on: boolean;
  since: string | null;
  /** Learning can run here: the rollout switch is on and the model's price is known. */
  available: boolean;
  unavailable: "rollout" | "unpriced" | "upgrading" | null;
}

export interface MemoryState {
  enabled: boolean;
  learning: LearningSettings;
  facts: MemoryFact[];
  profile: ProfileLine[];
  /** This month's background memory spend and its cap, USD. */
  spend: { usd: number; cap: number };
  /** Migration 062 isn't applied: facts are read from the old copy and can't change. */
  upgrading: boolean;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export const toFact = (r: MemoryFactRow): MemoryFact => ({
  id: r.id,
  key: r.key,
  value: r.value,
  category: r.category,
  provenance: r.provenance,
  certainty: Number(r.certainty),
  status: r.status,
  sources: r.sources ?? [],
  corroborations: r.corroborations,
  observedAt: r.observed_at,
  lastConfirmedAt: r.last_confirmed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  learned: Boolean(r.extractor),
});

const missingTable = (error: { code?: string; message?: string } | null) =>
  Boolean(
    error &&
    (error.code === "42P01" ||
      error.code === "PGRST205" ||
      /memory_(facts|profiles|suppressions|spend)/.test(error.message ?? "")),
  );

class UpgradingError extends Error {}

function fail(error: { code?: string; message?: string } | null, what: string): never {
  if (missingTable(error)) throw new UpgradingError(what);
  throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

const upgrading = () =>
  new AppError(
    "CAPABILITY_UNAVAILABLE",
    "Memory is being upgraded and can't change right now. Tell the user to try again later.",
    { recovery: "retry" },
  );

/** The do-not-relearn hash, keyed on the server and per person (prints never compare across people). */
export function printHasher(userId: string): Hasher {
  const env = serverEnv();
  const key =
    env.MEMORY_FINGERPRINT_KEY ??
    (env.ELISE_ENCRYPTION_KEY
      ? createHash("sha256").update(`elise-memory-print:${env.ELISE_ENCRYPTION_KEY}`).digest("hex")
      : null);
  return (text) =>
    key
      ? createHmac("sha256", key).update(`${userId}:${text}`).digest("hex")
      : createHash("sha256").update(`elise-memory:${userId}:${text}`).digest("hex");
}

/**
 * One person's memory through a given client: their own (RLS) or the server's for background
 * work. Every statement is scoped to the workspace and the person.
 */
export function memoryRepo(db: Db, workspaceId: string, userId: string) {
  const mine = <Q extends { eq: (c: string, v: string) => Q }>(q: Q) =>
    q.eq("workspace_id", workspaceId).eq("user_id", userId);
  const hash = printHasher(userId);

  const repo = {
    async all(): Promise<MemoryFact[]> {
      const { data, error } = await mine(db.from("memory_facts").select("*"));
      if (error) fail(error, "load memory");
      return (data ?? []).map(toFact);
    },
    async active(): Promise<MemoryFact[]> {
      const { data, error } = await mine(db.from("memory_facts").select("*")).eq(
        "status",
        "active",
      );
      if (error) fail(error, "load memory");
      return (data ?? []).map(toFact);
    },
    async current(key: string): Promise<MemoryFact | null> {
      const { data, error } = await mine(db.from("memory_facts").select("*"))
        .eq("key", key)
        .eq("status", "active")
        .maybeSingle();
      if (error) fail(error, "load memory");
      return data ? toFact(data) : null;
    },

    /** Applies remember(); retried once if another write got there first. */
    async remember(input: RememberInput, attempt = 0): Promise<MemoryChange | "full"> {
      const key = memoryKey(input.key);
      const current = await repo.current(key);
      const change = remember(current, input, new Date().toISOString(), crypto.randomUUID());
      try {
        if (change.kind === "kept") return change;
        if (change.kind === "confirm") {
          const f = change.fact;
          const { error } = await mine(db.from("memory_facts").update(updateRow(f))).eq("id", f.id);
          if (error) fail(error, "save memory");
          return change;
        }
        if (change.kind === "insert") {
          const { count } = await mine(
            db.from("memory_facts").select("id", { count: "exact", head: true }),
          ).eq("status", "active");
          if ((count ?? 0) >= MAX_ACTIVE_FACTS) return "full";
        } else {
          // Only if it's still the current value: a concurrent change makes this run again.
          const { data, error } = await mine(
            db.from("memory_facts").update({ status: "superseded" }),
          )
            .eq("id", change.replaced.id)
            .eq("status", "active")
            .select("id");
          if (error) fail(error, "save memory");
          if (!data?.length) throw Object.assign(new Error("raced"), { code: "23505" });
        }
        const { error } = await db.from("memory_facts").insert({
          ...updateRow(change.fact),
          id: change.fact.id,
          workspace_id: workspaceId,
          user_id: userId,
          key: change.fact.key,
          status: "active",
          extractor: input.learned ? learnedBy() : null,
          observed_at: change.fact.observedAt,
        });
        if (error) {
          if (error.code === "23505") throw error;
          fail(error, "save memory");
        }
        return change;
      } catch (error) {
        if ((error as { code?: string }).code === "23505" && attempt < 2)
          return repo.remember(input, attempt + 1);
        throw error;
      }
    },

    async edit(id: string, value: string) {
      const { data, error } = await mine(db.from("memory_facts").select("*"))
        .eq("id", id)
        .maybeSingle();
      if (error) fail(error, "load memory");
      if (!data)
        throw new AppError("NOT_FOUND", "That memory no longer exists", { recovery: "review" });
      const f = editFact(toFact(data), value, new Date().toISOString());
      const { error: e2 } = await mine(db.from("memory_facts").update(updateRow(f))).eq("id", id);
      if (e2) fail(e2, "save memory");
      await repo.allowKey(f.key);
    },

    /**
     * Forgets a fact — by id or by key — with every earlier value of it, leaves fingerprints
     * so it isn't learned again, and drops profile lines that mention it. Returns how many rows
     * went and which interactions had supported it (they stay in History until deleted there).
     */
    async forget(idOrKey: string): Promise<{ forgotten: number; sources: string[] }> {
      const { data: byId } = /^[0-9a-f-]{36}$/i.test(idOrKey)
        ? await mine(db.from("memory_facts").select("key")).eq("id", idOrKey).maybeSingle()
        : { data: null };
      let key: string;
      try {
        key = byId?.key ?? memoryKey(idOrKey);
      } catch {
        return { forgotten: 0, sources: [] };
      }
      const { data: rows, error } = await mine(db.from("memory_facts").select("*")).eq("key", key);
      if (error) fail(error, "load memory");
      if (!rows?.length) return { forgotten: 0, sources: [] };
      await repo.suppress(rows.map((r) => fingerprint(r.key, r.value, hash)));
      const { error: e2 } = await mine(db.from("memory_facts").delete()).eq("key", key);
      if (e2) fail(e2, "forget memory");
      await repo.trimProfile();
      return { forgotten: rows.length, sources: [...new Set(rows.flatMap((r) => r.sources))] };
    },

    async clear() {
      const facts = await repo.all();
      if (facts.length) await repo.suppress(facts.map((f) => fingerprint(f.key, f.value, hash)));
      const { error } = await mine(db.from("memory_facts").delete());
      if (error) fail(error, "clear memory");
      await mine(db.from("memory_profiles").delete());
    },

    async suppress(prints: SuppressionPrint[]) {
      const seen = new Set<string>();
      const rows = prints
        .filter((p) => !seen.has(p.valueHash) && seen.add(p.valueHash))
        .map((p) => ({
          workspace_id: workspaceId,
          user_id: userId,
          key_hash: p.keyHash,
          value_hash: p.valueHash,
          word_hashes: p.wordHashes,
        }));
      if (!rows.length) return;
      const { error } = await db.from("memory_suppressions").upsert(rows, {
        onConflict: "workspace_id,user_id,key_hash,value_hash",
        ignoreDuplicates: true,
      });
      if (error) fail(error, "forget memory");
    },
    async prints(): Promise<SuppressionPrint[]> {
      const { data, error } = await mine(
        db.from("memory_suppressions").select("key_hash, value_hash, word_hashes"),
      );
      if (error) fail(error, "load memory");
      return (data ?? []).map((r) => ({
        keyHash: r.key_hash,
        valueHash: r.value_hash,
        wordHashes: r.word_hashes,
      }));
    },
    /** The person asked for this key again, explicitly: earlier "forget" no longer blocks it. */
    async allowKey(key: string) {
      const { keyHash } = fingerprint(key, "", hash);
      await mine(db.from("memory_suppressions").delete()).eq("key_hash", keyHash);
    },
    async suppressed(key: string, value: string) {
      return isSuppressed(key, value, await repo.prints(), hash);
    },

    async profile(): Promise<{ lines: ProfileLine[]; version: number; at: string | null }> {
      const { data, error } = await mine(
        db.from("memory_profiles").select("lines, version, generated_at"),
      ).maybeSingle();
      if (error) fail(error, "load memory");
      return {
        lines: Array.isArray(data?.lines) ? (data.lines as unknown as ProfileLine[]) : [],
        version: data?.version ?? 0,
        at: data?.generated_at ?? null,
      };
    },
    async saveProfile(lines: ProfileLine[], extractor: string | null) {
      const prev = await repo.profile();
      const { error } = await db.from("memory_profiles").upsert(
        {
          workspace_id: workspaceId,
          user_id: userId,
          version: prev.version + 1,
          lines: lines as unknown as Json,
          extractor,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,user_id" },
      );
      if (error) fail(error, "save memory");
    },
    /** Drops profile lines that cite facts no longer active (after forgetting or pruning). */
    async trimProfile() {
      const p = await repo.profile();
      if (!p.lines.length) return;
      const ids = new Set((await repo.active()).map((f) => f.id));
      const kept = liveProfile(p.lines, ids);
      if (kept.length === p.lines.length) return;
      const { error } = await mine(
        db
          .from("memory_profiles")
          .update({ lines: kept as unknown as Json, version: p.version + 1 }),
      );
      if (error) fail(error, "save memory");
    },

    /** Evidence from deleted interactions leaves; an inference left without any is forgotten. */
    async prune(facts: MemoryFact[]): Promise<MemoryFact[]> {
      const ids = [...new Set(facts.flatMap((f) => f.sources))];
      if (!ids.length) return facts;
      const [conversations, sessions] = await Promise.all([
        db.from("conversations").select("id").in("id", ids).is("archived_at", null),
        db.from("interaction_sessions").select("id").in("id", ids).eq("status", "active"),
      ]);
      // A failed lookup never forgets anything.
      if (conversations.error || sessions.error) return facts;
      const live = new Set([
        ...(conversations.data ?? []).map((r) => r.id),
        ...(sessions.data ?? []).map((r) => r.id),
      ]);
      const kept: MemoryFact[] = [];
      let dropped = false;
      for (const f of facts) {
        const p = prune(f, live);
        if (p.kind === "keep") kept.push(f);
        else if (p.kind === "update") {
          await mine(db.from("memory_facts").update({ sources: p.sources })).eq("id", f.id);
          kept.push({ ...f, sources: p.sources });
        } else {
          await mine(db.from("memory_facts").delete()).eq("id", f.id);
          dropped = true;
        }
      }
      if (dropped) await repo.trimProfile();
      return kept;
    },
  };
  return repo;
}

const updateRow = (f: MemoryFact) => ({
  value: f.value,
  category: f.category,
  provenance: f.provenance,
  certainty: f.certainty,
  sources: f.sources,
  corroborations: f.corroborations,
  last_confirmed_at: f.lastConfirmedAt,
});

const learnedBy = () => `${resolveProfiles(serverEnv()).background.model}@${EXTRACTOR_VERSION}`;

// ── Settings: the switch, learning consent, spend ────────────────────────────

async function preferences(db: Db, workspaceId: string, userId: string) {
  const { data, error } = await db
    .from("user_preferences")
    .select("key, value_json")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .in("key", [ENABLED, LEARNING, LEGACY_FACTS]);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load memory", { cause: error });
  const row = (key: string) => data.find((r) => r.key === key)?.value_json;
  const enabled = row(ENABLED);
  const learning = learningConsent(row(LEARNING));
  return {
    // On unless the person turned it off (both switches).
    enabled: typeof enabled === "boolean" ? enabled : true,
    learningOn: learning.on,
    since: learning.since,
    legacy: row(LEGACY_FACTS),
  };
}

/** Whether learning can run in this deployment, and why not. */
export function learningAvailability(): Pick<LearningSettings, "available" | "unavailable"> {
  const env = serverEnv();
  if (env.MEMORY_LEARNING !== "on") return { available: false, unavailable: "rollout" };
  if (!modelPrice(resolveProfiles(env).background.model))
    return { available: false, unavailable: "unpriced" };
  return { available: true, unavailable: null };
}

/** Consent and switches for one person, read with any client (background jobs included). */
export async function learningState(db: Db, workspaceId: string, userId: string) {
  const p = await preferences(db, workspaceId, userId);
  const on = p.enabled && p.learningOn && learningAvailability().available;
  if (!on || p.since) return { on, since: p.since };
  // On by default and checked for the first time: learning starts now, never earlier.
  const since = new Date().toISOString();
  const { error } = await db.from("user_preferences").upsert(
    {
      workspace_id: workspaceId,
      user_id: userId,
      key: LEARNING,
      value_json: { on: true, since, version: 1, default: true },
      source: "system",
    },
    { onConflict: "workspace_id,user_id,key", ignoreDuplicates: true },
  );
  if (error) return { on: false, since: null };
  const again = await preferences(db, workspaceId, userId);
  return { on: again.learningOn, since: again.since };
}

async function writePref(auth: AuthContext, key: string, value: Json) {
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

export async function setMemoryEnabled(auth: AuthContext, enabled: boolean) {
  await writePref(auth, ENABLED, enabled);
}

/**
 * Learning from conversations: opting in starts *now* (earlier conversations are never read);
 * opting out stops every queued or running job from keeping anything. Facts stay.
 */
export async function setLearning(auth: AuthContext, on: boolean) {
  if (on && !learningAvailability().available)
    throw new AppError("CAPABILITY_UNAVAILABLE", "Learning isn't available yet", {
      recovery: "configure",
    });
  await writePref(
    auth,
    LEARNING,
    on
      ? { on: true, since: new Date().toISOString(), version: 1 }
      : { on: false, since: null, offAt: new Date().toISOString() },
  );
}

async function monthSpend(auth: AuthContext): Promise<number> {
  const month = `${new Date().toISOString().slice(0, 7)}-01`;
  const { data } = await auth.db
    .from("memory_spend")
    .select("estimated_usd, actual_usd, status")
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .eq("month", month);
  return (data ?? [])
    .filter((r) => r.status !== "released")
    .reduce((s, r) => s + Number(r.actual_usd ?? r.estimated_usd), 0);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** ADR-068's facts while migration 062 isn't applied: read only, as they were. */
function legacyFacts(raw: unknown): MemoryFact[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).flatMap((f) => {
    if (typeof f.key !== "string" || typeof f.value !== "string" || typeof f.id !== "string")
      return [];
    const sources = Array.isArray(f.sources) ? (f.sources as string[]) : [];
    const inferred = f.confidence === "inferred";
    const at = typeof f.updatedAt === "string" ? f.updatedAt : new Date(0).toISOString();
    return [
      {
        id: f.id,
        key: f.key,
        value: f.value,
        category: "fact" as const,
        provenance: inferred ? "inferred" : sources.length ? "user_explicit" : "user_settings",
        certainty: inferred ? 0.6 : 1,
        status: f.status === "superseded" ? "superseded" : "active",
        sources,
        corroborations: 1,
        observedAt: at,
        lastConfirmedAt: typeof f.lastConfirmedAt === "string" ? f.lastConfirmedAt : at,
        createdAt: at,
        updatedAt: at,
        learned: false,
      } satisfies MemoryFact,
    ];
  });
}

/** Everything Settings › Memoria shows, with evidence from deleted interactions removed. */
export async function getMemory(auth: AuthContext): Promise<MemoryState> {
  const p = await preferences(auth.db, auth.workspaceId, auth.userId);
  const learning = {
    on: p.learningOn,
    since: p.since,
    ...learningAvailability(),
  };
  const cap = serverEnv().MEMORY_USER_MONTHLY_USD;
  const repo = memoryRepo(auth.db, auth.workspaceId, auth.userId);
  try {
    const facts = activeFacts(await repo.prune(await repo.active()));
    const [profile, usd] = await Promise.all([repo.profile(), monthSpend(auth)]);
    const ids = new Set(facts.map((f) => f.id));
    return {
      enabled: p.enabled,
      learning,
      facts,
      profile: liveProfile(profile.lines, ids),
      spend: { usd, cap },
      upgrading: false,
    };
  } catch (error) {
    if (!(error instanceof UpgradingError)) throw error;
    return {
      enabled: p.enabled,
      learning: { ...learning, on: false, available: false, unavailable: "upgrading" },
      facts: activeFacts(legacyFacts(p.legacy)),
      profile: [],
      spend: { usd: 0, cap },
      upgrading: true,
    };
  }
}

/**
 * What a turn, a voice session or a brief may use (ADR-107): nothing when Memory is off; the
 * facts relevant to `message` (never a dump) and the short profile. Never throws: they all work
 * without memory.
 */
export async function memoryForContext(auth: AuthContext, message = ""): Promise<MemoryContext> {
  try {
    const m = await getMemory(auth);
    if (!m.enabled) return { facts: [], profile: [] };
    return {
      facts: selectContextFacts(m.facts, message),
      profile: m.profile.map((l) => l.text),
    };
  } catch {
    return { facts: [], profile: [] };
  }
}

// ── Writing (the person, or ELISE for them in a conversation) ────────────────

function writable<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    if (error instanceof UpgradingError) throw upgrading();
    throw error;
  });
}

export async function rememberFact(auth: AuthContext, input: RememberInput): Promise<MemoryChange> {
  const p = await preferences(auth.db, auth.workspaceId, auth.userId);
  if (!p.enabled)
    throw new AppError(
      "PERMISSION_DENIED",
      "Memory is off in Settings › Memoria. Don't save it; offer to turn it on only if the user asks.",
      { recovery: "review" },
    );
  return writable(async () => {
    const repo = memoryRepo(auth.db, auth.workspaceId, auth.userId);
    const change = await repo.remember(input);
    if (change === "full")
      throw new AppError(
        "VALIDATION_ERROR",
        `Memory is full (${MAX_ACTIVE_FACTS} facts). Ask the user to review Settings › Memoria.`,
        { recovery: "review" },
      );
    // Asked for explicitly: an earlier "forget" of this key no longer blocks it.
    if (input.provenance === "user_explicit" || input.provenance === "user_settings")
      await repo.allowKey(change.fact.key);
    return change;
  });
}

export async function editMemoryFact(auth: AuthContext, id: string, value: string) {
  await writable(() => memoryRepo(auth.db, auth.workspaceId, auth.userId).edit(id, value));
}

export async function forgetFact(auth: AuthContext, idOrKey: string) {
  return writable(() => memoryRepo(auth.db, auth.workspaceId, auth.userId).forget(idOrKey));
}

export async function clearMemory(auth: AuthContext) {
  await writable(() => memoryRepo(auth.db, auth.workspaceId, auth.userId).clear());
}

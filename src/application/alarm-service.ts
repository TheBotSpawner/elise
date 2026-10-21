import "server-only";

import { AppError } from "@/core/errors";
import {
  revivedDate,
  ALARM_LIMITS,
  armed,
  dueDecision,
  isBundledSound,
  isOnline,
  nextFire,
  sniffAudio,
  soundOf,
  stillRinging,
  UPLOAD_LIMITS,
  uploadSoundId,
  ALARM_SOUNDS,
  BUNDLED_SOUNDS,
  type Alarm,
  type AlarmDestination,
  type AlarmOccurrence,
  type AlarmPatch,
  type AlarmStore,
  type DestinationStatus,
  type NewAlarm,
  type SoundOption,
} from "@/core/timers/alarms";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { AlarmOccurrenceRow, AlarmRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import { saveTimePreferences, timePreferences } from "./time-service";

/**
 * Alarms (ADR-100). The server owns when an alarm fires: `next_fire_at` plus a delayed run keyed
 * by the alarm's version (a change makes older runs stale), and every read settles what's due —
 * a missed run, a sleeping laptop or a local setup without the worker never lose an alarm.
 * Firing writes one occurrence per alarm and time (unique), which every chosen device rings.
 */

type Db = AuthContext["db"];
const SOUNDS_BUCKET = "alarm-sounds";
const SIGNED_SECONDS = 300;

const dests = (j: unknown): AlarmDestination[] =>
  Array.isArray(j)
    ? j.filter(
        (d): d is AlarmDestination =>
          !!d &&
          typeof d === "object" &&
          ["browser", "desktop"].includes((d as AlarmDestination).kind) &&
          typeof (d as AlarmDestination).id === "string",
      )
    : [];

export const toAlarm = (r: AlarmRow): Alarm => ({
  id: r.id,
  label: r.label,
  time: r.local_time,
  date: r.local_date,
  weekdays: [...r.weekdays].sort(),
  timezone: r.timezone,
  // ADR-105: a one-off that already rang is off (rows from before kept `enabled`).
  enabled: r.enabled && r.state !== "done",
  sound: r.sound,
  snoozeMinutes: r.snooze_minutes,
  destinations: dests(r.destinations),
  state: r.state,
  nextFireAt: r.next_fire_at,
  snoozedUntil: r.snoozed_until,
  version: r.version,
});

const toOccurrence = (r: AlarmOccurrenceRow): AlarmOccurrence => ({
  id: r.id,
  alarmId: r.alarm_id,
  fireAt: r.fire_at,
  status: r.status,
  ringingSince: r.ringing_since,
  snoozedUntil: r.snoozed_until,
  label: r.label,
  sound: r.sound,
  destinations: dests(r.destinations),
});

/** The delayed run at an alarm's next time (if the worker is configured; reads settle anyway). */
async function scheduleFire(
  workspaceId: string,
  a: Pick<AlarmRow, "id" | "version" | "next_fire_at" | "enabled">,
) {
  if (!a.enabled || !a.next_fire_at || !isBackgroundConfigured()) return;
  try {
    await new TriggerDevBackgroundRuntime().enqueue({
      type: "time.alarm",
      payload: { workspaceId, alarmId: a.id, version: a.version },
      idempotencyKey: `alarm:${a.id}:v${a.version}`,
      runAt: new Date(a.next_fire_at),
    });
  } catch (error) {
    logger.warn("alarm.schedule_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
  }
}

async function scheduleSnoozeEnd(
  workspaceId: string,
  o: Pick<AlarmOccurrenceRow, "id" | "rings" | "snoozed_until">,
) {
  if (!o.snoozed_until || !isBackgroundConfigured()) return;
  try {
    await new TriggerDevBackgroundRuntime().enqueue({
      type: "time.alarm",
      payload: { workspaceId, occurrenceId: o.id, rings: o.rings },
      idempotencyKey: `alarm-snooze:${o.id}:${o.rings}`,
      runAt: new Date(o.snoozed_until),
    });
  } catch (error) {
    logger.warn("alarm.snooze_schedule_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
  }
}

/**
 * Fires an alarm whose time has come, exactly once: the occurrence is unique per alarm and time,
 * and the alarm only moves on if it's still at the version this was computed from.
 */
async function fire(
  db: Db,
  a: AlarmRow,
  now: Date,
  defaultSound: string | null,
): Promise<AlarmRow> {
  if (!a.enabled || !a.next_fire_at) return a;
  const decision = dueDecision(new Date(a.next_fire_at), now);
  if (decision === "early") return a;
  const ring = decision === "ring";
  const alarm = toAlarm(a);
  const { data: inserted } = await db
    .from("alarm_occurrences")
    .upsert(
      {
        alarm_id: a.id,
        workspace_id: a.workspace_id,
        user_id: a.user_id,
        fire_at: a.next_fire_at,
        status: ring ? "ringing" : "missed",
        ringing_since: ring ? now.toISOString() : null,
        rings: ring ? 1 : 0,
        ended_at: ring ? null : now.toISOString(),
        label: a.label,
        sound: soundOf(alarm, defaultSound),
        destinations: a.destinations,
      },
      { onConflict: "alarm_id,fire_at", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (inserted && ring)
    await db.from("notifications").insert({
      workspace_id: a.workspace_id,
      user_id: a.user_id,
      notification_type: "alarm.ringing",
      title: a.label ?? a.local_time,
      priority: "high",
      source_type: "alarm_occurrence",
      source_id: inserted.id,
      metadata: { alarmId: a.id, occurrenceId: inserted.id, at: a.next_fire_at },
    });
  const next = a.local_date ? null : nextFire(alarm, new Date(a.next_fire_at));
  const { data } = await db
    .from("alarms")
    .update({
      state: ring ? "ringing" : next ? "scheduled" : "done",
      next_fire_at: next?.toISOString() ?? null,
      // ADR-105: a one-off rang its only time — it turns itself off.
      ...(next ? {} : { enabled: false }),
      version: a.version + 1,
    })
    .eq("id", a.id)
    .eq("version", a.version)
    .select("*")
    .maybeSingle();
  if (data) {
    await scheduleFire(a.workspace_id, data);
    logger.info("alarm.fired", {
      decision,
      late_ms: Math.max(0, now.getTime() - Date.parse(a.next_fire_at)),
      repeats: !a.local_date,
    });
  }
  return data ?? a;
}

/** Snoozes that ended ring again; rings past the failsafe stop. Idempotent (status-guarded). */
async function settleOccurrences(db: Db, userId: string, workspaceId: string, now: Date) {
  const { data } = await db
    .from("alarm_occurrences")
    .select("*")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .in("status", ["ringing", "snoozed"]);
  for (const o of data ?? []) {
    if (o.status === "ringing" && o.ringing_since && !stillRinging(new Date(o.ringing_since), now))
      await db
        .from("alarm_occurrences")
        .update({ status: "expired", ended_at: now.toISOString() })
        .eq("id", o.id)
        .eq("status", "ringing");
    else if (
      o.status === "snoozed" &&
      o.snoozed_until &&
      Date.parse(o.snoozed_until) <= now.getTime()
    ) {
      const late = now.getTime() - Date.parse(o.snoozed_until) > ALARM_LIMITS.lateGraceMs;
      await db
        .from("alarm_occurrences")
        .update(
          late
            ? { status: "expired", ended_at: now.toISOString() }
            : { status: "ringing", ringing_since: now.toISOString(), rings: o.rings + 1 },
        )
        .eq("id", o.id)
        .eq("status", "snoozed")
        .eq("rings", o.rings);
    }
  }
}

/** An alarm whose occurrence ended goes back to waiting for its next time (or done). */
async function rest(db: Db, alarmId: string) {
  const { data: a } = await db.from("alarms").select("*").eq("id", alarmId).maybeSingle();
  if (!a || (a.state !== "ringing" && a.state !== "snoozed")) return;
  await db
    .from("alarms")
    .update({
      state: !a.enabled ? "off" : a.next_fire_at ? "scheduled" : "done",
      snoozed_until: null,
      version: a.version + 1,
    })
    .eq("id", a.id)
    .eq("version", a.version);
}

export function alarmStore(auth: AuthContext, origin: "ai" | "user_ui" = "ai"): AlarmStore {
  const db = auth.db;
  const mine = <T extends { eq: (c: string, v: string) => T }>(q: T) =>
    q.eq("workspace_id", auth.workspaceId).eq("user_id", auth.userId);
  const audit = (
    event: string,
    id: string,
    metadata: Record<string, string | number | string[]> = {},
  ) =>
    db.from("audit_events").insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      event_type: event,
      resource_type: "alarm",
      resource_id: id,
      origin,
      result: "success",
      metadata,
    });

  const settle = async () => {
    const now = new Date();
    const prefs = await timePreferences(auth);
    const { data } = await mine(db.from("alarms").select("*"))
      .eq("enabled", true)
      .lte("next_fire_at", now.toISOString());
    for (const a of data ?? []) await fire(db, a, now, prefs.alarmSound);
    await settleOccurrences(db, auth.userId, auth.workspaceId, now);
  };

  return {
    async listAlarms() {
      await settle();
      const { data, error } = await mine(db.from("alarms").select("*"))
        .order("next_fire_at", { ascending: true, nullsFirst: false })
        .limit(ALARM_LIMITS.maxAlarms);
      if (error) throw new AppError("INTERNAL_ERROR", "Could not load alarms", { cause: error });
      return (data ?? []).map(toAlarm);
    },

    async createAlarm(n: NewAlarm) {
      const { count } = await mine(db.from("alarms").select("id", { count: "exact", head: true }));
      if ((count ?? 0) >= ALARM_LIMITS.maxAlarms)
        throw new AppError(
          "VALIDATION_ERROR",
          `You can have up to ${ALARM_LIMITS.maxAlarms} alarms.`,
          {
            recovery: "review",
          },
        );
      const now = new Date();
      const plan = armed({ ...n, enabled: true }, now);
      if (plan.state === "done")
        throw new AppError("VALIDATION_ERROR", "That time has already passed.", {
          recovery: "review",
        });
      const { data, error } = await db
        .from("alarms")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          label: n.label,
          local_time: n.time,
          local_date: n.date,
          weekdays: n.weekdays,
          timezone: n.timezone,
          sound: n.sound,
          snooze_minutes: n.snoozeMinutes,
          destinations: n.destinations as unknown as AlarmRow["destinations"],
          state: plan.state,
          next_fire_at: plan.nextFireAt,
          created_from_conversation_id: n.provenance?.conversationId ?? null,
          created_from_session_id: n.provenance?.sessionId ?? null,
        })
        .select("*")
        .single();
      if (error || !data)
        throw new AppError("INTERNAL_ERROR", "Could not set the alarm", { cause: error });
      await Promise.all([audit("alarm.created", data.id), scheduleFire(auth.workspaceId, data)]);
      logger.info("alarm.created", { repeats: !n.date, destinations: n.destinations.length });
      return toAlarm(data);
    },

    async changeAlarm(a: Alarm, patch: AlarmPatch) {
      const merged = { ...a, ...patch };
      // ADR-105: turning a past one-off back on means its hour, the next time it comes.
      if (patch.enabled) merged.date = revivedDate(merged, new Date());
      if (merged.date && merged.weekdays.length)
        throw new AppError(
          "VALIDATION_ERROR",
          "An alarm is either once (a date) or repeating (weekdays).",
          {
            recovery: "review",
          },
        );
      const plan = armed(merged, new Date());
      const { data, error } = await db
        .from("alarms")
        .update({
          label: merged.label,
          local_time: merged.time,
          local_date: merged.date,
          weekdays: merged.weekdays,
          enabled: merged.enabled && plan.state !== "done",
          sound: merged.sound,
          snooze_minutes: merged.snoozeMinutes,
          destinations: merged.destinations as unknown as AlarmRow["destinations"],
          // A change while it rings doesn't stop the ring (that's dismiss): only the next time.
          state: a.state === "ringing" || a.state === "snoozed" ? a.state : plan.state,
          next_fire_at: plan.nextFireAt,
          version: a.version + 1,
        })
        .eq("id", a.id)
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId)
        .eq("version", a.version)
        .select("*")
        .maybeSingle();
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not change the alarm", { cause: error });
      if (!data)
        throw new AppError("CONFLICT", "That alarm just changed. Try again.", {
          recovery: "retry",
        });
      await Promise.all([
        audit("alarm.changed", a.id, { fields: Object.keys(patch) }),
        scheduleFire(auth.workspaceId, data),
      ]);
      return toAlarm(data);
    },

    async deleteAlarm(a: Alarm) {
      const { error } = await db
        .from("alarms")
        .delete()
        .eq("id", a.id)
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId);
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not delete the alarm", { cause: error });
      await audit("alarm.deleted", a.id);
    },

    async liveOccurrences() {
      await settle();
      const { data } = await mine(db.from("alarm_occurrences").select("*"))
        .in("status", ["ringing", "snoozed"])
        .order("fire_at", { ascending: false })
        .limit(20);
      return (data ?? []).map(toOccurrence);
    },

    async occurrenceAction(id: string, action: "snooze" | "dismiss") {
      const { data: o } = await mine(db.from("alarm_occurrences").select("*"))
        .eq("id", id)
        .maybeSingle();
      if (!o) throw new AppError("NOT_FOUND", "That alarm isn't ringing.", { recovery: "review" });
      if (o.status !== "ringing" && o.status !== "snoozed") return toOccurrence(o); // already handled on another device: nothing to do twice
      const now = new Date();
      if (action === "dismiss") {
        const { data } = await db
          .from("alarm_occurrences")
          .update({ status: "dismissed", ended_at: now.toISOString(), snoozed_until: null })
          .eq("id", o.id)
          .in("status", ["ringing", "snoozed"])
          .select("*")
          .maybeSingle();
        await rest(db, o.alarm_id);
        await audit("alarm.dismissed", o.alarm_id, { occurrence: o.id });
        return toOccurrence(data ?? o);
      }
      const { data: a } = await db
        .from("alarms")
        .select("snooze_minutes")
        .eq("id", o.alarm_id)
        .maybeSingle();
      const until = new Date(
        now.getTime() + (a?.snooze_minutes ?? ALARM_LIMITS.defaultSnooze) * 60_000,
      );
      const { data } = await db
        .from("alarm_occurrences")
        .update({ status: "snoozed", snoozed_until: until.toISOString() })
        .eq("id", o.id)
        .eq("status", "ringing")
        .select("*")
        .maybeSingle();
      if (data) {
        await db
          .from("alarms")
          .update({ state: "snoozed", snoozed_until: until.toISOString() })
          .eq("id", o.alarm_id);
        await Promise.all([
          scheduleSnoozeEnd(auth.workspaceId, data),
          audit("alarm.snoozed", o.alarm_id, { until: until.toISOString() }),
        ]);
      }
      return toOccurrence(data ?? o);
    },

    async destinations() {
      const now = new Date();
      const [browsers, desktops] = await Promise.all([
        db
          .from("browser_endpoints")
          .select("endpoint_id, name, last_seen_at")
          .eq("user_id", auth.userId)
          .is("revoked_at", null),
        db
          .from("desktop_installations")
          .select("installation_id, name, last_seen_at")
          .eq("user_id", auth.userId)
          .is("revoked_at", null),
      ]);
      const out: DestinationStatus[] = [
        ...(browsers.data ?? []).map((b) => ({
          kind: "browser" as const,
          id: b.endpoint_id,
          name: b.name,
          online: isOnline(b.last_seen_at, now),
          lastSeenAt: b.last_seen_at,
        })),
        ...(desktops.data ?? []).map((d) => ({
          kind: "desktop" as const,
          id: d.installation_id,
          name: d.name,
          online: isOnline(d.last_seen_at, now),
          lastSeenAt: d.last_seen_at,
        })),
      ];
      return out;
    },

    async sounds() {
      const { data } = await mine(db.from("alarm_sounds").select("id, name")).order("created_at");
      const bundled: SoundOption[] = BUNDLED_SOUNDS.map((k) => ({
        key: k,
        name: ALARM_SOUNDS[k].name,
        kind: "bundled",
      }));
      return [
        ...bundled,
        ...(data ?? []).map((s) => ({
          key: `upload:${s.id}`,
          name: s.name,
          kind: "upload" as const,
        })),
      ];
    },

    async setDefaultSound(key: string) {
      if (!isBundledSound(key)) {
        const id = uploadSoundId(key);
        const { data } = id
          ? await mine(db.from("alarm_sounds").select("id")).eq("id", id).maybeSingle()
          : { data: null };
        if (!data)
          throw new AppError("NOT_FOUND", "That sound isn't available.", { recovery: "review" });
      }
      const prefs = await timePreferences(auth);
      await saveTimePreferences(auth, { ...prefs, alarmSound: key });
    },

    async setDefaultDestinations(d: AlarmDestination[]) {
      const prefs = await timePreferences(auth);
      await saveTimePreferences(auth, {
        ...prefs,
        alarmDestinations: d.slice(0, ALARM_LIMITS.maxDestinations),
      });
    },
  };
}

// ── Devices, receipts, sounds (pages and the ringing device) ────────────────

/** This browser, chosen by the user to ring alarms (only after their explicit action). */
export async function registerBrowser(auth: AuthContext, endpointId: string, name: string) {
  const { error } = await auth.db.from("browser_endpoints").upsert(
    {
      user_id: auth.userId,
      workspace_id: auth.workspaceId,
      endpoint_id: endpointId,
      name: name.slice(0, 80) || "Navegador",
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "user_id,endpoint_id" },
  );
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not register this browser", { cause: error });
}

export async function browserHeartbeat(auth: AuthContext, endpointId: string) {
  await auth.db
    .from("browser_endpoints")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("user_id", auth.userId)
    .eq("endpoint_id", endpointId)
    .is("revoked_at", null);
}

export async function revokeBrowser(auth: AuthContext, endpointId: string) {
  await auth.db
    .from("browser_endpoints")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", auth.userId)
    .eq("endpoint_id", endpointId);
}

export const RECEIPT_EVENTS = ["received", "playing", "blocked", "stopped"] as const;

/** What one device did with a ringing occurrence: never "it rang" unless it said "playing". */
export async function recordReceipt(
  auth: AuthContext,
  occurrenceId: string,
  device: string,
  event: (typeof RECEIPT_EVENTS)[number],
) {
  const { data: o } = await auth.db
    .from("alarm_occurrences")
    .select("receipts")
    .eq("id", occurrenceId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!o) return;
  const receipts = { ...((o.receipts as Record<string, Record<string, string>>) ?? {}) };
  receipts[device] = { ...(receipts[device] ?? {}), [event]: new Date().toISOString() };
  if (Object.keys(receipts).length > 20) return;
  await auth.db
    .from("alarm_occurrences")
    .update({ receipts: receipts as unknown as AlarmOccurrenceRow["receipts"] })
    .eq("id", occurrenceId)
    .eq("user_id", auth.userId);
}

/** An uploaded sound: checked by its first bytes and size, stored privately. */
export async function uploadSound(
  auth: AuthContext,
  name: string,
  bytes: Uint8Array,
  durationMs: number | null,
) {
  if (bytes.byteLength > UPLOAD_LIMITS.maxBytes)
    throw new AppError("VALIDATION_ERROR", "The file is larger than 2 MB.", { recovery: "review" });
  const mime = sniffAudio(bytes);
  if (!mime)
    throw new AppError("VALIDATION_ERROR", "Use an MP3, OGG, WAV or M4A file.", {
      recovery: "review",
    });
  const { count } = await auth.db
    .from("alarm_sounds")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId);
  if ((count ?? 0) >= UPLOAD_LIMITS.maxSounds)
    throw new AppError(
      "VALIDATION_ERROR",
      `You can keep up to ${UPLOAD_LIMITS.maxSounds} sounds.`,
      {
        recovery: "review",
      },
    );
  const id = crypto.randomUUID();
  const path = `${auth.workspaceId}/${auth.userId}/${id}`;
  const admin = createAdminClient();
  const up = await admin.storage
    .from(SOUNDS_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (up.error)
    throw new AppError("INTERNAL_ERROR", "Could not store the sound", { cause: up.error });
  const { data, error } = await auth.db
    .from("alarm_sounds")
    .insert({
      id,
      user_id: auth.userId,
      workspace_id: auth.workspaceId,
      name: name.trim().slice(0, 60) || "Mi sonido",
      storage_path: path,
      mime_type: mime,
      size_bytes: bytes.byteLength,
      duration_ms:
        durationMs && durationMs > 0 && durationMs <= 120_000 ? Math.round(durationMs) : null,
    })
    .select("id, name")
    .single();
  if (error || !data) {
    await admin.storage.from(SOUNDS_BUCKET).remove([path]);
    throw new AppError("INTERNAL_ERROR", "Could not save the sound", { cause: error });
  }
  return { key: `upload:${data.id}`, name: data.name };
}

/** A short-lived link to the user's own sound (ownership checked through RLS first). */
export async function soundUrl(auth: AuthContext, id: string): Promise<string> {
  const { data } = await auth.db
    .from("alarm_sounds")
    .select("storage_path")
    .eq("id", id)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "That sound isn't available.", { recovery: "review" });
  const { data: signed, error } = await createAdminClient()
    .storage.from(SOUNDS_BUCKET)
    .createSignedUrl(data.storage_path, SIGNED_SECONDS);
  if (error || !signed)
    throw new AppError("INTERNAL_ERROR", "Could not open the sound", { cause: error });
  return signed.signedUrl;
}

/**
 * Deletes an uploaded sound. Alarms that used it fall back to the default sound (null) and, if it
 * was the default, ELISE's default takes its place — the counts are returned so the UI says so.
 */
export async function deleteSound(auth: AuthContext, id: string) {
  const key = `upload:${id}`;
  const { data } = await auth.db
    .from("alarm_sounds")
    .select("storage_path")
    .eq("id", id)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "That sound isn't available.", { recovery: "review" });
  const { data: using } = await auth.db
    .from("alarms")
    .update({ sound: null })
    .eq("user_id", auth.userId)
    .eq("sound", key)
    .select("id");
  const prefs = await timePreferences(auth);
  const wasDefault = prefs.alarmSound === key;
  if (wasDefault) await saveTimePreferences(auth, { ...prefs, alarmSound: "brisa" });
  await auth.db.from("alarm_sounds").delete().eq("id", id).eq("user_id", auth.userId);
  await createAdminClient().storage.from(SOUNDS_BUCKET).remove([data.storage_path]);
  return { alarmsChanged: using?.length ?? 0, wasDefault };
}

// ── The background run ──────────────────────────────────────────────────────

/** An alarm's time (or a snooze's end), as a delayed run. Stale versions do nothing. */
export async function alarmRun(
  payload: {
    workspaceId: string;
    alarmId?: string;
    version?: number;
    occurrenceId?: string;
    rings?: number;
  },
  db: Db = createAdminClient(),
): Promise<"fired" | "stale" | "early" | "gone" | "snooze_ended"> {
  const now = new Date();
  if (payload.occurrenceId) {
    const { data: o } = await db
      .from("alarm_occurrences")
      .select("*")
      .eq("id", payload.occurrenceId)
      .maybeSingle();
    if (!o || o.status !== "snoozed" || o.rings !== payload.rings) return "stale";
    if (o.snoozed_until && Date.parse(o.snoozed_until) > now.getTime()) return "early";
    await settleOccurrences(db, o.user_id, o.workspace_id, now);
    return "snooze_ended";
  }
  const { data: a } = await db
    .from("alarms")
    .select("*")
    .eq("id", payload.alarmId!)
    .eq("workspace_id", payload.workspaceId)
    .maybeSingle();
  if (!a) return "gone";
  if (a.version !== payload.version || !a.enabled || !a.next_fire_at) return "stale";
  if (Date.parse(a.next_fire_at) > now.getTime()) return "early";
  const { data: pref } = await db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", a.workspace_id)
    .eq("user_id", a.user_id)
    .eq("key", "time")
    .maybeSingle();
  const sound = ((pref?.value_json ?? {}) as { alarmSound?: string }).alarmSound ?? null;
  const after = await fire(db, a, now, sound);
  return after.version === a.version ? "stale" : "fired";
}

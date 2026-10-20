import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  alarmStore,
  browserHeartbeat,
  deleteSound,
  recordReceipt,
  RECEIPT_EVENTS,
  registerBrowser,
  revokeBrowser,
  soundUrl,
  uploadSound,
} from "@/application/alarm-service";
import { getAuthContext } from "@/application/auth-context";
import { timePreferences } from "@/application/time-service";
import { AppError, toPublicError } from "@/core/errors";
import { ALARM_LIMITS, isTime } from "@/core/timers/alarms";

/**
 * Alarms for pages and the ringing device (ADR-100): everything goes through the same store as
 * the conversation's tools — validation, ownership (RLS) and audit are the server's. One route,
 * typed operations; Desktop reaches it through its /api proxy like the web.
 */

const destination = z.object({ kind: z.enum(["browser", "desktop"]), id: z.uuid() });
const alarmFields = z.object({
  label: z.string().trim().min(1).max(80).nullable(),
  time: z.string().refine(isTime, "HH:mm"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  sound: z.string().max(60).nullable(),
  snoozeMinutes: z.number().int().min(ALARM_LIMITS.minSnooze).max(ALARM_LIMITS.maxSnooze),
  destinations: z.array(destination).max(ALARM_LIMITS.maxDestinations),
});

const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), alarm: alarmFields }),
  z.object({
    op: z.literal("change"),
    id: z.uuid(),
    patch: alarmFields.partial().extend({ enabled: z.boolean().optional() }),
  }),
  z.object({ op: z.literal("delete"), id: z.uuid() }),
  z.object({ op: z.literal("occurrence"), id: z.uuid(), action: z.enum(["snooze", "dismiss"]) }),
  z.object({
    op: z.literal("receipt"),
    id: z.uuid(),
    device: z.string().regex(/^(browser|desktop):[0-9a-f-]{36}$/),
    event: z.enum(RECEIPT_EVENTS),
  }),
  z.object({ op: z.literal("registerBrowser"), endpointId: z.uuid(), name: z.string().max(80) }),
  z.object({ op: z.literal("heartbeat"), endpointId: z.uuid() }),
  z.object({ op: z.literal("revokeBrowser"), endpointId: z.uuid() }),
  z.object({ op: z.literal("defaultSound"), sound: z.string().min(1).max(60) }),
  z.object({ op: z.literal("defaultDestinations"), destinations: z.array(destination).max(10) }),
  z.object({ op: z.literal("soundUrl"), id: z.uuid() }),
  z.object({ op: z.literal("deleteSound"), id: z.uuid() }),
]);

function fail(error: unknown) {
  const e = toPublicError(error);
  const status =
    e.code === "NOT_FOUND"
      ? 404
      : e.code === "VALIDATION_ERROR"
        ? 400
        : e.code === "CONFLICT"
          ? 409
          : e.code === "PERMISSION_DENIED"
            ? 403
            : 500;
  return NextResponse.json({ error: e }, { status });
}

/** The alarms page and ringing devices: alarms, what rings now, devices, sounds, preferences. */
export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  try {
    const s = alarmStore(auth, "user_ui");
    const [alarms, live, destinations, sounds, prefs] = await Promise.all([
      s.listAlarms(),
      s.liveOccurrences(),
      s.destinations(),
      s.sounds(),
      timePreferences(auth),
    ]);
    return NextResponse.json(
      {
        alarms,
        live,
        destinations,
        sounds,
        prefs,
        timezone: auth.profile.timezone,
        serverNow: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  try {
    // An uploaded sound arrives as a form (the file itself is checked by its bytes).
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError("VALIDATION_ERROR", "No file");
      const duration = Number(form.get("durationMs") ?? 0) || null;
      const name = String(form.get("name") ?? file.name).replace(/\.[a-z0-9]+$/i, "");
      return NextResponse.json(
        await uploadSound(auth, name, new Uint8Array(await file.arrayBuffer()), duration),
      );
    }
    const parsed = op.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid request");
    const q = parsed.data;
    const s = alarmStore(auth, "user_ui");
    const find = async (id: string) => {
      const a = (await s.listAlarms()).find((x) => x.id === id);
      if (!a) throw new AppError("NOT_FOUND", "Alarm not found");
      return a;
    };
    switch (q.op) {
      case "create":
        return NextResponse.json(
          await s.createAlarm({ ...q.alarm, timezone: auth.profile.timezone }),
        );
      case "change":
        return NextResponse.json(await s.changeAlarm(await find(q.id), q.patch));
      case "delete":
        await s.deleteAlarm(await find(q.id));
        return NextResponse.json({ ok: true });
      case "occurrence":
        return NextResponse.json(await s.occurrenceAction(q.id, q.action));
      case "receipt":
        await recordReceipt(auth, q.id, q.device, q.event);
        return NextResponse.json({ ok: true });
      case "registerBrowser":
        await registerBrowser(auth, q.endpointId, q.name);
        return NextResponse.json({ ok: true });
      case "heartbeat":
        await browserHeartbeat(auth, q.endpointId);
        return NextResponse.json({ ok: true });
      case "revokeBrowser":
        await revokeBrowser(auth, q.endpointId);
        return NextResponse.json({ ok: true });
      case "defaultSound":
        await s.setDefaultSound(q.sound);
        return NextResponse.json({ ok: true });
      case "defaultDestinations":
        await s.setDefaultDestinations(q.destinations);
        return NextResponse.json({ ok: true });
      case "soundUrl":
        return NextResponse.json({ url: await soundUrl(auth, q.id) });
      case "deleteSound":
        return NextResponse.json(await deleteSound(auth, q.id));
    }
  } catch (error) {
    return fail(error);
  }
}

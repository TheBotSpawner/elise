import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import {
  broadTargets,
  describeState,
  HOME_DEVICE_TYPES,
  homeActionInputSchema,
  validateAction,
  type HomeAction,
  type HomeActionInput,
  type HomeCommandOutcome,
  type HomeDevice,
  type HomePort,
  type HomeSnapshot,
} from "../home/model";
import {
  resolveDevice,
  resolveGroup,
  resolveRoom,
  resolveScene,
  typeFromWords,
} from "../home/resolve";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * ELISE Home tools (ADR-079): the home by capability ("home.*"), never by provider. The model
 * says what the person wants — which device, room or mode, and what to change, in words or
 * numbers; this code resolves the targets among the person's own devices, checks every action
 * against what each device supports and its range, and only then sends it to the hub.
 */

const port = (env: ToolRunEnv): HomePort => env.providers.get("home", env.binding);
const es = (env: ToolRunEnv) => env.ctx.locale === "es";

async function snapshot(env: ToolRunEnv): Promise<HomeSnapshot> {
  const s = await port(env).snapshot();
  if (!s.home || !s.hub)
    throw new AppError("CAPABILITY_UNAVAILABLE", "ELISE Home isn't set up yet", {
      recovery: "configure",
      details: { setup: "/my-elise/home" },
    });
  return s;
}

type HomeView = SurfacePayloads["home"];

const roomName = (s: HomeSnapshot, d: HomeDevice) =>
  s.rooms.find((r) => r.id === d.roomId)?.name ?? null;

function view(
  s: HomeSnapshot,
  env: ToolRunEnv,
  title: string,
  devices: HomeDevice[],
  outcomes?: HomeCommandOutcome[],
): HomeView {
  return {
    title: title.slice(0, 120),
    hub: s.hub!.status,
    items: devices.slice(0, 24).map((d) => {
      const o = outcomes?.find((x) => x.deviceId === d.id);
      const now = o?.state ? { ...d, state: o.state } : d;
      return {
        deviceId: d.id,
        name: d.name.slice(0, 120),
        room: roomName(s, d),
        type: d.type,
        status: o ? o.status : d.available ? "state" : "unavailable",
        detail: describeState(now, env.ctx.locale).slice(0, 120),
        updatedAt: d.stateUpdatedAt,
      };
    }),
  };
}

/** What ELISE says when the hub can't be reached: the last known state, as such. */
const offlineNote = (s: HomeSnapshot) =>
  `The home hub is offline${s.hub?.lastSeenAt ? ` (last seen ${s.hub.lastSeenAt})` : ""}. Nothing was sent. Cached states are the last known ones, not current: say so ("el último estado registrado…").`;

// ── Reading ──────────────────────────────────────────────────────────────────

const statusInput = z
  .object({
    device: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe('A device as the user said it ("el aire del living").'),
    room: z.string().trim().max(80).optional(),
    type: z.enum(HOME_DEVICE_TYPES).optional(),
  })
  .strict();

export const homeStatusTool: ToolDefinition = {
  name: "home.status",
  capability: "home",
  operation: "status",
  description:
    '"¿Está prendido el aire?", "¿qué temperatura hay en el living?", "¿qué dispositivos tengo?", "¿qué modos tengo?": the home\'s devices with their state, the hub\'s connection and the modes. Read-only.',
  input: statusInput,
  async describe() {
    return { summary: "Read the home" };
  },
  async run(raw, env) {
    const q = statusInput.parse(raw);
    const s = await snapshot(env);
    let devices = s.devices;
    if (q.device) {
      const r = resolveDevice(q.device, s.devices, s.rooms);
      devices = r.kind === "one" ? [r.item] : r.kind === "ambiguous" ? r.candidates : [];
    } else if (q.room) {
      const r = resolveRoom(q.room, s.rooms);
      devices = r.kind === "one" ? s.devices.filter((d) => d.roomId === r.item.id) : [];
    }
    if (q.type) devices = devices.filter((d) => d.type === q.type);
    const stale = s.hub!.status === "offline";
    return {
      output: {
        hub: s.hub!.status,
        ...(stale ? { note: offlineNote(s) } : {}),
        devices: devices.slice(0, 40).map((d) => ({
          name: d.name,
          room: roomName(s, d),
          type: d.type,
          state: describeState(d, env.ctx.locale),
          available: d.available,
          updatedAt: d.stateUpdatedAt,
          can: d.capabilities.map((c) => c.type),
          // ADR-110: infrared can't be read back; its state is what ELISE last sent.
          ...(d.capabilities.some((c) => c.type === "ir" || c.type === "tuya_ir")
            ? { infrared: true, stateIsEstimated: true, buttons: canDo(d)[0] }
            : {}),
        })),
        rooms: s.rooms.map((r) => r.name),
        modes: s.scenes.map((x) => x.name),
      },
      ...(devices.length && devices.length <= 24
        ? {
            display: {
              kind: "home" as const,
              home: view(s, env, es(env) ? "Hogar" : "Home", devices),
            },
          }
        : {}),
    };
  },
};

// ── Controlling ──────────────────────────────────────────────────────────────

const actionsField = z
  .array(homeActionInputSchema)
  .min(1)
  .max(6)
  .describe(
    'What to change, in order. "prendé" → power true; "bajala al 20%" → brightness 20; "más tenue" → brightness -20 relative; "en verde" → color "verde"; "luz cálida" → color_temp "warm"; "poné el aire en 24" → temperature 24; "bajá el aire dos grados" → temperature -2 relative; "en frío" → hvac_mode "cool"; "subí el volumen" → volume +10 relative; "poné mute en la tele" (an infrared device) → button "mute".',
  );

const controlInput = z
  .object({
    device: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe(
        'One device as the user named it ("luz del escritorio", "el aire", "la tele"). For a follow-up ("bajala", "subilo") pass the device you just controlled.',
      ),
    room: z.string().trim().max(80).optional().describe('"Apagá todo el living" → room "living".'),
    group: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('A group the user created ("planta alta").'),
    everything: z
      .boolean()
      .optional()
      .describe('"Apagá todo" / "todas las luces": the whole home (low-risk devices only).'),
    type: z
      .enum(HOME_DEVICE_TYPES)
      .optional()
      .describe('With room/group/everything: only this kind ("las luces del living" → light).'),
    actions: actionsField,
  })
  .strict()
  .refine((q) => q.device || q.room || q.group || q.everything, "Say which device, room or group");

function summarize(outcomes: HomeCommandOutcome[]) {
  const by = (st: HomeCommandOutcome["status"]) =>
    outcomes.filter((o) => o.status === st).map((o) => o.name);
  return {
    done: by("succeeded"),
    notResponding: [...by("failed"), ...by("unavailable"), ...by("expired")],
    unconfirmed: by("pending"),
    hubOffline: outcomes.some((o) => o.status === "offline"),
  };
}

const CONFIRM_RULES =
  'Confirm in very few words ("Listo.", "Listo, luz al 20%."). If something didn\'t respond, name it briefly. "unconfirmed" = sent but the hub hasn\'t confirmed yet: say it was sent. Never mention providers, hubs\' internals or ids.';

/** What a device can do, in plain words: what ELISE offers instead when something can't be done. */
export function canDo(d: HomeDevice): string[] {
  return d.capabilities.flatMap((c): string[] => {
    switch (c.type) {
      case "power":
        return ["turn on/off"];
      case "brightness":
        return ["brightness"];
      case "color":
        return ["color"];
      case "color_temp":
        return ["white tone (warm/cool)"];
      case "temperature":
        return [`temperature ${c.min}–${c.max} °C`];
      case "hvac_mode":
        return [`mode: ${c.modes.join(", ")}`];
      case "fan_mode":
        return [`fan: ${c.modes.join(", ")}`];
      case "fan_speed":
        return ["fan speed"];
      case "humidity":
        return ["humidity"];
      case "volume":
        return ["volume"];
      case "media":
        return ["play/pause/next/previous"];
      case "source":
        return [`input or app: ${c.sources.slice(0, 8).join(", ")}`];
      case "app":
        return ["open apps (YouTube, Netflix, Prime Video, Disney+, Max)"];
      case "ir_blaster":
        return [];
      case "ir":
        return [
          `infrared buttons: ${c.commands.map((x) => x.label).join(", ")}`,
          "volume only up/down",
        ];
      case "tuya_ir":
        return c.kind === "ac" && c.ac?.modes.length
          ? [
              `climate: ${c.ac.modes.map((m) => `${m.mode} ${Math.min(...m.temps)}–${Math.max(...m.temps)} °C`).join(", ")}`,
              "turn on/off",
            ]
          : [`buttons: ${c.keys.map((x) => x.label).join(", ")}`, "volume only up/down"];
    }
  });
}

/** Turns validated (device, actions) into hub commands; skipped ones explain why. */
function plan(
  targets: HomeDevice[],
  inputs: HomeActionInput[],
  strict: boolean,
): {
  commands: { deviceId: string; actions: HomeAction[] }[];
  rejected: { name: string; reason: string; canDo: string[] }[];
} {
  const commands: { deviceId: string; actions: HomeAction[] }[] = [];
  const rejected: { name: string; reason: string; canDo: string[] }[] = [];
  for (const d of targets) {
    const actions: HomeAction[] = [];
    for (const input of inputs) {
      const v = validateAction(d, input);
      if (v.ok) actions.push(v.action);
      else if (strict) {
        rejected.push({ name: d.name, reason: v.message, canDo: canDo(d) });
        break;
      }
    }
    if (actions.length && (!strict || actions.length === inputs.length))
      commands.push({ deviceId: d.id, actions });
  }
  return { commands, rejected };
}

export const homeControlTool: ToolDefinition = {
  name: "home.control",
  capability: "home",
  operation: "control",
  description:
    '"Prendé la luz del escritorio", "poné el aire a 24", "bajá la luz del living al 30%", "la luz en verde y tenue", "apagá todo el living", "subí el volumen de la tele", "abrí YouTube en la tele del dormitorio" (action app), "pausá la tele" (action media pause — pausing is never power off), "silenciá la tele" (infrared: button "mute"): change the user\'s own devices — one device, a room, a group or the whole home (broad commands touch lights, plugs, fans, media and humidifiers only; climate only if named). ELISE checks every value against the device. Infrared devices (a TV, air conditioner or fan through an infrared controller) have no feedback: their state is estimated, volume only goes up/down, an air conditioner only takes the settings learned from its remote, and a single toggle power button is never treated as "off".',
  input: controlInput,
  async describe(raw) {
    const q = controlInput.parse(raw);
    return {
      summary: `Home: ${q.device ?? q.room ?? q.group ?? "everything"} · ${q.actions.map((a) => `${a.type}=${String(a.value)}`).join(", ")}`,
    };
  },
  async run(raw, env) {
    const q = controlInput.parse(raw);
    const s = await snapshot(env);
    let targets: HomeDevice[] = [];
    let strict = true;
    let title = "";
    if (q.device) {
      const r = resolveDevice(q.device, s.devices, s.rooms);
      if (r.kind === "ambiguous")
        return {
          output: {
            needsChoice: true,
            candidates: r.candidates.map((d) => ({ name: d.name, room: roomName(s, d) })),
            instructions:
              'Several devices match. Ask which one in a few words, by room ("¿El del living o el del dormitorio?"). Nothing was changed.',
          },
        };
      if (r.kind === "none")
        return {
          output: {
            found: false,
            devices: s.devices.map((d) => d.name).slice(0, 40),
            instructions:
              "No device matches. Say so and name the closest ones. Never invent a device.",
          },
        };
      targets = [r.item];
      title = r.item.name;
    } else {
      strict = false;
      let pool = s.devices;
      if (q.room) {
        const r = resolveRoom(q.room, s.rooms);
        if (r.kind !== "one")
          return {
            output: {
              found: false,
              rooms: s.rooms.map((x) => x.name),
              instructions: "No room matches; name the rooms.",
            },
          };
        pool = s.devices.filter((d) => d.roomId === r.item.id);
        title = r.item.name;
      } else if (q.group) {
        const g = resolveGroup(q.group, s.groups);
        if (g.kind !== "one")
          return {
            output: {
              found: false,
              groups: s.groups.map((x) => x.name),
              instructions: "No group matches; name the groups.",
            },
          };
        pool = s.devices.filter((d) => g.item.deviceIds.includes(d.id));
        title = g.item.name;
      } else title = es(env) ? "Casa" : "Home";
      const type = q.type ?? typeFromWords(`${q.room ?? ""} ${q.group ?? ""}`) ?? undefined;
      targets = broadTargets(
        pool,
        q.actions.map((a) => a.type),
        {
          type,
          includeClimate: type === "climate",
        },
      );
      if (!targets.length)
        return {
          output: { found: false, instructions: "Nothing there can do that. Say so briefly." },
        };
    }
    const { commands, rejected } = plan(targets, q.actions, strict);
    if (!commands.length)
      return {
        output: {
          done: false,
          rejected,
          instructions:
            'Nothing was sent. In one short line say why — it\'s what this device (its maker) allows, or the value is out of range — then offer one or two things it CAN do from canDo, as a question ("La TV del living no deja abrir apps desde acá. ¿Querés que la prenda o le suba el volumen?"). Never just say it failed.',
        },
      };
    const outcomes = await port(env).execute(commands);
    const sum = summarize(outcomes);
    const sent = targets.filter((d) => commands.some((c) => c.deviceId === d.id));
    return {
      output: {
        ...sum,
        ...(rejected.length ? { rejected } : {}),
        ...(sum.hubOffline ? { note: offlineNote(s) } : {}),
        instructions: CONFIRM_RULES,
      },
      display: { kind: "home", home: view(s, env, title, sent, outcomes) },
      ...(sent.length === 1 ? { target: { type: "home_device", id: sent[0]!.id } } : {}),
    };
  },
  confirm(output, locale) {
    const o = output as ReturnType<typeof summarize> & { rejected?: unknown[] };
    if (!o.done || o.hubOffline || o.notResponding?.length || o.unconfirmed?.length || o.rejected)
      return null;
    return locale === "es" ? "Listo." : "Done.";
  },
};

// ── Modes ────────────────────────────────────────────────────────────────────

const runSceneInput = z
  .object({ scene: z.string().trim().min(1).max(80).describe('"Modo Estudio" → "Estudio".') })
  .strict();

export const homeRunSceneTool: ToolDefinition = {
  name: "home.runScene",
  capability: "home",
  operation: "runScene",
  description:
    '"Activá Modo Estudio", "poné el modo cine": run one of the user\'s modes (each device set as the mode says).',
  input: runSceneInput,
  async describe(raw) {
    return { summary: `Run mode ${runSceneInput.parse(raw).scene}` };
  },
  async run(raw, env) {
    const q = runSceneInput.parse(raw);
    const s = await snapshot(env);
    const r = resolveScene(q.scene, s.scenes);
    if (r.kind !== "one")
      return {
        output: {
          found: false,
          modes: s.scenes.map((x) => x.name),
          instructions:
            r.kind === "ambiguous"
              ? "Several modes match; ask which."
              : "No mode matches; name the user's modes, or offer to create it.",
        },
      };
    const scene = r.item;
    const byId = new Map(s.devices.map((d) => [d.id, d]));
    const targets: HomeDevice[] = [];
    const commands: { deviceId: string; actions: HomeAction[] }[] = [];
    const skipped: string[] = [];
    for (const a of scene.actions) {
      const d = byId.get(a.deviceId);
      if (!d) continue; // removed from the home: the mode keeps it for when it returns
      const actions = a.actions
        .map((x) => validateAction(d, x))
        .flatMap((v) => (v.ok ? [v.action] : []));
      if (!actions.length) skipped.push(d.name);
      else {
        targets.push(d);
        commands.push({ deviceId: d.id, actions });
      }
    }
    const outcomes = commands.length ? await port(env).execute(commands) : [];
    const sum = summarize(outcomes);
    return {
      output: {
        mode: scene.name,
        ...sum,
        ...(skipped.length ? { skipped } : {}),
        ...(sum.hubOffline ? { note: offlineNote(s) } : {}),
        instructions: `${CONFIRM_RULES} Lead with "${scene.name} activado" (or "listo"), then what didn't respond, if anything.`,
      },
      display: { kind: "home", home: view(s, env, scene.name, targets, outcomes) },
    };
  },
  confirm(output, locale) {
    const o = output as ReturnType<typeof summarize> & { mode: string; skipped?: string[] };
    if (
      !o.mode ||
      o.hubOffline ||
      o.notResponding?.length ||
      o.unconfirmed?.length ||
      o.skipped?.length
    )
      return null;
    return locale === "es" ? `${o.mode} activado.` : `${o.mode} is on.`;
  },
};

const saveSceneInput = z
  .object({
    scene: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe("An existing mode to change; omit to create one."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('The mode\'s name ("Estudio"); required to create.'),
    set: z
      .array(
        z.object({ device: z.string().trim().min(1).max(120), actions: actionsField }).strict(),
      )
      .max(12)
      .optional()
      .describe(
        "Devices to add or change in the mode, each with what it should do (absolute values).",
      ),
    remove: z
      .array(z.string().trim().min(1).max(120))
      .max(12)
      .optional()
      .describe('"Sacá la música del modo" → its device.'),
  })
  .strict();

export const homeSaveSceneTool: ToolDefinition = {
  name: "home.saveScene",
  capability: "home",
  operation: "saveScene",
  description:
    '"Creame un Modo Estudio que ponga la luz del escritorio verde al 30% y el aire en 24", "agregale el humidificador al Modo Estudio", "en Modo Estudio dejá la luz al 15%", "sacá la música de Modo Estudio": create or change a mode as typed device actions. It doesn\'t run it.',
  input: saveSceneInput,
  async describe(raw) {
    const q = saveSceneInput.parse(raw);
    return { summary: `Save mode ${q.scene ?? q.name ?? ""}` };
  },
  async run(raw, env) {
    const q = saveSceneInput.parse(raw);
    const s = await snapshot(env);
    const existing = q.scene ? resolveScene(q.scene, s.scenes) : null;
    if (q.scene && existing?.kind !== "one")
      return {
        output: {
          found: false,
          modes: s.scenes.map((x) => x.name),
          instructions: "No mode matches; ask which, or offer to create it.",
        },
      };
    const base = existing?.kind === "one" ? existing.item : null;
    if (!base && !q.name)
      throw new AppError("VALIDATION_ERROR", "A new mode needs a name", { recovery: "review" });
    let actions = base ? [...base.actions] : [];
    const problems: string[] = [];
    for (const name of q.remove ?? []) {
      const r = resolveDevice(name, s.devices, s.rooms);
      if (r.kind === "one") actions = actions.filter((a) => a.deviceId !== r.item.id);
      else problems.push(name);
    }
    for (const item of q.set ?? []) {
      const r = resolveDevice(item.device, s.devices, s.rooms);
      if (r.kind !== "one") {
        problems.push(item.device);
        continue;
      }
      const bad = item.actions
        .map((a) => validateAction(r.item, { ...a, relative: false }))
        .find((v) => !v.ok);
      if (bad && !bad.ok) {
        problems.push(`${r.item.name}: ${bad.message}`);
        continue;
      }
      actions = [
        ...actions.filter((a) => a.deviceId !== r.item.id),
        { deviceId: r.item.id, actions: item.actions.map((a) => ({ ...a, relative: false })) },
      ];
    }
    if (problems.length)
      return {
        output: {
          saved: false,
          problems,
          instructions:
            "Say what couldn't be added (device not found or not supported) and ask. Nothing was saved.",
        },
      };
    const saved = await port(env).saveScene({
      ...(base ? { id: base.id } : {}),
      name: q.name ?? base!.name,
      icon: base?.icon ?? null,
      aliases: base?.aliases ?? [],
      actions,
    });
    const byId = new Map(s.devices.map((d) => [d.id, d]));
    return {
      output: {
        saved: true,
        mode: saved.name,
        devices: saved.actions.map((a) => byId.get(a.deviceId)?.name).filter(Boolean),
        instructions: "Confirm in one short sentence what the mode does. It wasn't run.",
      },
      target: { type: "home_scene", id: saved.id },
    };
  },
};

const deleteSceneInput = z.object({ scene: z.string().trim().min(1).max(80) }).strict();

export const homeDeleteSceneTool: ToolDefinition = {
  name: "home.deleteScene",
  capability: "home",
  operation: "deleteScene",
  description:
    "\"Borrá el Modo Cine\": delete one of the user's modes (the devices aren't touched). Needs approval.",
  input: deleteSceneInput,
  async describe(raw, env) {
    const s = await snapshot(env);
    const r = resolveScene(deleteSceneInput.parse(raw).scene, s.scenes);
    if (r.kind !== "one")
      throw new AppError("NOT_FOUND", "No mode matches", { recovery: "review" });
    return { summary: `Delete mode ${r.item.name}`, target: { type: "home_scene", id: r.item.id } };
  },
  async run(raw, env) {
    const s = await snapshot(env);
    const r = resolveScene(deleteSceneInput.parse(raw).scene, s.scenes);
    if (r.kind !== "one")
      throw new AppError("NOT_FOUND", "No mode matches", { recovery: "review" });
    await port(env).deleteScene(r.item.id);
    return { output: { deleted: r.item.name } };
  },
};

export const HOME_TOOLS = [
  homeStatusTool,
  homeControlTool,
  homeRunSceneTool,
  homeSaveSceneTool,
  homeDeleteSceneTool,
];

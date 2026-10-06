import { z } from "zod";

import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import {
  MUSIC_FEATURES,
  nextVolume,
  pickDevice,
  pickToPlay,
  matchScore,
  type MusicCommand,
  type MusicFeature,
  type MusicItem,
  type MusicKind,
  type MusicProvider,
  type Playback,
} from "../capabilities/music";
import { AppError } from "../errors";
import type { MusicPayload } from "../workspace/music";

/**
 * Music through conversation (ADR-042): canonical tools over whichever provider the user has
 * (Spotify, YouTube…). Remote providers are told directly; an embedded player (YouTube on
 * ELISE's screen) gets a command the page executes. Every result updates the one Music
 * Surface. Playback controls never ask: they only change the user's own player.
 */

const provider = (env: ToolRunEnv): MusicProvider => env.providers.get("music", env.binding);
const es = (env: ToolRunEnv) => env.ctx.locale === "es";
const embedded = (p: MusicProvider) => p.features.has("embedded_playback");

/** Remote providers apply commands asynchronously: read state after a short settle. */
const SETTLE_MS = 450;
const settle = (p: MusicProvider) =>
  embedded(p) ? Promise.resolve() : new Promise((r) => setTimeout(r, SETTLE_MS));

function need(p: MusicProvider, feature: MusicFeature, what: string) {
  if (!p.features.has(feature))
    throw new AppError("CAPABILITY_UNAVAILABLE", `${what} isn't supported with ${p.key}.`, {
      recovery: "none",
    });
}

async function current(p: MusicProvider, env: ToolRunEnv): Promise<Playback | null> {
  if (embedded(p)) return env.ctx.music?.provider === p.key ? env.ctx.music : null;
  return p.playback().catch(() => null);
}

export function musicPayloadOf(
  p: MusicProvider,
  playback: Playback | null,
  extra: Partial<
    Pick<MusicPayload, "devices" | "results" | "notice" | "queue" | "index" | "video">
  > = {},
): MusicPayload {
  return {
    provider: playback?.provider ?? p.key,
    playing: playback?.playing ?? false,
    item: playback?.item ?? null,
    context: playback?.context ?? null,
    progressMs: Math.max(0, Math.round(playback?.progressMs ?? 0)),
    durationMs: Math.max(0, Math.round(playback?.durationMs ?? playback?.item?.durationMs ?? 0)),
    device: playback?.device ?? null,
    volume: playback?.volume ?? null,
    at: playback?.at ?? new Date().toISOString(),
    features: MUSIC_FEATURES.filter((f) => p.features.has(f)),
    ...(playback?.video !== undefined ? { video: playback.video } : {}),
    ...extra,
  };
}

/** What the model learns: the state in words, never provider payloads. */
function describe(pb: Playback | null) {
  if (!pb?.item) return { playing: false, nothing: true };
  return {
    playing: pb.playing,
    track: pb.item.title,
    by: pb.item.subtitle,
    ...(pb.context?.title ? { from: pb.context.title } : {}),
    ...(pb.device ? { device: pb.device.name } : {}),
    ...(pb.volume !== null ? { volume: pb.volume } : {}),
    provider: pb.provider,
  };
}

/** After a control: the fresh state (or, for an embedded player, the state it will reach). */
async function after(
  p: MusicProvider,
  env: ToolRunEnv,
  command: MusicCommand | void,
  expect: (pb: Playback | null) => Playback | null = (pb) => pb,
): Promise<ToolRunResult<unknown>> {
  await settle(p);
  const pb = expect(await current(p, env));
  return {
    output: describe(pb),
    display: { kind: "music", music: musicPayloadOf(p, pb), ...(command ? { command } : {}) },
  };
}

const KINDS = ["track", "album", "artist", "playlist", "video"] as const;

// ── Read ─────────────────────────────────────────────────────────────────────

const searchInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    kind: z.enum(KINDS).optional(),
  })
  .strict();

export const searchMusicTool: ToolDefinition = {
  name: "music.search",
  capability: "music",
  operation: "search",
  description:
    '"Buscame canciones de X", "¿qué discos tiene Y?": search without playing. Results appear on the Music Surface; play one with music.play and its ref.',
  input: searchInput,
  async describe() {
    return { summary: "Search music" };
  },
  async run(raw, env) {
    const q = searchInput.parse(raw);
    const p = provider(env);
    need(p, "search", "Searching");
    const results = await p.search({
      query: q.query,
      kinds: q.kind ? [q.kind] : defaultKinds(p, "exact"),
      limit: 8,
    });
    const pb = await current(p, env);
    return {
      output: {
        results: results.map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, by: r.subtitle })),
      },
      display: { kind: "music", music: musicPayloadOf(p, pb, { results: results.slice(0, 10) }) },
    };
  },
};

export const getPlaybackTool: ToolDefinition = {
  name: "music.getPlayback",
  capability: "music",
  operation: "getPlayback",
  description: '"¿Qué está sonando?", "¿qué es esto?": what is playing now, where and how loud.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Current music" };
  },
  async run(_raw, env) {
    const p = provider(env);
    const pb = await current(p, env);
    return { output: describe(pb), display: { kind: "music", music: musicPayloadOf(p, pb) } };
  },
};

export const listDevicesTool: ToolDefinition = {
  name: "music.listDevices",
  capability: "music",
  operation: "listDevices",
  description: '"¿En qué dispositivos puedo poner música?": the user\'s playback devices.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Music devices" };
  },
  async run(_raw, env) {
    const p = provider(env);
    need(p, "devices", "Choosing a device");
    const [devices, pb] = await Promise.all([p.devices!(), current(p, env)]);
    return {
      output: { devices: devices.map((d) => ({ name: d.name, type: d.type, active: d.active })) },
      display: { kind: "music", music: musicPayloadOf(p, pb, { devices }) },
    };
  },
};

// ── Play ─────────────────────────────────────────────────────────────────────

function defaultKinds(p: MusicProvider, mode: "exact" | "discovery"): MusicKind[] {
  if (embedded(p)) return mode === "discovery" ? ["playlist", "video"] : ["video", "playlist"];
  return mode === "discovery" ? ["playlist", "track"] : ["artist", "album", "track", "playlist"];
}

const playInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'What to play, as named ("Daft Punk", "Random Access Memories") or, for discovery, a short descriptive search ("calm piano focus", "upbeat running", "instrumental lo-fi").',
      ),
    mode: z
      .enum(["exact", "discovery"])
      .default("exact")
      .describe(
        'exact: the user named an artist, album, song or playlist. discovery: a mood, genre or activity ("algo tranquilo para estudiar", "jazz tranquilo", "algo parecido a X").',
      ),
    kind: z
      .enum(KINDS)
      .optional()
      .describe('Only when the user said it ("el álbum", "la canción").'),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("A ref from search results or the Music Surface (with its kind)."),
    mine: z
      .boolean()
      .default(false)
      .describe('"Mi playlist Workout": one of the user\'s own playlists.'),
    video: z
      .boolean()
      .default(false)
      .describe("The user wants to watch (a video), not just listen."),
    device: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Where to play ("el parlante del living"), only if the user said it.'),
  })
  .strict()
  .refine((q) => q.query || q.ref, { message: "Say what to play (query) or pass a ref" });

export const playMusicTool: ToolDefinition = {
  name: "music.play",
  capability: "music",
  operation: "play",
  description:
    '"Poné Daft Punk", "poné mi playlist Workout", "poneme algo tranquilo para estudiar", "poné jazz": finds and starts music at once. An artist plays their music (don\'t ask which song); an exact name that matches nothing confidently returns choices to ask about. Playback controls never need approval.',
  input: playInput,
  async describe(raw, env) {
    const q = playInput.parse(raw);
    return { summary: es(env) ? `Poner ${q.query ?? "música"}` : `Play ${q.query ?? "music"}` };
  },
  async run(raw, env) {
    const q = playInput.parse(raw);
    const p = provider(env);
    let item: MusicItem | null = null;
    let queue: MusicItem[] | null = null;
    let results: MusicItem[] = [];

    if (q.ref) {
      item = {
        ref: q.ref,
        kind: q.kind ?? "track",
        title: q.query ?? "",
        subtitle: null,
        artwork: null,
        durationMs: null,
        url: null,
        provider: p.key,
      };
    } else if (q.mine) {
      need(p, "playlists", "Your own playlists");
      const own = await p.myPlaylists!();
      const ranked = own
        .map((pl) => ({ pl, score: matchScore(pl, q.query!) }))
        .sort((a, b) => b.score - a.score);
      if (!ranked.length || ranked[0]!.score < 0.5)
        throw new AppError(
          "NOT_FOUND",
          own.length
            ? `No playlist of yours matches "${q.query}". Yours: ${own
                .slice(0, 12)
                .map((x) => x.title)
                .join(", ")}`
            : "You have no playlists there.",
          { recovery: "review" },
        );
      item = ranked[0]!.pl;
    } else {
      need(p, "search", "Searching");
      results = await p.search({
        query: q.query!,
        kinds: q.kind ? [q.kind] : defaultKinds(p, q.mode),
        limit: 8,
      });
      const pick = pickToPlay(results, q.query!, q.mode, q.kind);
      if (pick.kind === "none")
        throw new AppError("NOT_FOUND", `Nothing found for "${q.query}".`, { recovery: "review" });
      if (pick.kind === "ambiguous") {
        const pb = await current(p, env);
        return {
          output: {
            started: false,
            needsChoice: pick.candidates.map((c) => ({
              ref: c.ref,
              kind: c.kind,
              title: c.title,
              by: c.subtitle,
            })),
            instructions:
              "Nothing matched what the user named confidently. Ask which one in one short question (the options are on screen), then call music.play with its ref and kind.",
          },
          display: { kind: "music", music: musicPayloadOf(p, pb, { results: pick.candidates }) },
        };
      }
      item = pick.item;
      // An embedded player plays a controlled queue: the matching videos, best first.
      if (embedded(p) && item.kind === "video")
        queue = [
          ...new Map(
            [item, ...results.filter((r) => r.kind === "video")].map((r) => [r.ref, r]),
          ).values(),
        ];
    }

    let deviceId: string | null = null;
    if (q.device) {
      need(p, "devices", "Choosing a device");
      const found = pickDevice(await p.devices!(), q.device);
      if (found.kind !== "found")
        throw new AppError(
          "VALIDATION_ERROR",
          found.kind === "ask"
            ? `Which device? ${found.options.map((d) => d.name).join(", ")}`
            : "No device is available. Open the provider's app on a device first.",
          { recovery: "review" },
        );
      deviceId = found.device.id;
    }

    const command = await p.play(queue ? { tracks: queue, deviceId } : { item: item!, deviceId });
    // An embedded command loads with video only when asked: a music request stays compact.
    const cmd =
      command && command.action === "load"
        ? { ...command, video: q.video }
        : (command ?? undefined);
    return after(p, env, cmd, (pb) =>
      pb?.item
        ? pb
        : // The provider hasn't reported it yet: show what was asked to play.
          {
            provider: p.key,
            playing: true,
            item: item!.kind === "track" || item!.kind === "video" ? item : null,
            context:
              item!.kind === "track" || item!.kind === "video"
                ? null
                : { kind: item!.kind, title: item!.title, ref: item!.ref },
            progressMs: 0,
            durationMs: item!.durationMs ?? 0,
            device: pb?.device ?? null,
            volume: pb?.volume ?? null,
            at: new Date().toISOString(),
            ...(embedded(p) ? { video: q.video } : {}),
          },
    ).then((r) => ({
      ...r,
      output: {
        started: true,
        playing: { title: item!.title, by: item!.subtitle, kind: item!.kind },
        ...(r.output as object),
      },
    }));
  },
};

// ── Controls ─────────────────────────────────────────────────────────────────

function control(
  op: "pause" | "resume" | "next" | "previous",
  description: string,
  says: { es: string; en: string },
): ToolDefinition {
  return {
    name: `music.${op}`,
    capability: "music",
    operation: op,
    description,
    input: z.object({}).strict(),
    async describe(_raw, env) {
      return { summary: es(env) ? says.es : says.en };
    },
    confirm(output, locale) {
      const o = output as { track?: string; by?: string | null };
      if (op === "pause") return locale === "es" ? "Listo, pausé la música." : "Paused.";
      if (op === "resume") return locale === "es" ? "Listo, sigue sonando." : "Playing again.";
      return o.track
        ? locale === "es"
          ? `Ahora suena “${o.track}”${o.by ? ` de ${o.by}` : ""}.`
          : `Now playing “${o.track}”${o.by ? ` by ${o.by}` : ""}.`
        : null;
    },
    async run(_raw, env) {
      const p = provider(env);
      const command = await p[op]();
      return after(p, env, command, (pb) =>
        pb && (op === "pause" || op === "resume") ? { ...pb, playing: op === "resume" } : pb,
      );
    },
  };
}

export const pauseMusicTool = control("pause", '"Pausá la música", "pará": pauses playback.', {
  es: "Pausar música",
  en: "Pause music",
});
export const resumeMusicTool = control(
  "resume",
  '"Seguí", "dale play", "volvé a poner la música": resumes playback.',
  { es: "Reanudar música", en: "Resume music" },
);
export const nextMusicTool = control("next", '"Pasá esta", "la siguiente", "skip": next track.', {
  es: "Siguiente canción",
  en: "Next track",
});
export const previousMusicTool = control(
  "previous",
  '"Volvé a la anterior", "la de antes": previous track.',
  { es: "Canción anterior", en: "Previous track" },
);

const seekInput = z
  .object({
    seconds: z.number().min(0).max(36_000).optional().describe("Absolute position."),
    by: z.number().min(-3_600).max(3_600).optional().describe("Relative: +30, -15."),
  })
  .strict()
  .refine((q) => q.seconds !== undefined || q.by !== undefined, "Give seconds or by");

export const seekMusicTool: ToolDefinition = {
  name: "music.seek",
  capability: "music",
  operation: "seek",
  description: '"Adelantá 30 segundos", "volvé al principio", "andá al minuto 2".',
  input: seekInput,
  async describe() {
    return { summary: "Seek" };
  },
  async run(raw, env) {
    const q = seekInput.parse(raw);
    const p = provider(env);
    need(p, "seek", "Seeking");
    const pb = q.seconds === undefined ? await current(p, env) : null;
    const ms = Math.max(
      0,
      Math.round(q.seconds !== undefined ? q.seconds * 1000 : (pb?.progressMs ?? 0) + q.by! * 1000),
    );
    const command = await p.seek(ms);
    return after(p, env, command, (x) => (x ? { ...x, progressMs: ms } : x));
  },
};

const volumeInput = z
  .object({
    percent: z.number().min(0).max(100).optional().describe('"Bajalo al 30%" → 30.'),
    change: z
      .enum(["up", "down", "mute"])
      .optional()
      .describe('"Subilo", "bajalo un poco", "silencio".'),
    by: z.number().min(1).max(100).optional().describe('How much, when said ("bajalo 20").'),
  })
  .strict()
  .refine((q) => q.percent !== undefined || q.change, "Give percent or change");

export const setVolumeTool: ToolDefinition = {
  name: "music.setVolume",
  capability: "music",
  operation: "setVolume",
  description: '"Bajalo un poco", "subilo", "bajalo al 30%": the music\'s volume.',
  input: volumeInput,
  async describe() {
    return { summary: "Music volume" };
  },
  confirm(output, locale) {
    const v = (output as { volume?: number }).volume;
    return v === undefined
      ? null
      : locale === "es"
        ? `Listo, volumen al ${v}%.`
        : `Volume at ${v}%.`;
  },
  async run(raw, env) {
    const q = volumeInput.parse(raw);
    const p = provider(env);
    need(p, "volume", "Changing the volume");
    const pb = await current(p, env);
    if (pb?.device && !pb.device.supportsVolume)
      throw new AppError(
        "CAPABILITY_UNAVAILABLE",
        `"${pb.device.name}" doesn't let ELISE change its volume. Use the device itself.`,
        { recovery: "none" },
      );
    const volume = nextVolume(pb?.volume ?? null, q);
    const command = await p.setVolume(volume);
    const r = await after(p, env, command, (x) => (x ? { ...x, volume } : x));
    return { ...r, output: { ...(r.output as object), volume } };
  },
};

const transferInput = z
  .object({
    device: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('The device as the user named it ("el parlante del living", "otro dispositivo").'),
  })
  .strict();

export const transferMusicTool: ToolDefinition = {
  name: "music.transfer",
  capability: "music",
  operation: "transfer",
  description:
    '"Mandalo al parlante del living", "ponelo en otro dispositivo", "pasalo acá": moves playback to another device. Several could match → it lists them to ask.',
  input: transferInput,
  async describe(raw, env) {
    const d = transferInput.parse(raw).device;
    return { summary: es(env) ? `Pasar la música a ${d}` : `Move music to ${d}` };
  },
  async run(raw, env) {
    const p = provider(env);
    need(p, "transfer", "Moving playback to another device");
    const devices = await p.devices!();
    const found = pickDevice(devices, transferInput.parse(raw).device);
    if (found.kind !== "found") {
      const pb = await current(p, env);
      return {
        output: {
          moved: false,
          ...(found.kind === "ask"
            ? {
                options: found.options.map((d) => d.name),
                instructions: "Ask which device in one short question; they're on screen.",
              }
            : { reason: "No device is available. Open the provider's app on a device first." }),
        },
        display: { kind: "music", music: musicPayloadOf(p, pb, { devices }) },
      };
    }
    await p.transfer!(found.device.id, true);
    const r = await after(p, env, undefined, (pb) =>
      pb ? { ...pb, device: { ...found.device, active: true } } : pb,
    );
    return { ...r, output: { moved: true, device: found.device.name, ...(r.output as object) } };
  },
};

export const MUSIC_TOOLS = [
  searchMusicTool,
  getPlaybackTool,
  listDevicesTool,
  playMusicTool,
  pauseMusicTool,
  resumeMusicTool,
  nextMusicTool,
  previousMusicTool,
  seekMusicTool,
  setVolumeTool,
  transferMusicTool,
];

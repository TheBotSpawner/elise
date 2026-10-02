import { describe, expect, it } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import { knowledgeMap, resolveMentioned, type KnowledgeNode } from "@/core/history/links";
import type { LocationCapability, Route } from "@/core/location/model";
import {
  boostPhrases,
  mergeRecallHits,
  quotedPhrases,
  recallDue,
  type RecallHit,
  type RecallReader,
  type RecallSession,
} from "@/core/recall/model";
import { setupFailure, GoogleMapsLocation } from "@/infrastructure/location/google-maps";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Core reliability (object first, Recall coverage, initiative, Location availability). Names
 * here are synthetic: the behaviour is general, never tied to one user's Sections or phrases.
 */

const SPACE = "s-uni";
const SECTION = "s-calc";
const nodes: KnowledgeNode[] = [
  { id: SPACE, name: "University", parentId: null, parentName: null, archived: false },
  {
    id: SECTION,
    name: "CALC3",
    parentId: SPACE,
    parentName: "University",
    archived: false,
    aliases: ["Calculus III"],
  },
  {
    id: "s-hist",
    name: "History",
    parentId: SPACE,
    parentName: "University",
    archived: false,
  },
  {
    id: "s-old",
    name: "Physics",
    parentId: SPACE,
    parentName: "University",
    archived: true,
  },
];

describe("object first: resolving the Section a message names", () => {
  it("resolves by description alias with Roman numerals read as digits", () => {
    expect(resolveMentioned("¿Qué dice el cronograma de calculus 3?", nodes)?.id).toBe(SECTION);
    expect(resolveMentioned("el programa de Calculus III", nodes)?.id).toBe(SECTION);
    expect(resolveMentioned("apuntes de CALC3", nodes)?.id).toBe(SECTION);
  });

  it("a Space named with its Section resolves to the Section; unrelated pairs to nothing", () => {
    expect(resolveMentioned("University: el parcial de Calculus III", nodes)?.id).toBe(SECTION);
    expect(resolveMentioned("comparar Calculus III con History", nodes)).toBeNull();
    expect(resolveMentioned("¿Qué tengo mañana en mi calendario?", nodes)).toBeNull();
    expect(resolveMentioned("apuntes de Physics", nodes)).toBeNull();
  });

  it("the model sees every Space/Section with the names the user gave them", () => {
    expect(knowledgeMap(nodes)).toContainEqual({
      path: "University › CALC3",
      aliases: ["Calculus III"],
    });
    expect(knowledgeMap(nodes).some((n) => n.path.includes("Physics"))).toBe(false);
  });
});

const base = {
  user: { displayName: null, locale: "es" as const, timezone: "UTC" },
  now: new Date("2026-10-02T15:00:00Z"),
  availableCapabilities: ["calendar", "tasks", "knowledge", "lists"] as const,
  history: [],
  userMessage: "x",
};

describe("runtime guidance", () => {
  const text = buildContextPackage({
    ...base,
    knowledgeMap: knowledgeMap(nodes),
    resolvedSpace: "University › CALC3",
  }).instructions;

  it("routes by the object, not by nouns like calendario/cronograma/tareas/lista", () => {
    expect(text).toContain("Object first, tool second");
    expect(text).toMatch(/"el cronograma de <a subject\/Section>".*knowledge\.search/);
    expect(text).toMatch(/"mi calendario".*calendar\.\*/);
    expect(text).toContain('"mis tareas de hoy" → tasks');
    expect(text).toContain('"mi lista de compras" → lists');
    expect(text).toContain("Knowledge finding nothing is not a reason to look in the calendar");
  });

  it("names the Section ELISE resolved and lists the user's Knowledge map", () => {
    expect(text).toContain('This message is about the Section "University › CALC3"');
    expect(text).toContain("- University › CALC3 — Calculus III");
    expect(text).toContain("never ask which one");
  });

  it("initiative: defaults for optional parameters, no re-asking, risky actions still ask", () => {
    expect(text).toContain("Optional tool parameters are not questions for the user");
    expect(text).toContain("no time → now");
    expect(text).toContain("Never re-ask");
    expect(text).toMatch(/risky or hard to undo \(sending, deleting, money/);
    expect(text).toContain("Approvals and confirmations for those stay exactly as they are");
  });

  it("abilities are the run's tools: a missing Maps setup is said, never guessed around", () => {
    expect(text).toContain("never say you lack access to something a tool provides");
    const off = buildContextPackage({ ...base, location: null }).instructions;
    expect(off).toContain("Location/maps: not set up in this deployment");
    const on = buildContextPackage({ ...base, location: { here: false } }).instructions;
    expect(on).toContain("Never ask for the mode or the time before answering");
    expect(on).toContain('"Maps setup:"');
  });

  it("Recall: searched first when asked, relative dates read from that interaction", () => {
    expect(text).toContain("search Recall (history.search) first and thoroughly");
    expect(text).toContain("relative to THAT interaction's date");
  });
});

// ── Recall ───────────────────────────────────────────────────────────────────

const hit = (chunkId: string, sessionId: string, content: string, score: number): RecallHit => ({
  chunkId,
  sessionId,
  content,
  startedAt: "2026-10-01T23:00:00Z",
  endedAt: "2026-10-01T23:01:00Z",
  similarity: 0.4,
  keywordMatched: false,
  score,
});

describe("Recall coverage and retrieval", () => {
  it("typed and voice interactions behind the index are both due, newest first", () => {
    const due = recallDue(
      [
        { id: "c-indexed", last_message_at: "2026-10-01T10:00:00Z" },
        { id: "c-new", last_message_at: "2026-10-02T09:00:00Z" },
        { id: "c-current", last_message_at: "2026-10-02T12:00:00Z" },
      ],
      [
        {
          id: "s-c1",
          conversation_id: "c-indexed",
          indexed_through: "2026-10-01T10:00:00.500Z",
          last_activity_at: "2026-10-01T10:00:00Z",
        },
        {
          id: "s-voice",
          conversation_id: null,
          indexed_through: null,
          last_activity_at: "2026-10-01T23:22:00Z",
        },
        {
          id: "s-voice-done",
          conversation_id: null,
          indexed_through: "2026-10-01T20:00:00Z",
          last_activity_at: "2026-10-01T20:00:00Z",
        },
      ],
      { skip: ["c-current"], limit: 10 },
    );
    expect(due.map((d) => d.conversationId ?? d.sessionId)).toEqual(["c-new", "s-voice"]);
  });

  it("merges query variants (each excerpt once, best score) and boosts exact phrases", () => {
    const merged = mergeRecallHits([
      [hit("a", "s1", "User: something about mail", 0.03)],
      [hit("a", "s1", "User: something about mail", 0.02), hit("b", "s2", "x", 0.01)],
    ]);
    expect(merged.map((h) => [h.chunkId, h.score])).toEqual([
      ["a", 0.03],
      ["b", 0.01],
    ]);
    const boosted = boostPhrases(
      [
        hit("loose", "s1", "User: check my calendar settings", 0.032),
        hit("exact", "s2", "ELISE: Listo: creé el evento 'Water Plants' para mañana", 0.016),
      ],
      ["water plants"],
    );
    expect(boosted[0]!.chunkId).toBe("exact");
    expect(boosted[0]!.keywordMatched).toBe(true);
    expect(quotedPhrases('un evento "Water Plants" o algo así')).toEqual(["Water Plants"]);
  });

  it("history.search keeps the user's own sentence alongside the model's reduced query", async () => {
    const texts: string[] = [];
    const sessions: RecallSession[] = [
      {
        id: "voice-1",
        conversationId: null,
        modality: "voice",
        title: "Calendars",
        summary: "Talked about calendars",
        topics: [],
        startedAt: "2026-10-01T23:21:00Z",
        lastActivityAt: "2026-10-01T23:22:00Z",
      },
    ];
    const reader: RecallReader = {
      async search(q) {
        texts.push(q.text);
        // Only the full sentence reaches the excerpt (like a reduced keyword query missing it).
        return {
          semantic: true,
          hits: q.text.includes("agregar")
            ? [
                hit(
                  "v1",
                  "voice-1",
                  "User: ¿Podés agregar un evento que sea water plants mañana? ELISE: Listo: creé 'Water Plants'.",
                  0.016,
                ),
              ]
            : [],
        };
      },
      async sessions(ids) {
        return sessions.filter((s) => ids.includes(s.id));
      },
      async recent() {
        return sessions;
      },
      async turns() {
        return [];
      },
    };
    const { ports } = makePorts([]);
    ports.providers = {
      get: ((c: string) => (c === "history" ? reader : undefined)) as ProviderFactory["get"],
    };
    const said = "Buscame la conversación donde te pedí agregar un evento para water plants";
    const out = await executeToolCall(
      ports,
      makeCtx({ userMessage: said, interactionSessionId: "voice-now" }),
      { name: "history.search", args: { query: "evento calendario", phrases: ["Water Plants"] } },
    );
    expect(texts).toEqual(["evento calendario", said]);
    expect(out).toMatchObject({
      status: "succeeded",
      output: { enough: true, interactions: [{ modality: "voice" }] },
    });
  });
});

// ── Location availability and initiative ────────────────────────────────────

const route = (mode: Route["mode"], s: number): Route => ({
  mode,
  distanceMeters: 4200,
  durationSeconds: s,
  polyline: null,
  warnings: [],
  start: null,
  end: null,
  mapsUrl: null,
});

function maps(over: Partial<LocationCapability>): LocationCapability {
  const none = async () => [];
  return {
    searchPlaces: none,
    getPlace: async () => null,
    geocode: none,
    reverseGeocode: none,
    route: async () => null,
    matrix: none,
    ...over,
  };
}

function run(m: LocationCapability, args: unknown) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "location" ? m : undefined)) as ProviderFactory["get"],
  };
  return executeToolCall(ports, makeCtx(), { name: "location.getRoute", args });
}

describe("Location: route without questions", () => {
  it("no mode named: compares driving, transit and walking, leaving now", async () => {
    const asked: string[] = [];
    const out = await run(
      maps({
        route: async (r) => {
          asked.push(`${r.mode}:${r.departAt}`);
          return route(r.mode, r.mode === "drive" ? 900 : r.mode === "transit" ? 1500 : 3000);
        },
      }),
      { from: "Origin St 1", to: "Destination Ave" },
    );
    expect(asked).toEqual(["drive:null", "transit:null", "walk:null"]);
    expect(out).toMatchObject({
      status: "succeeded",
      output: {
        mode: "drive",
        minutes: 15,
        assumed: "leaving now",
        otherModes: [
          { mode: "transit", minutes: 25 },
          { mode: "walk", minutes: 50 },
        ],
      },
      display: { map: { route: { alternatives: [{ mode: "transit" }, { mode: "walk" }] } } },
    });
  });

  it('"en auto": one driving route, now', async () => {
    const asked: string[] = [];
    await run(
      maps({
        route: async (r) => {
          asked.push(r.mode);
          return route(r.mode, 600);
        },
      }),
      { from: "A street 1", to: "B avenue", mode: "drive" },
    );
    expect(asked).toEqual(["drive"]);
  });

  it("a setup error is the answer (precise), not a silent 'no maps'", async () => {
    const setup = setupFailure("API_KEY_HTTP_REFERRER_BLOCKED", "routes")!;
    const out = await run(
      maps({
        route: async () => {
          throw setup;
        },
      }),
      { from: "A street 1", to: "B avenue" },
    );
    expect(out).toMatchObject({
      status: "failed",
      error: { code: "CAPABILITY_UNAVAILABLE", recovery: "configure" },
    });
    if (out.status === "failed") expect(out.error.message).toContain("Routes API");
  });
});

describe("Google setup errors are classified", () => {
  it.each([
    ["API_KEY_HTTP_REFERRER_BLOCKED", "key_referrer_restricted"],
    ["PERMISSION_DENIED SERVICE_DISABLED", "api_disabled"],
    ["Routes API has not been used in project 1 before or it is disabled", "api_disabled"],
    ["API_KEY_SERVICE_BLOCKED", "api_not_allowed"],
    ["API key not valid. Please pass a valid API key.", "key_invalid"],
    ["BILLING_DISABLED", "billing"],
  ])("%s → %s", (reason, setup) => {
    expect(setupFailure(reason, "routes")?.details).toEqual({ setup, api: "Routes API" });
  });

  it("reads Google's reason from the error body (Routes, Places) and Geocoding's status", async () => {
    const body = {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED", metadata: { service: "routes.googleapis.com" } }],
      },
    };
    const http = (async (url: string | URL | Request) =>
      String(url).includes("geocode")
        ? new Response(
            JSON.stringify({
              status: "REQUEST_DENIED",
              error_message: "API keys with referer restrictions cannot be used with this API.",
            }),
          )
        : new Response(JSON.stringify(body), { status: 403 })) as typeof fetch;
    const g = new GoogleMapsLocation("k", undefined, http);
    await expect(
      g.route({
        origin: { address: "A" },
        destination: { address: "B" },
        stops: [],
        mode: "drive",
        departAt: null,
        language: "es",
      }),
    ).rejects.toMatchObject({ details: { setup: "api_disabled", api: "Routes API" } });
    await expect(g.geocode("A", "es")).rejects.toMatchObject({
      details: { setup: "key_referrer_restricted", api: "Geocoding API" },
    });
  });
});

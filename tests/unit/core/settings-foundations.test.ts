import { describe, expect, it, vi } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import {
  activeFacts,
  editFact,
  forget,
  MAX_FACTS,
  prune,
  remember,
  type MemoryFact,
} from "@/core/memory/model";
import {
  categoryOf,
  formatBytes,
  summarizeStorage,
  type StoredFile,
} from "@/core/storage/accounting";
import { voicePreferences, WAKE_PHRASE, webVoiceCapabilities } from "@/core/voice/preferences";

vi.mock("server-only", () => ({}));
vi.mock("@/application/knowledge-service", () => ({ deleteItem: vi.fn() }));

const NOW = "2026-10-16T12:00:00.000Z";
const LATER = "2026-10-17T12:00:00.000Z";

// ── Voice (ADR-068) ──────────────────────────────────────────────────────────

describe("voice preferences", () => {
  const row = {
    voice_language: "auto" as const,
    voice_name: "elise" as const,
    voice_continuous: true,
  };

  it("three choices; the rest are good defaults", () => {
    expect(voicePreferences(row)).toEqual({
      enabled: true,
      speak: true,
      language: "auto",
      voice: "elise",
      continuous: true,
      bargeIn: true,
      wakeEnabled: true,
      wakePhrase: "elise",
    });
  });

  it("older rows read safely: a custom phrase or turned-off toggles don't survive", () => {
    const legacy = {
      ...row,
      voice_continuous: false,
      voice_enabled: false,
      voice_output: false,
      voice_barge_in: false,
      voice_wake_enabled: true,
      voice_wake_phrase: "liz",
    };
    const v = voicePreferences(legacy);
    expect(v.wakePhrase).toBe(WAKE_PHRASE);
    expect(WAKE_PHRASE).toBe("elise");
    expect(v).toMatchObject({ enabled: true, speak: true, bargeIn: true });
    // "Elise" only wakes a resting session in continuous mode.
    expect(v.wakeEnabled).toBe(false);
    expect(voicePreferences({ ...row, voice_continuous: null }).continuous).toBe(false);
  });

  it("voice language is separate from the interface language", () => {
    for (const language of ["auto", "es", "en"] as const)
      expect(voicePreferences({ ...row, voice_language: language }).language).toBe(language);
  });

  it("the web never claims background wake-word listening", () => {
    expect(webVoiceCapabilities("granted")).toEqual({
      platform: "web",
      microphone: "granted",
      backgroundWake: "unsupported",
    });
    // A preference is not a permission: continuous on with the microphone denied stays denied.
    expect(webVoiceCapabilities("denied").microphone).toBe("denied");
  });
});

// ── Memory (ADR-068) ─────────────────────────────────────────────────────────

const said = (key: string, value: string, conversationId: string | null = "c1") => ({
  key,
  value,
  confidence: "stated" as const,
  conversationId,
});

describe("memory facts", () => {
  it("remembers with provenance; saying it again confirms instead of duplicating", () => {
    const a = remember([], said("trabajo.horario", "De 9 a 18"), NOW, "f1");
    expect(a.fact).toMatchObject({
      key: "trabajo.horario",
      value: "De 9 a 18",
      sources: ["c1"],
      status: "active",
    });
    const b = remember(a.facts, said("trabajo.horario", "de 9 a 18", "c2"), LATER, "f2");
    expect(b.facts).toHaveLength(1);
    expect(b.fact.sources).toEqual(["c1", "c2"]);
    expect(b.fact.lastConfirmedAt).toBe(LATER);
  });

  it("a stated change replaces; an inference never overwrites what the person said", () => {
    const a = remember([], said("respuestas.formato", "Cortas"), NOW, "f1");
    const inferred = remember(
      a.facts,
      { ...said("respuestas.formato", "Largas"), confidence: "inferred" },
      LATER,
      "f2",
    );
    expect(inferred.kept).toBe(true);
    expect(activeFacts(inferred.facts).map((f) => f.value)).toEqual(["Cortas"]);
    const changed = remember(a.facts, said("respuestas.formato", "Con viñetas"), LATER, "f3");
    expect(changed.replaced?.value).toBe("Cortas");
    expect(activeFacts(changed.facts).map((f) => f.value)).toEqual(["Con viñetas"]);
    // The old one stays as history, not as current memory.
    expect(changed.facts.find((f) => f.id === "f1")?.status).toBe("superseded");
  });

  it("never keeps secrets", () => {
    expect(() => remember([], said("banco", "Mi contraseña es hunter2"), NOW, "f")).toThrow();
    expect(() => remember([], said("tarjeta", "4111 1111 1111 1111"), NOW, "f")).toThrow();
  });

  it("edit and forget", () => {
    const a = remember([], said("socia", "Ana"), NOW, "f1").facts;
    const edited = editFact(a, "f1", "Ana Gómez", LATER);
    expect(edited[0]).toMatchObject({ value: "Ana Gómez", confidence: "stated" });
    expect(forget(edited, "f1")).toEqual([]);
    expect(forget(edited, "socia")).toEqual([]);
  });

  it("a deleted conversation takes its evidence: inferences without evidence go", () => {
    const facts: MemoryFact[] = [
      ...remember([], { ...said("rutina", "Gym los lunes"), confidence: "inferred" }, NOW, "f1")
        .facts,
    ];
    const stated = remember(facts, said("ciudad", "Buenos Aires", "c9"), NOW, "f2").facts;
    const after = prune(stated, new Set());
    expect(after.map((f) => f.key)).toEqual(["ciudad"]);
    expect(after[0]!.sources).toEqual([]);
    // Facts written in Settings never had a conversation to lose.
    const manual = remember([], said("apodo", "Leo", null), NOW, "f3").facts;
    expect(prune(manual, new Set())).toEqual(manual);
  });

  it("is bounded", () => {
    let facts: MemoryFact[] = [];
    for (let i = 0; i < MAX_FACTS + 10; i++)
      facts = remember(facts, said(`k${i}`, `v${i}`), NOW, `f${i}`).facts;
    expect(facts).toHaveLength(MAX_FACTS);
  });

  it("reaches the model only when given (Memory on), as data separate from Recall", () => {
    const base = {
      user: { displayName: "Leo", locale: "es" as const, timezone: "UTC" },
      now: new Date(NOW),
      availableCapabilities: [],
      history: [],
      userMessage: "hola",
    };
    const off = buildContextPackage(base).instructions;
    expect(off).not.toContain("Settings › Memoria");
    const on = buildContextPackage({
      ...base,
      memory: [{ key: "trabajo.horario", value: "De 9 a 18" }],
    }).instructions;
    expect(on).toContain("- trabajo.horario: De 9 a 18");
  });
});

// ── Storage (ADR-068) ────────────────────────────────────────────────────────

const file = (over: Partial<StoredFile>): StoredFile => ({
  id: "x",
  origin: "knowledge",
  name: "a.pdf",
  mimeType: "application/pdf",
  bytes: 1000,
  createdAt: NOW,
  where: { kind: "space", id: "s", label: "Facultad" },
  deletable: true,
  sourceId: "i",
  ...over,
});

describe("storage accounting", () => {
  it("documents, images and attachments", () => {
    expect(categoryOf(file({}))).toBe("documents");
    expect(categoryOf(file({ mimeType: "image/png" }))).toBe("images");
    expect(categoryOf(file({ origin: "chat", mimeType: "image/jpeg" }))).toBe("images");
    expect(categoryOf(file({ origin: "chat", mimeType: "text/csv" }))).toBe("attachments");
    const s = summarizeStorage([
      file({ bytes: 1_500_000 }),
      file({ mimeType: "image/png", bytes: 500_000 }),
    ]);
    expect(s).toMatchObject({ bytes: 2_000_000, files: 2 });
    expect(s.categories.images).toEqual({ bytes: 500_000, files: 1 });
    expect(summarizeStorage([])).toMatchObject({ bytes: 0, files: 0 });
  });

  it("formats large and small values", () => {
    expect(formatBytes(1_570_000_000, "en")).toBe("1.57 GB");
    expect(formatBytes(697_000_000, "en")).toBe("697 MB");
    expect(formatBytes(2_400_000, "es")).toBe("2,4 MB");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(3_200_000_000_000, "en")).toBe("3.2 TB");
  });
});

/**
 * A small stand-in for the Supabase query builder: it applies eq / in / not-null / gte filters
 * to in-memory rows, so the services' queries are checked, not mocked away.
 */
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>, fail: string[] = []) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let head = false;
      const q = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          head = Boolean(opts?.head);
          return q;
        },
        eq(col: string, v: unknown) {
          rows = rows.filter((r) => r[col] === v);
          return q;
        },
        in(col: string, vs: unknown[]) {
          rows = rows.filter((r) => vs.includes(r[col]));
          return q;
        },
        not(col: string) {
          rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
          return q;
        },
        is(col: string, v: null) {
          rows = rows.filter((r) => (r[col] ?? null) === v);
          return q;
        },
        gte(col: string, v: string) {
          rows = rows.filter((r) => String(r[col]) >= v);
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        range(from: number, to: number) {
          rows = rows.slice(from, to + 1);
          return q;
        },
        then<T>(resolve: (r: { data: Row[] | null; count: number | null; error: unknown }) => T) {
          if (fail.includes(table))
            return Promise.resolve(resolve({ data: null, count: null, error: new Error("x") }));
          return Promise.resolve(
            resolve({ data: head ? null : rows, count: rows.length, error: null }),
          );
        },
      };
      return q;
    },
  };
}

const WS = "ws-1";
const OTHER = "ws-2";

function storageTables(): Record<string, Row[]> {
  return {
    knowledge_versions: [
      // An upload: stored by ELISE.
      {
        id: "v1",
        workspace_id: WS,
        knowledge_item_id: "i1",
        storage_path: "workspace/ws-1/knowledge/i1/v1/a.pdf",
        size_bytes: 2_000_000,
        mime_type: "application/pdf",
        created_at: NOW,
        version_number: 1,
      },
      // Drive and Notion: read live, nothing stored.
      {
        id: "v2",
        workspace_id: WS,
        knowledge_item_id: "i2",
        storage_path: null,
        size_bytes: 9_000_000,
        mime_type: "application/vnd.google-apps.document",
        created_at: NOW,
        version_number: 1,
      },
      {
        id: "v3",
        workspace_id: WS,
        knowledge_item_id: "i3",
        storage_path: null,
        size_bytes: null,
        mime_type: null,
        created_at: NOW,
        version_number: 1,
      },
      // Another workspace's file never appears.
      {
        id: "v4",
        workspace_id: OTHER,
        knowledge_item_id: "i4",
        storage_path: "workspace/ws-2/knowledge/i4/v4/b.pdf",
        size_bytes: 5_000_000,
        mime_type: "application/pdf",
        created_at: NOW,
        version_number: 1,
      },
    ],
    knowledge_items: [
      { id: "i1", workspace_id: WS, title: "Apunte", mime_type: "application/pdf", space_id: "s1" },
      { id: "i2", workspace_id: WS, title: "Doc de Drive", mime_type: null, space_id: "s1" },
      { id: "i3", workspace_id: WS, title: "Página de Notion", mime_type: null, space_id: "s1" },
    ],
    knowledge_spaces: [{ id: "s1", workspace_id: WS, name: "Facultad" }],
    chat_attachments: [
      {
        id: "a1",
        workspace_id: WS,
        name: "foto.png",
        mime_type: "image/png",
        size_bytes: 300_000,
        created_at: NOW,
        conversation_id: "c1",
        status: "sent",
      },
      // Still uploading: not stored yet.
      {
        id: "a2",
        workspace_id: WS,
        name: "x.pdf",
        mime_type: "application/pdf",
        size_bytes: 10,
        created_at: NOW,
        conversation_id: null,
        status: "uploading",
      },
    ],
    conversations: [{ id: "c1", title: "Plan de estudio", user_id: "u1", workspace_id: WS }],
  };
}

const auth = (db: unknown) =>
  ({
    db,
    workspaceId: WS,
    userId: "u1",
    profile: { timezone: "America/Argentina/Buenos_Aires" },
  }) as never;

describe("storage service", () => {
  it("counts only what ELISE stores, in this workspace", async () => {
    const { listStoredFiles } = await import("@/application/storage-service");
    const files = await listStoredFiles(auth(fakeDb(storageTables())));
    expect(files.map((f) => f.name).sort()).toEqual(["Apunte", "foto.png"]);
    const s = summarizeStorage(files);
    expect(s.bytes).toBe(2_300_000);
    expect(s.categories.documents.files).toBe(1);
    expect(s.categories.images.files).toBe(1);
    expect(files.find((f) => f.name === "foto.png")).toMatchObject({
      deletable: false,
      where: { kind: "conversation", label: "Plan de estudio" },
    });
  });

  it("an upload increases usage; deleting it decreases it", async () => {
    const { listStoredFiles } = await import("@/application/storage-service");
    const tables = storageTables();
    const before = summarizeStorage(await listStoredFiles(auth(fakeDb(tables)))).bytes;
    tables.knowledge_versions!.push({
      id: "v5",
      workspace_id: WS,
      knowledge_item_id: "i1",
      storage_path: "workspace/ws-1/knowledge/i1/v5/a.pdf",
      size_bytes: 1_000_000,
      mime_type: "application/pdf",
      created_at: LATER,
      version_number: 2,
    });
    const after = summarizeStorage(await listStoredFiles(auth(fakeDb(tables)))).bytes;
    expect(after - before).toBe(1_000_000);
    tables.knowledge_versions = tables.knowledge_versions!.filter(
      (v) => v.knowledge_item_id !== "i1",
    );
    const removed = summarizeStorage(await listStoredFiles(auth(fakeDb(tables)))).bytes;
    expect(removed).toBe(300_000);
  });

  it("empty: nothing stored", async () => {
    const { listStoredFiles } = await import("@/application/storage-service");
    expect(await listStoredFiles(auth(fakeDb({})))).toEqual([]);
  });

  it("refuses to delete anything that isn't an ELISE upload (Drive, Notion)", async () => {
    const { deleteStoredFile } = await import("@/application/storage-service");
    await expect(deleteStoredFile(auth(fakeDb(storageTables())), "i2")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

describe("usage", () => {
  it("only real counts for this month; an unreadable one is null, never zero", async () => {
    const { accountUsage } = await import("@/application/account-usage-service");
    const tables = {
      ...storageTables(),
      conversations: [
        { id: "c1", workspace_id: WS, user_id: "u1", created_at: "2026-10-10T12:00:00Z" },
        { id: "c0", workspace_id: WS, user_id: "u1", created_at: "2026-09-20T12:00:00Z" },
        { id: "cx", workspace_id: OTHER, user_id: "u9", created_at: "2026-10-10T12:00:00Z" },
      ],
      usage_events: [
        {
          workspace_id: WS,
          user_id: "u1",
          unit: "seconds",
          operation: "transcription",
          provider: "openai",
          units: 90,
          created_at: "2026-10-12T00:00:00Z",
        },
        {
          workspace_id: WS,
          user_id: "u1",
          unit: "seconds",
          operation: "speech",
          provider: "openai-live",
          units: 30,
          created_at: "2026-10-12T00:00:00Z",
        },
        // Spoken replies aren't "your voice".
        {
          workspace_id: WS,
          user_id: "u1",
          unit: "seconds",
          operation: "speech",
          provider: "elevenlabs",
          units: 500,
          created_at: "2026-10-12T00:00:00Z",
        },
      ],
      schedule_runs: [
        { id: "r1", workspace_id: WS, status: "completed", scheduled_for: "2026-10-02T11:00:00Z" },
        { id: "r2", workspace_id: WS, status: "failed", scheduled_for: "2026-10-03T11:00:00Z" },
      ],
    };
    const u = await accountUsage(auth(fakeDb(tables, ["messages"])), new Date(NOW));
    expect(u).toEqual({
      since: "2026-10-01",
      conversations: 1,
      messages: null,
      voiceSeconds: 120,
      scheduledRuns: 1,
      storageBytes: 2_300_000,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

import { FakeSupabase } from "../fixtures/fake-supabase";
import { mercadoPagoSettlementCsv } from "../fixtures/mercado-pago-settlement";

/**
 * ADR-075: a spreadsheet attached in chat goes through the Finance screen's own pipeline,
 * from the ORIGINAL stored bytes — so the same file gives the same analysis from both doors.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: null as unknown,
  files: new Map<string, Uint8Array>(),
  chat: new Map<string, Uint8Array>(),
}));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/infrastructure/supabase/storage", () => ({
  downloadFinanceImport: async (_ws: string, path: string) => state.files.get(path)!,
  uploadFinanceImport: async (_ws: string, path: string, bytes: Uint8Array) =>
    void state.files.set(path, bytes),
  downloadChatAttachment: async (_ws: string, path: string) => state.chat.get(path) ?? null,
  removeFinanceImport: async () => undefined,
  createFinanceUploadUrl: async (_ws: string, path: string) => ({ path, token: "t" }),
  financeImportPath: (_ws: string, id: string) => `fi/${id}`,
}));
vi.mock("@/application/background", () => ({
  workspaceContext: async () => ({ db: state.db, workspaceId: WS, userId: ME }),
}));
vi.mock("@/application/elise", () => ({ googleHttpFor: vi.fn() }));
vi.mock("@/infrastructure/ai", () => ({
  getAIProvider: () => {
    throw new Error("no AI in tests: rules only");
  },
}));
vi.mock("@/infrastructure/background/trigger/runtime", () => ({
  isBackgroundConfigured: () => false,
  TriggerDevBackgroundRuntime: class {},
}));

const WS = "ws-1";
const ME = "user-1";
const ATTACHMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MP = "55555555-5555-4555-8555-555555555555";

const {
  analyzeAttachmentImport,
  importAnalysis,
  inspectImport,
  prepareFileImport,
  previewFinanceImport,
  startFinanceImport,
} = await import("@/application/finance-import");

const CSV = new TextEncoder().encode(mercadoPagoSettlementCsv());
let db: FakeSupabase;
let auth: AuthContext;

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  state.files.clear();
  state.chat.clear();
  db.rows("finance_accounts").push({
    id: MP,
    workspace_id: WS,
    name: "Mercado Pago",
    archived_at: null,
  });
  db.defaults.finance_transactions = { archived_at: null };
  db.defaults.imports = {
    status: "uploading",
    mapping_config: {},
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    duplicate_rows: 0,
    imported_rows: 0,
  };
  auth = { db, workspaceId: WS, userId: ME } as unknown as AuthContext;
  state.chat.set("chat/movimientos.csv", CSV);
  db.rows("chat_attachments").push({
    id: ATTACHMENT,
    workspace_id: WS,
    user_id: ME,
    name: "movimientos.csv",
    mime_type: "text/csv",
    size_bytes: CSV.byteLength,
    storage_path: "chat/movimientos.csv",
    status: "sent",
  });
});

/** The Finance screen: upload → inspect → preview. */
async function throughTheScreen() {
  const { importId, path } = await prepareFileImport(auth, {
    name: "movimientos.csv",
    size: CSV.byteLength,
    type: "text/csv",
  });
  state.files.set(path, CSV);
  const inspection = await inspectImport(auth, importId);
  const preview = await previewFinanceImport(auth, importId, inspection.mapping);
  return importAnalysis(inspection, { ...preview, sameFile: inspection.sameFile });
}

describe("one import pipeline for the Finance screen and chat", () => {
  it("the same file gives the same analysis from both doors", async () => {
    const screen = await throughTheScreen();
    const chat = await analyzeAttachmentImport(auth, ATTACHMENT);
    const comparable = (a: typeof chat) => ({ ...a, importId: null });
    expect(comparable(chat)).toEqual(comparable(screen));
    expect(chat).toMatchObject({
      rows: 230,
      format: "Mercado Pago",
      typeStrategy: "sign",
      fileCurrency: true,
      needs: ["defaultCurrency"],
    });
  });

  it("chat reads the ORIGINAL bytes — all 230 rows, not the model's preview", async () => {
    const a = await analyzeAttachmentImport(auth, ATTACHMENT);
    const stored = [...state.files.values()][0]!;
    expect(stored).toEqual(CSV);
    expect(a.rows).toBe(230);
  });

  it("an upload the bytes prove incomplete is the only 'attach it again'", async () => {
    db.rows("chat_attachments")[0]!.size_bytes = CSV.byteLength + 10;
    await expect(analyzeAttachmentImport(auth, ATTACHMENT)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { problem: "size_mismatch" },
    });
  });

  it("choosing the currency on the card starts the same import, into the wallet's account", async () => {
    const a = await analyzeAttachmentImport(auth, ATTACHMENT);
    await expect(startFinanceImport(auth, a.importId, {})).rejects.toMatchObject({
      recovery: "review",
    });
    const r = await startFinanceImport(auth, a.importId, { defaultCurrency: "ARS" });
    expect(r).toMatchObject({ status: "completed", imported: 230 });
    const txs = db.rows("finance_transactions");
    expect(txs).toHaveLength(230);
    expect(new Set(txs.map((t) => t.account_id))).toEqual(new Set([MP]));
    expect(txs.every((t) => t.category_id === null && t.currency === "ARS")).toBe(true);
    // It shows up in the import history like any other.
    expect(db.rows("imports").find((i) => i.id === a.importId)).toMatchObject({
      status: "completed",
      imported_rows: 230,
    });
  });

  it("someone else's attachment is never readable", async () => {
    db.rows("chat_attachments")[0]!.user_id = "user-2";
    await expect(analyzeAttachmentImport(auth, ATTACHMENT)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

import { describe, expect, it } from "vitest";

import { sourceState } from "@/core/knowledge/source-state";

const counts = (ready: number, processing = 0, attention = 0) => ({ ready, processing, attention });

describe("what a connected source looks like", () => {
  it("is preparing until something is usable — never 'waiting'", () => {
    expect(sourceState({ status: "idle", lastSyncedAt: null, counts: counts(0) })).toBe(
      "preparing",
    );
    expect(sourceState({ status: "syncing", lastSyncedAt: null, counts: counts(0) })).toBe(
      "preparing",
    );
    // Listed, files still being read: still preparing (partial readiness is shown apart).
    expect(sourceState({ status: "ready", lastSyncedAt: "t", counts: counts(0, 5) })).toBe(
      "preparing",
    );
  });

  it("is up to date between background checks", () => {
    expect(sourceState({ status: "ready", lastSyncedAt: "t", counts: counts(12) })).toBe(
      "up_to_date",
    );
    // Old data stays usable while a refresh runs.
    expect(sourceState({ status: "syncing", lastSyncedAt: "t", counts: counts(12) })).toBe(
      "syncing",
    );
    expect(sourceState({ status: "ready", lastSyncedAt: "t", counts: counts(12, 2) })).toBe(
      "syncing",
    );
  });

  it("needs attention when the account or the source can't be read", () => {
    for (const status of ["needs_attention", "disconnected"])
      expect(sourceState({ status, lastSyncedAt: "t", counts: counts(12) })).toBe(
        "needs_attention",
      );
  });
});

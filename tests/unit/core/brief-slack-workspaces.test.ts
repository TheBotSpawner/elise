import { describe, expect, it } from "vitest";

import { morningBriefConfigSchema, slackReady } from "@/core/schedules/schedule";

/** The Slack block reads channels from one or more workspaces (ADR-062). */
describe("Slack in a brief: several workspaces", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("channels from two workspaces, each with its own connection, are a valid block", () => {
    const config = morningBriefConfigSchema.parse({
      blocks: ["slack"],
      slack: {
        connectionId: B,
        channels: [
          { id: "C1", name: "general", connectionId: A },
          { id: "C9", name: "ventas", connectionId: B },
        ],
      },
    });
    expect(config.slack.channels.map((c) => c.connectionId)).toEqual([A, B]);
  });

  it("an older config (one workspace for every channel) still works", () => {
    expect(slackReady({ connectionId: A, channels: [{ id: "C1" } as never] })).toBe(true);
    expect(() =>
      morningBriefConfigSchema.parse({
        blocks: ["slack"],
        slack: { connectionId: A, channels: [{ id: "C1", name: "general" }] },
      }),
    ).not.toThrow();
  });

  it("a channel with no workspace at all, or no channels, isn't ready", () => {
    expect(slackReady({ connectionId: null, channels: [{ id: "C1" } as never] })).toBe(false);
    expect(slackReady({ connectionId: A, channels: [] })).toBe(false);
  });
});

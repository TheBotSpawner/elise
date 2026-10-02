import "server-only";

/**
 * Feature flags (ADR-019): a deliberately small mechanism, not an experimentation platform.
 * Each flag has a default per environment; ELISE_FLAGS overrides it:
 *
 *   ELISE_FLAGS="wakePhrase:off,research:on,study:ws=<workspace-id>;<workspace-id>"
 *
 * `on` / `off` set it globally; `ws=` turns it on only for the listed workspaces.
 */
export const FLAGS = {
  /** Browser wake phrase ("Elise…") where the browser supports on-device recognition. */
  wakePhrase: { development: true, staging: true, production: true },
  /** Web search and research (ADR-015). */
  research: { development: true, staging: true, production: true },
  /** Study mode (ADR-016). */
  study: { development: true, staging: true, production: true },
  /** Internal usage page (/admin/usage); still requires ELISE_ADMIN_EMAILS. */
  usagePage: { development: true, staging: true, production: true },
} as const satisfies Record<string, Record<"development" | "staging" | "production", boolean>>;

export type Flag = keyof typeof FLAGS;

type Override = { kind: "on" } | { kind: "off" } | { kind: "workspaces"; ids: Set<string> };

export function parseFlagOverrides(raw: string | undefined): Partial<Record<Flag, Override>> {
  const out: Partial<Record<Flag, Override>> = {};
  for (const part of (raw ?? "").split(",")) {
    const [name, value] = part.split(":").map((x) => x?.trim());
    if (!name || !value || !(name in FLAGS)) continue;
    if (value === "on" || value === "off") out[name as Flag] = { kind: value };
    else if (value.startsWith("ws="))
      out[name as Flag] = {
        kind: "workspaces",
        ids: new Set(value.slice(3).split(";").filter(Boolean)),
      };
  }
  return out;
}

let overrides: Partial<Record<Flag, Override>> | undefined;

export function isEnabled(flag: Flag, who?: { workspaceId?: string | null }): boolean {
  overrides ??= parseFlagOverrides(process.env.ELISE_FLAGS);
  const o = overrides[flag];
  if (o?.kind === "on") return true;
  if (o?.kind === "off") return false;
  if (o?.kind === "workspaces") return Boolean(who?.workspaceId && o.ids.has(who.workspaceId));
  const env = (process.env.ELISE_ENV ?? "development") as keyof (typeof FLAGS)[Flag];
  return FLAGS[flag][env] ?? FLAGS[flag].development;
}

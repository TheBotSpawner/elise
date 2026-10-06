import type { ConnectionHealth } from "./health";
import type { CapabilityKey } from "../capabilities/types";

/**
 * The Connections Hub catalog (ADR-043): every provider ELISE can connect, described once —
 * the Hub and Provider Detail render from it; authentication and capabilities stay in their
 * adapters. Hub → providers; Provider Detail → accounts; Account → capabilities.
 */

export const PROVIDER_CATEGORIES = [
  "productivity",
  "communication",
  "files",
  "music",
  "development",
  "business",
  "native",
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export interface ProviderCatalogEntry {
  /** URL segment and registry key ("google" → /connections/google). */
  id: string;
  name: string;
  category: ProviderCategory;
  /** Canonical capabilities its accounts can bring. */
  capabilities: readonly CapabilityKey[];
  /** Product names and everyday words people search for ("gmail", "correo", "música"). */
  keywords: readonly string[];
  /** Several accounts of this provider can be connected side by side. */
  multiAccount: boolean;
  /** live: connectable now; planned: listed so people find it, not connectable yet. */
  availability: "live" | "planned";
  /** ELISE's own data: built in, never an external OAuth connection. */
  builtIn?: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "google",
    name: "Google",
    category: "productivity",
    capabilities: ["calendar", "email", "knowledge", "tasks", "finance"],
    keywords: [
      "gmail",
      "mail",
      "email",
      "correo",
      "calendar",
      "calendario",
      "agenda",
      "drive",
      "documentos",
      "docs",
      "sheets",
      "hojas",
      "planillas",
      "tasks",
      "tareas",
      "google workspace",
    ],
    multiAccount: true,
    availability: "live",
  },
  {
    id: "notion",
    name: "Notion",
    category: "productivity",
    capabilities: ["knowledge", "structured"],
    keywords: ["paginas", "pages", "wiki", "bases de datos", "databases", "documentos", "crm"],
    multiAccount: true,
    availability: "live",
  },
  {
    id: "spotify",
    name: "Spotify",
    category: "music",
    capabilities: ["music"],
    keywords: ["musica", "music", "canciones", "songs", "playlists", "podcast", "reproducir"],
    multiAccount: false,
    availability: "live",
  },
  {
    id: "youtube",
    name: "YouTube",
    category: "music",
    capabilities: ["music"],
    keywords: ["musica", "music", "videos", "canciones", "reproducir"],
    multiAccount: false,
    availability: "live",
  },
  {
    id: "microsoft",
    name: "Microsoft 365",
    category: "productivity",
    capabilities: ["email", "calendar", "knowledge", "tasks"],
    keywords: [
      "outlook",
      "mail",
      "email",
      "correo",
      "calendar",
      "calendario",
      "onedrive",
      "teams",
      "to do",
      "office",
    ],
    multiAccount: true,
    availability: "planned",
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    capabilities: [],
    keywords: ["mensajes", "messages", "canales", "channels", "chat", "equipo"],
    multiAccount: true,
    availability: "planned",
  },
  {
    id: "github",
    name: "GitHub",
    category: "development",
    capabilities: [],
    keywords: ["repositorios", "repos", "issues", "pull requests", "codigo", "code"],
    multiAccount: true,
    availability: "planned",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    category: "files",
    capabilities: ["knowledge"],
    keywords: ["archivos", "files", "documentos", "carpetas"],
    multiAccount: true,
    availability: "planned",
  },
  {
    id: "deezer",
    name: "Deezer",
    category: "music",
    capabilities: ["music"],
    keywords: ["musica", "music", "canciones", "playlists"],
    multiAccount: false,
    availability: "planned",
  },
  {
    id: "elise_native",
    name: "ELISE",
    category: "native",
    capabilities: ["tasks", "habits", "goals", "lists", "notes", "finance"],
    keywords: ["nativo", "native", "tareas", "habitos", "metas", "listas", "notas", "finanzas"],
    multiAccount: false,
    availability: "live",
    builtIn: true,
  },
];

export const catalogEntry = (id: string) => PROVIDER_CATALOG.find((p) => p.id === id) ?? null;

/** One connected account, as the Hub needs it (persisted metadata only — no provider calls). */
export interface HubAccount {
  id: string;
  providerKey: string;
  displayName: string;
  accountLabel: string | null;
  contextLabel: string | null;
  health: ConnectionHealth;
  capabilities: readonly { key: CapabilityKey; enabled: boolean; granted: boolean }[];
}

export type ProviderStatus =
  | "connected"
  /** Some accounts work and some need the user (or a capability is missing permission). */
  | "partial"
  /** Something needs the user: a permission, an error. */
  | "attention"
  /** Every account lost access: reconnect. */
  | "reconnect"
  | "not_connected"
  /** Planned, or not set up on this server. */
  | "unavailable";

export interface ProviderSummary {
  status: ProviderStatus;
  accounts: number;
  /** Accounts needing the user (permission, expired, error). */
  attention: number;
  /** Capabilities enabled on at least one healthy-or-not account, in catalog order. */
  enabled: CapabilityKey[];
}

const NEEDS_USER: ReadonlySet<ConnectionHealth> = new Set([
  "permission_missing",
  "expired",
  "needs_attention",
]);

/** A provider's status, aggregated from its accounts. */
export function summarize(
  entry: ProviderCatalogEntry,
  accounts: readonly HubAccount[],
  configured: boolean,
): ProviderSummary {
  const mine = accounts.filter((a) => a.providerKey === entry.id);
  const attention = mine.filter((a) => NEEDS_USER.has(a.health)).length;
  const expired = mine.filter((a) => a.health === "expired").length;
  const enabled = entry.capabilities.filter((cap) =>
    mine.some((a) => a.capabilities.some((c) => c.key === cap && c.enabled)),
  );
  const status: ProviderStatus =
    entry.availability === "planned" || (!configured && !mine.length)
      ? "unavailable"
      : !mine.length
        ? "not_connected"
        : expired === mine.length
          ? "reconnect"
          : attention && attention < mine.length
            ? "partial"
            : attention
              ? "attention"
              : "connected";
  return { status, accounts: mine.length, attention, enabled };
}

/** Lowercase, accent-free. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * Search (client-side, immediate): provider name, its description, its capabilities in the
 * user's language, everyday aliases ("gmail", "correo", "música"), and the names of connected
 * accounts ("UTN" finds Google). Every word must match something.
 */
export function searchCatalog(
  entries: readonly ProviderCatalogEntry[],
  query: string,
  text: {
    description: (id: string) => string;
    capability: (key: CapabilityKey) => string;
  },
  accounts: readonly HubAccount[] = [],
): ProviderCatalogEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => {
    const haystack = fold(
      [
        e.name,
        text.description(e.id),
        ...e.capabilities.map(text.capability),
        ...e.keywords,
        ...accounts
          .filter((a) => a.providerKey === e.id)
          .flatMap((a) => [a.displayName, a.accountLabel ?? "", a.contextLabel ?? ""]),
      ].join(" "),
    );
    return words.every((w) => haystack.includes(w));
  });
}

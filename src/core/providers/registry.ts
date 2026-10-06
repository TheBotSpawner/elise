import type { ProviderDefinition, ProviderKey } from "./types";

/** Provider registry. Mirrors `provider_definitions` in the database. */
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    key: "elise_native",
    authType: "none",
    supportsMultipleAccounts: false,
    capabilities: ["tasks", "habits", "lists", "goals", "notes", "finance", "knowledge"],
    status: "available",
    sourceOfTruth: "elise",
  },
  {
    key: "google",
    authType: "oauth2",
    supportsMultipleAccounts: true,
    capabilities: ["email", "calendar", "tasks", "knowledge", "finance"],
    status: "planned",
    sourceOfTruth: "external",
  },
  {
    key: "notion",
    authType: "oauth2",
    supportsMultipleAccounts: true,
    capabilities: ["knowledge", "structured"],
    status: "planned",
    sourceOfTruth: "external",
  },
  // Music (ADR-042): Spotify is an account; YouTube is search + the official embedded player;
  // Deezer's API is closed to new apps, so it stays planned.
  {
    key: "spotify",
    authType: "oauth2",
    supportsMultipleAccounts: false,
    capabilities: ["music"],
    status: "available",
    sourceOfTruth: "external",
  },
  {
    key: "youtube",
    authType: "api_key",
    supportsMultipleAccounts: false,
    capabilities: ["music"],
    status: "available",
    sourceOfTruth: "external",
  },
  {
    key: "deezer",
    authType: "oauth2",
    supportsMultipleAccounts: false,
    capabilities: ["music"],
    status: "planned",
    sourceOfTruth: "external",
  },
  {
    key: "web_search",
    authType: "api_key",
    supportsMultipleAccounts: false,
    capabilities: ["web_search"],
    status: "planned",
    sourceOfTruth: "external",
  },
];

export function getProvider(key: ProviderKey): ProviderDefinition {
  const provider = PROVIDERS.find((p) => p.key === key);
  if (!provider) throw new Error(`Unknown provider: ${key}`);
  return provider;
}

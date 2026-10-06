// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionView } from "@/application/connections-service";
import type { CapabilityKey } from "@/core/capabilities/types";
import {
  PROVIDER_CATALOG,
  searchCatalog,
  summarize,
  type HubAccount,
} from "@/core/providers/catalog";
import { PROVIDERS } from "@/core/providers/registry";
import { ConnectionsHub } from "@/features/connections/hub";
import { ProviderDetail } from "@/features/connections/provider-detail";
import { I18nProvider } from "@/lib/i18n/client";
import { es } from "@/lib/i18n/dictionaries/es";

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => nav.params,
}));
vi.mock("@/features/connections/actions", () => ({
  connectGoogle: vi.fn(),
  connectNotion: vi.fn(),
  connectSpotify: vi.fn(),
  enableYouTubeAction: vi.fn(),
  disconnectAction: vi.fn(),
  renameConnectionAction: vi.fn(),
  setDefaultAction: vi.fn(),
  toggleCapabilityAction: vi.fn(),
}));

const GOOGLE_CAPS: CapabilityKey[] = ["calendar", "tasks", "email", "knowledge", "finance"];

function google(
  id: string,
  name: string,
  email: string,
  over: Partial<ConnectionView> = {},
  enabled: CapabilityKey[] = GOOGLE_CAPS,
): ConnectionView {
  return {
    id,
    providerKey: "google",
    displayName: name,
    accountLabel: email,
    contextLabel: null,
    status: "connected",
    health: "connected",
    capabilities: GOOGLE_CAPS.map((key) => ({
      key,
      enabled: enabled.includes(key),
      granted: enabled.includes(key),
      isDefault: false,
    })),
    ...over,
  };
}

const ACCOUNTS: ConnectionView[] = [
  {
    id: "native",
    providerKey: "elise_native",
    displayName: "ELISE",
    accountLabel: null,
    contextLabel: null,
    status: "connected",
    health: "connected",
    capabilities: (
      ["tasks", "habits", "goals", "lists", "notes", "finance"] as CapabilityKey[]
    ).map((key) => ({ key, enabled: true, granted: true, isDefault: true })),
  },
  google("g1", "Personal", "leo@example.com"),
  google("g2", "UTN", "lm@frba.utn.edu.ar"),
  google(
    "g3",
    "Firbot Academy",
    "leo@firbot.example",
    {
      health: "permission_missing",
      capabilities: GOOGLE_CAPS.map((key) => ({
        key,
        enabled: ["calendar", "tasks", "email", "knowledge"].includes(key),
        granted: key !== "knowledge" && key !== "finance",
        isDefault: false,
      })),
    },
    ["calendar", "tasks", "email", "knowledge"],
  ),
  {
    id: "n1",
    providerKey: "notion",
    displayName: "Firbot",
    accountLabel: "leo@firbot.example",
    contextLabel: null,
    status: "connected",
    health: "connected",
    capabilities: [
      { key: "knowledge", enabled: true, granted: true, isDefault: false },
      { key: "structured", enabled: true, granted: true, isDefault: true },
    ],
  },
];

const CONFIGURED = {
  google: true,
  notion: true,
  spotify: true,
  youtube: false,
  elise_native: true,
};

const text = {
  description: (id: string) => es.connectionsHub.descriptions[id] ?? "",
  capability: (key: CapabilityKey) => es.capabilities[key],
};
const ids = (q: string, accounts: HubAccount[] = ACCOUNTS) =>
  searchCatalog(PROVIDER_CATALOG, q, text, accounts).map((e) => e.id);

beforeEach(() => {
  nav.replace.mockClear();
  nav.params = new URLSearchParams();
  window.localStorage.clear();
});

describe("provider catalog", () => {
  it("every connectable provider in the code registry has a catalog entry", () => {
    for (const p of PROVIDERS.filter((x) => x.key !== "web_search"))
      expect(
        PROVIDER_CATALOG.some((e) => e.id === p.key),
        p.key,
      ).toBe(true);
  });

  it("search finds providers by name, service, everyday words and account names", () => {
    expect(ids("Google")).toEqual(["google"]);
    expect(ids("Gmail")).toEqual(["google"]);
    expect(ids("drive")).toContain("google");
    expect(ids("Calendar")).toEqual(expect.arrayContaining(["google", "microsoft"]));
    expect(ids("correo")).toEqual(expect.arrayContaining(["google", "microsoft"]));
    expect(ids("UTN")).toEqual(["google"]);
    expect(ids("notion")).toEqual(["notion"]);
    expect(ids("música")).toEqual(expect.arrayContaining(["spotify", "youtube"]));
    expect(ids("MUSICA")).toEqual(ids("música"));
    expect(ids("nada que ver xyz")).toEqual([]);
  });

  it("status aggregates accounts: connected, partial, reconnect, not connected, coming soon", () => {
    const g = PROVIDER_CATALOG.find((e) => e.id === "google")!;
    expect(summarize(g, ACCOUNTS, true)).toMatchObject({
      status: "partial",
      accounts: 3,
      attention: 1,
    });
    expect(summarize(g, ACCOUNTS.slice(0, 3), true)).toMatchObject({
      status: "connected",
      enabled: ["calendar", "email", "knowledge", "tasks", "finance"],
    });
    const expired = ACCOUNTS.filter((a) => a.providerKey === "google").map((a) => ({
      ...a,
      health: "expired" as const,
    }));
    expect(summarize(g, expired, true).status).toBe("reconnect");
    const spotify = PROVIDER_CATALOG.find((e) => e.id === "spotify")!;
    expect(summarize(spotify, ACCOUNTS, true).status).toBe("not_connected");
    const slack = PROVIDER_CATALOG.find((e) => e.id === "slack")!;
    expect(summarize(slack, ACCOUNTS, true).status).toBe("unavailable");
  });

  it("scales: 50 providers and 100+ accounts search in well under a frame", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...PROVIDER_CATALOG[0]!,
      id: `p${i}`,
      name: `Provider ${i}`,
    }));
    const accounts = Array.from({ length: 120 }, (_, i) => ({
      ...ACCOUNTS[1]!,
      id: `a${i}`,
      providerKey: `p${i % 50}`,
      displayName: `Cuenta ${i}`,
    }));
    const t0 = performance.now();
    const r = searchCatalog(many, "cuenta 77", text, accounts);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.map((e) => e.id)).toEqual(["p27"]);
  });
});

function hub(accounts = ACCOUNTS) {
  return render(
    <I18nProvider locale="es">
      <ConnectionsHub accounts={accounts} configured={CONFIGURED} />
    </I18nProvider>,
  );
}

describe("Connections Hub", () => {
  it("shows providers, never account configuration", () => {
    hub();
    expect(screen.queryByText("lm@frba.utn.edu.ar")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    const strip = screen.getByRole("heading", { name: "Conectadas" }).parentElement!;
    expect(
      within(strip).getByRole("link", {
        name: /Google, 3 cuentas conectadas, 1 necesita atención/,
      }),
    ).toBeTruthy();
    expect(within(strip).getByRole("link", { name: /Notion/ })).toBeTruthy();
    // The Google card summarizes: accounts and the account that needs attention.
    const card = screen.getByRole("link", {
      name: /^Google: .*3 cuentas conectadas · 1 necesita atención/,
    });
    expect(card.getAttribute("href")).toBe("/connections/google");
    // Not connected providers offer to connect; planned ones are listed, not clickable.
    expect(screen.getByRole("link", { name: /^Spotify: .*Conectar/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Slack/ })).toBeNull();
    expect(screen.getByText("Slack")).toBeTruthy();
    // ELISE's built-in data is apart from external connections, with no Connect.
    const native = screen
      .getAllByRole("link")
      .find((l) => l.getAttribute("href") === "/connections/elise_native")!;
    expect(native.textContent).toContain("Integrado");
    expect(native.textContent).not.toContain("Conectar");
  });

  it("search is immediate, accent- and case-insensitive, and labelled", () => {
    hub();
    const search = screen.getByLabelText("Buscar conexiones");
    fireEvent.change(search, { target: { value: "gmail" } });
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/connections/google",
    ]);
    fireEvent.change(search, { target: { value: "UTN" } });
    expect(screen.getByRole("link", { name: /^Google:/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("Nada coincide con “zzz”.")).toBeTruthy();
  });

  it("filters: connected and available", () => {
    hub();
    fireEvent.click(screen.getByRole("button", { name: "Conectadas" }));
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/connections/google",
      "/connections/notion",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Disponibles" }));
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/connections/spotify",
    ]);
  });

  it("returning from OAuth opens the provider that was just connected", () => {
    nav.params = new URLSearchParams({ connected: "g4", provider: "notion" });
    hub();
    expect(nav.replace).toHaveBeenCalledWith("/connections/notion?opened=g4");
  });
});

function detail(provider: string, opened: string | null = null) {
  return render(
    <I18nProvider locale="es">
      <ProviderDetail
        providerId={provider}
        connections={ACCOUNTS}
        configured={CONFIGURED[provider as keyof typeof CONFIGURED] ?? false}
        opened={opened}
      />
    </I18nProvider>,
  );
}

describe("Provider Detail", () => {
  it("Google: three accounts, compact; the one needing attention opens on the exact capability", () => {
    detail("google");
    const accounts = screen.getAllByRole("article");
    expect(accounts).toHaveLength(3);
    expect(screen.getByText("3 cuentas conectadas · 1 necesita atención")).toBeTruthy();
    // Personal and UTN are collapsed: no switches inside them.
    expect(within(accounts[0]!).queryByRole("switch")).toBeNull();
    // Firbot Academy is open: Drive is on but not allowed, with its own "Allow" action.
    const firbot = accounts[2]!;
    expect(within(firbot).getByText("Google Drive")).toBeTruthy();
    expect(
      within(firbot).getAllByRole("button", { name: es.connections.allow }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Conectar otra cuenta/ })).toBeTruthy();
  });

  it("an account expands to its capabilities, alias and 'use this account for', and collapses", () => {
    detail("google");
    const toggle = screen.getByRole("button", { name: es.connections.expand("Personal") });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const personal = screen.getAllByRole("article")[0]!;
    expect(within(personal).getAllByRole("switch")).toHaveLength(5);
    expect(within(personal).getByLabelText(es.connections.name)).toHaveProperty(
      "value",
      "Personal",
    );
    expect(within(personal).getByLabelText(es.connections.context)).toBeTruthy();
    expect(within(personal).getByRole("button", { name: es.connections.disconnect })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: es.connections.collapse("Personal") }));
    expect(within(screen.getAllByRole("article")[0]!).queryByRole("switch")).toBeNull();
  });

  it("a just-connected account opens once", () => {
    detail("google", "g2");
    expect(
      within(screen.getAllByRole("article")[1]!).getAllByRole("switch").length,
    ).toBeGreaterThan(0);
  });

  it("Notion: one workspace; Spotify: connect; ELISE: built in, no connect", () => {
    const { unmount } = detail("notion");
    expect(screen.getByText("1 espacio conectado")).toBeTruthy();
    expect(screen.getByText("Firbot")).toBeTruthy();
    unmount();
    const s = detail("spotify");
    expect(screen.getByRole("button", { name: "Conectar" })).toBeTruthy();
    s.unmount();
    detail("elise_native");
    expect(screen.queryByRole("button", { name: /Conectar/ })).toBeNull();
    expect(screen.getByText(es.capabilities.habits)).toBeTruthy();
  });
});

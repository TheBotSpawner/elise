// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySettings } from "@/features/settings/memory";
import {
  SETTINGS_SECTIONS,
  searchSettings,
  sectionHref,
  sectionOf,
} from "@/features/settings/registry";
import { SettingsIndex, SettingsShell } from "@/features/settings/shell";
import { VoiceSettings } from "@/features/settings/voice-settings";
import { getDictionary } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/client";

const nav = vi.hoisted(() => ({ pathname: "/settings/voice", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, refresh: vi.fn(), replace: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  setVoicePreferences: vi.fn(),
  setMemoryEnabledAction: vi.fn(),
  addMemoryAction: vi.fn(),
  editMemoryAction: vi.fn(),
  forgetMemoryAction: vi.fn(),
  clearMemoryAction: vi.fn(),
  setTheme: vi.fn(),
  setAccent: vi.fn(),
  updateProfile: vi.fn(),
  deleteStoredFileAction: vi.fn(),
  chooseContinuousConversation: vi.fn(),
}));
vi.mock("@/features/settings/actions", () => actions);
// This browser can't detect a wake phrase on the device: nothing about it is offered.
vi.mock("@/features/voice/wake-engine", () => ({
  WebSpeechWakeEngine: class {
    static supported() {
      return false;
    }
  },
}));

const es = getDictionary("es");
const en = getDictionary("en");
const wrap = (ui: React.ReactNode, locale: "es" | "en" = "es") =>
  render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue({ ok: true });
  nav.push.mockReset();
  nav.pathname = "/settings/voice";
});

describe("settings registry (ADR-068)", () => {
  it("one list of categories feeds everything, each with its own URL", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "general",
      "appearance",
      "voice",
      "memory",
      "storage",
      "shortcuts",
      "account",
      "usage",
      "billing",
    ]);
    expect(sectionHref("memory")).toBe("/settings/memory");
    expect(sectionOf("/settings/storage/images")).toBe("storage");
    expect(sectionOf("/settings")).toBeNull();
    // No Privacy category.
    expect(SETTINGS_SECTIONS.some((s) => (s.id as string) === "privacy")).toBe(false);
  });

  it("search finds settings by title, hint and category, locally", () => {
    const idioma = searchSettings(es, "idioma");
    expect(idioma.map((h) => [h.label, h.sectionLabel])).toEqual(
      expect.arrayContaining([
        ["Idioma de la interfaz", "General"],
        ["Idioma de voz", "Voz"],
      ]),
    );
    expect(idioma.find((h) => h.label === "Idioma de voz")?.href).toBe(
      "/settings/voice#voice-language",
    );
    expect(searchSettings(es, "memoria")[0]).toMatchObject({
      section: "memory",
      sectionLabel: null,
    });
    expect(searchSettings(es, "voz")[0]?.section).toBe("voice");
    expect(searchSettings(es, "atajos")[0]?.section).toBe("shortcuts");
    // Accents and case don't matter; English labels in English.
    expect(searchSettings(es, "UBICACION").map((h) => h.href)).toContain(
      "/settings/general#location",
    );
    expect(searchSettings(en, "language").map((h) => h.label)).toEqual(
      expect.arrayContaining(["Interface language", "Voice language"]),
    );
    expect(searchSettings(es, "zzz")).toEqual([]);
  });
});

describe("settings shell", () => {
  it("desktop: back to ELISE, search and the categories, with the active one marked", () => {
    wrap(<SettingsShell>contenido</SettingsShell>);
    expect(screen.getByRole("link", { name: "Volver a ELISE" })).toHaveAttribute("href", "/");
    const voice = screen.getByRole("link", { name: "Voz" });
    expect(voice).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("contenido")).toBeInTheDocument();
  });

  it("/settings on a wide screen means General", () => {
    nav.pathname = "/settings";
    wrap(<SettingsShell>x</SettingsShell>);
    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("a search result navigates to the setting's anchor (deep link)", () => {
    wrap(<SettingsShell>x</SettingsShell>);
    fireEvent.change(screen.getByRole("combobox", { name: "Buscar ajustes" }), {
      target: { value: "idioma de voz" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Idioma de voz/ }).querySelector("button")!);
    expect(nav.push).toHaveBeenCalledWith("/settings/voice#voice-language");
  });

  it("phones: a list of every category, each a full screen", () => {
    wrap(<SettingsIndex />);
    for (const s of SETTINGS_SECTIONS)
      expect(
        screen.getByRole("link", { name: new RegExp(es.settingsHub.sections[s.id].title) }),
      ).toHaveAttribute("href", `/settings/${s.id}`);
  });

  it("labels follow the interface language", () => {
    wrap(<SettingsIndex />, "en");
    expect(screen.getByRole("link", { name: /Billing/ })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
  });
});

describe("voice settings", () => {
  const profiles = [{ id: "elise" as const, displayName: "ELISE" }];

  it("only continuous conversation, voice language and voice", () => {
    wrap(
      <VoiceSettings
        initial={{ continuous: true, language: "auto", voice: "elise" }}
        profiles={profiles}
      />,
    );
    expect(screen.getByRole("switch", { name: "Conversación continua" })).toBeChecked();
    const language = screen.getByRole("combobox", { name: "Idioma de voz" });
    expect([...(language as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Automático",
      "Español",
      "English",
    ]);
    expect(screen.getByRole("combobox", { name: "Voz" })).toHaveValue("elise");
    expect(screen.getByRole("button", { name: "Escuchar" })).toBeInTheDocument();
    for (const gone of [
      "Frase de activación",
      "Responder en voz alta",
      "Interrumpir hablando",
      "Adaptar mi volumen de voz",
      "Conversaciones por voz",
      "ElevenLabs",
    ])
      expect(screen.queryByText(new RegExp(gone))).toBeNull();
    // An unsupported browser gets no promise about "Elise".
    expect(screen.queryByText(/decí «Elise»/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Activar «Elise»/ })).toBeNull();
  });

  it("each change saves the same three values", async () => {
    wrap(
      <VoiceSettings
        initial={{ continuous: true, language: "auto", voice: "elise" }}
        profiles={profiles}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Conversación continua" }));
    });
    expect(actions.setVoicePreferences).toHaveBeenLastCalledWith({
      continuous: false,
      language: "auto",
      voice: "elise",
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Idioma de voz" }), {
        target: { value: "en" },
      });
    });
    expect(actions.setVoicePreferences).toHaveBeenLastCalledWith({
      continuous: false,
      language: "en",
      voice: "elise",
    });
  });

  it("the startup sound lives in Voice, as a secondary block", () => {
    wrap(
      <VoiceSettings
        initial={{ continuous: false, language: "es", voice: "elise" }}
        profiles={profiles}
      />,
    );
    expect(screen.getByText("Sonidos de ELISE")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Sonido de inicio" })).toBeInTheDocument();
  });
});

describe("memory settings", () => {
  const fact = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "trabajo.horario",
    value: "De 9 a 18",
    confidence: "stated" as const,
    sources: ["c1", "c2"],
    status: "active" as const,
    createdAt: "",
    updatedAt: "",
    lastConfirmedAt: "",
  };

  it("a readable summary with provenance, editable and forgettable", async () => {
    wrap(<MemorySettings enabled facts={[fact]} />);
    expect(screen.getByText("De 9 a 18")).toBeInTheDocument();
    expect(screen.getByText("Horario")).toBeInTheDocument();
    expect(screen.getByText("De 2 conversaciones")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Olvidar: Horario" }));
    });
    expect(actions.forgetMemoryAction).toHaveBeenCalledWith(fact.id);
  });

  it("the switch turns Memory off; what's saved stays", async () => {
    wrap(<MemorySettings enabled facts={[fact]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Usar memoria" }));
    });
    expect(actions.setMemoryEnabledAction).toHaveBeenCalledWith(false);
    expect(screen.getByText(/La memoria está desactivada/)).toBeInTheDocument();
    expect(screen.getByText("De 9 a 18")).toBeInTheDocument();
  });

  it("empty state", () => {
    wrap(<MemorySettings enabled facts={[]} />);
    expect(screen.getByText("Todavía no hay nada guardado.")).toBeInTheDocument();
  });
});

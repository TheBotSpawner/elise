// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ONBOARDING_STEPS } from "@/features/onboarding/model";
import { OnboardingFlow } from "@/features/onboarding/onboarding-flow";
import { I18nProvider } from "@/lib/i18n/client";

const settings = vi.hoisted(() => ({
  chooseContinuousConversation: vi.fn(),
  updateProfile: vi.fn(),
}));
const onboarding = vi.hoisted(() => ({
  saveOnboardingProgress: vi.fn(),
  chooseModulesAction: vi.fn(),
  completeOnboarding: vi.fn(),
  createFirstSpace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/features/settings/actions", () => settings);
vi.mock("@/features/onboarding/actions", () => onboarding);
vi.mock("@/features/connections/actions", () => ({
  connectGoogle: vi.fn(),
  connectNotion: vi.fn(),
}));
vi.mock("@/components/elise/orb/orb", () => ({ Orb: () => null }));

function flow() {
  return render(
    <I18nProvider locale="es">
      <OnboardingFlow
        initial={{ step: "voice" }}
        profile={{ displayName: "Leo", language: "es", timezone: "UTC" }}
        accounts={[]}
        googleAvailable
        notionAvailable
        spaces={[]}
        returned={{ connected: false, missing: [], error: null }}
        modules={[]}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  settings.chooseContinuousConversation.mockReset().mockResolvedValue({ ok: true });
  onboarding.saveOnboardingProgress.mockReset().mockResolvedValue(undefined);
});

describe("onboarding: continuous conversation (ADR-068)", () => {
  it("comes right after choosing Mi ELISE's modules", () => {
    expect(ONBOARDING_STEPS.indexOf("voice")).toBe(ONBOARDING_STEPS.indexOf("uses") + 1);
  });

  it("asks, without promising background listening on the web, and saves the choice", async () => {
    flow();
    expect(screen.getByRole("heading", { name: "Conversaciones por voz" })).toBeInTheDocument();
    // No roadmap promises in onboarding.
    expect(screen.queryByText(/futura app móvil/)).toBeNull();
    expect(screen.queryByText(/pantalla bloqueada/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Activar conversación continua" }));
    });
    expect(settings.chooseContinuousConversation).toHaveBeenCalledWith(true, "onboarding");
    // Then on to connecting accounts.
    expect(onboarding.saveOnboardingProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "connect" }),
    );
  });

  it("“Ahora no” is a real choice: saved off, never on by default", async () => {
    flow();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ahora no" }));
    });
    expect(settings.chooseContinuousConversation).toHaveBeenCalledWith(false, "onboarding");
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MapPayload } from "@/core/workspace/location";
import { sharedLocation, stopSharing } from "@/features/location/shared-location";
import { MapBody } from "@/features/workspace/canvas/map";
import { I18nProvider } from "@/lib/i18n/client";

const places: MapPayload = {
  mode: "places",
  query: "cafés",
  center: null,
  places: [
    {
      id: "a",
      name: "Café Cerca",
      address: "Corrientes 1000",
      location: { lat: -34.6, lng: -58.38 },
      category: "Café",
      rating: 4.5,
      ratingCount: 10,
      openNow: true,
      distanceMeters: 120,
      mapsUrl: "https://maps.google.com/?cid=1",
    },
  ],
  route: null,
  comparison: null,
};

const view = (p: MapPayload, onPrompt = vi.fn()) =>
  render(
    <I18nProvider locale="es">
      <MapBody p={p} size="large" onPrompt={onPrompt} />
    </I18nProvider>,
  );

describe("Map Surface", () => {
  it("without a browser key the places still read as a list", () => {
    view(places);
    expect(screen.getByText("El mapa no está disponible; los detalles están abajo.")).toBeTruthy();
    expect(screen.getByText("Café Cerca")).toBeTruthy();
    expect(screen.getByText("120 m")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Café Cerca/ }));
    expect(screen.getByText("Corrientes 1000")).toBeTruthy();
  });

  it("asks for the position only on a tap, keeps it coarse, and continues the request", async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: -34.60123456, longitude: -58.38345678 } } as GeolocationPosition),
    );
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    const onPrompt = vi.fn();
    view({ ...places, mode: "locate", places: [] }, onPrompt);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Compartir mi ubicación/ }));
    });
    expect(sharedLocation()).toEqual({ lat: -34.601, lng: -58.383 });
    expect(onPrompt).toHaveBeenCalledWith("Usá mi ubicación");
    act(() => stopSharing());
    expect(sharedLocation()).toBeNull();
  });

  it("says when permission is denied", async () => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) =>
          fail({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
      },
      configurable: true,
    });
    view({ ...places, mode: "locate", places: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Compartir mi ubicación/ }));
    });
    expect(screen.getByText(/El acceso a la ubicación está desactivado/)).toBeTruthy();
  });
});

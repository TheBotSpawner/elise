"use client";

import { useState } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  enableDeviceLocation,
  setDeviceLocationEnabled,
  useDeviceLocation,
} from "@/features/location/shared-location";
import { useI18n } from "@/lib/i18n/client";

/**
 * Location (ADR-028): opt in to ELISE using this device's current position for routes and
 * nearby places. A per-device choice — the browser keeps the permission; ELISE keeps no
 * position, no history and never tracks in the background.
 */
export function LocationSettings() {
  const { t } = useI18n();
  const s = t.settings.location;
  const { enabled, status, accuracy } = useDeviceLocation();
  const [asking, setAsking] = useState(false);
  const blocked = status === "blocked";
  const unavailable = status === "unavailable";

  async function toggle(on: boolean) {
    if (!on) return setDeviceLocationEnabled(false);
    setAsking(true);
    await enableDeviceLocation();
    setAsking(false);
  }

  const state = unavailable
    ? s.unavailable
    : blocked
      ? s.blocked
      : status === "allowed"
        ? s.allowed
        : status === "needs_permission"
          ? s.needsPermission
          : "";
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-medium">{s.title}</h2>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{s.use}</p>
          <p className="text-[13px] text-muted">{s.useHint}</p>
        </div>
        <Switch
          checked={enabled && !blocked && !unavailable}
          disabled={asking || blocked || unavailable}
          aria-label={s.use}
          onCheckedChange={(on) => void toggle(on)}
        />
      </div>
      <p className="mt-3 text-[13px] text-muted" aria-live="polite">
        <span className="text-fg2">{state}</span>
        {enabled && status === "allowed" && accuracy !== null && ` · ${s.accuracy(accuracy)}`}
        {blocked && ` ${s.blockedHint}`}
      </p>
    </Card>
  );
}

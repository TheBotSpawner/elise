import { AirVent, Fan, Gauge, Lightbulb, Plug, Tv, Droplets, type LucideIcon } from "lucide-react";

import type { HomeDeviceType } from "@/core/home/model";

const ICONS: Record<HomeDeviceType, LucideIcon> = {
  light: Lightbulb,
  switch: Plug,
  climate: AirVent,
  fan: Fan,
  humidifier: Droplets,
  media_player: Tv,
  sensor: Gauge,
};

export function DeviceIcon({ type, className }: { type: HomeDeviceType; className?: string }) {
  const Icon = ICONS[type];
  return <Icon className={className} aria-hidden />;
}

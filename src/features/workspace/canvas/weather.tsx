"use client";

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Moon,
  Sun,
  Wind,
  type LucideIcon,
} from "lucide-react";

import type { WeatherCondition } from "@/core/weather/model";
import { WINDY_KMH } from "@/core/weather/model";
import type { WeatherPayload } from "@/core/workspace/weather";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { VisualSize } from "./composition";
import { LocateCard } from "./map";
import { LineChart } from "../viz/charts";

/**
 * The Weather Surface (ADR-038): one component for every place weather appears — the Live
 * Canvas (compact or focused), the chat thread and the Morning Brief. Icons are ELISE's own
 * line set (no provider-hosted images); colour never carries meaning alone.
 */

const DAY_ICONS: Record<WeatherCondition, LucideIcon> = {
  clear: Sun,
  mostly_clear: CloudSun,
  partly_cloudy: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  heavy_rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

export function WeatherIcon({
  condition,
  isDay = true,
  className,
}: {
  condition: WeatherCondition;
  isDay?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const Icon =
    !isDay && condition === "clear"
      ? Moon
      : !isDay && (condition === "mostly_clear" || condition === "partly_cloudy")
        ? CloudMoon
        : DAY_ICONS[condition];
  const wet = condition.includes("rain") || condition === "drizzle" || condition === "storm";
  return (
    <Icon
      role="img"
      aria-label={t.weather.conditions[condition]}
      className={cn(
        "shrink-0",
        wet ? "text-[var(--accent-text)]" : condition === "clear" ? "text-fg" : "text-muted",
        className,
      )}
    />
  );
}

const deg = (n: number) => `${Math.round(n)}°`;

function useDayLabel() {
  const { locale } = useI18n();
  const f = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // Dates are already local to the place: format them as calendar days, not instants.
  return (date: string) => f.format(new Date(`${date}T12:00:00Z`)).replace(".", "");
}

function Rain({ p }: { p: number | null }) {
  if (p == null) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-[11px]",
        p >= 50 ? "text-[var(--accent-text)]" : "text-faint",
      )}
    >
      <Droplets className="size-3" aria-hidden />
      {p}%
    </span>
  );
}

/** Compact for the Brief and small cards; large/focus adds the chart and more hours. */
export function WeatherView({
  p,
  size = "medium",
  onPrompt,
  compact = false,
}: {
  p: WeatherPayload;
  size?: VisualSize;
  onPrompt?: (text: string) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (p.mode === "needs_location")
    return onPrompt ? (
      <LocateCard onPrompt={onPrompt} />
    ) : (
      <p className="text-[13px] text-muted">{t.weather.needsLocation}</p>
    );
  const big = !compact && (size === "large" || size === "focus");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {p.current && (p.mode === "current" || !compact) && p.mode !== "daily" && <Current p={p} />}
      {p.mode === "daily" ? (
        <Days p={p} chart={!compact && p.days.length > 2} chartHeight={big ? 170 : 110} />
      ) : (
        <>
          {p.mode === "hourly" && p.days[0] && <DayLine d={p.days[0]} />}
          <Hours p={p} limit={compact ? 6 : big ? 48 : 12} chart={big && p.hours.length > 2} />
        </>
      )}
      <Footer p={p} />
    </div>
  );
}

function Current({ p }: { p: WeatherPayload }) {
  const { t } = useI18n();
  const c = p.current!;
  const today = p.days[0];
  return (
    <div className="flex items-center gap-4">
      <WeatherIcon condition={c.condition} isDay={c.isDay} className="size-10" />
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-[32px] leading-none text-fg">{deg(c.temperature)}</span>
        <span className="text-[13px] text-muted">
          {t.weather.conditions[c.condition]}
          {c.apparentTemperature != null &&
            Math.round(c.apparentTemperature) !== Math.round(c.temperature) &&
            ` · ${t.weather.feelsLike(deg(c.apparentTemperature))}`}
        </span>
      </div>
      <dl className="ml-auto grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[12px]">
        {today && (
          <>
            <dt className="text-faint">{t.weather.today}</dt>
            <dd className="font-mono text-fg">
              {deg(today.min)} / {deg(today.max)}
            </dd>
            {today.precipitationProbability != null && (
              <>
                <dt className="text-faint">{t.weather.rain}</dt>
                <dd className="font-mono text-fg">{today.precipitationProbability}%</dd>
              </>
            )}
          </>
        )}
        {c.windSpeed != null && c.windSpeed >= WINDY_KMH / 2 && (
          <>
            <dt className="text-faint">{t.weather.wind}</dt>
            <dd className="font-mono text-fg">{Math.round(c.windSpeed)} km/h</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function DayLine({ d }: { d: WeatherPayload["days"][number] }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <WeatherIcon condition={d.condition} className="size-5" />
      <span className="text-fg">{t.weather.conditions[d.condition]}</span>
      <span className="font-mono text-muted">
        {deg(d.min)} / {deg(d.max)}
      </span>
      <Rain p={d.precipitationProbability} />
      {(d.windMax ?? 0) >= WINDY_KMH && (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted">
          <Wind className="size-3.5" aria-hidden />
          {Math.round(d.windMax!)} km/h
        </span>
      )}
    </div>
  );
}

function Days({
  p,
  chart,
  chartHeight,
}: {
  p: WeatherPayload;
  chart: boolean;
  chartHeight: number;
}) {
  const { t } = useI18n();
  const day = useDayLabel();
  return (
    <>
      <ol
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, p.days.length)}, minmax(0, 1fr))` }}
        aria-label={t.weather.week}
      >
        {p.days.map((d) => (
          <li
            key={d.date}
            className="flex flex-col items-center gap-1 rounded-lg py-1.5 text-center"
            aria-label={`${day(d.date)}: ${t.weather.conditions[d.condition]}, ${deg(d.max)} / ${deg(d.min)}${d.precipitationProbability != null ? `, ${t.weather.rain} ${d.precipitationProbability}%` : ""}`}
          >
            <span className="type-label text-faint uppercase">{day(d.date)}</span>
            <WeatherIcon condition={d.condition} className="size-6" />
            <span className="font-mono text-[14px] text-fg">{deg(d.max)}</span>
            <span className="font-mono text-[12px] text-muted">{deg(d.min)}</span>
            <Rain p={d.precipitationProbability} />
          </li>
        ))}
      </ol>
      {chart && (
        <LineChart
          height={chartHeight}
          spec={{
            type: "line",
            title: t.weather.chart,
            format: { kind: "number", decimals: 0 },
            x: p.days.map((d) => day(d.date)),
            series: [
              { name: t.weather.max, values: p.days.map((d) => Math.round(d.max)) },
              { name: t.weather.min, values: p.days.map((d) => Math.round(d.min)) },
            ],
          }}
        />
      )}
    </>
  );
}

function Hours({ p, limit, chart }: { p: WeatherPayload; limit: number; chart: boolean }) {
  const { t } = useI18n();
  const hours = p.hours.slice(0, limit);
  if (!hours.length) return null;
  return (
    <>
      <ol className="flex gap-1 overflow-x-auto pb-1" aria-label={t.weather.hours}>
        {hours.map((h) => (
          <li
            key={h.time}
            className="flex min-w-[46px] flex-col items-center gap-1 py-1 text-center"
            aria-label={`${h.time.slice(11)}: ${t.weather.conditions[h.condition]}, ${deg(h.temperature)}${h.precipitationProbability != null ? `, ${t.weather.rain} ${h.precipitationProbability}%` : ""}`}
          >
            <span className="font-mono text-[11px] text-faint">{h.time.slice(11)}</span>
            <WeatherIcon condition={h.condition} isDay={h.isDay} className="size-5" />
            <span className="font-mono text-[13px] text-fg">{deg(h.temperature)}</span>
            <Rain p={h.precipitationProbability} />
          </li>
        ))}
      </ol>
      {chart && (
        <LineChart
          height={150}
          spec={{
            type: "area",
            title: t.weather.chart,
            format: { kind: "number", decimals: 0 },
            x: hours.slice(0, 62).map((h) => h.time.slice(11)),
            series: [
              { name: t.weather.chart, values: hours.slice(0, 62).map((h) => h.temperature) },
            ],
          }}
        />
      )}
    </>
  );
}

function Footer({ p }: { p: WeatherPayload }) {
  const { t } = useI18n();
  const where =
    p.location?.source === "device"
      ? t.weather.device
      : [p.location?.name, p.location?.detail].filter(Boolean).join(", ");
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
      {where && <span>{where}</span>}
      {p.location?.source === "timezone" && <span>· {t.weather.assumed}</span>}
      <span>
        · {t.weather.data}:{" "}
        <a href={p.attribution.url} target="_blank" rel="noreferrer" className="underline">
          {p.attribution.name}
        </a>
      </span>
    </p>
  );
}

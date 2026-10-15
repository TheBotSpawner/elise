"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { InfoTip } from "@/components/shared/info-tip";
import { Switch } from "@/components/ui/switch";
import { availableModules, type ModuleStates, type NativeModuleKey } from "@/core/modules/registry";
import { fold } from "@/core/providers/catalog";
import type { Dictionary } from "@/lib/i18n";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { setModuleAction } from "./actions";

/**
 * Connections → Mi ELISE (ADR-064): ELISE's own modules, chosen here — not a connection, so it
 * sits above them and never mixes with providers. Toggling is immediate and reversible; nothing
 * is ever deleted. Search matches names, descriptions and everyday words in both languages.
 */

/** Modules matching a search, in Mi ELISE order (every word must match something). */
export function matchModules(query: string, t: Dictionary): NativeModuleKey[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return availableModules()
    .filter((m) => {
      const key = m.key as NativeModuleKey;
      const hay = fold(
        [
          t.capabilities[key],
          t.myEliseModules.descriptions[key],
          t.myEliseModules.title,
          ...m.searchTerms,
        ].join(" "),
      );
      return words.every((w) => hay.includes(w));
    })
    .map((m) => m.key as NativeModuleKey);
}

export function MyEliseSection({
  states: initial,
  only,
}: {
  states: ModuleStates;
  /** A search's matches; absent: every module. */
  only?: readonly NativeModuleKey[];
}) {
  const { t } = useI18n();
  const m = t.myEliseModules;
  const router = useRouter();
  const [states, setStates] = useState(initial);
  const [pending, start] = useTransition();
  const keys = only ?? availableModules().map((x) => x.key as NativeModuleKey);
  if (!keys.length) return null;

  function toggle(key: NativeModuleKey, on: boolean) {
    const name = t.capabilities[key];
    setStates((s) => ({ ...s, [key]: on }));
    start(async () => {
      const r = await setModuleAction(key, on);
      if (!r.ok) {
        setStates((s) => ({ ...s, [key]: !on }));
        return void toast.error(errorText(t, r.error));
      }
      toast.success(on ? m.enabledToast(name) : m.disabledToast(name));
      // Navigation, guards and ELISE's next turn read the saved choice.
      router.refresh();
    });
  }

  return (
    <section
      id="mi-elise"
      aria-labelledby="hub-my-elise"
      className="flex scroll-mt-24 flex-col gap-3"
    >
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1">
          <h2 id="hub-my-elise" className="type-label text-faint">
            {m.title}
          </h2>
          <InfoTip label={t.common.aboutSection(m.title)} title={m.title} body={[m.about]} />
        </span>
        {!only && <p className="text-[13.5px] text-muted">{m.subtitle}</p>}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {keys.map((key) => {
          const Icon = MY_ELISE_ICONS[key];
          const on = states[key];
          const name = t.capabilities[key];
          return (
            <li key={key}>
              <div
                className={cn(
                  "flex h-full items-center gap-3 rounded-2xl border bg-surface px-4 py-3 transition-colors",
                  on ? "border-border" : "border-dashed border-border",
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-bg",
                    on ? "text-accent-text" : "text-faint",
                  )}
                >
                  <Icon className="size-[18px]" strokeWidth={1.7} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-medium">{name}</span>
                  <span className="line-clamp-2 block text-[13px] leading-snug text-muted">
                    {m.descriptions[key]}
                  </span>
                  {/* State in words, not only color. */}
                  <span className={cn("block text-[12px]", on ? "text-faint" : "text-faint/80")}>
                    {on ? m.on : m.off}
                  </span>
                </span>
                <Switch
                  checked={on}
                  disabled={pending}
                  aria-label={m.toggle(name)}
                  onCheckedChange={(next) => toggle(key, next)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

"use client";

import { PERSONALITIES, type ElisePersonality } from "@/core/personality";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * The five personalities (ADR-076) as native radios: one control for Settings, onboarding and
 * the chat's "cambiá tu personalidad" — never three lists. Keyboard: arrows move, space picks.
 */
export function PersonalityOptions({
  value,
  onChange,
  disabled = false,
  name = "personality",
  showSample = false,
}: {
  value: ElisePersonality;
  onChange: (p: ElisePersonality) => void;
  disabled?: boolean;
  /** Distinct per instance when several are on screen (chat history). */
  name?: string;
  /** Under the chosen one: how ELISE would reply. */
  showSample?: boolean;
}) {
  const { t } = useI18n();
  const p = t.personality;
  return (
    <div role="radiogroup" aria-label={p.base} className="flex flex-col gap-2">
      {PERSONALITIES.map((key) => {
        const on = key === value;
        const o = p.options[key];
        return (
          <label
            key={key}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
              on ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              disabled && "cursor-default opacity-60",
            )}
          >
            <input
              type="radio"
              name={name}
              value={key}
              checked={on}
              disabled={disabled}
              onChange={() => onChange(key)}
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.name}</span>
              <span className="block text-[12.5px] text-muted">{o.description}</span>
              {showSample && on && (
                <span className="mt-1.5 block text-[12.5px] text-fg/80 italic">
                  <span className="text-faint not-italic">{p.previewLabel}: </span>“{o.sample}”
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

"use client";

import { Check, Clock } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, useTransition } from "react";

import { Orb } from "@/components/elise/orb/orb";
import { Button } from "@/components/ui/button";
import type { CapabilityKey } from "@/core/capabilities/types";
import { PROVIDERS } from "@/core/providers/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { completeOnboarding } from "./actions";

const CHOICES: CapabilityKey[] = [
  "tasks",
  "calendar",
  "email",
  "knowledge",
  "habits",
  "finance",
  "notes",
];
const DEFAULTS: CapabilityKey[] = ["tasks", "calendar", "email", "knowledge", "habits"];

/** Short, visual, skippable (docs/product/04 §9-10). Explains value, not architecture. */
export function OnboardingFlow() {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<CapabilityKey[]>(DEFAULTS);
  const [pending, startTransition] = useTransition();

  function finish(skipped: boolean) {
    startTransition(() =>
      completeOnboarding({
        capabilities: selected,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        skipped,
      }),
    );
  }

  function toggle(key: CapabilityKey) {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  }

  return (
    <div className="w-full max-w-lg">
      <AnimatePresence mode="wait">
        <motion.section
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center text-center"
        >
          {step === 0 && (
            <>
              <Orb size={200} state="idle" />
              <h1 className="mt-8 text-3xl font-semibold tracking-tight">
                {t.onboarding.welcomeTitle}
              </h1>
              <p className="mt-3 max-w-md text-muted">{t.onboarding.welcomeBody}</p>
              <p className="mt-6 font-mono text-xs tracking-[0.3em] text-accent">
                {t.meta.tagline.toUpperCase()}
              </p>
              <div className="mt-8 flex gap-2">
                <Button size="lg" onClick={() => setStep(1)}>
                  {t.onboarding.start}
                </Button>
                <Button size="lg" variant="ghost" onClick={() => finish(true)} disabled={pending}>
                  {t.onboarding.skip}
                </Button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Orb size={88} state="listening" />
              <h1 className="mt-6 text-2xl font-semibold tracking-tight">
                {t.onboarding.capabilitiesTitle}
              </h1>
              <p className="mt-2 text-sm text-muted">{t.onboarding.capabilitiesBody}</p>
              <div className="mt-6 grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
                {CHOICES.map((key) => {
                  const on = selected.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(key)}
                      className={cn(
                        "flex h-12 items-center justify-between rounded-xl border px-3 text-sm transition-colors",
                        on
                          ? "border-accent bg-accent-soft"
                          : "border-border text-muted hover:border-border-strong",
                      )}
                    >
                      {t.capabilities[key]}
                      {on && <Check className="size-4 text-accent" aria-hidden />}
                    </button>
                  );
                })}
              </div>
              <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} />
            </>
          )}

          {step === 2 && (
            <>
              <Orb size={88} state="executing" />
              <h1 className="mt-6 text-2xl font-semibold tracking-tight">
                {t.onboarding.connectTitle}
              </h1>
              <p className="mt-2 text-sm text-muted">{t.onboarding.connectBody}</p>
              <ul className="mt-6 w-full space-y-2 text-left">
                {selected.map((key) => {
                  const native = key === "tasks";
                  const providers = PROVIDERS.filter(
                    (p) => p.capabilities.includes(key) && p.key !== "elise_native",
                  );
                  return (
                    <li
                      key={key}
                      className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{t.capabilities[key]}</p>
                        <p className="text-xs text-muted">
                          {native
                            ? t.onboarding.useEliseTasks
                            : providers.map((p) => t.providers[p.key]).join(" · ")}
                        </p>
                      </div>
                      {native ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <Check className="size-3.5" aria-hidden />
                          {t.onboarding.ready}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                          <Clock className="size-3.5" aria-hidden />
                          {t.onboarding.comingSoon}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-8 flex gap-2">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  {t.onboarding.back}
                </Button>
                <Button size="lg" onClick={() => finish(false)} disabled={pending}>
                  {t.onboarding.finish}
                </Button>
              </div>
            </>
          )}
        </motion.section>
      </AnimatePresence>
    </div>
  );
}

function Nav({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-8 flex gap-2">
      <Button variant="ghost" onClick={onBack}>
        {t.onboarding.back}
      </Button>
      <Button onClick={onNext}>{t.onboarding.next}</Button>
    </div>
  );
}

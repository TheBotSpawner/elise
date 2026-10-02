"use client";

import { Check } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { GoogleMark, NotionIcon } from "@/components/elise/brand-icons";
import { Orb } from "@/components/elise/orb/orb";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input, Label, Select } from "@/components/ui/input";
import type { CapabilityKey } from "@/core/capabilities/types";
import type { ConnectionHealth } from "@/core/providers/health";
import { connectGoogle, connectNotion } from "@/features/connections/actions";
import { SpaceGlyph } from "@/features/knowledge/appearance";
import { updateProfile } from "@/features/settings/actions";
import { errorText, LOCALES, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { timezoneOptions } from "@/lib/timezones";
import { cn } from "@/lib/utils";

import { completeOnboarding, createFirstSpace, saveOnboardingProgress } from "./actions";
import {
  ONBOARDING_STEPS,
  PRESET_APPEARANCE,
  SPACE_PRESETS,
  type OnboardingProgress,
  type OnboardingStep,
  type SpacePreset,
} from "./model";

const GOOGLE_PRODUCTS = ["calendar", "tasks", "email", "knowledge", "finance"] as const;
/** Brand names: the same in every language. */
const PRODUCT: Record<(typeof GOOGLE_PRODUCTS)[number], string> = {
  calendar: "Calendar",
  tasks: "Tasks",
  email: "Gmail",
  knowledge: "Drive",
  finance: "Sheets",
};
/** Asked for by default; the rest are opt-in, as in Connections. */
const DEFAULT_ON = new Set<string>(["calendar", "tasks"]);

export interface OnboardingAccount {
  id: string;
  provider: "google" | "notion";
  label: string;
  health: ConnectionHealth;
  capabilities: CapabilityKey[];
}

/**
 * First run, in five short steps (ADR-019; docs/product/04 §9-10): welcome, profile, tools,
 * first Space, ready. It explains value, never architecture, and ends on Home.
 */
export function OnboardingFlow({
  initial,
  profile,
  accounts,
  googleAvailable,
  notionAvailable,
  spaces,
  returned,
}: {
  initial: OnboardingProgress;
  profile: { displayName: string; language: Locale; timezone: string };
  accounts: OnboardingAccount[];
  googleAvailable: boolean;
  notionAvailable: boolean;
  spaces: { id: string; name: string; icon: string; color: string }[];
  returned: { connected: boolean; missing: string[]; error: string | null };
}) {
  const { t } = useI18n();
  const o = t.onboarding;
  const reduce = useReducedMotion();
  const [progress, setProgress] = useState<OnboardingProgress>(initial);
  const [finishing, startFinish] = useTransition();
  const step = progress.step;
  // OAuth results arrive in the URL once; a reload shouldn't show them again.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", "/onboarding");
  }, []);
  const index = ONBOARDING_STEPS.indexOf(step);

  function go(next: OnboardingStep, patch: Partial<OnboardingProgress> = {}) {
    const value = { ...progress, ...patch, step: next };
    setProgress(value);
    // Saved in the background: leaving for Google and coming back resumes here.
    void saveOnboardingProgress(value).catch(() => undefined);
  }

  const finish = (skipped: boolean) => startFinish(() => completeOnboarding({ skipped }));

  return (
    <div className="w-full max-w-xl">
      {index > 0 && (
        <p className="mb-6 text-center font-mono text-[11px] tracking-[0.25em] text-faint uppercase">
          <span className="sr-only">{o.stepOf(index, ONBOARDING_STEPS.length - 1)}</span>
          <span aria-hidden className="inline-flex gap-1.5">
            {ONBOARDING_STEPS.slice(1).map((s, i) => (
              <span
                key={s}
                className={cn("h-1 w-6 rounded-full", i < index ? "bg-accent" : "bg-border-strong")}
              />
            ))}
          </span>
        </p>
      )}
      <AnimatePresence mode="wait">
        <motion.section
          key={step}
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: -12 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center text-center"
          aria-labelledby={`onboarding-${step}`}
        >
          {step === "welcome" && (
            <>
              <Orb size={200} state="idle" />
              <h1 id="onboarding-welcome" className="mt-8 text-3xl font-semibold tracking-tight">
                {o.welcomeTitle}
              </h1>
              <p className="mt-3 max-w-md text-muted">{o.welcomeBody}</p>
              <div className="mt-8 flex flex-col gap-2 sm:flex-row">
                <Button size="lg" onClick={() => go("profile")}>
                  {o.start}
                </Button>
                <Button size="lg" variant="ghost" onClick={() => finish(true)} disabled={finishing}>
                  {o.explore}
                </Button>
              </div>
            </>
          )}

          {step === "profile" && (
            <ProfileStep
              profile={profile}
              onBack={() => go("welcome")}
              onDone={() => go("connect")}
            />
          )}

          {step === "connect" && (
            <ConnectStep
              accounts={accounts}
              googleAvailable={googleAvailable}
              notionAvailable={notionAvailable}
              returned={returned}
              onBack={() => go("profile")}
              onNext={() => go("space")}
            />
          )}

          {step === "space" && (
            <SpaceStep
              spaces={spaces}
              preset={progress.spacePreset ?? null}
              onBack={() => go("connect")}
              onDone={(spacePreset, spaceId) => go("ready", { spacePreset, spaceId })}
            />
          )}

          {step === "ready" && (
            <>
              <Orb size={120} state="success" />
              <h1 id="onboarding-ready" className="mt-6 text-2xl font-semibold tracking-tight">
                {o.readyTitle}
              </h1>
              <p className="mt-2 max-w-md text-sm text-muted">{o.readyBody}</p>
              <ul className="mt-6 w-full space-y-2 text-left text-sm">
                <ReadyLine done>{o.readyProfile}</ReadyLine>
                <ReadyLine done={accounts.length > 0}>
                  {accounts.length ? o.readyConnected(accounts.length) : o.readyNoConnections}
                </ReadyLine>
                <ReadyLine done={Boolean(progress.spaceId) || spaces.length > 0}>
                  {progress.spaceId || spaces.length ? o.readySpace : o.readyNoSpace}
                </ReadyLine>
              </ul>
              <div className="mt-8 flex flex-col gap-2 sm:flex-row">
                <Button variant="ghost" onClick={() => go("space")} disabled={finishing}>
                  {o.back}
                </Button>
                <Button size="lg" onClick={() => finish(false)} disabled={finishing}>
                  {o.finish}
                </Button>
              </div>
            </>
          )}
        </motion.section>
      </AnimatePresence>
    </div>
  );
}

function ReadyLine({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full",
          done ? "bg-accent text-accent-fg" : "border border-border-strong",
        )}
      >
        {done && <Check className="size-3" />}
      </span>
      <span className={cn(!done && "text-muted")}>{children}</span>
    </li>
  );
}

function ProfileStep({
  profile,
  onBack,
  onDone,
}: {
  profile: { displayName: string; language: Locale; timezone: string };
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const o = t.onboarding;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // A new account starts in UTC: suggest the browser's zone instead.
  const [values, setValues] = useState(() => ({
    ...profile,
    timezone:
      profile.timezone === "UTC"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        : profile.timezone,
  }));
  const timezones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return timezoneOptions(zones.includes(values.timezone) ? zones : [values.timezone, ...zones]);
  }, [values.timezone]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateProfile(values);
      if (!result.ok) return setError(errorText(t, result.error));
      // A language change re-renders the rest of the flow in that language.
      if (values.language !== profile.language) router.refresh();
      onDone();
    });
  }

  return (
    <form onSubmit={save} className="flex w-full flex-col items-center">
      <Orb size={88} state="listening" />
      <h1 id="onboarding-profile" className="mt-6 text-2xl font-semibold tracking-tight">
        {o.profileTitle}
      </h1>
      <p className="mt-2 text-sm text-muted">{o.profileBody}</p>
      <div className="mt-6 grid w-full gap-4 text-left sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="ob-name">{t.settings.displayName}</Label>
          <Input
            id="ob-name"
            value={values.displayName}
            maxLength={120}
            required
            autoComplete="name"
            onChange={(e) => setValues({ ...values, displayName: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-language">{t.settings.language}</Label>
          <Select
            id="ob-language"
            value={values.language}
            onChange={(e) => setValues({ ...values, language: e.target.value as Locale })}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t.settings.languages[l]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-timezone">{t.settings.timezone}</Label>
          <Combobox
            id="ob-timezone"
            value={values.timezone}
            options={timezones}
            placeholder={t.settings.timezoneSearch}
            emptyText={t.settings.timezoneNone}
            onChange={(timezone) => setValues({ ...values, timezone })}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-8 flex gap-2">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          {o.back}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t.common.loading : o.next}
        </Button>
      </div>
    </form>
  );
}

function ConnectStep({
  accounts,
  googleAvailable,
  notionAvailable,
  returned,
  onBack,
  onNext,
}: {
  accounts: OnboardingAccount[];
  googleAvailable: boolean;
  notionAvailable: boolean;
  returned: { connected: boolean; missing: string[]; error: string | null };
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [leaving, setLeaving] = useState(false);
  const google = accounts.filter((a) => a.provider === "google");
  const notion = accounts.filter((a) => a.provider === "notion");

  return (
    <div className="flex w-full flex-col items-center">
      <Orb size={88} state="executing" />
      <h1 id="onboarding-connect" className="mt-6 text-2xl font-semibold tracking-tight">
        {o.connectTitle}
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted">{o.connectBody}</p>

      {returned.error && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          {errorText(t, { code: returned.error })}
        </p>
      )}
      {returned.missing.length > 0 && (
        <p role="status" className="mt-4 text-sm text-approval-text">
          {t.connections.missingToast(
            returned.missing.map((c) => PRODUCT[c as keyof typeof PRODUCT] ?? c).join(", "),
          )}
        </p>
      )}

      <div className="mt-6 w-full space-y-3 text-left">
        {/* Google: the user picks exactly what ELISE may use. */}
        <section className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <GoogleMark size={18} />
            Google
          </h2>
          {google.map((a) => (
            <AccountLine key={a.id} account={a} />
          ))}
          {googleAvailable ? (
            <form action={connectGoogle} onSubmit={() => setLeaving(true)} className="mt-3">
              <input type="hidden" name="returnTo" value="/onboarding" />
              <fieldset>
                <legend className="text-[13px] text-muted">{o.googlePick}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {GOOGLE_PRODUCTS.map((cap) => (
                    <label
                      key={cap}
                      className="flex h-11 cursor-pointer items-center gap-2 rounded-full border border-border-strong px-3.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
                    >
                      <input
                        type="checkbox"
                        name="capability"
                        value={cap}
                        defaultChecked={DEFAULT_ON.has(cap)}
                        className="size-4 accent-[var(--accent)]"
                      />
                      {PRODUCT[cap]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button type="submit" className="mt-3" disabled={leaving}>
                <GoogleMark size={16} />
                {google.length ? t.connections.addGoogle : t.connections.connectGoogle}
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-[13px] text-muted">{t.connections.notConfigured}</p>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <NotionIcon size={18} />
            Notion
          </h2>
          {notion.map((a) => (
            <AccountLine key={a.id} account={a} />
          ))}
          {notionAvailable ? (
            <form action={connectNotion} onSubmit={() => setLeaving(true)} className="mt-2">
              <input type="hidden" name="returnTo" value="/onboarding" />
              <p className="text-[13px] text-muted">{t.connections.notionHint}</p>
              <Button type="submit" variant="secondary" className="mt-3" disabled={leaving}>
                {notion.length ? t.connections.addNotion : t.connections.connectNotion}
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-[13px] text-muted">{t.connections.notionNotConfigured}</p>
          )}
        </section>
        <p className="text-center text-[12.5px] text-faint">{o.connectPrivacy}</p>
      </div>

      <div className="mt-8 flex gap-2">
        <Button variant="ghost" onClick={onBack} disabled={leaving}>
          {o.back}
        </Button>
        <Button onClick={onNext} disabled={leaving}>
          {accounts.length ? o.next : o.skipStep}
        </Button>
      </div>
    </div>
  );
}

function AccountLine({ account }: { account: OnboardingAccount }) {
  const { t } = useI18n();
  const ok = account.health === "connected";
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px]">
      <Check className={cn("size-4", ok ? "text-success" : "text-approval")} aria-hidden />
      <span className="font-medium">{account.label}</span>
      <span className="text-muted">
        {ok
          ? account.capabilities
              .map((c) => PRODUCT[c as keyof typeof PRODUCT] ?? t.capabilities[c])
              .join(" · ")
          : t.connections.health[account.health]}
      </span>
    </p>
  );
}

function SpaceStep({
  spaces,
  preset: initialPreset,
  onBack,
  onDone,
}: {
  spaces: { id: string; name: string; icon: string; color: string }[];
  preset: SpacePreset | null;
  onBack: () => void;
  onDone: (preset: SpacePreset | null, spaceId: string | null) => void;
}) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [preset, setPreset] = useState<SpacePreset | null>(initialPreset);
  const [name, setName] = useState(initialPreset ? o.presets[initialPreset].name : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(p: SpacePreset) {
    setPreset(p);
    setName(p === "custom" ? "" : o.presets[p].name);
  }

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!preset) return;
    setError(null);
    startTransition(async () => {
      const result = await createFirstSpace({ preset, name });
      if (!result.ok) return setError(errorText(t, result.error));
      onDone(preset, result.spaceId);
    });
  }

  return (
    <form onSubmit={create} className="flex w-full flex-col items-center">
      <Orb size={88} state="thinking" />
      <h1 id="onboarding-space" className="mt-6 text-2xl font-semibold tracking-tight">
        {o.spaceTitle}
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted">{o.spaceBody}</p>
      {spaces.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          {o.spaceExisting(spaces.map((s) => s.name).join(", "))}
        </p>
      )}
      <div
        role="radiogroup"
        aria-label={o.spaceTitle}
        className="mt-6 grid w-full grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {SPACE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            onClick={() => pick(p)}
            className={cn(
              "flex min-h-14 items-center gap-2.5 rounded-xl border px-3 text-left text-sm transition-colors",
              preset === p
                ? "border-accent bg-accent-soft"
                : "border-border text-muted hover:border-border-strong",
            )}
          >
            <SpaceGlyph
              icon={PRESET_APPEARANCE[p].icon}
              color={PRESET_APPEARANCE[p].color}
              size="sm"
            />
            {o.presets[p].label}
          </button>
        ))}
      </div>
      {preset && (
        <div className="mt-4 w-full space-y-1.5 text-left">
          <Label htmlFor="ob-space-name">{o.spaceName}</Label>
          <Input
            id="ob-space-name"
            value={name}
            maxLength={80}
            required
            placeholder={o.spaceNamePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-[12.5px] text-faint">{o.presets[preset].hint}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-8 flex gap-2">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          {o.back}
        </Button>
        <Button variant="ghost" onClick={() => onDone(null, null)} disabled={pending}>
          {o.skipStep}
        </Button>
        <Button type="submit" disabled={!preset || !name.trim() || pending}>
          {pending ? t.common.loading : o.createSpace}
        </Button>
      </div>
    </form>
  );
}

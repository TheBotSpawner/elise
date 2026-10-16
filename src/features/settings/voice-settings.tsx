"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { VOICE_CATALOG, type VoiceKey } from "@/core/voice/catalog";
import type { WakeAvailability } from "@/core/voice/device";
import { VOICE_LANGUAGES, type VoiceLanguage } from "@/core/voice/preferences";
import { setStartupSoundEnabled, startupSoundEnabled } from "@/features/boot/startup-sound";
import { VOICE_PREFS_EVENT } from "@/features/voice/voice-controller";
import { WebSpeechWakeEngine } from "@/features/voice/wake-engine";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { setVoicePreferences } from "./actions";
import { SettingRow, SettingsCard } from "./shell";

interface Prefs {
  continuous: boolean;
  language: VoiceLanguage;
  voice: VoiceKey;
}

/**
 * Voice (ADR-068): three choices — continuous conversation, the voice language and the voice.
 * The wake phrase is always "Elise"; barge-in and quiet-speech matching are defaults. The
 * device line says only what this browser can really do, checked, never assumed.
 */
export function VoiceSettings({
  initial,
  voices,
  wakeAllowed = true,
}: {
  initial: Prefs;
  /** The curated voices configured now, by stable key (ADR-030); never provider ids. */
  voices: readonly VoiceKey[];
  /** The wake-phrase feature flag (ADR-019). */
  wakeAllowed?: boolean;
}) {
  const { t, locale } = useI18n();
  const v = t.settingsHub.voice;
  const [prefs, setPrefs] = useState(initial);
  const [, startTransition] = useTransition();
  const lang: "es" | "en" = prefs.language === "auto" ? locale : prefs.language;
  const offered = VOICE_CATALOG.filter((c) => voices.includes(c.key));
  const [wake, setWake] = useState<WakeAvailability | "installing" | "checking">("checking");
  useEffect(() => {
    let live = true;
    const engine = WebSpeechWakeEngine.supported() ? new WebSpeechWakeEngine() : null;
    void (engine ? engine.availability(lang) : Promise.resolve("unavailable" as const)).then(
      (a) => live && setWake(a),
    );
    return () => {
      live = false;
    };
  }, [lang]);

  async function install() {
    setWake("installing");
    const ok = await new WebSpeechWakeEngine().install(lang);
    setWake(ok ? "available" : await new WebSpeechWakeEngine().availability(lang));
  }

  function change(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    startTransition(async () => {
      const result = await setVoicePreferences(next);
      if (!result.ok) {
        setPrefs(prefs);
        toast.error(t.errors.codes[result.error.code]);
      } else
        window.dispatchEvent(
          new CustomEvent(VOICE_PREFS_EVENT, {
            detail: { continuous: next.continuous, wakeEnabled: next.continuous },
          }),
        );
    });
  }

  const [previewing, setPreviewing] = useState<VoiceKey | null>(null);
  /** A short fixed sample in that voice; listening never changes the chosen voice. */
  async function preview(voice: VoiceKey) {
    setPreviewing(voice);
    try {
      const res = await fetch(`/api/voice/preview?voice=${voice}&language=${lang}`);
      if (!res.ok) throw new Error("preview failed");
      const rate = Number(/rate=(\d+)/.exec(res.headers.get("x-audio-format") ?? "")?.[1] ?? 24000);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
      const ctx = new AudioContext();
      const buffer = ctx.createBuffer(1, pcm.length, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => void ctx.close();
      source.start();
    } catch {
      toast.error(v.previewFailed);
    } finally {
      setPreviewing(null);
    }
  }

  // The web can only offer "Elise" in an open, visible tab — and only where it's detected here.
  const wakeHere = wakeAllowed && prefs.continuous && wake !== "unavailable" && wake !== "checking";
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard>
        <SettingRow
          id="continuous"
          label={v.continuous}
          info={v.continuousInfo}
          hint={
            <>
              {v.continuousHint}
              {wakeHere && wake === "available" && (
                <span className="mt-1 block text-faint">{v.wakeHere}</span>
              )}
              {wakeHere && wake !== "available" && (
                // The browser needs its on-device speech pack first: a quiet, optional step.
                <button
                  type="button"
                  disabled={wake !== "downloadable"}
                  onClick={() => void install()}
                  className="mt-1 block text-[12.5px] text-accent-text hover:underline disabled:text-faint disabled:no-underline"
                >
                  {wake === "downloadable" ? v.wakeInstall : v.wakeInstalling}
                </button>
              )}
            </>
          }
        >
          <Switch
            checked={prefs.continuous}
            aria-label={v.continuous}
            onCheckedChange={(continuous) => change({ continuous })}
          />
        </SettingRow>
        <SettingRow id="voice-language" label={v.language} hint={v.languageHint} stack>
          <Select
            aria-label={v.language}
            value={prefs.language}
            onChange={(e) => change({ language: e.target.value as VoiceLanguage })}
            className="sm:w-56"
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {v.languages[l]}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow id="voice-name" label={v.voice} hint={v.voiceHint} stack>
          <div role="radiogroup" aria-label={v.voice} className="flex flex-col gap-2">
            {offered.map((c) => {
              const on = c.key === prefs.voice;
              return (
                <div
                  key={c.key}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                    on ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
                  )}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <input
                      type="radio"
                      name="voice"
                      value={c.key}
                      checked={on}
                      onChange={() => change({ voice: c.key })}
                      className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {c.name}
                        {on && (
                          <span className="text-[11.5px] font-normal text-accent-text">
                            {v.voiceInUse}
                          </span>
                        )}
                      </span>
                      <span className="block text-[12.5px] text-muted">{c.summary[locale]}</span>
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    aria-label={v.previewOf(c.name)}
                    disabled={previewing !== null}
                    onClick={() => void preview(c.key)}
                  >
                    {previewing === c.key ? v.previewing : v.preview}
                  </Button>
                </div>
              );
            })}
          </div>
        </SettingRow>
      </SettingsCard>
      <SoundsCard />
    </div>
  );
}

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** ELISE's sounds: the startup chime, a per-device choice (ADR-046). */
function SoundsCard() {
  const { t } = useI18n();
  const s = t.settings.startup;
  const on = useSyncExternalStore(subscribe, startupSoundEnabled, () => true);
  return (
    <SettingsCard title={t.settingsHub.voice.sounds}>
      <SettingRow id="sounds" label={s.sound} hint={s.soundHint}>
        <Switch
          checked={on}
          aria-label={s.sound}
          onCheckedChange={(next) => {
            setStartupSoundEnabled(next);
            listeners.forEach((l) => l());
          }}
        />
      </SettingRow>
    </SettingsCard>
  );
}

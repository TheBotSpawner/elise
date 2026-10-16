"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { WakeAvailability } from "@/core/voice/device";
import { VOICE_LANGUAGES, type VoiceLanguage } from "@/core/voice/preferences";
import type { VoiceChoice } from "@/core/voice/providers";
import { setStartupSoundEnabled, startupSoundEnabled } from "@/features/boot/startup-sound";
import { VOICE_PREFS_EVENT } from "@/features/voice/voice-controller";
import { WebSpeechWakeEngine } from "@/features/voice/wake-engine";
import { useI18n } from "@/lib/i18n/client";

import { setVoicePreferences } from "./actions";
import { SettingRow, SettingsCard } from "./shell";

interface Prefs {
  continuous: boolean;
  language: VoiceLanguage;
  voice: VoiceChoice;
}

/**
 * Voice (ADR-068): three choices — continuous conversation, the voice language and the voice.
 * The wake phrase is always "Elise"; barge-in and quiet-speech matching are defaults. The
 * device line says only what this browser can really do, checked, never assumed.
 */
export function VoiceSettings({
  initial,
  profiles,
  wakeAllowed = true,
}: {
  initial: Prefs;
  /** The voices this deployment offers, by stable id (the provider is an implementation). */
  profiles: { id: VoiceChoice; displayName: string }[];
  /** The wake-phrase feature flag (ADR-019). */
  wakeAllowed?: boolean;
}) {
  const { t, locale } = useI18n();
  const v = t.settingsHub.voice;
  const [prefs, setPrefs] = useState(initial);
  const [, startTransition] = useTransition();
  const lang: "es" | "en" = prefs.language === "auto" ? locale : prefs.language;
  const voice = profiles.some((p) => p.id === prefs.voice)
    ? prefs.voice
    : (profiles[0]?.id ?? prefs.voice);
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

  const [previewing, setPreviewing] = useState(false);
  /** A fixed ELISE sample in the selected voice (never the user's own content). */
  async function preview() {
    setPreviewing(true);
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
      setPreviewing(false);
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
          <div className="flex gap-2">
            <Select
              aria-label={v.voice}
              value={voice}
              onChange={(e) => change({ voice: e.target.value as VoiceChoice })}
              className="max-sm:flex-1 sm:w-44"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName.charAt(0).toUpperCase() + p.displayName.slice(1)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              className="h-10 shrink-0"
              disabled={previewing}
              onClick={() => void preview()}
            >
              {previewing ? v.previewing : v.preview}
            </Button>
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

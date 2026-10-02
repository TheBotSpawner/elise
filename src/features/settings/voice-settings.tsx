"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { VoicePreferences } from "@/application/auth-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { WakeAvailability } from "@/core/voice/device";
import { VOICES } from "@/core/voice/providers";
import { WAKE_LABELS, WAKE_PHRASES, type WakePhrase } from "@/core/voice/wake";
import { VOICE_PREFS_EVENT } from "@/features/voice/voice-controller";
import { WebSpeechWakeEngine } from "@/features/voice/wake-engine";
import { useI18n } from "@/lib/i18n/client";

import { setVoicePreferences } from "./actions";

/**
 * Voice (ADR-014, ADR-017): only controls that work. The wake phrase is offered only as far as
 * this browser can detect it on the device — checked, never assumed.
 */
export function VoiceSettings({
  initial,
  wakeAllowed = true,
}: {
  initial: VoicePreferences;
  /** The wake-phrase feature flag (ADR-019). */
  wakeAllowed?: boolean;
}) {
  const { t, locale } = useI18n();
  const s = t.voice.settings;
  const [prefs, setPrefs] = useState(initial);
  const [, startTransition] = useTransition();
  const lang: "es" | "en" = prefs.language === "auto" ? locale : prefs.language;
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

  function change(patch: Partial<VoicePreferences>) {
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
            detail: {
              speak: next.speak,
              continuous: next.continuous,
              bargeIn: next.bargeIn,
              wakeEnabled: next.wakeEnabled,
              wakePhrase: next.wakePhrase,
            },
          }),
        );
    });
  }

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-medium">{s.title}</h2>
      <div className="flex flex-col gap-5">
        <Row label={s.enabled} hint={s.enabledHint}>
          <Switch
            checked={prefs.enabled}
            aria-label={s.enabled}
            onCheckedChange={(enabled) => change({ enabled })}
          />
        </Row>
        <Row label={s.speak} hint={s.speakHint}>
          <Switch
            checked={prefs.speak}
            disabled={!prefs.enabled}
            aria-label={s.speak}
            onCheckedChange={(speak) => change({ speak })}
          />
        </Row>
        <Row label={s.continuous} hint={s.continuousHint}>
          <Switch
            checked={prefs.continuous}
            disabled={!prefs.enabled}
            aria-label={s.continuous}
            onCheckedChange={(continuous) => change({ continuous })}
          />
        </Row>
        <Row label={s.bargeIn} hint={s.bargeInHint}>
          <Switch
            checked={prefs.bargeIn}
            disabled={!prefs.enabled || !prefs.speak}
            aria-label={s.bargeIn}
            onCheckedChange={(bargeIn) => change({ bargeIn })}
          />
        </Row>
        {/* Offered only where this browser can detect it on the device (ADR-017 §7). */}
        {wakeAllowed && wake !== "unavailable" && (
          <Row label={s.wake} hint={s.wakeHint}>
            <Switch
              checked={prefs.wakeEnabled}
              disabled={!prefs.enabled || wake === "checking"}
              aria-label={s.wake}
              onCheckedChange={(wakeEnabled) => change({ wakeEnabled })}
            />
          </Row>
        )}
        {wakeAllowed && prefs.enabled && prefs.wakeEnabled && wake !== "unavailable" && (
          <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="voice-wake-phrase">{s.wakePhrase}</Label>
                <Select
                  id="voice-wake-phrase"
                  value={prefs.wakePhrase}
                  onChange={(e) => change({ wakePhrase: e.target.value as WakePhrase })}
                >
                  {WAKE_PHRASES.map((p) => (
                    <option key={p} value={p}>
                      {WAKE_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </div>
              {(wake === "downloadable" || wake === "downloading" || wake === "installing") && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={wake !== "downloadable"}
                  onClick={() => void install()}
                >
                  {wake === "downloadable" ? s.wakeInstall : s.wakeInstalling}
                </Button>
              )}
            </div>
            <p className="text-[12.5px] text-muted">
              {wake === "available" ? s.wakeReady : s.wakeNeedsPack}
            </p>
            {/* Only said where it's true: detection runs in this browser, on this device. */}
            {wake === "available" && <p className="text-[12.5px] text-faint">{s.wakePrivacy}</p>}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="voice-language">{s.language}</Label>
            <Select
              id="voice-language"
              value={prefs.language}
              disabled={!prefs.enabled}
              onChange={(e) => change({ language: e.target.value as VoicePreferences["language"] })}
            >
              {(["auto", "es", "en"] as const).map((l) => (
                <option key={l} value={l}>
                  {s.languages[l]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voice-name">{s.voice}</Label>
            <Select
              id="voice-name"
              value={prefs.voice}
              disabled={!prefs.enabled || !prefs.speak}
              onChange={(e) => change({ voice: e.target.value as VoicePreferences["voice"] })}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-[12.5px] text-faint">{s.privacy}</p>
      </div>
    </Card>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm">{label}</p>
        <p className="text-[13px] text-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

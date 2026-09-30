"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { VoicePreferences } from "@/application/auth-context";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { VOICES } from "@/core/voice/providers";
import { useI18n } from "@/lib/i18n/client";

import { setVoicePreferences } from "./actions";

/** Voice (ADR-014): only what's needed — on/off, spoken replies, language, voice. */
export function VoiceSettings({ initial }: { initial: VoicePreferences }) {
  const { t } = useI18n();
  const s = t.voice.settings;
  const [prefs, setPrefs] = useState(initial);
  const [, startTransition] = useTransition();

  function change(patch: Partial<VoicePreferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    startTransition(async () => {
      const result = await setVoicePreferences(next);
      if (!result.ok) {
        setPrefs(prefs);
        toast.error(t.errors.codes[result.error.code]);
      }
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

"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { PRESETS } from "@/core/schedules/presets";
import {
  BRIEF_BLOCKS,
  BRIEF_HORIZONS,
  DEFAULT_BRIEF_BLOCKS,
  MAX_BRIEF_CHANNELS,
  type BriefBlock,
  type BriefHorizon,
  type ScheduleInput,
  type SchedulePreset,
} from "@/core/schedules/schedule";
import { addDays, todayIn } from "@/core/time";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { createScheduleAction, slackChannelsAction, updateScheduleAction } from "./actions";
import { describeWhen } from "./format";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** A blank scheduled task: the user says what ELISE should do; nothing is assumed beyond it. */
export function blankTask(timezone: string): ScheduleInput {
  return {
    name: "",
    actionType: "morning_brief",
    definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
    timezone,
    configuration: {
      blocks: [...DEFAULT_BRIEF_BLOCKS],
      sources: { calendar: "all", email: "all", tasks: "all" },
      newsTopics: "",
      horizon: "today",
      knowledgeSpaceId: null,
      weatherLocation: null,
      slack: { connectionId: null, channels: [], window: "since_previous" },
      methodId: null,
      preset: null,
    },
    instructions: null,
    delivery: { notify: "in_app" },
  };
}

/** A preset prefills the same task (ADR-037): name, what to do, what to look at, when. */
export function presetTask(
  id: SchedulePreset,
  timezone: string,
  text: { name: string; instructions: string },
): ScheduleInput {
  const spec = PRESETS.find((p) => p.id === id)!;
  const base = blankTask(timezone);
  return {
    ...base,
    name: text.name,
    definition: spec.definition,
    configuration: {
      ...base.configuration,
      blocks: [...spec.blocks],
      horizon: spec.horizon,
      preset: id,
    },
    instructions: text.instructions || null,
  };
}

/**
 * The one scheduled-task form, no technical syntax: what ELISE should do, what it looks at,
 * when (with a readable preview), and how to notify. Presets arrive here prefilled.
 */
export function ScheduleForm({
  initial,
  scheduleId,
  spaces,
  slackWorkspaces = [],
  methods = [],
  onDone,
}: {
  /** Connected Slack workspaces: the Slack block is offered only when there is one. */
  slackWorkspaces?: { id: string; name: string }[];
  /** Methods the task can follow: the schedule says when, the Method how (ADR-040 §O). */
  methods?: { id: string; name: string }[];
  initial: ScheduleInput;
  scheduleId?: string;
  /** Knowledge Spaces for the Knowledge block. */
  spaces: { id: string; path: string }[];
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const [pending, startTransition] = useTransition();
  const [v, setV] = useState(initial);
  const timezones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const once = v.definition.kind === "once";
  const time = v.definition.kind === "once" ? v.definition.at.slice(11, 16) : v.definition.time;
  const date =
    v.definition.kind === "once" ? v.definition.at.slice(0, 10) : addDays(todayIn(v.timezone), 1);

  const setWhen = (next: { once?: boolean; days?: number[]; time?: string; date?: string }) => {
    const isOnce = next.once ?? once;
    const tm = next.time ?? time;
    setV((s) => ({
      ...s,
      definition: isOnce
        ? { kind: "once", at: `${next.date ?? date}T${tm}` }
        : {
            kind: "weekly",
            days:
              next.days ?? (s.definition.kind === "weekly" ? s.definition.days : [1, 2, 3, 4, 5]),
            time: tm,
          },
    }));
  };

  const toggleBlock = (b: BriefBlock) =>
    setV((s) => {
      const blocks = s.configuration.blocks.includes(b)
        ? s.configuration.blocks.filter((x) => x !== b)
        : [...s.configuration.blocks, b];
      return { ...s, configuration: { ...s.configuration, blocks } };
    });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      // Results are always delivered in ELISE (ADR-063); a legacy choice isn't carried over.
      const input = { ...v, delivery: { notify: "in_app" as const } };
      const result = scheduleId
        ? await updateScheduleAction(scheduleId, input)
        : await createScheduleAction(input);
      if (!result.ok) {
        toast.error(errorText(t, result.error));
        return;
      }
      onDone();
    });
  }

  const days = v.definition.kind === "weekly" ? v.definition.days : [];
  const blocks = v.configuration.blocks;
  const needsSpace = blocks.includes("knowledge") && !v.configuration.knowledgeSpaceId;
  const slack = v.configuration.slack;
  const needsSlack = blocks.includes("slack") && (!slack.connectionId || !slack.channels.length);
  const offered = BRIEF_BLOCKS.filter(
    (b) => b !== "slack" || slackWorkspaces.length > 0 || blocks.includes("slack"),
  );
  const setConfig = (patch: Partial<ScheduleInput["configuration"]>) =>
    setV((s) => ({ ...s, configuration: { ...s.configuration, ...patch } }));

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5"
    >
      <h2 className="text-base font-medium">
        {scheduleId ? t.schedules.editTitle(initial.name) : t.schedules.newTitle}
      </h2>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-name">{t.schedules.form.name}</Label>
        <Input
          id="schedule-name"
          value={v.name}
          maxLength={120}
          required
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-instructions">{t.schedules.form.what}</Label>
        <textarea
          id="schedule-instructions"
          rows={3}
          maxLength={2000}
          value={v.instructions ?? ""}
          placeholder={t.schedules.form.whatPlaceholder}
          onChange={(e) => setV({ ...v, instructions: e.target.value || null })}
          className="rounded-xl border border-border-strong bg-transparent px-3.5 py-2.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
        />
      </div>

      {(methods.length > 0 || v.configuration.methodId) && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-method">{t.methods.scheduleMethod}</Label>
          <Select
            id="schedule-method"
            value={v.configuration.methodId ?? ""}
            onChange={(e) =>
              setV({
                ...v,
                configuration: { ...v.configuration, methodId: e.target.value || null },
              })
            }
          >
            <option value="">{t.methods.scheduleNoMethod}</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <p className="text-[12.5px] text-faint">{t.methods.scheduleMethodHint}</p>
        </div>
      )}

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-sm font-medium">{t.schedules.form.repeat}</legend>
        <div className="flex flex-wrap gap-1.5">
          {WEEK_ORDER.map((d) => {
            const on = !once && days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setWhen({
                    once: false,
                    days: on ? days.filter((x) => x !== d) : [...days, d],
                  })
                }
                className={cn(
                  "h-9 min-w-12 rounded-full border px-3 text-[13px] transition-colors",
                  on
                    ? "border-accent bg-accent-soft text-accent-text"
                    : "border-border-strong text-muted hover:text-fg",
                )}
              >
                {t.schedules.days[d]}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={once}
            onClick={() => setWhen({ once: !once })}
            className={cn(
              "h-9 rounded-full border px-3 text-[13px] transition-colors",
              once
                ? "border-accent bg-accent-soft text-accent-text"
                : "border-border-strong text-muted hover:text-fg",
            )}
          >
            {t.schedules.form.oneTime}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {once && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-date">{t.schedules.form.date}</Label>
              <Input
                id="schedule-date"
                type="date"
                value={date}
                required
                onChange={(e) => setWhen({ date: e.target.value })}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-time">{t.schedules.form.time}</Label>
            <Input
              id="schedule-time"
              type="time"
              value={time}
              required
              onChange={(e) => setWhen({ time: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="schedule-tz">{t.schedules.form.timezone}</Label>
            <Select
              id="schedule-tz"
              value={v.timezone}
              onChange={(e) => setV({ ...v, timezone: e.target.value })}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </fieldset>

      {/* What "when" means in plain words: no cron, no RRULE. */}
      {(once || days.length > 0) && (
        <p className="-mt-2 text-[13px] text-muted">
          {t.schedules.form.preview}: {describeWhen(v.definition, t, locale)} ·{" "}
          {t.schedules.form.timeIn(v.timezone)}
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t.schedules.form.looksAt}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {offered.map((b) => (
            <label
              key={b}
              className="flex h-11 cursor-pointer items-center gap-3 rounded-xl border border-border-strong px-3.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="checkbox"
                checked={blocks.includes(b)}
                onChange={() => toggleBlock(b)}
                className="accent-[var(--accent)]"
              />
              {t.schedules.blocks[b]}
            </label>
          ))}
        </div>
        {blocks.includes("calendar") && (
          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor="schedule-horizon">{t.schedules.form.horizon}</Label>
            <Select
              id="schedule-horizon"
              value={v.configuration.horizon}
              onChange={(e) => setConfig({ horizon: e.target.value as BriefHorizon })}
            >
              {BRIEF_HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {t.schedules.form.horizons[h]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {blocks.includes("knowledge") && (
          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor="schedule-space">{t.schedules.form.space}</Label>
            {spaces.length === 0 ? (
              <p className="text-[13px] text-muted">{t.schedules.form.noSpaces}</p>
            ) : (
              <Select
                id="schedule-space"
                value={v.configuration.knowledgeSpaceId ?? ""}
                required
                onChange={(e) => setConfig({ knowledgeSpaceId: e.target.value || null })}
              >
                <option value="">{t.schedules.form.spacePlaceholder}</option>
                {spaces.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.path}
                  </option>
                ))}
              </Select>
            )}
            {needsSpace && (
              <p className="text-[12.5px] text-approval-text">{t.schedules.form.spaceRequired}</p>
            )}
          </div>
        )}
        {blocks.includes("news") && (
          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor="schedule-news-topics">{t.schedules.form.newsTopics}</Label>
            <Input
              id="schedule-news-topics"
              value={v.configuration.newsTopics ?? ""}
              maxLength={300}
              placeholder={t.schedules.form.newsTopicsPlaceholder}
              onChange={(e) =>
                setV({ ...v, configuration: { ...v.configuration, newsTopics: e.target.value } })
              }
            />
            <p className="text-[12.5px] text-faint">{t.schedules.form.newsTopicsHint}</p>
          </div>
        )}
        {blocks.includes("slack") && (
          <SlackBriefSettings
            workspaces={slackWorkspaces}
            value={slack}
            onChange={(next) => setConfig({ slack: next })}
          />
        )}
        {blocks.includes("weather") && (
          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor="schedule-weather-location">{t.schedules.form.weatherLocation}</Label>
            <Input
              id="schedule-weather-location"
              value={v.configuration.weatherLocation ?? ""}
              maxLength={120}
              placeholder={t.schedules.form.weatherLocationPlaceholder}
              onChange={(e) =>
                setV({
                  ...v,
                  configuration: {
                    ...v.configuration,
                    weatherLocation: e.target.value.trim() ? e.target.value : null,
                  },
                })
              }
            />
            <p className="text-[12.5px] text-faint">{t.schedules.form.weatherLocationHint}</p>
          </div>
        )}
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          {t.schedules.form.cancel}
        </Button>
        <Button
          type="submit"
          disabled={
            pending ||
            !v.name.trim() ||
            blocks.length === 0 ||
            needsSpace ||
            needsSlack ||
            (!once && days.length === 0)
          }
        >
          {scheduleId ? t.schedules.form.save : t.schedules.form.create}
        </Button>
      </div>
    </form>
  );
}

type SlackConfig = ScheduleInput["configuration"]["slack"];

/**
 * Which Slack conversations a brief reads (ADR-062): one workspace, a few chosen channels and a
 * window. ELISE reads only these, live, at run time — never the whole workspace.
 */
function SlackBriefSettings({
  workspaces,
  value,
  onChange,
}: {
  workspaces: { id: string; name: string }[];
  value: SlackConfig;
  onChange: (next: SlackConfig) => void;
}) {
  const { t } = useI18n();
  const f = t.schedules.form;
  const [channels, setChannels] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionId = value.connectionId;

  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    void slackChannelsAction(connectionId).then((r) => {
      if (!live) return;
      if (r.ok) setChannels(r.value);
      else setError(errorText(t, r.error));
    });
    return () => {
      live = false;
    };
  }, [connectionId, t]);

  const chosen = new Set(value.channels.map((c) => c.id));
  // Channels already chosen stay visible even before the list loads (or if it can't).
  const shown = [...value.channels, ...(channels ?? []).filter((c) => !chosen.has(c.id))];
  const toggle = (c: { id: string; name: string }) =>
    onChange({
      ...value,
      channels: chosen.has(c.id)
        ? value.channels.filter((x) => x.id !== c.id)
        : [...value.channels, c].slice(0, MAX_BRIEF_CHANNELS),
    });

  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-slack-workspace">{f.slackWorkspace}</Label>
          <Select
            id="schedule-slack-workspace"
            value={connectionId ?? ""}
            required
            onChange={(e) => {
              setChannels(null);
              setError(null);
              onChange({ ...value, connectionId: e.target.value || null, channels: [] });
            }}
          >
            <option value="">{f.slackWorkspacePlaceholder}</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-slack-window">{f.slackWindow}</Label>
          <Select
            id="schedule-slack-window"
            value={value.window}
            onChange={(e) =>
              onChange({ ...value, window: e.target.value as SlackConfig["window"] })
            }
          >
            <option value="since_previous">{f.slackWindows.since_previous}</option>
            <option value="24h">{f.slackWindows["24h"]}</option>
          </Select>
        </div>
      </div>
      {connectionId && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] text-muted">
            {f.slackChannels(MAX_BRIEF_CHANNELS)}
          </legend>
          {error ? (
            <p className="text-[12.5px] text-approval-text">{error}</p>
          ) : channels === null && !shown.length ? (
            <p className="text-[12.5px] text-faint">{f.slackLoading}</p>
          ) : (
            <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
              {shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={chosen.has(c.id)}
                  disabled={!chosen.has(c.id) && value.channels.length >= MAX_BRIEF_CHANNELS}
                  onClick={() => toggle(c)}
                  className={cn(
                    "h-8 rounded-full border px-3 text-[13px] transition-colors disabled:opacity-40",
                    chosen.has(c.id)
                      ? "border-accent bg-accent-soft text-accent-text"
                      : "border-border-strong text-muted hover:text-fg",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {!value.channels.length && (
            <p className="text-[12.5px] text-approval-text">{f.slackChannelRequired}</p>
          )}
        </fieldset>
      )}
    </div>
  );
}

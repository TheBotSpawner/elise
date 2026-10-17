"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ScheduleInput } from "@/core/schedules/schedule";
import { useI18n } from "@/lib/i18n/client";

import { searchMarketsAction } from "./actions";

type Markets = ScheduleInput["configuration"]["markets"];
type Instrument = Markets["instruments"][number];

/**
 * The Markets block's settings (ADR-074): which assets (searched by name or ticker through the
 * market provider, stored resolved — never free text), the period, and optional news. No assets
 * chosen → the person's followed assets. Information only: nothing here trades or owns.
 */
export function MarketsBriefSettings({
  value,
  onChange,
}: {
  value: Markets;
  onChange: (next: Markets) => void;
}) {
  const { t } = useI18n();
  const f = t.schedules.form.markets;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Instrument[]>([]);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 1) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      void searchMarketsAction(q).then((r) => {
        if (mine !== seq.current) return;
        setFailed(!r.ok);
        setFound(r.ok ? r.value : []);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const chosen = value.instruments;
  const add = (i: Instrument) => {
    if (chosen.some((c) => c.symbol === i.symbol) || chosen.length >= 8) return;
    onChange({ ...value, instruments: [...chosen, i] });
    setQuery("");
    setFound([]);
  };
  const visible = q ? found.filter((i) => !chosen.some((c) => c.symbol === i.symbol)) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-markets-search">{f.assets}</Label>
        {chosen.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {chosen.map((i) => (
              <li
                key={i.symbol}
                className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-2.5 text-[12.5px]"
              >
                <span className="font-mono">{i.symbol}</span>
                <span className="max-w-40 truncate text-muted">{i.name}</span>
                <button
                  type="button"
                  aria-label={f.remove(i.name)}
                  onClick={() =>
                    onChange({ ...value, instruments: chosen.filter((c) => c.symbol !== i.symbol) })
                  }
                  className="touch-hit grid size-5 place-items-center rounded-full text-faint hover:text-fg"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Input
          id="schedule-markets-search"
          value={query}
          maxLength={60}
          autoComplete="off"
          placeholder={f.placeholder}
          onChange={(e) => setQuery(e.target.value)}
          disabled={chosen.length >= 8}
        />
        {visible.length > 0 && (
          <ul
            role="listbox"
            aria-label={f.assets}
            className="flex flex-col rounded-xl border border-border"
          >
            {visible.slice(0, 6).map((i) => (
              <li key={`${i.symbol}-${i.exchange}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => add(i)}
                  className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-surface-2"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono font-medium">{i.symbol}</span>
                    <span className="text-muted"> · {i.name}</span>
                  </span>
                  <span className="shrink-0 text-[11.5px] text-faint">{i.exchange ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-faint">
          {failed ? f.unavailable : chosen.length ? f.chosenHint : f.emptyHint}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-markets-period">{f.period}</Label>
          <Select
            id="schedule-markets-period"
            value={value.period}
            onChange={(e) => onChange({ ...value, period: e.target.value as Markets["period"] })}
          >
            {(["today", "5d", "week", "month"] as const).map((p) => (
              <option key={p} value={p}>
                {t.brief.markets.period[p]}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-3 self-end py-2 text-[13.5px]">
          <Switch
            checked={value.news}
            aria-label={f.news}
            onCheckedChange={(news) => onChange({ ...value, news })}
          />
          {f.news}
        </label>
      </div>
    </div>
  );
}

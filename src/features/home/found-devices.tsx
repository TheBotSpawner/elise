"use client";

import { ChevronDown, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { HomeDevice } from "@/core/home/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { updateDeviceAction } from "./actions";
import { DeviceIcon } from "./device-icon";

const PAGE = 8;

/**
 * ADR-103: devices the home engine found on the network by itself (a Cast integration adds every
 * TV box around). They are not the person's until they tap "Agregar"; "Ignorar" stops offering
 * them. Nothing here is controllable, listed by ELISE or put in modes.
 *
 * ADR-128: these were registered some other time — a search now didn't confirm them — so they
 * are "Encontrados anteriormente", folded by default, with no online/offline claim, a page at
 * a time. Rows are the engine's own entities: two with the same name are two (never merged).
 */
export function FoundDevices({ devices }: { devices: readonly HomeDevice[] }) {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [limit, setLimit] = useState(PAGE);
  if (!devices.length) return null;
  const update = (id: string, patch: { added: true } | { hidden: true }) =>
    start(async () => {
      const r = await updateDeviceAction(id, patch);
      if (!r.ok) toast.error(errorText(t, r.error));
      else router.refresh();
    });
  return (
    <details className="group rounded-2xl border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-3.5 py-2.5 text-[13.5px] text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{d.previously(devices.length)}</span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ul className="flex flex-col divide-y divide-border">
        {devices.slice(0, limit).map((x) => (
          <li key={x.id} className="flex items-center gap-3 px-3.5 py-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
              <DeviceIcon type={x.type} className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px]" title={x.name}>
              {x.name}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={d.ignore}
              title={d.ignore}
              className="w-8 shrink-0 px-0"
              disabled={pending}
              onClick={() => update(x.id, { hidden: true })}
            >
              <X aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => update(x.id, { added: true })}
            >
              {d.add}
            </Button>
          </li>
        ))}
      </ul>
      {devices.length > limit && (
        <Button size="sm" variant="ghost" className="m-2" onClick={() => setLimit((n) => n + PAGE)}>
          {d.showMore(Math.min(PAGE, devices.length - limit))}
        </Button>
      )}
    </details>
  );
}

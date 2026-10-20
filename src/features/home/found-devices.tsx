"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { HomeDevice } from "@/core/home/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { updateDeviceAction } from "./actions";
import { DeviceIcon } from "./device-icon";

/**
 * ADR-103: devices the home engine found on the network by itself (a Cast integration adds every
 * TV box around). They are not the person's until they tap "Agregar"; "Ignorar" stops offering
 * them. Nothing here is controllable, listed by ELISE or put in modes.
 */
export function FoundDevices({ devices }: { devices: readonly HomeDevice[] }) {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!devices.length) return null;
  const update = (id: string, patch: { added: true } | { hidden: true }) =>
    start(async () => {
      const r = await updateDeviceAction(id, patch);
      if (!r.ok) toast.error(errorText(t, r.error));
      else router.refresh();
    });
  return (
    <section aria-labelledby="home-found" className="flex flex-col gap-2">
      <div>
        <h2 id="home-found" className="type-label text-faint">
          {d.onNetwork}
        </h2>
        <p className="text-[13px] text-muted">{d.onNetworkHint}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-dashed border-border-strong">
        {devices.map((x) => (
          <li key={x.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
              <DeviceIcon type={x.type} className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px]">{x.name}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => update(x.id, { hidden: true })}
            >
              {d.ignore}
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
    </section>
  );
}

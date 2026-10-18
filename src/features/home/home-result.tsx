"use client";

import Link from "next/link";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { DeviceIcon } from "./device-icon";

/**
 * What a home command or mode did (ADR-079), compact on the Canvas: each device with its state
 * line or what went wrong — in words, never color alone. The full dashboard is a tap away.
 */
export function HomeResultBody({ p }: { p: SurfacePayloads["home"] }) {
  const { t } = useI18n();
  const h = t.smartHome;
  const bad = p.items.filter((i) =>
    ["failed", "expired", "unavailable", "offline"].includes(i.status),
  );
  return (
    <div className="flex flex-col gap-2">
      {p.hub !== "online" && <p className="text-[12.5px] text-approval-text">{h.hub[p.hub]}</p>}
      <ul className="flex flex-col gap-1.5">
        {p.items.map((i) => {
          const failed = ["failed", "expired", "unavailable", "offline"].includes(i.status);
          return (
            <li key={i.deviceId} className="flex items-center gap-2.5 text-[13.5px]">
              <DeviceIcon type={i.type} className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">
                {i.name}
                {i.room && <span className="text-faint"> · {i.room}</span>}
              </span>
              <span
                className={cn("shrink-0 text-[12.5px]", failed ? "text-danger-text" : "text-muted")}
              >
                {failed || i.status === "pending"
                  ? h.statuses[i.status as keyof typeof h.statuses]
                  : i.detail}
              </span>
            </li>
          );
        })}
      </ul>
      {p.items.length > 1 && (
        <p className="text-[12px] text-faint">
          {p.items.length - bad.length}/{p.items.length}
        </p>
      )}
      <Link
        href="/my-elise/home"
        className="self-start text-[12.5px] text-accent-text hover:underline"
      >
        {h.title}
      </Link>
    </div>
  );
}

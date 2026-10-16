"use client";

import { OverflowMenu } from "@/components/ui/sheet-menu";
import { cn } from "@/lib/utils";

/** Small pieces shared by the My Elise workspaces (Habits, Goals). */

export function IconTile({
  icon,
  size = "md",
}: {
  icon: string | null;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-surface-2",
        size === "sm" && "size-7 text-[15px]",
        size === "md" && "size-9 text-[18px]",
        size === "lg" && "size-12 text-[24px]",
      )}
    >
      {icon ?? <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  );
}

export function Bar({ value, flag = false }: { value: number | null; flag?: boolean }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300",
          flag ? "bg-approval" : "bg-accent",
        )}
        style={{ width: `${Math.round((value ?? 0) * 100)}%` }}
      />
    </span>
  );
}

/** "⋯" for secondary actions: anchored menu from `md`, action sheet on phones (ADR-066). */
export function Menu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onClick: () => void; danger?: boolean }[];
}) {
  return <OverflowMenu label={label} items={items} />;
}

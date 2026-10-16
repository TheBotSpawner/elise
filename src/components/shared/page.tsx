import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PageInfo } from "./page-info";

export function PageHeader({
  title,
  subtitle,
  actions,
  icon: Icon,
  info,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** The section's navigation icon, shown subtly before the title (Finance). */
  icon?: LucideIcon;
  /** What the section is, behind a small ⓘ next to the title (instead of a subtitle). */
  info?: string[];
}) {
  return (
    // Phones (ADR-066): a compact title, actions on the same row — content starts sooner.
    <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 md:mb-6 md:items-end">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h1 className="flex items-center gap-2.5 text-[26px] leading-[1.15] font-light tracking-[-0.025em] md:gap-3 md:text-[30px]">
            {Icon && (
              <Icon
                className="size-5 shrink-0 text-muted md:size-6"
                strokeWidth={1.6}
                aria-hidden
              />
            )}
            {title}
          </h1>
          {info && <PageInfo title={title} body={info} />}
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}

/** `wide`: data-dense workspaces (Habits, Finance) use the screen; forms and settings don't. */
export function PageContainer({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`mx-auto w-full ${wide ? "max-w-[1440px]" : "max-w-[960px]"} px-[var(--page-gutter)] pt-4 pb-10 md:pt-10 md:pb-16`}
    >
      {children}
    </div>
  );
}

/** Every empty screen explains what to do next (docs/product/04 §30). */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
        <Icon className="size-5" aria-hidden />
      </span>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

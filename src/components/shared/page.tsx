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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="flex items-center gap-3 text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            {Icon && <Icon className="size-6 shrink-0 text-muted" strokeWidth={1.6} aria-hidden />}
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
      className={`mx-auto w-full ${wide ? "max-w-[1440px]" : "max-w-[960px]"} px-4 pt-6 pb-16 md:px-10 md:pt-10`}
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

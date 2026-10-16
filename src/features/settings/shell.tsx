"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";

import { InfoTip } from "@/components/shared/info-tip";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  searchSettings,
  sectionHref,
  sectionOf,
  type SettingsSectionId,
} from "./registry";

/**
 * Settings shell (ADR-068). From `md`: a sticky sidebar (back to ELISE, search, the categories)
 * beside the selected section, at a comfortable reading width. On phones the sidebar is gone:
 * /settings is a list of categories and each one is a full-width screen with Back.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  // /settings on a wide screen shows General.
  const active = sectionOf(pathname) ?? "general";
  return (
    <div className="mx-auto w-full max-w-[1180px] px-[var(--page-gutter)] pt-4 pb-10 md:grid md:grid-cols-[232px_minmax(0,1fr)] md:gap-10 md:pt-8 md:pb-16 lg:gap-14">
      <aside className="max-md:hidden">
        <div className="sticky top-24 flex max-h-[calc(100dvh-7rem)] flex-col gap-4 overflow-y-auto pb-4">
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-2 self-start rounded-full px-2 text-[13.5px] text-muted hover:text-fg"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t.settingsHub.back}
          </Link>
          <SettingsSearch />
          <SectionNav active={active} />
        </div>
      </aside>
      <div className="min-w-0">
        <div className="mx-auto w-full max-w-[760px]">{children}</div>
      </div>
    </div>
  );
}

function SectionNav({ active }: { active: SettingsSectionId }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t.settingsHub.backToSettings} className="flex flex-col gap-4">
      {SETTINGS_GROUPS.map((group) => (
        <div key={group} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1 type-label text-faint">{t.settingsHub.groups[group]}</p>
          {SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => (
            <Link
              key={s.id}
              href={sectionHref(s.id)}
              aria-current={active === s.id ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-xl px-3 text-[14px] transition-colors",
                active === s.id
                  ? "bg-active font-medium text-fg"
                  : "text-muted hover:bg-active/60 hover:text-fg",
              )}
            >
              <s.icon
                className={cn("size-4 shrink-0", active === s.id && "text-accent-text")}
                strokeWidth={1.7}
                aria-hidden
              />
              {t.settingsHub.sections[s.id].title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Local search over the registry; Enter opens the first result. */
export function SettingsSearch({ className }: { className?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const listId = useId();
  const hits = searchSettings(t, query);
  const go = (href: string) => {
    setQuery("");
    router.push(href);
  };
  return (
    <div className={cn("relative", className)}>
      <label className="relative block">
        <span className="sr-only">{t.settingsHub.search}</span>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
        />
        <input
          type="search"
          value={query}
          role="combobox"
          aria-expanded={Boolean(query)}
          aria-controls={listId}
          placeholder={t.settingsHub.search}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) go(hits[0].href);
            if (e.key === "Escape") setQuery("");
          }}
          className="h-10 w-full rounded-full border border-border bg-surface pr-3 pl-9 text-[14px] placeholder:text-faint focus:border-accent focus:outline-none md:h-9 md:text-[13.5px]"
        />
      </label>
      {query && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t.settingsHub.search}
          className="absolute top-full right-0 left-0 z-30 mt-1 flex flex-col rounded-2xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
        >
          {hits.length ? (
            hits.map((h) => (
              <li key={h.href} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => go(h.href)}
                  className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span className="text-[13.5px]">{h.label}</span>
                  {h.sectionLabel && (
                    <span className="text-[12px] text-faint">{h.sectionLabel}</span>
                  )}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-[13px] text-muted">{t.settingsHub.noResults}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Phones: /settings is the list of categories (from `md` the sidebar replaces it). */
export function SettingsIndex() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5 md:hidden">
      <h1 className="text-[26px] leading-[1.15] font-light tracking-[-0.025em]">
        {t.settings.title}
      </h1>
      <SettingsSearch />
      {SETTINGS_GROUPS.map((group) => (
        <section key={group} className="flex flex-col gap-1.5">
          <h2 className="px-1 type-label text-faint">{t.settingsHub.groups[group]}</h2>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => (
              <li key={s.id}>
                <Link
                  href={sectionHref(s.id)}
                  className="flex min-h-14 items-center gap-3 px-4 py-2.5 active:bg-active"
                >
                  <s.icon
                    className="size-[18px] shrink-0 text-muted"
                    strokeWidth={1.7}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px]">{t.settingsHub.sections[s.id].title}</span>
                    <span className="block truncate text-[13px] text-faint">
                      {t.settingsHub.sections[s.id].hint}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * One section's page: on phones a Back row to the categories; then its title (with an ⓘ when
 * it needs explaining) and its content.
 */
export function SettingsPage({
  section,
  info,
  back,
  title,
  children,
}: {
  section: SettingsSectionId;
  info?: string[];
  /** A drill-down's parent (Storage › Images); default: the categories (phones only). */
  back?: { href: string; label: string };
  title?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const name = title ?? t.settingsHub.sections[section].title;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={back?.href ?? "/settings"}
          className={cn(
            "-ml-2 inline-flex h-10 items-center gap-1 self-start rounded-full px-2 text-[14px] text-muted hover:text-fg",
            !back && "md:hidden",
          )}
        >
          <ChevronLeft className="size-4" aria-hidden />
          {back?.label ?? t.settingsHub.backToSettings}
        </Link>
        <div className="flex items-center gap-1.5">
          <h1 className="text-[26px] leading-[1.15] font-light tracking-[-0.025em] md:text-[30px]">
            {name}
          </h1>
          {info && (
            <InfoTip label={t.common.aboutSection(name)} title={name} body={info} size="lg" />
          )}
        </div>
      </header>
      {children}
    </div>
  );
}

/** A group of rows in one card. */
export function SettingsCard({
  title,
  info,
  children,
  className,
}: {
  title?: string;
  info?: string[];
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title && (
        <div className="flex items-center gap-1 px-1">
          <h2 className="type-label text-faint">{title}</h2>
          {info && <InfoTip label={t.common.aboutSection(title)} title={title} body={info} />}
        </div>
      )}
      <div className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: label and a one-line hint on the left, its control on the right (stacked under
 * it on phones when `stack`). `id` is the anchor search links to; it lights up when targeted.
 */
export function SettingRow({
  id,
  label,
  hint,
  info,
  stack = false,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  info?: string[];
  stack?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      id={id}
      className={cn(
        "settings-row flex scroll-mt-24 gap-3 px-4 py-3.5 md:px-5",
        stack ? "flex-col sm:flex-row sm:items-center" : "items-center",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="text-[14.5px]">{label}</p>
          {info && typeof label === "string" && (
            <InfoTip label={t.common.aboutSection(label)} title={label} body={info} />
          )}
        </div>
        {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      </div>
      {children && <div className={cn("shrink-0", stack && "max-sm:w-full")}>{children}</div>}
    </div>
  );
}

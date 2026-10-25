"use client";

import {
  AlertTriangle,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Car,
  ChartLine,
  Check,
  CircleDot,
  CircleHelp,
  Clock,
  Code,
  DollarSign,
  Dumbbell,
  ExternalLink,
  File,
  FileText,
  Globe,
  GraduationCap,
  Heart,
  House,
  Info,
  Leaf,
  Lightbulb,
  Link2,
  Mail,
  MapPin,
  Paperclip,
  Phone,
  Plane,
  Scale,
  Shield,
  Sparkles,
  Star,
  TrendingUp,
  User,
  Users,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { isSafeHref } from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import type { SummaryIcon } from "@/core/workspace/summary-icons";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Summary = SurfacePayloads["summary"];
type Kind = Summary["sections"][number]["kind"];

const ICONS: Record<SummaryIcon, LucideIcon> = {
  info: Info,
  check: Check,
  alert: AlertTriangle,
  star: Star,
  lightbulb: Lightbulb,
  scale: Scale,
  dumbbell: Dumbbell,
  heart: Heart,
  building: Building2,
  briefcase: Briefcase,
  users: Users,
  user: User,
  globe: Globe,
  "map-pin": MapPin,
  plane: Plane,
  home: House,
  calendar: Calendar,
  clock: Clock,
  money: DollarSign,
  chart: ChartLine,
  book: BookOpen,
  graduation: GraduationCap,
  code: Code,
  shield: Shield,
  leaf: Leaf,
  food: Utensils,
  car: Car,
  phone: Phone,
  mail: Mail,
  file: File,
  link: Link2,
  question: CircleHelp,
};

/** Each kind of section: its own icon and tint, so a glance tells facts from suggestions. */
const KIND: Record<Kind, { icon: LucideIcon; tone: Tone }> = {
  facts: { icon: Info, tone: "teal" },
  context: { icon: BookOpen, tone: "blue" },
  changes: { icon: TrendingUp, tone: "amber" },
  open_items: { icon: CircleDot, tone: "orange" },
  questions: { icon: CircleHelp, tone: "violet" },
  suggestions: { icon: Sparkles, tone: "accent" },
  material: { icon: Paperclip, tone: "slate" },
};

type Tone = "teal" | "blue" | "amber" | "orange" | "violet" | "accent" | "slate" | "green";
/** Item bubbles cycle through these so two options never look alike. */
const CYCLE: Tone[] = ["teal", "green", "blue", "violet", "amber", "orange"];
const TONE: Record<Tone, { bubble: string; number: string; line: string }> = {
  teal: {
    bubble: "bg-[color-mix(in_oklab,#0e9fb0_14%,transparent)] text-[#0b7f8c] dark:text-[#5fd3df]",
    number: "bg-[color-mix(in_oklab,#0e9fb0_16%,transparent)] text-[#0b7f8c] dark:text-[#5fd3df]",
    line: "#0e9fb0",
  },
  green: {
    bubble: "bg-[color-mix(in_oklab,#16a36a_14%,transparent)] text-[#127a51] dark:text-[#5fd39f]",
    number: "bg-[color-mix(in_oklab,#16a36a_16%,transparent)] text-[#127a51] dark:text-[#5fd39f]",
    line: "#16a36a",
  },
  blue: {
    bubble: "bg-[color-mix(in_oklab,#2f6fd6_14%,transparent)] text-[#2457a8] dark:text-[#8db4f2]",
    number: "bg-[color-mix(in_oklab,#2f6fd6_16%,transparent)] text-[#2457a8] dark:text-[#8db4f2]",
    line: "#2f6fd6",
  },
  violet: {
    bubble: "bg-[color-mix(in_oklab,#7c4dd6_14%,transparent)] text-[#5f37ad] dark:text-[#b89cf2]",
    number: "bg-[color-mix(in_oklab,#7c4dd6_16%,transparent)] text-[#5f37ad] dark:text-[#b89cf2]",
    line: "#7c4dd6",
  },
  amber: {
    bubble: "bg-[color-mix(in_oklab,#d69a1c_16%,transparent)] text-[#8f6410] dark:text-[#f0c766]",
    number: "bg-[color-mix(in_oklab,#d69a1c_18%,transparent)] text-[#8f6410] dark:text-[#f0c766]",
    line: "#d69a1c",
  },
  orange: {
    bubble: "bg-[color-mix(in_oklab,#e0662a_14%,transparent)] text-[#a84a1c] dark:text-[#f2a07a]",
    number: "bg-[color-mix(in_oklab,#e0662a_16%,transparent)] text-[#a84a1c] dark:text-[#f2a07a]",
    line: "#e0662a",
  },
  accent: {
    bubble: "bg-accent-soft text-accent-text",
    number: "bg-accent-soft text-accent-text",
    line: "var(--color-accent, #0e9fb0)",
  },
  slate: {
    bubble: "bg-surface-2 text-muted",
    number: "bg-surface-2 text-muted",
    line: "#8a97a3",
  },
};

const MD_LINK = /\[([^\]]{1,200})\]\((https:\/\/[^)\s]{1,2000})\)/g;
const BRACKETED_URL = /\[(https:\/\/[^\]\s]+)\](?!\()/g;
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

interface ParsedItem {
  title: string | null;
  text: string;
  links: { label: string; url: string }[];
}

/**
 * "International Association of Forensic Sciences: asociación profesional… [EBSCO](https://…)"
 * → a bold title, the text, and its sources as chips (never inline clutter).
 */
export function parseItem(raw: string): ParsedItem {
  const links: ParsedItem["links"] = [];
  let text = raw.replace(BRACKETED_URL, (_, u: string) => `[${host(u)}](${u})`);
  text = text
    .replace(MD_LINK, (_, label: string, url: string) => {
      if (isSafeHref(url) && !links.some((l) => l.url === url)) links.push({ label, url });
      return "";
    })
    .replace(/\s*\(\s*\)|\s*[·•]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s.,;:·-]+$/, (m) => (m.includes(".") ? "." : ""));
  const bold = /^\*\*(.{2,90}?)\*\*[:.\s—-]*\s*(.*)$/s.exec(text);
  if (bold) return { title: bold[1]!.trim(), text: bold[2]!.trim(), links };
  const colon = /^([^:]{2,90}):\s+(.{8,})$/s.exec(text);
  if (colon && !/https?$/i.test(colon[1]!))
    return { title: colon[1]!.trim(), text: colon[2]!.trim(), links };
  return { title: null, text, links };
}

/** **bold** inside a text, rendered (nothing else is markup). */
function rich(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]{1,120}\*\*)/g).map((part, i) =>
    /^\*\*[^*]+\*\*$/.test(part) ? (
      <strong key={i} className="font-semibold text-fg">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * ELISE's summary card (ADR-013): a clear title with its tag and one-line lead; each point a card
 * with its icon, number, bold title, text and source chips; sections told apart by color; two
 * columns when there is room. Two to four labeled options also get a small concept map.
 */
export function SummaryCard({ p, title, large }: { p: Summary; title: string; large: boolean }) {
  const { t } = useI18n();
  const parsed = p.sections.map((s) => ({ ...s, parsed: s.items.map(parseItem) }));
  const sources = new Set(
    parsed.flatMap((s) => s.parsed.flatMap((i) => i.links.map((l) => l.url))),
  );
  // One section of 2–4 titled options ("IAFS" can mean…): the concept map shows how they relate.
  const options =
    parsed.length === 1 &&
    parsed[0]!.parsed.length >= 2 &&
    parsed[0]!.parsed.length <= 4 &&
    parsed[0]!.parsed.every((i) => i.title)
      ? parsed[0]!
      : null;
  const facts = p.facts ?? [];
  const map = Boolean(options && large && title.length <= 24 && !facts.length);
  const side = map || facts.length > 0;
  return (
    <div className="flex flex-col gap-4">
      {(title || p.badge || p.lead) && (
        <header className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            {title && (
              <h2 className="text-[22px] leading-tight font-semibold tracking-tight text-fg">
                {title}
              </h2>
            )}
            {p.badge && (
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12.5px] font-medium text-accent-text">
                {p.badge}
              </span>
            )}
          </div>
          {p.lead && <p className="text-[14px] text-muted">{p.lead}</p>}
          {p.tags && p.tags.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {p.tags.map((tag, i) => {
                const Icon = tag.icon ? ICONS[tag.icon] : null;
                return (
                  <li
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent-line/50 bg-accent-soft/40 px-3 py-1 text-[12.5px] text-accent-text"
                  >
                    {Icon && <Icon className="size-3.5" aria-hidden />}
                    {tag.label}
                  </li>
                );
              })}
            </ul>
          )}
        </header>
      )}
      <div className={cn("grid gap-5", side && "lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.7fr)]")}>
        <div className="flex min-w-0 flex-col gap-5">
          {parsed.map((s, si) => {
            const kind = KIND[s.kind];
            const KindIcon = kind.icon;
            const numbered = s.parsed.length > 1 && s.kind !== "suggestions";
            return (
              <section key={`${s.kind}-${si}`} className="flex flex-col gap-2.5">
                {(parsed.length > 1 || !p.lead) && (
                  <h3 className="flex items-center gap-2 text-[12px] font-medium tracking-[0.08em] text-muted uppercase">
                    <span
                      className={cn(
                        "grid size-5 place-items-center rounded-md",
                        TONE[kind.tone].bubble,
                      )}
                    >
                      <KindIcon className="size-3" aria-hidden />
                    </span>
                    {s.heading || t.workspace.summaryKinds[s.kind]}
                  </h3>
                )}
                <ul
                  className={cn(
                    "grid gap-2.5",
                    !side && large && s.parsed.length > 1 && "md:grid-cols-2",
                  )}
                >
                  {s.parsed.map((item, i) => {
                    const tone =
                      TONE[
                        s.kind === "facts" || s.kind === "context"
                          ? CYCLE[i % CYCLE.length]!
                          : kind.tone
                      ];
                    const Icon = (s.icons?.[i] && ICONS[s.icons[i]!]) || KindIcon;
                    return (
                      <li
                        key={i}
                        className={cn(
                          "flex gap-3 rounded-2xl border border-border bg-surface px-3.5 py-3",
                          s.kind === "suggestions" && "border-accent-line/60 bg-accent-soft/20",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-10 shrink-0 place-items-center rounded-full",
                            tone.bubble,
                          )}
                        >
                          <Icon className="size-[18px]" />
                        </span>
                        <div className="flex min-w-0 flex-col gap-1">
                          {(item.title || numbered) && (
                            <p className="flex items-start gap-2 text-[14.5px] leading-snug font-semibold text-fg">
                              {numbered && (
                                <span
                                  className={cn(
                                    "mt-px grid h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 text-[11.5px] font-semibold tabular-nums",
                                    tone.number,
                                  )}
                                >
                                  {i + 1}
                                </span>
                              )}
                              {item.title && <span className="min-w-0">{rich(item.title)}</span>}
                            </p>
                          )}
                          {item.text && (
                            <p className="text-[13.5px] leading-relaxed text-fg2">
                              {rich(item.text)}
                            </p>
                          )}
                          {item.links.length > 0 && (
                            <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                              {item.links.map((l) => (
                                <a
                                  key={l.url}
                                  href={l.url}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className="inline-flex items-center gap-1 text-[12.5px] text-accent-text hover:underline"
                                >
                                  <ExternalLink className="size-3" aria-hidden />
                                  {l.label}
                                </a>
                              ))}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
        {map && options && <ConceptMap title={title} section={options} />}
        {facts.length > 0 && (
          <dl className="flex flex-col gap-2 self-start rounded-3xl bg-surface-2/50 p-2.5">
            {facts.map((f, i) => {
              const Icon = f.icon ? ICONS[f.icon] : Info;
              return (
                <div key={i} className="flex items-center gap-3 rounded-2xl bg-surface px-3 py-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full",
                      TONE[CYCLE[i % CYCLE.length]!].bubble,
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-[11.5px] text-muted">{f.label}</dt>
                    <dd className="text-[14px] leading-snug font-semibold [overflow-wrap:anywhere] text-fg">
                      {f.value}
                    </dd>
                  </div>
                </div>
              );
            })}
          </dl>
        )}
      </div>
      {sources.size > 0 && (
        <footer className="flex items-center gap-2 border-t border-border pt-3 text-[12.5px] text-muted">
          <FileText className="size-3.5" aria-hidden />
          {t.workspace.summarySources(sources.size)}
        </footer>
      )}
    </div>
  );
}

/** The subject in the middle, its options around it, each with its icon and color. */
function ConceptMap({
  title,
  section,
}: {
  title: string;
  section: { kind: Kind; icons?: SummaryIcon[]; parsed: ParsedItem[] };
}) {
  const n = section.parsed.length;
  return (
    <div
      aria-hidden
      className="relative flex flex-col items-center gap-0 rounded-3xl bg-surface-2/50 px-4 pt-6 pb-5"
    >
      <span className="grid size-24 place-items-center rounded-full border-2 border-accent bg-surface px-2 text-center text-[17px] leading-tight font-bold text-fg shadow-[0_0_0_8px_color-mix(in_oklab,var(--color-accent,#0e9fb0)_10%,transparent)]">
        {title}
      </span>
      <svg viewBox={`0 0 ${n * 100} 44`} className="h-11 w-full" preserveAspectRatio="none">
        {section.parsed.map((_, i) => {
          const x = i * 100 + 50;
          const tone = TONE[CYCLE[i % CYCLE.length]!];
          return (
            <g key={i}>
              <path
                d={`M ${(n * 100) / 2} 0 V 16 Q ${(n * 100) / 2} 22 ${(n * 100) / 2 + (x > (n * 100) / 2 ? 6 : x < (n * 100) / 2 ? -6 : 0)} 22 H ${x + (x > (n * 100) / 2 ? -6 : 6)} Q ${x} 22 ${x} 28 V 40`}
                fill="none"
                stroke={tone.line}
                strokeWidth="1.6"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={x} cy={40} r="3" fill={tone.line} />
            </g>
          );
        })}
      </svg>
      <div
        className="grid w-full gap-2"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {section.parsed.map((item, i) => {
          const tone = TONE[CYCLE[i % CYCLE.length]!];
          const Icon = (section.icons?.[i] && ICONS[section.icons[i]!]) || KIND[section.kind].icon;
          return (
            <div
              key={i}
              className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface px-2 py-3 text-center"
            >
              <span className={cn("grid size-9 place-items-center rounded-full", tone.bubble)}>
                <Icon className="size-4" />
              </span>
              <span className="line-clamp-3 text-[12.5px] leading-tight font-semibold text-fg">
                {item.title}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

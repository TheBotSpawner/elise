import {
  BookOpenCheck,
  CheckSquare,
  Target,
  ListChecks,
  Repeat,
  StickyNote,
  Timer,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { CapabilityKey } from "@/core/capabilities/types";

export type SectionKey = "home" | "chat" | "knowledge" | "connections" | "schedules";

/**
 * Primary sections, in reference order. Native modules live under My Elise (docs/product/04
 * §6-7). "chat" is labeled History: Home is where you talk to ELISE; this lists past
 * conversations (the route stays /chat).
 */
export const SECTIONS: { key: SectionKey; href: string }[] = [
  { key: "home", href: "/" },
  { key: "chat", href: "/chat" },
  { key: "knowledge", href: "/knowledge" },
  { key: "connections", href: "/connections" },
  { key: "schedules", href: "/schedules" },
];

/**
 * The one icon per My Elise module: the menu, the My Elise page and every module's page header
 * use this mapping, so a module looks the same wherever it appears.
 */
export const MY_ELISE_ICONS = {
  tasks: CheckSquare,
  habits: Repeat,
  lists: ListChecks,
  goals: Target,
  notes: StickyNote,
  finance: Wallet,
  shortcuts: Zap,
  methods: BookOpenCheck,
  time: Timer,
} as const satisfies Partial<Record<CapabilityKey, LucideIcon>>;

export type MyEliseModule = keyof typeof MY_ELISE_ICONS;

/** The modules in the My Elise menu, in order. */
export const MY_ELISE: { key: MyEliseModule; href: string | null; icon: LucideIcon }[] = (
  ["tasks", "habits", "lists", "goals", "notes", "finance", "shortcuts"] as const
).map((key) => ({ key, href: `/my-elise/${key}`, icon: MY_ELISE_ICONS[key] }));

export type ActiveSection = SectionKey | "myElise" | "settings" | "approvals" | null;

export function activeSection(pathname: string): ActiveSection {
  // A conversation is the interaction in use, so Home (ADR-032); History is the archive.
  if (pathname === "/" || /^\/chat\/[^/]+/.test(pathname)) return "home";
  if (pathname.startsWith("/my-elise")) return "myElise";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/approvals")) return "approvals";
  return SECTIONS.find((s) => s.href !== "/" && pathname.startsWith(s.href))?.key ?? null;
}

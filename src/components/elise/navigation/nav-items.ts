import {
  CheckSquare,
  Compass,
  Target,
  ListChecks,
  Repeat,
  StickyNote,
  Wallet,
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

/** Monochrome icons, the same ones as the My Elise page. */
export const MY_ELISE: { key: CapabilityKey; href: string | null; icon: LucideIcon }[] = [
  { key: "tasks", href: "/my-elise/tasks", icon: CheckSquare },
  { key: "habits", href: "/my-elise/habits", icon: Repeat },
  { key: "lists", href: "/my-elise/lists", icon: ListChecks },
  { key: "goals", href: "/my-elise/goals", icon: Target },
  { key: "notes", href: "/my-elise/notes", icon: StickyNote },
  { key: "finance", href: "/my-elise/finance", icon: Wallet },
  { key: "contexts", href: "/my-elise/contexts", icon: Compass },
];

export type ActiveSection = SectionKey | "myElise" | "settings" | "approvals" | null;

export function activeSection(pathname: string): ActiveSection {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/my-elise")) return "myElise";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/approvals")) return "approvals";
  return SECTIONS.find((s) => s.href !== "/" && pathname.startsWith(s.href))?.key ?? null;
}

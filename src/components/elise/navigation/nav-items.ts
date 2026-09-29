import type { CapabilityKey } from "@/core/capabilities/types";

export type SectionKey = "home" | "chat" | "knowledge" | "connections" | "schedules";

/** Primary sections, in reference order. Native modules live under My Elise (docs/product/04 §6-7). */
export const SECTIONS: { key: SectionKey; href: string }[] = [
  { key: "home", href: "/" },
  { key: "chat", href: "/chat" },
  { key: "knowledge", href: "/knowledge" },
  { key: "connections", href: "/connections" },
  { key: "schedules", href: "/schedules" },
];

export const MY_ELISE: { key: CapabilityKey; href: string | null }[] = [
  { key: "tasks", href: "/my-elise/tasks" },
  { key: "habits", href: null },
  { key: "lists", href: null },
  { key: "finance", href: null },
  { key: "goals", href: null },
  { key: "notes", href: null },
];

export type ActiveSection = SectionKey | "myElise" | "settings" | "approvals" | null;

export function activeSection(pathname: string): ActiveSection {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/my-elise")) return "myElise";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/approvals")) return "approvals";
  return SECTIONS.find((s) => s.href !== "/" && pathname.startsWith(s.href))?.key ?? null;
}

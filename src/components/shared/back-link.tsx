import { ChevronLeft } from "lucide-react";
import Link from "next/link";

/** "‹ Conocimiento": a compact back control naming where it goes (the whole thing is the link). */
export function BackLink({
  href,
  label,
  ariaLabel,
}: {
  href: string;
  label: string;
  /** "Volver a Conocimiento". */
  ariaLabel: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="-ml-1.5 flex w-fit max-w-full items-center gap-1 rounded-full py-1 pr-2.5 pl-1 text-[13px] text-muted transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <ChevronLeft className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}

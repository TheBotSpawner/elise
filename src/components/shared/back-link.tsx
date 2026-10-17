import { ChevronLeft } from "lucide-react";
import Link from "next/link";

/**
 * "‹ Volver a Importar": the one back control for child pages, naming where it goes; the whole
 * row is the link. Only for navigation back to a parent — never on a plain heading.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-ml-1.5 flex min-h-11 w-fit max-w-full items-center gap-1 rounded-full py-1 pr-2.5 pl-1 text-[14px] text-muted transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none md:min-h-0 md:text-[13px]"
    >
      <ChevronLeft className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}

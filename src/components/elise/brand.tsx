import { cn } from "@/lib/utils";

/**
 * The ELISE logo (ADR-136): the flat "Open Core" symbol, two crescents and a core, in its geometry
 * for 24–64 px, and the wordmark. Decorative: the link around them names ELISE.
 */
export function BrandSymbol({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      aria-hidden
      className={cn("shrink-0 text-[#0A6573] dark:text-[#22D3EE]", className)}
    >
      <path fill="currentColor" d="M9.5 67.1A51 51 0 0 1 88.52 17.72A88.5 88.5 0 0 0 9.5 67.1Z" />
      <path
        fill="currentColor"
        d="M110.5 52.9A51 51 0 0 1 31.48 102.28A88.5 88.5 0 0 0 110.5 52.9Z"
      />
      <circle cx="60" cy="60" r="11.5" className="fill-[#22D3EE] dark:fill-[#9EF6FD]" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 502 108" aria-hidden className={cn("w-auto shrink-0", className)}>
      <g transform="translate(4 4)" fill="none" stroke="currentColor" strokeWidth="8">
        <path d="M74 4H4V96H74M4 50H66" />
        <path transform="translate(122 0)" d="M4 0V96H66" />
        <path transform="translate(236 0)" d="M4 0V100" />
        <path
          transform="translate(292 0)"
          d="M76 4H20A16 16 0 0 0 4 20V34A16 16 0 0 0 20 50H60A16 16 0 0 1 76 66V80A16 16 0 0 1 60 96H0"
        />
        <path transform="translate(420 0)" d="M74 4H4V96H74M4 50H66" />
      </g>
    </svg>
  );
}

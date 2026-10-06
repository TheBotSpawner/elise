import { GoogleMark, NotionIcon, SpotifyIcon, YouTubeIcon } from "@/components/elise/brand-icons";
import { cn } from "@/lib/utils";

const MARKS: Record<string, (p: { size: number }) => React.ReactNode> = {
  google: ({ size }) => <GoogleMark size={size} />,
  notion: ({ size }) => <NotionIcon size={size} />,
  spotify: ({ size }) => <SpotifyIcon size={size} />,
  youtube: ({ size }) => <YouTubeIcon size={size} />,
};

/**
 * A provider's mark in a quiet tile. Providers without a mark yet get a monogram, so a new
 * provider slots in with no design work. Named for assistive technology by `label`.
 */
export function ProviderIcon({
  id,
  name,
  size = 40,
  label = false,
}: {
  id: string;
  name: string;
  size?: number;
  /** Announce the provider's name (when the icon stands alone). */
  label?: boolean;
}) {
  const Mark = MARKS[id];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label ? name : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("grid shrink-0 place-items-center rounded-xl border border-border bg-bg")}
      style={{ width: size, height: size }}
    >
      {Mark ? (
        Mark({ size: Math.round(size * 0.55) })
      ) : id === "elise_native" ? (
        <span className="size-2.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
      ) : (
        <span className="text-[13px] font-medium text-muted">{name.slice(0, 2)}</span>
      )}
    </span>
  );
}

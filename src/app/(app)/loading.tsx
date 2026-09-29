export default function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center py-24" role="status" aria-live="polite">
      <span className="size-3 animate-ping rounded-full bg-accent" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

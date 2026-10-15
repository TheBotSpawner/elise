import { permanentRedirect } from "next/navigation";

/** Shortcuts moved to Settings (ADR-064): old links and bookmarks keep working. */
export default function ShortcutsMoved() {
  permanentRedirect("/settings/shortcuts");
}

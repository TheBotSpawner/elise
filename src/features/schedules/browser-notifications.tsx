"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createClient } from "@/infrastructure/supabase/client";
import { useI18n } from "@/lib/i18n/client";

const supported = () => typeof window !== "undefined" && "Notification" in window;
const noop = () => () => undefined;

function usePermission(): [NotificationPermission | "unsupported", () => Promise<void>] {
  const initial = useSyncExternalStore(
    noop,
    () => (supported() ? Notification.permission : "unsupported"),
    () => "default" as const,
  );
  const [asked, setAsked] = useState<NotificationPermission | null>(null);
  return [
    asked ?? initial,
    async () => {
      if (supported()) setAsked(await Notification.requestPermission());
    },
  ];
}

/** Asked only in context (when the user picks browser notifications), never on load. */
export function BrowserNotificationsPrompt() {
  const { t } = useI18n();
  const [permission, request] = usePermission();
  if (permission === "granted" || permission === "unsupported") return null;
  if (permission === "denied")
    return <p className="text-[13px] text-approval-text">{t.schedules.browserBlocked}</p>;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5">
      <p className="text-[13px] text-muted">{t.schedules.browserHint}</p>
      <Button size="sm" variant="secondary" onClick={() => void request()}>
        {t.schedules.enableBrowser}
      </Button>
    </div>
  );
}

/**
 * Tells the user a scheduled result is ready while ELISE is open: a quiet toast, plus a
 * browser notification when that Schedule asked for one and permission was granted.
 * Previews never include content ("Morning Brief ready", not what the emails say).
 */
export function ResultNotifier({ userId }: { userId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const labels = useRef(t);
  useEffect(() => {
    labels.current = t;
  });

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const n = payload.new as {
            id: string;
            notification_type: string;
            action_url: string | null;
            metadata: { browser?: boolean } | null;
          };
          if (n.notification_type !== "schedule.result_ready" || !n.action_url) return;
          const url = n.action_url;
          const title = labels.current.brief.ready;
          toast(title, {
            action: { label: labels.current.brief.view, onClick: () => router.push(url) },
          });
          if (n.metadata?.browser && supported() && Notification.permission === "granted") {
            // Same tag in every open tab: the browser shows it once.
            const shown = new Notification(title, { tag: n.id });
            shown.onclick = () => {
              window.focus();
              router.push(url);
            };
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, router]);

  return null;
}

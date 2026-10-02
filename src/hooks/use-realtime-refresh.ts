"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { createClient } from "@/infrastructure/supabase/client";

type RealtimeTable =
  | "tasks"
  | "task_lists"
  | "approvals"
  | "notifications"
  | "schedules"
  | "schedule_runs"
  | "scheduled_results"
  | "knowledge_spaces"
  | "knowledge_sources"
  | "knowledge_items"
  | "knowledge_sync_runs"
  | "habits"
  | "habit_entries"
  | "goals"
  | "goal_links"
  | "lists"
  | "list_items"
  | "notes"
  | "finance_transactions"
  | "finance_accounts"
  | "finance_categories"
  | "finance_sources"
  | "imports"
  | "structured_sources"
  | "live_workspaces";

/**
 * Subscribes to workspace-scoped row changes (RLS still applies server-side) and calls
 * `onChange`, or refreshes the current route's server data by default. Changes made through
 * Chat, another tab or another device appear without a manual reload.
 */
export function useRealtimeRefresh(
  workspaceId: string,
  tables: readonly RealtimeTable[],
  onChange?: () => void,
) {
  const router = useRouter();
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  });

  const key = tables.join(",");
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (callback.current ? callback.current() : router.refresh()), 150);
    };

    const channel = supabase.channel(`ws:${workspaceId}:${key}`);
    for (const table of key.split(",") as RealtimeTable[]) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `workspace_id=eq.${workspaceId}` },
        fire,
      );
    }
    // Realtime is a hint, not the source of truth: events missed while the channel was down
    // (sleep, network loss, a hidden tab) are reconciled by re-reading the server's state when
    // the channel comes back, the tab is shown again or the network returns.
    let dropped = false;
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && dropped) fire();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
        dropped = true;
    });
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) fire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", fire);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", fire);
      void supabase.removeChannel(channel);
    };
  }, [workspaceId, key, router]);
}

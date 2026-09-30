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
  | "notes";

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
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [workspaceId, key, router]);
}

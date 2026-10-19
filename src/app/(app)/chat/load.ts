import { after } from "next/server";

import { autoLinkThread } from "@/application/history-links-service";
import { historyRows } from "@/application/history-service";
import type { HistoryFilter } from "@/core/history/links";
import type { HistoryParams } from "@/features/history/history-controls";

import type { RouteLoader } from "../route-contract";

const UUID = /^[0-9a-f-]{36}$/i;

export const load = (async (auth, { search: raw }) => {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const params: HistoryParams = {
    q: str(raw.q).trim().slice(0, 200),
    space: str(raw.space) === "untagged" || UUID.test(str(raw.space)) ? str(raw.space) : null,
    section: UUID.test(str(raw.section)) ? str(raw.section) : null,
    // Folders (Space › Section) are the default; a flat list or Section groups are a choice.
    group:
      str(raw.group) === "none" || str(raw.group) === "section"
        ? (str(raw.group) as "none" | "section")
        : "space",
    sort: str(raw.sort) === "oldest" ? "oldest" : "newest",
    archived: str(raw.view) === "archived",
  };
  const filter: HistoryFilter =
    params.space === "untagged"
      ? { kind: "untagged" }
      : params.space
        ? { kind: "space", spaceId: params.space, sectionId: params.section }
        : { kind: "all" };
  const { rows, nodes, untaggedRecent } = await historyRows(auth, {
    q: params.q,
    filter,
    sort: params.sort,
    archived: params.archived,
  });
  // Never delays the page: tags appear on the next visit.
  if (untaggedRecent.length)
    after(() => Promise.all(untaggedRecent.map((t) => autoLinkThread(auth, t))));
  // "Hace 2 horas" is relative to when the list was read: the same text on server and client.
  return {
    params,
    filter,
    rows,
    nodes,
    timezone: auth.profile.timezone,
    now: new Date().toISOString(),
  };
}) satisfies RouteLoader<unknown>;

export type ChatHistoryProps = Awaited<ReturnType<typeof load>>;

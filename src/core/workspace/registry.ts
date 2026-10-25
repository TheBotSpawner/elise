import { z } from "zod";

import { PERSONALITIES } from "../personality";
import { CALENDAR_VIEWS, MAX_CALENDAR_EVENTS } from "./calendar";
import { mapPayload, placePayload, type MapPayload } from "./location";
import { mediaPayload } from "./media";
import {
  ACTION_IDS,
  INTENT_KINDS,
  isSafeHref,
  SURFACE_SIZES,
  SURFACE_STATES,
  SURFACE_TYPES,
  emptyWorkspace,
  isOpen,
  type ActionId,
  type Surface,
  type SurfaceAction,
  type SurfaceSize,
  type SurfaceType,
  type WorkspaceState,
} from "./model";
import { musicPayload } from "./music";
import { SUMMARY_ICONS } from "./summary-icons";
import { clockPayload, timerFromPayload, timerPayload, type TimerPayload } from "./time";
import { visualizationSpec, type VisualizationSpec } from "./visualization";
import { weatherPayload, type WeatherPayload } from "./weather";
import { TASK_STATUSES } from "../capabilities/tasks";
import { TEAM_ACCESS } from "../capabilities/team-messaging";
import { CONTEXT_KINDS, LINK_TYPES } from "../contexts/model";
import { BLOCK_CATEGORIES } from "../planning/day-plan";
import { toLocalDateTime } from "../time";
import { clockText, currentPhase, elapsedMs, remainingMs } from "../timers/model";
import { imageGalleryPayload } from "../web/images";

/**
 * Surface registry (ADR-013), in the spirit of the capability registry: each type declares its
 * payload schema, sizes, actions, how it is described to the model and which tool its direct
 * actions call. The UI maps the same types to renderers; nothing here knows about React.
 */

const text = (max: number) => z.string().max(max);
const href = z.string().max(2000).refine(isSafeHref, "Only https: or internal links");
const address = z.object({ name: text(200).nullable(), email: text(320) });

const eventPayload = z.object({
  eventId: text(1000),
  title: text(300),
  start: text(40),
  end: text(40),
  allDay: z.boolean(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  location: text(500).nullable(),
  description: text(800).nullable(),
  calendarName: text(200),
  account: text(200),
  htmlUrl: href.nullable(),
  meetingUrl: href.nullable(),
  attendees: z
    .array(
      z.object({
        name: text(200).nullable(),
        email: text(320),
        response: z.enum(["accepted", "declined", "tentative", "needsAction"]).nullable(),
        organizer: z.boolean(),
        self: z.boolean(),
      }),
    )
    .max(25),
});

const emailItem = z.object({
  messageId: text(1000),
  threadId: text(1000),
  subject: text(300),
  from: address.nullable(),
  date: text(40),
  snippet: text(300),
  unread: z.boolean(),
  needsReply: z.boolean().optional(),
  account: text(200),
  /** Triage (ADR-067): how much attention it needs, and the one status worth showing. */
  priority: z.enum(["high", "medium", "normal"]).optional(),
  status: z.enum(["needs_reply", "urgent", "payment", "waiting"]).nullable().optional(),
});

/** The account a Communication Surface belongs to: the identity Connections shows. */
const mailbox = z.object({
  label: text(200),
  providerKey: text(40),
  address: text(320).nullable(),
});

const teamMessage = z.object({
  messageId: text(500),
  threadId: text(500).nullable(),
  channel: text(200),
  author: text(200),
  date: text(40),
  /** Third-party text, shown as text only; clipped. */
  text: text(800),
  replyCount: z.number().int().nullable(),
  url: href.nullable(),
  workspace: text(200),
});

const taskItem = z.object({
  id: text(1000),
  title: text(300),
  status: z.enum(TASK_STATUSES),
  dueDate: text(10).nullable(),
  priority: text(20).nullable(),
  source: text(200),
  listName: text(200).nullable(),
  /** ADR-050: the same task semantics as the Tasks workspace (optional: older Surfaces lack them). */
  labels: z.array(text(60)).max(10).optional(),
  subtask: z.boolean().optional(),
});

const passage = z.object({
  ref: z.number().int(),
  chunkId: text(100),
  section: text(300).nullable(),
  page: z.number().int().nullable(),
  excerpt: text(600),
});

/**
 * An answer-first Surface (ADR-071): a bounded presentation vocabulary — never markup or styles.
 * Every item points at the sources it came from (indexes into `sources`).
 */
export const ANSWER_INTENTS = [
  "list",
  "entities",
  "ranking",
  "comparison",
  "metrics",
  "checklist",
  "summary",
] as const;
export type AnswerIntent = (typeof ANSWER_INTENTS)[number];
const sourceRefs = z.array(z.number().int().min(0).max(11)).max(6);
const answerPayload = z.object({
  intent: z.enum(ANSWER_INTENTS),
  summary: text(400).optional(),
  items: z
    .array(
      z.object({
        title: text(160),
        description: text(300).optional(),
        badge: text(40).optional(),
        group: text(80).optional(),
        value: text(60).optional(),
        rank: z.number().int().min(1).max(500).optional(),
        /** Comparison: one value per column key. */
        cells: z.record(text(40), text(120)).optional(),
        sources: sourceRefs,
      }),
    )
    .max(50),
  columns: z
    .array(z.object({ key: text(40), label: text(60) }))
    .max(6)
    .optional(),
  metrics: z
    .array(
      z.object({
        label: text(60),
        value: text(40),
        secondary: text(80).optional(),
        sources: sourceRefs,
      }),
    )
    .max(8)
    .optional(),
  /** Provenance: what the answer came from (a Knowledge document, a page, a conversation). */
  sources: z
    .array(
      z.object({
        title: text(300),
        url: href.nullable(),
        kind: z.enum(["knowledge", "web", "recall", "other"]),
        space: text(200).optional(),
      }),
    )
    .max(12),
  /** How many there are in all, when only some are shown. */
  total: z.number().int().min(0).max(100_000).optional(),
});

/** Home devices as a command left them (ADR-079): names, a state line, no provider ids. */
export const homePayload = z.object({
  title: text(120),
  hub: z.enum(["online", "degraded", "offline"]),
  items: z
    .array(
      z.object({
        deviceId: z.uuid(),
        name: text(120),
        room: text(80).nullable(),
        type: z.enum([
          "light",
          "switch",
          "climate",
          "fan",
          "humidifier",
          "media_player",
          "sensor",
          "ir_controller",
        ]),
        status: z.enum([
          "state",
          "succeeded",
          "failed",
          "expired",
          "offline",
          "unavailable",
          "pending",
        ]),
        detail: text(120),
        updatedAt: text(40).nullable(),
      }),
    )
    .max(24),
});

/** A chat attachment analyzed by the Finance import pipeline (ADR-075): counts, never rows. */
export const financeImportPayload = z.object({
  importId: z.uuid(),
  label: text(300),
  rows: z.number().int().min(0),
  format: text(60).nullable(),
  dateRange: z.object({ from: text(10), to: text(10) }).nullable(),
  willImport: z.number().int().min(0),
  invalid: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  review: z.number().int().min(0),
  needs: z.array(text(40)).max(10),
  fileCurrency: z.boolean(),
  currency: text(3).nullable(),
  typeStrategy: z.enum(["column", "sign", "income", "expense"]).nullable(),
  accounts: z.array(z.object({ raw: text(120), name: text(120), how: text(20) })).max(6),
  creates: z.object({
    accounts: z.array(text(120)).max(30),
    categories: z.array(text(120)).max(30),
  }),
  sameFile: z.boolean(),
});

/** Public market data as Surfaces show it (ADR-074): every number from the provider or code. */
const nullableNumber = z.number().finite().nullable();
const marketQuote = z.object({
  symbol: text(20),
  name: text(200).nullable(),
  price: z.number().finite(),
  currency: text(8).nullable(),
  change: nullableNumber,
  changePercent: nullableNumber,
  open: nullableNumber,
  previousClose: nullableNumber,
  dayHigh: nullableNumber,
  dayLow: nullableNumber,
  volume: nullableNumber,
  asOf: text(40).nullable(),
  freshness: z.enum(["live", "delayed", "unknown"]),
});
export const marketPayload = z.object({
  mode: z.enum(["quote", "history", "watch"]),
  quotes: z.array(marketQuote).max(24),
  history: z
    .object({
      symbol: text(20),
      name: text(200).nullable(),
      currency: text(8).nullable(),
      period: text(20),
      points: z.array(z.object({ date: text(10), close: z.number().finite() })).max(420),
      change: z
        .object({
          from: text(10),
          to: text(10),
          start: z.number().finite(),
          end: z.number().finite(),
          change: z.number().finite(),
          changePercent: nullableNumber,
          high: z.number().finite(),
          low: z.number().finite(),
        })
        .nullable(),
    })
    .nullable(),
  /** Symbols that couldn't be read (plan, limits): shown honestly, never invented. */
  unavailable: z.array(text(20)).max(24).default([]),
  provider: text(40),
});

/**
 * Products to buy (ADR-112): a marketplace's offers, each saying how much is verified. A price
 * only from an authorized source (the official API); a search link is never a listing. Other
 * stores show in their own web_collection Surface — never mixed into this ranking (terms).
 */
export const productOffersPayload = z.object({
  query: text(300),
  marketplace: z.object({
    name: text(40),
    site: text(4),
    /** api: prices from the official API · search: listings a web search found (no prices). */
    method: z.enum(["api", "search", "link"]),
    searchUrl: href,
    offers: z
      .array(
        z.object({
          title: text(200),
          url: href,
          price: z.number().positive().nullable(),
          currency: text(3).nullable(),
          condition: z.enum(["new", "used"]).nullable(),
          match: z.enum(["exact", "related", "accessory"]),
          freeShipping: z.boolean().nullable(),
          installments: text(80).nullable(),
          seller: text(80).nullable(),
          image: href.nullable(),
          evidence: z.enum(["api", "search_result"]),
          checkedAt: text(40),
        }),
      )
      .max(8),
  }),
  maxPrice: z.number().positive().nullable(),
  currency: text(3).nullable(),
  notes: z.array(text(240)).max(5),
  /** The exact model asked for; without one, nothing is flagged as "not the model". */
  model: text(60).nullable().optional(),
});

/**
 * Supermarket prices (ADR-111): every amount computed by ELISE from public SEPA data, in cents,
 * with its province, date and how it was aggregated. Never a store-level quote, never a ranking
 * the data doesn't support.
 */
const cents = z.number().int().min(0).max(5_000_000_000);
const shoppingChainPrice = z.object({
  id: text(20),
  name: text(120),
  listCents: cents,
  minCents: cents,
  branches: z.number().int().min(1).max(10_000),
  perUnit: z.object({ cents, per: z.enum(["kg", "L", "u"]) }).nullable(),
  promoCents: cents.nullable(),
  promoLabel: text(120).nullable(),
  conditionalLabel: text(120).nullable(),
  quoteDate: text(10),
});
const shoppingProduct = z.object({
  ean: text(14),
  name: text(200),
  brand: text(80).nullable(),
  size: text(20).nullable(),
});
export const shoppingPayload = z.object({
  mode: z.enum(["product", "basket", "history", "resolution", "alerts"]),
  region: text(8),
  regionName: text(60),
  product: shoppingProduct.nullable(),
  chains: z.array(shoppingChainPrice).max(40),
  basket: z
    .object({
      listId: z.uuid().nullable(),
      listName: text(120).nullable(),
      requested: z.number().int().min(0).max(100),
      commonLines: z.number().int().min(0).max(100),
      chains: z
        .array(
          z.object({
            id: text(20),
            name: text(120),
            covered: z.number().int().min(0).max(100),
            availableCents: cents,
            commonCents: cents,
            full: z.boolean(),
          }),
        )
        .max(30),
      cheapestCommon: z
        .object({ chainId: text(20), savingsCents: cents, vsChainId: text(20) })
        .nullable(),
      lines: z
        .array(
          z.object({
            label: text(500),
            product: shoppingProduct.nullable(),
            quantity: z.number().int().min(1).max(99),
            status: z.enum(["priced", "unresolved", "no_price"]),
            common: z.boolean(),
            cheapestChainId: text(20).nullable(),
            prices: z
              .array(z.object({ chainId: text(20), unitCents: cents, lineCents: cents }))
              .max(30),
          }),
        )
        .max(100),
    })
    .nullable(),
  history: z
    .object({
      series: z
        .array(
          z.object({
            chain: text(120),
            points: z
              .array(z.object({ date: text(10), cents: cents.nullable(), observed: z.boolean() }))
              .max(400),
          }),
        )
        .max(8),
      change: z
        .object({
          chain: text(120),
          from: z.object({ date: text(10), cents }),
          to: z.object({ date: text(10), cents }),
          percent: z.number().finite(),
        })
        .nullable(),
    })
    .nullable(),
  candidates: z
    .array(
      shoppingProduct.extend({
        forLine: text(500).nullable(),
        extraVariant: z.array(text(40)).max(6),
        fromCents: cents.nullable(),
      }),
    )
    .max(15),
  alerts: z
    .array(
      z.object({
        product: text(200),
        thresholdCents: cents,
        region: text(60),
        state: z.enum(["armed", "triggered"]),
        lastBestCents: cents.nullable(),
        lastBestChain: text(120).nullable(),
        lastQuoteDate: text(10).nullable(),
        lastCheck: text(20).nullable(),
      }),
    )
    .max(20),
  /** The data's own day (YYYY-MM-DD) and its source, always shown. */
  date: text(10).nullable(),
  source: z.object({ name: text(80), url: href }),
  notes: z.array(text(240)).max(6),
});

/**
 * Public economic data as Surfaces show it (ADR-094): every number from the provider or code,
 * every figure dated, and its source to cite. Rows are typed by mode, never free HTML.
 */
const economyRow = z.object({
  /** A market, a bank, a holiday's name, a month, an indicator. */
  label: text(160),
  /** The figure's own date (a quote's ISO time, a day, a month "2026-09"). */
  date: text(40).nullable(),
  buy: nullableNumber,
  sell: nullableNumber,
  value: nullableNumber,
  /** Holiday kind, or "clients"/"non_clients" for a rate. */
  kind: text(20).nullable(),
});
export const economyPayload = z.object({
  mode: z.enum(["rates", "history", "inflation", "deposits", "indicators", "holidays"]),
  /** The one computed figure that answers (an accumulated rate, a change, a simulation). */
  headline: z
    .object({
      label: text(160),
      value: z.number().finite(),
      unit: z.enum(["ars", "usd", "percent", "points", "index"]),
      /** What it covers ("2026-04 → 2026-09"), or a date. */
      period: text(60).nullable(),
      /** True when a gap or an old copy means it isn't the whole picture. */
      partial: z.boolean(),
    })
    .nullable(),
  rows: z.array(economyRow).max(40),
  /** A series to draw (daily or monthly), oldest first. */
  series: z
    .array(z.object({ date: text(10), value: z.number().finite() }))
    .max(820)
    .nullable(),
  unit: z.enum(["ars", "usd", "percent", "points", "index"]),
  /** Short facts the reader needs (a missing month, "venta", a simulation's assumptions). */
  notes: z.array(text(240)).max(4),
  sources: z
    .array(
      z.object({
        name: text(60),
        original: text(60).nullable(),
        url: href,
        fetchedAt: text(40),
        stale: z.boolean(),
      }),
    )
    .min(1)
    .max(3),
});

const knowledgeSource = z.object({
  itemId: text(100),
  title: text(300),
  sourceType: text(40),
  spaceName: text(200),
  url: href.nullable(),
  passages: z.array(passage).max(4),
});

const change = z.object({
  setting: z.enum([
    "accent",
    "theme",
    "timezone",
    "language",
    "notifications",
    "schedule",
    "wake_phrase",
    "module",
    "continuous",
    "voice_language",
    "voice",
    "personality",
    "memory",
  ]),
  from: text(120).nullable(),
  to: text(120),
  subject: text(200).optional(),
});

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const calendarPayloadSchema = z.object({
  view: z.enum(CALENDAR_VIEWS),
  anchor: isoDay,
  range: z.object({ from: isoDay, to: isoDay }),
  timezone: text(60),
  events: z
    .array(
      z.object({
        id: text(1000),
        calendarId: text(1000),
        calendarName: text(200),
        account: text(200),
        title: text(300),
        start: text(40),
        end: text(40),
        allDay: z.boolean(),
        status: z.enum(["confirmed", "tentative", "cancelled"]),
        location: text(300).nullable(),
        description: text(400).nullable(),
        meetingUrl: href.nullable(),
        htmlUrl: href.nullable(),
        attendees: z.number().int().min(0),
        busy: z.boolean().optional(),
      }),
    )
    .max(MAX_CALENDAR_EVENTS * 2),
  hidden: z.array(text(1000)).max(50),
  free: z.array(z.object({ start: text(40), end: text(40) })).max(100),
  truncated: z.boolean(),
  loaded: z
    .array(z.object({ from: isoDay, to: isoDay }))
    .max(50)
    .optional(),
  scope: text(1000).optional(),
  summary: z
    .object({
      year: z.string().regex(/^\d{4}$/),
      counts: z.record(isoDay, z.number().int().min(0).max(1000)),
      complete: z.boolean(),
    })
    .refine((s) => Object.keys(s.counts).length <= 366)
    .optional(),
  seq: z.number().int().min(0).optional(),
});

const goalHabit = z.object({
  name: text(120),
  icon: text(16).nullable(),
  done: z.number(),
  goal: z.number(),
  drives: z.boolean(),
});

const goalRefPayload = z.object({ id: text(100), title: text(500), icon: text(16).nullable() });

/** One goal as Surfaces show it (ADR-055): every number computed by core/goals. */
const goalItem = z.object({
  id: text(100),
  title: text(300),
  icon: text(16).nullable(),
  status: z.enum(["active", "completed", "paused", "cancelled", "archived"]),
  health: z.enum([
    "not_started",
    "in_progress",
    "on_track",
    "at_risk",
    "completed",
    "paused",
    "cancelled",
    "archived",
  ]),
  reason: z
    .object({
      kind: z.enum(["pace", "overdue", "starts"]),
      elapsed: z.number().optional(),
      progress: z.number().optional(),
      date: isoDay.optional(),
    })
    .nullable(),
  percent: z.number().min(0).max(100).nullable(),
  value: z.number().nullable(),
  target: z.number().nullable(),
  progressType: z.enum(["binary", "numeric", "percentage"]),
  direction: z.enum(["increase", "decrease"]),
  basis: z.enum(["completed", "manual", "linked", "hybrid", "none"]),
  unit: text(60).nullable(),
  currency: text(3).nullable(),
  periodFrom: isoDay.nullable(),
  periodTo: isoDay.nullable(),
  deadline: isoDay.nullable(),
  reached: z.boolean(),
  visions: z.array(text(500)).max(5),
  area: text(60).nullable(),
  habits: z.array(goalHabit).max(6),
  completedAt: text(40).nullable(),
});

export const PAYLOADS = {
  meeting: eventPayload,
  calendar_event: eventPayload,
  calendar: calendarPayloadSchema,
  email_list: z.object({
    items: z.array(emailItem).max(10),
    query: text(200).optional(),
    /** One account's triaged email (ADR-067); absent on plain lists and older Surfaces. */
    mailbox: mailbox.optional(),
  }),
  email_thread: z.object({
    threadId: text(1000),
    subject: text(300),
    participants: z.array(text(200)).max(10),
    messageCount: z.number().int(),
    latest: z.object({ from: text(200), date: text(40), excerpt: text(700) }).nullable(),
    url: href.nullable(),
    account: text(200),
  }),
  knowledge_result: z.object({
    query: text(300).optional(),
    enough: z.boolean(),
    sources: z.array(knowledgeSource).max(6),
  }),
  knowledge_source: knowledgeSource,
  document: z.object({
    itemId: text(100),
    title: text(300),
    sourceType: text(40),
    spaceName: text(200),
    url: href.nullable(),
    updatedAt: text(40),
    versions: z.number().int(),
  }),
  recall: z.object({
    query: text(300).optional(),
    results: z
      .array(
        z.object({
          interactionId: text(100),
          title: text(300),
          date: text(40),
          summary: text(1200).nullable(),
          excerpts: z.array(z.object({ text: text(500), at: text(40) })).max(2),
          url: href.nullable(),
          /** A spoken interaction shows it ("Voice interaction · Sep 30"). */
          modality: z.enum(["text", "voice", "proactive", "live"]).optional(),
        }),
      )
      .max(5),
  }),
  task_list: z.object({ items: z.array(taskItem).max(12), total: z.number().int() }),
  task: z.object({
    task: taskItem,
    change: z.enum(["created", "updated", "completed", "reopened", "deleted", "shown"]),
  }),
  person: z.object({
    name: text(200).nullable(),
    email: text(320),
    role: z.enum(["organizer", "attendee"]),
    lastEmailAt: text(40).nullable(),
    threads: z.number().int(),
  }),
  links: z.object({
    links: z
      .array(
        z.object({ title: text(200), url: href, kind: z.enum(["meeting", "document", "web"]) }),
      )
      .max(8),
  }),
  schedule: z.object({
    name: text(200),
    status: text(40),
    nextRunAt: text(40).nullable(),
    proposal: z.unknown().optional(),
  }),
  settings: z.object({ changes: z.array(change).min(1).max(4) }),
  approval: z.object({
    approvalId: text(100),
    summary: text(500),
    reason: text(80),
    tool: text(80),
    preview: z.unknown().optional(),
    decision: z.enum(["approved", "rejected"]).nullable(),
    display: z.unknown().optional(),
    /** Approved work that continues in the background (e.g. a bulk change). */
    background: z.enum(["running", "done", "failed"]).optional(),
  }),
  summary: z.object({
    sections: z
      .array(
        z.object({
          kind: z.enum([
            "facts",
            "context",
            "changes",
            "open_items",
            "questions",
            "suggestions",
            "material",
          ]),
          heading: text(120),
          // Room for a markdown source link ([site](url)), rendered as a safe link.
          // "Title: text" gives an item a bold title; **bold** works inside the text.
          items: z.array(text(600)).min(1).max(8),
          /** One icon per item, in order (shown in its bubble); the section's own otherwise. */
          icons: z.array(z.enum(SUMMARY_ICONS)).max(8).optional(),
        }),
      )
      .min(1)
      .max(7),
    /** One line under the title ("Según el contexto, IAFS puede referirse a:"). */
    lead: text(200).optional(),
    /** A short tag next to the title ("2 significados", "3 opciones"). */
    badge: text(40).optional(),
    /** Chips under the title: where, what, a status ("Nueva Zelanda", "Licenciada por FMA"). */
    tags: z
      .array(z.object({ label: text(48), icon: z.enum(SUMMARY_ICONS).optional() }))
      .max(6)
      .optional(),
    /** Key facts at a glance, label → value ("Director" → "Rod Schubert"). */
    facts: z
      .array(
        z.object({ label: text(40), value: text(120), icon: z.enum(SUMMARY_ICONS).optional() }),
      )
      .max(8)
      .optional(),
  }),
  web_results: z.object({
    query: text(300),
    retrievedAt: text(40),
    results: z
      .array(
        z.object({
          title: text(300),
          url: href,
          domain: text(200),
          snippet: text(400),
          publishedAt: text(40).nullable(),
          inspected: z.boolean(),
          passages: z.array(text(700)).max(3),
        }),
      )
      .max(8),
  }),
  web_source: z.object({
    url: href,
    title: text(300),
    domain: text(200),
    siteName: text(200).nullable(),
    publishedAt: text(40).nullable(),
    retrievedAt: text(40),
    passages: z.array(text(700)).max(3),
    truncated: z.boolean(),
  }),
  web_news: z.object({
    query: text(200),
    recency: z.enum(["day", "week", "month", "year"]),
    retrievedAt: text(40),
    events: z
      .array(
        z.object({
          headline: text(300),
          items: z
            .array(
              z.object({
                title: text(300),
                url: href,
                domain: text(200),
                publishedAt: text(40).nullable(),
                snippet: text(300),
              }),
            )
            .min(1)
            .max(4),
        }),
      )
      .max(6),
  }),
  web_research: z.object({
    question: text(300),
    retrievedAt: text(40),
    subquestions: z
      .array(
        z.object({
          question: text(200),
          status: z.enum(["searching", "done", "gap", "failed"]),
          sources: z
            .array(
              z.object({
                title: text(200),
                url: href,
                domain: text(200),
                publishedAt: text(40).nullable(),
                inspected: z.boolean(),
              }),
            )
            .max(4),
        }),
      )
      .max(4),
  }),
  /** Concrete items found on the web (ADR-028): listings, products, options — each sourced. */
  web_collection: z.object({
    query: text(300),
    domain: text(200).nullable(),
    retrievedAt: text(40),
    /** Still reading: results arrive progressively. */
    searching: z.boolean(),
    requested: z.number().int().min(1).max(12),
    status: z.enum(["sufficient", "partial", "insufficient"]),
    items: z
      .array(
        z.object({
          title: text(200),
          url: href,
          domain: text(200),
          price: z.number().finite().nullable(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
          image: href.nullable(),
          attributes: z.array(z.object({ label: text(40), value: text(60) })).max(6),
          /** Known only from the search index: its page couldn't be read. */
          fromIndex: z.boolean(),
        }),
      )
      .max(12),
    limitations: z
      .array(
        z.object({
          domain: text(200),
          reason: z.enum(["blocked", "dynamic", "no_items", "not_found"]),
        }),
      )
      .max(6),
  }),
  // ── Contexts, Work and Study (ADR-016) ──
  context_overview: z.object({
    contextId: text(100),
    name: text(120),
    kind: z.enum(CONTEXT_KINDS),
    accent: text(20).nullable(),
    description: text(400).nullable(),
    links: z.array(z.object({ type: text(40), label: text(200), confirmed: z.boolean() })).max(16),
    /** A brief's comparison point ("since your last Client A interaction on Sep 28"). */
    baseline: z
      .object({
        since: text(40),
        basis: z.enum(["user", "last_interaction", "last_meeting", "default_window"]),
      })
      .nullable(),
    /** What each source contributed, or that it was unavailable. */
    sources: z
      .array(
        z.object({
          source: text(30),
          status: z.enum(["ok", "empty", "unavailable", "failed"]),
          count: z.number().int().min(0),
        }),
      )
      .max(10),
  }),
  context_proposal: z.object({
    name: text(80),
    kind: z.enum(CONTEXT_KINDS),
    /** The Space it becomes a Section of (ADR-018), when there is one. */
    space: z
      .object({ id: text(100), name: text(120) })
      .nullable()
      .default(null),
    description: text(400).nullable(),
    aliases: z.array(text(80)).max(12),
    suggestions: z
      .array(
        z.object({
          id: text(20),
          type: z.enum(LINK_TYPES),
          resourceId: text(600).nullable(),
          value: text(320).nullable(),
          label: text(200),
          detail: text(200).nullable(),
          confidence: z.enum(["high", "medium", "low"]),
          person: z.object({ name: text(200), email: text(320) }).nullable(),
        }),
      )
      .max(16),
    /** Set once the user created it from this proposal. */
    createdId: text(100).nullable(),
  }),
  commitments: z.object({
    contextName: text(120),
    items: z
      .array(
        z.object({
          id: text(20),
          text: text(240),
          direction: z.enum(["ours", "theirs", "waiting"]),
          who: text(200).nullable(),
          source: z.object({
            kind: z.enum(["email", "recall", "task"]),
            label: text(200),
            date: text(40).nullable(),
            ref: text(1000).nullable(),
          }),
        }),
      )
      .max(8),
  }),
  timeline: z.object({
    contextName: text(120),
    entries: z
      .array(
        z.object({
          at: text(40),
          kind: z.enum(["meeting", "email", "task", "document", "interaction", "record"]),
          title: text(300),
          detail: text(200).nullable(),
          upcoming: z.boolean(),
        }),
      )
      .max(12),
  }),
  study_question: z.object({
    sessionId: text(100),
    contextName: text(120),
    mode: z.enum(["review", "oral_exam", "quiz"]),
    number: z.number().int().min(1),
    question: text(600),
    conceptLabel: text(120),
    options: z.array(text(200)).max(4).nullable(),
    /** Hints shown so far (never the ones not asked for). */
    hints: z.array(text(240)).max(3),
    state: z.enum(["asking", "answered"]),
    /** Shown after the answer only, when feedback is per answer. */
    assessment: z.enum(["strong", "partial", "needs_review"]).nullable(),
    feedback: z
      .object({
        correct: z.array(text(240)).max(5),
        missing: z.array(text(240)).max(5),
        incorrect: z.array(text(240)).max(5),
        explanation: text(800),
      })
      .nullable(),
    /** Excerpts of the material: empty until answered or asked for. */
    sources: z
      .array(
        z.object({
          itemId: text(100),
          title: text(300),
          section: text(300).nullable(),
          page: z.number().int().nullable(),
          excerpt: text(600),
        }),
      )
      .max(3),
    /** The answer just given, with its feedback (when feedback is per answer). */
    previous: z
      .object({
        number: z.number().int().min(1),
        question: text(600),
        answer: text(400),
        assessment: z.enum(["strong", "partial", "needs_review"]).nullable(),
        feedback: z
          .object({
            correct: z.array(text(240)).max(5),
            missing: z.array(text(240)).max(5),
            incorrect: z.array(text(240)).max(5),
            explanation: text(800),
          })
          .nullable(),
        sources: z
          .array(
            z.object({
              itemId: text(100),
              title: text(300),
              section: text(300).nullable(),
              page: z.number().int().nullable(),
              excerpt: text(600),
            }),
          )
          .max(3),
      })
      .nullable(),
    feedbackMode: z.enum(["each", "end"]),
    scope: text(200),
  }),
  study_progress: z.object({
    contextId: text(100),
    contextName: text(120),
    counts: z.object({
      not_reviewed: z.number().int().min(0),
      learning: z.number().int().min(0),
      understood: z.number().int().min(0),
      needs_review: z.number().int().min(0),
    }),
    weak: z.array(text(120)).max(6),
    strong: z.array(text(120)).max(6),
    sessionQuestions: z.number().int().min(0),
    targetDate: text(10).nullable(),
  }),
  study_summary: z.object({
    contextName: text(120),
    questions: z.number().int().min(0),
    covered: z.array(text(120)).max(20),
    strong: z.array(text(120)).max(20),
    review: z.array(text(120)).max(20),
    mistakes: z.array(text(240)).max(5),
    nextReview: z.array(text(120)).max(5),
    at: text(40),
  }),
  shortcut: z.object({
    shortcutId: text(100).nullable(),
    name: text(80),
    phrases: z.array(text(60)).min(1).max(5),
    steps: z
      .array(z.object({ type: text(60), config: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(4),
    contextId: text(100).nullable(),
    contextName: text(120).nullable(),
    requiresConfirmation: z.boolean(),
    state: z.enum(["proposed", "saved"]),
  }),
  /** A chart chosen from the supported templates (ADR-021); never markup or code. */
  visualization: z.object({ spec: visualizationSpec }),
  /** Images, video and link previews from URLs the workspace already holds (ADR-021). */
  media: mediaPayload,
  image_gallery: imageGalleryPayload,
  /** Places, a route or a travel-time comparison on a map (ADR-023). */
  map: mapPayload,
  /** One place in detail (ADR-023). */
  place: placePayload,
  /** Current conditions, hours or days at one place (ADR-038). */
  weather: weatherPayload,
  /** What is playing now, one per interaction (ADR-042). */
  music: musicPayload,
  /** One of the user's timers, Pomodoros or stopwatches — a view over it (ADR-045). */
  timer: timerPayload,
  /** A live clock, here or in another time zone (ADR-045). */
  clock: clockPayload,
  /** Any other tool result, rendered by its existing card. */
  checklist: z.object({
    listId: text(100),
    name: text(120),
    icon: text(16).nullable(),
    items: z
      .array(
        z.object({
          id: text(100),
          content: text(500),
          checked: z.boolean(),
          notes: text(1000).nullable(),
          labels: z.array(text(60)).max(10).optional(),
        }),
      )
      .max(60),
    open: z.number().int(),
    total: z.number().int(),
  }),
  goal: z.object({
    goal: goalItem,
    history: z.array(z.object({ date: isoDay, value: z.number() })).max(60),
    events: z
      .array(
        z.object({
          at: text(40),
          value: z.number().nullable(),
          previous: z.number().nullable(),
          note: text(500).nullable(),
          source: text(20),
        }),
      )
      .max(10),
    parent: goalRefPayload.nullable(),
    children: z.array(goalRefPayload.extend({ percent: z.number().nullable() })).max(12),
    related: z.array(goalRefPayload).max(12),
    today: isoDay,
  }),
  goals_overview: z.object({
    goals: z.array(goalItem).max(30),
    total: z.number().int(),
    summary: z.object({
      active: z.number().int(),
      atRisk: z.number().int(),
      completed: z.number().int(),
      averageProgress: z.number().nullable(),
    }),
    visions: z
      .array(goalRefPayload.extend({ active: z.number().int(), completed: z.number().int() }))
      .max(8),
    scope: z.object({
      status: text(20),
      from: isoDay.nullable(),
      to: isoDay.nullable(),
      visionId: text(100).nullable(),
    }),
    today: isoDay,
  }),
  vision: z.object({
    vision: z.object({
      id: text(100),
      title: text(500),
      description: text(1200).nullable(),
      icon: text(16).nullable(),
      area: text(60).nullable(),
      status: z.enum(["active", "achieved", "archived"]),
    }),
    goals: z.array(goalItem).max(20),
    habits: z.array(goalHabit).max(8),
    completed: z.number().int(),
    total: z.number().int(),
    today: isoDay,
  }),
  team_messages: z.object({
    query: text(300).nullable(),
    channel: text(200).nullable(),
    items: z.array(teamMessage).max(10),
    files: z
      .array(
        z.object({
          title: text(300),
          fileType: text(40).nullable(),
          url: href.nullable(),
          date: text(40).nullable(),
          author: text(200).nullable(),
          workspace: text(200),
        }),
      )
      .max(6),
    notSearched: z.array(z.enum(TEAM_ACCESS)).max(7),
    unavailable: z.array(text(200)).max(10).optional(),
    unread: z.boolean().optional(),
  }),
  team_thread: z.object({
    threadId: text(500),
    channel: text(200),
    workspace: text(200),
    url: href.nullable(),
    total: z.number().int(),
    hasMore: z.boolean(),
    messages: z
      .array(teamMessage.pick({ messageId: true, author: true, date: true, text: true, url: true }))
      .max(30),
  }),
  result: z.object({ display: z.object({ kind: text(60) }).passthrough() }),
  answer: answerPayload,
  market: marketPayload,
  economy: economyPayload,
  shopping: shoppingPayload,
  product_offers: productOffersPayload,
  finance_import: financeImportPayload,
  personality: z.object({ current: z.enum(PERSONALITIES) }),
  home: homePayload,
  alarms: z.object({
    alarms: z
      .array(
        z.object({
          id: text(40),
          label: text(80).nullable(),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          date: isoDay.nullable(),
          weekdays: z.array(z.number().int().min(0).max(6)).max(7),
          enabled: z.boolean(),
          state: z.enum(["scheduled", "ringing", "snoozed", "done", "off"]),
          nextFireAt: text(40).nullable(),
          sound: text(60).nullable(),
          soundName: text(60),
          snoozeMinutes: z.number().int(),
          destinations: z
            .array(
              z.object({
                kind: z.enum(["browser", "desktop"]),
                id: text(40),
                name: text(80).nullable(),
                online: z.boolean(),
              }),
            )
            .max(10),
        }),
      )
      .max(12),
    sounds: z
      .array(z.object({ key: text(60), name: text(60), kind: z.enum(["bundled", "upload"]) }))
      .max(20)
      .optional(),
    defaultSound: text(60),
    timezone: text(64),
    focus: text(40).optional(),
  }),
  day_plan: z.object({
    date: isoDay,
    timezone: text(60),
    title: text(120).nullable(),
    blocks: z
      .array(
        z.object({
          id: text(10),
          start: z.string().regex(/^\d{2}:\d{2}$/),
          end: z.string().regex(/^\d{2}:\d{2}$/),
          minutes: z.number().int(),
          label: text(120),
          category: z.enum(BLOCK_CATEGORIES),
          notes: text(300).nullable(),
          origin: z.enum(["user", "suggested", "calendar"]),
          state: z.enum(["proposed", "saved"]),
          eventId: text(1000).nullable(),
          conflicts: z.array(text(10)).max(40),
        }),
      )
      .max(40),
    gaps: z.array(z.object({ start: text(5), end: text(5), minutes: z.number().int() })).max(40),
    warnings: z
      .array(
        z.union([
          z.object({ kind: z.literal("overlap"), a: text(10), b: text(10) }),
          z.object({ kind: z.literal("nonexistent_time"), at: text(5) }),
          z.object({ kind: z.literal("calendar_unavailable") }),
        ]),
      )
      .max(60),
    version: z.number().int().min(1),
  }),
} satisfies Record<SurfaceType, z.ZodType>;

export type SurfacePayloads = { [K in SurfaceType]: z.infer<(typeof PAYLOADS)[K]> };
export type TypedSurface<K extends SurfaceType> = Surface<SurfacePayloads[K]> & { type: K };

/** A direct action resolves to exactly one tool call, built here from the Surface's own data. */
export interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

interface SurfaceDefinition<K extends SurfaceType> {
  sizes: readonly SurfaceSize[];
  size: SurfaceSize;
  priority: number;
  actions(p: SurfacePayloads[K]): SurfaceAction[];
  describe(p: SurfacePayloads[K], timezone: string): string;
  tool?(p: SurfacePayloads[K], action: ActionId, itemId: string | null): ToolCallSpec | null;
}

export { isOpen };

const link = (id: ActionId, url: string | null | undefined): SurfaceAction[] =>
  url && isSafeHref(url) ? [{ id, kind: "link", href: url }] : [];
const expand: SurfaceAction = { id: "expand", kind: "expand" };
const local = (iso: string, tz: string) =>
  iso.length > 10 ? toLocalDateTime(new Date(iso), tz).replace("T", " ") : iso;
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

const describeGoal = (g: SurfacePayloads["goal"]["goal"]) =>
  `${q(g.title)} ${g.health}${g.percent !== null ? ` ${g.percent}%` : ""}${g.deadline ? ` due ${g.deadline}` : ""} (goal ${g.id})`;

const event = <K extends "meeting" | "calendar_event">(priority: number): SurfaceDefinition<K> => ({
  sizes: ["small", "medium", "large", "expanded"],
  size: priority >= 90 ? "large" : "medium",
  priority,
  actions: (p) => [...link("join", p.meetingUrl), ...link("open_calendar", p.htmlUrl), expand],
  describe: (p, tz) =>
    `${q(p.title)} ${local(p.start, tz)}–${local(p.end, tz).slice(-5)} · ${p.attendees.filter((a) => !a.self).length} participants (event ${p.eventId})`,
});

const DEFINITIONS: { [K in SurfaceType]: SurfaceDefinition<K> } = {
  meeting: event(100),
  calendar_event: event(70),
  calendar: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 82,
    actions: () => [expand],
    describe: (p, tz) => {
      const shown = p.events.filter((e) => !p.hidden.includes(e.calendarId));
      return [
        `${p.view} view of ${p.anchor} (loaded ${p.range.from}…${p.range.to}`,
        p.hidden.length ? `, hidden calendars: ${p.hidden.length}` : "",
        `): `,
        shown
          .slice(0, 40)
          .map((e) =>
            e.busy
              ? `busy ${local(e.start, tz)}–${local(e.end, tz).slice(11)}`
              : `${q(e.title)} ${e.allDay ? `${e.start} all day` : `${local(e.start, tz)}–${local(e.end, tz).slice(11)}`} [${e.calendarName}] (event ${e.id})`,
          )
          .join("; ") || "no events",
      ].join("");
    },
  },
  email_list: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 60,
    actions: () => [expand],
    describe: (p) =>
      p.items
        .map(
          (m, i) =>
            `${i + 1}) ${q(m.subject)} — ${m.from?.name ?? m.from?.email ?? "?"} ${m.date.slice(0, 10)} (thread ${m.threadId}, message ${m.messageId})`,
        )
        .join("; "),
  },
  team_messages: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 62,
    actions: () => [expand],
    describe: (p, tz) =>
      [
        p.query ? `search ${q(p.query)}` : p.channel ? `recent in ${p.channel}` : "",
        ...p.items.map(
          (m, i) =>
            `${i + 1}) ${m.author} in ${m.channel} ${local(m.date, tz)} · ${m.workspace} (message ${m.messageId}${m.threadId ? `, thread ${m.threadId}` : ""})`,
        ),
        p.items.length ? "" : "no messages",
      ]
        .filter(Boolean)
        .join("; "),
  },
  team_thread: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "large",
    priority: 68,
    actions: (p) => [
      ...link("open", p.url),
      { id: "summarize", kind: "prompt" },
      { id: "draft_reply", kind: "prompt" },
      expand,
    ],
    describe: (p) =>
      `thread in ${p.channel} · ${p.workspace} · ${p.total} messages (thread ${p.threadId}, latest message ${p.messages.at(-1)?.messageId ?? "?"})`,
  },
  email_thread: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 65,
    actions: (p) => [
      ...link("open", p.url),
      { id: "summarize", kind: "prompt" },
      { id: "draft_reply", kind: "prompt" },
      expand,
    ],
    describe: (p) =>
      `${q(p.subject)} with ${p.participants.slice(0, 4).join(", ")} · ${p.messageCount} messages (thread ${p.threadId})`,
  },
  knowledge_result: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: () => [expand],
    describe: (p) =>
      p.sources
        .map((s, i) => `${i + 1}) ${q(s.title)} · ${s.spaceName} (item ${s.itemId})`)
        .join("; "),
  },
  knowledge_source: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    // With a link, the card's own "Abrir en Notion" is the way out (ADR-114).
    actions: (p) => [
      ...(p.url
        ? []
        : [
            {
              id: "open_source" as const,
              kind: "link" as const,
              href: `/knowledge/items/${p.itemId}`,
            },
          ]),
      { id: "summarize", kind: "prompt" },
      expand,
    ],
    describe: (p) =>
      `${q(p.title)} · ${p.spaceName} (item ${p.itemId})${p.url ? ` · ${p.url}` : ""}`,
  },
  document: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: (p) => [
      { id: "open_source", kind: "link", href: `/knowledge/items/${p.itemId}` },
      { id: "summarize", kind: "prompt" },
      expand,
    ],
    describe: (p) => `${q(p.title)} · ${p.spaceName} (item ${p.itemId})`,
  },
  recall: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 58,
    actions: () => [expand],
    describe: (p) =>
      p.results
        .map(
          (r, i) =>
            `${i + 1}) ${r.date.slice(0, 10)} ${q(r.title)} (interaction ${r.interactionId})`,
        )
        .join("; "),
  },
  task_list: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 50,
    actions: () => [{ id: "complete", kind: "tool" }, expand],
    describe: (p) =>
      p.items
        .map(
          (t, i) =>
            `${i + 1}) ${q(t.title)}${isOpen(t.status) ? "" : ` [${t.status}]`} (task ${t.id})`,
        )
        .join("; "),
    tool: (p, action, itemId) => {
      const item = p.items.find((t) => t.id === itemId);
      return action === "complete" && item && isOpen(item.status)
        ? { name: "tasks.complete", args: { taskId: item.id } }
        : null;
    },
  },
  task: {
    sizes: ["micro", "small", "medium"],
    size: "small",
    priority: 45,
    actions: (p) => (isOpen(p.task.status) ? [{ id: "complete", kind: "tool" }] : []),
    describe: (p) => `${q(p.task.title)} [${p.change}] (task ${p.task.id})`,
    tool: (p, action) =>
      action === "complete" && isOpen(p.task.status)
        ? { name: "tasks.complete", args: { taskId: p.task.id } }
        : null,
  },
  person: {
    sizes: ["micro", "small"],
    size: "small",
    priority: 34,
    actions: () => [],
    describe: (p) => `${p.name ?? p.email} <${p.email}>`,
  },
  links: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 35,
    actions: () => [],
    describe: (p) => p.links.map((l) => q(l.title)).join(", "),
  },
  schedule: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 50,
    actions: () => [],
    describe: (p) => `${q(p.name)} ${p.status}`,
  },
  settings: {
    sizes: ["micro", "small"],
    size: "small",
    priority: 30,
    actions: (p) =>
      p.changes.length === 1 && undoFor(p.changes[0]!) ? [{ id: "undo", kind: "tool" }] : [],
    describe: (p) => p.changes.map((c) => `${c.setting} ${c.from ?? "—"} → ${c.to}`).join(", "),
    tool: (p, action) =>
      action === "undo" && p.changes.length === 1 ? undoFor(p.changes[0]!) : null,
  },
  approval: {
    sizes: ["medium", "large"],
    size: "medium",
    priority: 95,
    actions: () => [],
    describe: (p) => `${q(p.summary)} — ${p.decision ?? "waiting for the user's approval"}`,
  },
  summary: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 90,
    actions: () => [],
    describe: (p) => p.sections.map((s) => s.heading).join(" · "),
  },
  web_results: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 62,
    actions: () => [expand],
    describe: (p) =>
      p.results.map((r, i) => `${i + 1}) ${q(r.title)} · ${r.domain} (${r.url})`).join("; "),
  },
  web_source: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 64,
    actions: (p) => [...link("open", p.url), { id: "save", kind: "prompt" }, expand],
    describe: (p) => `${q(p.title)} · ${p.domain} (${p.url})`,
  },
  web_news: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 63,
    actions: () => [expand],
    describe: (p) =>
      p.events
        .map(
          (e, i) =>
            `${i + 1}) ${q(e.headline)} — ${e.items.map((it) => it.domain).join(", ")} (${e.items[0]?.url})`,
        )
        .join("; "),
  },
  web_research: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 80,
    actions: () => [expand],
    describe: (p) =>
      p.subquestions
        .map(
          (s, i) =>
            `${i + 1}) ${q(s.question)} [${s.status}]: ${s.sources.map((x) => x.url).join(" ")}`,
        )
        .join("; "),
  },
  web_collection: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    // The concrete items answer the question: they lead.
    priority: 82,
    actions: () => [expand],
    describe: (p) =>
      `${p.items.length}/${p.requested} ${p.status}${p.searching ? " (searching)" : ""}: ${p.items
        .map(
          (it, i) =>
            `${i + 1}) ${q(it.title)}${it.price !== null ? ` · ${it.currency ?? ""} ${it.price}` : ""} · ${it.domain} (${it.url})`,
        )
        .join(
          "; ",
        )}${p.limitations.length ? ` — limits: ${p.limitations.map((l) => `${l.domain} ${l.reason}`).join(", ")}` : ""}`,
  },
  context_overview: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 85,
    actions: (p) => [
      { id: "open", kind: "link", href: `/my-elise/contexts/${p.contextId}` },
      { id: "research", kind: "prompt" },
    ],
    describe: (p) =>
      `${q(p.name)} (${p.kind}, context ${p.contextId})${p.baseline ? ` since ${p.baseline.since.slice(0, 10)} [${p.baseline.basis}]` : ""}${p.sources.length ? ` · sources: ${p.sources.map((s) => `${s.source} ${s.status}${s.count ? ` ${s.count}` : ""}`).join(", ")}` : ""}`,
  },
  context_proposal: {
    sizes: ["medium", "large"],
    size: "large",
    priority: 92,
    actions: (p) => (p.createdId ? [] : [{ id: "create_context", kind: "tool" }]),
    describe: (p) =>
      `Proposed context ${q(p.name)} (${p.kind})${p.createdId ? " [created]" : ""}: ${p.suggestions.map((s) => `${s.id}) ${s.label} [${s.confidence}]`).join("; ")}`,
    // The user's selection (suggestion ids) arrives as itemId; everything else comes from the
    // stored proposal, never from the browser.
    tool: (p, action, itemId) => {
      if (action !== "create_context" || p.createdId) return null;
      const chosen = new Set((itemId ?? "").split(",").filter(Boolean));
      return {
        name: "contexts.create",
        args: {
          kind: p.kind,
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          ...(p.space ? { space: p.space.id } : {}),
          aliases: p.aliases,
          links: p.suggestions
            .filter((s) => chosen.has(s.id))
            .map((s) => ({
              type: s.type,
              ...(s.resourceId ? { resourceId: s.resourceId } : {}),
              ...(s.value ? { value: s.value } : {}),
              label: s.label,
              ...(s.person ? { person: s.person } : {}),
            })),
        },
      };
    },
  },
  commitments: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 72,
    actions: (p) => (p.items.length ? [{ id: "create_task", kind: "tool" }] : []),
    describe: (p) =>
      p.items
        .map(
          (c, i) =>
            `${i + 1}) [${c.direction}] ${q(c.text)}${c.who ? ` — ${c.who}` : ""} (${c.source.kind} ${q(c.source.label)}${c.source.date ? ` ${c.source.date.slice(0, 10)}` : ""}, item ${c.id})`,
        )
        .join("; "),
    tool: (p, action, itemId) => {
      const item = p.items.find((c) => c.id === itemId);
      return action === "create_task" && item
        ? { name: "tasks.create", args: { title: item.text.slice(0, 200) } }
        : null;
    },
  },
  timeline: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 62,
    actions: () => [expand],
    describe: (p, tz) =>
      p.entries
        .map(
          (e) =>
            `${local(e.at, tz).slice(0, 10)} ${e.kind}${e.upcoming ? " (upcoming)" : ""} ${q(e.title)}`,
        )
        .join("; "),
  },
  study_question: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 96,
    actions: (p) =>
      p.state === "asking"
        ? [
            ...(p.hints.length < 3 ? [{ id: "hint" as const, kind: "tool" as const }] : []),
            ...(p.sources.length ? [] : [{ id: "reveal" as const, kind: "tool" as const }]),
            { id: "next", kind: "tool" },
            { id: "end_session", kind: "tool" },
          ]
        : [
            { id: "next", kind: "tool" },
            { id: "end_session", kind: "tool" },
          ],
    // The model gets the question, never the key points or hints it hasn't shown.
    describe: (p) =>
      `Study session ${p.sessionId} · ${q(p.contextName)} · ${p.mode} · question ${p.number} [${p.state}${p.assessment ? `: ${p.assessment}` : ""}] about ${q(p.conceptLabel)}: ${q(p.question)}`,
    tool: (p, action) => {
      const session = { session: p.sessionId };
      switch (action) {
        case "hint":
          return p.state === "asking" ? { name: "study.hint", args: session } : null;
        case "reveal":
          return p.state === "asking" ? { name: "study.reveal", args: session } : null;
        case "next":
          return { name: "study.next", args: session };
        case "end_session":
          return { name: "study.end", args: session };
        default:
          return null;
      }
    },
  },
  study_progress: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 70,
    actions: (p) => (p.weak.length ? [{ id: "review_weak", kind: "prompt" }] : []),
    describe: (p) =>
      `${q(p.contextName)} progress: understood ${p.counts.understood}, learning ${p.counts.learning}, needs review ${p.counts.needs_review}, not reviewed ${p.counts.not_reviewed}${p.weak.length ? ` · weak: ${p.weak.join(", ")}` : ""}`,
  },
  study_summary: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 94,
    actions: (p) => (p.review.length ? [{ id: "review_weak", kind: "prompt" }] : []),
    describe: (p) =>
      `${q(p.contextName)} session summary: ${p.questions} questions · strong: ${p.strong.join(", ") || "—"} · review: ${p.review.join(", ") || "—"}`,
  },
  shortcut: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 88,
    actions: (p) => (p.state === "proposed" ? [{ id: "save_shortcut", kind: "tool" }] : []),
    describe: (p) =>
      `Shortcut ${q(p.name)} [${p.state}] phrases: ${p.phrases.map(q).join(", ")} → ${p.steps.map((s) => s.type).join(", ")}`,
    // Saving builds the call from the stored proposal, never from the browser.
    tool: (p, action) =>
      action === "save_shortcut" && p.state === "proposed"
        ? {
            name: "shortcuts.create",
            args: {
              name: p.name,
              phrases: p.phrases,
              steps: p.steps,
              ...(p.contextId ? { context: p.contextId } : {}),
              requiresConfirmation: p.requiresConfirmation,
            },
          }
        : null,
  },
  visualization: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 64,
    actions: () => [expand],
    describe: (p) => describeSpec(p.spec),
  },
  media: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 60,
    actions: (p) => [...link("open", p.items[0]?.url), expand],
    describe: (p) =>
      `${p.kind}: ${p.items.map((m, i) => `${i + 1}) ${q(m.title || m.domain)} (${m.url})`).join("; ")}`,
  },
  image_gallery: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 68,
    actions: () => [expand],
    describe: (p) =>
      `photos: ${p.groups.map((g, i) => `${i + 1}) ${q(g.name)}${g.context ? ` (${q(g.context)})` : ""}: ${g.images.length}`).join("; ")}`,
  },
  map: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 72,
    actions: (p) => [...link("open", p.route?.mapsUrl ?? null), expand],
    describe: describeMap,
  },
  place: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 66,
    actions: (p) => [...link("open", p.mapsUrl), expand],
    describe: (p) =>
      `${q(p.name)}${p.address ? ` · ${p.address}` : ""}${p.openNow == null ? "" : p.openNow ? " · open now" : " · closed now"} (place ${p.id})`,
  },
  weather: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 70,
    actions: (p) => (p.mode === "needs_location" ? [] : [expand]),
    describe: describeWeather,
  },
  music: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "small",
    // Ambient: it accompanies the work, it doesn't lead it.
    priority: 36,
    actions: () => [expand],
    describe: (p) =>
      [
        p.item
          ? `${p.playing ? "Playing" : "Paused"} ${q(p.item.title)}${p.item.subtitle ? ` by ${p.item.subtitle}` : ""}`
          : "Nothing playing",
        p.context?.title ? `from ${q(p.context.title)}` : null,
        p.device ? `on ${q(p.device.name)}` : null,
        p.volume !== null ? `volume ${p.volume}%` : null,
        `(${p.provider})`,
        p.results?.length
          ? `results: ${p.results.map((r) => `${q(r.title)} [${r.kind} ${r.ref}]`).join("; ")}`
          : null,
        p.devices?.length ? `devices: ${p.devices.map((d) => q(d.name)).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" "),
  },
  timer: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    // What the user is doing right now: above ambient music, below the work itself.
    priority: 74,
    actions: () => [expand],
    describe: describeTimer,
  },
  clock: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 50,
    actions: () => [expand],
    describe: (p) => `Clock ${p.place ? q(p.place) + " " : ""}(${p.timezone})`,
  },
  checklist: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: (p) => [
      { id: "complete", kind: "tool" },
      { id: "uncheck", kind: "tool" },
      ...link("open", `/my-elise/lists?focus=${p.listId}`),
      expand,
    ],
    describe: (p) =>
      `list ${q(p.name)} (list ${p.listId}): ${p.items
        .map((i) => `${q(i.content)}${i.checked ? " [checked]" : ""} (item ${i.id})`)
        .join("; ")}`,
    tool: (p, action, itemId) => {
      const item = p.items.find((i) => i.id === itemId);
      if (!item) return null;
      if (action === "complete" && !item.checked)
        return { name: "lists.checkItem", args: { list: p.listId, item: item.id } };
      if (action === "uncheck" && item.checked)
        return { name: "lists.uncheckItem", args: { list: p.listId, item: item.id } };
      return null;
    },
  },
  goal: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 64,
    actions: (p) => [...link("open", `/my-elise/goals?goal=${p.goal.id}`), expand],
    describe: (p) => `goal ${describeGoal(p.goal)}`,
  },
  goals_overview: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 66,
    actions: () => [...link("open", "/my-elise/goals"), expand],
    describe: (p) =>
      `goals (${p.scope.status}${p.scope.from ? ` ${p.scope.from}…${p.scope.to}` : ""}): ${p.goals.map(describeGoal).join("; ") || "none"}`,
  },
  vision: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 66,
    actions: (p) => [...link("open", `/my-elise/goals?vision=${p.vision.id}`), expand],
    describe: (p) =>
      `Vision ${q(p.vision.title)} (vision ${p.vision.id}): ${p.completed}/${p.total} goals completed; ${p.goals.map(describeGoal).join("; ")}`,
  },
  result: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 40,
    actions: () => [],
    describe: (p) => p.display.kind,
  },
  // Home (ADR-079): what a command or mode did, compact; the full dashboard is a page away.
  home: {
    sizes: ["small", "medium", "large"],
    size: "small",
    priority: 86,
    actions: () => [],
    describe: (p) =>
      `${p.title} (hub ${p.hub}): ${p.items.map((i) => `${i.name} ${i.status === "state" ? "" : `${i.status} `}${i.detail}`).join("; ")}`,
  },
  // Alarms (ADR-100): the list, or the sounds to try; the devices say where each can ring.
  alarms: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 84,
    actions: () => [],
    describe: (p) =>
      p.alarms.length
        ? p.alarms
            .map(
              (a) =>
                `${a.time} ${a.label ? q(a.label) : ""} ${a.date ?? `weekdays ${a.weekdays.join(",")}`} ${a.enabled ? a.state : "off"} (alarm ${a.id})`,
            )
            .join("; ")
        : `Alarm sounds: ${(p.sounds ?? []).map((s) => s.name).join(", ")}`,
  },
  // A day's plan (ADR-098): the proposal is the answer; saving it is the conversation's.
  day_plan: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 90,
    actions: (p) =>
      p.blocks.some((b) => b.state === "proposed") ? [{ id: "save_plan", kind: "prompt" }] : [],
    describe: (p) =>
      `Plan for ${p.date} (v${p.version}): ${p.blocks
        .map(
          (b) =>
            `${b.start}–${b.end} ${q(b.label)} ${b.state}${b.origin === "calendar" ? " (calendar)" : ""}${b.conflicts.length ? " CONFLICT" : ""}`,
        )
        .join("; ")}`,
  },
  // The personality choices (ADR-076): picking one saves it, like Settings.
  personality: {
    sizes: ["medium", "large"],
    size: "medium",
    priority: 85,
    actions: () => [],
    describe: (p) => `Personality choices (current: ${p.current})`,
  },
  // A file to import (ADR-075): what ELISE understood and the one thing to decide.
  finance_import: {
    sizes: ["medium", "large", "expanded"],
    size: "medium",
    priority: 89,
    actions: () => [],
    describe: (p) =>
      `Finance import ${p.label}: ${p.rows} rows, ${p.willImport} ready, ${p.invalid} need attention${p.needs.length ? `; needs ${p.needs.join(", ")}` : ""}`,
  },
  // Market data (ADR-074): the quote is the answer to "¿cómo está X?".
  market: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 88,
    actions: () => [expand],
    describe: (p) =>
      [
        ...p.quotes.map(
          (q) =>
            `${q.symbol} ${q.price} ${q.currency ?? ""}${q.changePercent !== null ? ` ${q.changePercent > 0 ? "+" : ""}${q.changePercent}%` : ""}${q.asOf ? ` as of ${q.asOf}` : ""}`,
        ),
        p.history?.change
          ? `${p.history.symbol} ${p.history.period}: ${p.history.change.changePercent}% (${p.history.change.from}→${p.history.change.to})`
          : "",
      ]
        .filter(Boolean)
        .join("; "),
  },
  // Products to buy (ADR-112): the marketplace's offers, verified or only linked.
  product_offers: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 86,
    actions: () => [expand],
    describe: (p) =>
      [
        `${p.marketplace.name} (${p.marketplace.method}) · ${p.query}`,
        ...p.marketplace.offers
          .slice(0, 5)
          .map((o) =>
            [
              o.title,
              o.price !== null ? `${o.currency ?? ""} ${o.price}` : "no price",
              o.match,
            ].join(" · "),
          ),
      ].join("; "),
  },
  // Supermarket prices (ADR-111): a product's prices, a list's comparison, a history.
  shopping: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 86,
    actions: () => [expand],
    describe: (p) => {
      const money = (c: number) => `$${(c / 100).toFixed(2)}`;
      const head = `${p.mode} · ${p.regionName}${p.date ? ` · ${p.date}` : ""}`;
      if (p.basket)
        return [
          head,
          `${p.basket.commonLines}/${p.basket.requested} lines in every chain`,
          ...p.basket.chains.map(
            (c) =>
              `${c.name}: common ${money(c.commonCents)}, ${c.covered} lines${c.full ? " (full)" : ""}`,
          ),
        ].join("; ");
      if (p.product)
        return [
          `${head} · ${p.product.name}`,
          ...p.chains.slice(0, 8).map((c) => `${c.name} ${money(c.listCents)}`),
        ].join("; ");
      if (p.candidates.length)
        return `${head} · options: ${p.candidates.map((c) => c.name).join(" | ")}`;
      return head;
    },
  },
  // Public economic data (ADR-094): the figure is the answer to "¿a cuánto está el dólar?".
  economy: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 88,
    actions: () => [expand],
    describe: (p) =>
      [
        p.headline
          ? `${p.headline.label}: ${p.headline.value}${p.headline.period ? ` (${p.headline.period})` : ""}`
          : "",
        ...p.rows
          .slice(0, 8)
          .map((r) =>
            [
              r.label,
              r.buy !== null ? `compra ${r.buy}` : "",
              r.sell !== null ? `venta ${r.sell}` : "",
              r.value !== null ? String(r.value) : "",
              r.date ?? "",
            ]
              .filter(Boolean)
              .join(" "),
          ),
        `source ${p.sources.map((s) => s.name).join(", ")}`,
      ]
        .filter(Boolean)
        .join("; "),
  },
  // The answer leads (ADR-071): above its evidence, below approvals.
  answer: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 90,
    actions: () => [expand],
    describe: (p) =>
      `${p.intent}: ${[...p.items.map((i) => i.title), ...(p.metrics ?? []).map((m) => `${m.label} ${m.value}`)].slice(0, 12).join("; ")} · sources: ${p.sources.map((s) => q(s.title)).join(", ") || "none"}`,
  },
};

const minutes = (s: number | null) => (s == null ? "no route" : `${Math.round(s / 60)} min`);
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** Numbered, so "the second one" and "that café" resolve to a place id. */
function describeMap(p: MapPayload): string {
  if (p.mode === "locate") return "Waiting for the user to share their location";
  if (p.route) {
    const head = `${p.route.mode} route ${q(p.route.from)} → ${q(p.route.to)}: ${minutes(p.route.durationSeconds)}, ${km(p.route.distanceMeters)}`;
    // ADR-113: follow-ups ("¿dónde lo tomo?", "¿y la otra?") answer from the same lines.
    const it = p.route.itineraries;
    if (!it?.length) return head;
    return `${head}. ${it
      .map(
        (x, i) =>
          `Option ${i + 1} (${minutes(x.durationSeconds)}, ${x.transfers} transfers, ${x.walkMeters} m walking): ${x.legs
            .map((l) =>
              l.kind === "walk"
                ? `walk ${minutes(l.durationSeconds)}`
                : `${l.vehicleName ?? l.vehicle} ${l.line ?? "?"}${l.headsign ? ` towards ${q(l.headsign)}` : ""}${l.board ? ` from ${q(l.board)}` : ""}${l.alight ? ` to ${q(l.alight)}` : ""}${l.stops != null ? ` (${l.stops} stops)` : ""}`,
            )
            .join(" → ")}`,
      )
      .join("; ")}`;
  }
  if (p.comparison)
    return `${p.comparison.mode} times: ${p.comparison.rows
      .map(
        (r) =>
          `${q(p.comparison!.origins[r.origin] ?? "")} → ${q(r.destination)} ${minutes(r.durationSeconds)}`,
      )
      .join("; ")}`;
  return `${q(p.query)}: ${p.places
    .map(
      (x, i) =>
        `${i + 1}) ${q(x.name)}${x.distanceMeters != null ? ` ${x.distanceMeters} m` : ""}${x.rating ? ` ★${x.rating}` : ""} (place ${x.id})`,
    )
    .join("; ")}`;
}

/** A timer as the model can talk about it (time left from its timestamps, as of now). */
function describeTimer(p: TimerPayload): string {
  const t = timerFromPayload(p);
  const now = new Date();
  const phase = currentPhase(t);
  const time =
    t.kind === "stopwatch"
      ? `${clockText(elapsedMs(t, now), false)} elapsed`
      : `${clockText(remainingMs(t, now))} left`;
  return `${t.kind} ${t.label ? q(t.label) + " " : ""}[${t.state}] ${time}${phase ? ` · ${phase.phase} ${phase.cycle}/${t.pomodoro!.cycles}` : ""} (timer ${t.id}; ask time.list for the exact time left)`;
}

/** The forecast as the model can talk about it: place, now, and each day or hour. */
function describeWeather(p: WeatherPayload): string {
  if (p.mode === "needs_location") return "Weather: waiting for the user to name a place";
  const r = Math.round;
  const place = p.location ? q(p.location.name) : "";
  const now = p.current ? ` now ${r(p.current.temperature)}°C ${p.current.condition}` : "";
  const days = p.days
    .map(
      (d) =>
        `${d.date} ${r(d.min)}–${r(d.max)}°C ${d.condition} rain ${d.precipitationProbability ?? "?"}%`,
    )
    .join("; ");
  const hours = p.hours
    .slice(0, 12)
    .map((h) => `${h.time.slice(11)} ${r(h.temperature)}° ${h.precipitationProbability ?? "?"}%`)
    .join(", ");
  return `Weather ${place}${now}${days ? ` · ${days}` : ""}${hours ? ` · hours ${hours}` : ""}`;
}

/** A chart, compactly: its template, title and the numbers it shows (so ELISE can talk about it). */
function describeSpec(spec: VisualizationSpec): string {
  const head = `${spec.type} ${q(spec.title)}`;
  switch (spec.type) {
    case "kpi":
      return `${head}: ${spec.value}${spec.previous != null ? ` (previous ${spec.previous})` : ""}`;
    case "line":
    case "area":
    case "bar":
      return `${head}: ${spec.series
        .map((s) => `${s.name} [${s.values.map((v, i) => `${spec.x[i]}=${v ?? "–"}`).join(", ")}]`)
        .join("; ")}`;
    case "hbar":
    case "distribution":
    case "diverging":
    case "donut":
      return `${head}: ${spec.rows.map((r) => `${r.label}=${r.value}`).join(", ")}`;
    case "scatter":
      return `${head} (${spec.xLabel} vs ${spec.yLabel}): ${spec.points
        .slice(0, 30)
        .map((p) => `${p.label ? `${p.label} ` : ""}(${p.x}, ${p.y})`)
        .join(", ")}`;
    case "histogram":
      return `${head}: ${spec.bins.map((b) => `${b.from}–${b.to}: ${b.count}`).join(", ")}`;
    case "waterfall":
      return `${head}: ${spec.steps.map((st) => `${st.label} ${st.kind === "delta" && st.value > 0 ? "+" : ""}${st.value}`).join(", ")}`;
    case "candlestick":
      return `${head}: ${spec.x
        .map(
          (x, i) =>
            `${x} O${spec.ohlc[i]!.open} H${spec.ohlc[i]!.high} L${spec.ohlc[i]!.low} C${spec.ohlc[i]!.close}`,
        )
        .join("; ")}`;
    case "progress":
      return `${head}: ${spec.rows.map((r) => `${r.label}=${Math.round(r.value * 100)}%`).join(", ")}`;
    case "streak":
      return `${head}: ${spec.rows.map((r) => `${r.label} ${r.summary}`).join(", ")}`;
    case "table":
      return `${head}: ${spec.rows.length} rows`;
    case "dot":
      return `${head}${ref(spec)}: ${spec.rows
        .map(
          (r) =>
            `${r.label}=${r.value}${r.deltaPct != null ? ` (${r.deltaPct > 0 ? "+" : ""}${r.deltaPct}%)` : ""}${src(spec, r.source)}${r.uncertain ? " uncertain" : ""}`,
        )
        .join(", ")}`;
    case "range":
      return `${head}${ref(spec)}: ${spec.scenarios
        .map((r) => `${r.label}=${r.value}${src(spec, r.source)}`)
        .join(", ")}`;
    case "temporal":
      return `${spec.view} ${q(spec.title)}${
        spec.focus
          ? ` (showing ${[spec.focus.kinds?.join("/"), spec.focus.from, spec.focus.to].filter(Boolean).join(" ")})`
          : ""
      }: ${spec.events
        .map(
          (e) =>
            `${e.start}${e.end ? `..${e.end}` : ""} ${e.kind}${e.importance === "high" ? "!" : ""} ${q(e.title)}${src(spec, e.source)}${e.conflict ? " CONFLICT" : ""}`,
        )
        .join("; ")}`;
  }
}

/** Provenance in the description: the user may ask where a number came from. */
function src(spec: VisualizationSpec, i: number | undefined): string {
  const s = i === undefined ? undefined : spec.sources?.[i];
  if (!s) return "";
  return s.url ? ` [${s.title} ${s.url}]` : ` [${s.title}]`;
}
function ref(spec: VisualizationSpec): string {
  const r = "reference" in spec ? spec.reference : undefined;
  return r ? ` (reference ${r.label}=${r.value}${src(spec, r.source)})` : "";
}

function undoFor(c: z.infer<typeof change>): ToolCallSpec | null {
  if (!c.from) return null;
  switch (c.setting) {
    case "accent":
      return { name: "appearance.setAccent", args: { accent: c.from } };
    case "theme":
      return { name: "appearance.setTheme", args: { theme: c.from } };
    case "timezone":
      return { name: "settings.update", args: { timezone: c.from } };
    case "language":
      return { name: "settings.update", args: { language: c.from } };
    case "schedule":
      return c.subject
        ? {
            name: c.from === "paused" ? "schedules.pause" : "schedules.resume",
            args: { schedule: c.subject },
          }
        : null;
    default:
      return null;
  }
}

export function surfaceDefinition<K extends SurfaceType>(type: K): SurfaceDefinition<K> {
  return DEFINITIONS[type];
}

/** Defaults from the registry, so presenters only say what is specific. */
export function draftDefaults<K extends SurfaceType>(type: K, payload: SurfacePayloads[K]) {
  const d = DEFINITIONS[type];
  return { size: d.size, priority: d.priority, actions: d.actions(payload) };
}

/**
 * The tool call behind a direct action — only for actions the registry declares on this type,
 * with ids taken from the Surface's own payload. The call still goes through the executor.
 */
export function toolForAction(
  surface: Surface,
  action: ActionId,
  itemId: string | null,
): ToolCallSpec | null {
  const def = DEFINITIONS[surface.type] as SurfaceDefinition<SurfaceType>;
  const parsed = PAYLOADS[surface.type].safeParse(surface.payload);
  if (!parsed.success || !def.tool) return null;
  if (!surface.actions.some((a) => a.id === action && a.kind === "tool")) return null;
  return def.tool(parsed.data as never, action, itemId);
}

// ── Validation (on write and on restore) ─────────────────────────────────────

const envelope = z.object({
  id: text(120),
  handle: z.string().regex(/^S\d{1,4}$/),
  type: z.enum(SURFACE_TYPES),
  title: text(300),
  state: z.enum(SURFACE_STATES),
  priority: z.number().min(0).max(100),
  size: z.enum(SURFACE_SIZES),
  source: z.object({ capability: text(40), label: text(200).nullable() }).nullable(),
  ref: z.object({ resource: text(40), id: text(1000) }).nullable(),
  payload: z.unknown(),
  actions: z
    .array(
      z.object({
        id: z.enum(ACTION_IDS),
        kind: z.enum(["link", "prompt", "tool", "expand", "approval"]),
        href: href.optional(),
      }),
    )
    .max(8),
  intentId: text(100).nullable(),
  transient: z.boolean().optional(),
  pinned: z.boolean().optional(),
  compared: z.boolean().optional(),
  focusItem: text(1000).optional(),
  query: z
    .object({
      tool: z.string().regex(/^[a-z]+\.[A-Za-z]+$/),
      args: z.record(z.string(), z.unknown()),
    })
    .optional(),
  dataset: text(600).optional(),
  presentation: z.enum(["list", "timeline", "table"]).optional(),
  members: z.array(text(100)).max(200).optional(),
  changedAt: text(40).optional(),
  turn: z.number().int().min(0),
  createdAt: text(40),
  updatedAt: text(40),
});

export function parseSurface(raw: unknown): Surface | null {
  const e = envelope.safeParse(raw);
  if (!e.success) return null;
  const p = PAYLOADS[e.data.type].safeParse(e.data.payload);
  if (!p.success) return null;
  return { ...(e.data as Surface), payload: p.data };
}

export function isValidPayload(type: SurfaceType, payload: unknown): boolean {
  return PAYLOADS[type].safeParse(payload).success;
}

const intentSchema = z.object({
  id: text(100),
  kind: z.enum(INTENT_KINDS),
  description: text(300),
  startedAt: text(40),
  arrangement: z.literal("time").optional(),
});

const contextSchema = z.object({
  id: text(100),
  name: text(120),
  kind: z.enum(CONTEXT_KINDS),
  accent: text(20).nullable(),
  turn: z.number().int().min(0),
});

/** Stored or remote state → a valid workspace; anything malformed is dropped, never trusted. */
export function parseWorkspace(raw: {
  version?: unknown;
  turn?: unknown;
  intent?: unknown;
  surfaces?: unknown;
  focusId?: unknown;
  nextHandle?: unknown;
  context?: unknown;
}): WorkspaceState {
  const base = emptyWorkspace();
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.map(parseSurface).filter((s): s is Surface => s !== null)
    : [];
  const intent = intentSchema.safeParse(raw.intent);
  const context = contextSchema.safeParse(raw.context);
  const int = (v: unknown, d: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d;
  const handles = surfaces.map((s) => Number(s.handle.slice(1)));
  return {
    version: int(raw.version, base.version),
    turn: int(raw.turn, base.turn),
    intent: intent.success ? intent.data : null,
    context: context.success ? context.data : null,
    surfaces,
    focusId:
      typeof raw.focusId === "string" && surfaces.some((s) => s.id === raw.focusId)
        ? raw.focusId
        : null,
    nextHandle: Math.max(int(raw.nextHandle, 1), ...handles.map((h) => h + 1), 1),
  };
}

// ── Deictic context for the model ────────────────────────────────────────────

/**
 * What the user sees, compactly: handles, titles and the ids needed to act on items, never
 * full payloads. "The second email" resolves to item 2 of the visible email Surface.
 */
/** What "mostramelo" and "mostralas" refer to right now (ADR-031), for the model to see. */
function workingSet(state: WorkspaceState): string | null {
  const changed = state.surfaces
    .filter((s) => s.changedAt)
    .sort((a, b) => b.changedAt!.localeCompare(a.changedAt!))[0];
  const focused = state.surfaces.find((s) => s.id === state.focusId && s.query);
  const collection =
    focused ??
    state.surfaces
      .filter((s) => s.query && s.dataset)
      .sort((a, b) => b.turn - a.turn || b.updatedAt.localeCompare(a.updatedAt))[0];
  const parts = [
    changed ? `last changed: ${changed.handle}` : null,
    collection ? `active collection: ${collection.handle}` : null,
  ].filter(Boolean);
  return parts.length ? `Working set: ${parts.join("; ")}` : null;
}

export function describeWorkspace(state: WorkspaceState, timezone: string): string | null {
  if (!state.surfaces.length) return null;
  const lines = state.surfaces.map((s) => {
    const def = DEFINITIONS[s.type] as SurfaceDefinition<SurfaceType>;
    const flags = [
      s.id === state.focusId && (s.focusItem ? `focused on item ${s.focusItem}` : "focused"),
      s.compared && "compared",
      s.pinned && "pinned",
      s.state !== "ready" && s.state,
      s.presentation && s.presentation !== "list" && `as ${s.presentation}`,
    ].filter(Boolean);
    return `- ${s.handle} ${s.type}${flags.length ? ` [${flags.join(", ")}]` : ""} ${q(s.title)}: ${def.describe(s.payload as never, timezone)}`;
  });
  return [
    state.intent
      ? `Active intent: ${state.intent.kind} — ${q(state.intent.description)}${state.intent.arrangement === "time" ? " (shown in time order)" : ""}`
      : null,
    state.context ? `Active context: ${q(state.context.name)} (${state.context.kind})` : null,
    workingSet(state),
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

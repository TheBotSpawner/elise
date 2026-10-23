import { z } from "zod";

/**
 * Adding devices (ADR-090). The home engine finds devices on the network by itself (mDNS, SSDP,
 * DHCP) and keeps each one as a pending setup until someone confirms it. ELISE lists those,
 * lets the person pick which to add, and walks each one's short setup (a confirmation, or a
 * few fields such as a pairing code). Provider shapes never leave this module: the screen sees
 * ELISE's words only.
 */

/** Setups the engine started on its own after finding something on the network. */
const DISCOVERY_SOURCES = new Set([
  "zeroconf",
  "ssdp",
  "dhcp",
  "homekit",
  "mqtt",
  "usb",
  "integration_discovery",
  "discovery",
  "hassio",
]);

/** What a network has that isn't a device to control: routers' UPnP/IGD gateways. */
const INFRASTRUCTURE = new Set(["upnp"]);

export interface DiscoveredDevice {
  /** The engine's id for this pending setup (opaque). */
  flowId: string;
  /** "Philips Hue", "Living TV (192.168.1.40)". */
  name: string;
  /** The integration it belongs to ("hue", "cast"): for grouping only, never shown raw. */
  kind: string;
  /** ADR-117: a Broadlink locked in its app (unlock it there first). */
  note?: "locked";
}

export type DiscoveryFieldType = "text" | "password" | "number" | "boolean" | "select";

export interface DiscoveryField {
  name: string;
  type: DiscoveryFieldType;
  required: boolean;
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
}

/** One step of adding a device, in ELISE's terms. */
export type DiscoveryStep =
  | { kind: "confirm"; flowId: string; title: string | null }
  | {
      kind: "form";
      flowId: string;
      title: string | null;
      fields: DiscoveryField[];
      /** Field name → the engine's error key ("invalid_auth", "cannot_connect"…). */
      errors: Record<string, string>;
    }
  | { kind: "added"; name: string }
  | { kind: "aborted"; reason: string }
  /** Needs something ELISE can't show yet (a browser sign-in, a progress screen, a menu). */
  | { kind: "unsupported"; reason: string };

const FLOW_ID = /^[0-9A-Za-z_-]{10,64}$/;
export const isFlowId = (id: string) => FLOW_ID.test(id);

const humanize = (s: string) =>
  s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

const progressItem = z.object({
  flow_id: z.string(),
  handler: z.string(),
  context: z
    .object({
      source: z.string().optional(),
      title_placeholders: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

/** The engine's pending setups → what was found on the network, once each. */
export function discoveredDevices(raw: unknown): DiscoveredDevice[] {
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) return [];
  const out = new Map<string, DiscoveredDevice>();
  for (const item of list.data) {
    const p = progressItem.safeParse(item);
    if (!p.success || !isFlowId(p.data.flow_id)) continue;
    const source = p.data.context?.source ?? "";
    if (!DISCOVERY_SOURCES.has(source)) continue;
    // ADR-117: the network's own gear (the router's UPnP gateway) isn't a home device to add.
    if (INFRASTRUCTURE.has(p.data.handler)) continue;
    const placeholders = p.data.context?.title_placeholders ?? {};
    const label = [placeholders.name, placeholders.model, placeholders.host].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    const name = (label ?? humanize(p.data.handler)).slice(0, 80);
    const key = `${p.data.handler}|${name.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { flowId: p.data.flow_id, name, kind: p.data.handler });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const schemaItem = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    required: z.boolean().optional(),
    optional: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.unknown().optional(),
    selector: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** A serialized form field → ELISE's field; null when it's a kind ELISE can't render. */
function field(raw: unknown): DiscoveryField | null {
  const f = schemaItem.safeParse(raw);
  if (!f.success) return null;
  const { name } = f.data;
  const required = f.data.required ?? !f.data.optional;
  const selector = f.data.selector ? Object.keys(f.data.selector)[0] : undefined;
  const type = selector ?? f.data.type;
  const def = f.data.default;
  const defaultValue =
    typeof def === "string" || typeof def === "number" || typeof def === "boolean"
      ? def
      : undefined;
  const base = { name, required, ...(defaultValue !== undefined ? { defaultValue } : {}) };
  if (type === "string" || type === "text") {
    const secret = /pass|pin|code|token|key|secret/i.test(name);
    return { ...base, type: secret ? "password" : "text" };
  }
  if (type === "integer" || type === "float" || type === "number")
    return { ...base, type: "number" };
  if (type === "boolean") return { ...base, type: "boolean" };
  if (type === "select") {
    const opts = Array.isArray(f.data.options) ? f.data.options : [];
    const options = opts.flatMap((o) =>
      Array.isArray(o) && o.length >= 1
        ? [{ value: String(o[0]), label: String(o[1] ?? o[0]) }]
        : typeof o === "string"
          ? [{ value: o, label: o }]
          : [],
    );
    return options.length ? { ...base, type: "select", options } : null;
  }
  return null;
}

const stepSchema = z
  .object({
    type: z.string(),
    flow_id: z.string().optional(),
    step_id: z.string().optional(),
    data_schema: z.array(z.unknown()).nullable().optional(),
    errors: z.record(z.string(), z.string()).nullable().optional(),
    reason: z.string().optional(),
    title: z.string().optional(),
    description_placeholders: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

/** The engine's answer for a setup step → what ELISE shows next. */
export function discoveryStep(raw: unknown, flowId: string): DiscoveryStep {
  const s = stepSchema.safeParse(raw);
  if (!s.success) return { kind: "unsupported", reason: "unknown_step" };
  const placeholders = s.data.description_placeholders ?? {};
  const title =
    [placeholders.name, placeholders.model].find((v): v is string => typeof v === "string") ?? null;
  switch (s.data.type) {
    case "create_entry":
      return { kind: "added", name: (s.data.title ?? title ?? "").slice(0, 80) };
    case "abort":
      return { kind: "aborted", reason: s.data.reason ?? "aborted" };
    case "form": {
      const raws = s.data.data_schema ?? [];
      const fields = raws.map(field);
      if (fields.some((f) => f === null)) return { kind: "unsupported", reason: "form" };
      const usable = fields as DiscoveryField[];
      return usable.length
        ? { kind: "form", flowId, title, fields: usable, errors: s.data.errors ?? {} }
        : { kind: "confirm", flowId, title };
    }
    default:
      // external (browser sign-in), progress, menu, show_progress_done…
      return { kind: "unsupported", reason: s.data.type };
  }
}

/** What the person typed → only the step's own fields, each in its own type. */
export function stepAnswers(
  fields: readonly DiscoveryField[],
  values: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === "") continue;
    if (f.type === "boolean") out[f.name] = v === true || v === "true";
    else if (f.type === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.name] = n;
    } else if (f.type === "select") {
      if (f.options?.some((o) => o.value === String(v))) out[f.name] = String(v);
    } else out[f.name] = String(v).slice(0, 500);
  }
  return out;
}

/**
 * ADR-110: "agregar por IP" — only an address on the home's own network: a private IPv4
 * (10/8, 172.16/12, 192.168/16) or a local host name. Never a URL, a port, a public address or
 * the computer itself: the engine connects to it, so nothing else may get through here.
 */
export function lanHost(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (ip) {
    const [a, b, c, d] = ip.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255) || d === 0 || d === 255) return null;
    const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return lan ? `${a}.${b}.${c}.${d}` : null;
  }
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.local)?$/.test(s) && s !== "localhost" ? s : null;
}

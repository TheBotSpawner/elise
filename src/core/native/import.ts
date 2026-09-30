import { z } from "zod";

import { isIsoDate } from "../time";

/**
 * Native import (docs/architecture/10 §37-43): detect columns → propose a mapping → preview
 * with per-row validation → the user confirms → only valid rows are created, invalid ones are
 * reported with the reason. Nothing is imported on a guess.
 */

export type ImportKind = "habits" | "goals" | "lists";
export const MAX_IMPORT_ROWS = 500;

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Fields each module accepts, with header synonyms (English/Spanish) used for suggestions. */
export const IMPORT_FIELDS: Record<
  ImportKind,
  { key: string; required: boolean; synonyms: string[] }[]
> = {
  habits: [
    {
      key: "name",
      required: true,
      synonyms: ["name", "habit", "habit name", "nombre", "habito", "hábito"],
    },
    {
      key: "frequency",
      required: false,
      synonyms: ["frequency", "frecuencia", "period", "periodo"],
    },
    {
      key: "target",
      required: false,
      synonyms: ["target", "weekly target", "goal", "objetivo", "meta", "times", "veces"],
    },
    { key: "unit", required: false, synonyms: ["unit", "unidad", "units"] },
    { key: "days", required: false, synonyms: ["days", "dias", "días", "weekdays"] },
    {
      key: "description",
      required: false,
      synonyms: ["description", "descripcion", "descripción", "notes", "notas"],
    },
  ],
  goals: [
    {
      key: "title",
      required: true,
      synonyms: ["title", "goal", "name", "titulo", "título", "objetivo", "meta"],
    },
    {
      key: "targetDate",
      required: false,
      synonyms: ["target date", "deadline", "due", "fecha", "fecha limite", "fecha límite"],
    },
    { key: "targetValue", required: false, synonyms: ["target value", "target", "valor objetivo"] },
    {
      key: "currentValue",
      required: false,
      synonyms: ["current value", "current", "progress", "actual", "progreso"],
    },
    {
      key: "metric",
      required: false,
      synonyms: ["metric", "unit", "metrica", "métrica", "unidad"],
    },
    { key: "status", required: false, synonyms: ["status", "estado"] },
    {
      key: "description",
      required: false,
      synonyms: ["description", "descripcion", "descripción", "notes"],
    },
  ],
  lists: [
    {
      key: "item",
      required: true,
      synonyms: ["item", "name", "content", "task", "elemento", "nombre", "articulo", "artículo"],
    },
    {
      key: "list",
      required: false,
      synonyms: ["list", "lista", "category", "categoria", "categoría"],
    },
    {
      key: "checked",
      required: false,
      synonyms: ["checked", "done", "completed", "hecho", "listo", "comprado"],
    },
    { key: "notes", required: false, synonyms: ["notes", "notas", "comment", "comentario"] },
  ],
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** field → column header, by exact synonym first, then containment. Unmapped fields are left out. */
export function suggestMapping(headers: string[], kind: ImportKind): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const pass of ["exact", "contains"] as const) {
    for (const field of IMPORT_FIELDS[kind]) {
      if (mapping[field.key]) continue;
      const header = headers.find((h) => {
        if (used.has(h)) return false;
        const n = norm(h);
        return field.synonyms.some((s) => (pass === "exact" ? n === norm(s) : n.includes(norm(s))));
      });
      if (header) {
        mapping[field.key] = header;
        used.add(header);
      }
    }
  }
  return mapping;
}

// ── Row interpretation (deterministic) ───────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  dom: 0,
  domingo: 0,
  mon: 1,
  monday: 1,
  lun: 1,
  lunes: 1,
  tue: 2,
  tuesday: 2,
  mar: 2,
  martes: 2,
  wed: 3,
  wednesday: 3,
  mie: 3,
  miercoles: 3,
  thu: 4,
  thursday: 4,
  jue: 4,
  jueves: 4,
  fri: 5,
  friday: 5,
  vie: 5,
  viernes: 5,
  sat: 6,
  saturday: 6,
  sab: 6,
  sabado: 6,
};

function parseDays(value: string): number[] | null {
  if (!value.trim()) return [];
  const days = norm(value)
    .split(" ")
    .filter(Boolean)
    .map((d) => DAY_NAMES[d]);
  return days.every((d) => d !== undefined) ? [...new Set(days as number[])].sort() : null;
}

function parseFrequency(
  value: string,
  hasDays: boolean,
): "daily" | "weekly" | "specific_days" | null {
  const v = norm(value);
  if (!v) return hasDays ? "specific_days" : "weekly";
  if (/(daily|day|diari|dia)/.test(v)) return "daily";
  if (/(week|seman)/.test(v)) return "weekly";
  if (/(specific|days|dias)/.test(v)) return "specific_days";
  return null;
}

const number = (value: string) => {
  const n = Number(value.replace(",", ".").replace(/[^\d.-]/g, ""));
  return value.trim() && Number.isFinite(n) ? n : null;
};

const truthy = (value: string) =>
  ["x", "yes", "y", "true", "1", "si", "sí", "done", "hecho"].includes(value.trim().toLowerCase());

export type ImportRecord =
  | {
      kind: "habits";
      name: string;
      description: string | null;
      frequency: "daily" | "weekly" | "specific_days";
      target: number;
      unit: string | null;
      preferredDays: number[];
    }
  | {
      kind: "goals";
      title: string;
      description: string | null;
      targetDate: string | null;
      targetValue: number | null;
      currentValue: number | null;
      metric: string | null;
      status: "active" | "completed" | "paused";
    }
  | { kind: "lists"; list: string; item: string; checked: boolean; notes: string | null };

export interface ImportPreview {
  headers: string[];
  mapping: Record<string, string>;
  valid: { row: number; record: ImportRecord }[];
  invalid: { row: number; errors: string[] }[];
  total: number;
}

export function buildPreview(
  csv: string,
  kind: ImportKind,
  mapping: Record<string, string> | null,
  defaultList = "Imported",
): ImportPreview {
  const rows = parseCsvRows(csv);
  const [headers = [], ...body] = rows;
  const map = mapping ?? suggestMapping(headers, kind);
  const cell = (row: string[], key: string) => {
    const header = map[key];
    const index = header ? headers.indexOf(header) : -1;
    return index >= 0 ? (row[index] ?? "").trim() : "";
  };
  const valid: ImportPreview["valid"] = [];
  const invalid: ImportPreview["invalid"] = [];
  for (const field of IMPORT_FIELDS[kind]) {
    if (field.required && !map[field.key]) {
      return {
        headers,
        mapping: map,
        valid,
        invalid: [{ row: 0, errors: [`Choose a column for "${field.key}"`] }],
        total: body.length,
      };
    }
  }
  body.slice(0, MAX_IMPORT_ROWS).forEach((row, i) => {
    const errors: string[] = [];
    const line = i + 2; // header is line 1
    let record: ImportRecord | null = null;
    if (kind === "habits") {
      const name = cell(row, "name");
      const days = parseDays(cell(row, "days"));
      const frequency = parseFrequency(cell(row, "frequency"), Boolean(days?.length));
      const target = cell(row, "target") ? number(cell(row, "target")) : 1;
      if (!name) errors.push("name is empty");
      if (days === null) errors.push(`days "${cell(row, "days")}" not understood`);
      if (!frequency) errors.push(`frequency "${cell(row, "frequency")}" not understood`);
      if (frequency === "specific_days" && !days?.length)
        errors.push("specific days need a days column");
      if (target === null || target <= 0)
        errors.push(`target "${cell(row, "target")}" is not a positive number`);
      if (!errors.length)
        record = {
          kind,
          name: name.slice(0, 120),
          description: cell(row, "description") || null,
          frequency: frequency!,
          target: target!,
          unit: cell(row, "unit") || null,
          preferredDays: days ?? [],
        };
    } else if (kind === "goals") {
      const title = cell(row, "title");
      const date = cell(row, "targetDate");
      const statusRaw = norm(cell(row, "status"));
      const status =
        !statusRaw || /activ/.test(statusRaw)
          ? "active"
          : /(complet|done|hecho|logrado)/.test(statusRaw)
            ? "completed"
            : /(paus)/.test(statusRaw)
              ? "paused"
              : null;
      if (!title) errors.push("title is empty");
      if (date && !isIsoDate(date)) errors.push(`date "${date}" must be YYYY-MM-DD`);
      if (cell(row, "targetValue") && number(cell(row, "targetValue")) === null)
        errors.push("target value is not a number");
      if (cell(row, "currentValue") && number(cell(row, "currentValue")) === null)
        errors.push("current value is not a number");
      if (!status) errors.push(`status "${cell(row, "status")}" not understood`);
      if (!errors.length)
        record = {
          kind,
          title: title.slice(0, 300),
          description: cell(row, "description") || null,
          targetDate: date || null,
          targetValue: number(cell(row, "targetValue")),
          currentValue: number(cell(row, "currentValue")),
          metric: cell(row, "metric") || null,
          status: status!,
        };
    } else {
      const item = cell(row, "item");
      if (!item) errors.push("item is empty");
      if (!errors.length)
        record = {
          kind,
          list: (cell(row, "list") || defaultList).slice(0, 120),
          item: item.slice(0, 500),
          checked: truthy(cell(row, "checked")),
          notes: cell(row, "notes") || null,
        };
    }
    if (record) valid.push({ row: line, record });
    else invalid.push({ row: line, errors });
  });
  if (body.length > MAX_IMPORT_ROWS) {
    invalid.push({
      row: MAX_IMPORT_ROWS + 2,
      errors: [`Only the first ${MAX_IMPORT_ROWS} rows are imported`],
    });
  }
  return { headers, mapping: map, valid, invalid, total: body.length };
}

export const mappingSchema = z.record(z.string(), z.string());

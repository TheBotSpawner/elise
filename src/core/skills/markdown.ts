import { METHOD_LIMITS, METHOD_PLATFORMS, normalizeHints, type MethodPlatform } from "./model";

/**
 * Human-readable Markdown for Methods (ADR-040 §J3-J4), compatible with the Agent Skills
 * `SKILL.md` layout: YAML frontmatter with `name` (a lowercase slug) and `description`, then the
 * instructions. ELISE's own fields travel under `metadata` as strings, so other tools ignore
 * them and ELISE reads them back. The database never depends on this format.
 */

export interface MethodMarkdown {
  name: string;
  description: string;
  instructions: string;
  hints: string[];
  platforms: MethodPlatform[];
}

/** "Crear propuesta comercial" → "crear-propuesta-comercial" (Agent Skills `name`). */
export function slug(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "") || "method"
  );
}

const quote = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

export function toSkillMarkdown(
  m: Omit<MethodMarkdown, "platforms"> & {
    platforms?: readonly string[];
    scope?: string | null;
    version?: number;
    references?: readonly { kind: string; title: string }[];
  },
): string {
  const meta: [string, string][] = [
    ["elise-title", m.name],
    ...(m.scope ? ([["elise-scope", m.scope]] as [string, string][]) : []),
    ...(m.hints.length ? ([["elise-hints", m.hints.join(", ")]] as [string, string][]) : []),
    ...(m.platforms?.length
      ? ([["elise-platforms", m.platforms.join(", ")]] as [string, string][])
      : []),
    ...(m.version ? ([["elise-version", String(m.version)]] as [string, string][]) : []),
  ];
  const refs = m.references?.length
    ? `\n\n## Supporting material\n${m.references.map((r) => `- ${r.kind}: ${r.title}`).join("\n")}`
    : "";
  return `---
name: ${slug(m.name)}
description: ${quote(m.description)}
metadata:
${meta.map(([k, v]) => `  ${k}: ${quote(v)}`).join("\n")}
---

# ${m.name.trim()}

${m.instructions.trim()}${refs}
`;
}

/** A YAML scalar as written by us or by hand: "quoted", 'quoted' or bare. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Just the frontmatter we use: top-level `key: value` and one nested `metadata:` map. */
function frontmatter(block: string) {
  const top = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMetadata = false;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s+([\w-]+)\s*:\s*(.*)$/.exec(line);
    const flat = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (nested && inMetadata) metadata.set(nested[1]!, scalar(nested[2]!));
    else if (flat) {
      inMetadata = flat[1] === "metadata" && !flat[2]!.trim();
      if (!inMetadata) top.set(flat[1]!, scalar(flat[2]!));
    }
  }
  return { top, metadata };
}

const list = (s: string | undefined) =>
  (s ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => scalar(x))
    .filter(Boolean);

/**
 * Reads a SKILL.md, an exported Method, or plain Markdown/text: the first `# heading` names it
 * (else the file name), the first paragraph describes it, the rest is the procedure.
 */
export function parseSkillMarkdown(text: string, fileName = ""): MethodMarkdown {
  let body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  let fm: ReturnType<typeof frontmatter> | null = null;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (m) {
    fm = frontmatter(m[1]!);
    body = body.slice(m[0].length);
  }
  // Our own export appends the reference list; it isn't part of the procedure.
  body = body.replace(/\n## Supporting material\n(?:- .*\n?)*\s*$/, "\n").trim();
  const heading = /^#\s+(.+)\n?/.exec(body);
  if (heading) body = body.slice(heading[0].length).trim();
  const fromFile = fileName
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/^skill$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const name =
    fm?.metadata.get("elise-title") ||
    heading?.[1]?.trim() ||
    (fm?.top.get("name") ?? "").replace(/-/g, " ") ||
    fromFile ||
    "Method";
  let description = fm?.top.get("description") ?? "";
  if (!description) {
    // The first plain paragraph (not a heading or list) is the "what it's for" line.
    const first = body
      .split(/\n\s*\n/)
      .find((p) => p.trim() && !/^\s*([#>|]|[-*]|\d+[.)])/.test(p));
    description = first?.replace(/\s+/g, " ").trim() ?? name;
  }
  const platforms = list(fm?.metadata.get("elise-platforms")).filter((p): p is MethodPlatform =>
    (METHOD_PLATFORMS as readonly string[]).includes(p),
  );
  return {
    name: name.slice(0, METHOD_LIMITS.name).trim(),
    description: description.slice(0, METHOD_LIMITS.description).trim(),
    instructions: (body || description).slice(0, METHOD_LIMITS.instructions),
    hints: normalizeHints(list(fm?.metadata.get("elise-hints"))),
    platforms: platforms.length ? platforms : ["web"],
  };
}

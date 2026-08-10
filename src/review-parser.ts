// Pure parsing of axis review output into structured findings.
// Zero dependencies by design (mirrors stats.ts): testable without processes.

/** Sentinel token indicating no findings were detected in axis review output. */
export const NO_FINDINGS_TOKEN = "НАХОДОК НЕТ";

/**
 * A structured finding from axis review output with marker type, location, and title.
 * File and line are null for findings without a locatable target (nits, etc.).
 */
export interface Finding {
  axis: string;
  marker: "✗" | "⚠" | "ℹ";
  file: string | null;
  line: number | null;
  lineEnd: number | null;
  title: string;
}

/**
 * Result of parsing a single axis review text.
 * markerLines: count of lines matching marker pattern.
 * parsedLines: count of marker lines that yielded a file:line location.
 * cleanToken: true if NO_FINDINGS_TOKEN is present in the input.
 */
export interface AxisParse {
  findings: Finding[];
  markerLines: number;
  parsedLines: number;
  cleanToken: boolean;
}

// Marker not anchored to col 0: real Composer output wraps findings in list
// markers / headings / bold ("- ✗ **...**", "### ⚠ ...") — 2026-07-19 corpus;
// numbered lists ("1. ✗ ...", "2) ⚠ ...") — final-review backlog 2026-07-20.
const MARKER_RE = /^\s*(?:(?:[-*#>]+|\d+[.)])\s*)*([✗⚠ℹ])\s*(.*)$/u;
// Location candidates; optional ":§N" segment between file and line covers the
// real "design.md:§7:148" citation shape. A candidate is accepted only if it
// looks like a path (contains "/" or ends with a dot-extension) — rejects
// decoys like config:8080 and bare "§7:148".
const LOC_RE = /([\w./-]+)(?::§\d+)?:(\d+)(?:-(\d+))?/gu;

function pathLike(s: string): boolean {
  return s.includes("/") || /\.\w+$/.test(s);
}

export function extractLocation(rest: string): { file: string; line: number; lineEnd: number | null } | null {
  for (const m of rest.matchAll(LOC_RE)) {
    const file = m[1]!;
    if (!pathLike(file)) continue;
    return { file, line: Number(m[2]), lineEnd: m[3] !== undefined ? Number(m[3]) : null };
  }
  return null;
}

/**
 * Parse axis review text to extract structured findings.
 * Handles real Composer 2026-07-19 shapes: markers with optional prefixes (-, *, #),
 * bold text (**), file:line locations with optional line ranges, and §-section refs.
 * Filters decoys (config:8080, bare §7 refs) via pathLike() check.
 */
export function parseAxis(axis: string, text: string): AxisParse {
  const findings: Finding[] = [];
  let markerLines = 0;
  let parsedLines = 0;
  for (const lineText of text.split("\n")) {
    const m = MARKER_RE.exec(lineText);
    if (!m) continue;
    markerLines += 1;
    const rest = m[2]!.replaceAll("**", "");
    // The brief's canonical shape is "<title> — <file:line> — ..." — try the
    // second field first so a path-like decoy in the title (api.example.com:8080)
    // can't shadow the real location; fall back to scanning the whole line.
    const fields = rest.split(" — ");
    const loc = (fields.length > 1 ? extractLocation(fields[1]!) : null) ?? extractLocation(rest);
    if (loc) parsedLines += 1;
    const dash = rest.indexOf(" — ");
    findings.push({
      axis,
      marker: m[1] as Finding["marker"],
      file: loc?.file ?? null,
      line: loc?.line ?? null,
      lineEnd: loc?.lineEnd ?? null,
      title: (dash >= 0 ? rest.slice(0, dash) : rest).trim(),
    });
  }
  // Standalone-line match only: the brief's legend quotes the token in prose,
  // so a substring check would fake a clean pass on echoed instructions.
  // Trailing [.!] tolerated — models add a period; prose continuations don't count.
  const cleanToken = new RegExp(`^\\s*${NO_FINDINGS_TOKEN}\\s*[.!]?\\s*$`, "mu").test(text);
  return { findings, markerLines, parsedLines, cleanToken };
}

// Same file cited in different forms across axes: briefs pass absolute paths,
// models cite relative ones (proven by the first real run). Two citations match
// when one is a whole-segment suffix of the other; the common tail is the
// agreed-upon form and becomes the group's file.
function commonTail(a: string, b: string): string | null {
  if (a === b) return a;
  if (a.endsWith("/" + b)) return b;
  if (b.endsWith("/" + a)) return a;
  return null;
}

/**
 * Detect overlapping findings across axes (spec §7).
 * Pairwise matching only: |Δline| <= tolerance must hold for EVERY reported pair.
 * No transitive chaining: 0/10/20 with tolerance 10 yields two groups (0-10, 10-20),
 * not one, because the pair (0,20) violates the predicate.
 * Files match by whole-segment path suffix (absolute↔relative forms of the same file).
 * Groups are deduplicated by exact (common tail, minLine) key to preserve pairwise property.
 */
export function computeOverlap(
  findings: Finding[],
  toleranceLines = 10,
): Array<{ file: string; line: number; axes: string[] }> {
  const out: Array<{ file: string; line: number; axes: string[] }> = [];
  const located = findings.filter((f) => f.file !== null && f.line !== null);
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      const a = located[i]!;
      const b = located[j]!;
      if (a.axis === b.axis) continue;
      const tail = commonTail(a.file as string, b.file as string);
      if (tail === null) continue;
      if (Math.abs((a.line as number) - (b.line as number)) > toleranceLines) continue;
      const line = Math.min(a.line as number, b.line as number);
      const existing = out.find((o) => o.file === tail && o.line === line);
      if (existing) {
        for (const ax of [a.axis, b.axis]) if (!existing.axes.includes(ax)) existing.axes.push(ax);
        existing.axes.sort();
      } else {
        out.push({ file: tail, line, axes: [a.axis, b.axis].sort() });
      }
    }
  }
  return out;
}

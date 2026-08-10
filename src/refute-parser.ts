// Pure parsing of refuter role output into per-finding verdicts.
// Zero process deps by design (mirrors review-parser.ts).

import { extractLocation } from "./review-parser.ts";

/** Quotes shorter than this after normalization can't anchor a verdict. */
export const MIN_QUOTE_CHARS = 12;
/** ...and they must carry at least this many identifier-ish characters:
 *  a `////////` fence passes the length check while proving nothing. */
export const MIN_QUOTE_WORD_CHARS = 8;
/** The quote must occur within this many lines of the cited line number. */
export const QUOTE_LINE_TOL = 20;

export function normalizeQuote(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/**
 * Whitespace-tolerant literal containment ANCHORED to the cited line: the quote
 * must occur inside the ±QUOTE_LINE_TOL window around `line`. A hit anywhere
 * else in the file proves nothing (a trivial fragment exists everywhere), and a
 * verdict with no line number can't be verified at all. The quote must also be
 * substantive (MIN_QUOTE_WORD_CHARS of word characters).
 */
export function quoteMatches(quote: string, fileText: string, line: number | null): boolean {
  if (line === null || line < 1) return false; // file:0 is not a coordinate
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  if ((q.match(/[\p{L}\p{N}_]/gu) ?? []).length < MIN_QUOTE_WORD_CHARS) return false;
  const lines = fileText.split("\n");
  const from = Math.max(0, line - 1 - QUOTE_LINE_TOL);
  const window = lines.slice(from, line + QUOTE_LINE_TOL).join("\n");
  return normalizeQuote(window).includes(q);
}

export const REFUTE_VERDICTS = ["CONFIRMED", "REFUTED", "UNCLEAR"] as const;
export type RefuteVerdictWord = (typeof REFUTE_VERDICTS)[number];

/** One role's verdict on one finding. quoteVerified is null until the manager checks it. */
export interface RoleVerdict {
  verdict: RefuteVerdictWord;
  file: string | null;
  line: number | null;
  quote: string | null;
  reason: string;
  quoteVerified: boolean | null;
}

export interface RoleParse {
  verdicts: Record<string, RoleVerdict>;
  missing: string[];
  duplicates: string[];
  /** >50% of input ids have no verdict line — answer is unusable as a whole. */
  parseDegraded: boolean;
}

// Same list-prefix tolerance as review-parser MARKER_RE (real Composer shapes),
// plus a leading table pipe: models sometimes format verdicts as markdown rows.
const PREFIX_RE = /^\s*\|?\s*(?:(?:[-*#>]+|\d+[.)])\s+)*/u;
// Quotes in guillemets, backticks, or straight quotes — pairs matched BY TYPE:
// «…» may legally contain string literals with `"` inside (cycle 4). Straight
// quotes with nested `"` are unparseable — the brief mandates «…» for that.
const QUOTE_RE = /«([^«»]+)»|`([^`]+)`|"([^"]+)"/u;
// Full quoted spans, for masking quotes out of conflict detection.
const QUOTE_SPAN_RE = /«[^«»]*»|`[^`]*`|"[^"]*"/gu;
/** First quoted span's content, whichever quote type matched. */
function extractQuote(s: string): string | null {
  const m = QUOTE_RE.exec(s);
  return m === null ? null : (m[1] ?? m[2] ?? m[3])!.trim();
}

export function parseRoleVerdicts(text: string, ids: readonly string[]): RoleParse {
  // Object.create(null): a finding id equal to an Object.prototype key
  // ("constructor", "toString", "valueOf", "hasOwnProperty"…) must not resolve
  // to the inherited function instead of undefined — that silently corrupts
  // verdicts[id] lookups and the missing-count derived from them.
  const verdicts: Record<string, RoleVerdict> = Object.create(null) as Record<string, RoleVerdict>;
  const duplicates: string[] = [];
  for (const rawLine of text.split("\n")) {
    // rawTail keeps ** intact: stripping bold from the whole line corrupts
    // legal code inside quotes (`score ** 2`) — bold is only relevant around
    // the id/verdict zone.
    const raw = rawLine.replace(PREFIX_RE, "");
    const line = raw.replaceAll("**", "");
    // Anchor: line starts with a known id followed by a separator. "-" is a valid
    // separator, so a short id matches its own hyphenated extension (AUTH matches
    // "AUTH-BYPASS — ...") — the LONGEST matching id must win.
    const candidates = ids.filter((i) => line.startsWith(i) && /[\s—:|-]/u.test(line.charAt(i.length)));
    if (candidates.length === 0) continue;
    const id = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    const rest = line.slice(id.length);
    // Conflict detection counts verdict words OUTSIDE quote spans: a token like
    // UNCLEAR inside cited code is not the model doubting itself.
    const restNoQuotes = rest.replace(QUOTE_SPAN_RE, "«»");
    const words = [...new Set([...restNoQuotes.matchAll(/\b(CONFIRMED|REFUTED|UNCLEAR)\b/gu)].map((m) => m[1]!))];
    if (words.length === 0) continue;
    // Several DIFFERENT verdict words in ONE line ("REFUTED … но итог UNCLEAR"):
    // the first word must not beat an explicit doubt in the tail.
    const conflictInLine = words.length > 1;
    const verdict = conflictInLine ? "UNCLEAR" : (words[0] as RefuteVerdictWord);
    const prev = verdicts[id];
    if (prev !== undefined) {
      duplicates.push(id);
      // Same word repeated: first line wins. A DIFFERENT word is the model
      // correcting itself — silently keeping the first would auto-close against
      // the correction, so the role's verdict degrades to UNCLEAR.
      if (prev.verdict !== verdict) {
        verdicts[id] = {
          verdict: "UNCLEAR", file: null, line: null, quote: null,
          reason: "conflicting verdict lines", quoteVerified: null,
        };
      }
      continue;
    }
    if (conflictInLine) {
      verdicts[id] = {
        verdict: "UNCLEAR", file: null, line: null, quote: null,
        reason: "conflicting verdict words in one line", quoteVerified: null,
      };
      continue;
    }
    // Tail starts AFTER the chosen verdict word — an early quote in the title
    // zone must not fill the mandatory citation slot. `verdict` is a plain word,
    // so its first occurrence index is the same in detect and raw domains up to
    // stripped "**"; locate it independently in each.
    const tail = rest.slice(rest.indexOf(verdict) + verdict.length);
    const rawTail = raw.slice(raw.indexOf(verdict) + verdict.length);
    const loc = extractLocation(tail);
    const reason = (tail.split(" — ").at(-1) ?? "").trim();
    // A bare UNCLEAR with no reason is not a verdict (spec §6): it counts as
    // missing and feeds the parse_degraded diligence stats — a role spamming
    // naked UNCLEARs degrades and kills the pack's auto-closes. "No reason"
    // means no word characters — a dangling "—" is not an explanation (cycle 6).
    if (verdict === "UNCLEAR" && !/[\p{L}\p{N}]/u.test(reason)) continue;
    // Quote from the RAW tail (bold intact) — see comment above.
    verdicts[id] = {
      verdict,
      file: loc?.file ?? null,
      line: loc?.line ?? null,
      quote: extractQuote(rawTail),
      reason,
      quoteVerified: null,
    };
  }
  const missing = ids.filter((i) => verdicts[i] === undefined);
  return { verdicts, missing, duplicates, parseDegraded: missing.length * 2 > ids.length };
}

export type Consensus = "confirmed" | "refuted" | "escalate";
export type EscalateReason =
  | "disagreement" | "unclear" | "citation_failed" | "missing_verdict"
  | "degraded_role" | "cwd_changed"; // cwd_changed is assigned by the manager, not here
export interface ConsensusResult {
  consensus: Consensus;
  escalateReason?: EscalateReason;
  confidenceLowered?: true;
}

// Deliberate asymmetry (spec §7): "refuted" closes a record, so it demands the
// strongest agreement; anything short of two verified verdicts escalates.
// Degradation is PER-ROLE: only the verdict of a NON-degraded role may lower
// confidence — a role that ignored most of the pack earns no trust for the
// verdicts it did drop.
export function computeConsensus(
  p: RoleVerdict | null,
  a: RoleVerdict | null,
  degraded: { p: boolean; a: boolean },
): ConsensusResult {
  if (degraded.p || degraded.a) {
    const survivor = degraded.p ? (degraded.a ? null : a) : p;
    const lowered = survivor !== null && survivor.verdict === "REFUTED" && survivor.quoteVerified === true;
    return lowered
      ? { consensus: "escalate", escalateReason: "degraded_role", confidenceLowered: true }
      : { consensus: "escalate", escalateReason: "degraded_role" };
  }
  if (p === null || a === null) return { consensus: "escalate", escalateReason: "missing_verdict" };
  // A CONFIRMED/REFUTED whose citation failed the machine check degrades to
  // UNCLEAR for consensus purposes (needs-repro rule, spec §6).
  const eff = (x: RoleVerdict): RefuteVerdictWord =>
    x.verdict !== "UNCLEAR" && x.quoteVerified !== true ? "UNCLEAR" : x.verdict;
  const pe = eff(p);
  const ae = eff(a);
  if (pe === "CONFIRMED" && ae === "CONFIRMED") return { consensus: "confirmed" };
  if (pe === "REFUTED" && ae === "REFUTED") return { consensus: "refuted" };
  if (pe !== "UNCLEAR" && ae !== "UNCLEAR") return { consensus: "escalate", escalateReason: "disagreement" };
  const downgraded = (p.verdict !== "UNCLEAR" && pe === "UNCLEAR") || (a.verdict !== "UNCLEAR" && ae === "UNCLEAR");
  return { consensus: "escalate", escalateReason: downgraded ? "citation_failed" : "unclear" };
}

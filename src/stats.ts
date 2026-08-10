import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { lastRecordTs, SEGMENT_RE, TERMINAL_STATUSES } from "./telemetry.ts";

export interface TelemetryRecord {
  ts: string;
  kind: string;
  [k: string]: unknown;
}

const ACTIVE = "telemetry.jsonl";

export async function loadTelemetryRecords(
  logsDir: string,
  opts: { days?: number; now?: number } = {},
): Promise<{ records: TelemetryRecord[]; corruptLines: number; segmentsRead: number; segmentsSkipped: number }> {
  const days = opts.days ?? 7;
  const cutoff = (opts.now ?? Date.now()) - days * 86_400_000;
  let files: string[] = [];
  try {
    files = (await readdir(logsDir)).filter((f) => f === ACTIVE || SEGMENT_RE.test(f));
  } catch {
    return { records: [], corruptLines: 0, segmentsRead: 0, segmentsSkipped: 0 };
  }
  const records: TelemetryRecord[] = [];
  let corruptLines = 0;
  let segmentsRead = 0;
  let segmentsSkipped = 0;
  for (const f of files) {
    const full = path.join(logsDir, f);
    if (f !== ACTIVE) {
      // segments are append-ordered: the last record is the newest, so a last-ts
      // below the cutoff means the whole segment is out of window — skip the read
      // entirely. null (unparseable last line) is treated as "unknown" — read fully
      // so the tolerant loader still counts its corrupt lines.
      const last = await lastRecordTs(full);
      if (last !== null && last < cutoff) {
        segmentsSkipped += 1;
        continue;
      }
      segmentsRead += 1;
    }
    let body = "";
    try {
      body = await readFile(full, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as TelemetryRecord;
        const ts = Date.parse(r.ts ?? "");
        if (Number.isNaN(ts)) {
          corruptLines += 1;
        } else if (ts >= cutoff) {
          records.push(r);
        }
      } catch {
        corruptLines += 1;
      }
    }
  }
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { records, corruptLines, segmentsRead, segmentsSkipped };
}

/** Nearest-rank percentile of a sorted-ascending array. Empty input → NaN (not undefined-as-number). */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[idx]!;
}

export function normalizeError(e: string): string {
  return e
    .replace(/^watchdog: (idle-timeout|hard-timeout|first-token-timeout).*$/, "watchdog: $1")
    .replace(/(?<![A-Za-z0-9_])\/[^\s):;,]+/g, "<path>");
}

const MIN_N = 5;

export interface Stats {
  tool_calls: Record<string, { count: number; errors: number }>;
  jobs: {
    by_status: Record<string, number>;
    by_mode: Record<string, number>;
    by_isolation: Record<string, number>;
  };
  signals: Record<string, number>;
  durations: Record<string, { count: number; p50: number | null; p95: number | null }>;
  top_errors: Array<{ error: string; count: number }>;
}

export function aggregate(records: TelemetryRecord[]): Stats {
  const toolCalls: Stats["tool_calls"] = {};
  const durationsRaw = new Map<string, number[]>();
  const byStatus: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const byIsolation: Record<string, number> = {};
  const signals: Record<string, number> = {};
  const errors = new Map<string, number>();

  const bump = (m: Record<string, number>, k: unknown) => {
    if (typeof k === "string" && k) m[k] = (m[k] ?? 0) + 1;
  };
  const dur = (key: string, ms: unknown) => {
    if (typeof ms !== "number") return;
    if (!durationsRaw.has(key)) durationsRaw.set(key, []);
    durationsRaw.get(key)!.push(ms);
  };
  const err = (e: unknown) => {
    if (typeof e !== "string" || !e) return;
    const n = normalizeError(e);
    errors.set(n, (errors.get(n) ?? 0) + 1);
  };

  for (const r of records) {
    if (r.kind === "tool_call") {
      const tool = typeof r.tool === "string" ? r.tool : "unknown";
      toolCalls[tool] ??= { count: 0, errors: 0 };
      toolCalls[tool].count += 1;
      if (r.ok === false) {
        toolCalls[tool].errors += 1;
        err(r.error);
      }
      dur(tool, r.duration_ms);
    } else if (r.kind === "job") {
      if (typeof r.transition === "string" && TERMINAL_STATUSES.has(r.transition)) {
        bump(byStatus, r.status);
        bump(byMode, r.mode);
        bump(byIsolation, r.isolation);
        if (typeof r.elapsed_sec === "number") dur("job", r.elapsed_sec * 1000);
        err(r.errorText);
      }
    } else if (r.kind === "signal") {
      bump(signals, r.signal);
    }
  }

  const durations: Stats["durations"] = {};
  for (const [k, arr] of durationsRaw) {
    arr.sort((a, b) => a - b);
    durations[k] =
      arr.length < MIN_N
        ? { count: arr.length, p50: null, p95: null }
        : { count: arr.length, p50: percentile(arr, 50), p95: percentile(arr, 95) };
  }

  const top_errors = [...errors.entries()]
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { tool_calls: toolCalls, jobs: { by_status: byStatus, by_mode: byMode, by_isolation: byIsolation }, signals, durations, top_errors };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregate, loadTelemetryRecords, normalizeError, percentile } from "../src/stats.ts";

const rec = (kind: string, extra: Record<string, unknown>, ageMs = 0) =>
  JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), kind, ...extra });

test("loader: reads active + segments, honors days window by ts, counts corrupt lines", async () => {
  const logsDir = mkdtempSync(path.join(tmpdir(), "cbstats-"));
  writeFileSync(
    path.join(logsDir, "telemetry.jsonl"),
    [rec("tool_call", { tool: "cursor_ask" }), "NOT JSON", rec("job", { transition: "completed" }, 10 * 86_400_000)].join("\n") + "\n",
  );
  writeFileSync(path.join(logsDir, "telemetry-1.jsonl"), rec("signal", { signal: "cancel" }) + "\n");
  const { records, corruptLines, segmentsRead } = await loadTelemetryRecords(logsDir, { days: 7 });
  assert.equal(records.length, 2); // 10-day-old record filtered out
  assert.equal(corruptLines, 1);
  assert.equal(segmentsRead, 1);
});

test("loader: segment fully outside window is skipped without being read (corrupt middle line not counted)", async () => {
  const logsDir = mkdtempSync(path.join(tmpdir(), "cbstats-"));
  writeFileSync(path.join(logsDir, "telemetry.jsonl"), rec("tool_call", { tool: "cursor_ask" }) + "\n");
  const oldAge = 10 * 86_400_000;
  writeFileSync(
    path.join(logsDir, "telemetry-1.jsonl"),
    [rec("job", { transition: "completed" }, oldAge), "NOT JSON", rec("job", { transition: "completed" }, oldAge)].join("\n") + "\n",
  );
  const { records, corruptLines, segmentsRead, segmentsSkipped } = await loadTelemetryRecords(logsDir, { days: 7 });
  assert.equal(corruptLines, 0, "corrupt line in skipped segment must not be read/counted");
  assert.equal(segmentsSkipped, 1);
  assert.equal(segmentsRead, 0);
  assert.equal(records.length, 1, "active file record still loaded");
});

test("loader: segment whose last record is inside the window is fully read; only in-window records returned", async () => {
  const logsDir = mkdtempSync(path.join(tmpdir(), "cbstats-"));
  writeFileSync(
    path.join(logsDir, "telemetry-1.jsonl"),
    [rec("job", { transition: "completed" }, 10 * 86_400_000), rec("job", { transition: "completed" }, 0)].join("\n") + "\n",
  );
  const { records, segmentsRead, segmentsSkipped } = await loadTelemetryRecords(logsDir, { days: 7 });
  assert.equal(segmentsRead, 1);
  assert.equal(segmentsSkipped, 0);
  assert.equal(records.length, 1, "only the in-window record is returned");
});

test("percentile: nearest-rank (helper-only semantics — null-under-5 is aggregate()'s policy, not percentile()'s)", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(percentile([7], 95), 7);
});

test("percentile([]) returns NaN rather than undefined-as-number", () => {
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("normalizeError strips paths and watchdog timings", () => {
  assert.equal(normalizeError("watchdog: idle-timeout after 42s"), "watchdog: idle-timeout");
  assert.equal(normalizeError("watchdog: first-token-timeout after 189s (no first token)"), "watchdog: first-token-timeout");
  assert.equal(
    normalizeError("refusing in-place edit on a dirty work tree (/Users/x/proj); commit/stash first"),
    "refusing in-place edit on a dirty work tree (<path>); commit/stash first",
  );
  assert.equal(normalizeError("cannot access /tmp"), "cannot access <path>");
  assert.equal(normalizeError("boom /tmp/a"), "boom <path>");
});

test("aggregate: counters, null percentiles under n=5, top_errors normalized", () => {
  const records = [
    ...Array.from({ length: 3 }, (_, i) =>
      JSON.parse(rec("tool_call", { tool: "cursor_run", ok: true, duration_ms: 10 + i })),
    ),
    JSON.parse(rec("tool_call", { tool: "cursor_run", ok: false, error: "boom /tmp/a", duration_ms: 99 })),
    JSON.parse(rec("tool_call", { tool: "cursor_ask", ok: false, error: "boom /tmp/b", duration_ms: 5 })),
    JSON.parse(rec("job", { transition: "completed", status: "completed", mode: "edit", isolation: "inplace", elapsed_sec: 4 })),
    JSON.parse(rec("job", { transition: "working", status: "working", mode: "edit", isolation: "inplace" })),
    JSON.parse(rec("signal", { signal: "watchdog_kill" })),
    JSON.parse(rec("signal", { signal: "watchdog_kill" })),
  ];
  const s = aggregate(records);
  assert.deepEqual(s.tool_calls.cursor_run, { count: 4, errors: 1 });
  assert.equal(s.jobs.by_status.completed, 1); // terminal transitions only
  assert.equal(s.signals.watchdog_kill, 2);
  assert.equal(s.durations.cursor_run!.count, 4);
  assert.equal(s.durations.cursor_run!.p50, null); // n < 5
  assert.equal(s.durations.job!.count, 1);
  assert.equal(s.top_errors[0]!.error, "boom <path>");
  assert.equal(s.top_errors[0]!.count, 2); // normalized dedup
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Telemetry } from "../src/telemetry.ts";

function mk(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cbtel-"));
  const logsDir = path.join(root, "logs");
  const jobsDir = path.join(root, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  return { root, logsDir, jobsDir, tel: new Telemetry({ logsDir, jobsDir, enabled: true, ...over }) };
}

function lines(logsDir: string, file = "telemetry.jsonl"): string[] {
  return readFileSync(path.join(logsDir, file), "utf8").split("\n").filter((l) => l.trim());
}

test("concurrent records serialize into valid one-per-line NDJSON", async () => {
  const { logsDir, tel } = mk();
  const big = "x".repeat(5_000);
  for (let i = 0; i < 100; i++) tel.record("tool_call", { i, big });
  await tel.flush(5_000);
  const ls = lines(logsDir);
  assert.equal(ls.length, 100);
  for (const l of ls) {
    const r = JSON.parse(l); // throws on interleaved corruption
    assert.equal(r.kind, "tool_call");
    assert.ok(typeof r.ts === "string" && !Number.isNaN(Date.parse(r.ts)));
  }
});

test("string fields over the cap are truncated and record flagged", async () => {
  const { logsDir, tel } = mk({ maxFieldChars: 100 });
  tel.record("tool_call", { small: "ok", nested: { huge: "y".repeat(500) } });
  await tel.flush();
  const r = JSON.parse(lines(logsDir)[0]!);
  assert.equal(r.truncated, true);
  assert.ok((r.nested.huge as string).length < 200);
  assert.equal(r.small, "ok");
});

test("inline rotation: exceeding rotateBytes creates a segment and resets active file", async () => {
  const { logsDir, tel } = mk({ rotateBytes: 500 });
  for (let i = 0; i < 10; i++) tel.record("job", { pad: "z".repeat(100) });
  await tel.flush(5_000);
  const segs = readdirSync(logsDir).filter((f) => /^telemetry-\d+(-\d+)?\.jsonl$/.test(f));
  assert.ok(segs.length >= 1, "at least one segment after overflow");
  const total = segs.reduce((n, s) => n + lines(logsDir, s).length, 0) + lines(logsDir).length;
  assert.equal(total, 10, "no records lost across rotation");
});

test("janitor: no watermark → deletes nothing; with watermark → ts-based deletion, active jobs skipped", async () => {
  const { logsDir, jobsDir, tel } = mk({ activeJobIds: () => ["live1"] });
  mkdirSync(logsDir, { recursive: true });
  const old = new Date(Date.now() - 86_400_000).toISOString();
  // "fresh" must be NEWER than the watermark markAnalyzed() will set below — use future ts,
  // otherwise a correct janitor would rightfully delete it and the keep-assertion fails
  const fresh = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(path.join(logsDir, "telemetry-1.jsonl"), JSON.stringify({ ts: old, kind: "job" }) + "\n");
  writeFileSync(path.join(logsDir, "telemetry-2.jsonl"), JSON.stringify({ ts: fresh, kind: "job" }) + "\n");
  // adversarial mtimes prove retention is ts-based, not mtime-based:
  // old-ts segment gets a FRESH mtime (must still be deleted), fresh-ts segment gets an OLD mtime (must be kept)
  utimesSync(path.join(logsDir, "telemetry-1.jsonl"), new Date(), new Date());
  const oldDate = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(path.join(logsDir, "telemetry-2.jsonl"), oldDate, oldDate);
  // three job dirs: terminal-old, terminal-old-but-active, working-old
  for (const [id, status] of [["dead1", "completed"], ["live1", "completed"], ["run1", "working"]] as const) {
    mkdirSync(path.join(jobsDir, id));
    writeFileSync(
      path.join(jobsDir, id, "meta.json"),
      JSON.stringify({ status, endedAt: status === "working" ? null : Date.now() - 86_400_000 }),
    );
  }
  await tel.startup(); // no watermark yet
  assert.ok(existsSync(path.join(logsDir, "telemetry-1.jsonl")), "nothing deleted without watermark");
  assert.ok(existsSync(path.join(jobsDir, "dead1")));

  await tel.markAnalyzed(); // watermark = now
  await tel.startup();
  assert.ok(!existsSync(path.join(logsDir, "telemetry-1.jsonl")), "old segment deleted");
  assert.ok(existsSync(path.join(logsDir, "telemetry-2.jsonl")), "fresh segment kept");
  assert.ok(!existsSync(path.join(jobsDir, "dead1")), "terminal old job deleted");
  assert.ok(existsSync(path.join(jobsDir, "live1")), "active job skipped despite terminal meta");
  assert.ok(existsSync(path.join(jobsDir, "run1")), "non-terminal meta kept");
});

test("disabled telemetry is a no-op", async () => {
  const { logsDir, tel } = mk({ enabled: false });
  tel.record("tool_call", { a: 1 });
  await tel.flush();
  await tel.startup();
  assert.ok(!existsSync(path.join(logsDir, "telemetry.jsonl")));
});

test("CURSOR_BRIDGE_TELEMETRY=off disables via env default", async () => {
  process.env.CURSOR_BRIDGE_TELEMETRY = "off";
  try {
    const root = mkdtempSync(path.join(tmpdir(), "cbtelenv-"));
    const tel = new Telemetry({ logsDir: path.join(root, "logs"), jobsDir: path.join(root, "jobs") });
    assert.equal(tel.enabled, false);
    tel.record("tool_call", { a: 1 });
    await tel.flush();
    assert.ok(!existsSync(path.join(root, "logs", "telemetry.jsonl")));
  } finally {
    delete process.env.CURSOR_BRIDGE_TELEMETRY;
  }
});

test("disabled telemetry: destructive/read APIs are no-ops or reject, not silent successes", async () => {
  const { tel } = mk({ enabled: false });
  await assert.rejects(tel.markAnalyzed(), /disabled/);
  assert.deepEqual(await tel.listDeletable(), { segments: [], jobs: [] });
  assert.equal(await tel.watermark(), null);
});

test("listDeletable previews without deleting", async () => {
  const { logsDir, jobsDir, tel } = mk();
  mkdirSync(logsDir, { recursive: true });
  const old = new Date(Date.now() - 86_400_000).toISOString();
  writeFileSync(path.join(logsDir, "telemetry-1.jsonl"), JSON.stringify({ ts: old, kind: "job" }) + "\n");
  mkdirSync(path.join(jobsDir, "dead1"));
  writeFileSync(path.join(jobsDir, "dead1", "meta.json"), JSON.stringify({ status: "failed", endedAt: Date.now() - 86_400_000 }));
  await tel.markAnalyzed();
  const d = await tel.listDeletable();
  assert.deepEqual(d.segments, ["telemetry-1.jsonl"]);
  assert.deepEqual(d.jobs, ["dead1"]);
  assert.ok(existsSync(path.join(logsDir, "telemetry-1.jsonl")), "preview must not delete");
});

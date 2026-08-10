import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobManager } from "../src/job-manager.ts";
import { Telemetry } from "../src/telemetry.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-agent.mjs");
const spawnCfg = { bin: process.execPath, binArgs: [FAKE] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mk(over: Record<string, unknown> = {}) {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "cbjobs-"));
  return new JobManager({ jobsDir, spawnCfg, idleTimeoutMs: 1_000, ...over });
}

async function waitDone(jm: JobManager, id: string) {
  for (let i = 0; i < 200; i++) {
    const s = jm.status(id).status;
    if (s !== "queued" && s !== "working") return s;
    await sleep(25);
  }
  throw new Error("job never finished");
}

async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 5_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

function gitRepo(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cbrepo-"));
  execFileSync("git", ["init", "-q", "."], { cwd: d });
  return d;
}

test("happy path: submit → completed with result and journal", async () => {
  const jm = mk();
  const { jobId, chatId } = await jm.submit({ prompt: "[OK] do", cwd: process.cwd(), mode: "plan" });
  assert.equal(chatId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(await waitDone(jm, jobId), "completed");
  const r = await jm.result(jobId);
  assert.equal(r.resultText, "final answer");
  assert.equal(r.status, "completed");
});

test("plan mode: result prefers the createPlanToolCall plan artifact over result narration", async () => {
  const jm = mk();
  const { jobId } = await jm.submit({ prompt: "[PLAN] p", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, jobId);
  assert.equal((await jm.result(jobId)).resultText, "# THE PLAN\n1. step");
});

test("empty-string result falls back to assistantText", async () => {
  const jm = mk();
  const { jobId } = await jm.submit({ prompt: "[EMPTY-RESULT] r", cwd: process.cwd(), mode: "ask" });
  assert.equal(await waitDone(jm, jobId), "completed");
  assert.equal((await jm.result(jobId)).resultText, "✗ Утекшая находка — src/leak.ts:5 — сценарий — гейт");
});

test("whitespace-only result falls back to assistantText", async () => {
  const jm = mk();
  const { jobId } = await jm.submit({ prompt: "[BLANK-RESULT] r", cwd: process.cwd(), mode: "ask" });
  assert.equal(await waitDone(jm, jobId), "completed");
  assert.equal((await jm.result(jobId)).resultText, "✗ Утекшая находка — src/leak.ts:5 — сценарий — гейт");
});

test("ask: empty-string result falls back to assistantText (parity with submit path)", async () => {
  const jm = mk();
  assert.equal(
    await jm.ask("[EMPTY-RESULT] q", process.cwd()),
    "✗ Утекшая находка — src/leak.ts:5 — сценарий — гейт",
  );
});

test("journal files are written", async () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "cbjjj-"));
  const jm = new JobManager({ jobsDir, spawnCfg, idleTimeoutMs: 1_000 });
  const { jobId } = await jm.submit({ prompt: "[OK] j", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, jobId);
  await waitUntil(() => {
    try {
      return JSON.parse(readFileSync(path.join(jobsDir, jobId, "meta.json"), "utf8")).status === "completed";
    } catch {
      return false;
    }
  });
  assert.ok(existsSync(path.join(jobsDir, jobId, "events.jsonl")));
  const meta = JSON.parse(readFileSync(path.join(jobsDir, jobId, "meta.json"), "utf8"));
  assert.equal(meta.status, "completed");
});

test("concurrency cap 3: fourth job queues, cancel of running frees a slot", async () => {
  const jm = mk({ maxConcurrent: 3, idleTimeoutMs: 60_000 });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    ids.push((await jm.submit({ prompt: "[HANG] w" + i, cwd: process.cwd(), mode: "plan" })).jobId);
  }
  await waitUntil(
    () =>
      ids.slice(0, 3).every((i) => jm.status(i).status === "working") &&
      jm.status(ids[3]!).status === "queued",
  );
  assert.deepEqual(ids.map((i) => jm.status(i).status), ["working", "working", "working", "queued"]);
  jm.cancel(ids[0]!);
  await waitUntil(() => jm.status(ids[3]!).status === "working");
  assert.equal(jm.status(ids[3]!).status, "working");
  for (const i of ids.slice(1)) jm.cancel(i);
  await Promise.all(ids.slice(1).map((i) => waitDone(jm, i)));
});

test("cancel queued job cancels immediately; unknown id reports not cancelled", async () => {
  const jm = mk({ maxConcurrent: 1, idleTimeoutMs: 60_000 });
  const a = (await jm.submit({ prompt: "[HANG] a", cwd: process.cwd(), mode: "plan" })).jobId;
  const b = (await jm.submit({ prompt: "[HANG] b", cwd: process.cwd(), mode: "plan" })).jobId;
  assert.equal(jm.status(b).status, "queued");
  assert.deepEqual(jm.cancel(b), { cancelled: true, status: "cancelled" });
  assert.deepEqual(jm.cancel("nope"), { cancelled: false, status: null });
  jm.cancel(a);
  await waitDone(jm, a);
});

test("idle timeout → failed with timeout error", async () => {
  const jm = mk({ idleTimeoutMs: 200 });
  const { jobId } = await jm.submit({ prompt: "[SILENT] s", cwd: process.cwd(), mode: "plan" });
  assert.equal(await waitDone(jm, jobId), "failed");
  assert.match((await jm.result(jobId)).errorText ?? "", /idle-timeout/);
});

test("per-job firstTokenGraceSec override: THINKER killed as first-token-timeout at the small grace", async () => {
  // manager default grace is generous (minutes); the 1s per-job override must win —
  // waitDone's ~5s budget proves the override was actually applied
  const jm = mk({ idleTimeoutMs: 200 });
  const { jobId } = await jm.submit({
    prompt: "[THINKER] t",
    cwd: process.cwd(),
    mode: "plan",
    firstTokenGraceSec: 1,
  });
  assert.equal(await waitDone(jm, jobId), "failed");
  assert.match((await jm.result(jobId)).errorText ?? "", /first-token-timeout/);
});

test("per-job idleTimeoutSec override: SILENT job outlives the manager idle default", async () => {
  // manager default idle is 200ms; the per-job 3s override must keep the job
  // working well past the default before the watchdog fires
  const jm = mk({ idleTimeoutMs: 200 });
  const { jobId } = await jm.submit({
    prompt: "[SILENT] s",
    cwd: process.cwd(),
    mode: "plan",
    idleTimeoutSec: 3,
  });
  await sleep(800);
  assert.equal(jm.status(jobId).status, "working", "still alive past the 200ms manager default");
  assert.equal(await waitDone(jm, jobId), "failed");
  assert.match((await jm.result(jobId)).errorText ?? "", /idle-timeout/);
});

test("reply inherits parent timeout overrides", async () => {
  const jm = mk({ idleTimeoutMs: 60_000 });
  const p = await jm.submit({
    prompt: "[OK] parent",
    cwd: process.cwd(),
    mode: "plan",
    firstTokenGraceSec: 1,
  });
  await waitDone(jm, p.jobId);
  const c = await jm.reply(p.jobId, "[THINKER] child");
  assert.equal(await waitDone(jm, c.jobId), "failed");
  assert.match((await jm.result(c.jobId)).errorText ?? "", /first-token-timeout/);
});

test("edit-mode gate: dirty tree rejected, allow_dirty passes, non-git rejected", async () => {
  const jm = mk();
  const clean = gitRepo();
  writeFileSync(path.join(clean, "x.txt"), "dirt");
  await assert.rejects(jm.submit({ prompt: "[OK] e", cwd: clean, mode: "edit" }), /dirty/i);
  const ok = await jm.submit({ prompt: "[OK] e", cwd: clean, mode: "edit", allowDirty: true });
  await waitDone(jm, ok.jobId);
  const plain = mkdtempSync(path.join(tmpdir(), "cbng-"));
  await assert.rejects(jm.submit({ prompt: "[OK] e", cwd: plain, mode: "edit" }), /git/i);
  await assert.rejects(jm.submit({ prompt: "[OK] e", cwd: plain, mode: "edit", isolation: "worktree", allowNonGit: true }), /git/i);
});

test("reply resumes parent chat without re-creating it", async () => {
  const jm = mk();
  const p = await jm.submit({ prompt: "[OK] parent", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, p.jobId);
  const c = await jm.reply(p.jobId, "[OK] next step");
  assert.equal(c.chatId, p.chatId);
  assert.equal(await waitDone(jm, c.jobId), "completed");
});

test("reply to a non-terminal parent is refused", async () => {
  const jm = mk({ idleTimeoutMs: 60_000 });
  const p = await jm.submit({ prompt: "[HANG] parent", cwd: process.cwd(), mode: "plan" });
  await assert.rejects(jm.reply(p.jobId, "[OK] next"), /while it is (queued|working)/);
  jm.cancel(p.jobId);
  await waitDone(jm, p.jobId);
});

test("ask returns answer synchronously and times out cleanly", async () => {
  const jm = mk();
  assert.equal(await jm.ask("[OK] what?", process.cwd()), "final answer");
  const jmFast = mk({ idleTimeoutMs: 200 });
  await assert.rejects(jmFast.ask("[SILENT] q", process.cwd()), /resubmit via cursor_run/);
});

test("list shows summaries", async () => {
  const jm = mk();
  const { jobId } = await jm.submit({ prompt: "[OK] listed job", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, jobId);
  const l = jm.list();
  assert.equal(l.length, 1);
  assert.equal(l[0]!.jobId, jobId);
  assert.ok(l[0]!.promptPreview.includes("listed"));
});

test("edit mode does not let a plan artifact mask the result", async () => {
  const jm = mk();
  const repo = gitRepo();
  const { jobId } = await jm.submit({ prompt: "[PLAN] e", cwd: repo, mode: "edit" });
  await waitDone(jm, jobId);
  assert.equal((await jm.result(jobId)).resultText, "narration only");
});

test("worktree diff misattribution: missing worktree does not fall back to the main tree", async () => {
  const jm = mk();
  const repo = gitRepo();
  const { jobId } = await jm.submit({
    prompt: "[OK] w",
    cwd: repo,
    mode: "edit",
    isolation: "worktree",
  });
  await waitDone(jm, jobId);
  // dirty the main tree after the (fake) job ran — the fake agent never creates a real worktree
  writeFileSync(path.join(repo, "untracked.txt"), "dirt");
  const r = await jm.result(jobId);
  assert.equal(r.worktreePath, null);
  assert.equal(r.worktreeMissing, true);
  assert.equal(r.diffStat, "");
  assert.equal(r.changedFiles.length, 0);
});

test("createChat calls are serialized under concurrent submits", async () => {
  const jm = mk({ maxConcurrent: 2 });
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      jm.submit({ prompt: "[HANG] b" + i, cwd: process.cwd(), mode: "plan" }),
    ),
  );
  for (const r of results) {
    assert.equal(r.chatId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  }
  for (const r of results) jm.cancel(r.jobId);
  await Promise.all(results.map((r) => waitDone(jm, r.jobId)));
});

function mkTel() {
  const root = mkdtempSync(path.join(tmpdir(), "cbjmtel-"));
  const logsDir = path.join(root, "logs");
  return { logsDir, tel: new Telemetry({ logsDir, jobsDir: path.join(root, "jobs"), enabled: true }) };
}

function telRecords(logsDir: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(logsDir, "telemetry.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("telemetry: job lifecycle records and terminal fields", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel });
  const { jobId } = await jm.submit({ prompt: "[OK] t", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, jobId);
  await tel.flush(5_000);
  const jobRecs = telRecords(logsDir).filter((r) => r.kind === "job" && r.job_id === jobId);
  const transitions = jobRecs.map((r) => r.transition);
  assert.deepEqual(transitions, ["queued", "working", "completed"]);
  const terminal = jobRecs[2]!;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.killedBy, null);
  assert.equal(typeof terminal.elapsed_sec, "number");
});

test("telemetry: ask timeout emits ask_timeout signal with detail", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, idleTimeoutMs: 200 });
  await assert.rejects(jm.ask("[SILENT] q", process.cwd()));
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "ask_timeout");
  assert.ok(sig, "ask_timeout signal recorded");
  assert.match(String(sig!.detail), /idle-timeout|hard-timeout/);
});

test("telemetry: gate refusal emits pre-job signal without job_id", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel });
  const plain = mkdtempSync(path.join(tmpdir(), "cbng3-"));
  await assert.rejects(jm.submit({ prompt: "[OK] e", cwd: plain, mode: "edit" }));
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "gate_refusal");
  assert.ok(sig);
  assert.equal(sig!.job_id, undefined);
  assert.equal(sig!.cwd, plain);
});

test("telemetry: cancelling a queued job emits both the cancel signal and a terminal job record", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, maxConcurrent: 1, idleTimeoutMs: 60_000 });
  const a = (await jm.submit({ prompt: "[HANG] a", cwd: process.cwd(), mode: "plan" })).jobId;
  const b = (await jm.submit({ prompt: "[HANG] b", cwd: process.cwd(), mode: "plan" })).jobId;
  jm.cancel(b); // b is queued — no done handler will ever fire for it
  await tel.flush(5_000);
  const recs = telRecords(logsDir);
  assert.ok(recs.find((r) => r.kind === "signal" && r.signal === "cancel" && r.job_id === b));
  assert.ok(recs.find((r) => r.kind === "job" && r.job_id === b && r.transition === "cancelled"));
  jm.cancel(a);
  await waitDone(jm, a);
});

test("telemetry: watchdog kill emits watchdog_kill and terminal job carries killedBy", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, idleTimeoutMs: 200 });
  const { jobId } = await jm.submit({ prompt: "[SILENT] s", cwd: process.cwd(), mode: "plan" });
  await waitDone(jm, jobId);
  await tel.flush(5_000);
  const recs = telRecords(logsDir);
  const sig = recs.find((r) => r.kind === "signal" && r.signal === "watchdog_kill" && r.job_id === jobId);
  assert.ok(sig);
  assert.match(String(sig!.detail), /idle-timeout|hard-timeout/);
  const term = recs.find((r) => r.kind === "job" && r.job_id === jobId && r.transition === "failed");
  assert.ok(term);
  assert.match(String(term!.killedBy), /idle-timeout|hard-timeout/);
});

test("telemetry: watchdog_kill carries stall diagnostics (saw_first_token, output_chars, stderr tail)", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, idleTimeoutMs: 200 });
  const { jobId } = await jm.submit({
    prompt: "[THINKER] t",
    cwd: process.cwd(),
    mode: "plan",
    firstTokenGraceSec: 1,
  });
  await waitDone(jm, jobId);
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "watchdog_kill" && r.job_id === jobId);
  assert.ok(sig, "watchdog_kill signal recorded");
  assert.equal(sig!.detail, "first-token-timeout");
  assert.equal(sig!.saw_first_token, false);
  assert.ok(typeof sig!.output_chars === "number" && (sig!.output_chars as number) > 0, "boilerplate bytes counted");
  assert.equal(typeof sig!.tool_call_count, "number");
  assert.equal(typeof sig!.stderr_tail, "string");
});

test("telemetry: reply to non-terminal parent emits reply_refused", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, idleTimeoutMs: 60_000 });
  const p = await jm.submit({ prompt: "[HANG] parent", cwd: process.cwd(), mode: "plan" });
  await assert.rejects(jm.reply(p.jobId, "[OK] next"));
  await tel.flush(5_000);
  assert.ok(telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "reply_refused" && r.job_id === p.jobId));
  jm.cancel(p.jobId);
  await waitDone(jm, p.jobId);
});

test("telemetry: create-chat failure emits spawn_error with phase", async () => {
  process.env.FAKE_SILENT_CREATE = "1";
  try {
    const { logsDir, tel } = mkTel();
    const jm = mk({ telemetry: tel, chatTimeoutMs: 300 });
    // fake create-chat prints nothing under FAKE_SILENT_CREATE → createChat times out fast
    await assert.rejects(
      jm.submit({ prompt: "[OK] x", cwd: process.cwd(), mode: "plan" }),
    );
    await tel.flush(5_000);
    const sig = telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "spawn_error");
    assert.ok(sig);
    assert.equal((sig!.detail as { phase: string }).phase, "create-chat");
  } finally {
    delete process.env.FAKE_SILENT_CREATE;
  }
});

test("telemetry: worktree job without a real worktree emits worktree_missing", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel });
  const repo = gitRepo();
  const { jobId } = await jm.submit({ prompt: "[OK] w", cwd: repo, mode: "edit", isolation: "worktree" });
  await waitDone(jm, jobId);
  await jm.drain(5_000);
  await tel.flush(5_000);
  assert.ok(telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "worktree_missing" && r.job_id === jobId));
});

test("meta chain: rapid cancel of a queued job leaves meta.json cancelled, not queued", async () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "cbmeta-"));
  const jm = new JobManager({ jobsDir, spawnCfg, idleTimeoutMs: 60_000, maxConcurrent: 1 });
  const a = (await jm.submit({ prompt: "[HANG] a", cwd: process.cwd(), mode: "plan" })).jobId;
  const { jobId: b } = await jm.submit({ prompt: "[OK] b", cwd: process.cwd(), mode: "plan" });
  assert.equal(jm.status(b).status, "queued");
  jm.cancel(b);
  await waitUntil(() => {
    try {
      return JSON.parse(readFileSync(path.join(jobsDir, b, "meta.json"), "utf8")).status === "cancelled";
    } catch {
      return false;
    }
  });
  const meta = JSON.parse(readFileSync(path.join(jobsDir, b, "meta.json"), "utf8"));
  assert.equal(meta.status, "cancelled");
  assert.equal(meta.metaChain, undefined); // internal chaining promise never serialized
  jm.cancel(a);
  await waitDone(jm, a);
});

test("telemetry: buffer overflow signal carries droppedBytes and job_id", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, spawnCfg: { ...spawnCfg, maxBufferChars: 1024 } });
  const { jobId } = await jm.submit({ prompt: "[BIGLINE] o", cwd: process.cwd(), mode: "plan" });
  assert.equal(await waitDone(jm, jobId), "completed");
  await jm.drain(5_000);
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find(
    (r) => r.kind === "signal" && r.signal === "buffer_overflow" && r.job_id === jobId,
  );
  assert.ok(sig, "buffer_overflow signal recorded");
  assert.ok(typeof sig!.droppedBytes === "number" && sig!.droppedBytes > 0);
});

test("telemetry: run-phase spawn error emits spawn_error with phase run", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, spawnCfg: { bin: "/nonexistent-bin-xyz" } });
  const { jobId } = await jm.submit({
    prompt: "[OK] r",
    cwd: process.cwd(),
    mode: "plan",
    resumeChatId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  assert.equal(await waitDone(jm, jobId), "failed");
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find(
    (r) => r.kind === "signal" && r.signal === "spawn_error" && r.job_id === jobId,
  );
  assert.ok(sig, "spawn_error signal recorded");
  assert.equal((sig!.detail as { phase: string }).phase, "run");
});

test("telemetry: ask-phase spawn error emits spawn_error with phase ask", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel, spawnCfg: { bin: "/nonexistent-bin-xyz" } });
  await assert.rejects(jm.ask("[OK] a", process.cwd()));
  await tel.flush(5_000);
  const sig = telRecords(logsDir).find((r) => r.kind === "signal" && r.signal === "spawn_error");
  assert.ok(sig, "spawn_error signal recorded");
  assert.equal((sig!.detail as { phase: string }).phase, "ask");
});

test("waitSettled: OK job resolves once settled, status terminal", async () => {
  const jm = mk();
  const { jobId } = await jm.submit({ prompt: "[OK] w", cwd: process.cwd(), mode: "plan" });
  await jm.waitSettled(jobId, 5_000);
  assert.equal(jm.status(jobId).status, "completed");
});

test("waitSettled: HANG job returns at the bound, status still working; cleaned up after", async () => {
  const jm = mk({ idleTimeoutMs: 60_000 });
  const { jobId } = await jm.submit({ prompt: "[HANG] w", cwd: process.cwd(), mode: "plan" });
  await waitUntil(() => jm.status(jobId).status === "working");
  const t0 = Date.now();
  await jm.waitSettled(jobId, 300);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2_000, `expected bounded wait, took ${elapsed}ms`);
  assert.equal(jm.status(jobId).status, "working");
  jm.cancel(jobId);
  await waitDone(jm, jobId);
});

test("waitSettled: unknown job id resolves without throwing", async () => {
  const jm = mk();
  await jm.waitSettled("nope", 100);
});

test("activeJobIds lists non-terminal jobs only", async () => {
  const jm = mk({ idleTimeoutMs: 60_000 });
  const a = (await jm.submit({ prompt: "[HANG] a", cwd: process.cwd(), mode: "plan" })).jobId;
  assert.deepEqual(jm.activeJobIds(), [a]);
  jm.cancel(a);
  await waitDone(jm, a);
  assert.deepEqual(jm.activeJobIds(), []);
});

test("submit meta попадает в телеметрию job-записей", async () => {
  const { logsDir, tel } = mkTel();
  const jm = mk({ telemetry: tel });
  const { jobId } = await jm.submit({
    prompt: "[OK] hi", cwd: process.cwd(), mode: "ask",
    meta: { review_id: "rev-123", axis: "broad" },
  });
  await waitDone(jm, jobId);
  await tel.flush(5_000);
  const jobRecs = telRecords(logsDir).filter((r) => r.kind === "job" && r.job_id === jobId);
  assert.ok(jobRecs.length >= 2); // queued + терминальная
  for (const r of jobRecs) {
    assert.deepEqual(r.meta, { review_id: "rev-123", axis: "broad" });
  }
});

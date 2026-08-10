import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JobManager } from "../src/job-manager.ts";
import { buildServer } from "../src/server.ts";
import { reviewAxesSchema } from "../src/tools.ts";
import { Telemetry } from "../src/telemetry.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-agent.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "cbtools-"));
  const logsDir = path.join(root, "logs");
  const jm = new JobManager({
    jobsDir: path.join(root, "jobs"),
    spawnCfg: { bin: process.execPath, binArgs: [FAKE] },
    idleTimeoutMs: 1_000,
  });
  const telemetry = new Telemetry({ logsDir, jobsDir: path.join(root, "jobs"), enabled: true, activeJobIds: () => jm.activeJobIds() });
  const server = buildServer(jm, telemetry);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return res as { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  return { call, client, telemetry, logsDir };
}

test("lists all thirteen tools", async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cursor_ask", "cursor_cancel", "cursor_jobs", "cursor_mark_analyzed",
    "cursor_refute", "cursor_refute_result",
    "cursor_reply", "cursor_result", "cursor_review", "cursor_review_result",
    "cursor_run", "cursor_stats", "cursor_status",
  ]);
});

test("cursor_refute: MCP-отказ на дубли id и на папку >12", async () => {
  const { call } = await setup();
  const f = (id: string) => ({ id, title: "t", file: "src/a.ts", claim: "сценарий поломки в десять+ символов" });
  const dup = await call("cursor_refute", {
    findings: [f("B-1"), f("B-1")], cwd: tmpdir(), context: "ctx",
  });
  assert.equal(dup.isError, true);
  const big = await call("cursor_refute", {
    findings: Array.from({ length: 13 }, (_, i) => f(`B-${i}`)), cwd: tmpdir(), context: "ctx",
  });
  assert.equal(big.isError, true);
});

test("cursor_refute: e2e через fake-agent — пара job'ов, meta, result с verify_note", async () => {
  const { call } = await setup();
  const root = mkdtempSync(path.join(tmpdir(), "refute-e2e-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/a.ts"), "const guarded = withLock(doWork)");
  const sub = await call("cursor_refute", {
    findings: [{ id: "B-1", title: "t", file: "src/a.ts", line: 1, claim: "гонка без лока на записи" }],
    cwd: root, context: "ctx",
  });
  assert.ok(!sub.isError);
  const sc = sub.structuredContent as { refute_id: string; roles: Array<{ role: string; job_id: string }> };
  assert.equal(sc.roles.length, 2);
  const res = await call("cursor_refute_result", { refute_id: sc.refute_id, wait_sec: 5 });
  const rc = res.structuredContent as Record<string, unknown>;
  assert.ok(["working", "completed", "degraded", "failed"].includes(rc.status as string));
  assert.match(rc.verify_note as string, /escalated/); // именно refute-специфичный verify_note, не общий
  assert.equal(rc.cwd_pinned, false); // фикстура не-git -> пин честно false
  assert.equal((rc.verdicts as unknown[]).length, 1); // вердикт-слот на каждое дело всегда есть
});

test("cursor_review: схема axes — инвариант min-2, enum, дубли", () => {
  assert.equal(reviewAxesSchema.safeParse(["broad"]).success, false);
  assert.equal(reviewAxesSchema.safeParse(["broad", "bogus"]).success, false);
  assert.equal(reviewAxesSchema.safeParse(["broad", "broad"]).success, false); // дубли ≠ 2 оси
  assert.equal(reviewAxesSchema.safeParse(["broad", "strict"]).success, true);
  assert.equal(reviewAxesSchema.safeParse(undefined).success, true); // optional
});

test("cursor_review: схема axes принимает оси code, кросс-набор бьётся в selectAxes", () => {
  assert.equal(reviewAxesSchema.safeParse(["correctness", "tests"]).success, true);
});

test("cursor_review: MCP-уровень отказ на кросс-набор осей (axis_set=plan + code-оси)", async () => {
  const { call } = await setup();
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const art = path.join(dir, "a.md");
  writeFileSync(art, "строка\n".repeat(10));
  const r = await call("cursor_review", {
    artifacts: [art], cwd: dir, context: "c", axis_set: "plan", axes: ["correctness", "security"],
  });
  assert.equal(r.isError, true);
  const text = (r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
  assert.match(text, /not in axis set/);
});

test("cursor_review: MCP-уровень отказ на кросс-набор осей, обратное направление (axis_set=code + plan-оси)", async () => {
  const { call } = await setup();
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const art = path.join(dir, "a.md");
  writeFileSync(art, "строка\n".repeat(10));
  const r = await call("cursor_review", {
    artifacts: [art], cwd: dir, context: "c", axis_set: "code", axes: ["broad", "strict"],
  });
  assert.equal(r.isError, true);
  const text = (r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
  assert.match(text, /not in axis set/);
});

test("instrument: tool calls land in telemetry with args and result", async () => {
  const { call, telemetry, logsDir } = await setup();
  await call("cursor_ask", { prompt: "[OK] q", cwd: process.cwd() });
  await telemetry.flush(5_000);
  const recs = readFileSync(path.join(logsDir, "telemetry.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tc = recs.find((r) => r.kind === "tool_call" && r.tool === "cursor_ask");
  assert.ok(tc);
  assert.equal(tc.ok, true);
  assert.equal(tc.result.answer, "final answer");
  assert.equal(typeof tc.duration_ms, "number");
  // spec: cursor_run must be instrumented too
  await call("cursor_run", { prompt: "[OK] r", cwd: process.cwd(), mode: "plan" });
  await telemetry.flush(5_000);
  const recs2 = readFileSync(path.join(logsDir, "telemetry.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(recs2.find((r) => r.kind === "tool_call" && r.tool === "cursor_run" && r.ok === true));
});

test("cursor_review: e2e MCP + телеметрия tool_call (weight/axis_count, blockers/parse)", async () => {
  const { call, telemetry, logsDir } = await setup();
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const art = path.join(dir, "a.md");
  writeFileSync(art, "строка\n".repeat(10));
  const sub = await call("cursor_review", {
    artifacts: [art], cwd: dir, context: "[REVIEW-CLEAN] тестовый проект",
  });
  assert.ok(!sub.isError);
  const sc = sub.structuredContent as Record<string, unknown>;
  assert.equal(sc.axis_count, 2);
  assert.equal(sc.weight, 10);
  const subCode = await call("cursor_review", {
    artifacts: [art], cwd: dir, context: "[REVIEW-CLEAN] p", axis_set: "code",
  });
  const scc = subCode.structuredContent as Record<string, unknown>;
  assert.equal(scc.axis_count, 3);
  assert.equal(scc.axis_set, "code");
  await call("cursor_review_result", { review_id: scc.review_id, wait_sec: 10 });
  // review axes are identifiable in cursor_jobs via job.meta (spec §5 backlog)
  const jobsOut = await call("cursor_jobs");
  const jobs = (jobsOut.structuredContent as { jobs: Array<Record<string, unknown>> }).jobs;
  const axisByJobId = new Map((sc.axes as Array<{ job_id: string; axis: string }>).map((a) => [a.job_id, a.axis]));
  const axisJobs = jobs.filter((x) => axisByJobId.has(x.job_id as string));
  assert.equal(axisJobs.length, axisByJobId.size); // guard against a vacuous empty loop
  for (const j of axisJobs) {
    const meta = j.meta as Record<string, unknown>;
    assert.equal(meta.review_id, sc.review_id);
    assert.equal(meta.axis, axisByJobId.get(j.job_id as string)); // exact axis, not just "a string"
  }
  const res = await call("cursor_review_result", {
    review_id: sc.review_id, wait_sec: 10,
  });
  const rsc = res.structuredContent as Record<string, unknown>;
  assert.equal(rsc.status, "completed");
  assert.equal(rsc.blockers_total, 0);
  assert.equal(rsc.parse_degraded, false);
  assert.deepEqual(rsc.findings, []); // clean pass pins the empty table too
  assert.ok(typeof rsc.verify_note === "string" && (rsc.verify_note as string).length > 0);
  await telemetry.flush(5_000);
  const tcs = readFileSync(path.join(logsDir, "telemetry.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.kind === "tool_call");
  const subTc = tcs.find((r) => r.tool === "cursor_review");
  // Two cursor_review_result calls happened (code-set at line 97, plan-set at
  // line 109) — .find() without a review_id filter silently grabbed whichever
  // record came first (the code run), not the plan run this block asserts
  // against. Pin by review_id so each record is unambiguous.
  const resTc = tcs.find((r) => r.tool === "cursor_review_result" &&
    (r.result as Record<string, unknown> | undefined)?.review_id === sc.review_id);
  const resTcCode = tcs.find((r) => r.tool === "cursor_review_result" &&
    (r.result as Record<string, unknown> | undefined)?.review_id === scc.review_id);
  assert.equal((subTc?.result as Record<string, unknown>)?.weight, 10);
  assert.equal((subTc?.result as Record<string, unknown>)?.axis_count, 2);
  assert.equal((resTc?.result as Record<string, unknown>)?.blockers_total, 0);
  assert.equal((resTc?.result as Record<string, unknown>)?.parse_degraded, false);
  assert.equal((resTcCode?.result as Record<string, unknown>)?.blockers_total, 0);
  // Mirror of the plan-run pin above — the code-set run's own telemetry record
  // must independently show a clean, non-degraded completion, not just the
  // (weaker) blockers_total check already in place.
  assert.equal((resTcCode?.result as Record<string, unknown>)?.status, "completed");
  assert.equal((resTcCode?.result as Record<string, unknown>)?.parse_degraded, false);
});

test("cursor_review_result: сериализация непустых findings через MCP (snake_case line_end)", async () => {
  const { call } = await setup();
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const art = path.join(dir, "a.md");
  writeFileSync(art, "строка\n".repeat(10));
  const sub = await call("cursor_review", { artifacts: [art], cwd: dir, context: "[REVIEW] p" });
  const sc = sub.structuredContent as Record<string, unknown>;
  const res = await call("cursor_review_result", { review_id: sc.review_id, wait_sec: 10 });
  const rsc = res.structuredContent as Record<string, any>;
  assert.equal(rsc.findings.length, 6); // 3 находки × 2 оси — путь с непустой таблицей
  const ranged = rsc.findings.find((f: any) => f.line_end !== null);
  assert.ok(ranged, "находка с диапазоном должна сериализоваться с line_end");
  assert.equal(ranged.file, "src/fake.ts");
  assert.equal(ranged.line, 100);
  assert.equal(ranged.line_end, 120);
  assert.ok(["broad", "strict"].includes(ranged.axis));
  assert.equal(rsc.blockers_total, 4);
  assert.equal(rsc.overlap.length, 2);
});

test("cursor_stats aggregates and reports storage", async () => {
  const { call, telemetry } = await setup();
  await call("cursor_ask", { prompt: "[OK] q", cwd: process.cwd() });
  await telemetry.flush(5_000);
  const s = await call("cursor_stats", {});
  assert.ok(!s.isError);
  const sc = s.structuredContent as Record<string, any>;
  assert.equal(sc.tool_calls.cursor_ask.count, 1);
  assert.ok(sc.storage.active_bytes > 0);
  assert.equal(sc.storage.watermark, null);
  assert.equal(sc.storage.corrupt_lines, 0);
  assert.equal(typeof sc.storage.segments_read, "number");
  assert.equal(typeof sc.storage.segments_skipped, "number");
  assert.ok(!("hint" in sc));
});

test("cursor_stats: hint appears once rotated segments reach the retention threshold", async () => {
  const { call, logsDir } = await setup();
  mkdirSync(logsDir, { recursive: true });
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      path.join(logsDir, `telemetry-${i}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), kind: "signal", signal: "noop" }) + "\n",
    );
  }
  const s = await call("cursor_stats", {});
  assert.ok(!s.isError);
  const sc = s.structuredContent as Record<string, any>;
  assert.equal(sc.storage.segments, 10);
  assert.match(sc.hint, /10 rotated segments/);
});

test("cursor_mark_analyzed requires confirm and sets watermark", async () => {
  const { call } = await setup();
  const refuse = await call("cursor_mark_analyzed", { confirm: false });
  assert.equal(refuse.isError, true);
  const okr = await call("cursor_mark_analyzed", { confirm: true });
  assert.ok(!okr.isError);
  assert.ok(typeof (okr.structuredContent as any).watermark === "string");
  assert.deepEqual((okr.structuredContent as any).deletable, { segments: [], jobs: [] });
});

test("run → status → result round trip", async () => {
  const { call } = await setup();
  const run = await call("cursor_run", { prompt: "[OK] task", cwd: process.cwd(), mode: "plan" });
  assert.ok(!run.isError);
  const jobId = run.structuredContent!.job_id as string;
  let status = "";
  for (let i = 0; i < 200; i++) {
    const s = await call("cursor_status", { job_id: jobId });
    status = s.structuredContent!.status as string;
    if (status !== "queued" && status !== "working") break;
    await sleep(25);
  }
  assert.equal(status, "completed");
  const r = await call("cursor_result", { job_id: jobId });
  assert.equal(r.structuredContent!.result_text, "final answer");
  assert.match(r.structuredContent!.verify_note as string, /confirm or refute/);
});

test("cursor_result wait_sec long-polls until the job settles", async () => {
  const { call } = await setup();
  const run = await call("cursor_run", { prompt: "[OK] task", cwd: process.cwd(), mode: "plan" });
  assert.ok(!run.isError);
  const jobId = run.structuredContent!.job_id as string;
  const r = await call("cursor_result", { job_id: jobId, wait_sec: 5 });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent!.status, "completed");
  assert.equal(r.structuredContent!.result_text, "final answer");
});

test("cursor_run forwards first_token_grace_sec and idle_sec to the job", async () => {
  const { call } = await setup();
  // grace override: THINKER (init then silence) must die as first-token-timeout at ~1s,
  // not survive to the server default of minutes
  const run = await call("cursor_run", {
    prompt: "[THINKER] t",
    cwd: process.cwd(),
    mode: "plan",
    first_token_grace_sec: 1,
    idle_sec: 1,
  });
  assert.ok(!run.isError);
  const r = await call("cursor_result", { job_id: run.structuredContent!.job_id as string, wait_sec: 10 });
  assert.equal(r.structuredContent!.status, "failed");
  assert.match(r.structuredContent!.error_text as string, /first-token-timeout/);
});

test("cursor_ask answers synchronously", async () => {
  const { call } = await setup();
  const r = await call("cursor_ask", { prompt: "[OK] q", cwd: process.cwd() });
  assert.equal(r.structuredContent!.answer, "final answer");
  assert.match(r.structuredContent!.verify_note as string, /confirm or refute/);
});

test("cursor_ask rejects a relative cwd", async () => {
  const { call } = await setup();
  const r = await call("cursor_ask", { prompt: "[OK] q", cwd: "relative/dir" });
  assert.equal(r.isError, true);
});

test("cursor_jobs lists, cursor_cancel reports unknown id as error-free false", async () => {
  const { call } = await setup();
  await call("cursor_run", { prompt: "[OK] listed", cwd: process.cwd(), mode: "plan" });
  const jobs = await call("cursor_jobs");
  assert.equal((jobs.structuredContent!.jobs as unknown[]).length, 1);
  // plain jobs have no meta — the key is absent, not null
  assert.equal("meta" in (jobs.structuredContent!.jobs as object[])[0]!, false);
  const c = await call("cursor_cancel", { job_id: "nope" });
  assert.equal(c.structuredContent!.cancelled, false);
  assert.equal(c.structuredContent!.status, null);
});

test("validation error surfaces as tool error, not crash", async () => {
  const { call } = await setup();
  const r = await call("cursor_run", { prompt: "[OK] x", cwd: mkdtempSync(path.join(tmpdir(), "cbng2-")) });
  assert.equal(r.isError, true); // edit mode in non-git dir is refused
});

test("unknown job_id yields tool error for status/result/reply", async () => {
  const { call } = await setup();
  for (const [name, args] of [
    ["cursor_status", { job_id: "nope" }],
    ["cursor_result", { job_id: "nope" }],
    ["cursor_reply", { job_id: "nope", prompt: "x" }],
  ] as const) {
    const r = await call(name, args as Record<string, unknown>);
    assert.equal(r.isError, true, `${name} should surface unknown job_id as tool error`);
  }
});

test("cursor_stats and cursor_mark_analyzed error clearly when telemetry is not wired", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cbtools-no-telem-"));
  const jm = new JobManager({
    jobsDir: path.join(root, "jobs"),
    spawnCfg: { bin: process.execPath, binArgs: [FAKE] },
    idleTimeoutMs: 1_000,
  });
  // Build server WITHOUT telemetry
  const server = buildServer(jm);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return res as { isError?: boolean; content?: Array<{ type: string; text: string }> };
  };

  // Test cursor_stats
  const statsResult = await call("cursor_stats", {});
  assert.equal(statsResult.isError, true);
  assert.ok(statsResult.content?.[0]?.text);
  assert.match(statsResult.content![0].text, /telemetry is disabled/);

  // Test cursor_mark_analyzed
  const analyzeResult = await call("cursor_mark_analyzed", { confirm: true });
  assert.equal(analyzeResult.isError, true);
  assert.ok(analyzeResult.content?.[0]?.text);
  assert.match(analyzeResult.content![0].text, /telemetry is disabled/);
});

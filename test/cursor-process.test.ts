import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildArgs, runCursorAgent, createChat } from "../src/cursor-process.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-agent.mjs");
const cfg = { bin: process.execPath, binArgs: [FAKE] };
const base = { cwd: process.cwd(), ...cfg };

test("buildArgs: edit mode gets -f and --trust, prompt is last", () => {
  const a = buildArgs({ prompt: "do it", cwd: "/x", mode: "edit" });
  assert.ok(a.includes("-f"));
  assert.ok(a.includes("--trust"));
  assert.ok(!a.includes("--mode"));
  assert.equal(a[a.length - 1], "do it");
  assert.equal(a[a.length - 2], "--");
  assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2), ["--model", "composer-2.5"]);
});

test("buildArgs: plan mode is read-only, resume and worktree flags present", () => {
  const a = buildArgs({ prompt: "p", cwd: "/x", mode: "plan", resumeChatId: "c1", worktreeName: "wt1" });
  assert.ok(!a.includes("-f"));
  assert.equal(a[a.length - 1], "p");
  assert.equal(a[a.length - 2], "--");
  assert.deepEqual(a.slice(a.indexOf("--mode"), a.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert.deepEqual(a.slice(a.indexOf("--resume"), a.indexOf("--resume") + 2), ["--resume", "c1"]);
  assert.deepEqual(a.slice(a.indexOf("-w"), a.indexOf("-w") + 2), ["-w", "wt1"]);
});

test("happy path collects result", async () => {
  const r = await runCursorAgent({ ...base, prompt: "[OK] hi" }).done;
  assert.equal(r.resultText, "final answer");
  assert.equal(r.assistantText, "hello ");
  assert.equal(r.toolCallCount, 1);
  assert.equal(r.exitCode, 0);
  assert.equal(r.killedBy, null);
});

test("idle watchdog kills silent hang", async () => {
  const r = await runCursorAgent({ ...base, prompt: "[SILENT] x", idleTimeoutMs: 300, hardTimeoutMs: 10_000 }).done;
  assert.equal(r.killedBy, "idle-timeout");
});

test("first-token grace: boilerplate-then-silence is killed as first-token-timeout, not idle", async () => {
  const start = Date.now();
  const r = await runCursorAgent({
    ...base,
    prompt: "[THINKER] x",
    idleTimeoutMs: 150,
    firstTokenGraceMs: 500,
    hardTimeoutMs: 10_000,
  }).done;
  assert.equal(r.killedBy, "first-token-timeout");
  assert.ok(Date.now() - start >= 500, "must outlive the idle timeout up to the grace budget");
  assert.equal(r.sawFirstToken, false);
  assert.ok(r.outputChars > 0, "boilerplate init event was received before the kill");
});

test("first-token grace: slow start survives idle silence before the first token, then completes", async () => {
  const r = await runCursorAgent({
    ...base,
    prompt: "[SLOWSTART] x",
    idleTimeoutMs: 200,
    firstTokenGraceMs: 5_000,
    hardTimeoutMs: 10_000,
  }).done;
  assert.equal(r.killedBy, null);
  assert.equal(r.exitCode, 0);
  assert.equal(r.resultText, "final answer");
  assert.equal(r.sawFirstToken, true);
  assert.ok(r.firstTokenMs !== null && r.firstTokenMs >= 500, `firstTokenMs must reflect the think delay, got ${r.firstTokenMs}`);
});

test("grace does not shield a stall AFTER the first token: idle-timeout applies", async () => {
  const r = await runCursorAgent({
    ...base,
    prompt: "[STALL] x",
    idleTimeoutMs: 300,
    firstTokenGraceMs: 10_000,
    hardTimeoutMs: 10_000,
  }).done;
  assert.equal(r.killedBy, "idle-timeout");
  assert.equal(r.sawFirstToken, true);
});

test("hard timeout kills a dripping process that never finishes", async () => {
  const r = await runCursorAgent({ ...base, prompt: "[DRIP] x", idleTimeoutMs: 2_000, hardTimeoutMs: 600 }).done;
  assert.equal(r.killedBy, "hard-timeout");
});

test("cancel kills the process", async () => {
  const h = runCursorAgent({ ...base, prompt: "[HANG] x", idleTimeoutMs: 10_000, hardTimeoutMs: 10_000 });
  setTimeout(() => h.cancel(), 100);
  const r = await h.done;
  assert.equal(r.killedBy, "cancelled");
});

test("nonzero exit reported", async () => {
  const r = await runCursorAgent({ ...base, prompt: "[FAIL] x" }).done;
  assert.equal(r.exitCode, 1);
  assert.equal(r.killedBy, null);
  assert.match(r.stderrTail, /boom-diagnostics/);
});

test("missing binary yields spawnError, not a hang", async () => {
  const r = await runCursorAgent({ prompt: "x", cwd: process.cwd(), bin: "/nonexistent-bin-xyz" }).done;
  assert.ok(r.spawnError);
});

test("createChat returns id even though process hangs afterwards", async () => {
  const id = await createChat(process.cwd(), cfg, 5_000);
  assert.equal(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("createChat times out on silent process", async () => {
  process.env.FAKE_SILENT_CREATE = "1";
  try {
    await assert.rejects(createChat(process.cwd(), cfg, 300));
  } finally {
    delete process.env.FAKE_SILENT_CREATE;
  }
});

test("watchdog settles even when a grandchild inherits stdout", async () => {
  const start = Date.now();
  // GRANDCHILD emits the init boilerplate before hanging, so the kill arrives
  // via the first-token budget, not the raw idle path.
  const r = await runCursorAgent({
    ...base,
    prompt: "[GRANDCHILD] x",
    idleTimeoutMs: 300,
    firstTokenGraceMs: 300,
    hardTimeoutMs: 15_000,
  }).done;
  assert.equal(r.killedBy, "first-token-timeout");
  assert.ok(Date.now() - start < 8_000, "done must settle within grace window");
});

test("exit-grace belt (not close) settles cancel when a SIGTERM-ignoring grandchild holds stdout", async () => {
  const pidfile = path.join(os.tmpdir(), `cursor-bridge-stubborn-pid-${process.pid}-${Date.now()}`);
  process.env.FAKE_PIDFILE = pidfile;
  try {
    let sawOutput: () => void;
    const gotOutput = new Promise<void>((resolve) => {
      sawOutput = resolve;
    });
    const h = runCursorAgent({
      ...base,
      prompt: "[STUBBORN] x",
      exitGraceMs: 300,
      idleTimeoutMs: 10_000,
      hardTimeoutMs: 10_000,
      onRawLine: () => sawOutput(),
    });
    await gotOutput;
    // Wait for the grandchild to write its pid to the pidfile after
    // registering the SIGTERM handler. Poll every 25ms, timeout after 5s.
    const pollStart = Date.now();
    let pidfileReady = false;
    while (Date.now() - pollStart < 5_000) {
      try {
        const content = readFileSync(pidfile, "utf8").trim();
        if (content) {
          pidfileReady = true;
          break;
        }
      } catch {
        // File doesn't exist yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(pidfileReady, "pidfile must be written within 5s");

    const start = Date.now();
    h.cancel();
    const r = await h.done;
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 2_000,
      `belt must settle well under the 3s SIGKILL escalation (grace 300ms); took ${elapsed}ms`,
    );
    assert.equal(r.killedBy, "cancelled");

    const gpid = Number(readFileSync(pidfile, "utf8").trim());
    let grandchildAlive = true;
    try {
      process.kill(gpid, 0);
    } catch {
      grandchildAlive = false;
    }
    assert.ok(
      grandchildAlive,
      "grandchild must still be alive at settle time — proves the exit-grace belt fired, not close()",
    );
    try {
      process.kill(gpid, "SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    delete process.env.FAKE_PIDFILE;
  }
});

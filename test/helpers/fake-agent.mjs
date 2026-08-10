// Fake cursor-agent. Prompt is the LAST positional arg; a [TAG] inside it picks behavior.
import { spawn } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const hang = () => setInterval(() => {}, 1 << 30);

if (args[0] === "create-chat") {
  if (process.env.FAKE_CREATE_FAIL_FILE) {
    appendFileSync(process.env.FAKE_CREATE_FAIL_FILE, "x");
    const { size } = statSync(process.env.FAKE_CREATE_FAIL_FILE);
    // 2nd+ create-chat call in this run: print nothing — silent create,
    // the same hang shape as FAKE_SILENT_CREATE — to simulate a create-chat
    // that times out for a later axis while an earlier axis already got its id.
    if (size < 2) process.stdout.write("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n");
  } else if (!process.env.FAKE_SILENT_CREATE) {
    process.stdout.write("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n");
  }
  hang();
} else {
  const prompt = args[args.length - 1] ?? "";
  const tag = /\[([A-Z-]+)\]/.exec(prompt)?.[1] ?? "OK";
  if (tag === "SILENT") {
    hang(); // zero bytes on stdout — the nastiest observed hang mode
  } else {
    emit({ type: "system", subtype: "init" });
    if (tag === "HANG") {
      hang();
    } else if (tag === "THINKER") {
      // boilerplate arrived, then silence forever — models "thinking" before
      // the first token (the observed 189s idle-kill incident shape)
      hang();
    } else if (tag === "SLOWSTART") {
      // long think (600ms) before the first token, then a normal finish
      setTimeout(() => {
        emit({ type: "assistant", message: { content: [{ type: "text", text: "thought " }] } });
        emit({ type: "result", result: "final answer" });
        process.exit(0);
      }, 600);
    } else if (tag === "STALL") {
      // first token arrives immediately, then the stream stalls forever
      emit({ type: "assistant", message: { content: [{ type: "text", text: "started " }] } });
      hang();
    } else if (tag === "GRANDCHILD") {
      spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)"], { stdio: "inherit" });
      hang();
    } else if (tag === "STUBBORN") {
      spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.env.FAKE_PIDFILE, String(process.pid)); setTimeout(()=>process.exit(0),8000); setInterval(()=>{},1<<30)"], { stdio: "inherit" });
      hang();
    } else if (tag === "DRIP") {
      setInterval(
        () => emit({ type: "assistant", message: { content: [{ type: "text", text: "." }] } }),
        50,
      );
    } else if (tag === "BIGLINE") {
      // large chunk, no trailing newline — accumulates in the collector's
      // buffer so a tiny maxBufferChars cap trips the overflow branch.
      process.stdout.write("x".repeat(64 * 1024));
      setTimeout(() => {
        emit({ type: "result", result: "final answer" });
        process.exit(0);
      }, 50);
    } else if (tag === "REVIEW") {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "думаю " }] } });
      emit({ type: "result", result: [
        "- ✗ **Первая находка** — src/fake.ts:10 — сценарий отказа — гейты не ловят",
        "✗ Вторая находка — src/fake.ts:100-120 — ошибка — фикс",
        "⚠ Минор без места — просто текст",
        "## ЧЕГО Я НЕ НАШЁЛ",
        "- остальное крепко",
      ].join("\n") });
      process.exit(0);
    } else if (tag === "REVIEW-CLEAN") {
      emit({ type: "result", result: "НАХОДОК НЕТ\n\n## ЧЕГО Я НЕ НАШЁЛ\n- всё крепко" });
      process.exit(0);
    } else if (tag === "EMPTY-RESULT") {
      // findings land in the assistant stream, the result event is an empty
      // string — the observed real-run shape that must fall back to assistantText
      emit({ type: "assistant", message: { content: [{ type: "text", text: "✗ Утекшая находка — src/leak.ts:5 — сценарий — гейт" }] } });
      emit({ type: "result", result: "" });
      process.exit(0);
    } else if (tag === "REVIEW-PARTIAL") {
      // 4 маркер-строки, только 1 с распознаваемым местом: 1 < 4/2 → parse_degraded
      emit({ type: "result", result: [
        "✗ Первая — src/fake.ts:10 — сценарий — гейт",
        "✗ Вторая без места — просто текст",
        "⚠ Третья без места — текст",
        "⚠ Четвёртая без места — текст",
      ].join("\n") });
      process.exit(0);
    } else if (tag === "BLANK-RESULT") {
      // whitespace-only result event — must fall through to assistantText
      emit({ type: "assistant", message: { content: [{ type: "text", text: "✗ Утекшая находка — src/leak.ts:5 — сценарий — гейт" }] } });
      emit({ type: "result", result: "\n   \n" });
      process.exit(0);
    } else if (tag === "REVIEW-MIXED") {
      // per-axis divergence: the strict brief mentions «холодного экзаменатора» —
      // that axis returns a broken format while the other axis is clean; pins
      // the .some() aggregation of parse_degraded across axes
      if (prompt.includes("холодного экзаменатора")) {
        emit({ type: "result", result: "Ответ по существу, но формат сломан: ни маркеров, ни токена." });
      } else {
        emit({ type: "result", result: "НАХОДОК НЕТ\n\n## ЧЕГО Я НЕ НАШЁЛ\n- всё крепко" });
      }
      process.exit(0);
    } else if (tag === "REVIEW-HALF") {
      // ровно 50% маркер-строк с местом (2 из 4) — граница порога, НЕ degraded
      emit({ type: "result", result: [
        "✗ Первая — src/fake.ts:10 — сценарий — гейт",
        "⚠ Вторая — src/fake.ts:20 — сценарий — гейт",
        "⚠ Третья без места — текст",
        "ℹ Четвёртая без места — текст",
      ].join("\n") });
      process.exit(0);
    } else if (tag === "FAIL") {
      emit({ type: "result", result: "boom" });
      process.stderr.write("boom-diagnostics\n");
      process.exit(1);
    } else if (tag === "PLAN") {
      emit({ type: "tool_call", subtype: "started", tool_call: { createPlanToolCall: { args: { plan: "# THE PLAN\n1. step" } } } });
      emit({ type: "tool_call", subtype: "completed", tool_call: { createPlanToolCall: { args: { plan: "# THE PLAN\n1. step" } } } });
      emit({ type: "result", result: "narration only" });
      process.exit(0);
    } else {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "hello " }] } });
      emit({ type: "tool_call", subtype: "started" });
      emit({ type: "tool_call", subtype: "completed" });
      emit({ type: "result", result: "final answer" });
      process.exit(0);
    }
  }
}

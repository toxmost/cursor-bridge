import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamCollector, summarizeEvent } from "../src/stream-events.ts";

const L = (o: unknown) => JSON.stringify(o) + "\n";

test("collects assistant text, result and tool calls across chunk boundaries", () => {
  const lines: string[] = [];
  const c = new StreamCollector({ onLine: (l) => lines.push(l) });
  const full =
    L({ type: "system", subtype: "init" }) +
    L({ type: "assistant", message: { content: [{ type: "text", text: "hel" }] } }) +
    L({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } }) +
    "GARBAGE NOT JSON\n" +
    L({ type: "tool_call", subtype: "started" }) +
    L({ type: "tool_call", subtype: "completed" }) +
    L({ type: "result", result: "done!" });
  // feed in awkward 7-byte chunks to exercise line buffering
  for (let i = 0; i < full.length; i += 7) c.feed(full.slice(i, i + 7));
  c.end();
  assert.equal(c.assistantText, "hello");
  assert.equal(c.resultText, "done!");
  assert.equal(c.toolCallCount, 1);
  assert.equal(c.planText, null); // no createPlanToolCall in this stream
  assert.equal(lines.length, 7); // garbage line still journaled raw
});

test("captures plan text from createPlanToolCall tool_call events", () => {
  const c = new StreamCollector();
  const full =
    L({ type: "system", subtype: "init" }) +
    L({
      type: "tool_call",
      subtype: "started",
      call_id: "1",
      tool_call: { createPlanToolCall: { args: { plan: "# THE PLAN\n1. step" } } },
    }) +
    L({
      type: "tool_call",
      subtype: "completed",
      call_id: "1",
      tool_call: { createPlanToolCall: { args: { plan: "# THE PLAN\n1. step" } } },
    }) +
    L({ type: "result", result: "narration only" });
  c.feed(full);
  c.end();
  assert.equal(c.planText, "# THE PLAN\n1. step");
});

test("end() flushes a final line without trailing newline", () => {
  const c = new StreamCollector();
  c.feed(JSON.stringify({ type: "result", result: "tail" })); // no \n
  c.end();
  assert.equal(c.resultText, "tail");
});

test("result event with no result field yields resultText null", () => {
  const c = new StreamCollector();
  c.feed(L({ type: "result" }));
  c.end();
  assert.equal(c.resultText, null);
});

test("buffer cap: overflow on a no-newline stream flags and resets, then a complete line still parses", () => {
  const events: unknown[] = [];
  const c = new StreamCollector({ maxBufferChars: 64, onEvent: (e) => events.push(e) });
  c.feed("x".repeat(100)); // no newline — buffer alone exceeds the cap
  assert.ok(events.some((e) => (e as { type?: string }).type === "bridge_buffer_overflow"));
  c.feed(L({ type: "result", result: "done!" }));
  c.end();
  assert.equal(c.resultText, "done!");
});

test("summarizeEvent", () => {
  assert.equal(summarizeEvent({ type: "tool_call", subtype: "shell" }), "tool_call:shell");
  assert.equal(summarizeEvent({ type: "result" }), "result");
  assert.equal(summarizeEvent({}), "unknown");
});

---
name: cursor-delegate
description: Use when delegating work to Cursor Composer via cursor-bridge MCP tools (cursor_run, cursor_ask, ...) — second-opinion reviews of plans/diffs (the dominant real-world use), verification of review/hunt findings via the refuter pair (cursor_refute — "перепроверь находки", confirm/refute a bug list), plus mechanical bulk edits, codemods, boilerplate, docstrings, test scaffolds — or when the user says "отдай в cursor" / "delegate to composer".
---

# Delegating to Cursor Composer (cursor-bridge)

Claude stays architect and reviewer; Composer does mechanical work in parallel.
Quality responsibility never transfers.

**Verification rule (non-negotiable):** everything Composer returns — findings, review
comments, explanations, diffs — is an UNVERIFIED hypothesis, not a fact. Before acting on it:
1. Independently confirm or refute EACH claim against the actual code/docs (read the cited
   lines, reproduce the issue, or run a focused check). Never fold unverified findings into
   specs, plans, or fixes wholesale.
2. For edits: review the full diff and run the project's tests/lint.
3. Record explicitly which claims you confirmed and which you refuted — a refuted finding is
   a result too. `cursor_result`/`cursor_ask` return a `verify_note` field repeating this rule.

## Tool availability & recovery (check FIRST)

Exact tool names (note the hyphen in the server segment): `mcp__cursor-bridge__cursor_run`,
`...cursor_status`, `...cursor_result`, `...cursor_reply`, `...cursor_ask`, `...cursor_cancel`, `...cursor_jobs`,
`...cursor_review`, `...cursor_review_result`, `...cursor_refute`, `...cursor_refute_result`.
Load them via ToolSearch: `select:mcp__cursor-bridge__cursor_run,mcp__cursor-bridge__cursor_status,...`

If ToolSearch finds nothing:
1. **Right after session start** the server may still be connecting — wait ~5 s, retry the same `select:` once.
2. **Still empty** → this session predates the server's registration and will NEVER see the tools.
   `claude mcp list` showing "✔ Connected" does NOT disprove this — it checks CLI config, not this session's toolset.
   Recovery without restart — drive the bridge through a headless session (keeps watchdog/queue/journal/git-gates):
   ```bash
   claude -p "Use cursor_run (mode=..., cwd=...) with prompt '...'. Call cursor_result(wait_sec=60..120), repeating while non-terminal, then report result_text and diff_stat verbatim." --allowedTools "mcp__cursor-bridge__*"
   ```
   Prefer `cursor_result(wait_sec=...)` over a `cursor_status` poll loop here: a headless driver that
   ends its own turn mid-poll kills the server, and shutdown then cancels the still-live job
   (a real dogfooding incident lost 30s of work / 23 tool calls this way). `wait_sec` blocks inside a
   single tool call instead, so there's no loop for the driver to walk away from mid-flight.
3. **Raw `cursor-agent` CLI is the LAST resort** (no watchdog, no journal, no dirty-tree gate; known intermittent hang bug):
   only for one-off read-only questions, always with a hard Bash timeout, `--trust`, and `--` before the prompt:
   `cursor-agent -p --output-format text --mode ask --model composer-2.5 --trust -- "<question>"`

## When to delegate
- Second opinions: artifact reviews (plans, diffs, docs) via `cursor_review` — in practice
  the dominant use of the bridge (~85% of jobs); large non-review questions via `cursor_run(mode=ask)`; see pattern 4
- Mechanical bulk edits and codemods across many files
- Boilerplate, scaffolds, JSDoc/docstrings, test skeletons
- Independent routine subtasks that free you to keep working

## When NOT to delegate
- Architecture and design decisions
- Debugging and anything requiring conversation context
- Security-sensitive code

## Model rule
Always the default `composer-2.5`. Another model ONLY if the user explicitly names one
(e.g. "отдай ревью в cursor на opus").

## Brief template (Composer cannot ask follow-ups — briefs must be self-contained)

```text
GOAL: <one sentence>
CONTEXT: <what the project is, relevant conventions>
FILES: <exact paths or glob>
CONSTRAINTS: <style, libs allowed/forbidden, what NOT to touch>
ACCEPTANCE: <how to verify done; commands to run>
OUTPUT: <expected form of the final answer>
```

## Patterns

1. **One-shot**: `cursor_run(mode=edit)` → keep working → `cursor_result(wait_sec=60..120)` (repeat while
   non-terminal) → review diff → run tests. Prefer `wait_sec` over polling `cursor_status` in a loop — see
   the turn-boundary note under tool recovery above. Poll `cursor_status` instead only when you need
   incremental progress reporting while other work is in flight, not as the primary wait mechanism.
2. **Plan → execute**: `cursor_run(mode=plan)` → review plan → `cursor_reply("план утверждён, выполняй", mode=edit)` — same chat keeps context.
3. **Fan-out**: several `cursor_run(isolation=worktree)` in parallel (max 3) → review and merge worktrees one by one.
4. **Second opinion** — two distinct cases, do not conflate them:
   - **Reviewing an artifact** (plan, spec, design doc, diff — any "find what's wrong
     with this document" ask) → `cursor_review` ONLY. Reviews are never single-axis
     (invariant): the tool fans out 2–3 adversarial briefs of different temperaments
     and scales the count by artifact weight; override with `axes`. Fetch via
     `cursor_review_result(wait_sec=60..120)`, repeated while non-terminal. Findings
     are UNVERIFIED hypotheses — confirm/refute each one before acting (~15% refute
     rate historically, including math findings by the math-focused axis).
     Trigger examples: final gate before executing a plan; final gate before merging
     a spec; "прогони ревью" on any document. Set `cycles_passed` honestly — it
     changes the brief tone from "full review" to "find what SURVIVED".
     Pass `axis_set="code"` when the artifact is source code (a branch diff, a
     module, changed files before a PR) — the plan-flavored axes stay for specs,
     plans and design docs. For diffs, pass the CHANGED FILES as artifacts and
     name the base ref in context (e.g. "compare with git diff main...HEAD").
   - **A large non-review question** (explain this subsystem, compare approaches,
     cross-file analysis) → `cursor_run(mode=ask)` + `cursor_result(wait_sec=60..120)`.
     Same read-only semantics, no 120 s cap. NOT for artifact reviews — that path is
     single-axis by construction and teaches you to bypass the review invariant.
   - Short focused question about one file/small diff → `cursor_ask` (sync, 120 s cap).
     Avoid firing `cursor_ask` while a review is in flight: axes occupy all 3 slots and
     the ask adds a 4th Composer process (contention slows the axes).
5. **Manage in-flight jobs**: `cursor_jobs` lists all jobs this session (status/mode/isolation/preview) — use after fan-out or if job_ids are lost. `cursor_cancel(job_id)` stops a queued/running job before waiting on the watchdog.

### Pattern: hunt verification — cursor_refute

After a code hunt (cursor_review axis_set=code) produced findings, do NOT hand-verify
each one first. Feed the pack (per code area, 1..12 findings) to `cursor_refute`:
prosecutor + advocate verify in parallel; fetch `cursor_refute_result(wait_sec=60..120)`
repeatedly while non-terminal.

Rules (non-negotiable, mirror of RETRO §7.3 constraints):
- consensus=refuted → the record is CLOSED but NEVER deleted: keep it with both
  verdicts and quotes in the bug library (a refuted finding is also a result).
- consensus=escalate → human arbitration; bring both role verdicts verbatim.
- A degraded pair yields zero auto-closes — retry the failed role once
  (new cursor_refute call for the same pack) before arbitrating by hand.
- Record human restores of auto-refuted findings in the hunt journal —
  false-refute rate is measured against the pilot baseline (~25%, domain-skewed:
  hardened core 31–33% vs raw orchestration seams 9–18%; a flat rate across
  domains means the refuter is broken).

## Timeouts (three separate budgets — pick by failure mode)
- `timeout_sec` — hard cap on the whole job (default 600).
- `first_token_grace_sec` — thinking budget to the model's FIRST token (default 480).
  Long pre-answer silence is NORMAL for heavy reviews on large resumed contexts — it is
  thinking, not a hang. Raise this for big-context `mode=ask` questions and `cursor_reply`
  into long chats (review axes via `cursor_review` already default to 900 s).
- `idle_sec` — inter-token stall detector AFTER the first token (default 180).

## Safety defaults
- In-place edits require a clean git tree (the tools enforce this); prefer `isolation=worktree` for risky/bulk changes.
- Watchdog kills are NOT one recipe — read the error text and telemetry before retrying:
  - `watchdog: first-token-timeout` — the model never started answering (thinking budget
    exhausted). Do NOT blindly re-run the same resumed chat: an identical retry died
    identically in the observed incident. Instead: raise `first_token_grace_sec`, or start
    a FRESH chat (drop `resume_chat_id` — smaller context thinks faster), or split the brief.
  - `watchdog: idle-timeout` with zero output — the known `-p` hang bug fired; re-running
    is fine.
  - `watchdog: idle-timeout` mid-stream (there is partial output/tool calls) — likely the
    hang bug too; re-run, and check `cursor_stats`/the `watchdog_kill` signal fields
    (`saw_first_token`, `output_chars`) if it repeats.
- After `cursor_result`: read `diff_stat`/`changed_files`, review the actual diff, run the project's tests before accepting.
- Prompts are visible in local `ps` output — never put secrets in briefs.

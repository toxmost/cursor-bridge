# cursor-bridge

**MCP server that turns Cursor's headless `cursor-agent` into a disciplined second AI workforce for Claude Code** — delegate mechanical work, run multi-axis adversarial reviews, and verify findings with a prosecutor/advocate pair. Every job runs under watchdogs, git safety gates and local telemetry.

🇷🇺 [Русская версия](README.ru.md)

---

## Why

If you pay for both Claude Code and Cursor, your Cursor quota often sits idle while Claude does everything. cursor-bridge puts it to work:

- **A different model family reviews your artifacts.** Cross-model reviews catch what same-model reviews rubber-stamp.
- **Mechanical work runs in parallel.** Bulk edits, codemods, boilerplate, test scaffolds — Composer grinds while Claude keeps architecting.
- **Machine-checked verification.** Review findings are hypotheses; the refuter pair confirms or refutes each one against the actual code, with citations the server verifies literally.

## The three mechanisms

### 1. Delegation — `cursor_run` / `cursor_ask` / `cursor_reply`

Async jobs against any repo: `edit` mode (writes code, gated by a clean git tree or worktree isolation), `plan` and `ask` modes (read-only). Multi-turn: `cursor_reply` continues the same Composer chat. Up to 3 parallel agents; per-call model override.

### 2. Detectives — `cursor_review` (multi-axis adversarial review)

A review is **never single-axis**: 2–3 parallel reviewers with deliberately different temperaments read the same artifact and cannot see each other.

| Axis set | Axes | For |
|---|---|---|
| `plan` (default) | broad · strict · hygiene | specs, plans, design docs |
| `code` | correctness · security · tests | source code (always all 3) |

Findings come back as a structured table (marker / file:line / title per axis) plus raw outputs and a cross-axis overlap report. Machine clean-pass criterion: `completed && !parse_degraded && blockers_total == 0`.

### 3. Investigators — `cursor_refute` (prosecutor/advocate verification)

Feed it a pack of findings (1–12 per code area). Two adversarial roles run in parallel:

- **prosecutor** — proves each bug is real by tracing the call chain to the failure;
- **advocate** — proves it false by finding defenses and documented design decisions.

The server then applies a deliberately asymmetric consensus:

| Outcome | Condition |
|---|---|
| `confirmed` (auto) | both roles CONFIRMED, both citations machine-verified |
| `refuted` (auto-close; **record is kept, never deleted**) | both roles REFUTED, both citations machine-verified |
| `escalate` → human | anything else: disagreement, uncertainty, failed citation, missing verdict, degraded role, changed working tree |

“Machine-verified citation” is literal: the quoted fragment must exist in the cited file **within ±20 lines of the cited line**, be substantive (not a `////` fence), come from a git-tracked file, and be accompanied by actual reasoning. The working tree is pinned between submit and result (`git` HEAD + dirty check); an unpinned tree kills all auto-verdicts. A failed or lazy role (>50 % of the pack ignored) kills all auto-closes for the pack.

**Philosophy:** the bridge automates the *labor* of verification, never the *right* to a final verdict. Contested findings always reach a human.

## Tool reference

| Group | Tools |
|---|---|
| Delegation | `cursor_run`, `cursor_ask`, `cursor_reply` |
| Review | `cursor_review`, `cursor_review_result` |
| Verification | `cursor_refute`, `cursor_refute_result` |
| Job management | `cursor_status`, `cursor_result`, `cursor_jobs`, `cursor_cancel`, `cursor_stats`, `cursor_mark_analyzed` |

Every result carries a `verify_note`: subagent output is an unverified claim until confirmed against the code.

## Requirements

- **Node.js ≥ 26** (the server runs TypeScript natively — no build step)
- **[cursor-agent CLI](https://cursor.com/cli)** installed and signed in (`cursor-agent login`), with an active Cursor subscription
- **Claude Code** (or any MCP client that can spawn stdio servers)

## Install

```bash
git clone https://github.com/<you>/cursor-bridge.git
cd cursor-bridge
./install.sh            # server + Claude Code skill
# ./install.sh --no-skill
# ./install.sh --uninstall
```

The installer registers the server with `claude mcp add --scope user` and copies the optional **cursor-delegate skill** into `~/.claude/skills/` — the skill teaches Claude *when* to reach for which mechanism. For other MCP clients, register a stdio server running `node <repo>/src/server.ts`.

Start a **new** Claude Code session after installing — running sessions keep their old toolset.

## Usage

Talk to Claude naturally; the skill routes to the right tool:

```text
» Delegate to Composer: add JSDoc to every exported function in src/.
    → cursor_run(mode=edit) … cursor_result

» Get a second opinion on docs/design.md.
    → cursor_review(artifacts=[…], axis_set=plan) … cursor_review_result

» Re-check these five bug findings against the code.
    → cursor_refute(findings=[…], cwd=…) … cursor_refute_result
```

Or call tools directly — e.g. a verification pack:

```jsonc
// cursor_refute
{
  "findings": [{
    "id": "B-001",
    "title": "bonus spent but order update can fail",
    "file": "src/pay.ts", "line": 42, "severity": "S1",
    "claim": "spendBonus succeeds, then updateOrders throws — money gone, no discount recorded"
  }],
  "cwd": "/abs/path/to/repo",
  "context": "payments module; pinned read-only worktree",
  "domain": "orchestration"   // feeds false-refute calibration
}
```

## Reliability & safety

- **Three watchdog budgets** per job: hard timeout, first-token grace (thinking is not a hang), inter-token idle. The known `cursor-agent -p` hang bug is contained by design.
- **Git gates:** in-place edits require a clean tree; `isolation: "worktree"` gives risky jobs their own git worktree.
- **Read-only means read-only:** review and refute run in `ask` mode — they cannot touch your files.
- **Local-only data:** job journals and telemetry live in `jobs/` and `logs/` inside the repo (gitignored). Nothing leaves your machine except the prompts sent to Cursor's API by `cursor-agent` itself.
- **Prompts are visible in local `ps` output** — never put secrets in briefs.

## Project layout

```text
src/            server, job manager, watchdogs, git safety, review + refute engines, telemetry
skills/         cursor-delegate skill for Claude Code (when to use which mechanism)
tools/audit/    standalone repo-mapping helpers (build-blocks, preflight) for large-scale code audits
test/           285 tests (node:test), including an end-to-end fake-agent harness
```

## Development

```bash
npm ci
npm test        # node --test, no build step
```

## License

[MIT](LICENSE)

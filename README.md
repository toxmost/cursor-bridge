# cursor-bridge

🇷🇺 [Русская версия](README.ru.md)

If you pay for both Claude Code and Cursor, you've probably noticed an awkward thing: Claude does all the work while your Cursor subscription mostly sits there, quietly renewing itself every month.

cursor-bridge fixes that. It's an MCP server that hands Cursor's headless `cursor-agent` to Claude Code as a **second AI workforce** — one that Claude can delegate to, argue with, and use as an independent fact-checker. Not a toy integration: every job runs under watchdog timers, git safety gates, and local telemetry, because the whole point is to trust the results.

## The idea in one story

Say Claude just reviewed your code and found fifteen suspicious spots. Now what? You could read all fifteen yourself — that's an evening gone. You could trust them blindly — and about a quarter of AI review findings turn out to be wrong, so now you're "fixing" code that was fine.

Or you could do what this project does: hand the findings to **a different model family** and let two adversarial roles fight over each one. A *prosecutor* tries to prove each bug is real by tracing the code path to the failure. An *advocate* tries to prove it's a false alarm by finding the guard clause, the lock, the documented design decision the reviewer missed. When they agree — with code citations the server literally verifies against your files — the case closes automatically. When they disagree, it lands on your desk. You end up reading three contested findings instead of fifteen.

That's the philosophy running through the whole project: **automate the labor of verification, never the right to a final verdict.**

## What's inside

One server, thirteen tools, three mechanisms. Think of it as a toolbox with three drawers.

### Drawer one: delegation

The bread and butter. `cursor_run` starts an async Composer job in any repo — bulk edits, codemods, boilerplate, test scaffolds, the mechanical stuff that eats your day. `cursor_ask` is for quick questions, `cursor_reply` continues a conversation with the same agent. Jobs run up to three in parallel, and you can pick a different model per call.

Write access is taken seriously: an editing job either requires a clean git tree or gets its own isolated git worktree. If it goes sideways, your work doesn't.

### Drawer two: the detectives

`cursor_review` runs an adversarial review of any artifact — a spec, a plan, a diff, a module. The trick that makes it work: a review is **never a single reviewer**. Two or three parallel reviewers with deliberately different temperaments read the same thing without seeing each other. For documents that's *broad* (external risks and blind spots), *strict* (internal rigor, the cold examiner), and *hygiene* (tests that would pass on broken code). For source code it's *correctness*, *security*, and *tests* — always all three.

Different temperaments genuinely find different things; the overlap report shows you where they agree, which is usually where the fire is.

### Drawer three: the investigators

`cursor_refute` is the newest mechanism, the one from the story above. You feed it a pack of findings — up to twelve for one area of code — and the prosecutor/advocate pair goes to work. The server then applies a deliberately asymmetric rule:

- **Auto-confirm** only when both roles say "real" with verified citations.
- **Auto-close as refuted** only when both say "false alarm" with verified citations — and even then the record is kept forever, never deleted. A refuted finding is also a result.
- **Everything else escalates to you**: disagreements, uncertainty, a citation that didn't check out, a role that died or got lazy.

"Verified citation" means exactly that. The quoted code must actually exist in the cited file, within twenty lines of the cited line, must be substantive (a `////////` fence proves nothing), must come from a git-tracked file, and must be accompanied by actual reasoning. The server also pins your working tree between start and finish — if HEAD moved or the tree got dirty, all auto-verdicts are off, because a verdict about code that changed underneath it is worth nothing.

## Getting started

You'll need three things:

- **Node.js 26+** — the server runs TypeScript natively, there's no build step at all;
- the **[cursor-agent CLI](https://cursor.com/cli)**, installed and signed in (`cursor-agent login`), with an active Cursor subscription;
- **Claude Code** — or any other MCP client that can talk to stdio servers.

Then it's one command — `npx` fetches the server straight from GitHub, dependencies and all:

```bash
claude mcp add --scope user cursor-bridge -- npx -y github:toxmost/cursor-bridge
```

That's the whole install. `--scope user` makes the tools available in every project.

Prefer a local checkout (say, for hacking on it)? Clone and point Claude at it:

```bash
git clone https://github.com/toxmost/cursor-bridge.git && cd cursor-bridge && npm ci --omit=dev
claude mcp add --scope user cursor-bridge -- node "$PWD/src/server.ts"
```

**Optional but recommended** — the cursor-delegate skill, a playbook that teaches Claude when to reach for which drawer so you don't have to remember tool names. It's a single file:

```bash
mkdir -p ~/.claude/skills/cursor-delegate
curl -fsSL https://raw.githubusercontent.com/toxmost/cursor-bridge/main/skills/cursor-delegate.SKILL.md \
  -o ~/.claude/skills/cursor-delegate/SKILL.md
```

To uninstall: `claude mcp remove --scope user cursor-bridge` and delete the skill folder.

One thing to remember: already-running Claude Code sessions keep their old toolset. Open a fresh session after installing.

## Day-to-day use

You mostly just talk to Claude:

> "Delegate to Composer: add JSDoc to every exported function in src/."
>
> "Get me a second opinion on docs/design.md before I build this."
>
> "Here are five bug findings from the review — re-check them against the code."

The skill routes each request to the right mechanism. If you prefer calling tools directly, here's what a verification pack looks like:

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
  "domain": "orchestration"   // lets you track false-refute rates per domain later
}
```

Poll `cursor_refute_result` (it supports long-polling via `wait_sec`) and you get both roles' verdicts per finding, the consensus, and counters for auto-confirmed / auto-refuted / escalated.

## Why you can trust it with real work

A few hard-won design decisions, each of them paid for by an actual incident during development:

- **Three separate watchdog budgets per job** — a hard timeout, a "first token" grace period (a model thinking for five minutes before answering is normal for heavy reviews, not a hang), and an inter-token stall detector. The known `cursor-agent -p` hang-forever bug is contained by design rather than hoped away.
- **Read-only means read-only.** Reviews and verification run in ask mode; they physically cannot modify your files.
- **Every result carries a `verify_note`** reminding whoever reads it — human or AI — that subagent output is an unverified claim until checked. This sounds preachy until the first time an agent folds a wrong finding into a spec.
- **Everything stays local.** Job journals and telemetry live in `jobs/` and `logs/` inside the repo, both gitignored. Nothing leaves your machine except what `cursor-agent` itself sends to Cursor's API.
- One honest caveat: **prompts are visible in local `ps` output**, so don't put secrets in briefs.

## Project layout

```text
src/            the server: job manager, watchdogs, git safety, review & refute engines, telemetry
skills/         the cursor-delegate skill for Claude Code
tools/audit/    standalone helpers for mapping large repos before a systematic code audit
test/           285 tests (node:test), including an end-to-end harness with a fake agent
```

Development is refreshingly boring: `npm ci`, then `npm test`. No build, no bundler, no config.

## License

[MIT](LICENSE). Use it, fork it, break it, tell us what you found.

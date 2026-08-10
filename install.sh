#!/usr/bin/env bash
# cursor-bridge installer: registers the MCP server with Claude Code and
# (optionally) installs the cursor-delegate skill.
#
# Usage:
#   ./install.sh              install server + skill
#   ./install.sh --no-skill   install server only
#   ./install.sh --uninstall  remove server registration + skill
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${HOME}/.claude/skills/cursor-delegate"
SERVER="cursor-bridge"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user "$SERVER" 2>/dev/null && say "MCP server '$SERVER' unregistered" \
      || warn "MCP server '$SERVER' was not registered"
  fi
  if [[ -d "$SKILL_DIR" ]]; then
    rm -rf "$SKILL_DIR"
    say "Skill removed: $SKILL_DIR"
  fi
  say "Done. The repository itself was left in place: $REPO_DIR"
  exit 0
fi

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js >= 26 (https://nodejs.org)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 26 ]] || die "Node.js >= 26 required (native TypeScript execution); found $(node --version)."

if ! command -v cursor-agent >/dev/null 2>&1; then
  warn "cursor-agent CLI not found in PATH."
  warn "Install it from https://cursor.com/cli and sign in (cursor-agent login),"
  warn "otherwise every job will fail at spawn time."
fi

command -v npm >/dev/null 2>&1 || die "npm not found (ships with Node.js)."

# --- dependencies ------------------------------------------------------------

say "Installing dependencies…"
(cd "$REPO_DIR" && npm ci --omit=dev --silent)

# --- MCP registration --------------------------------------------------------

if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user "$SERVER" >/dev/null 2>&1 || true
  claude mcp add --scope user "$SERVER" -- node "$REPO_DIR/src/server.ts"
  say "MCP server registered (user scope): $SERVER -> $REPO_DIR/src/server.ts"
  say "Already-running Claude Code sessions keep the old toolset — start a new session."
else
  warn "Claude Code CLI ('claude') not found — skipping automatic registration."
  warn "For any MCP client, register a stdio server with this command line:"
  printf '\n    node %s/src/server.ts\n\n' "$REPO_DIR"
fi

# --- skill (optional) --------------------------------------------------------

if [[ "${1:-}" != "--no-skill" ]]; then
  mkdir -p "$SKILL_DIR"
  cp "$REPO_DIR/skills/cursor-delegate.SKILL.md" "$SKILL_DIR/SKILL.md"
  say "Skill installed: $SKILL_DIR/SKILL.md"
else
  say "Skill installation skipped (--no-skill)."
fi

say "Install complete. Try it from a fresh Claude Code session:"
say '  "use cursor_ask to ask Composer what this repo does"'

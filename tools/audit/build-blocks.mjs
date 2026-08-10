// Thin-map stage 0 of the archaeology pilot (spec 2026-08-09 §3).
// Deterministic by construction: reads a pinned worktree and git history UP TO
// the pin only; time windows are relative to the pin commit's date, never "now".
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Mirrors the bridge's MAX_ARTIFACT_BYTES (src/review.ts) — a block file above
 * this cannot be submitted to cursor_review; keep the two in sync manually. */
export const MAX_FILE_BYTES = 2_000_000;

// Uncalibrated; empirical review ceiling (pilot spec §3), tuned by stage-4 retro.
export const MAX_SHARD_LOC = 4000;

export function git(root, args) {
  // very large monorepos: `git log --name-only` over the full pre-pin history can
  // exceed the 64 MiB default well before it exceeds this budget.
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function listTracked(root) {
  return git(root, ["ls-files"]).split("\n").filter(Boolean);
}

// Generated/vendored artifacts are noise for review: locks, dist, minified,
// maps, snapshots, binaries by extension.
const EXCLUDE_RE = [
  /(^|\/)(dist|build|coverage|node_modules|\.next|vendor)\//,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock)$/,
  /\.(min\.js|min\.css|map|snap|lock)$/,
  /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|webm)$/i,
];
export function isExcluded(relpath) {
  return EXCLUDE_RE.some((re) => re.test(relpath));
}

/** Block naming: apps/<app>/src/<top> → "apps/<app>/<top>"; packages/<p> →
 * "packages/<p>"; otherwise the first path segment. */
export function blockOf(relpath) {
  const seg = relpath.split("/");
  if (seg[0] === "apps" && seg.length >= 4 && seg[2] === "src") return `apps/${seg[1]}/${seg[3].replace(/\.\w+$/, "")}`;
  if (seg[0] === "apps" && seg.length >= 3) return `apps/${seg[1]}`;
  if (seg[0] === "packages" && seg.length >= 2) return `packages/${seg[1]}`;
  return seg[0];
}

export function fileStats(root, relpath) {
  const abs = path.join(root, relpath);
  const text = readFileSync(abs, "utf8");
  const parts = text.split("\n");
  const loc = text === "" ? 0 : parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
  return { loc, bytes: statSync(abs).size };
}

/** Co-change across blocks: commits up to the pin whose file lists span >1 block.
 * Key is "A|B" with A<B; value is the number of shared commits (a seam weight).
 * `lookup` maps a relpath to its block name — defaults to `blockOf` for direct
 * unit calls, but buildMap passes the import-reassignment-aware mapping so a
 * file that moved blocks doesn't keep welding its old (possibly now-empty)
 * directory block to whatever it co-changes with. */
// Commit-boundary sentinel: `%x00%H` prefixes every commit's hash line with a
// literal NUL byte. A tracked file's path can never contain NUL, so `\0` at
// the start of a line unambiguously marks a commit boundary — unlike the
// former `^[0-9a-f]{40}$` check, which also matched a tracked file whose NAME
// happened to be exactly 40 hex characters (e.g. a content-hash-named asset),
// wrongly splitting that commit's real file list into two bogus groups.
const COMMIT_BOUNDARY_RE = /^\0[0-9a-f]{40}$/;

export function coChange(root, pin, sinceEpoch, lookup = blockOf) {
  const raw = git(root, ["log", pin, `--since=${sinceEpoch}`, "--name-only", "--pretty=%x00%H"]);
  const map = new Map();
  let files = [];
  const flush = () => {
    const blocks = [...new Set(files.filter((f) => !isExcluded(f)).map(lookup))].sort();
    for (let i = 0; i < blocks.length; i++)
      for (let j = i + 1; j < blocks.length; j++) {
        const k = `${blocks[i]}|${blocks[j]}`;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
    files = [];
  };
  for (const line of raw.split("\n")) {
    if (COMMIT_BOUNDARY_RE.test(line)) flush();
    else if (line.trim()) files.push(line.trim());
  }
  flush();
  return map;
}

// per-block commit counts within a window ending at the pin. `lookup` — see coChange.
export function commitsTouching(root, pin, sinceEpoch, lookup = blockOf) {
  const raw = git(root, ["log", pin, `--since=${sinceEpoch}`, "--name-only", "--pretty=%x00%H"]);
  const counts = new Map();
  let seen = new Set();
  const flush = () => { for (const b of seen) counts.set(b, (counts.get(b) ?? 0) + 1); seen = new Set(); };
  for (const line of raw.split("\n")) {
    if (COMMIT_BOUNDARY_RE.test(line)) flush();
    else if (line.trim() && !isExcluded(line.trim())) seen.add(lookup(line.trim()));
  }
  flush();
  return counts;
}

function rank(entries) {
  // descending value → rank 1..n; equal values share a rank (dense ranking)
  const sorted = [...new Set(entries.map(([, v]) => v))].sort((a, b) => b - a);
  return new Map(entries.map(([k, v]) => [k, sorted.indexOf(v) + 1]));
}

/** Hotness = SUM of ranks (spec: not a product — zero churn must not zero coupling). */
export function hotness(blockNames, cc, churn, recent) {
  const coupling = new Map(blockNames.map((b) => [b, 0]));
  for (const [k, v] of cc) {
    const [a, bb] = k.split("|");
    coupling.set(a, (coupling.get(a) ?? 0) + v);
    coupling.set(bb, (coupling.get(bb) ?? 0) + v);
  }
  const rc = rank(blockNames.map((b) => [b, churn.get(b) ?? 0]));
  // Spec §3: rank the SHARE of recent commits in churn, not the raw recent count —
  // a small block with few but concentrated-recent commits should outrank a big
  // stale one, which raw-count ranking would miss.
  const rr = rank(blockNames.map((b) => {
    const c = churn.get(b) ?? 0;
    const rec = recent.get(b) ?? 0;
    return [b, c > 0 ? rec / c : 0];
  }));
  const rk = rank(blockNames.map((b) => [b, coupling.get(b) ?? 0]));
  return new Map(blockNames.map((b) => [b, {
    churn: churn.get(b) ?? 0, recent: recent.get(b) ?? 0, coupling: coupling.get(b) ?? 0,
    rankSum: rc.get(b) + rr.get(b) + rk.get(b),
  }]));
}

/** Split an over-limit block by subdirectory; an indivisible oversize subdir
 * stays a single shard (no infinite recursion) — stage 2 handles it manually. */
export function shardBlock(files, maxLoc = MAX_SHARD_LOC) {
  const total = files.reduce((s, f) => s + f.loc, 0);
  if (total <= maxLoc) return [files.map((f) => f.path)];
  const byDir = new Map();
  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/");
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  if (byDir.size === 1) return [files.map((f) => f.path)];
  const shards = [];
  let cur = [], curLoc = 0;
  for (const [, dirFiles] of [...byDir.entries()].sort()) {
    const dirLoc = dirFiles.reduce((s, f) => s + f.loc, 0);
    if (curLoc + dirLoc > maxLoc && cur.length) { shards.push(cur); cur = []; curLoc = 0; }
    cur.push(...dirFiles.map((f) => f.path)); curLoc += dirLoc;
  }
  if (cur.length) shards.push(cur);
  return shards;
}

// Which tracked files count as SOURCES of imports (targets may be any tracked file).
export const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

// `import ... from "x"` / `export ... from "x"` (single or double quotes); the
// non-greedy middle allows default/named/namespace/type-only import clauses AND
// newlines — Prettier wraps multi-name clauses onto their own lines
// (`import {\n  A,\n  B,\n} from "x"`). The class still excludes quote
// characters, so the lazy match can never cross into or past a string literal
// — it stops at the nearest "from" + quote, which keeps cross-statement
// over-capture impossible (a plain string containing the word "from" later in
// the file is never reached by this match).
const FROM_RE = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g;
// Bare side-effect import: `import "x"` (no `from` clause).
const BARE_IMPORT_RE = /import\s*["']([^"']+)["']/g;
// `require("x")` and dynamic `import("x")` (single or double quotes).
const CALL_RE = /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Extracts import/require specifiers from source text: import-from, export-from,
 * bare side-effect import, require(), dynamic import(). Deduped, first-seen order
 * preserved (determinism) — order is by position in `text`, not by regex group.
 * Pure-regex, no AST: a specifier-shaped string inside a comment or string literal
 * is matched too — accepted as noise (slight over-connection), not filtered here;
 * Task B consumers should be aware edges may include such false positives. */
export function extractImports(text) {
  const found = [];
  for (const re of [FROM_RE, BARE_IMPORT_RE, CALL_RE]) {
    for (const m of text.matchAll(re)) found.push({ index: m.index, spec: m[1] });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const specs = [];
  for (const { spec } of found) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}

// Relative-resolution candidate extensions, in try order (spec §Task A design notes).
const REL_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
// TS-ESM twin: a compiled-output-style specifier may point at its TS source —
// js->ts, jsx->tsx, mjs->mts, cjs->cts (every REL_EXTS JS variant has exactly
// one TS twin; there is no twin the other direction).
const TWIN_MAP = { js: "ts", jsx: "tsx", mjs: "mts", cjs: "cts" };
const TWIN_STRIP_RE = /\.(js|jsx|mjs|cjs)$/;
// Index-file candidates: same family as REL_EXTS (an `index.mts`-only package
// must resolve exactly like an `index.ts`-only one — gate-cycle-2 parity fix).
const INDEX_EXTS = REL_EXTS;

/** tsconfig(.*).json or jsconfig(.*).json basename, matched against the posix
 * basename only (a full path like "apps/web/tsconfig.json",
 * "tsconfig.build.json", or "jsconfig.json" all qualify — jsconfig.json is
 * VS Code/JS-project tooling's tsconfig equivalent and carries the same
 * compilerOptions.paths shape). */
const TSCONFIG_RE = /^(?:ts|js)config(\..+)?\.json$/;

// Conservative JSONC comment stripper: block comments then line comments,
// then trailing commas before a closing `}`/`]`. Not a full JSON5 parser —
// good enough for the comment/trailing-comma styles tsconfig.json actually
// uses in practice (TS itself accepts trailing commas; JSON.parse does not —
// without this step a tsconfig with a trailing comma anywhere, e.g.
// `"paths": { "@/*": ["src/*"], }`, would fail to parse and ALL of its
// aliases would be silently dropped). Anything this still mangles just fails
// JSON.parse and the tsconfig is skipped (tolerated, see parseAliases).
function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

const EXTENDS_DEPTH_CAP = 5; // belt alongside the visited-set cycle guard

function readConfigJson(f, readFile) {
  try {
    return JSON.parse(stripJsonComments(readFile(f)));
  } catch {
    return null; // unreadable, or invalid JSON/JSONC even after stripping — tolerated
  }
}

/** Resolves a tsconfig's `extends` string to one of the tracked files, or null
 * for a bare/npm-package specifier (e.g. "@tsconfig/node20") that doesn't
 * resolve to a tracked file — skipped silently, per contract, since there is
 * no in-repo chain to follow for it. Relative resolution is against the
 * EXTENDING config's own directory (TS semantics); `.json` is appended when
 * missing, but the literal as-is path is tried too. */
function resolveExtendsTarget(extendsStr, configDir, fileSet) {
  const joined = path.posix.normalize(path.posix.join(configDir, extendsStr));
  const withJson = joined.endsWith(".json") ? joined : `${joined}.json`;
  if (fileSet.has(withJson)) return withJson;
  if (fileSet.has(joined)) return joined;
  return null;
}

/** Resolves the effective `compilerOptions.paths` for tsconfig `f`, following
 * its `extends` chain. Returns Map<key, {targets, defDir, defBaseUrl}>.
 * TS semantics: a `paths` entry inherited through `extends` still resolves
 * its relative target against the DECLARING config's own directory + baseUrl,
 * not the leaf's — so each entry carries `defDir`/`defBaseUrl` from whichever
 * config in the chain actually declared that key. Merge is per-key: a child
 * that redeclares a key overrides just that key (using the CHILD's own dir +
 * baseUrl for it); a key the child doesn't redeclare keeps its original
 * defDir/defBaseUrl, however far up the chain that is (base's own baseUrl,
 * not the leaf's, per contract). `visited` guards a cycle (two configs
 * extending each other): re-entering an in-progress node returns an empty map
 * instead of recursing forever — the chain still resolves with whatever is
 * resolvable up to that point. `depth` additionally caps chain length as a
 * belt alongside the cycle guard. */
function resolveMergedPaths(f, fileSet, readFile, visited, depth) {
  if (depth > EXTENDS_DEPTH_CAP || visited.has(f)) return new Map();
  visited.add(f);
  const parsed = readConfigJson(f, readFile);
  if (!parsed || typeof parsed !== "object") return new Map();
  const configDir = path.posix.dirname(f);
  let merged = new Map();
  if (typeof parsed.extends === "string") {
    const baseFile = resolveExtendsTarget(parsed.extends, configDir, fileSet);
    if (baseFile) merged = resolveMergedPaths(baseFile, fileSet, readFile, visited, depth + 1);
  }
  const opts = parsed.compilerOptions;
  const pathsMap = opts && typeof opts === "object" ? opts.paths : null;
  if (pathsMap && typeof pathsMap === "object") {
    const ownBaseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : ".";
    for (const [key, targets] of Object.entries(pathsMap)) {
      if (!Array.isArray(targets) || targets.length === 0 || typeof targets[0] !== "string") continue;
      merged.set(key, { targets, defDir: configDir, defBaseUrl: ownBaseUrl }); // child overrides base per-key
    }
  }
  return merged;
}

/** Extracts tsconfig `compilerOptions.paths` alias rules from every tracked
 * tsconfig(.*).json/jsconfig(.*).json in `files`, following each one's
 * `extends` chain (see resolveMergedPaths). For each effective paths key:
 * - wildcard form ("P/*": ["T/*", ...]) -> a prefix rule: spec.startsWith("P/")
 *   maps to targetPrefix + rest, where targetPrefix is T (baseUrl- and
 *   declaring-config-dir-relative) joined into a repo-relative path.
 * - exact form ("P": ["T"]) -> an exact rule: spec === "P" maps to T resolved
 *   the same way.
 * Only the FIRST target array entry is used per key (spec). Missing/invalid
 * JSON (even after comment stripping), and a wholly-unresolvable extends
 * chain, are tolerated — that tsconfig (or the unreachable part of its chain)
 * is skipped, not thrown. Each rule carries `scopeDir` — the posix dirname of
 * the tsconfig FILE BEING ITERATED (the child, even for an entry inherited
 * from a base) — or "" for a repo-root tsconfig — so the caller (makeResolver)
 * can restrict a rule to importers inside that tsconfig's own subtree (a
 * monorepo with the same alias prefix declared by two different tsconfigs,
 * e.g. apps/api and apps/web, must not let one silently win for the other's
 * files). Deterministic: returned in (tsconfig path, key) sorted order —
 * collision ordering among applicable rules is resolved by the caller at
 * match time, not by this ordering alone. */
export function parseAliases(files, readFile) {
  const raw = [];
  const fileSet = new Set(files);
  for (const f of files) {
    if (!TSCONFIG_RE.test(path.posix.basename(f))) continue;
    const merged = resolveMergedPaths(f, fileSet, readFile, new Set(), 0);
    if (merged.size === 0) continue;
    const tsconfigDir = path.posix.dirname(f);
    const scopeDir = tsconfigDir === "." ? "" : tsconfigDir; // "" = applies repo-wide; always the CHILD's own dir
    for (const [key, { targets, defDir, defBaseUrl }] of merged) {
      const target = targets[0]; // first target only, per contract
      if (key.endsWith("*") && target.endsWith("*")) {
        const prefix = key.slice(0, -1);
        const targetBase = path.posix.join(defDir, defBaseUrl, target.slice(0, -1)).replace(/\/+$/, "");
        raw.push({ tsconfigPath: f, key, scopeDir, kind: "prefix", prefix, targetPrefix: `${targetBase}/` });
      } else if (!key.includes("*") && !target.includes("*")) {
        const resolvedTarget = path.posix.join(defDir, defBaseUrl, target);
        raw.push({ tsconfigPath: f, key, scopeDir, kind: "exact", exact: key, target: resolvedTarget });
      }
      // wildcard/exact-shape mismatches between key and target are malformed
      // tsconfig entries — silently skipped, not thrown.
    }
  }
  // (tsconfig path, key): the deterministic tie-break for two rules that are
  // otherwise equally applicable (same scope depth, same match length) — see
  // resolveAlias in makeResolver, which relies on this order being stable
  // (strict-axis ℹ: intentional, documented here and there).
  raw.sort((a, b) => a.tsconfigPath.localeCompare(b.tsconfigPath) || a.key.localeCompare(b.key));
  return raw;
}

// scopeDir === "" is the repo-root tsconfig (applies everywhere); otherwise a
// rule applies only to importers whose relpath is inside that tsconfig's own
// directory subtree.
function scopeApplies(scopeDir, fromRel) {
  return scopeDir === "" || fromRel.startsWith(`${scopeDir}/`);
}

// Nearest tsconfig wins: depth of a scopeDir ("" = shallowest, repo root).
function scopeDepth(scopeDir) {
  return scopeDir === "" ? 0 : scopeDir.split("/").length;
}

/** Builds a resolver over a fixed file set + package.json reader — both injected,
 * no fs of its own, so units run with no disk (buildMap passes the real worktree
 * reader). `aliases` (from parseAliases) are tsconfig `paths` rules, tried before
 * bare-package resolution. Returns resolve(fromRel, spec) => tracked relpath | null.
 * - relative specs (start with ".") resolve against fromRel's directory, trying in
 *   order: exact; spec+ext; TS-ESM twin; spec+"/index."+ext. Escaping above the
 *   repo root, or no candidate present in `files`, is null.
 * - bare specs first try alias rules, scoped to fromRel: only rules whose
 *   scopeDir is "" (repo-root tsconfig) or an ancestor directory of fromRel are
 *   considered (a monorepo with the same alias prefix declared by two different
 *   tsconfigs must not let one tsconfig's rule win for the other's files).
 *   Among applicable rules, candidates are tried in order: (a) deepest scopeDir
 *   first — the nearest enclosing tsconfig wins over the repo root; (b) longest
 *   matching prefix/key; (c) deterministic (tsconfigPath, key) tie-break as a
 *   final fallback. The first candidate that resolves against `files` wins; a
 *   total miss across every applicable rule falls through to the package.json
 *   name→path map built lazily from `files` entries ending in "package.json"
 *   (parse errors tolerated: entry skipped); exact name or name+"/" prefix
 *   match; longest name wins on overlap (deterministic). No match anywhere is
 *   null.
 */
export function makeResolver(files, readFile, aliases = []) {
  const fileSet = new Set(files);
  let pkgNameToPath = null;

  function candidatesFor(joined) {
    const candidates = [joined];
    for (const ext of REL_EXTS) candidates.push(`${joined}.${ext}`);
    const twinMatch = joined.match(TWIN_STRIP_RE);
    if (twinMatch) candidates.push(`${joined.slice(0, -twinMatch[0].length)}.${TWIN_MAP[twinMatch[1]]}`);
    for (const ext of INDEX_EXTS) candidates.push(`${joined}/index.${ext}`);
    return candidates;
  }

  function resolveAgainstFileSet(joined) {
    for (const c of candidatesFor(joined)) if (fileSet.has(c)) return c;
    return null;
  }

  function resolveAlias(fromRel, spec) {
    const applicable = aliases.filter((a) => {
      if (!scopeApplies(a.scopeDir, fromRel)) return false;
      return a.kind === "exact" ? a.exact === spec : spec.startsWith(a.prefix);
    });
    if (applicable.length === 0) return null;
    const matchLen = (a) => (a.kind === "exact" ? a.exact.length : a.prefix.length);
    const ordered = [...applicable].sort((a, b) =>
      scopeDepth(b.scopeDir) - scopeDepth(a.scopeDir) ||
      matchLen(b) - matchLen(a) ||
      // Two equally-applicable, equally-specific rules (e.g. the same exact
      // key declared by two sibling tsconfigs at the same scope depth) fall
      // back to this (tsconfigPath, key) order — intentional and deterministic
      // by construction (strict-axis ℹ: documented here and in parseAliases).
      a.tsconfigPath.localeCompare(b.tsconfigPath) || a.key.localeCompare(b.key));
    for (const a of ordered) {
      const target = a.kind === "exact" ? a.target : `${a.targetPrefix}${spec.slice(a.prefix.length)}`;
      const hit = resolveAgainstFileSet(target);
      if (hit) return hit; // try the next candidate on a miss, per contract
    }
    return null;
  }

  function buildPkgMap() {
    const map = new Map();
    for (const f of files) {
      if (path.posix.basename(f) !== "package.json") continue; // exact basename — not e.g. legacy-package.json
      let parsed;
      try {
        parsed = JSON.parse(readFile(f));
      } catch {
        continue; // unreadable or invalid JSON — tolerated, entry skipped
      }
      if (parsed && typeof parsed.name === "string") map.set(parsed.name, f);
    }
    return map;
  }

  function resolveBare(fromRel, spec) {
    const aliasHit = resolveAlias(fromRel, spec);
    if (aliasHit) return aliasHit;
    if (!pkgNameToPath) pkgNameToPath = buildPkgMap();
    if (pkgNameToPath.has(spec)) return pkgNameToPath.get(spec);
    let best = null;
    for (const name of pkgNameToPath.keys()) {
      if (spec.startsWith(`${name}/`) && (!best || name.length > best.length)) best = name;
    }
    return best ? pkgNameToPath.get(best) : null;
  }

  function resolveRelative(fromRel, spec) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    if (joined === ".." || joined.startsWith("../")) return null; // escapes repo root
    return resolveAgainstFileSet(joined);
  }

  return function resolve(fromRel, spec) {
    return spec.startsWith(".") ? resolveRelative(fromRel, spec) : resolveBare(fromRel, spec);
  };
}

// Uncalibrated; how many import-graph links to a foreign block it takes to
// override a file's directory-block default (spec §3, tuned by stage-4 retro).
export const IMPORT_REASSIGN_MIN = 2; // uncalibrated; stage-4 retro tunes

// Reverse of edgesByFile: target relpath -> list of source relpaths importing it.
function importersIndex(edgesByFile) {
  const idx = new Map();
  for (const [src, targets] of edgesByFile) {
    for (const t of targets) {
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(src);
    }
  }
  return idx;
}

/** Affinity of file `f` to every block it touches via the import graph:
 * (# of f's own resolved import targets landing in that block) + (# of source
 * files in that block that import f). Returns Map<blockName, count>. */
function fileAffinity(f, edgesByFile, importersOf) {
  const affinity = new Map();
  for (const t of edgesByFile.get(f) ?? []) {
    const b = blockOf(t);
    affinity.set(b, (affinity.get(b) ?? 0) + 1);
  }
  for (const imp of importersOf.get(f) ?? []) {
    const b = blockOf(imp);
    affinity.set(b, (affinity.get(b) ?? 0) + 1);
  }
  return affinity;
}

/** Assigns every file to a block: default `blockOf`, reassigned to the best
 * foreign block iff own-affinity is exactly 0 AND that foreign block's
 * affinity is >= IMPORT_REASSIGN_MIN (tie broken by lexicographically
 * smallest block name). package.json manifests are never reassigned — they
 * are bare-import resolution targets (Task A), not import-graph participants.
 * Single pass over the base (blockOf) assignment: a reassignment does not
 * feed back into anyone else's affinity computation, so there is no cascade
 * to iterate — deterministic and O(files + edges) by construction. */
export function assignBlocks(files, edgesByFile) {
  const importersOf = importersIndex(edgesByFile);
  const result = new Map();
  for (const f of files) {
    const own = blockOf(f);
    if (path.posix.basename(f) === "package.json") { result.set(f, own); continue; }
    const affinity = fileAffinity(f, edgesByFile, importersOf);
    if ((affinity.get(own) ?? 0) !== 0) { result.set(f, own); continue; }
    let maxVal = 0;
    for (const [b, v] of affinity) if (b !== own && v > maxVal) maxVal = v;
    if (maxVal < IMPORT_REASSIGN_MIN) { result.set(f, own); continue; }
    const winners = [...affinity.entries()].filter(([b, v]) => b !== own && v === maxVal).map(([b]) => b).sort();
    result.set(f, winners[0]);
  }
  return result;
}

const WINDOW_CHURN_DAYS = 183;  // ~6 months; uncalibrated, tuned by stage-4 retro
const WINDOW_RECENT_DAYS = 92;  // ~3 months; uncalibrated, tuned by stage-4 retro

export function buildMap(root, pin) {
  const pinEpoch = Number(git(root, ["show", "-s", "--format=%ct", pin]).trim());
  const since6m = pinEpoch - WINDOW_CHURN_DAYS * 86_400;
  const since3m = pinEpoch - WINDOW_RECENT_DAYS * 86_400;
  const tracked = listTracked(root);
  const excluded = tracked.filter(isExcluded).sort();
  const oversize = [];
  const unreadable = [];
  const statsByPath = new Map();
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let st;
    try {
      st = fileStats(root, f);
    } catch {
      // A tracked file that can't be read (e.g. a symlink to a target that no
      // longer exists) must not kill the whole run — skip it, report it.
      unreadable.push(f);
      continue;
    }
    if (st.bytes > MAX_FILE_BYTES) { oversize.push(f); continue; }
    statsByPath.set(f, st);
  }
  // Non-excluded, non-oversize, non-unreadable — the file universe for the
  // import graph AND the resolver (Task A handoff: package.json entries must
  // stay visible as targets even though only SOURCE_RE files are import sources).
  const allFiles = [...statsByPath.keys()];
  const readFile = (relpath) => readFileSync(path.join(root, relpath), "utf8");
  const aliases = parseAliases(allFiles, readFile);
  const resolve = makeResolver(allFiles, readFile, aliases);
  const edgesByFile = new Map();
  for (const f of allFiles) {
    if (!SOURCE_RE.test(f)) continue;
    let text;
    try {
      text = readFile(f);
    } catch {
      unreadable.push(f); // defensive: fileStats already read it once, but re-guard the second read
      continue;
    }
    // Set, not array: distinct resolved TARGETS per source file — two specs
    // resolving to the same file ("./helper" + "./helper.ts", or two bare
    // subpaths of the same package) must count as ONE edge, not two, or
    // affinity arithmetic double-counts a single real dependency.
    const targets = new Set();
    for (const spec of extractImports(text)) {
      const t = resolve(f, spec);
      if (t) targets.add(t); // external (non-workspace) specs resolve to null — silently ignored
    }
    if (targets.size) edgesByFile.set(f, [...targets]);
  }
  const mapping = assignBlocks(allFiles, edgesByFile);
  const lookup = (relpath) => mapping.get(relpath) ?? blockOf(relpath);
  const importersOf = importersIndex(edgesByFile);
  const reassignedByImports = [...mapping.entries()]
    .filter(([f, b]) => b !== blockOf(f))
    .map(([f, b]) => ({ path: f, from: blockOf(f), to: b, links: fileAffinity(f, edgesByFile, importersOf).get(b) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const byBlock = new Map();
  for (const f of allFiles) {
    const b = lookup(f);
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push({ path: f, ...statsByPath.get(f) });
  }
  const names = [...byBlock.keys()].sort();
  const cc = coChange(root, pin, since6m, lookup);
  const hot = hotness(names, cc, commitsTouching(root, pin, since6m, lookup), commitsTouching(root, pin, since3m, lookup));
  const blocks = names.map((name) => {
    const files = byBlock.get(name).sort((a, b) => a.path.localeCompare(b.path));
    const neighbors = [...cc.entries()]
      .filter(([k]) => k.split("|").includes(name))
      .map(([k, v]) => ({ block: k.split("|").find((x) => x !== name), cochange: v }))
      .sort((a, b) => b.cochange - a.cochange || a.block.localeCompare(b.block));
    const shards = shardBlock(files);
    // A shard is "oversize" when its indivisible subdirectory content exceeds
    // MAX_SHARD_LOC — machine-visible so the ≤4000-loc criterion (spec §3) is
    // checkable without eyeballing BLOCKS.md.
    const locByPath = new Map(files.map((f) => [f.path, f.loc]));
    const oversizeShards = shards
      .map((shard, idx) => [idx, shard.reduce((s, p) => s + (locByPath.get(p) ?? 0), 0)])
      .filter(([, loc]) => loc > MAX_SHARD_LOC)
      .map(([idx]) => idx);
    return {
      name, files, loc: files.reduce((s, f) => s + f.loc, 0),
      shards, oversizeShards, neighbors, hotness: hot.get(name),
      excludedOversize: oversize.filter((f) => blockOf(f) === name),
    };
  });
  const top = [...blocks].sort((a, b) => a.hotness.rankSum - b.hotness.rankSum || a.name.localeCompare(b.name))
    .slice(0, 10).map((b) => b.name);
  // Top-level visibility: a block whose ONLY file is oversize never appears in
  // `blocks` (nothing left to add to byBlock) and is not in `excluded` either
  // (isExcluded is a different filter) — without this it vanishes silently.
  return {
    pin, blocks, top, excluded, excludedOversize: [...oversize].sort(),
    unreadable: [...new Set(unreadable)].sort(), reassignedByImports,
  };
}

if (import.meta.main) {
  const [root, pin, outDir = process.cwd()] = process.argv.slice(2);
  if (!root || !pin) { console.error("usage: build-blocks.mjs <worktree> <pin> [outDir]"); process.exit(2); }
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== pin) { console.error(`worktree HEAD ${head} != pin ${pin}`); process.exit(2); }
  // Pristine check (mirrors preflight.mjs's dirty-worktree wording): blocks.json's
  // numbers are only trustworthy against a worktree that is EXACTLY the pin.
  const dirty = git(root, ["status", "--porcelain"]).split("\n").filter(Boolean);
  if (dirty.length > 0) {
    console.error(`worktree dirty: ${dirty.length} entries (worktree must be pristine at the pin)`);
    process.exit(2);
  }
  // Shallow-clone check: co-change/hotness read git history UP TO the pin, which
  // a shallow clone doesn't have — silently truncated history would understate
  // churn/coupling without any other visible symptom.
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow === "true") {
    console.error("worktree is a shallow clone (git history is required for co-change/hotness)");
    process.exit(2);
  }
  const map = buildMap(root, pin);
  const { writeFileSync, renameSync } = await import("node:fs");
  // outDir defaults to cwd but is normally OUTSIDE the pinned worktree — writing
  // generated artifacts into the worktree itself would make it non-pristine,
  // which preflight's dirty-worktree check (gate-cycle-2) now treats as fatal.
  // Atomic writes: write to a .tmp sibling then rename over the target, so a
  // reader (or a crash mid-write) never observes a half-written artifact.
  function writeAtomic(dest, content) {
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, dest);
  }
  writeAtomic(path.join(outDir, "blocks.json"), JSON.stringify(map, null, 2));
  const md = [`# BLOCKS @ ${pin}`, "", ...map.top.map((t, i) => {
    const b = map.blocks.find((x) => x.name === t);
    return `## ${i + 1}. ${t} — ${b.loc} loc, rankSum ${b.hotness.rankSum}\n` +
      `- швы: ${b.neighbors.map((n) => `${n.block}(${n.cochange})`).join(", ") || "нет"}\n` +
      `- шардов: ${b.shards.length}${b.excludedOversize.length ? `; исключено >2МБ: ${b.excludedOversize.join(", ")}` : ""}` +
      `${b.oversizeShards.length ? ` ; OVERSIZE: шарды ${b.oversizeShards.join(", ")}` : ""}`;
  })].join("\n");
  const excludedSection = [
    "## Исключено",
    `- фильтром (generated/lock/dist): ${map.excluded.length} файлов`,
    `- сверх 2 МБ: ${map.excludedOversize.length ? map.excludedOversize.join(", ") : "нет"}`,
    ...(map.unreadable.length ? [`- нечитаемые: ${map.unreadable.join(", ")}`] : []),
  ].join("\n");
  const reassignSection = [
    "## Переезды по импортам",
    `- всего: ${map.reassignedByImports.length}`,
    ...(map.reassignedByImports.length
      ? map.reassignedByImports.map((r) => `- ${r.path}: ${r.from} → ${r.to} (links ${r.links})`)
      : ["- нет"]),
  ].join("\n");
  writeAtomic(path.join(outDir, "BLOCKS.md"), md + "\n\n" + excludedSection + "\n\n" + reassignSection + "\n");
  console.log(`blocks: ${map.blocks.length}, top-10 written`);
}

// Stage-2 preflight (pilot spec §2 "path contract" + §3 stage 2 machine checks):
// verifies the worktree is at the pin and resolves a shard's relative paths to
// absolute artifact paths INSIDE the worktree; main-tree paths are impossible
// by construction.
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { git, fileStats, MAX_FILE_BYTES, MAX_SHARD_LOC } from "./build-blocks.mjs";

export function preflight(worktree, pin, blocksJsonPath, blockName, shardIdx = 0) {
  const errors = [];
  const cwd = path.resolve(worktree);
  const head = git(worktree, ["rev-parse", "HEAD"]).trim();
  if (head !== pin) errors.push(`worktree HEAD ${head} != pin ${pin}`);
  // Dirty-worktree check (gate-cycle-2: three review axes converged on this):
  // blocks.json's loc numbers are only trustworthy against a worktree that is
  // EXACTLY the pin. Uncommitted edits let live loc silently diverge from what
  // the pin's history says without HEAD itself moving, which the HEAD==pin
  // check above cannot catch.
  const dirty = git(worktree, ["status", "--porcelain"]).split("\n").filter(Boolean);
  if (dirty.length > 0) {
    errors.push(`worktree dirty: ${dirty.length} entries (worktree must be pristine at the pin)`);
  }
  const map = JSON.parse(readFileSync(blocksJsonPath, "utf8"));
  if (map.pin !== pin) errors.push(`blocks.json pin ${map.pin} != pin ${pin}`);
  const hasBlocksArray = Array.isArray(map.blocks);
  if (!hasBlocksArray) errors.push("blocks.json malformed: no blocks array");
  const block = hasBlocksArray ? map.blocks.find((b) => b.name === blockName) : undefined;
  if (hasBlocksArray && !block) errors.push(`unknown block: ${blockName}`);
  const shard = block?.shards?.[shardIdx];
  if (block && !shard) errors.push(`block ${blockName} has no shard #${shardIdx}`);
  const filesByPath = new Map((block?.files ?? []).map((f) => [f.path, f]));
  const artifacts = [];
  // Live loc is ground truth (gate-cycle-2): trust the worktree ON DISK, not
  // blocks.json's claimed numbers, which can go stale (hand-edited or simply
  // regenerated-and-forgotten). Only files that pass exists/bytes are scanned.
  let liveLocSum = 0;
  for (const rel of shard ?? []) {
    const abs = path.resolve(worktree, rel);
    if (!abs.startsWith(path.resolve(worktree) + path.sep)) { errors.push(`escapes worktree: ${rel}`); continue; }
    if (!existsSync(abs)) { errors.push(`missing in worktree: ${rel}`); continue; }
    if (statSync(abs).size > MAX_FILE_BYTES) { errors.push(`over ${MAX_FILE_BYTES} bytes: ${rel}`); continue; }
    const live = fileStats(worktree, rel);
    liveLocSum += live.loc;
    const entry = filesByPath.get(rel);
    if (!entry) {
      errors.push(`shard path not in block.files: ${rel} (stale blocks.json?)`);
    } else if (entry.loc !== live.loc) {
      errors.push(`blocks.json stale for ${rel}: loc ${entry.loc} != live ${live.loc}`);
    }
    artifacts.push(abs);
  }
  // Budget guard, now on live truth: a shard whose files sum past MAX_SHARD_LOC
  // on disk must be marked oversize, whatever blocks.json's own numbers claim.
  if (block && shard && liveLocSum > MAX_SHARD_LOC && !(block.oversizeShards ?? []).includes(shardIdx)) {
    errors.push(`shard #${shardIdx} exceeds ${MAX_SHARD_LOC} loc but is not marked oversize (stale blocks.json?)`);
  }
  return { ok: errors.length === 0, errors, artifacts, cwd };
}

if (import.meta.main) {
  const [wt, pin, blocksJson, block, shard] = process.argv.slice(2);
  const r = preflight(wt, pin, blocksJson, block, shard ? Number(shard) : 0);
  if (!r.ok) { for (const e of r.errors) console.error(e); process.exit(2); }
  // {cwd, artifacts} — the resolved worktree path is the value stage-2
  // operators must pass as cursor_review's `cwd`; bare artifacts made this
  // easy to miss.
  console.log(JSON.stringify({ cwd: r.cwd, artifacts: r.artifacts }, null, 2));
}

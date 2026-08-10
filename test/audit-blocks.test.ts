import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  listTracked, isExcluded, blockOf, fileStats,
  coChange, commitsTouching, shardBlock, buildMap, hotness, assignBlocks,
  IMPORT_REASSIGN_MIN,
} from "../tools/audit/build-blocks.mjs";
import {
  git, fixtureRepo, fixtureRepoHistory, fixtureRepoImports,
  fixtureRepoDedupTwin, fixtureRepoDedupBare, fixtureRepoAlias,
  fixtureRepoHexFilename, addOversizeFile,
} from "./helpers/audit-fixture.ts";

const BUILD_BLOCKS_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "audit", "build-blocks.mjs",
);

test("listTracked/isExcluded: lock, dist и .min отфильтрованы, исходники на месте", () => {
  const d = fixtureRepo();
  const files = listTracked(d).filter((f) => !isExcluded(f));
  assert.deepEqual(files.sort(), [
    "apps/api/src/orders/model.ts",
    "apps/api/src/orders/service.ts",
    "packages/util/src/fmt.ts",
  ]);
});

test("blockOf: apps/<app>/src/<top> и packages/<p>", () => {
  assert.equal(blockOf("apps/api/src/orders/service.ts"), "apps/api/orders");
  assert.equal(blockOf("packages/util/src/fmt.ts"), "packages/util");
  assert.equal(blockOf("plugin-1c/handler.php"), "plugin-1c");
});

test("fileStats: loc и bytes", () => {
  const d = fixtureRepo();
  const s = fileStats(d, "apps/api/src/orders/service.ts");
  assert.equal(s.loc, 50);
  assert.ok(s.bytes >= 100);
});

test("coChange: шов между блоками считается по общим коммитам", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  // Window starts after the fixture's "init" commit (2026-01-01, which also
  // touches both blocks) and before "seam" (2026-06-01), so only "seam" counts.
  // (git's approxidate silently treats small numeric --since values, incl. 0,
  // as "now" rather than a Unix timestamp — an absolute epoch is required.)
  const since = Date.parse("2026-02-01T00:00:00Z") / 1000;
  const cc = coChange(d, pin, since);
  // Full map, not just one key: in this window only "seam" (2026-06-01) counts
  // (per the comment above), and it touches exactly the two blocks below — no
  // other pair should exist.
  assert.deepEqual(Object.fromEntries(cc), { "apps/api/orders|packages/util": 1 });
});

// ---- 40-hex tracked filename vs commit-hash boundary (gate-cycle-2-retry #2) ----

const HEX_NAME = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

test("coChange: a tracked file whose repo-relative PATH is 40 hex chars does not split the commit's file list", () => {
  const d = fixtureRepoHexFilename();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const since = Date.parse("2026-01-15T00:00:00Z") / 1000; // after init, only "seam-with-hex-filename" counts
  const cc = coChange(d, pin, since);
  // blockOf's fallback for a root-level file with no directory component
  // returns the filename itself — a legitimate, if unusually-named, singleton
  // block. Sorted alphabetically ("apps/..." < "deadbeef...").
  assert.deepEqual(Object.fromEntries(cc), { [`apps/api/orders|${HEX_NAME}`]: 1 });
});

test("commitsTouching: a tracked file whose repo-relative PATH is 40 hex chars still counts both blocks it co-touches", () => {
  const d = fixtureRepoHexFilename();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const since = Date.parse("2026-01-15T00:00:00Z") / 1000;
  const counts = commitsTouching(d, pin, since);
  assert.equal(counts.get("apps/api/orders"), 1);
  assert.equal(counts.get(HEX_NAME), 1);
});

test("shardBlock: блок тяжелее лимита режется по подкаталогам, лёгкий — один шард", () => {
  const files = [
    { path: "m/a/x.ts", loc: 3000 }, { path: "m/a/y.ts", loc: 1500 },
    { path: "m/b/z.ts", loc: 2000 },
  ];
  const shards = shardBlock(files, 4000);
  // m/a totals 4500 loc but is a single subdirectory — it is never split, so it
  // stays one shard (over the limit, allowed for an indivisible dir); m/b is
  // its own shard. Total: 2 shards.
  assert.deepEqual(shards, [["m/a/x.ts", "m/a/y.ts"], ["m/b/z.ts"]]);
});

test("shardBlock: неделимый оверсайз-подкаталог остаётся шардом (не бесконечная рекурсия)", () => {
  const shards = shardBlock([{ path: "m/a/only.ts", loc: 9000 }], 4000);
  assert.deepEqual(shards, [["m/a/only.ts"]]);
});

test("hotness: компонента recent ранжирует ДОЛЮ свежего в churn, не сырой счёт (спека §3)", () => {
  // A: big steady block (churn 100, recent 10 → share .1)
  // B: small recent-concentrated block (churn 4, recent 2 → share .5)
  // C: big stale block (churn 50, recent 1 → share .02)
  // coupling: none → all tie at rank 1.
  // churn ranks: A=1, C=2, B=3. share ranks: B=1, A=2, C=3.
  // rankSum(share): A=1+2+1=4, B=3+1+1=5, C=2+3+1=6 → B beats C.
  // Under raw-recent ranking B and C would tie at 6 — this assertion pins the share semantics.
  const names = ["A", "B", "C"];
  const churn = new Map([["A", 100], ["B", 4], ["C", 50]]);
  const recent = new Map([["A", 10], ["B", 2], ["C", 1]]);
  const hot = hotness(names, new Map(), churn, recent);
  assert.equal(hot.get("A")!.rankSum, 4);
  assert.equal(hot.get("B")!.rankSum, 5);
  assert.equal(hot.get("C")!.rankSum, 6);
});

test("buildMap: неделимый oversize-шард помечается в oversizeShards", () => {
  const d = fixtureRepo();
  // A single >4000-loc file inside the already-existing apps/api/src/orders dir
  // makes that block's one subdirectory indivisible-and-oversize (shardBlock
  // never splits a single directory), so it stays exactly one shard, flagged.
  writeFileSync(path.join(d, "apps/api/src/orders/big.ts"), "x\n".repeat(4500));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "oversize"], {
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  });
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  const orders = m.blocks.find((b) => b.name === "apps/api/orders")!;
  assert.equal(orders.shards.length, 1); // single subdirectory — indivisible
  assert.deepEqual(orders.oversizeShards, [0]);
});

test("buildMap: детерминированный полный прогон — top, соседи, шарды, пути относительные", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m1 = buildMap(d, pin);
  const m2 = buildMap(d, pin);
  assert.deepEqual(m1, m2); // одинаковый вход ⇒ одинаковый выход (спека: детерминизм)
  assert.equal(m1.pin, pin);
  const orders = m1.blocks.find((b) => b.name === "apps/api/orders")!;
  assert.ok(orders.files.every((f) => !path.isAbsolute(f.path)));
  // buildMap's churn window is 183 days back from the pin ("hot", 2026-06-20),
  // i.e. from 2025-12-19 — which also covers the fixture's "init" commit
  // (2026-01-01, touches both blocks), not just "seam". Two commits share the
  // seam within that window, so cochange is 2 (not just the "seam" commit alone).
  assert.deepEqual(orders.neighbors, [{ block: "packages/util", cochange: 2 }]);
  // Exact, deterministic order (only two blocks exist in this fixture, so
  // `top` is a full ranking, not a subset — worth pinning exactly instead of
  // a tautological `.includes`). Churn window (183d back from "hot",
  // 2026-06-20) covers all three commits: orders churn=3 (init+seam+hot),
  // util churn=2 (init+seam). Recent window (92d back) covers seam+hot only:
  // orders recent=2, util recent=1. Recent SHARE (recent/churn): orders =
  // 2/3 ≈ .667, util = 1/2 = .5 — orders ranks higher (share rank 1 vs 2).
  // Coupling (from cc, the one apps/api/orders|packages/util pair, weight 2,
  // added to both sides): orders=2, util=2 — tied, both rank 1. rankSum =
  // churnRank + recentShareRank + couplingRank: orders = 1+1+1 = 3;
  // util = 2+2+1 = 5 — lower rankSum sorts first, so orders precedes util.
  assert.deepEqual(m1.top, ["apps/api/orders", "packages/util"]);
});

test("buildMap: блок, чей ЕДИНСТВЕННЫЙ файл >2МБ, не пропадает бесследно — виден в top-level excludedOversize", () => {
  const d = fixtureRepo();
  // apps/api/src/lonely/big.dat: a brand-new block whose only file is oversize.
  // Not caught by EXCLUDE_RE (verified: not a lock/dist/min/map/snap/image path).
  assert.equal(isExcluded("apps/api/src/lonely/big.dat"), false);
  addOversizeFile(d);
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  // gap confirmed: the block never surfaces — not in blocks[], not in the plain excluded[]
  assert.equal(m.blocks.find((b) => b.name === "apps/api/lonely"), undefined);
  assert.ok(!m.excluded.includes("apps/api/src/lonely/big.dat"));
  // top-level visibility: the oversize path must still be reachable somewhere in the map
  assert.deepEqual(m.excludedOversize, ["apps/api/src/lonely/big.dat"]);
  for (const b of m.blocks) assert.ok(!b.files.some((f) => f.path === "apps/api/src/lonely/big.dat"));
});

test("build-blocks CLI: BLOCKS.md показывает секцию «Исключено» (фильтр + oversize)", () => {
  const d = fixtureRepo();
  addOversizeFile(d);
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  // Explicit third positional outDir, run from the WORKTREE's own cwd (not
  // outDir) — proves the CLI honors the argument itself, not merely inheriting
  // process.cwd() by coincidence.
  const outDir = mkdtempSync(path.join(tmpdir(), "audit-cli-"));
  execFileSync(process.execPath, [BUILD_BLOCKS_CLI, d, pin, outDir], { cwd: d, encoding: "utf8" });
  const md = readFileSync(path.join(outDir, "BLOCKS.md"), "utf8");
  assert.match(md, /## Исключено/);
  // Exact count, computed from the fixture (not a magic number): pnpm-lock.yaml
  // + apps/api/dist/bundle.min.js — addOversizeFile's own file is NOT excluded
  // by EXCLUDE_RE (it's caught by the separate >2MB oversize path instead).
  const excludedCount = listTracked(d).filter(isExcluded).length;
  assert.match(md, new RegExp(`фильтром \\(generated/lock/dist\\): ${excludedCount} файлов`));
  assert.match(md, /сверх 2 МБ: apps\/api\/src\/lonely\/big\.dat/);
  const blocksJson = JSON.parse(readFileSync(path.join(outDir, "blocks.json"), "utf8"));
  assert.equal(blocksJson.pin, pin);
  assert.ok(Array.isArray(blocksJson.blocks) && blocksJson.blocks.length > 0);
});

// ---- import-graph reassignment (Task B) ------------------------------------

test("buildMap: own-affinity 0 и ≥2 импортёров в чужом блоке — файл переезжает, старый блок исчезает", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.deepEqual(m.reassignedByImports.find((r) => r.path === "apps/api/src/misc/helper.ts"), {
    path: "apps/api/src/misc/helper.ts", from: "apps/api/misc", to: "packages/util", links: 2,
  });
  // apps/api/misc had exactly one file — it moved, so the block ceases to exist.
  assert.equal(m.blocks.find((b) => b.name === "apps/api/misc"), undefined);
  const util = m.blocks.find((b) => b.name === "packages/util")!;
  assert.ok(util.files.some((f) => f.path === "apps/api/src/misc/helper.ts"));
});

test("buildMap: 1 внешняя связь и 0 своих — порог IMPORT_REASSIGN_MIN(2) не достигнут, файл не переезжает", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.equal(m.reassignedByImports.some((r) => r.path === "apps/api/src/misc-low/lowlink.ts"), false);
  const miscLow = m.blocks.find((b) => b.name === "apps/api/misc-low")!;
  assert.ok(miscLow.files.some((f) => f.path === "apps/api/src/misc-low/lowlink.ts"));
});

test("buildMap: связь в своём блоке (own-affinity != 0) — не переезжает даже при ≥2 чужих связях", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.equal(m.reassignedByImports.some((r) => r.path === "apps/api/src/misc-own/ownlinked.ts"), false);
  const miscOwn = m.blocks.find((b) => b.name === "apps/api/misc-own")!;
  assert.ok(miscOwn.files.some((f) => f.path === "apps/api/src/misc-own/ownlinked.ts"));
});

test("buildMap: детерминизм переезда по графу импортов — deepEqual двух прогонов на одном пине", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m1 = buildMap(d, pin);
  const m2 = buildMap(d, pin);
  assert.deepEqual(m1, m2);
});

test("buildMap: co-change считает швы по итоговой принадлежности — переехавший файл не тянет несуществующий блок в соседи", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  // The "seam" commit touches helper.ts, fmt.ts, and thing.ts together. Under
  // the raw directory block this would register apps/api/misc (helper's old
  // home) as a co-change neighbor. Under the final (import-reassignment-aware)
  // mapping helper.ts and fmt.ts are BOTH packages/util, so the only real
  // cross-block pair left is apps/other|packages/util — negative: the
  // nonexistent old block must not leak into neighbors.
  const util = m.blocks.find((b) => b.name === "packages/util")!;
  assert.ok(!util.neighbors.some((n) => n.block === "apps/api/misc"));
  // Positive: the seam IS attributed to packages/util via the FINAL mapping —
  // proof that `lookup`, not raw blockOf, drove the co-change computation.
  // (count is 2, not 1: "init" also co-touches every block in one commit, and
  // the churn window covers both "init" and "seam"; the important part is that
  // apps/other|packages/util — the real final-mapping pair — is present at all.)
  assert.ok(util.neighbors.some((n) => n.block === "apps/other" && n.cochange === 2));
  const other = m.blocks.find((b) => b.name === "apps/other")!;
  assert.ok(other.neighbors.some((n) => n.block === "packages/util" && n.cochange === 2));
});

test("build-blocks CLI: несовпадение пина — ненулевой exit (status 2), blocks.json не пишется в outDir", () => {
  const d = fixtureRepo();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const wrongPin = pin.startsWith("0") ? "f".repeat(40) : "0".repeat(40);
  const outDir = mkdtempSync(path.join(tmpdir(), "audit-cli-pinguard-"));
  assert.throws(
    () => execFileSync(process.execPath, [BUILD_BLOCKS_CLI, d, wrongPin, outDir], { encoding: "utf8" }),
    (err: unknown) => (err as { status?: number }).status === 2,
  );
  assert.throws(() => readFileSync(path.join(outDir, "blocks.json"), "utf8"));
});

// ---- edge dedup (Task: gate-wave import graph) -----------------------------

test("buildMap: twin-spec duplicate ('./helper' + './helper.ts') dedups to 1 edge — no reassignment at MIN=2", () => {
  const d = fixtureRepoDedupTwin();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.equal(m.reassignedByImports.some((r) => r.path === "apps/api/src/dup/target.ts"), false);
  const dup = m.blocks.find((b) => b.name === "apps/api/dup")!;
  assert.ok(dup.files.some((f) => f.path === "apps/api/src/dup/target.ts"));
});

test("buildMap: two bare subpaths to the same package.json dedup to 1 edge — no reassignment at MIN=2", () => {
  const d = fixtureRepoDedupBare();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.equal(m.reassignedByImports.some((r) => r.path === "apps/api/src/consumer/service.ts"), false);
  const consumer = m.blocks.find((b) => b.name === "apps/api/consumer")!;
  assert.ok(consumer.files.some((f) => f.path === "apps/api/src/consumer/service.ts"));
});

// ---- tsconfig alias integration --------------------------------------------

test("buildMap: tsconfig path alias drives real import-graph edges — reassigns via @/* alias", () => {
  const d = fixtureRepoAlias();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.deepEqual(m.reassignedByImports.find((r) => r.path === "apps/web/src/lib/target.ts"), {
    path: "apps/web/src/lib/target.ts", from: "apps/web/lib", to: "packages/util", links: 2,
  });
  const util = m.blocks.find((b) => b.name === "packages/util")!;
  assert.ok(util.files.some((f) => f.path === "apps/web/src/lib/target.ts"));
});

// ---- robustness belts (Task: gate-wave import graph §4) --------------------

test("buildMap: непрочитываемый трекнутый файл (битый симлинк) не валит прогон — попадает в unreadable", () => {
  const d = fixtureRepo();
  symlinkSync(path.join(d, "does-not-exist.ts"), path.join(d, "apps/api/src/orders/broken.ts"));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "broken-symlink"], {
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  });
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const m = buildMap(d, pin);
  assert.deepEqual(m.unreadable, ["apps/api/src/orders/broken.ts"]);
  for (const b of m.blocks) assert.ok(!b.files.some((f) => f.path === "apps/api/src/orders/broken.ts"));
});

test("build-blocks CLI: грязный worktree — exit 2, файлы в outDir не пишутся", () => {
  const d = fixtureRepo();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  writeFileSync(path.join(d, "apps/api/src/orders/model.ts"), "dirty\n");
  const outDir = mkdtempSync(path.join(tmpdir(), "audit-cli-dirty-"));
  assert.throws(
    () => execFileSync(process.execPath, [BUILD_BLOCKS_CLI, d, pin, outDir], { encoding: "utf8" }),
    (err: unknown) => (err as { status?: number }).status === 2,
  );
  assert.throws(() => readFileSync(path.join(outDir, "blocks.json"), "utf8"));
  assert.throws(() => readFileSync(path.join(outDir, "BLOCKS.md"), "utf8"));
});

test("build-blocks CLI: неглубокий (shallow) клон — exit 2", () => {
  const d = fixtureRepo();
  const shallowDir = mkdtempSync(path.join(tmpdir(), "audit-cli-shallow-"));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${d}`, shallowDir], { encoding: "utf8" });
  const pin = git(shallowDir, ["rev-parse", "HEAD"]).trim();
  const outDir = mkdtempSync(path.join(tmpdir(), "audit-cli-shallow-out-"));
  assert.throws(
    () => execFileSync(process.execPath, [BUILD_BLOCKS_CLI, shallowDir, pin, outDir], { encoding: "utf8" }),
    (err: unknown) => (err as { status?: number }).status === 2,
  );
  assert.throws(() => readFileSync(path.join(outDir, "blocks.json"), "utf8"));
});

// ---- test pins: assignBlocks direct units ----------------------------------

test("assignBlocks: inbound-only reassignment — no outbound edges, 2 importers from a foreign block, moves", () => {
  // Mirror of the outbound-only test below: here `target.ts` has NO entry of
  // its own in edgesByFile (own outbound affinity 0 by construction), and its
  // foreign-affinity comes entirely from importersIndex (two packages/util
  // sources importing it) — exercises the inbound half of fileAffinity
  // directly, as the outbound-only test exercises the outbound half.
  const files = ["apps/misc/target.ts", "packages/util/src/a.ts", "packages/util/src/b.ts"];
  const edgesByFile = new Map([
    ["packages/util/src/a.ts", ["apps/misc/target.ts"]],
    ["packages/util/src/b.ts", ["apps/misc/target.ts"]],
  ]);
  const mapping = assignBlocks(files, edgesByFile);
  assert.equal(mapping.get("apps/misc/target.ts"), "packages/util");
});

test("assignBlocks: outbound-only reassignment — no importers, 2 own outbound edges into a foreign block, moves", () => {
  const files = ["apps/misc/a.ts", "packages/util/src/x.ts", "packages/util/src/y.ts"];
  const edgesByFile = new Map([["apps/misc/a.ts", ["packages/util/src/x.ts", "packages/util/src/y.ts"]]]);
  const mapping = assignBlocks(files, edgesByFile);
  assert.equal(mapping.get("apps/misc/a.ts"), "packages/util");
});

test("assignBlocks: lexicographic tie-break — equal affinity to two foreign blocks, smallest name wins", () => {
  assert.equal(IMPORT_REASSIGN_MIN, 2); // pin the threshold this test relies on
  const files = ["apps/misc/thing.ts"];
  const edgesByFile = new Map([[
    "apps/misc/thing.ts",
    ["packages/aaa/x1.ts", "packages/aaa/x2.ts", "packages/bbb/y1.ts", "packages/bbb/y2.ts"],
  ]]);
  const mapping = assignBlocks(files, edgesByFile);
  assert.equal(mapping.get("apps/misc/thing.ts"), "packages/aaa");
});

test("assignBlocks: package.json manifest immunity — own-affinity 0 and 2 foreign importers, stays put", () => {
  const files = ["packages/util/package.json"];
  const edgesByFile = new Map([
    ["apps/api/thing1.ts", ["packages/util/package.json"]],
    ["apps/api/thing2.ts", ["packages/util/package.json"]],
  ]);
  const mapping = assignBlocks(files, edgesByFile);
  // Would reassign to apps/api (foreign-affinity 2, own-affinity 0) if it were
  // an ordinary file — the manifest exclusion must override that.
  assert.equal(mapping.get("packages/util/package.json"), "packages/util");
});

// ---- test pins: CLI reassignment section content ---------------------------

test("build-blocks CLI: секция «Переезды по импортам» содержит запись переезда с links", () => {
  const d = fixtureRepoImports();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const outDir = mkdtempSync(path.join(tmpdir(), "audit-cli-reassign-"));
  execFileSync(process.execPath, [BUILD_BLOCKS_CLI, d, pin, outDir], { encoding: "utf8" });
  const md = readFileSync(path.join(outDir, "BLOCKS.md"), "utf8");
  assert.match(md, /## Переезды по импортам/);
  assert.match(md, /- всего: 1/);
  assert.match(
    md,
    /- apps\/api\/src\/misc\/helper\.ts: apps\/api\/misc → packages\/util \(links 2\)/,
  );
});

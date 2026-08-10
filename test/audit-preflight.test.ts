import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { preflight } from "../tools/audit/preflight.mjs";
import { buildMap, MAX_SHARD_LOC, MAX_FILE_BYTES } from "../tools/audit/build-blocks.mjs";
import { git, fixtureRepoHistory } from "./helpers/audit-fixture.ts";

// blocks.json must live OUTSIDE the pinned worktree: preflight's dirty-worktree
// check (gate-cycle-2) treats any uncommitted worktree entry as fatal, and an
// untracked blocks.json written INSIDE the worktree would trip it on every test.
function freshBlocksJsonPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "audit-blocksjson-")), "blocks.json");
}

test("preflight: чистый прогон — абсолютные пути внутри worktree", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  const r = preflight(d, pin, blocksJson, "apps/api/orders");
  assert.equal(r.ok, true);
  assert.ok(r.artifacts.length >= 2);
  for (const a of r.artifacts) assert.ok(a.startsWith(d + path.sep) || a.startsWith(d + "/"));
  // cwd is the resolved worktree path — stage-2 operators must pass this to
  // cursor_review's `cwd`, so preflight makes it impossible to miss.
  assert.equal(r.cwd, path.resolve(d));
});

test("preflight: расхождение пина — отказ с внятной ошибкой", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  const r = preflight(d, "0".repeat(40), blocksJson, "apps/api/orders");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /pin/i.test(e)));
});

test("preflight: неизвестный блок — отказ", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  const r = preflight(d, pin, blocksJson, "no/such/block");
  assert.equal(r.ok, false);
});

test("preflight: битый blocks.json (нет массива blocks) — ok:false, не TypeError", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify({ pin }));
  const r = preflight(d, pin, blocksJson, "apps/api/orders");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /malformed/.test(e)));
});

test("preflight: несуществующий shardIdx у известного блока — ok:false", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 99);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /shard/.test(e)));
});

test("preflight: грязный worktree — незакоммиченное изменение трекнутого файла — ok:false /dirty/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  // A live file grows AFTER blocks.json was built, but nothing is committed —
  // HEAD still equals the pin, so only the dirty-worktree check catches this.
  writeFileSync(path.join(d, "apps/api/src/orders/model.ts"), "b3\n".repeat(50));
  const r = preflight(d, pin, blocksJson, "apps/api/orders");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /dirty/.test(e)));
});

test("preflight: раздутый JSON loc без пометки oversize — теперь ловится staleness первой (протухший blocks.json)", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin);
  const orders = map.blocks.find((b) => b.name === "apps/api/orders");
  // Hand-edit blocks.json: inflate the loc blocks.json CLAIMS for the shard's
  // files well past MAX_SHARD_LOC, without marking the shard oversize. Under
  // gate-cycle-2 (live disk is ground truth), this diverges from the live loc
  // BEFORE the sum can even be compared against the budget — staleness fires first.
  for (const f of orders.files) f.loc = MAX_SHARD_LOC;
  assert.ok(!(orders.oversizeShards ?? []).includes(0));
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /stale/.test(e)));
});

test("preflight: json loc расходится с live для одного файла — ok:false /stale/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin);
  const orders = map.blocks.find((b) => b.name === "apps/api/orders");
  // Worktree stays untouched (clean) — only blocks.json's claimed number for
  // one file is patched to mismatch the live file it describes.
  orders.files[0].loc += 1;
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /blocks\.json stale for .*: loc \d+ != live \d+/.test(e)));
});

test("preflight: путь шарда отсутствует в block.files — ok:false /not in block.files/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin);
  const orders = map.blocks.find((b) => b.name === "apps/api/orders");
  const target = orders.shards[0][0];
  orders.files = orders.files.filter((f) => f.path !== target); // shard still references it
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in block\.files/.test(e)));
});

test("preflight: live-budget guard — реальный ~4100-строчный шард, blocks.json СОВПАДАЕТ с диском, но не помечен oversize — отказ", () => {
  const d = fixtureRepoHistory();
  writeFileSync(path.join(d, "apps/api/src/orders/fat.ts"), "x\n".repeat(4100));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "fat"], {
    GIT_AUTHOR_DATE: "2026-06-25T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-25T00:00:00Z",
  });
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  // buildMap WOULD correctly shard/mark this as oversize (single indivisible
  // subdirectory), so to exercise the live-budget guard in isolation, hand-craft
  // blocks.json: every loc number still matches disk (staleness never fires),
  // but the oversizeShards mark buildMap set is stripped — the "forgot to
  // re-mark" scenario the guard exists for.
  const map = buildMap(d, pin);
  const orders = map.blocks.find((b) => b.name === "apps/api/orders");
  assert.equal(orders.shards.length, 1);
  assert.deepEqual(orders.oversizeShards, [0]); // buildMap DOES mark it correctly
  orders.oversizeShards = [];
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not marked oversize/.test(e)));
});

test("preflight: live-budget guard — тот же оверсайз-шард, корректно помечен oversizeShards — проходит", () => {
  const d = fixtureRepoHistory();
  writeFileSync(path.join(d, "apps/api/src/orders/fat.ts"), "x\n".repeat(4100));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "fat"], {
    GIT_AUTHOR_DATE: "2026-06-25T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-25T00:00:00Z",
  });
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin); // oversizeShards=[0] left as buildMap computed it
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, true);
});

test("preflight: pin в blocks.json расходится с ПРАВИЛЬНЫМ HEAD — ok:false /pin/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin);
  map.pin = "0".repeat(40); // blocks.json itself is stale, HEAD is correct
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin, blocksJson, "apps/api/orders");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /pin/i.test(e)));
});

test("preflight: файл шарда превышает лимит байт — ok:false /over .* bytes/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  writeFileSync(path.join(d, "apps/api/src/orders/huge.ts"), "x".repeat(MAX_FILE_BYTES + 1));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "huge"], {
    GIT_AUTHOR_DATE: "2026-06-25T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-25T00:00:00Z",
  });
  // buildMap itself would route a >2MB tracked file into excludedOversize, not
  // a shard — so hand-craft blocks.json referencing it directly inside a shard
  // to exercise preflight's own byte-limit guard in isolation.
  const pin2 = git(d, ["rev-parse", "HEAD"]).trim();
  const map = buildMap(d, pin2);
  const orders = map.blocks.find((b) => b.name === "apps/api/orders");
  orders.shards[0].push("apps/api/src/orders/huge.ts");
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(map));
  const r = preflight(d, pin2, blocksJson, "apps/api/orders", 0);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => new RegExp(`over ${MAX_FILE_BYTES} bytes`).test(e)));
});

test("preflight: файл шарда отсутствует в worktree — ok:false /missing in worktree/", () => {
  const d = fixtureRepoHistory();
  const pin = git(d, ["rev-parse", "HEAD"]).trim();
  const blocksJson = freshBlocksJsonPath();
  writeFileSync(blocksJson, JSON.stringify(buildMap(d, pin)));
  rmSync(path.join(d, "apps/api/src/orders/model.ts"));
  const r = preflight(d, pin, blocksJson, "apps/api/orders");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing in worktree/.test(e)));
});

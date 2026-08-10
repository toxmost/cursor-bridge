// Shared git-repo fixtures for the audit test suite (build-blocks + preflight).
// Both audit test files import from here to avoid duplicating fixture setup.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}

/** Builds a tiny deterministic repo: two blocks + excluded artifacts. */
export function fixtureRepo(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "apps/api/src/orders"), { recursive: true });
  mkdirSync(path.join(d, "packages/util/src"), { recursive: true });
  mkdirSync(path.join(d, "apps/api/dist"), { recursive: true });
  writeFileSync(path.join(d, "apps/api/src/orders/service.ts"), "a\n".repeat(50));
  writeFileSync(path.join(d, "apps/api/src/orders/model.ts"), "b\n".repeat(30));
  writeFileSync(path.join(d, "packages/util/src/fmt.ts"), "c\n".repeat(20));
  writeFileSync(path.join(d, "pnpm-lock.yaml"), "lock\n");
  writeFileSync(path.join(d, "apps/api/dist/bundle.min.js"), "x\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  return d;
}

/** Builds a repo exercising import-graph reassignment (Task B):
 * - apps/api/src/misc/helper.ts is the ONLY file in block apps/api/misc, imports
 *   nothing, and is imported by BOTH packages/util/src/a.ts and b.ts (own-affinity
 *   0, foreign-affinity 2 >= IMPORT_REASSIGN_MIN) — reassigns to packages/util,
 *   and its old block ceases to exist.
 * - apps/api/src/misc-low/lowlink.ts is imported by ONLY a.ts (foreign-affinity 1,
 *   below the threshold) — stays put.
 * - apps/api/src/misc-own/ownlinked.ts imports its own sibling.ts (own-affinity 1)
 *   while ALSO being imported by both a.ts and b.ts (foreign-affinity 2) — the
 *   nonzero own-affinity wins regardless of the foreign count, stays put.
 * - apps/other/thing.ts is a third, unrelated block (no import edges at all)
 *   included so the "seam" commit below has a genuine cross-block partner —
 *   without it, helper.ts + fmt.ts land in the SAME final block (packages/util)
 *   and no co-change pair is recorded at all, which can't distinguish "seam
 *   correctly attributed" from "seam silently dropped".
 * History: "init" adds everything; "seam" later touches helper.ts, fmt.ts
 * (both packages/util post-reassignment), AND thing.ts (apps/other) — a
 * deliberate probe for co-change using the FINAL mapping rather than the raw
 * directory block: the recorded pair must be apps/other|packages/util, never
 * apps/api/misc|packages/util (helper's old, now-nonexistent home). */
export function fixtureRepoImports(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-imports-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "apps/api/src/misc"), { recursive: true });
  mkdirSync(path.join(d, "apps/api/src/misc-low"), { recursive: true });
  mkdirSync(path.join(d, "apps/api/src/misc-own"), { recursive: true });
  mkdirSync(path.join(d, "packages/util/src"), { recursive: true });
  mkdirSync(path.join(d, "apps/other"), { recursive: true });
  writeFileSync(path.join(d, "apps/api/src/misc/helper.ts"), "export const helper = 1;\n");
  writeFileSync(path.join(d, "apps/api/src/misc-low/lowlink.ts"), "export const lowlink = 1;\n");
  writeFileSync(path.join(d, "apps/api/src/misc-own/sibling.ts"), "export const sibling = 1;\n");
  writeFileSync(
    path.join(d, "apps/api/src/misc-own/ownlinked.ts"),
    'import { sibling } from "./sibling";\nexport const ownlinked = sibling + 1;\n',
  );
  writeFileSync(path.join(d, "packages/util/src/fmt.ts"), "export const fmt = 1;\n");
  writeFileSync(path.join(d, "apps/other/thing.ts"), "export const thing = 1;\n");
  writeFileSync(
    path.join(d, "packages/util/src/a.ts"),
    [
      'import { helper } from "../../../apps/api/src/misc/helper";',
      'import { lowlink } from "../../../apps/api/src/misc-low/lowlink";',
      'import { ownlinked } from "../../../apps/api/src/misc-own/ownlinked";',
      "export const a = helper + lowlink + ownlinked;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(d, "packages/util/src/b.ts"),
    [
      'import { helper } from "../../../apps/api/src/misc/helper";',
      'import { ownlinked } from "../../../apps/api/src/misc-own/ownlinked";',
      "export const b = helper + ownlinked;",
      "",
    ].join("\n"),
  );
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  // Deliberate seam probe: touches helper.ts (reassigned to packages/util),
  // fmt.ts (already packages/util), AND thing.ts (apps/other, untouched by any
  // reassignment). Under the FINAL mapping the real cross-block pair here is
  // apps/other|packages/util — under the raw directory block it would instead
  // register a spurious apps/api/misc|apps/other seam (helper's old home).
  writeFileSync(path.join(d, "apps/api/src/misc/helper.ts"), "export const helper = 2;\n");
  writeFileSync(path.join(d, "packages/util/src/fmt.ts"), "export const fmt = 2;\n");
  writeFileSync(path.join(d, "apps/other/thing.ts"), "export const thing = 2;\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "seam"], {
    GIT_AUTHOR_DATE: "2026-06-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z",
  });
  return d;
}

/** Builds a repo where a single importer reaches the SAME target file via two
 * distinct relative specs — extension-less and explicit-extension (a
 * "./helper" + "./helper.ts" twin duplicate). Without per-source dedup of
 * resolved edge targets, this double-counts to foreign-affinity 2 (reaching
 * IMPORT_REASSIGN_MIN) and wrongly reassigns the target; deduped, it's 1 real
 * edge and the target stays put. */
export function fixtureRepoDedupTwin(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-deduptwin-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "apps/api/src/dup"), { recursive: true });
  mkdirSync(path.join(d, "packages/util/src"), { recursive: true });
  writeFileSync(path.join(d, "apps/api/src/dup/target.ts"), "export const target = 1;\n");
  writeFileSync(
    path.join(d, "packages/util/src/importer.ts"),
    [
      'import { target as t1 } from "../../../apps/api/src/dup/target";',
      'import { target as t2 } from "../../../apps/api/src/dup/target.ts";',
      "export const importer = t1 + t2;",
      "",
    ].join("\n"),
  );
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  return d;
}

/** Builds a repo where a single importer reaches the SAME package manifest via
 * two distinct bare specs — the package name and a subpath of it (both bare
 * specs resolve to the package's package.json). Without per-source dedup of
 * resolved edge targets, this double-counts the importer's OWN outbound
 * affinity to the target package's block, wrongly reassigning the importer
 * itself; deduped, it's 1 real edge and the importer stays put. */
export function fixtureRepoDedupBare(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-dedupbare-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "packages/util/src"), { recursive: true });
  mkdirSync(path.join(d, "apps/api/src/consumer"), { recursive: true });
  writeFileSync(path.join(d, "packages/util/package.json"), JSON.stringify({ name: "@scope/pkg" }));
  writeFileSync(path.join(d, "packages/util/src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    path.join(d, "apps/api/src/consumer/service.ts"),
    ['import "@scope/pkg";', 'import "@scope/pkg/sub";', "export const service = 1;", ""].join("\n"),
  );
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  return d;
}

/** Builds a repo with a root tsconfig.json defining a wildcard path alias
 * ("@/*" -> "apps/web/src/*") and two importers in a foreign block reaching a
 * target ONLY through that alias — proving alias resolution feeds real edges
 * into the import graph (own-affinity 0, foreign-affinity 2 -> reassigns). */
export function fixtureRepoAlias(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-alias-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "apps/web/src/lib"), { recursive: true });
  mkdirSync(path.join(d, "packages/util/src"), { recursive: true });
  writeFileSync(
    path.join(d, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["apps/web/src/*"] } } }),
  );
  writeFileSync(path.join(d, "apps/web/src/lib/target.ts"), "export const target = 1;\n");
  writeFileSync(
    path.join(d, "packages/util/src/a.ts"),
    'import { target } from "@/lib/target";\nexport const a = target;\n',
  );
  writeFileSync(
    path.join(d, "packages/util/src/b.ts"),
    'import { target } from "@/lib/target";\nexport const b = target;\n',
  );
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  return d;
}

/** Adds a >2MB tracked file (apps/api/src/lonely/big.dat) in its own commit —
 * shared setup for the two oversize-visibility tests in audit-blocks.test.ts
 * (previously duplicated verbatim). Caller reads the pin via
 * `git(d, ["rev-parse", "HEAD"]).trim()` afterward. */
export function addOversizeFile(d: string): void {
  mkdirSync(path.join(d, "apps/api/src/lonely"), { recursive: true });
  writeFileSync(path.join(d, "apps/api/src/lonely/big.dat"), "x".repeat(2_000_001));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "oversize-only-block"], {
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  });
}

/** Builds a repo where a tracked file's REPO-RELATIVE PATH is exactly 40 hex
 * characters (deadbeef... x5, at the repo ROOT — a directory prefix would
 * make the full --name-only line longer than 40 chars and never trigger the
 * bug) — indistinguishable from a commit hash under the OLD boundary regex
 * (`^[0-9a-f]{40}$` applied to every --name-only line, with no way to tell a
 * hash line from a file line of the same shape). The "seam" commit touches
 * apps/api/src/orders/service.ts AND the root-level hex-named file; git lists
 * changed paths in sorted order ("apps/..." < "deadbeef..."), so the hex file
 * comes LAST — under the old regex it would be mistaken for a second
 * commit's hash line, prematurely flushing service.ts alone (single block,
 * no pair) and silently swallowing the hex-named file itself (matched the
 * boundary branch, never pushed as a file — and no further content follows
 * it before the real next boundary, so it also never surfaces on its own).
 * The NUL-sentinel fix must recover the real single cross-block pair for
 * this commit (apps/api/orders and the hex file's own singleton root block —
 * see blockOf's fallback for a file with no directory component). */
export function fixtureRepoHexFilename(): string {
  const d = mkdtempSync(path.join(tmpdir(), "audit-fix-hexname-"));
  git(d, ["init", "-q", "."]);
  git(d, ["config", "user.email", "t@t"]); git(d, ["config", "user.name", "t"]);
  mkdirSync(path.join(d, "apps/api/src/orders"), { recursive: true });
  writeFileSync(path.join(d, "apps/api/src/orders/service.ts"), "a\n".repeat(10));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  writeFileSync(path.join(d, "apps/api/src/orders/service.ts"), "a2\n".repeat(10));
  writeFileSync(path.join(d, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), "hex-named\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "seam-with-hex-filename"], {
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  });
  return d;
}

export function fixtureRepoHistory(): string {
  const d = fixtureRepo();
  // co-change: orders + util touched by one commit (a seam), recent window
  writeFileSync(path.join(d, "apps/api/src/orders/service.ts"), "a2\n".repeat(60));
  writeFileSync(path.join(d, "packages/util/src/fmt.ts"), "c2\n".repeat(25));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "seam"], {
    GIT_AUTHOR_DATE: "2026-06-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z" });
  writeFileSync(path.join(d, "apps/api/src/orders/model.ts"), "b2\n".repeat(35));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "hot"], {
    GIT_AUTHOR_DATE: "2026-06-20T00:00:00Z", GIT_COMMITTER_DATE: "2026-06-20T00:00:00Z" });
  return d;
}

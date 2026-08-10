import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitInfo, diffStat, changedFiles, findWorktree } from "../src/git-safety.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

function repo(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cbgit-"));
  git(d, "init", "-q", ".");
  writeFileSync(path.join(d, "a.txt"), "one\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  return d;
}

test("non-git dir", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "cbplain-"));
  assert.deepEqual(await gitInfo(d), { isGit: false, dirty: false });
  assert.equal(await diffStat(d), "");
  assert.deepEqual(await changedFiles(d), []);
});

test("clean and dirty repo", async () => {
  const d = repo();
  assert.deepEqual(await gitInfo(d), { isGit: true, dirty: false });
  writeFileSync(path.join(d, "a.txt"), "two\n");
  assert.deepEqual(await gitInfo(d), { isGit: true, dirty: true });
  assert.match(await diffStat(d), /a\.txt/);
  assert.match((await changedFiles(d))[0]!, /^ M a\.txt$/);
});

test("findWorktree", async () => {
  const d = repo();
  const wt = path.join(d, "..", path.basename(d) + "-wt-cb1");
  git(d, "worktree", "add", "-q", wt);
  const found = await findWorktree(d, "cb1");
  assert.ok(found && found.includes("cb1"));
  assert.equal(await findWorktree(d, "nope"), null);
});

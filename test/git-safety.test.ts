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

test("gitLsFiles: полный tracked-список, кириллица/пробелы не искалечены quotePath, не-git -> []", async () => {
  const { gitLsFiles } = await import("../src/git-safety.ts");
  const d = repo();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(d, "апп/глубже"), { recursive: true });
  writeFileSync(path.join(d, "апп/глубже/маршрут таблицы.ts"), "x\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "add");
  const files = await gitLsFiles(d);
  assert.ok(files.includes("a.txt"));
  // core.quotePath по умолчанию экранирует не-ASCII в октали — -z обязан вернуть сырой путь
  assert.ok(files.includes("апп/глубже/маршрут таблицы.ts"), JSON.stringify(files));
  assert.deepEqual(await gitLsFiles(mkdtempSync(path.join(tmpdir(), "cbplain-"))), []);
});

test("gitLsFiles: вывод > 1MB (дефолтный maxBuffer execFile) не роняет список в []", async () => {
  // security-ось финального ревью: на монорепо ls-files -z превышает дефолтный
  // maxBuffer → execFile бросает → catch отдаёт [] → суффикс-резолв молча мёртв
  const { gitLsFiles } = await import("../src/git-safety.ts");
  const { mkdirSync } = await import("node:fs");
  const d = mkdtempSync(path.join(tmpdir(), "cbbig-"));
  execFileSync("git", ["init", "-q", "."], { cwd: d });
  const seg = "d".repeat(200);
  const deep = path.join(d, seg, seg, seg);
  mkdirSync(deep, { recursive: true });
  // ~2000 файлов × ~700 байт пути ≈ 1.2MB NUL-separated вывода
  for (let i = 0; i < 2000; i++) writeFileSync(path.join(deep, `f${String(i).padStart(4, "0")}.ts`), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "big");
  const files = await gitLsFiles(d);
  assert.equal(files.length, 2000);
  assert.ok(files[0]!.endsWith("f0000.ts"));
});

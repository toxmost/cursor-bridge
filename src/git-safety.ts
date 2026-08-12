import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function gitInfo(cwd: string): Promise<{ isGit: boolean; dirty: boolean }> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return { isGit: false, dirty: false };
  }
  try {
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd });
    return { isGit: true, dirty: stdout.trim().length > 0 };
  } catch {
    // fail closed: if we cannot read status, treat the tree as dirty so the safety gate refuses
    return { isGit: true, dirty: true };
  }
}

/** Current HEAD sha, or null when cwd is not a git repo (or HEAD is unborn). */
export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Whether relPath is tracked by git in cwd. Ignored/untracked files are not pinnable. */
export async function gitTracked(cwd: string, relPath: string): Promise<boolean> {
  try {
    await run("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** All tracked paths, repo-relative. NUL-separated (-z): core.quotePath would
 *  octal-escape non-ASCII names and break suffix matching against citations. */
export async function gitLsFiles(cwd: string): Promise<string[]> {
  try {
    // Default execFile maxBuffer (1MB) is smaller than a monorepo's ls-files
    // output — overflowing it would silently disable suffix resolution.
    const { stdout } = await run("git", ["ls-files", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

export async function diffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "--stat", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function changedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd });
    return stdout.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

export async function findWorktree(cwd: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd });
    const paths = stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
    return paths.find((p) => p.includes(name)) ?? null;
  } catch {
    return null;
  }
}

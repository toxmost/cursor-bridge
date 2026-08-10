// Flag layout verified against `cursor-agent --help` (Task 1 pre-flight).
import { spawn } from "node:child_process";
import { StreamCollector, type StreamEvent } from "./stream-events.ts";

export interface CursorSpawnConfig {
  bin?: string;
  binArgs?: string[];
  // Stream buffer cap in UTF-16 code units, forwarded to StreamCollector.
  // Production default (8 MiB) applies when omitted; tests can set a tiny
  // cap to exercise the bridge_buffer_overflow signal deterministically.
  maxBufferChars?: number;
  // Grace period (ms) between the child's own `exit` and force-settling
  // `done` when stdio is still held open (e.g. by a grandchild that inherited
  // the stdout pipe). Production default (2s) applies when omitted; tests
  // can shrink it to exercise the exit-grace belt deterministically.
  exitGraceMs?: number;
}

export type KillReason = "idle-timeout" | "hard-timeout" | "first-token-timeout" | "cancelled";

export interface CursorRunOptions extends CursorSpawnConfig {
  prompt: string;
  cwd: string;
  mode?: "edit" | "plan" | "ask";
  model?: string;
  resumeChatId?: string;
  worktreeName?: string;
  // Inter-token stall detector: max silence on stdout AFTER the first
  // meaningful event. Before it, the first-token grace applies instead.
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  // Thinking budget: max time from spawn to the first meaningful stream event
  // (assistant/tool_call/result). Boilerplate (system init, prompt echo) does
  // not count as a token. A truly silent process (zero stdout bytes) is still
  // reclaimed by idleTimeoutMs — that is the known cursor-agent hang-bug shape.
  firstTokenGraceMs?: number;
  onRawLine?: (line: string) => void;
  onEvent?: (e: StreamEvent) => void;
}

export interface CursorRunResult {
  exitCode: number | null;
  killedBy: KillReason | null;
  spawnError: string | null;
  resultText: string | null;
  planText: string | null;
  assistantText: string;
  toolCallCount: number;
  stderrTail: string;
  // Stall diagnostics: enough to tell "died before the first token" from
  // "stalled mid-stream" without exhuming events.jsonl.
  sawFirstToken: boolean;
  firstTokenMs: number | null;
  outputChars: number;
}

export interface CursorHandle {
  done: Promise<CursorRunResult>;
  cancel(): void;
}

export const DEFAULT_MODEL = "composer-2.5";
export const DEFAULT_IDLE_MS = 180_000;
export const DEFAULT_HARD_MS = 600_000;
// Sized from the observed incident: composer thought 189s+ on a large resumed
// context before its first token and was wrongly idle-killed at 180s.
export const DEFAULT_FIRST_TOKEN_GRACE_MS = 480_000;

const FIRST_TOKEN_TYPES: ReadonlySet<string> = new Set(["assistant", "tool_call", "result"]);

export function buildArgs(o: CursorRunOptions): string[] {
  const mode = o.mode ?? "edit";
  const args: string[] = [];
  if (o.resumeChatId) args.push("--resume", o.resumeChatId);
  args.push("-p", "--output-format", "stream-json", "--model", o.model ?? DEFAULT_MODEL, "--trust");
  if (mode === "edit") args.push("-f");
  else args.push("--mode", mode);
  if (o.worktreeName) args.push("-w", o.worktreeName);
  args.push("--", o.prompt); // `--` sentinel: a dashed prompt without it hard-fails CLI parsing
  return args;
}

export function runCursorAgent(o: CursorRunOptions): CursorHandle {
  const bin = o.bin ?? "cursor-agent";
  const binArgs = o.binArgs ?? [];
  const idleMs = o.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const hardMs = o.hardTimeoutMs ?? DEFAULT_HARD_MS;
  const exitGraceMs = o.exitGraceMs ?? 2_000;
  const firstTokenGraceMs = o.firstTokenGraceMs ?? DEFAULT_FIRST_TOKEN_GRACE_MS;

  const startedAt = Date.now();
  let sawAnyOutput = false;
  let sawFirstToken = false;
  let firstTokenMs: number | null = null;
  let outputChars = 0;

  const collector = new StreamCollector({
    onLine: o.onRawLine,
    onEvent: (e) => {
      if (!sawFirstToken && typeof e.type === "string" && FIRST_TOKEN_TYPES.has(e.type)) {
        sawFirstToken = true;
        firstTokenMs = Date.now() - startedAt;
      }
      o.onEvent?.(e);
    },
    maxBufferChars: o.maxBufferChars,
  });
  let killedBy: KillReason | null = null;
  let spawnError: string | null = null;
  let settled = false;

  const child = spawn(bin, [...binArgs, ...buildArgs(o)], {
    cwd: o.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const signalTree = (s: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, s);
        return;
      } catch {
        // group may already be gone; fall through to direct kill
      }
    }
    child.kill(s);
  };
  const kill = (reason: KillReason) => {
    if (settled || killedBy) return;
    killedBy = reason;
    signalTree("SIGTERM");
    setTimeout(() => signalTree("SIGKILL"), 3_000).unref();
  };

  // Idle expiry is a decision point, not always a kill: before the first
  // meaningful token, silence is "thinking" and is budgeted by the first-token
  // grace; a zero-output process (never even the init boilerplate) keeps the
  // fast idle kill — that is the known hang-bug shape, not thinking.
  let idleTimer: NodeJS.Timeout;
  const onIdleExpired = () => {
    if (!sawAnyOutput || sawFirstToken) return kill("idle-timeout");
    if (startedAt + firstTokenGraceMs - Date.now() <= 0) return kill("first-token-timeout");
    armIdle();
  };
  // Pre-first-token the timer must fire at whichever deadline is nearer — the
  // idle window or the remaining grace — so a grace shorter than the idle
  // window still kills on time.
  const nextDelay = () =>
    sawAnyOutput && !sawFirstToken
      ? Math.max(1, Math.min(idleMs, startedAt + firstTokenGraceMs - Date.now()))
      : idleMs;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleExpired, nextDelay());
    idleTimer.unref();
  };
  armIdle();
  const hardTimer = setTimeout(() => kill("hard-timeout"), hardMs);
  hardTimer.unref();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    sawAnyOutput = true;
    outputChars += chunk.length;
    collector.feed(chunk); // may flip sawFirstToken — feed before arming so the delay is right
    armIdle();
  });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2048);
  });

  const done = new Promise<CursorRunResult>((resolve) => {
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      collector.end();
      resolve({
        exitCode,
        killedBy,
        spawnError,
        resultText: collector.resultText,
        planText: collector.planText,
        assistantText: collector.assistantText,
        toolCallCount: collector.toolCallCount,
        stderrTail,
        sawFirstToken,
        firstTokenMs,
        outputChars,
      });
    };
    child.on("error", (err) => {
      spawnError = String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    // A grandchild can inherit the stdout pipe and hold it open, so `close`
    // may never fire. `exit` always fires when the child itself dies; give
    // stdout a short grace to flush, then force-settle to free the slot.
    child.on("exit", (code) => setTimeout(() => finish(code), exitGraceMs).unref());
  });

  return { done, cancel: () => kill("cancelled") };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// `create-chat` prints the chat id, then may hang forever (known bug) — read the id and kill.
export function createChat(cwd: string, cfg: CursorSpawnConfig = {}, timeoutMs = 30_000): Promise<string> {
  const bin = cfg.bin ?? "cursor-agent";
  const binArgs = cfg.binArgs ?? [];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...binArgs, "create-chat"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let out = "";
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`create-chat produced no chat id within ${timeoutMs}ms`))),
      timeoutMs,
    );
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const m = UUID_RE.exec(out);
      if (m) settle(() => resolve(m[0]));
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", () => settle(() => reject(new Error(`create-chat exited without a chat id: ${out.slice(0, 200)}`))));
  });
}

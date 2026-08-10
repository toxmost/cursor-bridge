import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createChat,
  runCursorAgent,
  DEFAULT_MODEL,
  DEFAULT_FIRST_TOKEN_GRACE_MS,
  type CursorHandle,
  type CursorSpawnConfig,
} from "./cursor-process.ts";
import { changedFiles, diffStat, findWorktree, gitInfo } from "./git-safety.ts";
import { summarizeEvent } from "./stream-events.ts";
import { Telemetry, TERMINAL_STATUSES } from "./telemetry.ts";

export type JobStatus = "queued" | "working" | "completed" | "failed" | "cancelled";
export type JobMode = "edit" | "plan" | "ask";

export interface SubmitParams {
  prompt: string;
  cwd: string;
  mode?: JobMode;
  isolation?: "inplace" | "worktree";
  model?: string;
  resumeChatId?: string;
  worktreeName?: string;
  timeoutSec?: number;
  // Inter-token stall detector override (seconds); manager default applies when omitted.
  idleTimeoutSec?: number;
  // Thinking budget override (seconds): time allowed from spawn to the first
  // meaningful token. Raise for heavy reviews on large resumed contexts.
  firstTokenGraceSec?: number;
  allowDirty?: boolean;
  allowNonGit?: boolean;
  meta?: Record<string, unknown>;
}

interface Job {
  id: string;
  chatId: string;
  prompt: string;
  cwd: string;
  mode: JobMode;
  isolation: "inplace" | "worktree";
  model: string;
  timeoutSec: number;
  idleTimeoutMs: number;
  firstTokenGraceMs: number;
  worktreeName: string | null;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  resultText: string | null;
  errorText: string | null;
  toolCallCount: number;
  recentActivity: string[];
  handle: CursorHandle | null;
  settled: Promise<void> | null;
  metaChain: Promise<void>;
  meta: Record<string, unknown> | null;
}

const ACTIVITY_RING = 8;

type FailureClass = { kind: "timeout"; detail: string } | { kind: "spawn"; error: string } | null;

function classifyFailure(r: { killedBy: string | null; spawnError: string | null }): FailureClass {
  if (r.killedBy === "idle-timeout" || r.killedBy === "hard-timeout" || r.killedBy === "first-token-timeout") {
    return { kind: "timeout", detail: r.killedBy };
  }
  if (r.spawnError) return { kind: "spawn", error: r.spawnError };
  return null;
}

export class JobManager {
  #jobs = new Map<string, Job>();
  #queue: Job[] = [];
  #running = 0;
  #jobsDir: string;
  #maxConcurrent: number;
  #idleTimeoutMs: number;
  #firstTokenGraceMs: number;
  #spawnCfg: CursorSpawnConfig;
  #chatChain: Promise<void> = Promise.resolve();
  #telemetry?: Telemetry;
  #chatTimeoutMs: number;

  constructor(opts: {
    jobsDir: string;
    maxConcurrent?: number;
    idleTimeoutMs?: number;
    firstTokenGraceMs?: number;
    spawnCfg?: CursorSpawnConfig;
    telemetry?: Telemetry;
    chatTimeoutMs?: number;
  }) {
    this.#jobsDir = opts.jobsDir;
    this.#maxConcurrent = opts.maxConcurrent ?? 3;
    this.#idleTimeoutMs = opts.idleTimeoutMs ?? 180_000;
    this.#firstTokenGraceMs = opts.firstTokenGraceMs ?? DEFAULT_FIRST_TOKEN_GRACE_MS;
    this.#spawnCfg = opts.spawnCfg ?? {};
    this.#telemetry = opts.telemetry;
    this.#chatTimeoutMs = opts.chatTimeoutMs ?? 30_000;
  }

  async submit(p: SubmitParams): Promise<{ jobId: string; chatId: string }> {
    const mode: JobMode = p.mode ?? "edit";
    const isolation = p.isolation ?? "inplace";

    if (mode === "edit") {
      const info = await gitInfo(p.cwd);
      if (isolation === "worktree" && !info.isGit) {
        const reason = `worktree isolation requires a git repository: ${p.cwd}`;
        this.#tel("signal", { signal: "gate_refusal", cwd: p.cwd, reason });
        throw new Error(reason);
      }
      if (isolation === "inplace") {
        if (!info.isGit && !p.allowNonGit) {
          const reason = `refusing in-place edit outside a git repository (${p.cwd}); pass allow_non_git to override`;
          this.#tel("signal", { signal: "gate_refusal", cwd: p.cwd, reason });
          throw new Error(reason);
        }
        if (info.dirty && !p.allowDirty) {
          const reason = `refusing in-place edit on a dirty work tree (${p.cwd}); commit/stash first or pass allow_dirty`;
          this.#tel("signal", { signal: "gate_refusal", cwd: p.cwd, reason });
          throw new Error(reason);
        }
      }
    }

    const chatId = p.resumeChatId ?? (await this.#gatedCreateChat(p.cwd));
    const id = randomUUID();
    const job: Job = {
      id,
      chatId,
      prompt: p.prompt,
      cwd: p.cwd,
      mode,
      isolation,
      model: p.model ?? DEFAULT_MODEL,
      timeoutSec: p.timeoutSec ?? 600,
      idleTimeoutMs: p.idleTimeoutSec !== undefined ? p.idleTimeoutSec * 1_000 : this.#idleTimeoutMs,
      firstTokenGraceMs: p.firstTokenGraceSec !== undefined ? p.firstTokenGraceSec * 1_000 : this.#firstTokenGraceMs,
      worktreeName:
        p.worktreeName ?? (isolation === "worktree" ? `cb-${id.slice(0, 8)}` : null),
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      resultText: null,
      errorText: null,
      toolCallCount: 0,
      recentActivity: [],
      handle: null,
      settled: null,
      metaChain: Promise.resolve(),
      meta: p.meta ?? null,
    };
    this.#jobs.set(id, job);
    try {
      await mkdir(path.join(this.#jobsDir, id), { recursive: true });
      await this.#writeMeta(job);
    } catch (err) {
      this.#jobs.delete(id);
      throw err;
    }
    this.#queue.push(job);
    this.#jobEvent(job, "queued");
    this.#pump();
    return { jobId: id, chatId };
  }

  async reply(
    jobId: string,
    prompt: string,
    opts: { mode?: JobMode; timeoutSec?: number; idleTimeoutSec?: number; firstTokenGraceSec?: number } = {},
  ): Promise<{ jobId: string; chatId: string }> {
    const parent = this.#must(jobId);
    if (parent.status === "queued" || parent.status === "working") {
      this.#tel("signal", { signal: "reply_refused", job_id: jobId, reason: `parent status ${parent.status}` });
      throw new Error(
        `cannot reply to job ${jobId} while it is ${parent.status}; wait for a terminal status`,
      );
    }
    return this.submit({
      prompt,
      cwd: parent.cwd,
      mode: opts.mode ?? parent.mode,
      isolation: parent.isolation,
      model: parent.model,
      resumeChatId: parent.chatId,
      worktreeName: parent.worktreeName ?? undefined,
      timeoutSec: opts.timeoutSec ?? parent.timeoutSec,
      // timeout overrides inherit from the parent (stored in ms, second-granular)
      idleTimeoutSec: opts.idleTimeoutSec ?? Math.round(parent.idleTimeoutMs / 1_000),
      firstTokenGraceSec: opts.firstTokenGraceSec ?? Math.round(parent.firstTokenGraceMs / 1_000),
      // the tree is expected to be dirty with the parent job's own edits
      allowDirty: true,
      allowNonGit: true,
    });
  }

  status(jobId: string) {
    const j = this.#must(jobId);
    return {
      jobId: j.id,
      chatId: j.chatId,
      status: j.status,
      elapsedSec: this.#elapsedSec(j),
      toolCallCount: j.toolCallCount,
      recentActivity: [...j.recentActivity],
      worktreeName: j.worktreeName,
    };
  }

  async result(jobId: string) {
    const j = this.#must(jobId);
    let worktreePath: string | null = null;
    if (j.worktreeName) worktreePath = await findWorktree(j.cwd, j.worktreeName);
    const worktreeMissing = j.worktreeName !== null && worktreePath === null;
    const where = worktreePath ?? j.cwd;
    const isEdit = j.mode === "edit" && !worktreeMissing;
    return {
      jobId: j.id,
      chatId: j.chatId,
      status: j.status,
      resultText: j.resultText,
      errorText: j.errorText,
      diffStat: isEdit ? await diffStat(where) : "",
      changedFiles: isEdit ? await changedFiles(where) : [],
      worktreePath,
      worktreeMissing,
    };
  }

  // Bounded wait for a job to REACH FULL SETTLEMENT (the same `settled` continuation
  // `drain()` awaits — covers terminal telemetry and the awaited findWorktree check,
  // not just the raw process exit). Polls every 50 ms while a job is queued (settled
  // is null until #start assigns it) or has just been cancelled out of the queue
  // (status flips to terminal but no settled promise is ever created for that path —
  // the status check catches it). Once settled exists, races it against the remaining
  // bound instead of continuing to poll. Never throws for an unknown id: result()/#must
  // produce the standard error downstream, and this method's job is only to wait.
  // Always clears its timer on every exit path (loop return, race resolution, or
  // unknown id) so no handle is left dangling.
  async waitSettled(jobId: string, timeoutMs: number): Promise<void> {
    const POLL_MS = 50;
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const j = this.#jobs.get(jobId);
        if (!j) return;
        if (j.settled) {
          const remaining = Math.max(0, deadline - Date.now());
          await Promise.race([
            j.settled,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, remaining);
            }),
          ]);
          return;
        }
        if (TERMINAL_STATUSES.has(j.status)) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(POLL_MS, remaining));
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(jobId: string): { cancelled: boolean; status: JobStatus | null } {
    const j = this.#jobs.get(jobId);
    if (!j) return { cancelled: false, status: null };
    if (j.status === "queued") {
      this.#queue = this.#queue.filter((q) => q.id !== jobId);
      j.status = "cancelled";
      j.endedAt = Date.now();
      void this.#writeMeta(j);
      this.#tel("signal", { signal: "cancel", job_id: jobId, reason: "explicit", status_at_cancel: "queued" });
      this.#jobEvent(j, "cancelled", { killedBy: null });
      return { cancelled: true, status: j.status };
    }
    if (j.status === "working" && j.handle) {
      this.#tel("signal", { signal: "cancel", job_id: jobId, reason: "explicit", status_at_cancel: "working" });
      j.handle.cancel();
      return { cancelled: true, status: j.status };
    }
    return { cancelled: false, status: j.status };
  }

  list() {
    return [...this.#jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        jobId: j.id,
        status: j.status,
        mode: j.mode,
        isolation: j.isolation,
        promptPreview: j.prompt.slice(0, 80),
        elapsedSec: this.#elapsedSec(j),
        // review axes all share one prompt preview — meta (review_id/axis) is
        // the only way to tell them apart in a listing (spec §5)
        meta: j.meta,
      }));
  }

  async ask(prompt: string, cwd: string, model?: string): Promise<string> {
    const hardMs = 120_000;
    const r = await runCursorAgent({
      prompt,
      cwd,
      mode: "ask",
      model: model ?? DEFAULT_MODEL,
      idleTimeoutMs: Math.min(hardMs, this.#idleTimeoutMs),
      // thinking before the first token is legitimate for the whole sync window;
      // the hard cap is the only bound that matters here
      firstTokenGraceMs: hardMs,
      hardTimeoutMs: hardMs,
      ...this.#spawnCfg,
    }).done;
    const fc = classifyFailure(r);
    if (fc?.kind === "timeout") this.#tel("signal", { signal: "ask_timeout", detail: fc.detail });
    else if (fc?.kind === "spawn") this.#tel("signal", { signal: "spawn_error", detail: { phase: "ask" }, error: fc.error });
    if (r.killedBy) throw new Error(`cursor_ask timed out (${r.killedBy}); the question was too big for the 120 s sync path — resubmit via cursor_run(mode="ask") and poll cursor_status/cursor_result`);
    if (r.spawnError) throw new Error(`cursor-agent failed to start: ${r.spawnError}`);
    if (r.exitCode !== 0)
      throw new Error(
        `cursor-agent exited with code ${r.exitCode}${r.stderrTail ? `; stderr: ${r.stderrTail.trim()}` : ""}`,
      );
    // trim-gate: empty/whitespace-only result must fall through to
    // assistantText — parity with the submit path's resultText link
    const answer = r.resultText?.trim() ? r.resultText : r.assistantText;
    if (!answer) throw new Error("cursor-agent returned no answer");
    return answer;
  }

  shutdown(): void {
    for (const j of this.#jobs.values()) {
      if (j.status === "queued") {
        this.#queue = this.#queue.filter((q) => q.id !== j.id);
        j.status = "cancelled";
        j.endedAt = Date.now();
        void this.#writeMeta(j);
        this.#tel("signal", { signal: "cancel", job_id: j.id, reason: "shutdown", status_at_cancel: "queued" });
        this.#jobEvent(j, "cancelled", { killedBy: null });
      } else if (j.status === "working" && j.handle) {
        this.#tel("signal", { signal: "cancel", job_id: j.id, reason: "shutdown", status_at_cancel: "working" });
        j.handle.cancel();
      }
    }
  }

  #gatedCreateChat(cwd: string): Promise<string> {
    // create-chat is serialized: the real binary has a hang bug and each call
    // costs a subprocess; a burst of submits must not fan these out unbounded
    const run = this.#chatChain.then(() =>
      createChat(cwd, this.#spawnCfg, this.#chatTimeoutMs).catch((e) => {
        this.#tel("signal", { signal: "spawn_error", cwd, detail: { phase: "create-chat" }, error: String(e) });
        throw e;
      }),
    );
    this.#chatChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #pump(): void {
    while (this.#running < this.#maxConcurrent && this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      // cancel() can flip a queued job's status to "cancelled" between the
      // #jobs.set/#queue.push in submit() and this pump running; without this
      // guard #start would overwrite that status back to "working".
      if (job.status === "cancelled") continue;
      this.#start(job);
    }
  }

  #start(job: Job): void {
    job.status = "working";
    job.startedAt = Date.now();
    void this.#writeMeta(job);
    this.#jobEvent(job, "working");
    this.#running += 1;
    const eventsPath = path.join(this.#jobsDir, job.id, "events.jsonl");
    job.handle = runCursorAgent({
      prompt: job.prompt,
      cwd: job.cwd,
      mode: job.mode,
      model: job.model,
      resumeChatId: job.chatId,
      worktreeName: job.worktreeName ?? undefined,
      idleTimeoutMs: job.idleTimeoutMs,
      firstTokenGraceMs: job.firstTokenGraceMs,
      hardTimeoutMs: job.timeoutSec * 1_000,
      onRawLine: (line) => void appendFile(eventsPath, line + "\n").catch(() => {}),
      onEvent: (e) => {
        if (e.type === "bridge_buffer_overflow") {
          this.#tel("signal", { signal: "buffer_overflow", job_id: job.id, droppedBytes: e.droppedBytes });
        }
        job.recentActivity.push(summarizeEvent(e));
        if (job.recentActivity.length > ACTIVITY_RING) job.recentActivity.shift();
      },
      ...this.#spawnCfg,
    });
    job.settled = job.handle.done.then(async (r) => {
      job.endedAt = Date.now();
      job.toolCallCount = r.toolCallCount;
      // trim-gate (not ??): an empty or whitespace-only result event must fall
      // through to assistantText — review axes were observed emitting findings only there
      job.resultText =
        (job.mode === "plan" ? r.planText : null) ??
        (r.resultText?.trim() ? r.resultText : null) ??
        (r.assistantText || null);
      if (r.killedBy === "cancelled") {
        job.status = "cancelled";
      } else if (r.killedBy) {
        job.status = "failed";
        job.errorText =
          r.killedBy === "first-token-timeout"
            ? `watchdog: first-token-timeout after ${this.#elapsedSec(job)}s (no first token — the model never started answering; raise first_token_grace_sec, or retry in a FRESH chat instead of resuming a large one)`
            : `watchdog: ${r.killedBy} after ${this.#elapsedSec(job)}s`;
      } else if (r.spawnError) {
        job.status = "failed";
        job.errorText = `spawn error: ${r.spawnError}`;
      } else if (r.exitCode !== 0) {
        job.status = "failed";
        job.errorText = `cursor-agent exited with code ${r.exitCode}${r.stderrTail ? `; stderr: ${r.stderrTail.trim()}` : ""}`;
      } else {
        job.status = "completed";
      }
      const fc = classifyFailure(r);
      if (fc?.kind === "timeout") {
        // stall diagnostics: saw_first_token=false + output_chars>0 reads as
        // "killed while thinking before the first token"; output_chars=0 is the
        // silent hang-bug shape; saw_first_token=true is a mid-stream stall
        this.#tel("signal", {
          signal: "watchdog_kill",
          job_id: job.id,
          detail: fc.detail,
          saw_first_token: r.sawFirstToken,
          first_token_ms: r.firstTokenMs,
          output_chars: r.outputChars,
          tool_call_count: r.toolCallCount,
          stderr_tail: r.stderrTail.slice(-512),
        });
      } else if (fc?.kind === "spawn") {
        this.#tel("signal", { signal: "spawn_error", job_id: job.id, detail: { phase: "run" }, error: fc.error });
      }
      this.#jobEvent(job, job.status, { killedBy: r.killedBy ?? null });
      this.#running -= 1;
      void this.#writeMeta(job);
      this.#pump();
      if (job.worktreeName) {
        const p = await findWorktree(job.cwd, job.worktreeName);
        if (p === null) this.#tel("signal", { signal: "worktree_missing", job_id: job.id });
      }
    });
  }

  #writeMeta(job: Job): Promise<void> {
    // Chained per-job so out-of-order completion of two fire-and-forget writes
    // (e.g. a "queued" write racing a "working" write) can't leave a stale
    // meta.json on disk — each write waits for the previous one to settle.
    const link = job.metaChain
      .then(() => {
        const { handle: _h, settled: _s, metaChain: _m, ...meta } = job;
        return writeFile(
          path.join(this.#jobsDir, job.id, "meta.json"),
          JSON.stringify(meta, null, 2),
        );
      })
      .catch(() => {});
    job.metaChain = link;
    return link;
  }

  #elapsedSec(j: Job): number {
    const start = j.startedAt ?? j.createdAt;
    const end = j.endedAt ?? Date.now();
    return Math.round((end - start) / 1000);
  }

  #must(jobId: string): Job {
    const j = this.#jobs.get(jobId);
    if (!j) throw new Error(`unknown job_id: ${jobId}`);
    return j;
  }

  #tel(kind: string, payload: Record<string, unknown>): void {
    this.#telemetry?.record(kind, payload);
  }

  #jobEvent(job: Job, transition: string, extra: Record<string, unknown> = {}): void {
    const terminal = TERMINAL_STATUSES.has(transition);
    this.#tel("job", {
      job_id: job.id,
      chat_id: job.chatId,
      transition,
      status: job.status,
      mode: job.mode,
      isolation: job.isolation,
      model: job.model,
      killedBy: null,
      errorText: job.errorText,
      // reliable only at terminal transitions (updated in the done handler)
      ...(terminal ? { toolCallCount: job.toolCallCount } : {}),
      elapsed_sec: this.#elapsedSec(job),
      ...(job.meta !== null ? { meta: job.meta } : {}),
      ...extra,
    });
  }

  // Await FULL settlement of all active jobs (bounded) — `settled` covers the whole
  // done-continuation including terminal telemetry and the awaited findWorktree check,
  // which `handle.done` alone would not. Used by server shutdown.
  async drain(timeoutMs: number): Promise<void> {
    // NO status filter: the settled continuation flips status to terminal EARLY,
    // so filtering by status would skip continuations still in flight.
    // Awaiting an already-settled promise is free.
    const pending = [...this.#jobs.values()]
      .filter((j) => j.settled)
      .map((j) => j.settled!);
    if (pending.length === 0) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(pending), new Promise((r) => { t = setTimeout(r, timeoutMs); })]);
    } finally {
      clearTimeout(t);
    }
  }

  activeJobIds(): string[] {
    return [...this.#jobs.values()].filter((j) => !TERMINAL_STATUSES.has(j.status)).map((j) => j.id);
  }

  attachTelemetry(t: Telemetry): void {
    this.#telemetry = t;
  }
}

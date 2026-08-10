import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_MODEL } from "./cursor-process.ts";
import type { JobManager } from "./job-manager.ts";
import { RefuteManager } from "./refute.ts";
import type { RoleVerdict } from "./refute-parser.ts";
import { ALL_AXIS_NAMES, AXIS_SET_NAMES, ReviewManager } from "./review.ts";
import { aggregate, loadTelemetryRecords } from "./stats.ts";
import { Telemetry } from "./telemetry.ts";

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> };

function instrument<A extends Record<string, unknown>>(
  telemetry: Telemetry | undefined,
  tool: string,
  handler: (a: A) => Promise<ToolResult>,
): (a: A) => Promise<ToolResult> {
  if (!telemetry?.enabled) return handler;
  return async (a: A) => {
    const t0 = Date.now();
    try {
      const res = await handler(a);
      telemetry.record("tool_call", { tool, args: a, ok: true, result: res.structuredContent, duration_ms: Date.now() - t0 });
      return res;
    } catch (err) {
      telemetry.record("tool_call", { tool, args: a, ok: false, error: String(err), duration_ms: Date.now() - t0 });
      throw err;
    }
  };
}

const VERIFY_NOTE =
  "Composer output is an UNVERIFIED claim. Before acting: " +
  "(1) independently confirm or refute each finding/statement against the actual code and docs — " +
  "never fold unverified claims into specs, plans, or fixes; " +
  "(2) for edits, review the full diff and run the project's tests/lint; " +
  "(3) explicitly record which claims you confirmed and which you refuted.";

const REFUTE_VERIFY_NOTE =
  "Refuter verdicts are machine-cross-checked SECOND opinions, not final truth. " +
  "Direct manual attention to escalated findings — that is the human's queue. " +
  "Auto-refuted records must be KEPT with verdicts and quotes, never deleted; " +
  "spot-check a sample of auto-closed findings and record restores in the hunt journal " +
  "(false-refute calibration). The right to a FINAL verdict stays with the owner.";

const modeSchema = z.enum(["edit", "plan", "ask"]);

export const reviewAxesSchema = z
  .array(z.enum(ALL_AXIS_NAMES)) // ALL_AXIS_NAMES — plan+code tuple (Task 1); cross-set validated in selectAxes
  .min(2, "review requires at least 2 axes (invariant)")
  .refine((a) => new Set(a).size >= 2, "review requires at least 2 DISTINCT axes (invariant)")
  .optional();

const HINT_SEGMENTS_THRESHOLD = 10;

const refuteFindingSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.string().optional(),
  claim: z.string().min(10).describe("Failure scenario in words — what breaks and how"),
});

export function registerTools(server: McpServer, jm: JobManager, telemetry?: Telemetry): void {
  const rm = new ReviewManager(jm);
  const fm = new RefuteManager(jm);

  server.registerTool(
    "cursor_run",
    {
      title: "Run Cursor Composer task (async)",
      description:
        "Start an async cursor-agent job. Returns job_id immediately; poll cursor_status, fetch cursor_result. " +
        "Prompt must be a self-contained brief: goal, context, files, constraints, acceptance criteria.",
      inputSchema: {
        prompt: z.string().min(1),
        cwd: z.string().refine((p) => path.isAbsolute(p), "cwd must be an absolute path").describe("Absolute path to the target project"),
        mode: modeSchema.default("edit"),
        isolation: z.enum(["inplace", "worktree"]).default("inplace"),
        model: z.string().default(DEFAULT_MODEL),
        resume_chat_id: z.string().optional(),
        timeout_sec: z.number().int().positive().max(3600).default(600),
        idle_sec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe("Inter-token stall detector: max seconds of stdout silence AFTER the first token before the watchdog kills the job (default 180)."),
        first_token_grace_sec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe(
            "Thinking budget: max seconds from start to the model's FIRST token (default 480). Raise for heavy reviews on large resumed contexts — long pre-answer thinking is normal there and is not a hang.",
          ),
        allow_dirty: z.boolean().default(false),
        allow_non_git: z.boolean().default(false),
      },
    },
    instrument(telemetry, "cursor_run", async (a) => {
      const { jobId, chatId } = await jm.submit({
        prompt: a.prompt,
        cwd: a.cwd,
        mode: a.mode,
        isolation: a.isolation,
        model: a.model,
        resumeChatId: a.resume_chat_id,
        timeoutSec: a.timeout_sec,
        idleTimeoutSec: a.idle_sec,
        firstTokenGraceSec: a.first_token_grace_sec,
        allowDirty: a.allow_dirty,
        allowNonGit: a.allow_non_git,
      });
      return ok({ job_id: jobId, chat_id: chatId, status: jm.status(jobId).status });
    }),
  );

  server.registerTool(
    "cursor_status",
    {
      title: "Check Cursor job status",
      description: "Status of an async job: queued|working|completed|failed|cancelled, elapsed time, recent activity.",
      inputSchema: { job_id: z.string() },
    },
    instrument(telemetry, "cursor_status", async (a) => {
      const s = jm.status(a.job_id);
      return ok({
        job_id: s.jobId,
        chat_id: s.chatId,
        status: s.status,
        elapsed_sec: s.elapsedSec,
        tool_call_count: s.toolCallCount,
        recent_activity: s.recentActivity,
        worktree_name: s.worktreeName,
      });
    }),
  );

  server.registerTool(
    "cursor_result",
    {
      title: "Fetch Cursor job result",
      description:
        "Final answer, git diff --stat, changed files, and worktree path (if any) for a job. The verify_note field is mandatory guidance: confirm or refute the output before using it. " +
        "Pass wait_sec to long-poll: blocks up to that many seconds for the job to finish before returning, instead of an immediate (possibly non-terminal) snapshot — removes the need to hand-roll a cursor_status poll loop.",
      inputSchema: {
        job_id: z.string(),
        wait_sec: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe(
            "Block up to this many seconds for the job to finish before returning (long-poll). Repeatable: call again if still non-terminal. Keep below your MCP client timeout.",
          ),
      },
    },
    instrument(telemetry, "cursor_result", async (a) => {
      if (a.wait_sec) await jm.waitSettled(a.job_id, a.wait_sec * 1000);
      const r = await jm.result(a.job_id);
      return ok({
        job_id: r.jobId,
        chat_id: r.chatId,
        status: r.status,
        result_text: r.resultText,
        error_text: r.errorText,
        diff_stat: r.diffStat,
        changed_files: r.changedFiles,
        worktree_path: r.worktreePath,
        worktree_missing: r.worktreeMissing,
        verify_note: VERIFY_NOTE,
      });
    }),
  );

  server.registerTool(
    "cursor_review",
    {
      title: "Multi-axis adversarial review (async)",
      description:
        "Start a multi-axis review: N parallel read-only Composer jobs with adversarial briefs of DIFFERENT temperaments " +
        "(broad = external risks, strict = internal rigor, hygiene = test/plan hygiene). Two axis sets: 'plan' (broad/strict/hygiene) for specs and design docs, 'code' (correctness/security/tests, always all 3) for source code — pick with axis_set. " +
        "A review is NEVER single-axis (invariant, min 2). Axis count auto-scales by artifact weight; override with axes[]. Returns review_id + per-axis job_ids immediately " +
        "(submit awaits serialized create-chat per axis — worst case N × ~30 s). Fetch with cursor_review_result. " +
        "A review dies with server shutdown at N× the cost of one job — for headless drivers, never end a turn mid-poll.",
      inputSchema: {
        artifacts: z.array(z.string().refine((p) => path.isAbsolute(p), "artifact paths must be absolute")).min(1),
        cwd: z.string().refine((p) => path.isAbsolute(p), "cwd must be an absolute path"),
        context: z.string().min(1).describe("What the project and artifact are — injected into every axis brief"),
        cycles_passed: z.number().int().min(0).default(0),
        axes: reviewAxesSchema,
        axis_set: z.enum(AXIS_SET_NAMES).default("plan")
          .describe("Which axis set to fan out: 'plan' for specs/plans/design docs, 'code' for source-code review (always all 3 axes)."),
        timeout_sec: z.number().int().positive().max(3600).optional(),
        first_token_grace_sec: z.number().int().positive().max(3600).optional(),
        idle_sec: z.number().int().positive().max(3600).optional(),
      },
    },
    instrument(telemetry, "cursor_review", async (a) => {
      const r = await rm.submit({
        artifacts: a.artifacts,
        cwd: a.cwd,
        context: a.context,
        cyclesPassed: a.cycles_passed,
        axes: a.axes,
        axisSet: a.axis_set,
        timeoutSec: a.timeout_sec,
        firstTokenGraceSec: a.first_token_grace_sec,
        idleTimeoutSec: a.idle_sec,
      });
      return ok({
        review_id: r.reviewId,
        weight: r.weight,
        axis_count: r.axisCount,
        axis_set: r.axisSet,
        axes: r.axes.map((x) => ({ axis: x.axis, job_id: x.jobId, chat_id: x.chatId })),
      });
    }),
  );

  server.registerTool(
    "cursor_review_result",
    {
      title: "Fetch multi-axis review result",
      description:
        "Findings table (marker/file/line/title per axis) + RAW axis outputs (always) + overlap (LOWER BOUND: " +
        "same-file near-line matches only; semantic overlaps across different files are NOT detected). " +
        "blockers_total counts ✗ findings of completed axes. parse_degraded=true means the table is incomplete — work from raw text. " +
        "Machine clean-pass criterion: status=completed && !parse_degraded && blockers_total=0. " +
        "Pass wait_sec to long-poll (all axes awaited in parallel within one budget; repeatable). " +
        "The verify_note is mandatory guidance: findings are UNVERIFIED (~15% refute rate historically).",
      inputSchema: {
        review_id: z.string(),
        wait_sec: z.number().int().min(1).max(120).optional(),
      },
    },
    instrument(telemetry, "cursor_review_result", async (a) => {
      const r = await rm.result(a.review_id, a.wait_sec !== undefined ? a.wait_sec * 1_000 : undefined);
      return ok({
        review_id: r.reviewId,
        status: r.status,
        axes: r.axes.map((x) => ({ axis: x.axis, job_id: x.jobId, status: x.status, result_text: x.resultText })),
        axes_failed: r.axesFailed.map((x) => ({ axis: x.axis, error_text: x.errorText })),
        findings: r.findings.map((f) => ({
          axis: f.axis, marker: f.marker, file: f.file, line: f.line, line_end: f.lineEnd, title: f.title,
        })),
        overlap: r.overlap,
        blockers_total: r.blockersTotal,
        parse_degraded: r.parseDegraded,
        verify_note: VERIFY_NOTE,
      });
    }),
  );

  server.registerTool(
    "cursor_refute",
    {
      title: "Refuter pair: primary confirm/refute of review findings (async)",
      description:
        "Dispatch a PAIR of adversarial verifiers over a pack of review findings: prosecutor (proves each bug real by tracing the call chain) " +
        "and advocate (proves it false by finding defenses and documented decisions). Read-only (ask mode). " +
        "Auto-verdicts happen ONLY on strong agreement with machine-checked code quotes; everything else escalates to the human. " +
        "Verdicts are SECOND opinions, not truth: auto-refuted records must be KEPT with their verdicts, never deleted. " +
        "Pack: 1..12 findings of one code area. Returns refute_id + per-role job_ids; fetch with cursor_refute_result.",
      inputSchema: {
        findings: z.array(refuteFindingSchema).min(1).max(12)
          .refine((fs) => new Set(fs.map((f) => f.id)).size === fs.length, "finding ids must be unique"),
        cwd: z.string().refine((p) => path.isAbsolute(p), "cwd must be an absolute path"),
        context: z.string().min(1).describe("Code area + known project decisions — injected into both briefs"),
        domain: z.string().optional()
          .describe("Domain tag for false-refute calibration (e.g. money-core vs orchestration)"),
        timeout_sec: z.number().int().positive().max(3600).optional(),
        first_token_grace_sec: z.number().int().positive().max(3600).optional(),
        idle_sec: z.number().int().positive().max(3600).optional(),
      },
    },
    instrument(telemetry, "cursor_refute", async (a) => {
      const r = await fm.submit({
        findings: a.findings, cwd: a.cwd, context: a.context, domain: a.domain,
        timeoutSec: a.timeout_sec, firstTokenGraceSec: a.first_token_grace_sec, idleTimeoutSec: a.idle_sec,
      });
      return ok({
        refute_id: r.refuteId,
        roles: r.roles.map((x) => ({ role: x.role, job_id: x.jobId, chat_id: x.chatId })),
      });
    }),
  );

  server.registerTool(
    "cursor_refute_result",
    {
      title: "Fetch refuter pair result",
      description:
        "Per-finding verdicts of both roles + machine consensus: confirmed / refuted (auto-close, KEEP the record) / escalate " +
        "(disagreement | unclear | citation_failed | missing_verdict | degraded_role | cwd_changed). " +
        "quote_verified means the cited code fragment literally matches the file (whitespace-tolerant). " +
        "A failed/degraded role (job death OR >50% of the pack ignored) kills ALL auto-closes for the pack (lone REFUTED only lowers confidence). " +
        "cwd_pinned=false (non-git cwd, dirty tree, or HEAD changed since submit) also kills auto-closes: verdicts must be tied to the code version they judge. " +
        "Pass wait_sec to long-poll. The refute-specific verify_note governs what still needs human attention.",
      inputSchema: {
        refute_id: z.string(),
        wait_sec: z.number().int().min(1).max(120).optional(),
      },
    },
    instrument(telemetry, "cursor_refute_result", async (a) => {
      const r = await fm.result(a.refute_id, a.wait_sec !== undefined ? a.wait_sec * 1_000 : undefined);
      const roleOut = (v: RoleVerdict | null) =>
        v === null ? null : {
          verdict: v.verdict, file: v.file, line: v.line, quote: v.quote,
          quote_verified: v.quoteVerified, reason: v.reason,
        };
      return ok({
        refute_id: r.refuteId,
        status: r.status,
        roles: r.roles.map((x) => ({ role: x.role, job_id: x.jobId, status: x.status, result_text: x.resultText })),
        verdicts: r.verdicts.map((v) => ({
          id: v.id, prosecutor: roleOut(v.prosecutor), advocate: roleOut(v.advocate),
          consensus: v.consensus,
          ...(v.escalateReason !== undefined ? { escalate_reason: v.escalateReason } : {}),
          ...(v.confidenceLowered ? { confidence_lowered: true } : {}),
        })),
        auto_confirmed: r.autoConfirmed, auto_refuted: r.autoRefuted, escalated: r.escalated,
        parse_degraded: r.parseDegraded,
        duplicates: r.duplicates,
        cwd_pinned: r.cwdPinned,
        verify_note: REFUTE_VERIFY_NOTE,
      });
    }),
  );

  server.registerTool(
    "cursor_reply",
    {
      title: "Continue a Cursor chat",
      description:
        "Send the next step in the same Composer chat as an earlier job (staged prompting: plan → approve → execute).",
      inputSchema: {
        job_id: z.string().describe("A previous job whose chat to continue"),
        prompt: z.string().min(1),
        mode: modeSchema.optional(),
        timeout_sec: z.number().int().positive().max(3600).optional(),
        idle_sec: z.number().int().positive().max(3600).optional().describe("Override the inherited inter-token stall detector (seconds)."),
        first_token_grace_sec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe("Override the inherited thinking budget (seconds to the first token). Resumed chats carry big contexts — long pre-answer thinking is normal."),
      },
    },
    instrument(telemetry, "cursor_reply", async (a) => {
      const { jobId, chatId } = await jm.reply(a.job_id, a.prompt, {
        mode: a.mode,
        timeoutSec: a.timeout_sec,
        idleTimeoutSec: a.idle_sec,
        firstTokenGraceSec: a.first_token_grace_sec,
      });
      return ok({ job_id: jobId, chat_id: chatId, status: jm.status(jobId).status });
    }),
  );

  server.registerTool(
    "cursor_ask",
    {
      title: "Ask Cursor (sync, read-only)",
      description:
        "Synchronous read-only question to cursor-agent (--mode ask). Hard limit 120 s. " +
        "Intentionally bypasses the 3-job concurrency cap (quick sync path); bounded only by its own 120 s limit. " +
        "The verify_note field is mandatory guidance: confirm or refute the output before using it. " +
        "For anything needing more than ~90 s of thinking or large context (big diffs, multiple docs, cross-file analysis), do NOT compress the prompt to fit — use cursor_run(mode=ask) instead: same read-only semantics, no 120 s cap, non-blocking (poll cursor_status, fetch cursor_result).",
      inputSchema: {
        prompt: z.string().min(1),
        cwd: z.string().refine((p) => path.isAbsolute(p), "cwd must be an absolute path"),
        model: z.string().default(DEFAULT_MODEL),
      },
    },
    instrument(telemetry, "cursor_ask", async (a) => ok({ answer: await jm.ask(a.prompt, a.cwd, a.model), verify_note: VERIFY_NOTE })),
  );

  server.registerTool(
    "cursor_cancel",
    {
      title: "Cancel Cursor job",
      description:
        "Cancel a queued or running job. The returned status is a snapshot at call time — poll cursor_status for the terminal state. " +
        "For unknown job ids, cancelled=false and status=null.",
      inputSchema: { job_id: z.string() },
    },
    instrument(telemetry, "cursor_cancel", async (a) => {
      const r = jm.cancel(a.job_id);
      return ok({ job_id: a.job_id, cancelled: r.cancelled, status: r.status });
    }),
  );

  server.registerTool(
    "cursor_jobs",
    {
      title: "List Cursor jobs",
      description: "All jobs of this session, newest first.",
      inputSchema: {},
    },
    instrument(telemetry, "cursor_jobs", async () =>
      ok({
        jobs: jm.list().map((j) => ({
          job_id: j.jobId,
          status: j.status,
          mode: j.mode,
          isolation: j.isolation,
          prompt_preview: j.promptPreview,
          elapsed_sec: j.elapsedSec,
          ...(j.meta !== null ? { meta: j.meta } : {}),
        })),
      }),
    ),
  );

  const requireTelemetry = (): Telemetry => {
    if (!telemetry?.enabled) throw new Error("telemetry is disabled (CURSOR_BRIDGE_TELEMETRY=off or not wired)");
    return telemetry;
  };

  server.registerTool(
    "cursor_stats",
    {
      title: "Bridge telemetry stats",
      description:
        "Aggregated bridge health over the telemetry window: tool calls, job outcomes, signals, duration percentiles, top errors, storage. Read-only.",
      inputSchema: { days: z.number().int().positive().max(365).default(7) },
    },
    instrument(telemetry, "cursor_stats", async (a: { days: number }) => {
      const t = requireTelemetry();
      const { records, corruptLines, segmentsRead, segmentsSkipped } = await loadTelemetryRecords(t.logsDir, { days: a.days });
      const stats = aggregate(records);
      const storage = await t.storageInfo();
      const hint =
        storage.segments >= HINT_SEGMENTS_THRESHOLD
          ? `telemetry has ${storage.segments} rotated segments; consider a deep-dive analysis then cursor_mark_analyzed {confirm:true} to allow cleanup`
          : undefined;
      return ok({
        ...stats,
        storage: { ...storage, corrupt_lines: corruptLines, segments_read: segmentsRead, segments_skipped: segmentsSkipped },
        ...(hint !== undefined ? { hint } : {}),
      });
    }),
  );

  server.registerTool(
    "cursor_mark_analyzed",
    {
      title: "Mark telemetry analyzed (destructive)",
      description:
        "Advances the analyzed-watermark to now. Segments and terminal job journals older than the watermark become DELETABLE at next server start. Call ONLY after a deep-dive analysis has been recorded. Requires confirm=true.",
      inputSchema: { confirm: z.boolean().default(false) },
    },
    instrument(telemetry, "cursor_mark_analyzed", async (a: { confirm: boolean }) => {
      const t = requireTelemetry();
      if (!a.confirm) {
        throw new Error("refusing: pass confirm=true — this enables deletion of analyzed telemetry segments and job journals at next server start");
      }
      const watermark = await t.markAnalyzed();
      const deletable = await t.listDeletable();
      return ok({ watermark, deletable });
    }),
  );
}

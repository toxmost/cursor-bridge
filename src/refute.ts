// Refuter pair: prosecutor/advocate fan-out over a pack of findings.
// Verdict authority stays with the human — the bridge automates the LABOR of
// verification, never the RIGHT to a final verdict (spec §2).

import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gitHead, gitInfo, gitTracked } from "./git-safety.ts";
import type { JobManager } from "./job-manager.ts";
import { MAX_ARTIFACT_BYTES, REVIEW_DEFAULTS } from "./review.ts";
import {
  computeConsensus, normalizeQuote, parseRoleVerdicts, quoteMatches,
  type ConsensusResult, type RoleVerdict,
} from "./refute-parser.ts";

export const REFUTE_ROLES = ["prosecutor", "advocate"] as const;
export type RefuteRole = (typeof REFUTE_ROLES)[number];
export const MAX_FINDINGS = 12;

export interface RefuteFinding {
  id: string;
  title: string;
  file: string;
  line?: number;
  severity?: string;
  claim: string;
}

const ROLE_TEXTS: Record<RefuteRole, { role: string; focus: string }> = {
  prosecutor: {
    role: "«прокурор» — докажи, что каждый баг из папки дел НАСТОЯЩИЙ",
    focus:
      "По КАЖДОМУ делу проследи цепочку вызовов от входа (роут/воркер/вебхук) до заявленной поломки. " +
      "CONFIRMED выноси только когда выкладка сходится: эти строки в этом порядке дают заявленный сценарий. " +
      "Если трассировка доказала ОБРАТНОЕ — сценарий недостижим или инвариант держится — выноси REFUTED " +
      "с цитатой места, где доказательство ломается: опровержение делом — тоже твоя работа. " +
      "Проверяй на живых путях кода, не на предположениях: конкурентные вызовы, порядок await, транзакционные границы. " +
      "Не смог ни доказать, ни опровергнуть — честный UNCLEAR с причиной. " +
      "Эхо claim'а без собственной трассировки — не вердикт.",
  },
  advocate: {
    role: "«адвокат кода» — докажи, что каждое подозрение из папки дел ЛОЖНОЕ",
    focus:
      "По КАЖДОМУ делу ищи защиту, которую сыщик мог не заметить: валидация/нормализация выше по цепочке, " +
      "транзакции и локи ниже, гейты конфигурации, ретраи и идемпотентность на соседнем слое. " +
      "Отдельно ищи задокументированные проектные решения: доки, комментарии в коде, существующие тесты, " +
      "фиксирующие именно это поведение как намеренное. " +
      "REFUTED выноси только с цитатой конкретной защиты или решения. " +
      "Не нашёл защиты — CONFIRMED (с цитатой уязвимого места) или UNCLEAR, но не молчание.",
  },
};

export function renderRefuteBrief(
  role: RefuteRole,
  s: { findings: readonly RefuteFinding[]; context: string },
): string {
  const { role: roleText, focus } = ROLE_TEXTS[role];
  const cases = s.findings
    .map(
      (f) =>
        `${f.id} [${f.severity ?? "?"}] ${f.title}\n  Место: ${f.file}${f.line !== undefined ? ":" + f.line : ""}\n  Сценарий: ${f.claim}`,
    )
    .join("\n\n");
  return `GOAL: Ты — ${roleText}. Перед тобой ПАПКА ДЕЛ — находки предыдущего ревью этого репозитория.
Каждое дело — непроверенная гипотеза. Твой вердикт — тоже гипотеза, его сверят со вторым независимым мнением.

CONTEXT: ${s.context}

ПАПКА ДЕЛ:
${cases}

CONSTRAINTS: read-only, НИЧЕГО не редактируй. Работай только по коду репозитория — не по памяти о похожих проектах.

ФОКУС ТВОЕЙ РОЛИ: ${focus}

ACCEPTANCE: вердикт по КАЖДОМУ id из папки — ответ без вердикта по какому-то делу не принимается.
CONFIRMED и REFUTED ОБЯЗАНЫ нести дословную цитату кода (фрагмент минимум в половину строки),
на которой основан вывод, и точное файл:строка. Цитата будет машинно сверена с файлом —
пересказ вместо дословного фрагмента провалит проверку. UNCLEAR требует причины, цитата не нужна.

OUTPUT: по одной строке на дело, ровно в формате:
<id> — CONFIRMED|REFUTED|UNCLEAR — <файл>:<строка> — «дословная цитата» — <обоснование одной фразой>
Для UNCLEAR: <id> — UNCLEAR — <причина>
НЕ оформляй вердикты markdown-таблицей — только строки указанного формата.
Номер строки обязателен для CONFIRMED/REFUTED: цитата сверяется с окном вокруг
этой строки, цитата «из другого места файла» проверку не пройдёт.
Весь финальный ответ — в завершающем сообщении. После строк вердиктов — секция
«ХОД ПРОВЕРКИ»: по абзацу на дело, как проверял.`;
}

export interface RefuteRoleState {
  role: RefuteRole;
  jobId: string;
  status: string;
  resultText: string | null;
}

export interface FindingVerdict {
  id: string;
  prosecutor: RoleVerdict | null;
  advocate: RoleVerdict | null;
  consensus: ConsensusResult["consensus"];
  escalateReason?: ConsensusResult["escalateReason"];
  confidenceLowered?: true;
}

export interface RefuteResult {
  refuteId: string;
  status: "working" | "completed" | "degraded" | "failed";
  roles: RefuteRoleState[];
  verdicts: FindingVerdict[];
  autoConfirmed: number;
  autoRefuted: number;
  escalated: number;
  parseDegraded: boolean;
  duplicates: { prosecutor: string[]; advocate: string[] };
  /** cwd is a clean git tree whose HEAD did not change between submit and result. */
  cwdPinned: boolean;
}

interface CwdPin { isGit: boolean; dirty: boolean; head: string | null }

interface RefuteRecord {
  id: string;
  cwd: string;
  pin: CwdPin;
  findings: RefuteFinding[];
  roles: Array<{ role: RefuteRole; jobId: string }>;
  createdAt: number;
  /** First terminal result, memoized: repeated polls must return one truth. */
  final?: RefuteResult;
}

const NON_TERMINAL = new Set(["queued", "working"]);

export class RefuteManager {
  #refutes = new Map<string, RefuteRecord>();
  #jm: JobManager;

  constructor(jm: JobManager) {
    this.#jm = jm;
  }

  async submit(p: {
    findings: RefuteFinding[]; cwd: string; context: string; domain?: string;
    timeoutSec?: number; firstTokenGraceSec?: number; idleTimeoutSec?: number;
  }): Promise<{ refuteId: string; roles: Array<{ role: RefuteRole; jobId: string; chatId: string }> }> {
    if (p.findings.length < 1) throw new Error("refute requires at least 1 finding");
    if (p.findings.length > MAX_FINDINGS) {
      throw new Error(`refute pack too large: ${p.findings.length} > ${MAX_FINDINGS} — split into two calls`);
    }
    const ids = new Set(p.findings.map((f) => f.id));
    if (ids.size !== p.findings.length) throw new Error("duplicate finding ids in pack");
    const refuteId = randomUUID();
    // Pin BEFORE dispatching: the first role starts reading code the moment its
    // job is submitted — a pin taken after dispatch leaves a TOCTOU window
    // (cross-review cycle 3). Verdicts must be tied to the version roles read.
    const pin: CwdPin = { ...(await gitInfo(p.cwd)), head: await gitHead(p.cwd) };
    // Same allSettled + cancel-on-partial-failure shape as ReviewManager.submit:
    // an orphaned role would silently burn a Composer slot otherwise.
    const settled = await Promise.allSettled(
      REFUTE_ROLES.map(async (role) => {
        const { jobId, chatId } = await this.#jm.submit({
          prompt: renderRefuteBrief(role, { findings: p.findings, context: p.context }),
          cwd: p.cwd,
          mode: "ask",
          timeoutSec: p.timeoutSec ?? REVIEW_DEFAULTS.timeoutSec,
          firstTokenGraceSec: p.firstTokenGraceSec ?? REVIEW_DEFAULTS.firstTokenGraceSec,
          idleTimeoutSec: p.idleTimeoutSec ?? REVIEW_DEFAULTS.idleTimeoutSec,
          meta: { refute_id: refuteId, role, domain: p.domain ?? null },
        });
        return { role, jobId, chatId };
      }),
    );
    const rejected = settled.find((s) => s.status === "rejected");
    if (rejected) {
      for (const s of settled) if (s.status === "fulfilled") this.#jm.cancel(s.value.jobId);
      throw (rejected as PromiseRejectedResult).reason;
    }
    const roles = settled.map(
      (s) => (s as PromiseFulfilledResult<{ role: RefuteRole; jobId: string; chatId: string }>).value,
    );
    this.#refutes.set(refuteId, {
      id: refuteId, cwd: p.cwd, pin, findings: [...p.findings],
      roles: roles.map(({ role, jobId }) => ({ role, jobId })), createdAt: Date.now(),
    });
    return { refuteId, roles };
  }

  /**
   * Resolve+read a cited file with realpath containment inside cwd; null on any
   * failure. Size-capped: a model citing a giant bundle/dump inside cwd must
   * fail the check, not OOM the MCP process (reuses MAX_ARTIFACT_BYTES).
   * In a git cwd the cited file must be TRACKED — ignored/untracked files are
   * invisible to the HEAD+porcelain pin and therefore unpinnable (cycle 3).
   */
  async #readCited(rec: RefuteRecord, cited: string): Promise<string | null> {
    try {
      const realCwd = await realpath(rec.cwd);
      const abs = path.isAbsolute(cited) ? cited : path.join(realCwd, cited);
      const real = await realpath(abs);
      if (real !== realCwd && !real.startsWith(realCwd + path.sep)) return null;
      if (rec.pin.isGit && !(await gitTracked(realCwd, path.relative(realCwd, real)))) return null;
      if ((await stat(real)).size > MAX_ARTIFACT_BYTES) return null;
      return await readFile(real, "utf8");
    } catch {
      return null;
    }
  }

  async result(refuteId: string, waitMs?: number): Promise<RefuteResult> {
    const rec = this.#refutes.get(refuteId);
    if (!rec) throw new Error(`unknown refute_id: ${refuteId}`);
    // Idempotent terminal result: a commit landing after the first read must not
    // flip an already-issued verdict set on a later poll (cross-review cycle 3).
    if (rec.final !== undefined) return rec.final;
    if (waitMs !== undefined) {
      await Promise.all(rec.roles.map((r) => this.#jm.waitSettled(r.jobId, waitMs)));
    }
    const roles: RefuteRoleState[] = [];
    const parsesByRole = new Map<RefuteRole, ReturnType<typeof parseRoleVerdicts>>();
    const ids = rec.findings.map((f) => f.id);
    for (const r of rec.roles) {
      const jr = await this.#jm.result(r.jobId);
      roles.push({ role: r.role, jobId: r.jobId, status: jr.status, resultText: jr.resultText });
      if (jr.status === "completed") parsesByRole.set(r.role, parseRoleVerdicts(jr.resultText ?? "", ids));
    }
    const anyRunning = roles.some((r) => NON_TERMINAL.has(r.status));
    const completed = roles.filter((r) => r.status === "completed").length;
    const status: RefuteResult["status"] = anyRunning
      ? "working"
      : completed === roles.length ? "completed" : completed > 0 ? "degraded" : "failed";
    // Quote verification: per-call file cache, one read per cited file.
    // quoteMatches is line-anchored and substance-checked. Reason must carry the
    // role's OWN reasoning: empty, or equal to the quote once quote punctuation
    // is stripped from both sides («quote» as the last field is not a reason).
    const fileCache = new Map<string, string | null>();
    // Strip quote punctuation AND trailing punctuation/dashes before the
    // reason-vs-quote comparison: «quote». or «quote» — (dangling separator)
    // as the last field is still no reason (cycles 4-5).
    const bare = (s: string): string =>
      normalizeQuote(s.replace(/[«»"`]/gu, "")).replace(/[\s.,;:!?…—–-]+$/u, "");
    const verify = async (v: RoleVerdict | null): Promise<RoleVerdict | null> => {
      if (v === null || v.verdict === "UNCLEAR") return v;
      if (v.quote === null || v.file === null || v.line === null) return { ...v, quoteVerified: false };
      if (bare(v.reason) === "" || bare(v.reason) === bare(v.quote)) {
        return { ...v, quoteVerified: false };
      }
      if (!fileCache.has(v.file)) fileCache.set(v.file, await this.#readCited(rec, v.file));
      const text = fileCache.get(v.file) ?? null;
      return { ...v, quoteVerified: text !== null && quoteMatches(v.quote, text, v.line) };
    };
    // Per-role degradation: job death OR ignoring >50% of the pack (the answer
    // is not accepted as a whole, spec §8). Only a NON-degraded role's verdict
    // may lower confidence — computeConsensus enforces that.
    const roleDegraded = (role: RefuteRole): boolean => {
      const st = roles.find((r) => r.role === role)!.status;
      const jobDead = !anyRunning && st !== "completed";
      return jobDead || (parsesByRole.get(role)?.parseDegraded ?? false);
    };
    const degraded = { p: roleDegraded("prosecutor"), a: roleDegraded("advocate") };
    const rawVerdicts: Array<{ id: string; p: RoleVerdict | null; a: RoleVerdict | null; c: ConsensusResult }> = [];
    for (const id of ids) {
      const p = await verify(parsesByRole.get("prosecutor")?.verdicts[id] ?? null);
      const a = await verify(parsesByRole.get("advocate")?.verdicts[id] ?? null);
      rawVerdicts.push({ id, p, a, c: computeConsensus(p, a, degraded) });
    }
    // Re-pin AFTER all verification reads: the pin must bracket every read this
    // call performed, or a mutation mid-verify slips through (cycle 3). The
    // submit-side pin was taken BEFORE the roles were dispatched.
    const now: CwdPin = { ...(await gitInfo(rec.cwd)), head: await gitHead(rec.cwd) };
    const cwdPinned =
      rec.pin.isGit && !rec.pin.dirty && !now.dirty &&
      rec.pin.head !== null && rec.pin.head === now.head;
    const verdicts: FindingVerdict[] = rawVerdicts.map(({ id, p, a, c }) => {
      // An unpinned cwd invalidates every quote-backed conclusion: would-be
      // auto-closes escalate, and confidence_lowered is dropped too — an
      // unpinned citation can't be trusted even as a signal.
      const gated = !cwdPinned && c.consensus !== "escalate"
        ? { consensus: "escalate" as const, escalateReason: "cwd_changed" as const }
        : { ...c, ...(cwdPinned ? {} : { confidenceLowered: undefined }) };
      return {
        id, prosecutor: p, advocate: a, consensus: gated.consensus,
        ...(gated.escalateReason !== undefined ? { escalateReason: gated.escalateReason } : {}),
        ...(gated.confidenceLowered ? { confidenceLowered: true as const } : {}),
      };
    });
    const out: RefuteResult = {
      refuteId, status, roles, verdicts,
      autoConfirmed: verdicts.filter((v) => v.consensus === "confirmed").length,
      autoRefuted: verdicts.filter((v) => v.consensus === "refuted").length,
      escalated: verdicts.filter((v) => v.consensus === "escalate").length,
      parseDegraded: [...parsesByRole.values()].some((p2) => p2.parseDegraded),
      duplicates: {
        prosecutor: parsesByRole.get("prosecutor")?.duplicates ?? [],
        advocate: parsesByRole.get("advocate")?.duplicates ?? [],
      },
      cwdPinned,
    };
    // Single-flight memoization: a concurrent poll racing this one must not
    // overwrite an already-recorded truth (cycle 4), and a SLOW working-snapshot
    // must not be returned after another poll already recorded terminal (cycle 5).
    if (status !== "working") {
      rec.final ??= out;
      return rec.final;
    }
    return rec.final ?? out;
  }
}

// Multi-axis review: weight-based axis selection and baked brief templates.
// Invariant: a review is NEVER single-axis (spec §1) — enforced here AND in zod.

import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { JobManager } from "./job-manager.ts";
import { computeOverlap, parseAxis, NO_FINDINGS_TOKEN, type Finding } from "./review-parser.ts";

export const WEIGHT_THRESHOLD_LINES = 400; // uncalibrated; tune via telemetry (spec §3)
export const OVERLAP_LINE_TOL = 10; // uncalibrated; tune via telemetry (spec §7)
// Review artifacts are documents; anything past this is a mispassed binary/log.
// submit() reads every artifact into memory for weighing — fail fast, don't OOM.
export const MAX_ARTIFACT_BYTES = 2_000_000; // uncalibrated; generous for text docs

export const REVIEW_DEFAULTS = {
  timeoutSec: 1_800,
  firstTokenGraceSec: 900,
  idleTimeoutSec: 600, // first real run 2026-07-20: strict axis idle-killed at 300s mid-crawl (predicted by broad axis)
} as const;

export const AXIS_SET_NAMES = ["plan", "code"] as const;
export type AxisSetName = (typeof AXIS_SET_NAMES)[number];

export const PLAN_AXES = ["broad", "strict", "hygiene"] as const;
export const CODE_AXES = ["correctness", "security", "tests"] as const;
/** Kept for backward compatibility: the plan set's axis tuple (zod, older tests). */
export const AXIS_NAMES = PLAN_AXES;
export type AxisName = (typeof PLAN_AXES)[number] | (typeof CODE_AXES)[number];
export const ALL_AXIS_NAMES = [...PLAN_AXES, ...CODE_AXES] as const;

/** Axis sets registry (spec §4/§10 extension point; pilot spec 2026-08-09 §3 stage 1). */
export const AXIS_SETS: Record<AxisSetName, readonly AxisName[]> = {
  plan: PLAN_AXES,
  code: CODE_AXES,
};

export function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

export function selectAxes(
  weight: number,
  manual?: readonly string[],
  set: AxisSetName = "plan",
): AxisName[] {
  const setAxes = AXIS_SETS[set] as readonly string[];
  if (manual !== undefined) {
    if (manual.length < 2) throw new Error("review requires at least 2 axes (invariant)");
    for (const a of manual) {
      if (!setAxes.includes(a)) throw new Error(`axis ${a} not in axis set ${set}`);
    }
    const unique = [...new Set(manual)] as AxisName[];
    // dupes collapsed below the invariant — zod .min(2) does NOT catch this (array length is 2)
    if (unique.length < 2) throw new Error("review requires at least 2 axes (invariant)");
    return unique;
  }
  // code axes are all mandatory: no axis of the three is optional for code review
  if (set === "code") return [...CODE_AXES];
  return weight < WEIGHT_THRESHOLD_LINES ? ["broad", "strict"] : ["broad", "strict", "hygiene"];
}

const ROLES: Record<AxisName, { role: string; focus: string }> = {
  broad: {
    role: "«широкого» ревьюера — ищи ВНЕШНИЕ риски и слепые зоны: то, что артефакт молча предполагает про реальный мир и что укусит на живом прогоне",
    focus:
      "Невысказанные допущения о физическом мире и среде исполнения; непроверенные контракты с внешними системами; " +
      "чем синтетика/тесты отличаются от реальности так, что проверки зелёные, а жизнь красная; " +
      "деградации и отказы вне happy-path (паузы, обрывы, перезапуски).",
  },
  strict: {
    role: "«холодного экзаменатора» — проверяй ВНУТРЕННЮЮ строгость: математику, размерности, согласованность документов, KISS/DRY. Никакой эмпатии к автору",
    focus:
      "Математика построчно с выкладками; краевые случаи формул; согласованность утверждений между документами и с кодом; " +
      "недоопределённые контракты (типы, статусы, идемпотентность); over-engineering и мёртвые хвосты.",
  },
  hygiene: {
    role: "аудитора гигиены плана и тестов — ищи тесты, которые пройдут на сломанном коде, и предписания, которые уедут в код дефектами",
    focus:
      "Тесты, зелёные на сломанном коде (assert внутри if без assert формы; return вместо fail при отсутствии данных); " +
      "RED-фазы, которых нет; расхождение списка Files и шагов задач; арифметика тестовых фикстур; " +
      "дословные дубли кода в тексте, которые уедут в репозиторий копиями.",
  },
  correctness: {
    role: "«параноика корректности» — ищи ошибки, дающие НЕВЕРНОЕ ПОВЕДЕНИЕ на живых данных: код прочитан построчно, каждый инвариант проверен на нарушаемость",
    focus:
      "Инварианты данных и денег: где источник истины и каким путём его можно рассогласовать; " +
      "Гонки и конкурентность: параллельные мутации, отсутствующая идемпотентность, блокировки и их обходы, порядок await; " +
      "краевые случаи: пусто/ноль/дубль/отрицательное/юникод/часовые пояса/границы пагинации; " +
      "контракты между модулями: кто что обещает соседу и где обещание молча нарушено; " +
      "миграции и обратная совместимость со старыми данными.",
  },
  security: {
    role: "«безопасника» — весь клиентский ввод считай враждебным, каждую границу доверия — проверяемой",
    focus:
      "Client-writable поля и подделываемые клиентом суммы/статусы/идентификаторы; " +
      "инъекции: SQL/NoSQL, шаблоны, пути файлов, заголовки; " +
      "авторизация: кто реально может вызвать эндпоинт/мутацию и совпадает ли это с замыслом; " +
      "утечки чувствительного: логи, тексты ошибок, избыточные поля ответов API; " +
      "секреты в коде/конфиге/фикстурах.",
  },
  tests: {
    role: "аудитора тестов КОДА — ищи разрыв между тем, что тесты проверяют, и тем, что код делает",
    focus:
      "Тесты, зелёные на сломанном коде (assert в if без ветки else-fail, return вместо fail, слишком широкие матчеры); " +
      "непокрытые ветки горячего кода: ошибки, откаты, degraded-пути, конкурентные сценарии; " +
      "фикстуры, расходящиеся с реальными формами данных; " +
      "моки, тестирующие сами себя вместо кода; " +
      "заявленные в коде/доках инварианты, на которые нет ни одного теста.",
  },
};

export function renderBrief(
  axis: AxisName,
  s: { artifacts: readonly string[]; context: string; cyclesPassed: number },
): string {
  const { role, focus } = ROLES[axis];
  const cyclesNote =
    s.cyclesPassed > 0
      ? `\nВАЖНО: артефакт уже прошёл ${s.cyclesPassed} цикл(а/ов) адверсариального ревью. ` +
        "Очевидные и общие замечания уже закрыты, банальности будут отброшены. " +
        "Ищи то, что ПЕРЕЖИЛО эти циклы.\n"
      : "";
  const files = s.artifacts.map((a) => `- ${a}`).join("\n");
  return `GOAL: Ревью артефакта в роли ${role}.

CONTEXT: ${s.context}
${cyclesNote}
FILES (читай все, включая связанный код проекта, если он упомянут в контексте):
${files}

CONSTRAINTS: read-only, НИЧЕГО не редактируй. Принятые в артефакте архитектурные решения
под сомнение не ставь — проверяй их проработку.

ФОКУС ТВОЕЙ ОСИ: ${focus}

ACCEPTANCE: каждая находка ОБЯЗАНА содержать: (а) точную ссылку файл:строка (или файл:§);
(б) конкретный сценарий отказа «при таких условиях произойдёт то-то» или выкладку;
(в) почему существующие проверки артефакта это не ловят. Находка без сценария — не находка.

OUTPUT: маркированный список по убыванию важности, ровно один маркер на пункт:
✗ БЛОКЕР — цель артефакта не будет достигнута
⚠ МИНОР — стоит поправить
ℹ НИТ — наблюдение
Формат пункта: <маркер> <краткий заголовок> — <файл:строка> — <сценарий/ошибка> — <почему не ловится>.
Весь финальный ответ, включая полный список находок, — в завершающем сообщении
(не растекаться по промежуточным). Если находок нет — первой строкой напиши ровно:
${NO_FINDINGS_TOKEN}
В конце ответа — секция «ЧЕГО Я НЕ НАШЁЛ»: что проверил и считаешь крепким (это тоже
результат). Максимум 12 находок; лучше 4 настоящие, чем 12 надуманных.`;
}

export interface ReviewAxisState { axis: AxisName; jobId: string; status: string; resultText: string | null }

export interface ReviewResult {
  reviewId: string;
  status: "working" | "completed" | "degraded" | "failed";
  axes: ReviewAxisState[];
  axesFailed: Array<{ axis: AxisName; errorText: string | null }>;
  findings: Finding[];
  overlap: Array<{ file: string; line: number; axes: string[] }>;
  blockersTotal: number;
  parseDegraded: boolean;
}

interface ReviewRecord { id: string; axes: Array<{ axis: AxisName; jobId: string }>; createdAt: number }

const NON_TERMINAL = new Set(["queued", "working"]);

export class ReviewManager {
  #reviews = new Map<string, ReviewRecord>();
  #jm: JobManager;

  constructor(jm: JobManager) {
    this.#jm = jm;
  }

  async submit(p: {
    artifacts: string[]; cwd: string; context: string; cyclesPassed?: number;
    axes?: string[]; axisSet?: AxisSetName; timeoutSec?: number;
    firstTokenGraceSec?: number; idleTimeoutSec?: number;
  }): Promise<{ reviewId: string; weight: number; axisCount: number; axisSet: AxisSetName;
                axes: Array<{ axis: AxisName; jobId: string; chatId: string }> }> {
    const axisSet = p.axisSet ?? "plan";
    // resolve + dedupe (realpath dereferences symlinks: same content = same weight)
    const resolved = new Set<string>();
    for (const a of p.artifacts) {
      try {
        resolved.add(await realpath(a));
      } catch {
        throw new Error(`artifact not found: ${a}`);
      }
    }
    const files = [...resolved];
    let weight = 0;
    for (const f of files) {
      const { size } = await stat(f);
      if (size > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact too large: ${f} (${size} bytes > ${MAX_ARTIFACT_BYTES})`);
      }
      weight += countLines(await readFile(f, "utf8"));
    }
    const axes = selectAxes(weight, p.axes, axisSet);
    const reviewId = randomUUID();
    const cyclesPassed = p.cyclesPassed ?? 0;
    // Axes submit concurrently; #gatedCreateChat serializes create-chat internally
    // anyway (spec §2.1) — worst case N × chat timeout is a documented trade-off.
    // Promise.allSettled (not Promise.all): if a later axis's serialized create-chat
    // times out after an earlier axis already fulfilled, that earlier axis has a live
    // queued/running job with a full timeout budget. On partial failure we cancel every
    // fulfilled axis before rejecting so it doesn't orphan into a silent Composer burn.
    const settled = await Promise.allSettled(
      axes.map(async (axis) => {
        const { jobId, chatId } = await this.#jm.submit({
          prompt: renderBrief(axis, { artifacts: files, context: p.context, cyclesPassed }),
          cwd: p.cwd,
          mode: "ask",
          timeoutSec: p.timeoutSec ?? REVIEW_DEFAULTS.timeoutSec,
          firstTokenGraceSec: p.firstTokenGraceSec ?? REVIEW_DEFAULTS.firstTokenGraceSec,
          idleTimeoutSec: p.idleTimeoutSec ?? REVIEW_DEFAULTS.idleTimeoutSec,
          meta: { review_id: reviewId, axis, axis_set: axisSet },
        });
        return { axis, jobId, chatId };
      }),
    );
    const rejected = settled.find((s) => s.status === "rejected");
    if (rejected) {
      for (const s of settled) {
        if (s.status === "fulfilled") this.#jm.cancel(s.value.jobId);
      }
      throw rejected.reason;
    }
    const submitted = settled.map(
      (s) => (s as PromiseFulfilledResult<{ axis: AxisName; jobId: string; chatId: string }>).value,
    );
    this.#reviews.set(reviewId, {
      id: reviewId,
      axes: submitted.map(({ axis, jobId }) => ({ axis, jobId })),
      createdAt: Date.now(),
    });
    return { reviewId, weight, axisCount: axes.length, axisSet, axes: submitted };
  }

  async result(reviewId: string, waitMs?: number): Promise<ReviewResult> {
    const rec = this.#reviews.get(reviewId);
    if (!rec) throw new Error(`unknown review_id: ${reviewId}`);
    if (waitMs !== undefined) {
      // parallel per-job waits share one budget: total ≤ waitMs (spec §2.2)
      await Promise.all(rec.axes.map((a) => this.#jm.waitSettled(a.jobId, waitMs)));
    }
    const axes: ReviewAxisState[] = [];
    const axesFailed: ReviewResult["axesFailed"] = [];
    const parses: Array<ReturnType<typeof parseAxis>> = [];
    for (const a of rec.axes) {
      const r = await this.#jm.result(a.jobId);
      axes.push({ axis: a.axis, jobId: a.jobId, status: r.status, resultText: r.resultText });
      if (r.status === "completed") {
        parses.push(parseAxis(a.axis, r.resultText ?? ""));
      } else if (!NON_TERMINAL.has(r.status)) {
        // cancelled jobs have no errorText — synthesize one so axes_failed is self-explaining
        axesFailed.push({ axis: a.axis, errorText: r.errorText ?? (r.status === "cancelled" ? "cancelled" : null) });
      }
    }
    const anyRunning = axes.some((a) => NON_TERMINAL.has(a.status));
    const completed = axes.filter((a) => a.status === "completed").length;
    const status: ReviewResult["status"] = anyRunning
      ? "working"
      : completed === axes.length
        ? "completed"
        : completed > 0
          ? "degraded"
          : "failed";
    const findings = parses.flatMap((p2) => p2.findings);
    // spec §7: degraded parse = (<50% of marker lines located) OR (0 markers AND no clean token)
    const parseDegraded = parses.some(
      (p2) =>
        (p2.markerLines > 0 && p2.parsedLines < p2.markerLines / 2) ||
        (p2.markerLines === 0 && !p2.cleanToken),
    );
    return {
      reviewId,
      status,
      axes,
      axesFailed,
      findings,
      overlap: computeOverlap(findings, OVERLAP_LINE_TOL),
      blockersTotal: findings.filter((f) => f.marker === "✗").length,
      parseDegraded,
    };
  }
}

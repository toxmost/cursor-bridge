import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager } from "../src/job-manager.ts";
import {
  AXIS_NAMES, AXIS_SETS, AXIS_SET_NAMES, MAX_ARTIFACT_BYTES, REVIEW_DEFAULTS, ReviewManager, WEIGHT_THRESHOLD_LINES,
  countLines, renderBrief, selectAxes,
} from "../src/review.ts";
import { NO_FINDINGS_TOKEN } from "../src/review-parser.ts";

test("countLines: детерминированная семантика границы", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);          // без завершающего \n
  assert.equal(countLines("a\n"), 1);        // с завершающим — та же 1
  assert.equal(countLines("a\nb\n"), 2);
  // порог 399/400/401 детерминирован именно через countLines (спека §3/§9)
  assert.equal(countLines("x\n".repeat(399)), 399);
  assert.equal(countLines("x\n".repeat(400)), 400);
  assert.equal(countLines("x\n".repeat(401)), 401);
});

test("selectAxes: 2 оси до порога, 3 от порога", () => {
  assert.deepEqual(selectAxes(WEIGHT_THRESHOLD_LINES - 1), ["broad", "strict"]);
  assert.deepEqual(selectAxes(WEIGHT_THRESHOLD_LINES), ["broad", "strict", "hygiene"]);
});

test("selectAxes: ручной состав побеждает вес; инвариант min-2 и enum", () => {
  assert.deepEqual(selectAxes(10, ["strict", "hygiene"]), ["strict", "hygiene"]);
  assert.throws(() => selectAxes(10, ["broad"]), /at least 2 axes/);
  assert.throws(() => selectAxes(10, ["broad", "bogus"]), /not in axis set/);
  // дубли НЕ обходят инвариант: Set-схлопывание ["broad","broad"] → 1 ось → отказ
  assert.throws(() => selectAxes(10, ["broad", "broad"]), /at least 2 axes/);
});

test("AXIS_SETS: реестр наборов — plan и code, оси не пересекаются", () => {
  assert.deepEqual(AXIS_SET_NAMES, ["plan", "code"]);
  assert.deepEqual(AXIS_SETS.plan, ["broad", "strict", "hygiene"]);
  assert.deepEqual(AXIS_SETS.code, ["correctness", "security", "tests"]);
});

test("selectAxes: set=code — всегда все 3 оси, вес не управляет", () => {
  assert.deepEqual(selectAxes(10, undefined, "code"), ["correctness", "security", "tests"]);
  assert.deepEqual(selectAxes(100_000, undefined, "code"), ["correctness", "security", "tests"]);
});

test("selectAxes: ручные оси чужого набора — отказ", () => {
  assert.throws(() => selectAxes(10, ["broad", "strict"], "code"), /not in axis set/);
  assert.throws(() => selectAxes(10, ["correctness", "tests"], "plan"), /not in axis set/);
});

test("selectAxes: ручной поднабор своего набора работает в code", () => {
  assert.deepEqual(selectAxes(10, ["correctness", "tests"], "code"), ["correctness", "tests"]);
});

test("renderBrief: слоты подставлены, обязательные элементы формата на месте", () => {
  for (const axis of AXIS_NAMES) {
    const b = renderBrief(axis, {
      artifacts: ["/tmp/spec.md", "/tmp/plan.md"],
      context: "ПРОЕКТ-МАРКЕР-XYZ",
      cyclesPassed: 0,
    });
    assert.ok(b.includes("/tmp/spec.md") && b.includes("/tmp/plan.md"));
    assert.ok(b.includes("ПРОЕКТ-МАРКЕР-XYZ"));
    assert.ok(b.includes(NO_FINDINGS_TOKEN));           // токен чистого прохода
    assert.ok(b.includes("файл:строка"));               // требование места
    assert.ok(b.includes("ЧЕГО Я НЕ НАШЁЛ"));           // секция покрытия
    assert.ok(b.includes("завершающем сообщении"));     // финал целиком
    assert.ok(!b.includes("ПЕРЕЖИЛО"));                 // cycles 0 → без отметки
    assert.ok(!b.includes("{"));                        // нет незаполненных слотов
  }
});

test("renderBrief: cyclesPassed > 0 включает отметку выжившего", () => {
  const b = renderBrief("strict", { artifacts: ["/a.md"], context: "c", cyclesPassed: 2 });
  // exact substitution pin: bare includes("2") was vacuously satisfied by
  // the template's own "Максимум 12 находок" (gate cycle 2, hygiene axis)
  assert.ok(b.includes("уже прошёл 2 цикл"));
  assert.ok(b.includes("ПЕРЕЖИЛО"));
});

test("REVIEW_DEFAULTS: значения спеки §5 дословно", () => {
  assert.deepEqual(REVIEW_DEFAULTS, { timeoutSec: 1800, firstTokenGraceSec: 900, idleTimeoutSec: 600 });
});

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-agent.mjs");
const spawnCfg = { bin: process.execPath, binArgs: [FAKE] };

function artifact(lines: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const p = path.join(dir, "artifact.md");
  writeFileSync(p, "строка\n".repeat(lines));
  return p;
}

// осознанный дубль mk() из job-manager.test.ts — держать конфиг в sync при изменениях там
// (включая idleTimeoutMs: 1_000 — оси ревью его переопределяют REVIEW_DEFAULTS, но
// не-ревью джобы этих тестов должны падать быстро, как в mk())
function mkReview(over: Record<string, unknown> = {}) {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "cbjobs-"));
  const jm = new JobManager({ jobsDir, spawnCfg, idleTimeoutMs: 1_000, ...over });
  return { jm, rm: new ReviewManager(jm) };
}

test("submit: артефакт больше потолка размера — fail fast", async () => {
  const { rm } = mkReview();
  const dir = mkdtempSync(path.join(tmpdir(), "cbart-"));
  const p = path.join(dir, "huge.md");
  writeFileSync(p, "x".repeat(MAX_ARTIFACT_BYTES + 1));
  await assert.rejects(
    rm.submit({ artifacts: [p], cwd: tmpdir(), context: "c" }),
    /artifact too large/,
  );
});

test("e2e: две оси [REVIEW] → completed, findings обеих, blockers, overlap", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(50)], cwd: tmpdir(), context: "[REVIEW] тестовый проект",
  });
  assert.equal(sub.axisCount, 2); // 50 строк < 400
  assert.equal(sub.weight, 50);
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.findings.length, 6);      // 3 находки × 2 оси
  assert.equal(r.blockersTotal, 4);        // 2 ✗ × 2 оси
  assert.equal(r.parseDegraded, false);
  // точный пин overlap (не .some — лишние/битые группы должны ронять):
  // пары cross-axis (10,10) и (100,100) → ровно 2 записи
  assert.deepEqual(r.overlap, [
    { file: "src/fake.ts", line: 10, axes: ["broad", "strict"] },
    { file: "src/fake.ts", line: 100, axes: ["broad", "strict"] },
  ]);
  // сырьё всегда, и оно содержательно (не пустая строка)
  for (const a of r.axes) assert.ok(a.resultText?.includes("Первая находка"));
  // идемпотентность result после терминала (спека §2.2)
  const r2 = await rm.result(sub.reviewId);
  assert.deepEqual(r2, r);
});

test("e2e: граница веса через реальные файлы — 399→2 оси, 400→3", async () => {
  const { rm } = mkReview();
  const s399 = await rm.submit({
    artifacts: [artifact(399)], cwd: tmpdir(), context: "[REVIEW-CLEAN] p",
  });
  assert.equal(s399.axisCount, 2);
  const s400 = await rm.submit({
    artifacts: [artifact(400)], cwd: tmpdir(), context: "[REVIEW-CLEAN] p",
  });
  assert.equal(s400.axisCount, 3);
});

test("e2e: порог 50% — [REVIEW-PARTIAL] (1 место из 4 маркеров) → parse_degraded", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW-PARTIAL] p",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");     // оси живы — degraded именно ПАРСИНГ
  assert.equal(r.parseDegraded, true);
  assert.equal(r.blockersTotal, 4);        // 2 ✗ × 2 оси — находки не теряются
});

test("e2e: ровно 50% мест — граница порога, НЕ degraded (пин строгого <)", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW-HALF] p",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.parseDegraded, false); // 2 < 4/2 ложно — спека §7: degraded только < 50%
});

test("e2e: находки из assistant-потока при result:\"\" доходят до парсера", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[EMPTY-RESULT] p",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.findings.length, 2);          // 1 находка × 2 оси
  assert.equal(r.findings[0]!.file, "src/leak.ts");
  assert.equal(r.parseDegraded, false);
});

test("e2e: смешанный парс осей — одна чистая, одна битая → parse_degraded (пин .some-агрегации)", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW-MIXED] p",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.parseDegraded, true); // битая ось не маскируется чистой соседкой
});

test("e2e: дубли artifacts схлопываются в весе", async () => {
  const { rm } = mkReview();
  const a = artifact(300);
  const sub = await rm.submit({
    artifacts: [a, a], cwd: tmpdir(), context: "[REVIEW-CLEAN] p",
  });
  assert.equal(sub.weight, 300);   // не 600
  assert.equal(sub.axisCount, 2);  // не 3
});

test("e2e: несуществующий артефакт — fail fast на submit", async () => {
  const { rm } = mkReview();
  await assert.rejects(
    rm.submit({ artifacts: ["/no/such/file.md"], cwd: tmpdir(), context: "c" }),
    /artifact not found/,
  );
});

test("e2e: чистый проход через токен — completed, 0 находок, не degraded", async () => {
  const { rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW-CLEAN] p",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.blockersTotal, 0);
  assert.equal(r.parseDegraded, false);
  assert.deepEqual(r.findings, []); // чистый проход = пустая таблица, не только 0 блокеров
});

test("e2e: осмысленный ответ без маркеров и токена → parse_degraded", async () => {
  const { rm } = mkReview();
  // дефолтный тег fake — [OK] → result_text «final answer»: 0 маркеров, нет токена
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "обычный контекст без тега",
  });
  const r = await rm.result(sub.reviewId, 10_000);
  assert.equal(r.status, "completed");
  assert.equal(r.parseDegraded, true);
});

test("e2e: отмена оси → degraded с находками живой", async () => {
  const { jm, rm } = mkReview({ maxConcurrent: 1 });
  // блокер занимает единственный слот ДО submit — обе оси гарантированно queued
  const blocker = await jm.submit({ prompt: "[HANG] blocker", cwd: tmpdir(), mode: "ask" });
  try {
    const sub = await rm.submit({
      artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW] p",
    });
    jm.cancel(sub.axes[1]!.jobId);   // queued → cancelled, БЕЗ гонки (слот занят блокером)
    jm.cancel(blocker.jobId);        // освободить слот → ось 0 стартует и завершается
    const r = await rm.result(sub.reviewId, 10_000);
    assert.equal(r.status, "degraded");
    assert.equal(r.axesFailed.length, 1);
    assert.equal(r.axesFailed[0]!.axis, sub.axes[1]!.axis);
    // cancelled axes carry a synthesized reason so axes_failed is self-explaining
    assert.equal(r.axesFailed[0]!.errorText, "cancelled");
    assert.equal(r.findings.length, 3);                // находки только живой оси
    // сырьё живой оси присутствует и содержательно (спека §2.2)
    const live = r.axes.find((a) => a.status === "completed");
    assert.ok(live?.resultText?.includes("Первая находка"));
  } finally {
    jm.cancel(blocker.jobId); // повторный cancel безопасен ({cancelled:false})
  }
});

test("e2e: отменены все оси → failed", async () => {
  const { jm, rm } = mkReview({ maxConcurrent: 1 });
  const blocker = await jm.submit({ prompt: "[HANG] blocker", cwd: tmpdir(), mode: "ask" });
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW] p",
  });
  try {
    for (const a of sub.axes) jm.cancel(a.jobId);      // обе queued → cancelled
    const r = await rm.result(sub.reviewId, 10_000);
    assert.equal(r.status, "failed");
  } finally {
    jm.cancel(blocker.jobId);                          // не бросать HANG-процесс при падении assert
  }
});

test("result: неизвестный review_id — ошибка", async () => {
  const { rm } = mkReview();
  await assert.rejects(rm.result("nope"), /unknown review_id/);
});

test("result без waitMs — мгновенный снимок working", async () => {
  const { jm, rm } = mkReview({ maxConcurrent: 1 });
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[HANG] p",
  });
  try {
    const r = await rm.result(sub.reviewId);
    assert.equal(r.status, "working");
  } finally {
    for (const a of sub.axes) jm.cancel(a.jobId);   // и при падении assert не бросать HANG
    await rm.result(sub.reviewId, 5_000);           // дождаться терминала
  }
});

test("renderBrief: оси code — слоты и обязательные элементы формата на месте", () => {
  for (const axis of AXIS_SETS.code) {
    const b = renderBrief(axis, {
      artifacts: ["/wt/apps/x.ts"], context: "МАРКЕР-CODE", cyclesPassed: 0,
    });
    assert.ok(b.includes("/wt/apps/x.ts") && b.includes("МАРКЕР-CODE"));
    assert.ok(b.includes(NO_FINDINGS_TOKEN));
    assert.ok(b.includes("файл:строка"));
    assert.ok(b.includes("ЧЕГО Я НЕ НАШЁЛ"));
    assert.ok(b.includes("завершающем сообщении"));
    assert.ok(!b.includes("{"));
  }
  // per-axis identity markers: each brief carries its own focus, not a copy
  const c = renderBrief("correctness", { artifacts: ["/a"], context: "c", cyclesPassed: 0 });
  const s = renderBrief("security", { artifacts: ["/a"], context: "c", cyclesPassed: 0 });
  const t = renderBrief("tests", { artifacts: ["/a"], context: "c", cyclesPassed: 0 });
  assert.ok(c.includes("Гонки") || c.includes("гонки"));
  assert.ok(s.includes("враждебн"));
  assert.ok(t.includes("зелёные на сломанном"));
});

test("e2e: axisSet=code — три оси с правильными именами и meta.axis_set", async () => {
  const { jm, rm } = mkReview();
  const sub = await rm.submit({
    artifacts: [artifact(10)], cwd: tmpdir(), context: "[REVIEW-CLEAN] p", axisSet: "code",
  });
  assert.equal(sub.axisCount, 3); // вес 10 < 400, но code = всегда 3
  assert.deepEqual(sub.axes.map((a) => a.axis).sort(), ["correctness", "security", "tests"]);
  assert.equal(sub.axisSet, "code");
  const withMeta = jm.list().filter((j) => (j.meta as Record<string, unknown> | null)?.axis_set === "code");
  assert.equal(withMeta.length, 3);
  const r = await rm.result(sub.reviewId, 10_000); // дождаться терминала — не бросать процессы
  assert.equal(r.status, "completed");
  assert.equal(r.axesFailed.length, 0); // [REVIEW-CLEAN]: все три оси должны дожить чисто
  assert.equal(r.parseDegraded, false);
});

test("e2e: create-chat падает для 2-й оси после успеха 1-й → submit отклоняется, живая ось отменена (не сиротеет)", async () => {
  const { jm, rm } = mkReview({ chatTimeoutMs: 500 });
  const failFile = path.join(mkdtempSync(path.join(tmpdir(), "cbfail-")), "create-chat-calls");
  process.env.FAKE_CREATE_FAIL_FILE = failFile;
  try {
    await assert.rejects(
      rm.submit({
        artifacts: [artifact(10)], cwd: tmpdir(), context: "[HANG] partial submit failure",
      }),
      // первая ось создала чат и стартовала [HANG]-работу; вторая — create-chat таймаут
      /create-chat produced no chat id/,
    );
    // ось первой оси (живая, queued→working на [HANG]) не должна остаться сиротой:
    // ReviewManager.submit обязан отменить её при частичном отказе.
    const deadline = Date.now() + 5_000;
    let job: ReturnType<typeof jm.list>[number] | undefined;
    for (;;) {
      const jobs = jm.list();
      assert.equal(jobs.length, 1); // вторая ось так и не была создана (create-chat не дошёл до jm.submit)
      job = jobs[0];
      if (job!.status === "cancelled" || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job!.status, "cancelled");
  } finally {
    delete process.env.FAKE_CREATE_FAIL_FILE;
    // safety net: on assert regression (submit resolving) axes must not leak [HANG] processes
    for (const j of jm.list()) jm.cancel(j.jobId);
  }
});

test("e2e: symlink на артефакт разыменовывается — дубль контента не удваивает вес", async () => {
  const { rm } = mkReview();
  const real = artifact(120);
  const link = path.join(path.dirname(real), "link.md");
  symlinkSync(real, link);
  const sub = await rm.submit({
    artifacts: [real, link], cwd: tmpdir(), context: "[REVIEW-CLEAN] p",
  });
  assert.equal(sub.weight, 120); // realpath схлопнул символьную ссылку с оригиналом
});

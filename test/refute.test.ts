import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, writeFile as fsWrite, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_FINDINGS, REFUTE_ROLES, RefuteManager, renderRefuteBrief } from "../src/refute.ts";

const finding = (id: string) => ({
  id, title: "деньги списаны, 1С без скидки", file: "src/pay.ts", line: 42,
  severity: "S1", claim: "spendBonus прошёл, updateOrders бросил — статусы разошлись",
});

function fakeJm() {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    calls,
    submit: async (p: Record<string, unknown>) => { calls.push(p); n += 1; return { jobId: `j${n}`, chatId: `c${n}` }; },
    cancel: (_id: string) => true,
  };
}

test("submit: ровно пара ролей, mode=ask, meta несёт refute_id/role/domain", async () => {
  const jm = fakeJm();
  const rm = new RefuteManager(jm as never);
  const r = await rm.submit({ findings: [finding("B-001")], cwd: "/tmp/repo", context: "ctx", domain: "orchestration" });
  assert.equal(r.roles.length, 2);
  assert.deepEqual(r.roles.map((x) => x.role).sort(), [...REFUTE_ROLES].sort());
  assert.equal(jm.calls.length, 2);
  for (const c of jm.calls) {
    assert.equal(c.mode, "ask");
    const meta = c.meta as Record<string, unknown>;
    assert.equal(meta.refute_id, r.refuteId);
    assert.equal(meta.domain, "orchestration");
  }
});

test("submit: cap findings 1..12 и уникальность id — отказ с внятной ошибкой", async () => {
  const rm = new RefuteManager(fakeJm() as never);
  await assert.rejects(() => rm.submit({ findings: [], cwd: "/t", context: "c" }), /at least 1/);
  const many = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding(`B-${i}`));
  await assert.rejects(() => rm.submit({ findings: many, cwd: "/t", context: "c" }), /12/);
  await assert.rejects(
    () => rm.submit({ findings: [finding("B-001"), finding("B-001")], cwd: "/t", context: "c" }),
    /duplicate/,
  );
});

test("брифы: у ролей РАЗНЫЕ задачи, оба требуют вердикт по каждому id", () => {
  const s = { findings: [finding("B-001"), finding("B-013")], context: "ctx" };
  const p = renderRefuteBrief("prosecutor", s);
  const a = renderRefuteBrief("advocate", s);
  assert.match(p, /прокурор/u);
  assert.match(a, /адвокат/u);
  assert.notEqual(p, a);
  for (const brief of [p, a]) {
    assert.match(brief, /B-001/);
    assert.match(brief, /B-013/);
    assert.match(brief, /КАЖДОМУ/u); // требование вердикта по каждому делу
    assert.match(brief, /CONFIRMED\|REFUTED\|UNCLEAR/);
  }
});

test("submit: частичный отказ create-chat -> cancel уже поднятых, reject", async () => {
  let n = 0;
  const cancelled: string[] = [];
  const jm = {
    submit: async () => {
      n += 1;
      if (n === 2) throw new Error("create-chat timeout");
      return { jobId: `j${n}`, chatId: `c${n}` };
    },
    cancel: (id: string) => { cancelled.push(id); return true; },
  };
  const rm = new RefuteManager(jm as never);
  await assert.rejects(() => rm.submit({ findings: [finding("B-001")], cwd: "/t", context: "c" }));
  assert.deepEqual(cancelled, ["j1"]);
});

// jm-мок: submit как в Task 4, result отдаёт заготовленные тексты по jobId
function fakeJmWithResults(byJob: Record<string, { status: string; resultText: string | null }>) {
  let n = 0;
  return {
    submit: async () => { n += 1; return { jobId: `j${n}`, chatId: `c${n}` }; },
    cancel: () => true,
    waitSettled: async () => undefined,
    result: async (id: string) => ({ errorText: null, ...byJob[id]! }),
  };
}

// Авто-закрытия возможны ТОЛЬКО в чистом git-репо с неизменным HEAD (пин cwd,
// спека §4) — фикстуры авто-закрытий обязаны быть репозиториями.
async function mkRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsWrite(path.join(dir, rel), content);
  }
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture", {
    cwd: dir, shell: "/bin/sh",
  });
  return dir;
}

test("result: REFUTED×2 с реальными цитатами в чистом репо -> auto refuted, cwd_pinned", async () => {
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок закрывает гонку";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.status, "completed");
  assert.equal(r.autoRefuted, 1);
  assert.equal(r.cwdPinned, true);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, true);
});

test("result: не-git cwd или сменившийся код -> would-be refuted уходит в escalate/cwd_changed", async () => {
  // не-git каталог: вердикт не привязан к версии кода — авто-закрытий нет (цикл 2, блокер №3)
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/pay.ts"), "await ledger.withLock(order.id, async () => spend())");
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, false);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.escalateReason, "cwd_changed");
});

test("result: не-git cwd, CONFIRMED×2 с валидными цитатами -> тоже escalate/cwd_changed, не тихий auto-confirm", async () => {
  // Тот же гейт обязан ловить CONFIRMED-сторону, а не только REFUTED: мутация
  // условия на c.consensus === "refuted" не должна проходить незамеченной.
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/pay.ts"), "await ledger.withLock(order.id, async () => spend())");
  const line = "B-001 — CONFIRMED — src/pay.ts:1 — «ledger.withLock(order.id, async» — уязвимо";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, false);
  assert.equal(r.autoConfirmed, 0);
  assert.equal(r.verdicts[0]!.consensus, "escalate");
  assert.equal(r.verdicts[0]!.escalateReason, "cwd_changed");
});

test("result: коммит внутри jm.result() (во время verify-цикла) -> ре-пин ПОСЛЕ чтений ловит его, cwd_pinned=false", async () => {
  // Дифференцирующий тест на порядок: если бы ре-пин переехал в начало result()
  // (до цикла jm.result()/verify-чтений), он увидел бы ещё старый HEAD и дал бы
  // cwd_pinned=true — коммит в этом моке происходит ВНУТРИ вызова jm.result(),
  // то есть строго до момента, когда правильная реализация берёт пин.
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок";
  let committed = false;
  let n = 0;
  const jm = {
    submit: async () => { n += 1; return { jobId: `j${n}`, chatId: `c${n}` }; },
    cancel: () => true,
    waitSettled: async () => undefined,
    result: async (_id: string) => {
      if (!committed) {
        committed = true;
        await fsWrite(path.join(dir, "src/other.ts"), "export const later = 1;");
        execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm later", { cwd: dir, shell: "/bin/sh" });
      }
      return { errorText: null, status: "completed", resultText: line };
    },
  };
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, false);
  assert.equal(r.autoRefuted, 0);
});

test("result: коммит между submit и result -> cwd_pinned=false", async () => {
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  await fsWrite(path.join(dir, "src/other.ts"), "export const later = 1;");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm later", { cwd: dir, shell: "/bin/sh" });
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, false);
  assert.equal(r.autoRefuted, 0);
});

test("result: отсутствующее обоснование (цитата — последнее поле) -> провал проверки", async () => {
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  // строка обрывается на цитате: split-хвост = «цитата» в кавычках; после снятия
  // кавычечных символов он равен самой цитате — рассуждения нет (цикл 3, блокер №4)
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async»";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
  // точка после эхо-цитаты и висящий разделитель не обходят гейт (циклы 4-5)
  for (const suffix of [".", " —"]) {
    const jm2 = fakeJmWithResults({
      j1: { status: "completed", resultText: line + suffix },
      j2: { status: "completed", resultText: line + suffix },
    });
    const rm2 = new RefuteManager(jm2 as never);
    const { refuteId: id2 } = await rm2.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
    const r2 = await rm2.result(id2);
    assert.equal(r2.autoRefuted, 0, `suffix ${JSON.stringify(suffix)}`);
    assert.equal(r2.verdicts[0]!.prosecutor!.quoteVerified, false);
  }
});

test("result: цитируемый ignored-файл (невидим пину) -> провал проверки", async () => {
  const dir = await mkRepo({
    ".gitignore": "src/generated.ts\n",
    "src/pay.ts": "export const ok = true;",
  });
  await fsWrite(path.join(dir, "src/generated.ts"), "await ledger.withLock(order.id, async () => spend())");
  // дерево чистое (файл ignored), но untracked-файл непинуем — цитата из него не принимается
  const line = "B-001 — REFUTED — src/generated.ts:1 — «ledger.withLock(order.id, async» — лок в генерате";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, true); // дерево формально чистое...
  assert.equal(r.autoRefuted, 0);  // ...но ignored-цитата не проходит
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
});

test("result: терминальный итог идемпотентен — коммит после первого чтения его не меняет", async () => {
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок закрывает гонку";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const first = await rm.result(refuteId);
  assert.equal(first.autoRefuted, 1);
  await fsWrite(path.join(dir, "src/later.ts"), "export const later = 1;");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm later", { cwd: dir, shell: "/bin/sh" });
  const second = await rm.result(refuteId);
  assert.deepEqual(second, first); // один refute_id — одна истина (цикл 3, минор №6)
});

test("result: незапиненный cwd снимает и confidence_lowered", async () => {
  // не-git каталог + упавший advocate: REFUTED✓ выжившего прокурора не должен
  // давать даже сигнала понижения — цитата не привязана к версии (цикл 3, минор №7)
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/pay.ts"), "await ledger.withLock(order.id, async () => spend())");
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок" },
    j2: { status: "failed", resultText: null },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.escalateReason, "degraded_role");
  assert.equal(r.verdicts[0]!.confidenceLowered, undefined);
});

test("result: duplicates обеих ролей отдаются наружу", async () => {
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const dup = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок\n" +
    "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — тот же лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: dup },
    j2: { status: "completed", resultText: "B-001 — CONFIRMED — src/pay.ts:1 — «ledger.withLock(order.id, async» — спорю" },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.deepEqual(r.duplicates, { prosecutor: ["B-001"], advocate: [] });
});

test("result: цитата не из файла -> quote_verified=false, escalate/citation_failed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/pay.ts"), "совсем другое содержимое файла");
  const line = "B-001 — REFUTED — src/pay.ts:1 — «выдуманный фрагмент кода» — казалось бы";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.escalateReason, "citation_failed");
});

test("result: файл вне cwd -> провал проверки (containment), не quote-мисматч", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  // Sibling tmpdir OUTSIDE cwd, holding a file whose content IS exactly the
  // quoted fragment — quoteMatches would succeed on content alone, so the only
  // thing that can fail here is the containment check itself (real prefix of
  // realCwd). Cited by absolute path, same as a model citing outside the tree.
  const outside = await mkdtemp(path.join(tmpdir(), "refute-outside-"));
  const quoted = "ledger.withLock(order.id, async () => spend())";
  await fsWrite(path.join(outside, "secret.ts"), quoted);
  const line = `B-001 — REFUTED — ${path.join(outside, "secret.ts")}:1 — «${quoted}» — лок`;
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
});

test("result: роль упала -> degraded, ноль авто-закрытий, одиночный REFUTED✓ = confidence_lowered", async () => {
  // git-репо: confidence_lowered существует только при запиненном cwd
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок" },
    j2: { status: "failed", resultText: null },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.status, "degraded");
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.escalateReason, "degraded_role");
  assert.equal(r.verdicts[0]!.confidenceLowered, true);
});

test("result: parse_degraded роли (>50% дел без вердикта) глушит авто-закрытия всей папки", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/pay.ts"), "await ledger.withLock(order.id, async () => spend())");
  // обе роли completed, но ответили только по 1 делу из 3 — их валидный REFUTED
  // по B-001 НЕ должен авто-закрыться (спека §8: ответ не принят целиком)
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({
    findings: [finding("B-001"), finding("B-002"), finding("B-003")], cwd: dir, context: "c",
  });
  const r = await rm.result(refuteId);
  assert.equal(r.parseDegraded, true);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts.find((v) => v.id === "B-001")!.escalateReason, "degraded_role");
});

test("result: цитируемый файл больше MAX_ARTIFACT_BYTES -> провал проверки, не OOM", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await fsWrite(path.join(dir, "src/big.ts"), "x".repeat(2_000_001));
  const line = "B-001 — REFUTED — src/big.ts:1 — «xxxxxxxxxxxxxxxx» — большой файл";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
});

test("result: finding id совпадает с ключом Object.prototype ('constructor') -> не бросает, escalate/missing_verdict", async () => {
  // Без Object.create(null) в parseRoleVerdicts, verdicts["constructor"] вернул бы
  // унаследованную Object.prototype.constructor вместо undefined, и verify()
  // упал бы на bare(v.reason) с reason===undefined — result() не долетал бы до
  // rec.final, и все последующие поллы падали бы тоже.
  const dir = await mkRepo({ "src/pay.ts": "export const ok = true;" });
  // Оба дела получают вердикт только по "B-002" — "constructor" остаётся без
  // строки вердикта (missing=1 из 2, ровно половина — не задевает parseDegraded).
  const line = "B-002 — CONFIRMED — src/pay.ts:1 — «export const ok = true» — норм";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({
    findings: [finding("constructor"), finding("B-002")], cwd: dir, context: "c",
  });
  const r = await rm.result(refuteId);
  const v = r.verdicts.find((x) => x.id === "constructor")!;
  assert.equal(v.consensus, "escalate");
  assert.equal(v.escalateReason, "missing_verdict");
});

test("result: unknown refute_id -> внятная ошибка", async () => {
  const rm = new RefuteManager(fakeJm() as never);
  await assert.rejects(() => rm.result("nope"), /unknown refute_id/);
});

// ---- Калибровка 2026-08-12: суффикс-резолв усечённых путей в #readCited ----

test("result: усечённый путь цитаты резолвится уникальным суффиксом по tracked -> честный вердикт, не citation_failed", async () => {
  // 8/9 эскалаций orchestration-пака: роли цитируют «/cancel/route.ts» вместо
  // apps/.../cancel/route.ts при точной цитате-строке — согласие ролей терялось
  const dir = await mkRepo({
    "apps/medusa/src/api/admin/orders/cancel/route.ts":
      "await ledger.withLock(order.id, async () => spend())",
  });
  const line = "B-001 — REFUTED — /cancel/route.ts:1 — «ledger.withLock(order.id, async» — лок закрывает гонку";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, true);
  assert.equal(r.autoRefuted, 1);
});

test("result: НЕОДНОЗНАЧНЫЙ суффикс (2 tracked-омонима) -> провал цитаты, escalate/citation_failed", async () => {
  const body = "await ledger.withLock(order.id, async () => spend())";
  const dir = await mkRepo({
    "apps/a/cancel/route.ts": body,
    "apps/b/cancel/route.ts": body,
  });
  const line = "B-001 — REFUTED — /cancel/route.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
  assert.equal(r.verdicts[0]!.escalateReason, "citation_failed");
});

test("result: суффикс-фолбэк требует git — в не-git cwd усечённый путь НЕ резолвится", async () => {
  // без gitTracked-списка суффикс не к чему прикалывать; и пин всё равно false
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "apps/x/cancel"), { recursive: true });
  await fsWrite(
    path.join(dir, "apps/x/cancel/route.ts"),
    "await ledger.withLock(order.id, async () => spend())",
  );
  const line = "B-001 — REFUTED — /cancel/route.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
  assert.equal(r.autoRefuted, 0);
});

// ---- Калибровка 2026-08-12: правило owner-маркера (решение владельца) ----

test("брифы: ОБЕ роли несут правило owner-маркера (пин ФОРМУЛИРОВКИ брифа; машинного гейта нет — решение владельца)", () => {
  // источник: оба false-refute калибровки (класс «comment-as-decision»):
  // роли приняли голый code-comment («Осознанный fail-open») за ратифицированное решение.
  // Гейт промпт-уровневый: детерминированной машинной проверки «цитата содержит
  // owner-маркер» здесь нет намеренно — семантика маркера не регэкспится надёжно
  const s = { findings: [finding("B-001")], context: "ctx" };
  for (const role of REFUTE_ROLES) {
    const brief = renderRefuteBrief(role, s);
    assert.match(brief, /owner-маркер/u);
    // состав маркера: дата решения / ISSUE / ADR / пинующий тест
    assert.match(brief, /дат/iu);
    assert.match(brief, /ISSUE/u);
    assert.match(brief, /ADR/u);
    assert.match(brief, /пину[юе]щ/iu);
    // голый комментарий в коде — НЕ решение: вердикт обязан уйти в UNCLEAR
    assert.match(brief, /комментари[йяи][^\n]*не[^\n]*(решени|маркер)|не[^\n]*решени[^\n]*комментари/iu);
  }
});

test("result: cwd стал git-репо МЕЖДУ submit и result -> суффикс-фолбэк всё равно выключен (привязан к пину submit)", async () => {
  // дифференциальный пин: фолбэк читает tracked-список по СОСТОЯНИЮ НА SUBMIT
  // (pin.isGit), а не по текущему — иначе цитата верифицируется по непину
  const dir = await mkdtemp(path.join(tmpdir(), "refute-"));
  await mkdir(path.join(dir, "apps/x/cancel"), { recursive: true });
  await fsWrite(
    path.join(dir, "apps/x/cancel/route.ts"),
    "await ledger.withLock(order.id, async () => spend())",
  );
  const line = "B-001 — REFUTED — /cancel/route.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm late", {
    cwd: dir, shell: "/bin/sh",
  });
  const r = await rm.result(refuteId);
  assert.equal(r.verdicts[0]!.prosecutor!.quoteVerified, false);
  assert.equal(r.autoRefuted, 0);
});

test("result: dirty worktree (незакоммиченная правка, HEAD тот же) -> cwd_pinned=false, escalate/cwd_changed", async () => {
  // финальное ревью ветки (tests-ось): смена HEAD запинована, а dirty — нет;
  // регрессия !pin.dirty/!now.dirty оставалась бы зелёной на HEAD-тестах
  const dir = await mkRepo({ "src/pay.ts": "await ledger.withLock(order.id, async () => spend())" });
  const line = "B-001 — REFUTED — src/pay.ts:1 — «ledger.withLock(order.id, async» — лок";
  const jm = fakeJmWithResults({
    j1: { status: "completed", resultText: line },
    j2: { status: "completed", resultText: line },
  });
  const rm = new RefuteManager(jm as never);
  const { refuteId } = await rm.submit({ findings: [finding("B-001")], cwd: dir, context: "c" });
  await fsWrite(path.join(dir, "src/pay.ts"), "await ledger.withLock(order.id, async () => spend()) // изменено");
  const r = await rm.result(refuteId);
  assert.equal(r.cwdPinned, false);
  assert.equal(r.autoRefuted, 0);
  assert.equal(r.verdicts[0]!.escalateReason, "cwd_changed");
});

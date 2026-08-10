import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_FINDINGS_TOKEN, computeOverlap, parseAxis } from "../src/review-parser.ts";

// Эталонные строки — ДОСЛОВНО формы реального вывода Composer 2026-07-19:
// маркер в col0, маркер после "- " + **жирность**, маркер после "### ".
const REAL_SHAPES = [
  "✗ **Правило A ломает временную привязку** — docs/specs/design.md:133 — сценарий — гейты не ловят",
  "- ✗ **estimatorFault по confidence** — docs/plans/plan.md:1138 — сценарий — гейт",
  "### ⚠ Заголовочная форма — src/kalman.ts:100-120 — ошибка — фикс",
  "⚠ Параграфная форма — docs/x.md:§7:148 — ошибка — фикс", // реальная форма строгой оси
  "ℹ Нит без места — просто наблюдение без файла",
].join("\n");

test("parseAxis: реальные формы 2026-07-19 разбираются", () => {
  const p = parseAxis("strict", REAL_SHAPES);
  assert.equal(p.markerLines, 5);
  assert.equal(p.parsedLines, 4); // четыре с местом, нит без места
  assert.equal(p.findings.length, 5); // нит тоже находка, file: null
  const [a, b, c, e, d] = p.findings;
  assert.deepEqual([e.marker, e.file, e.line], ["⚠", "docs/x.md", 148]); // :§7: пропущен
  assert.deepEqual(
    [a.marker, a.file, a.line, a.lineEnd],
    ["✗", "docs/specs/design.md", 133, null],
  );
  assert.equal(a.title, "Правило A ломает временную привязку"); // ** снята, обрез по « — »
  assert.deepEqual([b.marker, b.file, b.line], ["✗", "docs/plans/plan.md", 1138]);
  assert.deepEqual([c.marker, c.file, c.line, c.lineEnd], ["⚠", "src/kalman.ts", 100, 120]);
  assert.deepEqual([d.marker, d.file, d.line], ["ℹ", null, null]);
  assert.equal(d.title, "Нит без места");
  assert.equal(p.cleanToken, false);
});

test("parseAxis: decoy host:port и версии не дают ложного file", () => {
  const p = parseAxis("broad", "✗ Порт API — config:8080 — упадёт — не ловят");
  assert.equal(p.findings.length, 1);
  assert.equal(p.findings[0]!.file, null); // "config" — без "/" и без .расширения
  assert.equal(p.parsedLines, 0);
});

test("parseAxis: §-ссылка БЕЗ номера строки не матчится как file", () => {
  const p = parseAxis("strict", "✗ Секция — spec.md:§7 — ошибка — фикс");
  assert.equal(p.findings[0]!.file, null); // после §7 нет :\\d+ — места нет
});

test("parseAxis: чистый проход через токен", () => {
  const p = parseAxis("broad", `${NO_FINDINGS_TOKEN}\n\n## ЧЕГО Я НЕ НАШЁЛ\n- всё крепко`);
  assert.equal(p.markerLines, 0);
  assert.equal(p.cleanToken, true);
});

test("parseAxis: цитата токена в прозе — НЕ чистый проход", () => {
  // real failure shape: the model quotes the brief's legend ("...напиши НАХОДОК НЕТ")
  // without actually declaring a clean pass — substring match faked cleanToken=true
  const p = parseAxis("broad", `Бриф требует: если находок нет, написать «${NO_FINDINGS_TOKEN}». Но у меня формат сломался.`);
  assert.equal(p.markerLines, 0);
  assert.equal(p.cleanToken, false);
});

test("parseAxis: токен отдельной строкой с отступом и хвостовыми пробелами — чистый проход", () => {
  const p = parseAxis("broad", `Преамбула.\n  ${NO_FINDINGS_TOKEN}  \n## ЧЕГО Я НЕ НАШЁЛ`);
  assert.equal(p.cleanToken, true);
});

test("parseAxis: токен с хвостовой пунктуацией (НАХОДОК НЕТ.) — чистый проход", () => {
  // models add a period; a false parse_degraded on a genuinely clean pass
  // burns the caller's trust in the machine criterion (gate cycle 2)
  const p = parseAxis("broad", `${NO_FINDINGS_TOKEN}.\n\n## ЧЕГО Я НЕ НАШЁЛ`);
  assert.equal(p.cleanToken, true);
});

test("parseAxis: токен с продолжением прозы на той же строке — НЕ чистый проход", () => {
  const p = parseAxis("broad", `${NO_FINDINGS_TOKEN}, но есть сомнения по src/x.ts`);
  assert.equal(p.cleanToken, false);
});

test("parseAxis: осмысленный текст без маркеров и без токена — 0 маркер-строк, cleanToken false", () => {
  const p = parseAxis("broad", "Длинный ответ по существу, но формат нарушен полностью.");
  assert.equal(p.markerLines, 0);
  assert.equal(p.cleanToken, false); // Task 4 превратит это в parse_degraded
});

test("parseAxis: домен в заголовке не перебивает каноничный слот файла", () => {
  // pathLike("api.example.com") is true (dot-suffix) — the canonical second
  // " — " field must win over an earlier path-like decoy in the title
  const p = parseAxis("strict", "✗ Регрессия на api.example.com:8080 — src/real.ts:10 — сценарий — гейт");
  assert.equal(p.findings[0]!.file, "src/real.ts");
  assert.equal(p.findings[0]!.line, 10);
});

test("parseAxis: место только в заголовке — fallback на всю строку", () => {
  const p = parseAxis("strict", "✗ Баг в src/foo.ts:10 — сценарий без места");
  assert.equal(p.findings[0]!.file, "src/foo.ts");
  assert.equal(p.findings[0]!.line, 10);
});

test("parseAxis: нумерованные находки — префиксы «1.» и «2)»", () => {
  const p = parseAxis("strict", [
    "1. ✗ **Первая** — src/a.ts:5 — сценарий — гейт",
    "2) ⚠ Вторая — src/b.ts:10 — сценарий — гейт",
  ].join("\n"));
  assert.equal(p.markerLines, 2);
  assert.equal(p.findings[0]!.marker, "✗");
  assert.equal(p.findings[0]!.title, "Первая");
  assert.equal(p.findings[1]!.file, "src/b.ts");
});

test("parseAxis: нумерованный список без маркера — не находка", () => {
  const p = parseAxis("strict", "1. просто пункт плана\n2. ещё пункт");
  assert.equal(p.markerLines, 0);
});

test("computeOverlap: близкие строки разных осей матчатся, свои не матчатся", () => {
  const f = (axis: string, file: string | null, line: number | null) =>
    ({ axis, marker: "✗" as const, file, line, lineEnd: null, title: "t" });
  const overlap = computeOverlap(
    [f("broad", "plan.md", 1740), f("strict", "plan.md", 1748), f("strict", "plan.md", 1749),
     f("broad", "other.md", 5), f("strict", "another.md", 5), f("broad", null, null)],
    10,
  );
  assert.equal(overlap.length, 1);
  assert.deepEqual(overlap[0], { file: "plan.md", line: 1740, axes: ["broad", "strict"] });
});

test("computeOverlap: за пределами tolerance — не матч", () => {
  const f = (axis: string, line: number) =>
    ({ axis, marker: "⚠" as const, file: "a.md", line, lineEnd: null, title: "t" });
  assert.equal(computeOverlap([f("broad", 100), f("strict", 111)], 10).length, 0);
});

test("computeOverlap: absolute↔relative формы одного файла матчатся суффиксом", () => {
  // proven by the first real run: artifacts are absolute, axes cite src/review.ts:145
  const f = (axis: string, file: string, line: number) =>
    ({ axis, marker: "✗" as const, file, line, lineEnd: null, title: "t" });
  const o = computeOverlap(
    [f("broad", "/Users/u/.claude/mcp/cursor-bridge/src/review.ts", 145), f("strict", "src/review.ts", 150)],
    10,
  );
  assert.deepEqual(o, [{ file: "src/review.ts", line: 145, axes: ["broad", "strict"] }]);
});

test("computeOverlap: одинаковый basename в разных директориях — не матч", () => {
  const f = (axis: string, file: string, line: number) =>
    ({ axis, marker: "✗" as const, file, line, lineEnd: null, title: "t" });
  assert.equal(computeOverlap([f("broad", "a/utils.ts", 5), f("strict", "b/utils.ts", 5)], 10).length, 0);
});

test("computeOverlap: без транзитивного сцепления — 0/10/20 не сливаются в одну группу", () => {
  const f = (axis: string, line: number) =>
    ({ axis, marker: "✗" as const, file: "a.md", line, lineEnd: null, title: "t" });
  const o = computeOverlap([f("broad", 0), f("strict", 10), f("hygiene", 20)], 10);
  assert.deepEqual(o, [
    { file: "a.md", line: 0, axes: ["broad", "strict"] },
    { file: "a.md", line: 10, axes: ["hygiene", "strict"] },
  ]);
});

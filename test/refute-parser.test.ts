import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoleVerdicts, computeConsensus, type RoleVerdict } from "../src/refute-parser.ts";

const IDS = ["B-001", "B-013", "B-035"] as const;

test("parseRoleVerdicts: три ключевых слова, цитата, file:line", () => {
  const text = [
    "B-001 — CONFIRMED — src/pay.ts:42 — «await spendBonus(order)» — цепочка доведена до поломки",
    "- B-013 — REFUTED — src/sync.ts:10 — «withLock(async () =>» — dedup держится на локе",
    "**B-035** — UNCLEAR — не смог проследить источник display_id",
  ].join("\n");
  const p = parseRoleVerdicts(text, IDS);
  assert.equal(p.missing.length, 0);
  assert.equal(p.verdicts["B-001"]!.verdict, "CONFIRMED");
  assert.equal(p.verdicts["B-001"]!.file, "src/pay.ts");
  assert.equal(p.verdicts["B-001"]!.line, 42);
  assert.equal(p.verdicts["B-001"]!.quote, "await spendBonus(order)");
  assert.equal(p.verdicts["B-013"]!.verdict, "REFUTED");
  assert.equal(p.verdicts["B-035"]!.verdict, "UNCLEAR");
  assert.equal(p.verdicts["B-035"]!.quote, null); // UNCLEAR без цитаты — норма
  assert.equal(p.verdicts["B-001"]!.quoteVerified, null); // проверка цитат — не дело парсера
});

test("parseRoleVerdicts: id совпадает с ключом Object.prototype -> честный missing, не унаследованная функция", () => {
  // "constructor" без строки вердикта в тексте: verdicts["constructor"] на {}-литерале
  // вернул бы унаследованную Object.prototype.constructor вместо undefined —
  // missing-подсчёт (и всё, что от него зависит выше по цепочке) солгал бы.
  const p = parseRoleVerdicts("B-001 — CONFIRMED — src/a.ts:1 — «x = compute(y) + 1» — ok", ["B-001", "constructor"]);
  assert.deepEqual(p.missing, ["constructor"]);
  assert.equal(p.verdicts["constructor"], undefined);
});

test("parseRoleVerdicts: пропущенный id -> missing; >50% -> parseDegraded", () => {
  const one = parseRoleVerdicts("B-001 — CONFIRMED — src/a.ts:1 — «x = compute(y) + 1» — ok", IDS);
  assert.deepEqual(one.missing.sort(), ["B-013", "B-035"]);
  assert.equal(one.parseDegraded, true); // 2 из 3 пропущено
  const two = parseRoleVerdicts(
    "B-001 — CONFIRMED — src/a.ts:1 — «x» — ok\nB-013 — UNCLEAR — причина",
    IDS,
  );
  assert.equal(two.parseDegraded, false); // 1 из 3 — не больше половины
});

test("parseRoleVerdicts: повтор id с ТЕМ ЖЕ вердиктом — первая строка побеждает, повтор во флаге", () => {
  const p = parseRoleVerdicts(
    "B-001 — CONFIRMED — src/a.ts:1 — «первая цитата тут» — да\nB-001 — CONFIRMED — src/a.ts:2 — «вторая» — да",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "CONFIRMED");
  assert.equal(p.verdicts["B-001"]!.line, 1);
  assert.deepEqual(p.duplicates, ["B-001"]);
});

test("parseRoleVerdicts: повтор id с ДРУГИМ вердиктом (самопоправка) -> принудительный UNCLEAR", () => {
  const p = parseRoleVerdicts(
    "B-001 — REFUTED — src/a.ts:1 — «валидная длинная цитата» — лок\nB-001 — UNCLEAR — на самом деле не уверен",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "UNCLEAR"); // конфликт не даёт тихого закрытия
  assert.match(p.verdicts["B-001"]!.reason, /conflicting/);
  assert.deepEqual(p.duplicates, ["B-001"]);
});

test("parseRoleVerdicts: id-префиксы не путаются — цифры (B-1 vs B-10) и дефисные (AUTH vs AUTH-BYPASS)", () => {
  const p = parseRoleVerdicts("B-10 — CONFIRMED — src/a.ts:5 — «фрагмент кода х» — ок", ["B-1", "B-10"]);
  assert.equal(p.verdicts["B-10"]!.verdict, "CONFIRMED");
  assert.equal(p.verdicts["B-1"], undefined);
  // дефис — валидный разделитель, поэтому короткий id матчится на длинном;
  // побеждать обязан ДЛИННЕЙШИЙ совпавший id
  const q = parseRoleVerdicts("AUTH-BYPASS — REFUTED — src/g.ts:2 — «guard(req.user, scope)» — гейт", ["AUTH", "AUTH-BYPASS"]);
  assert.equal(q.verdicts["AUTH-BYPASS"]!.verdict, "REFUTED");
  assert.equal(q.verdicts["AUTH"], undefined);
});

test("parseRoleVerdicts: markdown-обёртки — табличный | срезается, цитата в backticks принимается", () => {
  const p = parseRoleVerdicts(
    "| B-001 — REFUTED — src/a.ts:3 — `withLock(order.id, fn)` — лок есть",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "REFUTED");
  assert.equal(p.verdicts["B-001"]!.quote, "withLock(order.id, fn)");
});

test("parseRoleVerdicts: НЕСКОЛЬКО разных вердикт-слов в одной строке -> принудительный UNCLEAR", () => {
  // первое слово не должно побеждать явное сомнение в хвосте (цикл 2, блокер №1)
  const p = parseRoleVerdicts(
    "B-001 — сначала REFUTED — src/a.ts:10 — «withLock(order.id)» — но итог UNCLEAR",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "UNCLEAR");
  assert.match(p.verdicts["B-001"]!.reason, /conflicting/);
});

test("parseRoleVerdicts: exponentiation в цитате переживает зачистку жирности", () => {
  // цитата берётся из СЫРОГО хвоста — replaceAll('**','') не должен калечить код (цикл 2, минор №6)
  const p = parseRoleVerdicts(
    "**B-001** — CONFIRMED — src/m.ts:7 — «const risk = score ** 2;» — рост квадратичный",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "CONFIRMED");
  assert.equal(p.verdicts["B-001"]!.quote, "const risk = score ** 2;");
});

test("parseRoleVerdicts: ранняя кавычка ДО вердикт-слова не подменяет цитатный слот", () => {
  // цитата обязана стоять после вердикта; ранний «фрагмент» в заголовочной зоне
  // не должен становиться citation (цикл 3, блокер №3)
  const p = parseRoleVerdicts(
    "B-001 — проверил «withLock(order.id)» — REFUTED — src/pay.ts:1 — лок защищает",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "REFUTED");
  assert.equal(p.verdicts["B-001"]!.quote, null); // слота после вердикта нет -> цитаты нет
});

test("parseRoleVerdicts: вердиктный токен ВНУТРИ цитаты кода — не конфликт", () => {
  // `UNCLEAR` в цитируемом коде не является сомнением модели (цикл 3, минор №5)
  const p = parseRoleVerdicts(
    "B-001 — REFUTED — src/p.ts:2 — «if (verdict === UNCLEAR) throw» — код сам отбрасывает",
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.verdict, "REFUTED");
});

test("parseRoleVerdicts: строковый литерал с \" внутри «» не режет цитату", () => {
  // пары кавычек матчатся по типу (цикл 4, блокер №1)
  const p = parseRoleVerdicts(
    'B-001 — REFUTED — src/g.ts:4 — «if (mode === "safe") return» — гейт закрывает',
    ["B-001"],
  );
  assert.equal(p.verdicts["B-001"]!.quote, 'if (mode === "safe") return');
});

test("parseRoleVerdicts: голый UNCLEAR без причины — не вердикт, уходит в missing", () => {
  // роль обязана объяснить сомнение; спам голыми UNCLEAR деградирует роль (цикл 4, минор №5)
  // «причина» без единого буквенно-цифрового символа (висящее тире) — тоже не причина (цикл 6)
  for (const line of ["B-001 — UNCLEAR", "B-001 — UNCLEAR —", "B-001 — UNCLEAR — ..."]) {
    const p = parseRoleVerdicts(line, ["B-001"]);
    assert.deepEqual(p.missing, ["B-001"], line);
    assert.equal(p.parseDegraded, true);
  }
});

test("parseRoleVerdicts: строки без вердикт-слова и чужие id игнорируются", () => {
  const p = parseRoleVerdicts("Вступление о папке дел\nX-9 — CONFIRMED — a.ts:1 — «q» — ok", ["B-001"]);
  assert.deepEqual(p.missing, ["B-001"]);
});

test("quoteMatches: терпимость к пробелам/переносам в окне вокруг строки", async () => {
  const { quoteMatches } = await import("../src/refute-parser.ts");
  const file = "async function spend(order) {\n  await ledger.debit( order.id,  amount );\n}";
  assert.equal(quoteMatches("await ledger.debit(order.id, amount);", file, 2), false); // пунктуация не совпала
  assert.equal(quoteMatches("await ledger.debit( order.id, amount )", file, 2), true); // пробелы схлопнуты
});

test("quoteMatches: короче MIN_QUOTE_CHARS — отказ (защита от цитаты-огрызка)", async () => {
  const { MIN_QUOTE_CHARS, quoteMatches } = await import("../src/refute-parser.ts");
  assert.equal(MIN_QUOTE_CHARS, 12);
  assert.equal(quoteMatches("await x", "await x + y", 1), false);
});

test("quoteMatches: несодержательная цитата (мало идентификаторных символов) — отказ", async () => {
  const { quoteMatches } = await import("../src/refute-parser.ts");
  // забор из комментария проходит по длине, но ничего не доказывает (цикл 2, блокер №2)
  assert.equal(quoteMatches("////////////", "// ////////////\ncode();", 1), false);
  assert.equal(quoteMatches("============", "// ============\ncode();", 1), false);
  assert.equal(quoteMatches("ab + cd - ef", "const r = ab + cd - ef;", 1), false); // 6 word-символов < 8
  assert.equal(quoteMatches("alpha + betaGamma", "const r = alpha + betaGamma;", 1), true); // 14 ≥ 8
});

test("quoteMatches: цитаты нет в файле — false", async () => {
  const { quoteMatches } = await import("../src/refute-parser.ts");
  assert.equal(quoteMatches("const missing = fragment", "совсем другой текст файла", 1), false);
});

test("quoteMatches: ПРИВЯЗКА К СТРОКЕ — фрагмент из другого конца файла не проходит", async () => {
  const { QUOTE_LINE_TOL, quoteMatches } = await import("../src/refute-parser.ts");
  // «return result;» существует в файле, но на строке 60 при заявленной 1 —
  // вхождение «где-то в файле» ничего не доказывает (кросс-ревью, блокер №1)
  const far = ["const top = 1;", ...Array.from({ length: 50 }, () => "// filler"), "function f() {", "  return dbl(result);", "}"].join("\n");
  assert.equal(quoteMatches("return dbl(result);", far, 1), false); // строка 53 вне окна ±20 от 1
  assert.equal(quoteMatches("return dbl(result);", far, 50), true); // в окне — проходит
  assert.equal(QUOTE_LINE_TOL, 20);
});

test("quoteMatches: null-строка (вердикт без номера) — отказ", async () => {
  const { quoteMatches } = await import("../src/refute-parser.ts");
  assert.equal(quoteMatches("const top = 1; // достаточно длин", "const top = 1; // достаточно длин", null), false);
});

test("quoteMatches: строка 0 — не координата, отказ (цикл 4, минор №4)", async () => {
  const { quoteMatches } = await import("../src/refute-parser.ts");
  assert.equal(quoteMatches("const top = someValue1;", "const top = someValue1;", 0), false);
});

const v = (verdict: RoleVerdict["verdict"], quoteVerified: boolean | null): RoleVerdict => ({
  verdict, file: "src/a.ts", line: 1, quote: "достаточно длинная цитата", reason: "r", quoteVerified,
});

const OK = { p: false, a: false };

test("консенсус: CONFIRMED✓ × CONFIRMED✓ -> confirmed", () => {
  assert.deepEqual(computeConsensus(v("CONFIRMED", true), v("CONFIRMED", true), OK),
    { consensus: "confirmed" });
});

test("консенсус: REFUTED✓ × REFUTED✓ -> refuted (авто-закрытие)", () => {
  assert.deepEqual(computeConsensus(v("REFUTED", true), v("REFUTED", true), OK),
    { consensus: "refuted" });
});

test("консенсус: спор CONFIRMED✓ × REFUTED✓ -> escalate/disagreement (обе стороны)", () => {
  assert.equal(computeConsensus(v("CONFIRMED", true), v("REFUTED", true), OK).escalateReason, "disagreement");
  assert.equal(computeConsensus(v("REFUTED", true), v("CONFIRMED", true), OK).escalateReason, "disagreement");
});

test("консенсус: UNCLEAR у любого -> escalate/unclear", () => {
  const u: RoleVerdict = { verdict: "UNCLEAR", file: null, line: null, quote: null, reason: "не смог", quoteVerified: null };
  assert.equal(computeConsensus(u, v("REFUTED", true), OK).escalateReason, "unclear");
});

test("консенсус: цитата не прошла проверку -> понижение до needs-repro, escalate/citation_failed", () => {
  // REFUTED×2, но одна цитата не сошлась с кодом — авто-закрытия НЕТ
  const r = computeConsensus(v("REFUTED", true), v("REFUTED", false), OK);
  assert.deepEqual(r, { consensus: "escalate", escalateReason: "citation_failed" });
});

test("консенсус: вердикт отсутствует -> escalate/missing_verdict", () => {
  assert.equal(computeConsensus(null, v("REFUTED", true), OK).escalateReason, "missing_verdict");
});

test("консенсус: деградация роли глушит авто-закрытие; одиночный REFUTED✓ выжившей роли -> confidence_lowered", () => {
  const r = computeConsensus(v("REFUTED", true), null, { p: false, a: true });
  assert.deepEqual(r, { consensus: "escalate", escalateReason: "degraded_role", confidenceLowered: true });
  // одиночный CONFIRMED уверенность не понижает
  assert.equal(computeConsensus(v("CONFIRMED", true), null, { p: false, a: true }).confidenceLowered, undefined);
});

test("консенсус: REFUTED от САМОЙ деградированной роли уверенность НЕ понижает", () => {
  // prosecutor деградировал (разобрал 2 из 12), но в свои 2 бросил REFUTED;
  // advocate полноценен и говорит CONFIRMED — доверять негодной роли нельзя (цикл 2, минор №4)
  const r = computeConsensus(v("REFUTED", true), v("CONFIRMED", true), { p: true, a: false });
  assert.deepEqual(r, { consensus: "escalate", escalateReason: "degraded_role" });
  // а полноценный REFUTED✓ на фоне деградировавшего партнёра — понижает
  const r2 = computeConsensus(v("CONFIRMED", true), v("REFUTED", true), { p: true, a: false });
  assert.equal(r2.confidenceLowered, true);
});

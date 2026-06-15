// Offline determinism test for the fetchExchangeChunked page-starvation backfill.
// Requires the REAL functions from server.js (no port bound, no Trade2 calls —
// server.listen is guarded behind require.main) and stubs the network via
// __setExchangeRawImpl, so this exercises the actual shipping code, not a copy.
//
// Simulated failure: a high-liquidity "whale" currency in a 3-wide chunk fills
// the single capped response page, so its chunk-mates come back with zero offers
// (real page starvation). The backfill must re-fetch each starved item alone and
// recover it, without re-fetching the already-covered whale or wasting calls when
// nothing is starved.
const { fetchExchangeChunked, collectExchangeOffers, bestExchangeOffer, sanitizeLeague, buildExchangeCatalog, __setExchangeRawImpl } = require("./server.js");

const EXALTED_ID = "exalted";
const WHALE = "divine";
let rawCalls = [];
let gid = 0; // globally-unique listing ids (real exchange ids never collide across pages)

__setExchangeRawImpl(async (league, haveIds, wantIds) => {
  const have = Array.isArray(haveIds) ? haveIds : [haveIds];
  const want = Array.isArray(wantIds) ? wantIds : [wantIds];
  rawCalls.push({ have: [...have], want: [...want] });
  const result = {};
  const multi = have.length >= want.length ? have : want;
  const whaleCrowds = multi.length > 1 && multi.includes(WHALE);
  for (const h of have) for (const w of want) {
    if (h === w) continue;
    const item = multi === have ? h : w;
    if (whaleCrowds && item !== WHALE) continue; // starved by the whale's page
    result["L" + (gid++)] = { exchange: { currency: h, amount: 1 }, item: { currency: w, amount: 2 } };
  }
  return { result };
});

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

  // want = [divine(whale), regal, vaal, chaos, alch] vs have=[exalted].
  // First chunk [divine,regal,vaal] starves regal+vaal; backfill must recover them.
  const want = ["divine", "regal", "vaal", "chaos", "alch"];
  rawCalls = [];
  const out = await fetchExchangeChunked("L", EXALTED_ID, want);
  for (const w of want) ok(collectExchangeOffers(out, EXALTED_ID, w).length > 0, "covered after backfill: " + w);
  const solo = rawCalls.filter((c) => c.want.length === 1).map((c) => c.want[0]);
  ok(solo.includes("regal") && solo.includes("vaal"), "backfill re-fetched the starved items (" + solo.join(",") + ")");
  ok(!solo.includes("divine"), "whale (divine) was NOT re-fetched (already covered)");

  // Control: no whale -> the batched pass covers everything, backfill adds nothing.
  rawCalls = [];
  const want2 = ["regal", "vaal", "chaos", "alch"];
  const out2 = await fetchExchangeChunked("L", EXALTED_ID, want2);
  ok(want2.every((w) => collectExchangeOffers(out2, EXALTED_ID, w).length > 0), "no-whale: all covered by batched pass");
  ok(rawCalls.length === 2, "no-whale: no extra backfill calls beyond the 2 batched chunks (no waste)");

  // sanitizeLeague: a proxy that appended its origin onto the league must not
  // reach the upstream API (this caused the live HTTP 400 "Invalid query").
  ok(sanitizeLeague("Runes of Aldurhttp://docker:8098") === "Runes of Aldur", "sanitizeLeague strips an appended proxy origin");
  ok(sanitizeLeague("Runes of Aldur") === "Runes of Aldur", "sanitizeLeague leaves a clean league untouched");
  ok(sanitizeLeague("") === "Runes of Aldur" && sanitizeLeague(null) === "Runes of Aldur", "sanitizeLeague falls back to default on empty");
  ok(sanitizeLeague("  Hardcore  ") === "Hardcore", "sanitizeLeague trims/collapses whitespace");

  // buildExchangeCatalog: walks the grouped static structure into a
  // normalizedName -> {id,name,category} map so the Rune Picker can resolve any
  // pasted rune/essence/soul-core to its exchange id.
  const cat = buildExchangeCatalog({ result: [
    { label: "Runes", entries: [{ id: "lesser-desert-rune", text: "Lesser Desert Rune" }] },
    { label: "Vaal", entries: [{ id: "soul-core-of-tacati", text: "Soul Core of Tacati" }] },
    { label: "Currency", entries: [{ id: "divine", text: "Divine Orb" }] },
  ] });
  const rune = [...cat.values()].find((e) => e.id === "lesser-desert-rune");
  const core = [...cat.values()].find((e) => e.id === "soul-core-of-tacati");
  ok(cat.size === 3, "buildExchangeCatalog maps every entry (" + cat.size + ")");
  ok(rune && rune.category === "Runes" && rune.name === "Lesser Desert Rune", "buildExchangeCatalog keeps id+name+category for runes");
  ok(core && core.category === "Vaal", "buildExchangeCatalog resolves soul cores (Vaal group)");

  // bestExchangeOffer: the Currency Exchange is littered with spam "par" listings
  // that swap the base unit 1:1 (e.g. 1 exalted : 1 divine). For an above-1ex
  // currency these sort to the top and used to be taken as "cheapest", poisoning
  // the rate (Divine read 1 ex instead of ~166). Must drop par offers and pick the
  // cheapest real one — while leaving sub-1ex currencies (whose floor is below the
  // par junk) untouched, and falling back to par only when nothing else exists.
  const offer = (payAmt, recvCur, recvAmt, recvStock) =>
    ({ exchange: { currency: "exalted", amount: payAmt }, item: { currency: recvCur, amount: recvAmt, stock: recvStock } });
  const divineData = { result: { a: offer(1, "divine", 1, 67), b: offer(166, "divine", 1, 373), c: offer(169, "divine", 1, 53) } };
  const dBest = bestExchangeOffer(divineData, EXALTED_ID, "divine", 5);
  ok(dBest && Math.round(dBest.payPerReceive) === 166, "bestExchangeOffer drops the par 1:1 spam (divine -> " + (dBest && dBest.payPerReceive) + " ex, not 1)");

  const transData = { result: { a: offer(1, "transmute", 3, 5000), b: offer(1, "transmute", 1, 100), c: offer(1, "transmute", 2, 200) } };
  const tBest = bestExchangeOffer(transData, EXALTED_ID, "transmute", 5);
  ok(tBest && Math.abs(tBest.payPerReceive - 1 / 3) < 0.01, "bestExchangeOffer keeps the sub-1ex floor (transmute -> " + (tBest && tBest.payPerReceive.toFixed(3)) + ", par drop doesn't touch it)");

  const allPar = { result: { a: offer(1, "x", 1, 9), b: offer(5, "x", 5, 9) } };
  const pBest = bestExchangeOffer(allPar, EXALTED_ID, "x", 5);
  ok(pBest && pBest.payPerReceive === 1, "bestExchangeOffer falls back to par only when nothing else exists");

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

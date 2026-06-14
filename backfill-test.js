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
const { fetchExchangeChunked, collectExchangeOffers, sanitizeLeague, __setExchangeRawImpl } = require("./server.js");

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

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

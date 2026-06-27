// Offline self-check for the EE2-faithful exchange pricing (ee2SidePrices +
// exchangePriceEx). No network — stubs the raw exchange response. Proves the two
// things that make us match Exiled-Exchange-2: single-offer-listing filter and
// the divine-vs-exalted side auto-select. Run: node ee2-price-test.js
const assert = require("assert");
const { ee2SidePrices, exchangePriceEx, __setExchangeRawImpl } = require("./server.js");

// Build a fake exchange response: result keyed by listing id, each listing.offers.
// offer = { exchange:{currency,amount}, item:{amount,stock} }.
const listing = (have, exAmt, itAmt, stock = 0, extraOffers = 0) => ({
  listing: {
    offers: [
      { exchange: { currency: have, amount: exAmt }, item: { amount: itAmt, stock } },
      // extra offers make it a MULTI-offer (bulk) listing — EE2 drops these.
      ...Array.from({ length: extraOffers }, () => ({ exchange: { currency: have, amount: 1 }, item: { amount: 1, stock: 1 } })),
    ],
  },
});
const resp = (arr) => ({ result: Object.fromEntries(arr.map((l, i) => [String(i), l])) });

// 1. Single-offer filter drops par/spam bundles; cheapest single-offer ask wins.
{
  const data = resp([
    listing("exalted", 1, 1, 99, 2),   // 1ex par SPAM but multi-offer → DROPPED
    listing("exalted", 1, 1, 50, 1),   // another multi-offer 1ex → DROPPED
    listing("exalted", 7, 1, 3),       // real single-offer asks
    listing("exalted", 5, 1, 4),
    listing("exalted", 6, 1, 2),
  ]);
  const sides = ee2SidePrices(data);
  assert.strictEqual(sides.exalted.length, 3, "only the 3 single-offer listings survive");
  assert.strictEqual(sides.exalted[0].px, 5, "cheapest single-offer ask is 5ex, not the 1ex spam");
}

// 2. Side auto-select: exalted unless divine has MORE listings (ties → exalted).
__setExchangeRawImpl(async () => resp([
  listing("exalted", 5, 1, 4),
  listing("exalted", 6, 1, 2),
  listing("divine", 1, 1, 1),          // one divine-side listing
]));
(async () => {
  let p = await exchangePriceEx("L", "some-rune", 200, 50);
  assert.strictEqual(p.side, "exalted", "exalted out-lists divine → exalted side");
  assert.strictEqual(p.ex, 5, "exalted-side price is the cheapest ask in ex");

  // Now divine out-lists exalted → divine side, converted via divineEx.
  __setExchangeRawImpl(async () => resp([
    listing("exalted", 8, 1, 1),
    listing("divine", 2, 1, 3),
    listing("divine", 3, 1, 2),
    listing("divine", 4, 1, 1),
  ]));
  p = await exchangePriceEx("L", "chase", 200, 50);
  assert.strictEqual(p.side, "divine", "divine out-lists exalted → divine side");
  assert.strictEqual(p.ex, 400, "divine-side cheapest 2div × 200ex/div = 400ex");

  // No offers at all → null (EE2 shows nothing; we surface "no offers").
  __setExchangeRawImpl(async () => resp([]));
  assert.strictEqual(await exchangePriceEx("L", "empty", 200, 50), null, "no offers → null");

  // 3. Self-par exclusion: pricing a base currency must DROP its own side from `have`
  // (EE2: Divine→[exalted,chaos]), else the 1:1 self-par spam mis-prices it to ~1.
  let seenHave = null;
  __setExchangeRawImpl(async (league, have) => { seenHave = have; return resp([listing("exalted", 340, 1, 5)]); });
  p = await exchangePriceEx("L", "divine");
  assert.deepStrictEqual(seenHave, ["exalted", "chaos"], "divine excludes its own side from have");
  assert.strictEqual(p.ex, 340, "divine prices on the exalted side (340), not 1:1 self-par");
  await exchangePriceEx("L", "chaos");
  assert.deepStrictEqual(seenHave, ["divine", "exalted"], "chaos excludes its own side from have");

  // 4. Sides list is returned (native px per side) for the EE2-style display.
  __setExchangeRawImpl(async () => resp([listing("exalted", 2, 1, 9), listing("chaos", 0.1, 1, 3)]));
  p = await exchangePriceEx("L", "rune", 340, 50);
  assert.ok(p.sides.find((s) => s.tag === "exalted").px === 2, "exalted side px in native units");
  assert.ok(p.sides.find((s) => s.tag === "chaos").ex === 5, "chaos side converts to ex (0.1 × 50)");

  // 5. Lone troll bait dropped: a cheapest offer < half the next is skipped so the real
  // cluster is the price (fixes divine reading 1ex off a "1 exalted : 1 divine" bait).
  // A deep EQUAL floor (many offers at the same px) is NOT treated as bait.
  const baited = ee2SidePrices(resp([listing("exalted", 1, 1, 1), listing("exalted", 359, 1, 5), listing("exalted", 360, 1, 5)]));
  assert.strictEqual(baited.exalted[0].px, 359, "lone 1ex bait dropped → real cluster 359 wins");
  const deep = ee2SidePrices(resp([listing("divine", 1, 1, 9), listing("divine", 1, 1, 9), listing("divine", 1, 1, 9)]));
  assert.strictEqual(deep.divine[0].px, 1, "a deep equal floor (3× at 1 div) is NOT treated as bait");

  console.log("ee2-price-test: all assertions passed");
})();

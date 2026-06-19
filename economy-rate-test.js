// Offline regression for divine-anchor poisoning. The currency overview AND the
// economy sampler derive a currency's ex value from the cheapest standing exchange
// offer. The bulk exchange carries lowball BAIT — e.g. a "3 exalted : 1 divine"
// listing WITH real stock (seen live at stock 11) when divine is ~180ex. It passes
// every stock filter and sorts to the cheapest spot, dragging the rate to ~3ex and
// skewing every derived price on the home dashboard. robustCheapestOffer must reject
// it via the book's median floor. Uses the REAL exported function, no network.
const assert = require("assert");
const { bestExchangeOffer } = require("./server.js");

const offer = (payEx, recvDiv, recvStock) => ({
  exchange: { currency: "exalted", amount: payEx, stock: payEx * 100 },
  item: { currency: "divine", amount: recvDiv, stock: recvStock },
});

// Realistic divine book: a cluster of legit ~180ex offers, plus a WELL-STOCKED
// lowball bait at 3ex/div (stock 11 — not thin, so stock filters don't catch it).
const data = { result: [
  offer(3, 1, 11),     // bait: cheapest ratio, healthy stock — the trap
  offer(178, 1, 40),   // legit market floor
  offer(180, 1, 88),   // legit, deepest
  offer(182, 1, 25),   // legit
  offer(360, 2, 30),   // legit bulk: 180 ex/div
] };

// Even at stock>=5 (bait clears the filter), the median floor rejects it and we
// land on the real ~178ex market floor — not 3.
const best = bestExchangeOffer(data, "exalted", "divine", 5);
assert.strictEqual(Math.round(best.payPerReceive), 178, "median floor must reject the well-stocked 3ex bait");

// A genuinely thin book (no median to judge) still returns its cheapest rather
// than nothing — we don't over-reject when there's nothing to compare against.
const thin = { result: [offer(170, 1, 8), offer(175, 1, 6)] };
assert.strictEqual(Math.round(bestExchangeOffer(thin, "exalted", "divine", 5).payPerReceive), 170, "thin book keeps its cheapest");

// Sub-1ex currency: whole book near 0.1, nothing legit gets cut by the floor.
const cheap = { result: [
  { exchange:{currency:"exalted",amount:1,stock:100}, item:{currency:"transmute",amount:10,stock:500} }, // 0.1
  { exchange:{currency:"exalted",amount:1,stock:100}, item:{currency:"transmute",amount:9,stock:400} },  // 0.111
  { exchange:{currency:"exalted",amount:1,stock:100}, item:{currency:"transmute",amount:11,stock:300} }, // 0.0909
  { exchange:{currency:"exalted",amount:1,stock:100}, item:{currency:"transmute",amount:10,stock:200} },
] };
assert.ok(bestExchangeOffer(cheap, "exalted", "transmute", 5).payPerReceive < 0.12, "cheap currency unaffected by the floor");

console.log("economy-rate-test: OK");

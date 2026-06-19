// Offline regression for divine-anchor poisoning. The currency overview AND the
// economy sampler derive a currency's ex value from the cheapest standing exchange
// offer. The bulk exchange carries lowball BAIT — e.g. a "3 exalted : 1 divine"
// listing WITH real stock (seen live at stock 11) when divine is ~180ex. It passes
// every stock filter and sorts to the cheapest spot, dragging the rate to ~3ex and
// skewing every derived price on the home dashboard. robustCheapestOffer must reject
// it via the book's median floor. Uses the REAL exported function, no network.
const assert = require("assert");
const { bestExchangeOffer, divineMarketPrice } = require("./server.js");

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

// Divine-side high-value items (omens, Hinekora's): live books are par 1:1 bait,
// then scattered non-par lowballs (2·3·4 div), then the real cluster (5·6·7). The
// cheapest survivor is still a bait, so divineMarketPrice takes the 25th-percentile
// offer to land in the cluster. (pay = divine, receive = the item.)
const dOffer = (divPay, recv, stock) => ({
  exchange: { currency: "divine", amount: divPay, stock: 9999 },
  item: { currency: "omen-of-light", amount: recv, stock },
});
const omenBook = { result: [
  dOffer(1, 1, 6),                                   // par 1:1 -> dropped
  dOffer(2, 1, 3), dOffer(3, 1, 5), dOffer(4, 1, 4), // non-par lowball bait, below cluster
  dOffer(5, 1, 8), dOffer(5, 1, 6), dOffer(5, 1, 5), dOffer(10, 2, 7), dOffer(5, 1, 4), dOffer(5, 1, 3), // cluster ~5
  dOffer(6, 1, 4), dOffer(6, 1, 2), dOffer(7, 1, 3), dOffer(7, 1, 4),
] };
assert.strictEqual(divineMarketPrice(omenBook, "omen-of-light", 2), 5,
  "p25 lands in the 5-div cluster, not the 2-div bait floor");

// Tightly-priced item (no bait spread, e.g. Hinekora's ~680): p25 ≈ the floor, so
// the robust estimator doesn't inflate items that were already correct.
const tight = { result: [dOffer(680, 1, 3), dOffer(690, 1, 2), dOffer(700, 1, 4), dOffer(720, 1, 2)] };
assert.strictEqual(divineMarketPrice(tight, "omen-of-light", 2), 680, "tight book stays at its floor");

console.log("economy-rate-test: OK");

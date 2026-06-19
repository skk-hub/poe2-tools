// Offline regression for the economy divine-anchor poisoning. The sampler derives
// exPerDiv (divine's value in exalted) from the cheapest standing exchange offer;
// a thin lowball snipe ("~3 exalted : 1 divine") used to win and skew every price
// on the home dashboard. The currency overview never had this because it requires
// stock >= 5. This pins that a deep real offer wins at the 5-floor, and documents
// that the old 2-floor would have taken the bait. Uses the REAL exported function.
const assert = require("assert");
const { bestExchangeOffer } = require("./server.js");

const offer = (payEx, recvDiv, recvStock) => ({
  exchange: { currency: "exalted", amount: payEx, stock: payEx * 100 },
  item: { currency: "divine", amount: recvDiv, stock: recvStock },
});

// A realistic divine book: a cluster of legit ~180ex offers with deep stock, plus
// one thin lowball bait at 3ex/div (stock 2) sitting at the cheap front.
const data = { result: [
  offer(3, 1, 2),      // bait: cheapest ratio, thin stock
  offer(178, 1, 40),   // legit market floor
  offer(180, 1, 88),   // legit, deepest
  offer(360, 2, 30),   // legit bulk: 180 ex/div, stock 30
] };

// The fix: stock>=5 rejects the thin bait -> lands on the real ~178 market floor.
const fixed = bestExchangeOffer(data, "exalted", "divine", 5);
assert.strictEqual(Math.round(fixed.payPerReceive), 178, "5-floor should pick the real market offer, not the bait");

// Document the bug: the old 2-floor would have taken the 3ex bait.
const old = bestExchangeOffer(data, "exalted", "divine", 2);
assert.strictEqual(old.payPerReceive, 3, "2-floor takes the thin lowball (the bug)");

// And if the book were genuinely thin (only the bait clears nothing at >=5), the
// fallback still returns something rather than nothing.
const thin = { result: [offer(3, 1, 2)] };
assert.strictEqual(bestExchangeOffer(thin, "exalted", "divine", 5), null, "no >=5 offer -> null (caller falls back to >=1)");
assert.ok(bestExchangeOffer(thin, "exalted", "divine", 1), ">=1 fallback finds the only offer");

console.log("economy-rate-test: OK");

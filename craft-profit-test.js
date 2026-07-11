// craft-profit-test.js — self-check for the pricing-realism resale read and the
// expected-profit route scoring (recipe layer "Later phases" 2). Offline, no network.
//   node craft-profit-test.js
const assert = require("assert");
const { robustResalePrice, tagRouteClasses } = require("./server.js");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const NOW = new Date("2026-07-12T12:00:00Z").getTime();
const days = (n) => new Date(NOW - n * 86400000).toISOString();
const L = (div, ageDays) => ({ div, indexedAt: days(ageDays) });

// ── robustResalePrice ──
// one absurd lowball must not set the price (the "bad craft looks profitable" bug)
let r = robustResalePrice([L(0.1, 1), L(2, 1), L(2.1, 2), L(2.2, 1), L(2.4, 3)], { now: NOW });
ok(r.saleDiv === 2, `lowball bait ignored, cluster anchors the price (got ${r.saleDiv})`);
ok(r.liquidationDiv === 1.8, "liquidation = anchor × 0.9");
ok(!r.thin, "5 fresh offers is not thin");

// stale listings are aspirational, not the market
r = robustResalePrice([L(0.5, 30), L(0.6, 20), L(3, 1), L(3.1, 1), L(3.2, 2)], { now: NOW });
ok(r.saleDiv === 3 && r.freshSample === 3, `stale cheap listings dropped (got ${r.saleDiv}, fresh ${r.freshSample})`);
ok(r.thin, "3 fresh offers < minSample 5 → thin");

// no cluster → lowball-walk fallback still guards the single absurd ask
r = robustResalePrice([L(0.1, 1), L(5, 1)], { now: NOW });
ok(r.saleDiv === 5 && r.thin, `no cluster: 0.1-vs-5 walk lands on 5, flagged thin (got ${r.saleDiv})`);

// empty / all-stale → null price, thin
r = robustResalePrice([L(1, 60)], { now: NOW });
ok(r.saleDiv === null && r.thin && r.sample === 1 && r.freshSample === 0, "all-stale → null + thin");
r = robustResalePrice([], { now: NOW });
ok(r.saleDiv === null && r.thin, "no listings → null + thin");

// missing indexedAt is treated as fresh (fetch always carries it; belt-and-braces)
r = robustResalePrice([{ div: 2 }, { div: 2.1 }, { div: 2.2 }, { div: 2.3 }, { div: 2.5 }], { now: NOW });
ok(r.saleDiv === 2 && !r.thin, "undated listings count as fresh");

// ── tagRouteClasses ──
const M = (key, divineCost, p) => ({ key, feasible: true, impractical: false, divineCost, successPerAttempt: p });
// cheap-but-risky vs dear-but-safe vs the middle
const methods = [M("risky", 1.0, 0.02), M("mid", 1.5, 0.20), M("safe", 4.0, 0.90)];
tagRouteClasses(methods, 3);
const by = Object.fromEntries(methods.map((m) => [m.key, m]));
ok(by.risky.routeClasses.includes("cheapest"), "lowest amortized cost tagged cheapest");
ok(by.safe.routeClasses.includes("safest"), "highest one-shot odds tagged safest");
ok(by.risky.perAttemptDivineCost === 0.02, "per-attempt spend = divineCost × p");
ok(by.risky.routeClasses.includes("low_budget"), "least per-attempt spend tagged low_budget");
// best_ev: risky = .02×3−.02 = .04; mid = .2×3−.3 = .3; safe = .9×3−3.6 = −0.9
ok(by.mid.routeClasses.includes("best_ev") && !by.safe.routeClasses.includes("best_ev"),
  `best per-attempt profit tagged best_ev (mid ${by.mid.expectedProfitDiv}, safe ${by.safe.expectedProfitDiv})`);
ok(by.safe.expectedProfitDiv < 0, "negative-EV route carries its honest negative number");

// impractical/unpriced methods are never tagged
const mix = [M("ok", 2, 0.5), { key: "junk", feasible: true, impractical: true, divineCost: 0.1, successPerAttempt: 0.001 }, { key: "unpriced", feasible: true, impractical: false, divineCost: null, successPerAttempt: 0.5 }];
tagRouteClasses(mix, null);
ok(mix[0].routeClasses.includes("cheapest") && !mix[1].routeClasses && !mix[2].routeClasses, "impractical + unpriced excluded from classes");
ok(mix[0].expectedProfitDiv === undefined, "no targetValueDiv → no invented EV");

console.log(`craft-profit-test: ${pass} checks passed`);

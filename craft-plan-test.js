// craft-plan-test.js — the planner's two jobs, checked.
//
// 1. COVERAGE (the anti-forgetting contract). Every searchable move in the KB catalog must be
//    executable by the planner or explicitly named UNSUPPORTED with a reason. This is the test
//    that exists because the old engine silently forgot Hinekora's Lock, Greater Exaltation,
//    targeted Regals and the Crystallisation omens for months. If someone adds a mechanic to
//    poe2-kb/crafting/methods.json and doesn't teach the planner to use it, THIS fails.
//
// 2. EQUIVALENCE. The planner is a rewrite of 13 hand-written simulations whose odds were
//    validated (one against a closed-form evaluator). A generic executor that composes moves is
//    only trustworthy if it reproduces those numbers, so we pin the composed routes against the
//    old implementations' known behaviour rather than taking the rewrite on faith.

const assert = require("assert");
const P = require("./craft-plan.js");
const E = require("./craft-engine.js");
const METHODS = require("./method-data.js");

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`  FAIL ${name}\n    ${e.message}`); } };

// A synthetic pool: two prefixes and two suffixes, plus junk on both sides so slots really do
// jam. Weights are round numbers so the expected odds are hand-checkable.
const POOL = [
  { key: "p_life_t1", group: "Life", type: "prefix", weight: 100, ilvl: 60, tags: ["life"] },
  { key: "p_life_t2", group: "Life", type: "prefix", weight: 200, ilvl: 20, tags: ["life"] },
  { key: "p_phys", group: "PhysDamage", type: "prefix", weight: 100, ilvl: 60, tags: ["damage", "physical"] },
  { key: "p_junk1", group: "JunkP1", type: "prefix", weight: 300, ilvl: 1, tags: ["junk"] },
  { key: "p_junk2", group: "JunkP2", type: "prefix", weight: 300, ilvl: 1, tags: ["junk"] },
  { key: "s_res", group: "FireRes", type: "suffix", weight: 100, ilvl: 60, tags: ["resistance"] },
  { key: "s_speed", group: "AttackSpeed", type: "suffix", weight: 100, ilvl: 60, tags: ["damage", "speed"] },
  { key: "s_junk1", group: "JunkS1", type: "suffix", weight: 300, ilvl: 1, tags: ["junk"] },
  { key: "s_junk2", group: "JunkS2", type: "suffix", weight: 300, ilvl: 1, tags: ["junk"] },
];
const ESSENCES = [
  { name: "Greater Essence of the Body", modKey: "p_life_t1", group: "Life", type: "prefix", stat: "+# to maximum Life" },
  { name: "Perfect Essence of the Body", modKey: "p_life_t1", group: "Life", type: "prefix", stat: "+# to maximum Life" },
];

console.log("craft-plan — coverage");

ok("every searchable catalog move is executable or explicitly unsupported", () => {
  const gaps = [];
  for (const m of METHODS.moves) {
    if (!m.search) continue;
    if (P.EXECUTABLE.has(m.id)) continue;
    if (P.UNSUPPORTED[m.id]) continue;
    gaps.push(m.id);
  }
  assert.deepStrictEqual(gaps, [],
    `the catalog has searchable moves the planner cannot use: ${gaps.join(", ")}\n` +
    `    → either compose them into a route in craft-plan.js, or add them to UNSUPPORTED with a REASON.`);
});

ok("every UNSUPPORTED entry names a move that actually exists (no stale excuses)", () => {
  for (const id of Object.keys(P.UNSUPPORTED)) {
    assert.ok(P.MOVES[id], `UNSUPPORTED names "${id}", which is not in the catalog — delete the stale entry`);
    assert.ok(P.UNSUPPORTED[id].length > 20, `UNSUPPORTED["${id}"] needs a real reason, not a shrug`);
  }
});

ok("every executable move id exists in the catalog (no typo'd route)", () => {
  for (const id of P.EXECUTABLE) {
    assert.ok(P.MOVES[id], `planner can emit "${id}" but the catalog has no such move — typo, or a move was deleted from the KB`);
  }
});

ok("the mechanics the old engine forgot are now all reachable", () => {
  // The specific regression this whole rewrite exists to prevent.
  const forgotten = ["hinekora", "exalt-greater-omen", "regal-sinistral", "regal-dextral",
    "essence-rare-sinistral", "essence-rare-dextral", "annul-greater", "desecrate-echoes", "alchemy-sinistral"];
  for (const id of forgotten) {
    assert.ok(P.EXECUTABLE.has(id), `"${id}" is STILL forgotten by the planner`);
  }
});

console.log("craft-plan — routes");

ok("the classic Transmute → Augment → Regal opener is enumerated", () => {
  const ctx = P.buildCtx(POOL, ["Life", "FireRes"], { essences: [] });
  const routes = P.enumerateRoutes(ctx);
  const found = routes.some((r) => r.start === "transmute" && r.augment === "augment" && r.promote === "regal");
  assert.ok(found, "the single most common opening in the game is not in the route space");
});

ok("planning a 2-target craft produces feasible, ranked routes", () => {
  const r = P.planRoutes(POOL, ["Life", "FireRes"], { essences: ESSENCES, seed: 7, trials: 2000 });
  assert.ok(!r.impossible, "should be possible");
  assert.ok(r.methods.length > 0, "no routes returned");
  assert.ok(r.routesConsidered > 50, `only ${r.routesConsidered} routes considered — enumeration collapsed`);
  assert.ok(r.methods[0].feasible && r.methods[0].successPerAttempt > 0, "best route infeasible");
  // ranked cheapest-first
  for (let i = 1; i < r.methods.length; i++) {
    if (r.methods[i - 1].impractical === r.methods[i].impractical) {
      assert.ok(r.methods[i - 1].totalOrbs <= r.methods[i].totalOrbs + 1e-9, "routes not ranked by cost");
    }
  }
});

ok("an essence route guarantees its mod — 100% of the essence's own target", () => {
  // Essence of the Body guarantees Life. A route that uses it can never fail to have Life.
  const r = P.planRoutes(POOL, ["Life"], { essences: ESSENCES, seed: 11, trials: 2000 });
  const ess = r.methods.find((m) => m.essenceName);
  assert.ok(ess, "no essence route offered for a target an essence guarantees");
  assert.strictEqual(ess.successPerAttempt, 1, `an essence-guaranteed single target must be p=1, got ${ess.successPerAttempt}`);
});

ok("cost keys are real market names (they price directly, no proxy table)", () => {
  const r = P.planRoutes(POOL, ["Life", "FireRes"], { essences: ESSENCES, seed: 3, trials: 500 });
  const known = new Set(METHODS.moves.flatMap((m) => [m.currency, ...(m.omens || [])])
    .filter((c) => c && !c.startsWith("<")));
  known.add("Hinekora's Lock");
  for (const m of r.methods) {
    for (const orb of Object.keys(m.expectedOrbs)) {
      const isEssence = /Essence/.test(orb);
      assert.ok(known.has(orb) || isEssence, `route "${m.key}" charges "${orb}", which is not a catalog currency/omen — it will never price`);
    }
  }
});

ok("a target not in the pool is IMPOSSIBLE, not a 0% route", () => {
  const r = P.planRoutes(POOL, ["NotAThing"], { essences: [], seed: 1 });
  assert.strictEqual(r.impossible, true);
  assert.ok(r.missing.includes("NotAThing"));
});

ok("4 prefix targets cannot fit on an item — overCap, not a fantasy plan", () => {
  const pool = POOL.concat([
    { key: "p_a", group: "A", type: "prefix", weight: 100, ilvl: 1, tags: [] },
    { key: "p_b", group: "B", type: "prefix", weight: 100, ilvl: 1, tags: [] },
  ]);
  const r = P.planRoutes(pool, ["Life", "PhysDamage", "A", "B"], { essences: [], seed: 1 });
  assert.strictEqual(r.impossible, true);
  assert.strictEqual(r.overCap, true);
});

console.log("craft-plan — equivalence with the old hand-written methods");

// The planner replaced 13 hand-written simulations. These are the odds those simulations produced
// on the POOL above, MEASURED at 200k trials against the pre-rewrite craft-engine.js (the version
// whose odds had been cross-validated against a closed-form evaluator) immediately before it was
// deleted. Pinning the numbers rather than the code is the point: the old implementation is gone,
// but its answers still hold the rewrite to account. A composed route that drifts from these is a
// regression in the engine's mechanics, not a refactor.
const OLD_ENGINE = {
  trans_regal_exalt: 0.50119,   // transmute → augment → regal → exalt-fill, targets Life + FireRes
  chaos_spam: 0.99984,          // alchemy → chaos until both targets land (cap 120)
};

ok("planner reproduces Transmute→Augment→Regal→Exalt odds from the old engine", () => {
  const ctx = P.buildCtx(POOL, ["Life", "FireRes"], { essences: [] });
  const route = { start: "transmute", augment: "augment", promote: "regal", fill: "exalt", fix: "none", lock: false };
  const p = P.simulateRoute(route, ctx, 40000, E.rng(99)).successPerAttempt;
  const d = Math.abs(p - OLD_ENGINE.trans_regal_exalt);
  assert.ok(d < 0.02,
    `planner ${(p * 100).toFixed(2)}% vs old engine ${(OLD_ENGINE.trans_regal_exalt * 100).toFixed(2)}% — ` +
    `the composed route does not reproduce the hand-written one (Δ${(d * 100).toFixed(2)}pp)`);
});

ok("planner reproduces Alchemy + Chaos-spam odds from the old engine", () => {
  const ctx = P.buildCtx(POOL, ["Life", "FireRes"], { essences: [] });
  const route = { start: "alchemy", fill: "exalt", fix: "chaos", lock: false };
  const p = P.simulateRoute(route, ctx, 40000, E.rng(42)).successPerAttempt;
  const d = Math.abs(p - OLD_ENGINE.chaos_spam);
  assert.ok(d < 0.03,
    `planner ${(p * 100).toFixed(2)}% vs old chaos-spam ${(OLD_ENGINE.chaos_spam * 100).toFixed(2)}% (Δ${(d * 100).toFixed(2)}pp)`);
});

console.log("craft-plan — Hinekora's Lock");

ok("the Lock raises one-shot odds and charges Locks", () => {
  const ctx = P.buildCtx(POOL, ["Life", "FireRes"], { essences: [] });
  const bare = { start: "transmute", augment: null, promote: "regal", fill: "exalt", fix: "none", lock: false };
  const lock = { ...bare, lock: true };
  const a = P.simulateRoute(bare, ctx, 8000, E.rng(5));
  const b = P.simulateRoute(lock, ctx, 8000, E.rng(5));
  assert.ok(b.successPerAttempt > a.successPerAttempt,
    `foreseeing and declining bad slams must beat slamming blind (${b.successPerAttempt} vs ${a.successPerAttempt})`);
  assert.ok(b.expectedOrbs["Hinekora's Lock"] > 0, "a Lock route that charges no Locks is not using them");
});

console.log("craft-plan — desecration eligibility (sourced: crafting/techniques/)");

ok("a bone is ILLEGAL while a Desecrated modifier is on the item", () => {
  // "Items with Desecrated Modifiers cannot be Desecrated again" (revealed or not).
  const item = { rarity: "rare", quality: 0, corrupted: false, prefixes: [{ key: "d", group: "DesecA", type: "prefix", ilvl: 1, desecrated: true }], suffixes: [] };
  const ctx = { mods: POOL, T: [], essences: [], jewellery: false };
  assert.strictEqual(P.legal(P.MOVES["desecrate"], item, ctx), false, "boned an item that already carries a desecrated mod");
  assert.strictEqual(P.legal(P.MOVES["desecrate-echoes"], item, ctx), false, "echoes bone ignored the desecrated_absent gate");
  // Omen of Light is the documented way back to eligibility — it must stay legal.
  assert.strictEqual(P.legal(P.MOVES["annul-light"], item, ctx), true, "Omen of Light must be able to scrub the desecrated mod");
});

ok("a clean rare CAN be desecrated (the gate didn't over-fire)", () => {
  const item = { rarity: "rare", quality: 0, corrupted: false, prefixes: [{ key: "p_junk1", group: "JunkP1", type: "prefix", ilvl: 1 }], suffixes: [] };
  const ctx = { mods: POOL, T: [], essences: [], jewellery: false };
  assert.strictEqual(P.legal(P.MOVES["desecrate"], item, ctx), true, "a clean rare must still be desecratable");
});

ok("TWO desecrated targets is impossible, not merely unlikely", () => {
  const targets = [
    { group: "desecrated:A", desecrated: true, type: "prefix", poolN: 30 },
    { group: "desecrated:B", desecrated: true, type: "suffix", poolN: 30 },
  ];
  const r = P.planRoutes(POOL, targets, { essences: [], seed: 31, trials: 400 });
  assert.strictEqual(r.impossible, true, "two desecrated mods on one item was reported as craftable");
  assert.ok((r.missing || []).some((m) => /only ever keep ONE/i.test(m)), `expected a 'keep only one' reason, got ${JSON.stringify(r.missing)}`);
});

console.log("craft-plan — ranking is on MONEY, and unbuyable never wins");

ok("a route using a currency the market does not price is sunk below buyable routes", () => {
  // The bug this pins, observed live: every top-5 route for a Sapphire Ring used Omen of
  // Homogenising Exaltation — which the market does not price at all. Ranking on orb count made
  // the unpriced omen a FREE orb, so the unbuyable route won precisely because nothing bid its
  // price up, and the quoted divine cost silently excluded it. Unknown cost must mean "last",
  // never "free".
  const priceOf = (orb) => {
    if (/Omen of Homogenising/.test(orb)) return null;   // not sold on the market
    if (/Exalted Orb/.test(orb)) return 0.01;
    if (/Essence/.test(orb)) return 0.05;
    if (/Orb of Transmutation|Orb of Augmentation|Regal Orb|Orb of Alchemy/.test(orb)) return 0.001;
    if (/Chaos Orb|Orb of Annulment/.test(orb)) return 0.02;
    return 0.5;                                          // every other omen is priced
  };
  const r = P.planRoutes(POOL, ["Life", "FireRes"], { essences: ESSENCES, seed: 21, trials: 1200, priceOf });
  assert.ok(r.methods.length, "no routes");
  const top = r.methods[0];
  assert.ok(!top.priceMissing,
    `the best route depends on an unpriceable currency (${(top.priceMissing || []).join(", ")}) — unbuyable must never rank first`);
  assert.ok(top.divineCost != null, "the best route must have a real, complete divine cost");
  // and any route that IS unpriceable must sit below every priced one
  const firstUnpriced = r.methods.findIndex((m) => m.priceMissing);
  const lastPriced = r.methods.map((m) => !m.priceMissing).lastIndexOf(true);
  if (firstUnpriced >= 0) {
    assert.ok(firstUnpriced > lastPriced, "an unpriced route is ranked above a priced one");
  }
});

ok("with prices, the cheapest MONEY route wins — not the fewest-orbs route", () => {
  // Make Exalts dirt cheap and every omen absurd. The winner must be an omen-free route even
  // though omen routes use fewer orbs.
  const priceOf = (orb) => {
    if (/Omen/.test(orb)) return 500;                    // priced, but ruinous
    if (/Hinekora/.test(orb)) return 500;
    if (/Exalted Orb/.test(orb)) return 0.001;
    return 0.001;
  };
  const r = P.planRoutes(POOL, ["Life", "FireRes"], { essences: ESSENCES, seed: 22, trials: 1200, priceOf });
  const top = r.methods[0];
  const spentOnOmens = Object.keys(top.expectedOrbs).some((o) => /Omen|Hinekora/.test(o));
  assert.ok(!spentOnOmens,
    `best route buys ruinously-priced omens (${top.label}) — ranking is still on orb count, not money`);
});

console.log("craft-plan — advise a pasted item (continue vs BRICKED)");

ok("an item one slot short of its target says CONTINUE", () => {
  const current = [{ key: "p_life_t1", group: "Life", type: "prefix", ilvl: 60 }];
  const r = P.adviseItem(POOL, current, ["FireRes"], { essences: ESSENCES, startRarity: "rare", seed: 4, trials: 2000 });
  assert.strictEqual(r.verdict, "CONTINUE");
  assert.ok(r.methods.length > 0);
  assert.ok(r.methods[0].successPerAttempt > 0);
});

ok("a corrupted item is BRICKED, with no route offered", () => {
  const current = [{ key: "p_life_t1", group: "Life", type: "prefix", ilvl: 60 }];
  const r = P.adviseItem(POOL, current, ["FireRes"], { startRarity: "rare", corrupted: true, seed: 4 });
  assert.strictEqual(r.verdict, "BRICKED");
  assert.strictEqual(r.methods.length, 0);
  assert.match(r.reason, /corrupted/i);
});

ok("a full item of junk with no removal route is BRICKED, not a fantasy plan", () => {
  // Every slot taken by junk, and the target needs a suffix. Only removal routes could save it;
  // if none survive, the honest answer is BRICKED — that is the whole point of the verdict.
  const current = [
    { key: "p_junk1", group: "JunkP1", type: "prefix", ilvl: 1 },
    { key: "p_junk2", group: "JunkP2", type: "prefix", ilvl: 1 },
    { key: "p_phys", group: "PhysDamage", type: "prefix", ilvl: 60 },
    { key: "s_junk1", group: "JunkS1", type: "suffix", ilvl: 1 },
    { key: "s_junk2", group: "JunkS2", type: "suffix", ilvl: 1 },
    { key: "s_speed", group: "AttackSpeed", type: "suffix", ilvl: 60 },
  ];
  const r = P.adviseItem(POOL, current, ["FireRes"], { startRarity: "rare", seed: 4, trials: 1500 });
  // Keeping ALL six mods AND adding a 7th is impossible (6 slots, 6 used) — so any route must
  // sacrifice a kept mod, which counts as failure. Verdict must not be CONTINUE.
  assert.notStrictEqual(r.verdict, "CONTINUE",
    `a full item that cannot gain a 7th mod without losing one was reported as ${r.verdict}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

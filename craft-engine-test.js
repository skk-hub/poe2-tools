// craft-engine-test.js — self-check for the Monte Carlo crafting engine. Uses tiny
// synthetic pools whose probabilities are hand-computable, so the mechanics (weighted
// combined pool, prefix/suffix caps, group exclusion, impossibility) are provably right.
//   node craft-engine-test.js
const assert = require("assert");
const E = require("./craft-engine.js");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const near = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}: ${a.toFixed(4)} vs ${b} (±${tol})`); pass++; };

const A = { key: "A", type: "prefix", group: "GA", weight: 10, ilvl: 1 };
const B = { key: "B", type: "prefix", group: "GB", weight: 30, ilvl: 1 };
const C = { key: "C", type: "suffix", group: "GC", weight: 60, ilvl: 1 };
const pool = [A, B, C];
const N = 100000;

// 1) single weighted add (transmute): P(group present) == weight / totalWeight
const rnd = E.rng(1);
function pTransmute(target) {
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const it = E.newItem(); it.rarity = "magic"; E.addMod(it, pool, rnd);
    if (it.prefixes.concat(it.suffixes).some((m) => m.group === target)) hits++;
  }
  return hits / N;
}
near(pTransmute("GA"), 0.10, 0.01, "transmute P(GA)=w10/100");
near(pTransmute("GB"), 0.30, 0.01, "transmute P(GB)=w30/100");
near(pTransmute("GC"), 0.60, 0.01, "transmute P(GC)=w60/100 (suffix competes by weight, no 50/50 side flip)");

// 2) group exclusion + cap: a Magic item with prefix A, augment → only suffix C is legal
{
  const it = E.newItem(); it.rarity = "magic"; it.prefixes = [A];
  const added = E.addMod(it, pool, rnd);      // prefix side full (cap 1), GA present → must pick C
  ok(added && it.suffixes.length === 1 && it.suffixes[0].group === "GC", "augment on full-prefix magic adds the only legal suffix");
  const again = E.addMod(it, pool, rnd);      // now both sides full → nothing legal
  ok(again === false, "no affix added when both magic slots full");
}

// 3) alchemy (4 adds) on a 3-mod pool → adds all 3 distinct groups, 4th finds nothing
{
  const r = E.rng(7);
  let allThree = 0;
  for (let i = 0; i < 5000; i++) {
    const { item } = E.craftFresh(["alchemy"], pool, r);
    if (item.prefixes.length + item.suffixes.length === 3) allThree++;
  }
  ok(allThree === 5000, "alchemy on a 3-mod pool always yields exactly 3 affixes (caps/exclusion hold)");
  const res = E.simulateFresh({ key: "alch", label: "", recipe: ["alchemy"] }, pool, ["GA", "GB", "GC"], 2000, r);
  near(res.successPerAttempt, 1.0, 0.001, "alchemy always hits all 3 when the pool is exactly those 3");
}

// 4) reachability guards: unknown group impossible; >3 of one side over cap
{
  const bad = E.rankMethods(pool, ["GA", "GZ"], { trials: 500 });
  ok(bad.impossible && bad.missing.includes("GZ"), "target not in pool → impossible + reported");
  const fourPrefix = [
    { key: "p1", type: "prefix", group: "P1", weight: 1, ilvl: 1 },
    { key: "p2", type: "prefix", group: "P2", weight: 1, ilvl: 1 },
    { key: "p3", type: "prefix", group: "P3", weight: 1, ilvl: 1 },
    { key: "p4", type: "prefix", group: "P4", weight: 1, ilvl: 1 },
  ];
  const over = E.rankMethods(fourPrefix, ["P1", "P2", "P3", "P4"], { trials: 500 });
  ok(over.impossible && over.overCap, "4 prefix targets → over cap (max 3 prefixes)");
}

// 5) ranking returns feasible methods sorted by expected orbs, cheapest first
{
  const res = E.rankMethods(pool, ["GC"], { trials: 5000, seed: 3 });
  ok(!res.impossible && res.methods.length >= 2, "rankMethods returns methods for a reachable target");
  const feasible = res.methods.filter((m) => m.feasible);
  ok(feasible.length >= 1, "at least one feasible method");
  for (let i = 1; i < res.methods.length; i++) ok(res.methods[i - 1].totalOrbs <= res.methods[i].totalOrbs, "methods sorted cheapest-first");
}

// 6) tier-restricted targets: two tiers of one group; targeting a specific tier halves
//    the hit vs "any tier" (transmute picks each equally at weight 1).
{
  const L1 = { key: "L1", type: "prefix", group: "GL", weight: 1, ilvl: 1 };
  const L2 = { key: "L2", type: "prefix", group: "GL", weight: 1, ilvl: 1 };
  const r = E.rng(9);
  const anyTier = E.simulateFresh({ key: "t", label: "", recipe: ["transmute"] }, [L1, L2], ["GL"], N, r);
  near(anyTier.successPerAttempt, 1.0, 0.001, "transmute always lands the group (any tier) when it's the only group");
  const t1only = E.simulateFresh({ key: "t", label: "", recipe: ["transmute"] }, [L1, L2], [{ group: "GL", keys: ["L1"] }], N, r);
  near(t1only.successPerAttempt, 0.5, 0.01, "restricting to tier L1 halves the hit (L1 vs L2 equal weight)");
  const both = E.simulateFresh({ key: "t", label: "", recipe: ["transmute"] }, [L1, L2], [{ group: "GL", keys: ["L1", "L2"] }], N, r);
  near(both.successPerAttempt, 1.0, 0.001, "selecting both tiers == any tier");
  // selecting a tier that isn't in the pool (too-high ilvl) is impossible
  const imposs = E.rankMethods([L1, L2], [{ group: "GL", keys: ["L9"] }], { trials: 500 });
  ok(imposs.impossible && imposs.missing.length === 1, "unavailable tier → impossible");
}

// 7) essences: guaranteeing a target's mod makes it certain; an essence for the wrong
//    tier must NOT be used (it would block the wanted tier).
{
  const r = E.rng(11);
  // pool: two prefix tiers of GL + one suffix GS
  const L1 = { key: "L1", type: "prefix", group: "GL", weight: 1, ilvl: 1 };
  const L2 = { key: "L2", type: "prefix", group: "GL", weight: 1, ilvl: 1 };
  const S1 = { key: "S1", type: "suffix", group: "GS", weight: 1, ilvl: 1 };
  const p2 = [L1, L2, S1];
  const essL1 = [{ name: "Ess of L", modKey: "L1", group: "GL", type: "prefix", stat: "L1" }];
  // guarantee GL (any tier) → essence method always lands GL; targeting GL alone => 100%
  const rk = E.rankMethods(p2, ["GL"], { trials: 4000, seed: 5, essences: essL1 });
  const em = rk.methods.find((m) => m.key === "essence");
  ok(em && em.feasible, "essence method offered when a target is essence-available");
  near(em.successPerAttempt, 1.0, 0.001, "essence guarantees the target group → 100%/attempt");
  // target GL restricted to tier L2, but essence only makes L1 → essence must NOT apply
  const rk2 = E.rankMethods(p2, [{ group: "GL", keys: ["L2"] }], { trials: 2000, seed: 6, essences: essL1 });
  ok(!rk2.methods.some((m) => m.key === "essence"), "essence for the wrong tier is not offered (would block the wanted tier)");
}

// 8) omens: whittling removes the lowest-ilvl mod; directed exalts aim at a target's side
{
  const it = { rarity: "rare", prefixes: [{ key: "hi", group: "H", type: "prefix", ilvl: 80 }], suffixes: [{ key: "lo", group: "L", type: "suffix", ilvl: 5 }] };
  E.removeLowestIlvl(it);
  ok(it.suffixes.length === 0 && it.prefixes.length === 1, "whittling removes the lowest-ilvl mod");

  const J = { key: "J", type: "prefix", group: "JG", weight: 1, ilvl: 1 };
  const S = { key: "S", type: "suffix", group: "SG", weight: 1, ilvl: 1 };
  const r = E.rng(21);
  let land = 0;
  for (let i = 0; i < 2000; i++) { const item = { rarity: "rare", prefixes: [], suffixes: [] }; E.directedFill(item, [J, S], [{ group: "SG", keys: null, type: "suffix" }], r, 6); if (item.suffixes.some((m) => m.group === "SG")) land++; }
  near(land / 2000, 1.0, 0.001, "directed exalt to the suffix side always lands the lone suffix target");

  const rk = E.rankMethods([J, S], ["SG"], { trials: 3000, seed: 4 });
  ok(rk.methods.find((m) => m.key === "directed" && m.feasible), "directed-exalt omen method offered & feasible");
  ok(rk.methods.find((m) => m.key === "whittling" && m.feasible), "whittling omen method offered & feasible");
}

// 9) tiered Exalt fill gates on target tier: offered only when every target accepts a
//    high-tier (≥35) mod, not when a low tier is acceptable.
{
  const Plo = { key: "Plo", type: "prefix", group: "GP", weight: 1, ilvl: 1 };
  const Shi = { key: "Shi", type: "suffix", group: "GS", weight: 1, ilvl: 60 };
  const anyTier = E.rankMethods([Plo, Shi], ["GP"], { trials: 800, seed: 1 });   // GP accepts ilvl 1
  ok(!anyTier.methods.some((m) => m.key === "tiered"), "tiered fill NOT offered when a low tier is acceptable");
  const hiTier = E.rankMethods([Plo, Shi], [{ group: "GS", keys: ["Shi"] }], { trials: 800, seed: 2 }); // GS accepts only ilvl 60
  const t = hiTier.methods.find((m) => m.key === "tiered");
  ok(t && /Perfect Exalted/.test(t.label), "tiered (Perfect) fill offered for a high-tier-only target");
}

// 10) erasure (side helpers) + the erasure/annul methods are offered and feasible
{
  const it = { rarity: "rare", prefixes: [{ key: "p1", group: "P", type: "prefix", ilvl: 5 }, { key: "p2", group: "Q", type: "prefix", ilvl: 80 }], suffixes: [{ key: "s1", group: "S", type: "suffix", ilvl: 60 }] };
  E.removeLowestIlvlOnSide(it, "prefix");
  ok(it.prefixes.length === 1 && it.prefixes[0].group === "Q" && it.suffixes.length === 1, "erasure removes the lowest-ilvl mod on the chosen side only");
  const A = { key: "A", type: "prefix", group: "GA", weight: 1, ilvl: 1 };
  const B = { key: "B", type: "suffix", group: "GB", weight: 1, ilvl: 1 };
  const rk = E.rankMethods([A, B], ["GA", "GB"], { trials: 1500, seed: 8 });
  ok(rk.methods.some((m) => m.key === "erasure" && m.feasible), "erasure-chaos method offered & feasible");
  ok(rk.methods.some((m) => m.key === "annul"), "annul+exalt method offered");
}

console.log(`craft-engine-test: ${pass} checks passed`);

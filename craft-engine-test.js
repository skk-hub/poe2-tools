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
  // cheapest-first WITHIN the practical tier (impractical routes are sorted after all practical
  // ones regardless of orb count, so only compare like-with-like).
  for (let i = 1; i < res.methods.length; i++) {
    if (!!res.methods[i - 1].impractical === !!res.methods[i].impractical) ok(res.methods[i - 1].totalOrbs <= res.methods[i].totalOrbs, "methods sorted cheapest-first within tier");
  }
  ok(res.methods.every((m, i) => i === 0 || !(res.methods[i - 1].impractical && !m.impractical)), "practical methods always rank above impractical ones");
}

// 5b) impractical flag: a route that rarely completes within its reroll budget gets flagged
//     and sorted after every practical route; a trivially-easy target flags nothing.
{
  // one specific prefix + one specific suffix among lots of junk groups, with a tiny chaos cap
  // so raw chaos spam almost never lands both before scrapping the base → < PRACTICAL_MIN.
  const P1 = { key: "P1", type: "prefix", group: "GP", weight: 1, ilvl: 1 };
  const Pjunk = Array.from({ length: 40 }, (_, i) => ({ key: "PJ" + i, type: "prefix", group: "GPJ" + i, weight: 1, ilvl: 1 }));
  const S1 = { key: "S1", type: "suffix", group: "GS", weight: 1, ilvl: 1 };
  const Sjunk = Array.from({ length: 40 }, (_, i) => ({ key: "SJ" + i, type: "suffix", group: "GSJ" + i, weight: 1, ilvl: 1 }));
  const tight = [P1, ...Pjunk, S1, ...Sjunk];
  const res = E.rankMethods(tight, ["GP", "GS"], { trials: 4000, seed: 5, chaosCap: 4 });
  const chaos = res.methods.find((m) => m.key === "chaos_spam");
  ok(chaos && chaos.impractical, "raw chaos spam that rarely completes is flagged impractical");
  // it must never rank above a practical method, and never be the ★ pick
  const star = res.methods.findIndex((m) => m.feasible && !m.impractical);
  ok(star === -1 || res.methods[star].key !== "chaos_spam", "impractical chaos spam is never the ★ pick");
  // once an impractical method appears, every method after it is also impractical (or infeasible)
  const firstImpract = res.methods.findIndex((m) => m.impractical);
  ok(firstImpract === -1 || res.methods.slice(firstImpract).every((m) => m.impractical || !m.feasible), "no practical method is sorted after an impractical one");

  // easy target: the only group in a 1-mod pool — every route completes, nothing impractical
  const easy = E.rankMethods([{ key: "E", type: "prefix", group: "GE", weight: 1, ilvl: 1 }], ["GE"], { trials: 2000, seed: 6 });
  ok(easy.methods.filter((m) => m.feasible).every((m) => !m.impractical), "an always-hittable target flags no method impractical");
}

// 5c) rankFinish: finishing a seeded item (keep current mods, add fills) beats crafting the same
//     full combo from scratch, and respects the cap budget already used by kept mods.
{
  const pool = [
    { key: "A", type: "prefix", group: "GA", weight: 100, ilvl: 1 },
    { key: "B", type: "prefix", group: "GB", weight: 100, ilvl: 1 },
    { key: "C", type: "suffix", group: "GC", weight: 100, ilvl: 1 },
    { key: "J", type: "prefix", group: "GJ", weight: 100, ilvl: 1 },
  ];
  const current = [{ group: "GA", type: "prefix" }, { group: "GC", type: "suffix" }];   // magic item, 2 good mods
  const fin = E.rankFinish(pool, current, ["GB"], { startRarity: "magic", trials: 8000, seed: 7 });
  ok(!fin.impossible && fin.methods.length && fin.methods[0].feasible, "rankFinish returns a feasible finish route");
  const finP = fin.methods[0].successPerAttempt;
  const scr = E.rankMethods(pool, ["GA", "GB", "GC"], { trials: 8000, seed: 7 }).methods.filter((m) => m.feasible)[0];
  ok(finP >= scr.successPerAttempt, `finishing (keep GA+GC, add GB) is easier than the full combo from scratch (${(finP * 100).toFixed(0)}% ≥ ${(scr.successPerAttempt * 100).toFixed(0)}%)`);
  // finish cost is per-attempt (not amortized by 1/p) — one item, no reroll. Regal counted once.
  ok(fin.methods[0].expectedOrbs.Regal === 1, "magic finish spends exactly one Regal (per-attempt cost, not 1/p)");
  // over-cap: 3 prefixes already used, adding another prefix is impossible
  const full = [{ group: "GA", type: "prefix" }, { group: "GB", type: "prefix" }, { group: "GJ", type: "prefix" }];
  const oc = E.rankFinish([...pool, { key: "D", type: "prefix", group: "GD", weight: 100, ilvl: 1 }], full, ["GD"], { startRarity: "rare", trials: 100 });
  ok(oc.impossible && oc.overCap, "adding a prefix with 3 prefixes already used → over-cap");
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

// 11) expectedOrbs = expected total spend to FIRST success (per-attempt average / p),
//     for spam-loop methods too — not the per-capped-attempt average.
{
  // easy: alchemy on the 3-mod pool always hits all 3 → p=1, cost exactly 1 Alchemy + 0 Chaos
  const r = E.rng(31);
  const easy = E.simulateChaosSpam(pool, ["GA", "GB", "GC"], 3000, 50, r);
  near(easy.successPerAttempt, 1.0, 0.001, "chaos-spam easy target: p=1");
  near(easy.expectedOrbs.Alchemy, 1.0, 0.001, "chaos-spam easy target: 1 Alchemy expected");
  near(easy.expectedOrbs.Chaos || 0, 0, 0.001, "chaos-spam easy target: 0 Chaos expected");

  // hard: 4 equal-weight prefix groups, rare caps at 3 → P(P1 on the item) = 3/4; cap=0
  // forbids chaos, so an attempt = 1 Alchemy and expected Alchemy MUST be 1/p ≈ 4/3.
  const quad = [
    { key: "p1", type: "prefix", group: "P1", weight: 1, ilvl: 1 },
    { key: "p2", type: "prefix", group: "P2", weight: 1, ilvl: 1 },
    { key: "p3", type: "prefix", group: "P3", weight: 1, ilvl: 1 },
    { key: "p4", type: "prefix", group: "P4", weight: 1, ilvl: 1 },
  ];
  const hard = E.simulateChaosSpam(quad, ["P1"], 50000, 0, r);
  near(hard.successPerAttempt, 0.75, 0.01, "chaos-spam cap-0: p = 3/4 (3 of 4 equal groups fit)");
  near(hard.expectedOrbs.Alchemy, 1 / hard.successPerAttempt, 1e-9, "chaos-spam expected Alchemy = 1/p (restart on cap-fail)");
  // whittling with a real chaos budget: Alchemy count still 1/p, and Chaos = perAttemptAvg/p
  const T = [{ group: "P1", keys: null, type: "prefix" }];
  const wh = E.simulateWhittling(quad, T, 20000, 3, r);
  near(wh.expectedOrbs.Alchemy, 1 / wh.successPerAttempt, 1e-9, "whittling expected Alchemy = 1/p");
  ok(wh.expectedOrbs.Chaos * wh.successPerAttempt <= 3 + 1e-9, "whittling per-attempt Chaos average stays within cap");
  ok(Math.abs(wh.expectedOrbs.Chaos - wh.expectedOrbs["Omen of Whittling"]) < 1e-9, "one Whittling omen per Chaos");
}

console.log(`craft-engine-test: ${pass} checks passed`);

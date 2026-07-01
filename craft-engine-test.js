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

console.log(`craft-engine-test: ${pass} checks passed`);

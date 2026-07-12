// craft-engine-test.js — self-check for the crafting PRIMITIVES. Tiny synthetic pools whose
// probabilities are hand-computable, so the mechanics (weighted combined pool, prefix/suffix caps,
// group exclusion, tier floors) are provably right rather than plausibly right.
//   node craft-engine-test.js
//
// Route/ranking behaviour used to be tested here too, back when craft-engine.js contained 13
// hand-written simulate*() routes. Those live in craft-plan.js now and are tested by
// craft-plan-test.js — including an equivalence check that pins the planner against the odds the
// old hand-written engine produced, so nothing was lost in the move.
const assert = require("assert");
const E = require("./craft-engine.js");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const near = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}: ${a.toFixed(4)} vs ${b} (±${tol})`); pass++; };

const A = { key: "A", type: "prefix", group: "GA", weight: 10, ilvl: 1, tags: ["ta"] };
const B = { key: "B", type: "prefix", group: "GB", weight: 30, ilvl: 1, tags: ["tb"] };
const C = { key: "C", type: "suffix", group: "GC", weight: 60, ilvl: 1, tags: ["ta"] };
const pool = [A, B, C];
const N = 100000;

// 1) A single weighted add: P(group present) == weight / totalWeight. This is THE odds model —
// both sides compete purely by weight, with no 50/50 prefix-vs-suffix coin flip first.
const rnd = E.rng(1);
function pAdd(target) {
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const it = E.newItem(); it.rarity = "magic"; E.addMod(it, pool, rnd);
    if (it.prefixes.concat(it.suffixes).some((m) => m.group === target)) hits++;
  }
  return hits / N;
}
near(pAdd("GA"), 0.10, 0.01, "add P(GA) = w10/100");
near(pAdd("GB"), 0.30, 0.01, "add P(GB) = w30/100");
near(pAdd("GC"), 0.60, 0.01, "add P(GC) = w60/100 (suffix competes by weight, no 50/50 side flip)");

// 2) Group exclusion + side caps: a Magic item carrying prefix A can only take suffix C next.
{
  const it = E.newItem(); it.rarity = "magic"; it.prefixes = [A];
  const added = E.addMod(it, pool, rnd);      // prefix side full (cap 1), GA present → only C is legal
  ok(added && it.suffixes.length === 1 && it.suffixes[0].group === "GC", "add on a full-prefix Magic picks the only legal suffix");
  const again = E.addMod(it, pool, rnd);      // both Magic slots now full → nothing is legal
  ok(again === false, "add returns FALSE when both Magic slots are full (the return value is load-bearing)");
}

// 3) A Rare can hold 3+3, but never two mods of the same group.
{
  const it = E.newItem(); it.rarity = "rare";
  for (let i = 0; i < 6; i++) E.addMod(it, pool, rnd);
  const groups = it.prefixes.concat(it.suffixes).map((m) => m.group);
  ok(groups.length === 3, "a 3-group pool fills exactly 3 slots on a Rare — group exclusion holds");
  ok(new Set(groups).size === groups.length, "no group appears twice on one item");
}

// 4) Tier floors (Greater/Perfect currency): minIlvl excludes low tiers entirely.
{
  const tiered = [
    { key: "lo", type: "prefix", group: "G1", weight: 100, ilvl: 1, tags: [] },
    { key: "hi", type: "prefix", group: "G1", weight: 100, ilvl: 60, tags: [] },
    { key: "hi2", type: "suffix", group: "G2", weight: 100, ilvl: 60, tags: [] },
  ];
  const r = E.rng(3);
  for (let i = 0; i < 500; i++) {
    const it = E.newItem(); it.rarity = "rare";
    E.addMod(it, tiered, r, null, 50);        // Perfect-tier floor
    const all = it.prefixes.concat(it.suffixes);
    assert.ok(all.every((m) => m.ilvl >= 50), "a minIlvl add rolled a mod below the floor");
  }
  pass++;
  const it = E.newItem(); it.rarity = "rare";
  ok(E.addMod(it, [{ key: "lo", type: "prefix", group: "G1", weight: 100, ilvl: 1, tags: [] }], E.rng(4), null, 50) === false,
    "a tier floor no mod clears adds nothing (rather than silently ignoring the floor)");
}

// 5) Tag-biased add (Homogenising / catalyst): restrictTags limits the pool to same-type mods.
{
  const r = E.rng(5);
  const it = E.newItem(); it.rarity = "rare"; it.prefixes = [A];   // A carries tag "ta"; so does C
  const added = E.addModBiased(it, pool, r, null, 0, new Set(["ta"]), null, 1);
  ok(added && it.suffixes.length === 1 && it.suffixes[0].group === "GC",
    "homogenising add is restricted to mods sharing a tag with the item (B has no shared tag, C does)");
  ok(E.itemTags(it).has("ta"), "itemTags reports the tags present on the item");
}

// 6) Whittling's removal: always takes the LOWEST-level mod (that is the whole point of the omen).
{
  const it = E.newItem(); it.rarity = "rare";
  it.prefixes = [{ key: "x", group: "GX", type: "prefix", ilvl: 5 }, { key: "y", group: "GY", type: "prefix", ilvl: 80 }];
  E.removeLowestIlvl(it);
  ok(it.prefixes.length === 1 && it.prefixes[0].ilvl === 80, "removeLowestIlvl protects the high tier and eats the low one");
}

// 7) Side-restricted removal (Sinistral/Dextral omens) never touches the other side.
{
  const it = E.newItem(); it.rarity = "rare";
  it.prefixes = [{ key: "p", group: "GP", type: "prefix", ilvl: 1 }];
  it.suffixes = [{ key: "s", group: "GS", type: "suffix", ilvl: 1 }];
  E.removeRandomOnSide(it, "prefix", E.rng(9));
  ok(it.prefixes.length === 0 && it.suffixes.length === 1, "a Sinistral removal takes a prefix and leaves the suffix alone");
}

console.log(`craft-engine-test: ${pass} checks passed`);

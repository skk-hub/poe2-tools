// craft-engine.js — Monte Carlo crafting simulator for PoE2 core currencies.
// Given a base's eligible mod pool + a set of target mod GROUPS, it simulates known
// crafting methods and reports success chance + expected currency spend. Zero-dep.
//
// Mechanics (PoE2 patch 0.5 "Runes of Aldur", sourced from maxroll's crafting overview +
// community consensus — NOT invented):
//   - Transmutation: Normal → Magic, +1 affix
//   - Augmentation:  +1 affix to a Magic item
//   - Regal:         Magic → Rare, +1 affix
//   - Alchemy:       Normal → Rare, +4 affixes
//   - Exalted:       +1 affix to a Rare item
//   - Chaos:         remove 1 random affix, add 1 random affix
//   - Annulment:     remove 1 random affix
//   Caps: Magic = 1 prefix + 1 suffix; Rare = 3 prefixes + 3 suffixes. No Alteration/Scour.
//
// Model (community/Craft-of-Exile standard): a newly-added affix is drawn from the COMBINED
// pool of all eligible affixes (both prefixes and suffixes that still have an open slot),
// weighted by spawn weight; a full side is excluded, a group already present is excluded.
// There is no 50/50 prefix/suffix coin-flip first — sides compete purely by weight.
// ponytail: this is the accepted model; if GGG's real algorithm differs, it's a data/model
// tweak here, not a rewrite.

const CAP = { normal: { prefix: 0, suffix: 0 }, magic: { prefix: 1, suffix: 1 }, rare: { prefix: 3, suffix: 3 } };

// Deterministic RNG (mulberry32) so tests are reproducible; server passes a random seed.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(cands, rnd) {
  let total = 0;
  for (const c of cands) total += c.weight;
  let r = rnd() * total;
  for (const c of cands) { r -= c.weight; if (r < 0) return c; }
  return cands[cands.length - 1];
}

function newItem() { return { rarity: "normal", prefixes: [], suffixes: [] }; }
function groupsOn(item) { const s = new Set(); for (const m of item.prefixes) s.add(m.group); for (const m of item.suffixes) s.add(m.group); return s; }

// Add one affix. typeFilter optionally restricts to "prefix"/"suffix". Returns true if added.
function addMod(item, mods, rnd, typeFilter) {
  const present = groupsOn(item);
  const cap = CAP[item.rarity];
  const cands = [];
  for (const m of mods) {
    if (typeFilter && m.type !== typeFilter) continue;
    if (present.has(m.group)) continue;
    if (m.type === "prefix" && item.prefixes.length >= cap.prefix) continue;
    if (m.type === "suffix" && item.suffixes.length >= cap.suffix) continue;
    cands.push(m);
  }
  if (!cands.length) return false;
  const pick = weightedPick(cands, rnd);
  (pick.type === "prefix" ? item.prefixes : item.suffixes).push(pick);
  return true;
}

function removeRandom(item, rnd) {
  const all = item.prefixes.concat(item.suffixes);
  if (!all.length) return false;
  const victim = all[Math.floor(rnd() * all.length)];
  item.prefixes = item.prefixes.filter((m) => m !== victim);
  item.suffixes = item.suffixes.filter((m) => m !== victim);
  return true;
}

function hasAllTargets(item, targetGroups) {
  const g = groupsOn(item);
  for (const t of targetGroups) if (!g.has(t)) return false;
  return true;
}

// ── methods ──────────────────────────────────────────────────────────────────
// Each "fresh" method crafts one item from a white base via a fixed recipe and returns
// { item, cost:{orb:count} }. The engine repeats it on new bases until success, so its
// expected total cost = perAttemptCost / successRate.
function craftFresh(recipe, mods, rnd) {
  const item = newItem();
  const cost = {};
  const bump = (orb) => { cost[orb] = (cost[orb] || 0) + 1; };
  for (const step of recipe) {
    if (step === "transmute") { item.rarity = "magic"; addMod(item, mods, rnd); bump("Transmutation"); }
    else if (step === "augment") { if (addMod(item, mods, rnd)) bump("Augmentation"); }        // only if a slot was open
    else if (step === "regal") { item.rarity = "rare"; addMod(item, mods, rnd); bump("Regal"); }
    else if (step === "alchemy") { item.rarity = "rare"; for (let i = 0; i < 4; i++) addMod(item, mods, rnd); bump("Alchemy"); }
    else if (step === "exalt") { if (addMod(item, mods, rnd)) bump("Exalted"); }                // only if a slot was open
  }
  return { item, cost };
}

const FRESH_METHODS = [
  { key: "alchemy", label: "Alchemy (reroll white bases)", recipe: ["alchemy"] },
  { key: "trans_regal_exalt", label: "Transmute → Regal → Exalt to 6", recipe: ["transmute", "augment", "regal", "exalt", "exalt", "exalt"] },
];

function simulateFresh(method, mods, targetGroups, trials, rnd) {
  let hits = 0;
  const costSum = {};
  for (let i = 0; i < trials; i++) {
    const { item, cost } = craftFresh(method.recipe, mods, rnd);
    if (hasAllTargets(item, targetGroups)) hits++;
    for (const k in cost) costSum[k] = (costSum[k] || 0) + cost[k];
  }
  const p = hits / trials;
  // expected orbs to first success = mean per-attempt orb count / p
  const expected = {};
  if (p > 0) for (const k in costSum) expected[k] = (costSum[k] / trials) / p;
  return { key: method.key, label: method.label, successPerAttempt: p, expectedOrbs: expected, feasible: p > 0 };
}

// Chaos spam: build one rare (Alchemy), then Chaos until all targets present or a cap.
// Reports success-within-cap and expected orb spend (1 Alchemy + avg Chaos among successes).
function simulateChaosSpam(mods, targetGroups, trials, cap, rnd) {
  let successes = 0, chaosSumOnSuccess = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    item.rarity = "rare";
    for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
    let n = 0, ok = hasAllTargets(item, targetGroups);
    while (!ok && n < cap) { const it2 = item; removeRandom(it2, rnd); addMod(it2, mods, rnd); n++; ok = hasAllTargets(it2, targetGroups); }
    if (ok) { successes++; chaosSumOnSuccess += n; }
  }
  const p = successes / trials;
  const avgChaos = successes ? chaosSumOnSuccess / successes : 0;
  return {
    key: "chaos_spam", label: "Alchemy, then Chaos spam", successPerAttempt: p,
    expectedOrbs: p > 0 ? { Alchemy: 1, Chaos: avgChaos } : {}, feasible: p > 0, cap,
  };
}

// Rank the known methods for hitting targetGroups on a base's mod pool.
function rankMethods(mods, targetGroups, opts) {
  opts = opts || {};
  const trials = opts.trials || 20000;
  const cap = opts.chaosCap || 200;
  const seed = (opts.seed >>> 0) || 12345;
  // reachability: every target group must exist in the pool at all, and the targets must
  // fit within 3 prefix / 3 suffix (can't hit 4 prefixes on one item).
  const byGroup = {}; for (const m of mods) (byGroup[m.group] = byGroup[m.group] || m);
  const missing = targetGroups.filter((g) => !byGroup[g]);
  let pfx = 0, sfx = 0; for (const g of targetGroups) { const m = byGroup[g]; if (m) (m.type === "prefix" ? pfx++ : sfx++); }
  const overCap = pfx > 3 || sfx > 3;
  if (missing.length || overCap) {
    return { impossible: true, missing, overCap, prefixTargets: pfx, suffixTargets: sfx, methods: [] };
  }
  const rnd = rng(seed);
  const methods = [];
  for (const m of FRESH_METHODS) methods.push(simulateFresh(m, mods, targetGroups, trials, rnd));
  methods.push(simulateChaosSpam(mods, targetGroups, trials, cap, rnd));
  // rank by total expected orb count (cheapest first); price-weighting is Phase 3.
  const totalOrbs = (r) => Object.values(r.expectedOrbs).reduce((s, n) => s + n, 0);
  methods.forEach((r) => { r.totalOrbs = r.feasible ? totalOrbs(r) : Infinity; });
  methods.sort((a, b) => a.totalOrbs - b.totalOrbs);
  return { impossible: false, prefixTargets: pfx, suffixTargets: sfx, trials, methods };
}

module.exports = { rng, weightedPick, addMod, removeRandom, hasAllTargets, craftFresh, simulateFresh, simulateChaosSpam, rankMethods, CAP, newItem };

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
// Below this per-attempt success a route is "impractical" — you'd reroll the whole item too
// many times for it to be a real plan (see rankMethods).
const PRACTICAL_MIN = 0.02;

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

// Add one affix. typeFilter optionally restricts to "prefix"/"suffix"; minIlvl (for
// Greater/Perfect tiered currency) requires the added mod's ilvl ≥ minIlvl (higher tiers).
// Hot path (called millions of times in a run) — no Set alloc, single-pass weighted pick.
function addMod(item, mods, rnd, typeFilter, minIlvl) {
  const cap = CAP[item.rarity];
  const prefFull = item.prefixes.length >= cap.prefix;
  const sufFull = item.suffixes.length >= cap.suffix;
  if (prefFull && sufFull) return false;
  const present = [];   // ≤6 groups — linear scan beats a Set here
  for (const m of item.prefixes) present.push(m.group);
  for (const m of item.suffixes) present.push(m.group);
  let total = 0; const cands = [];
  for (const m of mods) {
    if (typeFilter && m.type !== typeFilter) continue;
    if (minIlvl && m.ilvl < minIlvl) continue;
    if (m.type === "prefix" ? prefFull : sufFull) continue;
    if (present.indexOf(m.group) >= 0) continue;
    cands.push(m); total += m.weight;
  }
  if (!cands.length) return false;
  let r = rnd() * total, pick = cands[cands.length - 1];
  for (const c of cands) { r -= c.weight; if (r < 0) { pick = c; break; } }
  (pick.type === "prefix" ? item.prefixes : item.suffixes).push(pick);
  return true;
}

function removeRandom(item, rnd) {
  const np = item.prefixes.length, tot = np + item.suffixes.length;
  if (!tot) return false;
  const i = Math.floor(rnd() * tot);
  if (i < np) item.prefixes.splice(i, 1); else item.suffixes.splice(i - np, 1);
  return true;
}
// Remove the mod with the lowest item-level requirement (Omen of Whittling on a Chaos).
function removeLowestIlvl(item) {
  let arr = null, idx = -1, lo = Infinity;
  for (let i = 0; i < item.prefixes.length; i++) if (item.prefixes[i].ilvl < lo) { lo = item.prefixes[i].ilvl; arr = item.prefixes; idx = i; }
  for (let i = 0; i < item.suffixes.length; i++) if (item.suffixes[i].ilvl < lo) { lo = item.suffixes[i].ilvl; arr = item.suffixes; idx = i; }
  if (arr) arr.splice(idx, 1);
  return !!arr;
}
// Remove the lowest-ilvl mod on ONE side (Omen of Sinistral/Dextral Erasure on a Chaos).
function removeLowestIlvlOnSide(item, side) {
  const arr = side === "prefix" ? item.prefixes : item.suffixes;
  if (!arr.length) return false;
  let idx = 0, lo = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i].ilvl < lo) { lo = arr[i].ilvl; idx = i; }
  arr.splice(idx, 1); return true;
}
// Remove a random mod on ONE side (Omen of Sinistral/Dextral Annulment on an Annul).
function removeRandomOnSide(item, side, rnd) {
  const arr = side === "prefix" ? item.prefixes : item.suffixes;
  if (!arr.length) return false;
  arr.splice(Math.floor(rnd() * arr.length), 1); return true;
}
// The side of the first unmet target (for directing an omen), or null if all met.
function unmetSide(item, T) {
  for (const t of T) if (!targetMet(item, t)) return t.type;
  return null;
}
// Is a target satisfied on this item? (t carries .keys Set or null)
function targetMet(item, t) {
  for (const m of item.prefixes) if (m.group === t.group && (!t.keys || t.keys.has(m.key))) return true;
  for (const m of item.suffixes) if (m.group === t.group && (!t.keys || t.keys.has(m.key))) return true;
  return false;
}
// Fill toward unmet targets by directing each Exalt to that target's SIDE (Sinistral =
// prefix, Dextral = suffix Exaltation omens). minIlvl (Greater/Perfect tiered Exalts) biases
// the added mod to high tiers. Returns how many directed exalts were spent.
function directedFill(item, mods, T, rnd, maxEx, minIlvl) {
  let ex = 0;
  while (ex < maxEx) {
    let side = null;
    for (const t of T) {
      if (targetMet(item, t)) continue;
      if (t.type === "prefix" && item.prefixes.length < CAP.rare.prefix) { side = "prefix"; break; }
      if (t.type === "suffix" && item.suffixes.length < CAP.rare.suffix) { side = "suffix"; break; }
    }
    if (!side) break;                       // every unmet target's side is full → stuck
    if (!addMod(item, mods, rnd, side, minIlvl)) break;
    ex++;
  }
  return ex;
}

// A target is a group plus an optional set of acceptable tier keys. Accepts a bare
// string ("any tier of this group"), {group, keys:[...]}, or an already-normalized
// {group, keys:Set}. keys empty/absent = any tier counts.
function normalizeTargets(targets) {
  return targets.map((t) => {
    if (typeof t === "string") return { group: t, keys: null };
    let keys = t.keys;
    if (keys instanceof Set) keys = keys.size ? keys : null;
    else if (Array.isArray(keys)) keys = keys.length ? new Set(keys) : null;
    else keys = null;
    return { group: t.group, keys };
  });
}
// Item satisfies pre-normalized targets T (call normalizeTargets ONCE outside the loop).
function matches(item, T) {
  for (const t of T) {
    let ok = false;
    for (const m of item.prefixes) if (m.group === t.group && (!t.keys || t.keys.has(m.key))) { ok = true; break; }
    if (!ok) for (const m of item.suffixes) if (m.group === t.group && (!t.keys || t.keys.has(m.key))) { ok = true; break; }
    if (!ok) return false;
  }
  return true;
}
// Public convenience wrapper (normalizes each call) — used by tests.
function hasAllTargets(item, targets) { return matches(item, normalizeTargets(targets)); }

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
  const T = normalizeTargets(targetGroups);   // normalize once, not per trial
  let hits = 0;
  const costSum = {};
  for (let i = 0; i < trials; i++) {
    const { item, cost } = craftFresh(method.recipe, mods, rnd);
    if (matches(item, T)) hits++;
    for (const k in cost) costSum[k] = (costSum[k] || 0) + cost[k];
  }
  const p = hits / trials;
  // expected orbs to first success = mean per-attempt orb count / p
  const expected = {};
  if (p > 0) for (const k in costSum) expected[k] = (costSum[k] / trials) / p;
  return { key: method.key, label: method.label, successPerAttempt: p, expectedOrbs: expected, feasible: p > 0 };
}

// Chaos spam: build one rare (Alchemy), then Chaos until all targets present or a cap.
// An "attempt" = 1 Alchemy + up to `cap` Chaos; a capped-out attempt is scrapped and
// restarted on a fresh base. Spam-until-hit methods count ops over ALL trials (a trial
// that doesn't hit within `cap` spent `cap` ops), and expectedOrbs — like every other
// method — is the expected TOTAL spend until first success: per-attempt average / p.
function simulateChaosSpam(mods, targetGroups, trials, cap, rnd) {
  const T = normalizeTargets(targetGroups);   // normalize once, not per chaos step
  let successes = 0, chaosSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    item.rarity = "rare";
    for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
    let n = 0, ok = matches(item, T);
    while (!ok && n < cap) { removeRandom(item, rnd); addMod(item, mods, rnd); n++; ok = matches(item, T); }
    if (ok) successes++;
    chaosSum += n;
  }
  const p = successes / trials;
  return {
    key: "chaos_spam", label: "Alchemy, then Chaos spam", successPerAttempt: p,
    expectedOrbs: p > 0 ? { Alchemy: 1 / p, Chaos: (chaosSum / trials) / p } : {}, feasible: p > 0, cap,
  };
}

// Essence method: an essence GUARANTEES one specific mod for the item's class (only one
// essence per item), then you fill the rest. Sourced (maxroll/community, 0.5): Lesser/
// Normal/Greater upgrade rarity adding a guaranteed tagged mod; here we model the net
// result — a Rare carrying the guaranteed mod + up to 5 random fills — and cost it as
// 1 Essence + the fill Exalts (the exact lesser+regal vs greater split is a Phase-3
// price detail). An essence only helps a target if its guaranteed key is a tier you
// accepted; otherwise it occupies the group slot and BLOCKS your wanted tier, so we only
// use essences whose modKey satisfies the target.
// Which target to guarantee with an essence: the essence-available one hardest to hit
// randomly (lowest summed weight of its accepted tiers) → biggest payoff. Null if none.
function pickEssenceTarget(mods, T, essences) {
  if (!essences || !essences.length) return null;
  let best = null;
  for (const t of T) {
    const opts = essences.filter((e) => e.group === t.group && (!t.keys || t.keys.has(e.modKey)));
    if (!opts.length) continue;
    const gw = mods.filter((m) => m.group === t.group && (!t.keys || t.keys.has(m.key))).reduce((s, m) => s + m.weight, 0);
    if (!best || gw < best.gw) best = { opt: opts[0], gw };
  }
  return best ? best.opt : null;            // {name, modKey, group, type, stat}
}

function simulateEssence(mods, T, essences, trials, rnd) {
  const g = pickEssenceTarget(mods, T, essences);
  if (!g) return null;
  const guaranteed = { key: g.modKey, group: g.group, type: g.type, ilvl: 1 };
  let hits = 0, exaltSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem(); item.rarity = "rare";
    (guaranteed.type === "prefix" ? item.prefixes : item.suffixes).push(guaranteed);
    let ex = 0; for (let k = 0; k < 5; k++) if (addMod(item, mods, rnd)) ex++;
    if (matches(item, T)) hits++;
    exaltSum += ex;
  }
  const p = hits / trials;
  return {
    key: "essence", label: `${g.name} (guarantees ${g.stat}) + Exalt fill`, essenceName: g.name,
    successPerAttempt: p, expectedOrbs: p > 0 ? { Essence: 1 / p, Exalted: (exaltSum / trials) / p } : {},
    feasible: p > 0,
  };
}

// Omen of Whittling chaos spam: Alchemy, then Chaos that removes the LOWEST-ilvl mod each
// time (protects your high tiers) + adds one, until targets met or cap.
function simulateWhittling(mods, T, trials, cap, rnd) {
  let successes = 0, chaosSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem(); item.rarity = "rare";
    for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
    let n = 0, ok = matches(item, T);
    while (!ok && n < cap) { removeLowestIlvl(item); addMod(item, mods, rnd); n++; ok = matches(item, T); }
    if (ok) successes++;
    chaosSum += n;
  }
  const p = successes / trials, avg = chaosSum / trials;
  // expected total to first success (restart on cap-fail) = per-attempt average / p
  return {
    key: "whittling", label: "Alchemy, then Chaos + Omen of Whittling",
    successPerAttempt: p, expectedOrbs: p > 0 ? { Alchemy: 1 / p, Chaos: avg / p, "Omen of Whittling": avg / p } : {}, feasible: p > 0, cap,
  };
}

// Erasure chaos (Sinistral/Dextral Erasure omens): Chaos that removes the lowest-ilvl mod
// of a CHOSEN side + adds a new one — so you churn the side that still needs a target while
// PROTECTING the other side's hits (directed Whittling). Alchemy start, then churn to cap.
function simulateErasureChaos(mods, T, trials, cap, rnd) {
  let successes = 0, sum = 0;   // T is already normalized WITH .type by rankMethods
  for (let i = 0; i < trials; i++) {
    const item = newItem(); item.rarity = "rare";
    for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
    let n = 0, ok = matches(item, T);
    while (!ok && n < cap) {
      const side = unmetSide(item, T); if (!side) break;
      removeLowestIlvlOnSide(item, side); addMod(item, mods, rnd, side); n++; ok = matches(item, T);
    }
    if (ok) successes++;
    sum += n;
  }
  const p = successes / trials, avg = sum / trials;
  // expected total to first success (restart on cap-fail) = per-attempt average / p
  return {
    key: "erasure", label: "Alchemy, then Chaos + Erasure omens (protect a side)",
    successPerAttempt: p, expectedOrbs: p > 0 ? { Alchemy: 1 / p, Chaos: avg / p, "Erasure omen": avg / p } : {}, feasible: p > 0, cap,
  };
}

// Annul + Exalt (Sinistral/Dextral Annulment omens): when a target's side is FULL of junk,
// annul a mod off that side to open a slot, then directed-Exalt the target. Alchemy start.
// Annul removes a RANDOM mod on the side (may hit a mod you wanted) — the sim reflects that.
function simulateAnnulExalt(mods, T, trials, cap, rnd) {
  let successes = 0, exSum = 0, anSum = 0;   // T is already normalized WITH .type by rankMethods
  for (let i = 0; i < trials; i++) {
    const item = newItem(); item.rarity = "rare";
    for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
    let n = 0, ex = 0, an = 0, ok = matches(item, T);
    while (!ok && n < cap) {
      const side = unmetSide(item, T); if (!side) break;
      const full = side === "prefix" ? item.prefixes.length >= CAP.rare.prefix : item.suffixes.length >= CAP.rare.suffix;
      if (!full) { if (addMod(item, mods, rnd, side)) ex++; }         // directed Exalt toward the target
      else { removeRandomOnSide(item, side, rnd); an++; }             // directed Annul to open a slot
      n++; ok = matches(item, T);
    }
    if (ok) successes++;
    exSum += ex; anSum += an;                                          // count over ALL trials (failed spends count too)
  }
  const p = successes / trials;
  // expected total to first success (restart on cap-fail) = per-attempt average / p
  const orbs = p > 0 ? { Alchemy: 1 / p } : {};
  if (p > 0) {
    const ex = (exSum / trials) / p, an = (anSum / trials) / p;
    if (ex > 0) { orbs.Exalted = ex; orbs["Exaltation omen"] = ex; }
    if (an > 0) { orbs.Annulment = an; orbs["Annulment omen"] = an; }
  }
  return {
    key: "annul", label: "Alchemy, then Annul + Exalt (Annulment omens)",
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0, cap,
  };
}

// Directed Exalts (Sinistral/Dextral Exaltation omens): guarantee the hardest target with
// an essence when one's available (else start from a Regal), then aim each Exalt at an
// unmet target's side. cost = start orbs + (Exalt + Exaltation omen) per directed exalt.
function simulateDirected(mods, T, essences, trials, rnd) {
  const g = pickEssenceTarget(mods, T, essences);
  let hits = 0, exSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1 }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }   // transmute → regal
    exSum += directedFill(item, mods, T, rnd, 6);
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    orbs.Exalted = avgEx / p; orbs["Exaltation omen"] = avgEx / p;
  }
  return {
    key: "directed", label: g ? `${g.name} + directed Exalts (Exaltation omens)` : "Regal → directed Exalts (Exaltation omens)",
    essenceName: g ? g.name : undefined,
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Lowest ilvl among the mods a target ACCEPTS (its selected tiers, or all tiers of the
// group). If every target only accepts high-ilvl tiers, tiered currency (Greater min-35 /
// Perfect min-50 Exalts) can bias fills to those tiers without making the target unreachable.
function targetMinIlvl(mods, t) {
  let lo = Infinity;
  for (const m of mods) { if (m.group !== t.group) continue; if (t.keys && !t.keys.has(m.key)) continue; if (m.ilvl < lo) lo = m.ilvl; }
  return lo === Infinity ? 0 : lo;
}
// Tiered Exalt fill (Greater min-35 / Perfect min-50): guarantee the hardest target with an
// essence when possible (else Regal start), then fill with tiered Exalts so added mods are
// high-tier. Only offered when EVERY target accepts a tier ≥35 (else tiered can't help and
// would just cost more) — so it self-activates exactly for high-tier goals.
function simulateTiered(mods, T, essences, trials, rnd) {
  const floor = T.length ? Math.min(...T.map((t) => targetMinIlvl(mods, t))) : 0;
  let tier = null;
  if (floor >= 50) tier = { key: "Perfect Exalted", min: 50 };
  else if (floor >= 35) tier = { key: "Greater Exalted", min: 35 };
  else return null;
  const g = pickEssenceTarget(mods, T, essences);
  let hits = 0, exSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1 }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }
    exSum += directedFill(item, mods, T, rnd, 6, tier.min);   // directed + tiered = aim high-tier mods at the right side
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    orbs[tier.key] = avgEx / p; orbs["Exaltation omen"] = avgEx / p;   // each directed tiered exalt = 1 tiered Exalt + 1 Exaltation omen
  }
  return {
    key: "tiered", label: (g ? `${g.name} + ` : "Regal → ") + `directed ${tier.key} (high tiers)`,
    essenceName: g ? g.name : undefined, successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Rank the known methods for hitting targetGroups on a base's mod pool.
function rankMethods(mods, targetGroups, opts) {
  opts = opts || {};
  const trials = opts.trials || 5000;    // ±~0.7% at p=0.5 — fine for a whole-% display; 4 spam loops × cap keep it bounded
  const cap = opts.chaosCap || 120;
  const seed = (opts.seed >>> 0) || 12345;
  // reachability: every target group must exist in the pool, any selected tier must be
  // available at this item level, and targets must fit within 3 prefix / 3 suffix.
  const T = normalizeTargets(targetGroups);
  const byGroup = {}; for (const m of mods) (byGroup[m.group] = byGroup[m.group] || m);
  const keysInPool = new Set(mods.map((m) => m.key));
  const missing = [];
  for (const t of T) {
    if (!byGroup[t.group]) { missing.push(t.group); continue; }
    if (t.keys) { let any = false; for (const k of t.keys) if (keysInPool.has(k)) { any = true; break; } if (!any) missing.push(t.group + " (selected tier needs a higher item level)"); }
  }
  let pfx = 0, sfx = 0; for (const t of T) { const m = byGroup[t.group]; if (m) { t.type = m.type; (m.type === "prefix" ? pfx++ : sfx++); } }
  const overCap = pfx > 3 || sfx > 3;
  if (missing.length || overCap) {
    return { impossible: true, missing, overCap, prefixTargets: pfx, suffixTargets: sfx, methods: [] };
  }
  const rnd = rng(seed);
  const methods = [];
  for (const m of FRESH_METHODS) methods.push(simulateFresh(m, mods, targetGroups, trials, rnd));
  methods.push(simulateChaosSpam(mods, targetGroups, trials, cap, rnd));
  methods.push(simulateWhittling(mods, T, trials, cap, rnd));          // Omen of Whittling
  methods.push(simulateErasureChaos(mods, T, trials, cap, rnd));       // Sinistral/Dextral Erasure
  methods.push(simulateAnnulExalt(mods, T, trials, cap, rnd));         // Sinistral/Dextral Annulment
  methods.push(simulateDirected(mods, T, opts.essences, trials, rnd)); // Exaltation omens
  const ess = simulateEssence(mods, T, opts.essences, trials, rnd);    // essence, undirected (no omens)
  if (ess) methods.push(ess);
  const tiered = simulateTiered(mods, T, opts.essences, trials, rnd);  // Greater/Perfect Exalt fill (high-tier targets only)
  if (tiered) methods.push(tiered);
  // rank by total expected orb count (cheapest first); price-weighting is Phase 3.
  const totalOrbs = (r) => Object.values(r.expectedOrbs).reduce((s, n) => s + n, 0);
  // "Impractical": a route that completes on <2% of fresh bases means you'd reroll the WHOLE
  // item 50+ times, scrapping expensive currency each miss — the reported expected cost is a
  // cap/p extrapolation nobody actually runs (this is the "0.02%, 120 chaos" chaos-spam the
  // user flagged). Flag it, sink it below realistic routes, and never let it be the ★ pick.
  // Cheap fresh rerolls (Alchemy) at low % are fine — but at <2% even those are absurd, so a
  // flat success floor is the honest line. ponytail: naive threshold; tune PRACTICAL_MIN if the
  // cutoff feels wrong for a specific goal.
  methods.forEach((r) => { r.totalOrbs = r.feasible ? totalOrbs(r) : Infinity; r.impractical = r.feasible && r.successPerAttempt < PRACTICAL_MIN; });
  methods.sort((a, b) => (a.impractical ? 1 : 0) - (b.impractical ? 1 : 0) || a.totalOrbs - b.totalOrbs);
  return { impossible: false, prefixTargets: pfx, suffixTargets: sfx, trials, methods };
}

module.exports = { rng, weightedPick, addMod, removeRandom, removeLowestIlvl, removeLowestIlvlOnSide, removeRandomOnSide, directedFill, hasAllTargets, craftFresh, simulateFresh, simulateChaosSpam, simulateEssence, simulateWhittling, simulateErasureChaos, simulateAnnulExalt, simulateDirected, rankMethods, CAP, newItem };

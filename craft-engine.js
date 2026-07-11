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

// Tag-biased add (for Omen of Homogenising Exaltation and catalyst-directed Exalts). Same as
// addMod but: restrictTags (Set) limits candidates to mods sharing ≥1 tag with it (homogenising
// = "add a mod of the same type as an existing mod"); boostTags (Set) multiplies matching mods'
// weight by boostMult (catalyst quality biasing a mod type). Both optional; needs mods to carry
// .tags (craftModList supplies them; synthetic/tag-less pools simply get no bias).
function addModBiased(item, mods, rnd, typeFilter, minIlvl, restrictTags, boostTags, boostMult) {
  const cap = CAP[item.rarity];
  const prefFull = item.prefixes.length >= cap.prefix, sufFull = item.suffixes.length >= cap.suffix;
  if (prefFull && sufFull) return false;
  const present = [];
  for (const m of item.prefixes) present.push(m.group);
  for (const m of item.suffixes) present.push(m.group);
  const cands = []; let total = 0;
  for (const m of mods) {
    if (typeFilter && m.type !== typeFilter) continue;
    if (minIlvl && m.ilvl < minIlvl) continue;
    if (m.type === "prefix" ? prefFull : sufFull) continue;
    if (present.indexOf(m.group) >= 0) continue;
    const tags = m.tags || [];
    if (restrictTags) { let ok = false; for (const tg of tags) if (restrictTags.has(tg)) { ok = true; break; } if (!ok) continue; }
    let w = m.weight;
    if (boostTags) for (const tg of tags) if (boostTags.has(tg)) { w *= boostMult; break; }
    cands.push({ m, w }); total += w;
  }
  if (!cands.length) return false;
  let r = rnd() * total, pick = cands[cands.length - 1].m;
  for (const c of cands) { r -= c.w; if (r < 0) { pick = c.m; break; } }
  (pick.type === "prefix" ? item.prefixes : item.suffixes).push(pick);
  return true;
}
// Union of tags across all mods currently on the item (the "types present" for homogenising).
function itemTags(item) {
  const s = new Set();
  for (const m of item.prefixes) for (const t of (m.tags || [])) s.add(t);
  for (const m of item.suffixes) for (const t of (m.tags || [])) s.add(t);
  return s;
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
// Remove a random mod that is NOT fractured (a fractured mod is locked in place and can't be
// removed by Chaos/Annul). Used by the Fracturing Orb method below.
function removeRandomUnfractured(item, rnd) {
  const pool = [];
  for (let i = 0; i < item.prefixes.length; i++) if (!item.prefixes[i].fractured) pool.push(item.prefixes, i);
  for (let i = 0; i < item.suffixes.length; i++) if (!item.suffixes[i].fractured) pool.push(item.suffixes, i);
  if (!pool.length) return false;
  const j = Math.floor(rnd() * (pool.length / 2)) * 2;   // pairs of (arr, idx)
  pool[j].splice(pool[j + 1], 1);
  return true;
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
  let ex = 0, omens = 0;
  while (ex < maxEx) {
    let side = null;
    for (const t of T) {
      if (targetMet(item, t)) continue;
      if (t.type === "prefix" && item.prefixes.length < CAP.rare.prefix) { side = "prefix"; break; }
      if (t.type === "suffix" && item.suffixes.length < CAP.rare.suffix) { side = "suffix"; break; }
    }
    if (!side) break;                       // every unmet target's side is full → stuck
    // An Exaltation omen only STEERS the exalt when the OTHER side still has an open slot (a
    // plain Exalt could stray there). If the other side is already full, a plain Exalted Orb is
    // forced onto the target side — no omen needed. (This is why a full-prefix item finishing a
    // suffix wants a bare Exalt, not Omen of Dextral Exaltation.)
    const otherFull = side === "prefix" ? item.suffixes.length >= CAP.rare.suffix : item.prefixes.length >= CAP.rare.prefix;
    if (!otherFull) omens++;
    if (!addMod(item, mods, rnd, side, minIlvl)) break;
    ex++;
  }
  return { ex, omens };
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

// Fracturing Orb (PoE2 0.5, poe2db): fractures a RANDOM modifier on a Rare item with at
// least 4 modifiers, locking it so Chaos/Annul can't remove it. Faithful play: Alch cheaply
// until a target mod appears, spend ONE Fracturing Orb (random — it may lock a target or
// junk), and only proceed when it locked a target; then Chaos-reroll the unfractured slots to
// hit the rest, protected by the lock. The random fracture landing on junk is the real cost,
// so it's reflected in the success rate rather than assumed away.
function simulateFracture(mods, targetGroups, trials, cap, rnd) {
  const T = normalizeTargets(targetGroups);
  let successes = 0, alchSum = 0, chaosSum = 0, fracSum = 0;
  for (let i = 0; i < trials; i++) {
    let item = null, alchs = 0, present = false;
    do {                                            // cheap Alch until at least one target shows
      item = newItem(); item.rarity = "rare";
      for (let k = 0; k < 4; k++) addMod(item, mods, rnd);
      alchs++;
      present = T.some((t) => targetMet(item, t));
    } while (!present && alchs < 20);
    alchSum += alchs;
    if (!present) continue;                         // no target after 20 alchs → give up this trial
    const all = item.prefixes.concat(item.suffixes);
    if (all.length < 4) continue;                   // Fracturing needs a 4+ mod rare
    const f = all[Math.floor(rnd() * all.length)];  // fracture a RANDOM mod (can't be chosen)
    f.fractured = true; fracSum++;
    const lockedTarget = T.some((t) => f.group === t.group && (!t.keys || t.keys.has(f.key)));
    let n = 0, ok = matches(item, T);
    if (lockedTarget) {                             // only worth continuing if the lock caught a target
      while (!ok && n < cap) { removeRandomUnfractured(item, rnd); addMod(item, mods, rnd); n++; ok = matches(item, T); }
    }
    chaosSum += n;
    if (ok && lockedTarget) successes++;
  }
  const p = successes / trials;
  return {
    key: "fracture", label: "Alchemy → Fracturing Orb (lock a hit) → Chaos the rest",
    successPerAttempt: p,
    expectedOrbs: p > 0 ? { Alchemy: (alchSum / trials) / p, "Fracturing Orb": (fracSum / trials) / p, Chaos: (chaosSum / trials) / p } : {},
    feasible: p > 0, cap,
  };
}

// Directed Exalts (Sinistral/Dextral Exaltation omens): guarantee the hardest target with
// an essence when one's available (else start from a Regal), then aim each Exalt at an
// unmet target's side. cost = start orbs + (Exalt + Exaltation omen) per directed exalt.
function simulateDirected(mods, T, essences, trials, rnd) {
  const g = pickEssenceTarget(mods, T, essences);
  let hits = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1 }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }   // transmute → regal
    const r = directedFill(item, mods, T, rnd, 6);
    exSum += r.ex; omenSum += r.omens;
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials, avgOmen = omenSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    orbs.Exalted = avgEx / p; if (avgOmen > 0) orbs["Exaltation omen"] = avgOmen / p;
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
  let hits = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1 }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }
    const r = directedFill(item, mods, T, rnd, 6, tier.min);   // directed + tiered = aim high-tier mods at the right side
    exSum += r.ex; omenSum += r.omens;
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials, avgOmen = omenSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    orbs[tier.key] = avgEx / p; if (avgOmen > 0) orbs["Exaltation omen"] = avgOmen / p;   // each STEERED tiered exalt = 1 tiered Exalt + 1 Exaltation omen (none when the other side is full)
  }
  return {
    key: "tiered", label: (g ? `${g.name} + ` : "Regal → ") + `directed ${tier.key} (high tiers)`,
    essenceName: g ? g.name : undefined, successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Tags a target group can carry (union over its accepted tiers in the pool).
function targetTags(mods, t) {
  const s = new Set();
  for (const m of mods) { if (m.group !== t.group) continue; if (t.keys && !t.keys.has(m.key)) continue; for (const tg of (m.tags || [])) s.add(tg); }
  return s;
}
function poolTagsForGroup(mods, group) { for (const m of mods) if (m.group === group) return m.tags || []; return []; }

// Homogenising fill: each Exalt is an Omen of Homogenising Exaltation — the added mod must share
// a tag ("type") with a mod already on the item. Directed to the unmet target's side.
function homogenisedFill(item, mods, T, rnd, maxEx) {
  let ex = 0, omens = 0;
  while (ex < maxEx) {
    let side = null;
    for (const t of T) {
      if (targetMet(item, t)) continue;
      if (t.type === "prefix" && item.prefixes.length < CAP.rare.prefix) { side = "prefix"; break; }
      if (t.type === "suffix" && item.suffixes.length < CAP.rare.suffix) { side = "suffix"; break; }
    }
    if (!side) break;
    const tags = itemTags(item);
    const ok = tags.size ? addModBiased(item, mods, rnd, side, 0, tags, null, 1) : addMod(item, mods, rnd, side);
    if (!ok) break;
    ex++; omens++;
  }
  return { ex, omens };
}

// Omen of Homogenising Exaltation (PoE2 0.5, poe2db): the Exalt adds a mod of the same TYPE (tag)
// as one already on the item. Only worthwhile when the targets are tag-clustered (share a tag) —
// once one is on, homogenising exalts hit the others far more often. Anchor the hardest target
// (essence if available, else Regal), then homogenised-exalt the rest.
function simulateHomogenising(mods, T, essences, trials, rnd) {
  const tagSets = T.map((t) => targetTags(mods, t));
  let clustered = false;
  for (let a = 0; a < tagSets.length && !clustered; a++)
    for (let b = a + 1; b < tagSets.length && !clustered; b++)
      for (const tg of tagSets[a]) if (tagSets[b].has(tg)) { clustered = true; break; }
  if (!clustered) return null;                              // no shared type → homogenising can't help
  const g = pickEssenceTarget(mods, T, essences);
  let hits = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1, tags: poolTagsForGroup(mods, g.group) }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }
    const r = homogenisedFill(item, mods, T, rnd, 6);
    exSum += r.ex; omenSum += r.omens;
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials, avgOmen = omenSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    if (avgEx > 0) { orbs.Exalted = avgEx / p; if (avgOmen > 0) orbs["Homogenising omen"] = avgOmen / p; }
  }
  return {
    key: "homogenising", essenceName: g ? g.name : undefined,
    label: (g ? `${g.name} + ` : "Regal → ") + "Homogenising Exalts (same-type mods)",
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Catalyst-directed Exalts (PoE2 0.5): a catalyst adds quality to a ring/amulet that biases a mod
// TYPE (tag), and Omen of Catalysing Exaltation makes the Exalt spend that quality to favour it.
// Modeled as a weight boost on the catalysed tag during a directed fill (jewellery only). Unlike
// homogenising it needs no same-type anchor, so it helps the FIRST mod of a type too.
// ponytail: CAT_MULT is a heuristic for ~20% catalyst quality; tune if GGG's real weighting surfaces.
const CAT_MULT = 3;
function simulateCatalyst(mods, T, essences, trials, rnd, jewellery) {
  if (!jewellery) return null;
  let hardest = null, lo = Infinity;                       // catalyse the rarest target's tag = biggest payoff
  for (const t of T) {
    const tags = targetTags(mods, t); if (!tags.size) continue;
    const w = mods.filter((m) => m.group === t.group && (!t.keys || t.keys.has(m.key))).reduce((s, m) => s + m.weight, 0);
    if (w < lo) { lo = w; hardest = tags; }
  }
  if (!hardest) return null;
  const g = pickEssenceTarget(mods, T, essences);
  let hits = 0, exSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem();
    if (g) { item.rarity = "rare"; (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1, tags: poolTagsForGroup(mods, g.group) }); }
    else { item.rarity = "magic"; addMod(item, mods, rnd); item.rarity = "rare"; addMod(item, mods, rnd); }
    let ex = 0;
    while (ex < 6) {
      let side = null;
      for (const t of T) {
        if (targetMet(item, t)) continue;
        if (t.type === "prefix" && item.prefixes.length < CAP.rare.prefix) { side = "prefix"; break; }
        if (t.type === "suffix" && item.suffixes.length < CAP.rare.suffix) { side = "suffix"; break; }
      }
      if (!side) break;
      if (!addModBiased(item, mods, rnd, side, 0, null, hardest, CAT_MULT)) break;
      ex++;
    }
    exSum += ex; if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials;
  const orbs = {};
  if (p > 0) {
    if (g) orbs.Essence = 1 / p; else { orbs.Transmutation = 1 / p; orbs.Regal = 1 / p; }
    if (avgEx > 0) { orbs.Exalted = avgEx / p; orbs.Catalyst = avgEx / p; orbs["Catalysing omen"] = avgEx / p; }
  }
  return {
    key: "catalyst", essenceName: g ? g.name : undefined,
    label: (g ? `${g.name} + ` : "Regal → ") + "Catalyst-directed Exalts (bias a mod type)",
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Desecration (PoE2 0.5, poe2db: Abyssal Bones + Well of Souls). A desecrated TARGET carries
// { desecrated:true, group, type, poolN } — poolN = estimated reveal-pool size (faction mods
// eligible on the base). Each bone reveals 3 and you pick 1, so P(target shown) ≈ min(1, 3/poolN);
// a miss is removed with Orb of Annulment + Omen of Light and re-desecrated. Normal targets are
// filled with directed Exalts alongside. Odds are an ESTIMATE — poe2db gives no per-base reveal
// weights (the data note says so); this models the structure, not exact weights.
function simulateDesecration(mods, T, trials, rnd) {
  const des = T.filter((t) => t.desecrated);
  if (!des.length) return null;
  const norm = T.filter((t) => !t.desecrated);
  const cap = 40;
  let hits = 0, boneSum = 0, lightSum = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = newItem(); item.rarity = "rare";
    let ok = true, bones = 0, lights = 0;
    for (const dt of des) {
      let got = false, n = 0;
      const pRe = Math.min(1, 3 / Math.max(3, dt.poolN || 30));
      while (n < cap) {
        const full = dt.type === "prefix" ? item.prefixes.length >= CAP.rare.prefix : item.suffixes.length >= CAP.rare.suffix;
        if (full) break;
        bones++;
        if (rnd() < pRe) { (dt.type === "prefix" ? item.prefixes : item.suffixes).push({ group: dt.group, type: dt.type, key: dt.key || dt.group, ilvl: 1, desecrated: true }); got = true; break; }
        lights++;              // miss → Orb of Annulment + Omen of Light removes it, re-desecrate
        n++;
      }
      if (!got) { ok = false; break; }
    }
    if (ok) { const r = directedFill(item, mods, norm, rnd, 6); exSum += r.ex; omenSum += r.omens; }
    boneSum += bones; lightSum += lights;
    if (ok && matches(item, T)) hits++;
  }
  const p = hits / trials;
  const orbs = {};
  if (p > 0) {
    orbs["Abyssal Bone"] = (boneSum / trials) / p;
    if (lightSum > 0) { orbs.Annulment = (lightSum / trials) / p; orbs["Omen of Light"] = (lightSum / trials) / p; }
    if (exSum > 0) { orbs.Exalted = (exSum / trials) / p; if (omenSum > 0) orbs["Exaltation omen"] = (omenSum / trials) / p; }
  }
  return {
    key: "desecration", estimate: true,
    label: "Desecrate (Well of Souls: reveal 3, pick 1) — remove misses with Annul + Omen of Light",
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// ── Finish an EXISTING item ────────────────────────────────────────────────
// The Craft Advisor path: instead of crafting from a white base, KEEP the mods already on a
// pasted Magic/Rare item and only ADD the fill targets. Seed a rare item with the current mods
// (they self-satisfy their own groups), then Regal (if it was Magic) + directed Exalts toward the
// fills. This is simulateDirected with a pre-seeded item — no new mechanics.
function seedItem(currentMods) {
  const item = newItem(); item.rarity = "rare";
  for (const m of (currentMods || [])) {
    const side = m.type === "prefix" ? item.prefixes : item.suffixes;
    side.push({ group: m.group, type: m.type, key: m.key || null, ilvl: m.ilvl || 1 });
  }
  return item;
}
const cloneItem = (it) => ({ rarity: it.rarity, prefixes: it.prefixes.slice(), suffixes: it.suffixes.slice() });

// One finish variant. startRarity "magic" spends a Regal (adds 1 RANDOM mod — may waste a slot,
// modeled) before the directed fill; "rare" fills directly. tier = minIlvl for Greater(35)/
// Perfect(50) Exalt fills (0 = plain Exalted). Cost mirrors simulateDirected.
function simulateFinish(seed, mods, T, trials, rnd, startRarity, tier, key, label) {
  let hits = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = cloneItem(seed);
    if (startRarity === "magic") addMod(item, mods, rnd);          // Regal: one undirected add
    const r = directedFill(item, mods, T, rnd, 6, tier || 0);      // directed Exalts toward unmet fills
    exSum += r.ex; omenSum += r.omens;
    if (matches(item, T)) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials, avgOmen = omenSum / trials;
  // expectedOrbs = AMORTIZED cost = expected orbs to end up WITH the finished item, retrying on
  // fresh (cheap) magic/rare bases when an attempt bricks (÷p). That's the number that compares to
  // the resale/buy price. successPerAttempt is kept as the ONE-SHOT chance (per-item brick risk).
  const orbs = {};
  if (p > 0) {
    if (startRarity === "magic") orbs.Regal = 1 / p;
    const exKey = tier >= 50 ? "Perfect Exalted" : tier >= 35 ? "Greater Exalted" : "Exalted";
    // Omen only when the exalt actually needed steering (other side open); a full opposite side
    // makes a plain Exalt forced onto the target, so no Exaltation omen is charged.
    if (avgEx > 0) { orbs[exKey] = avgEx / p; if (avgOmen > 0) orbs["Exaltation omen"] = avgOmen / p; }
  }
  return { key, label, successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0 };
}

// Finish variant that REROLLS a jammed side: when the target's side is full of junk (an unwanted
// mod took the slot), directed-Annul (Sinistral/Dextral Annulment omen) opens it, then re-Exalt.
// Because annul removes a RANDOM mod ON THAT SIDE, it can destroy a KEPT good mod — so here T
// includes the kept groups too (losing one = failure). Much higher one-shot success than pure
// Exalt (you get repeated tries on the same item), at the cost of annuls + omens + the brick risk.
function simulateFinishAnnul(seed, mods, Tall, trials, rnd, startRarity, cap) {
  let hits = 0, exSum = 0, anSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = cloneItem(seed);
    if (startRarity === "magic") addMod(item, mods, rnd);              // Regal
    let n = 0, ok = matches(item, Tall);
    while (!ok && n < cap) {
      const side = unmetSide(item, Tall); if (!side) break;
      const full = side === "prefix" ? item.prefixes.length >= CAP.rare.prefix : item.suffixes.length >= CAP.rare.suffix;
      if (!full) {
        const otherFull = side === "prefix" ? item.suffixes.length >= CAP.rare.suffix : item.prefixes.length >= CAP.rare.prefix;
        if (addMod(item, mods, rnd, side)) { exSum++; if (!otherFull) omenSum++; }   // directed Exalt (omen only when the other side is open)
      }
      else { removeRandomOnSide(item, side, rnd); anSum++; }            // directed Annul to unjam the side (may hit a kept mod)
      n++; ok = matches(item, Tall);
    }
    if (ok) hits++;
  }
  const p = hits / trials, avgEx = exSum / trials, avgAn = anSum / trials, avgOmen = omenSum / trials;
  const orbs = {};                                                     // amortized (÷p), like simulateFinish
  if (p > 0) {
    if (startRarity === "magic") orbs.Regal = 1 / p;
    if (avgEx > 0) { orbs.Exalted = avgEx / p; if (avgOmen > 0) orbs["Exaltation omen"] = avgOmen / p; }
    if (avgAn > 0) { orbs.Annulment = avgAn / p; orbs["Annulment omen"] = avgAn / p; }
  }
  return { key: "finish_annul", label: "Regal + Annul/Exalt with omens (reroll a jammed side)", successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0 };
}

// Essence finish (PoE2 0.5, poe2db): guarantee a still-missing fill target with an essence
// instead of fishing for it with Exalts. On a RARE start a **Perfect** essence removes a random
// modifier and adds the guaranteed one (the removal can destroy a kept mod → reflected as a
// failure); on a MAGIC start a normal essence upgrades to Rare and adds it (no removal). Then
// directed-Exalt the rest. Tall = kept groups + fills (losing a kept mod = failure).
function simulateFinishEssence(seed, mods, T, Tall, essences, trials, rnd, startRarity) {
  const perfect = startRarity === "rare";
  const pool = (essences || []).filter((e) => perfect === /^Perfect\b/i.test(e.name));
  const g = pickEssenceTarget(mods, T, pool);         // hardest-to-hit fill an essence can force
  if (!g) return null;
  let hits = 0, exSum = 0, omenSum = 0;
  for (let i = 0; i < trials; i++) {
    const item = cloneItem(seed);
    if (perfect) {
      removeRandom(item, rnd);                         // Perfect essence removes a random mod first
      const side = g.type;
      const full = side === "prefix" ? item.prefixes.length >= CAP.rare.prefix : item.suffixes.length >= CAP.rare.suffix;
      if (full) removeRandomOnSide(item, side, rnd);   // ensure room on the guaranteed mod's side
    } else { item.rarity = "rare"; }                   // normal essence: Magic → Rare, no removal
    (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1 });
    const r = directedFill(item, mods, T, rnd, 6);
    exSum += r.ex; omenSum += r.omens;
    if (matches(item, Tall)) hits++;                   // must still carry every kept mod + fill
  }
  const p = hits / trials, avgEx = exSum / trials, avgOmen = omenSum / trials;
  const orbs = {};
  if (p > 0) {
    orbs.Essence = 1 / p;
    if (avgEx > 0) { orbs.Exalted = avgEx / p; if (avgOmen > 0) orbs["Exaltation omen"] = avgOmen / p; }
  }
  return {
    key: "finish_essence", essenceName: g.name,
    label: `${g.name} (guarantees ${g.stat}) + directed Exalts`,
    successPerAttempt: p, expectedOrbs: orbs, feasible: p > 0,
  };
}

// Rank ways to FINISH currentMods into (currentMods + fill targets). fillGroups = the NEW target
// groups to add. opts: {startRarity:"magic"|"rare", trials, seed, finishCap}. Returns the same shape
// as rankMethods (impossible / methods[] with impractical + totalOrbs), so the UI renders it identically.
function rankFinish(mods, currentMods, fillGroups, opts) {
  opts = opts || {};
  const trials = opts.trials || 5000;
  const seed = (opts.seed >>> 0) || 12345;
  const startRarity = opts.startRarity === "magic" ? "magic" : "rare";
  const T = normalizeTargets(fillGroups);
  const byGroup = {}; for (const m of mods) (byGroup[m.group] = byGroup[m.group] || m);
  const keysInPool = new Set(mods.map((m) => m.key));
  const missing = [];
  for (const t of T) {
    if (!byGroup[t.group]) { missing.push(t.group); continue; }
    if (t.keys) { let any = false; for (const k of t.keys) if (keysInPool.has(k)) { any = true; break; } if (!any) missing.push(t.group + " (selected tier needs a higher item level)"); }
  }
  // fill targets take a side each; kept mods already occupy slots → check against the FREE budget.
  let fillP = 0, fillS = 0; for (const t of T) { const m = byGroup[t.group]; if (m) { t.type = m.type; (m.type === "prefix" ? fillP++ : fillS++); } }
  const usedP = (currentMods || []).filter((m) => m.type === "prefix").length;
  const usedS = (currentMods || []).filter((m) => m.type === "suffix").length;
  const overCap = fillP > (CAP.rare.prefix - usedP) || fillS > (CAP.rare.suffix - usedS);
  if (missing.length || overCap) return { impossible: true, missing, overCap, prefixTargets: fillP, suffixTargets: fillS, methods: [] };

  const rnd = rng(seed);
  const seeded = seedItem(currentMods);
  const methods = [simulateFinish(seeded, mods, T, trials, rnd, startRarity, 0, "finish", "Regal + directed Exalts (Exaltation omens)")];
  // Tiered variant, only when every fill accepts a high tier (else it can't help — same gate as simulateTiered).
  const floor = T.length ? Math.min(...T.map((t) => targetMinIlvl(mods, t))) : 0;
  if (floor >= 50) methods.push(simulateFinish(seeded, mods, T, trials, rnd, startRarity, 50, "finish_perfect", "Regal + directed Perfect Exalted (high tiers)"));
  else if (floor >= 35) methods.push(simulateFinish(seeded, mods, T, trials, rnd, startRarity, 35, "finish_greater", "Regal + directed Greater Exalted (high tiers)"));
  // Annul/Exalt reroll: T includes the KEPT groups (annul can destroy them). typeOf resolves each
  // group's side from the pool, falling back to the kept mod's own type.
  const typeOf = {}; for (const m of mods) if (!(m.group in typeOf)) typeOf[m.group] = m.type; for (const m of (currentMods || [])) typeOf[m.group] = m.type;
  const Tall = normalizeTargets([...(currentMods || []).map((m) => m.group), ...fillGroups]);
  for (const t of Tall) t.type = typeOf[t.group];
  methods.push(simulateFinishAnnul(seeded, mods, Tall, trials, rnd, startRarity, opts.finishCap || 30));
  // Essence guarantee for a still-missing fill (Perfect essence on rare / normal on magic).
  if (opts.essences && opts.essences.length) {
    const fe = simulateFinishEssence(seeded, mods, T, Tall, opts.essences, trials, rnd, startRarity);
    if (fe) methods.push(fe);
  }
  // Drop the Regal label/cost for a rare start (nothing to upgrade).
  if (startRarity === "rare") for (const m of methods) { m.label = m.label.replace("Regal + directed", "Directed").replace("Regal + Annul/Exalt", "Annul/Exalt"); delete m.expectedOrbs.Regal; }

  const totalOrbs = (r) => Object.values(r.expectedOrbs).reduce((s, n) => s + n, 0);
  methods.forEach((r) => { r.totalOrbs = r.feasible ? totalOrbs(r) : Infinity; r.impractical = r.feasible && r.successPerAttempt < PRACTICAL_MIN; });
  methods.sort((a, b) => (a.impractical ? 1 : 0) - (b.impractical ? 1 : 0) || a.totalOrbs - b.totalOrbs);
  return { impossible: false, prefixTargets: fillP, suffixTargets: fillS, trials, methods };
}

// ── Recipe step machine (poe2-kb recipe-v1 documents) ──────────────────────
// A recipe is a declarative step graph over moves this engine already simulates.
// simulateRecipe runs the graph as a Monte Carlo: build the starting item per
// starting_state, walk steps applying currencies, route on success_when, count costs
// by DISPLAY name (they double as poe.ninja proxy names for pricing). Recipes whose
// actions/currencies the engine can't model yet return {unsupported:true} — honest
// beats a fake number. Mod refs (already gen-validated) match key OR group.

const RECIPE_ITER_CAP = 200;   // hard bound: a cyclic recipe ends as "stopped", never spins

function refOn(item, ref) {
  for (const m of item.prefixes) if (m.key === ref || m.group === ref) return true;
  for (const m of item.suffixes) if (m.key === ref || m.group === ref) return true;
  return false;
}
function recipeTargetSatisfied(item, target) {
  for (const r of target.required_mods || []) if (!refOn(item, r.ref)) return false;
  for (const r of target.forbidden_mods || []) if (refOn(item, r.ref)) return false;
  return true;
}
// ctx = {target, noLegal} — noLegal true only when evaluating stop conditions after a
// step couldn't act (failed precondition / illegal currency use).
function evalRecipeCond(c, item, ctx) {
  if (c.all) { for (const s of c.all) if (!evalRecipeCond(s, item, ctx)) return false; return true; }
  if (c.any) { for (const s of c.any) if (evalRecipeCond(s, item, ctx)) return true; return false; }
  if (c.expression === "target_satisfied") return recipeTargetSatisfied(item, ctx.target);
  if (c.expression === "no_legal_transition") return !!ctx.noLegal;
  switch (c.predicate) {
    case "has_mod": return refOn(item, c.ref);
    case "missing_mod": return !refOn(item, c.ref);
    case "open_prefixes_at_least": return CAP[item.rarity].prefix - item.prefixes.length >= c.value;
    case "open_suffixes_at_least": return CAP[item.rarity].suffix - item.suffixes.length >= c.value;
    case "rarity_is": return item.rarity === c.value;
    default: return false;
  }
}
// Apply one currency use. true = applied, false = illegal here (no legal transition),
// null = this engine can't model that currency yet.
function recipeApplyCurrency(currency, item, mods, rnd) {
  switch (String(currency).toLowerCase()) {
    case "orb of transmutation": if (item.rarity !== "normal") return false; item.rarity = "magic"; addMod(item, mods, rnd); return true;
    case "orb of augmentation": return item.rarity === "magic" ? addMod(item, mods, rnd) : false;
    case "regal orb": if (item.rarity !== "magic") return false; item.rarity = "rare"; addMod(item, mods, rnd); return true;
    case "orb of alchemy": if (item.rarity !== "normal") return false; item.rarity = "rare"; for (let i = 0; i < 4; i++) addMod(item, mods, rnd); return true;
    case "exalted orb": return item.rarity === "rare" ? addMod(item, mods, rnd) : false;
    case "greater exalted orb": return item.rarity === "rare" ? addMod(item, mods, rnd, null, 35) : false;
    case "perfect exalted orb": return item.rarity === "rare" ? addMod(item, mods, rnd, null, 50) : false;
    case "chaos orb": if (item.rarity !== "rare" || !removeRandom(item, rnd)) return false; addMod(item, mods, rnd); return true;
    case "orb of annulment": return item.rarity === "rare" ? removeRandom(item, rnd) : false;
    default: return null;
  }
}
// Apply one essence use (0.5 semantics per PoE2DB, poe2-kb crafting/reference/essences.md:
// "An essence upgrades a Magic item to Rare and adds one guaranteed modifier ... Perfect
// essences apply to Rare items: they remove a random modifier and add the guaranteed one").
// Tiers only differ in rolled values / min ilvl — Lesser/Standard/Greater ALL act on Magic
// (a Lesser≠Normal→Magic misread here was caught by the 2026-07-12 verification pass).
// Illegal when the rarity is wrong or the mod's group is already present. e comes from the
// server's craftEssenceOptions (so the guaranteed mod is known to exist in this pool).
function recipeApplyEssence(e, item, rnd) {
  if (!e) return null;
  const perfect = /^Perfect\b/i.test(e.name);
  if (item.rarity !== (perfect ? "rare" : "magic")) return false;
  if (refOn(item, e.group)) return false;                       // one mod per group
  if (perfect) {
    removeRandom(item, rnd);
    const full = e.type === "prefix" ? item.prefixes.length >= CAP.rare.prefix : item.suffixes.length >= CAP.rare.suffix;
    if (full) removeRandomOnSide(item, e.type, rnd);
  } else item.rarity = "rare";
  (e.type === "prefix" ? item.prefixes : item.suffixes).push({ key: e.modKey, group: e.group, type: e.type, ilvl: 1 });
  return true;
}

// Starting item per starting_state: seed the required mods (weighted pick among the
// ref's tiers in the pool), then fill each side to cap minus its minimum_open with
// filler mods (target/forbidden groups excluded) — the "bought base" worst case.
function recipeStartItem(ss, mods, fillerMods, rnd) {
  const item = newItem();
  item.rarity = ss.rarity;
  for (const r of ss.required_mods || []) {
    const cands = mods.filter((m) => m.key === r.ref || m.group === r.ref);
    if (!cands.length) continue;                       // gen guarantees resolution; pool ilvl may still exclude it
    const pick = weightedPick(cands, rnd);
    if ((pick.type === "prefix" ? item.prefixes : item.suffixes).length < CAP[item.rarity][pick.type]) {
      (pick.type === "prefix" ? item.prefixes : item.suffixes).push(pick);
    }
  }
  const cap = CAP[item.rarity];
  const openP = ss.minimum_open_prefixes || 0, openS = ss.minimum_open_suffixes || 0;
  while (item.prefixes.length < cap.prefix - openP) if (!addMod(item, fillerMods, rnd, "prefix")) break;
  while (item.suffixes.length < cap.suffix - openS) if (!addMod(item, fillerMods, rnd, "suffix")) break;
  return item;
}

// ── Exact probability evaluator (recipe "Later phases" 3) ──────────────────
// Closed-form success probability + expected per-attempt orbs straight from the mod
// weights, for recipes whose moves are SIMPLE: a linear chain of single-add currencies
// (Transmute/Augment/Regal/Exalt tiers), ONE required target mod, target_satisfied
// success checks, no cycles. It enumerates the start-filler and every junk-add branch
// exactly, so side caps / consumed groups / preconditions are evaluated per state — no
// approximation. Anything else (chaos/annul/alchemy loops, omens, essences, multi-target,
// tier requirements) returns null and the Monte Carlo stands alone. Where both apply
// they cross-validate: the test asserts MC agrees within sampling error.
const EXACT_ADD_CURRENCIES = {
  "orb of transmutation": { fromRarity: "normal", toRarity: "magic", minIlvl: 0 },
  "orb of augmentation": { fromRarity: "magic", minIlvl: 0 },
  "regal orb": { fromRarity: "magic", toRarity: "rare", minIlvl: 0 },
  "exalted orb": { fromRarity: "rare", minIlvl: 0 },
  "greater exalted orb": { fromRarity: "rare", minIlvl: 35 },
  "perfect exalted orb": { fromRarity: "rare", minIlvl: 50 },
};
const EXACT_DEPTH_CAP = 3;   // branch enumeration is O(pool^depth); 3 ≈ millions, fine — 5 is not

function exactRecipeProbability(doc, mods) {
  const t = doc.target || {};
  const ss = doc.starting_state || {};
  if ((t.required_mods || []).length !== 1) return null;
  const req = t.required_mods[0];
  if (req.minimum_tier != null || (req.count || 1) > 1) return null;
  if ((t.forbidden_mods || []).length) return null;          // junk hitting a forbidden mod needs order tracking
  if ((ss.required_mods || []).length) return null;          // seeded starts → MC
  const steps = doc.steps || [];
  if (!steps.length || steps.length > EXACT_DEPTH_CAP) return null;
  const SIMPLE_PREDICATES = new Set(["rarity_is", "open_prefixes_at_least", "open_suffixes_at_least", "has_mod", "missing_mod"]);
  const condSimple = (c) => c.all ? c.all.every(condSimple) : c.any ? c.any.every(condSimple) : SIMPLE_PREDICATES.has(c.predicate);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.action !== "use_currency" || !EXACT_ADD_CURRENCIES[String(s.currency).toLowerCase()]) return null;
    if (!s.success_when || s.success_when.expression !== "target_satisfied") return null;
    if (s.on_success !== "finish") return null;
    const next = steps[i + 1];
    if (!(s.on_failure === "stop" || s.on_failure === "fail" || (next && s.on_failure === next.id))) return null;
    if (!(s.preconditions || []).every(condSimple)) return null;
  }
  for (const sc of doc.stop_conditions || []) {              // only the standard pair — extra semantics → MC
    const e = sc.expression && sc.expression.expression;
    if (e !== "target_satisfied" && e !== "no_legal_transition") return null;
  }

  const isTarget = (m) => m.key === req.ref || m.group === req.ref;
  const excluded = new Set();                                // filler exclusions — mirrors simulateRecipe
  for (const lists of [t.required_mods, ss.forbidden_mods]) {
    for (const r of lists || []) for (const m of mods) if (m.key === r.ref || m.group === r.ref) excluded.add(m.group);
  }
  const sideCount = (present, type) => { let n = 0; for (const m of present) if (m.type === type) n++; return n; };
  const refOnPresent = (present, ref) => present.some((m) => m.key === ref || m.group === ref);
  const preOk = (c, rarity, present) => {
    if (c.all) return c.all.every((x) => preOk(x, rarity, present));
    if (c.any) return c.any.some((x) => preOk(x, rarity, present));
    switch (c.predicate) {
      case "rarity_is": return rarity === c.value;
      case "open_prefixes_at_least": return CAP[rarity].prefix - sideCount(present, "prefix") >= c.value;
      case "open_suffixes_at_least": return CAP[rarity].suffix - sideCount(present, "suffix") >= c.value;
      case "has_mod": return refOnPresent(present, c.ref);
      case "missing_mod": return !refOnPresent(present, c.ref);
      default: return false;
    }
  };

  let pSuccess = 0;
  const orbUse = {};
  function walk(i, rarity, present, prob) {
    if (prob <= 0 || i >= steps.length) return;
    const s = steps[i];
    const cur = EXACT_ADD_CURRENCIES[String(s.currency).toLowerCase()];
    if (!(s.preconditions || []).every((c) => preOk(c, rarity, present))) return;   // stopped, no spend
    if (cur.fromRarity && cur.fromRarity !== rarity) return;                        // illegal use, no spend
    const nextRarity = cur.toRarity || rarity;
    const pFull = sideCount(present, "prefix") >= CAP[nextRarity].prefix;
    const sFull = sideCount(present, "suffix") >= CAP[nextRarity].suffix;
    const groups = present.map((m) => m.group);
    const elig = [];
    let W = 0, Wt = 0;
    for (const m of mods) {
      if (cur.minIlvl && m.ilvl < cur.minIlvl) continue;
      if (m.type === "prefix" ? pFull : sFull) continue;
      if (groups.indexOf(m.group) >= 0) continue;
      elig.push(m); W += m.weight;
      if (isTarget(m)) Wt += m.weight;
    }
    if (!(W > 0)) return;                                                           // addMod would fail → stopped
    orbUse[s.currency] = (orbUse[s.currency] || 0) + prob;
    pSuccess += prob * (Wt / W);
    const next = steps[i + 1];
    if (!next || s.on_failure !== next.id) return;                                  // a miss ends the recipe
    for (const m of elig) {
      if (isTarget(m)) continue;
      walk(i + 1, nextRarity, present.concat(m), prob * (m.weight / W));
    }
  }

  // Start states — mirror recipeStartItem: fill to cap minus minimum_open with filler
  // (excluded groups removed). Exact supports ≤1 filler slot; more → MC.
  const cap = CAP[ss.rarity];
  const fillP = Math.max(0, cap.prefix - (ss.minimum_open_prefixes || 0));
  const fillS = Math.max(0, cap.suffix - (ss.minimum_open_suffixes || 0));
  if (fillP + fillS > 1) return null;
  if (fillP + fillS === 0) walk(0, ss.rarity, [], 1);
  else {
    const side = fillP ? "prefix" : "suffix";
    const cands = mods.filter((m) => m.type === side && !excluded.has(m.group));
    const Wf = cands.reduce((s2, m) => s2 + m.weight, 0);
    if (!(Wf > 0)) walk(0, ss.rarity, [], 1);                                       // no filler available → empty start
    else for (const f of cands) walk(0, ss.rarity, [f], f.weight / Wf);
  }

  const expectedOrbs = {};
  if (pSuccess > 0) for (const k in orbUse) expectedOrbs[k] = orbUse[k] / pSuccess;
  return { method: "closed_form", successPerAttempt: pSuccess, perAttemptOrbs: orbUse, expectedOrbs, feasible: pSuccess > 0 };
}

// Monte Carlo a recipe-v1 document over a base's eligible mod pool. opts: {trials, seed,
// essences} — essences = the server's craftEssenceOptions list for this base+ilvl, needed
// only when the recipe has use_essence steps. Returns rankMethods-method shape
// (successPerAttempt/expectedOrbs/feasible + outcome counts) so the existing pricing +
// UI rendering apply unchanged.
function simulateRecipe(doc, mods, opts) {
  opts = opts || {};
  const trials = opts.trials || 5000;
  const rnd = rng((opts.seed >>> 0) || 12345);
  const warnings = [];
  const essByName = {};
  for (const e of opts.essences || []) essByName[e.name.toLowerCase()] = e;

  // refuse to fake what we can't model — unsupported action or currency
  for (const s of doc.steps) {
    if (s.action === "use_essence") {
      if (!essByName[String(s.currency).toLowerCase()]) return { key: "recipe", label: doc.name, unsupported: true, feasible: false, reason: `step "${s.id}": essence "${s.currency}" not applicable to this base/item level` };
      continue;
    }
    if (s.action !== "use_currency") return { key: "recipe", label: doc.name, unsupported: true, feasible: false, reason: `step "${s.id}": action "${s.action}" not simulatable yet` };
    if (recipeApplyCurrency(s.currency, newItem(), [], rng(1)) === null) return { key: "recipe", label: doc.name, unsupported: true, feasible: false, reason: `step "${s.id}": currency "${s.currency}" not simulatable yet` };
  }
  // every required target mod must be reachable in THIS pool (base + ilvl)
  const missing = (doc.target.required_mods || []).filter((r) => !mods.some((m) => m.key === r.ref || m.group === r.ref)).map((r) => r.ref);
  if (missing.length) return { key: "recipe", label: doc.name, impossible: true, missing, feasible: false };
  for (const r of doc.target.required_mods || []) {
    if (r.minimum_tier != null) warnings.push(`minimum_tier on "${r.ref}" is not modeled (any tier counts)`);
    if ((r.count || 1) > 1) warnings.push(`count ${r.count} on "${r.ref}" is not modeled (presence only)`);
  }

  const excluded = new Set();   // filler must not pre-satisfy the target or violate the start
  for (const lists of [doc.target.required_mods, doc.target.forbidden_mods, (doc.starting_state || {}).forbidden_mods]) {
    for (const r of lists || []) for (const m of mods) if (m.key === r.ref || m.group === r.ref) excluded.add(m.group);
  }
  const fillerMods = mods.filter((m) => !excluded.has(m.group));
  const stepById = {};
  for (const s of doc.steps) stepById[s.id] = s;

  const outcomes = { success: 0, failed: 0, stopped: 0 };
  const costSum = {};
  // Sell-vs-continue decision points: per step, over the trials that REACHED it, the
  // conditional success odds + expected remaining spend from that point. One-shot marginal
  // numbers (not ÷p amortized) — the decision at a step is about THIS in-flight item:
  //   EV(continue) ≈ P(success | here) × targetValue − E[remaining spend | here]
  // vs selling the current item now. Failed/stopped items keep scrap value we don't model,
  // so EV(continue) is a floor.
  const stepStats = {};
  for (const s of doc.steps) stepStats[s.id] = { reached: 0, success: 0, remaining: {} };
  const bump = (cost, name, n) => { cost[name] = (cost[name] || 0) + (n || 1); };
  for (let t = 0; t < trials; t++) {
    const item = recipeStartItem(doc.starting_state, mods, fillerMods, rnd);
    const cost = {};
    const ctx = { target: doc.target, noLegal: false };
    let step = doc.steps[0];
    let result = "stopped";
    const visited = {};   // step id → cost snapshot at FIRST arrival (the decision moment)
    for (let iter = 0; iter < RECIPE_ITER_CAP; iter++) {
      // global stop conditions first (target may already hold / a prior step ended the run)
      ctx.noLegal = false;
      const hit = (doc.stop_conditions || []).find((sc) => evalRecipeCond(sc.expression, item, ctx));
      if (hit) { result = hit.result === "success" ? "success" : hit.result === "failed" ? "failed" : "stopped"; break; }
      if (!step) break;   // routed to a terminal below
      if (!(step.id in visited)) visited[step.id] = Object.assign({}, cost);
      const legal = (step.preconditions || []).every((c) => evalRecipeCond(c, item, ctx))
        && (step.action === "use_essence"
          ? recipeApplyEssence(essByName[String(step.currency).toLowerCase()], item, rnd) === true
          : recipeApplyCurrency(step.currency, item, mods, rnd) === true);
      if (!legal) {       // no legal transition → only a no_legal_transition stop can name the result
        ctx.noLegal = true;
        const sc = (doc.stop_conditions || []).find((s) => evalRecipeCond(s.expression, item, ctx));
        result = sc && sc.result === "success" ? "success" : sc && sc.result === "failed" ? "failed" : "stopped";
        break;
      }
      bump(cost, step.currency);
      for (const o of step.omens || []) bump(cost, o);
      const dest = evalRecipeCond(step.success_when, item, ctx) ? step.on_success : step.on_failure;
      if (dest === "finish") { result = recipeTargetSatisfied(item, doc.target) ? "success" : "failed"; break; }
      if (dest === "stop") { result = "stopped"; break; }
      if (dest === "fail") { result = "failed"; break; }
      step = stepById[dest];
    }
    outcomes[result]++;
    for (const k in cost) bump(costSum, k, cost[k]);
    for (const id in visited) {
      const st = stepStats[id];
      st.reached++;
      if (result === "success") st.success++;
      for (const k in cost) { const rem = cost[k] - (visited[id][k] || 0); if (rem > 0) st.remaining[k] = (st.remaining[k] || 0) + rem; }
    }
  }

  const p = outcomes.success / trials;
  const perAttemptOrbs = {};
  for (const k in costSum) perAttemptOrbs[k] = costSum[k] / trials;
  const expectedOrbs = {};
  if (p > 0) for (const k in costSum) expectedOrbs[k] = (costSum[k] / trials) / p;
  const decisionPoints = doc.steps.map((s) => {
    const st = stepStats[s.id];
    const remainingOrbs = {};
    for (const k in st.remaining) remainingOrbs[k] = st.remaining[k] / (st.reached || 1);
    return {
      step: s.id, action: s.action, currency: s.currency,
      reachRate: st.reached / trials,
      successGivenReached: st.reached ? st.success / st.reached : 0,
      remainingOrbs,
    };
  });
  return {
    key: "recipe:" + doc.id, label: doc.name,
    successPerAttempt: p, outcomes, perAttemptOrbs, expectedOrbs, decisionPoints,
    feasible: p > 0, impractical: p > 0 && p < PRACTICAL_MIN,
    warnings: warnings.length ? warnings : undefined,
  };
}

// Rank the known methods for hitting targetGroups on a base's mod pool.
function rankMethods(mods, targetGroups, opts) {
  opts = opts || {};
  const trials = opts.trials || 5000;    // ±~0.7% at p=0.5 — fine for a whole-% display; 4 spam loops × cap keep it bounded
  const cap = opts.chaosCap || 120;
  const seed = (opts.seed >>> 0) || 12345;
  // Desecration branch: if any target is a desecrated mod, normal orbs can't add it, so only the
  // desecration method applies. Handled separately (and BEFORE the pool-reachability check, which
  // would otherwise flag the synthetic desecrated group as "missing"). No desecrated target → this
  // is skipped and the normal path below runs unchanged.
  if ((targetGroups || []).some((t) => t && typeof t === "object" && t.desecrated)) {
    const rnd = rng(seed);
    const byGroup = {}; for (const m of mods) if (!byGroup[m.group]) byGroup[m.group] = m;
    const Td = (targetGroups || []).map((t) => typeof t === "string"
      ? { group: t, keys: null }
      : { group: t.group, keys: (t.keys && t.keys.length) ? new Set(t.keys) : null, type: t.type, desecrated: !!t.desecrated, poolN: t.poolN, key: t.key });
    for (const t of Td) if (!t.desecrated && byGroup[t.group]) t.type = byGroup[t.group].type;
    const pfx = Td.filter((t) => t.type === "prefix").length, sfx = Td.filter((t) => t.type === "suffix").length;
    if (pfx > CAP.rare.prefix || sfx > CAP.rare.suffix) return { impossible: true, overCap: true, prefixTargets: pfx, suffixTargets: sfx, methods: [] };
    const methods = [];
    const dz = simulateDesecration(mods, Td, trials, rnd);
    if (dz) methods.push(dz);
    const totalOrbsD = (r) => Object.values(r.expectedOrbs).reduce((s, n) => s + n, 0);
    methods.forEach((r) => { r.totalOrbs = r.feasible ? totalOrbsD(r) : Infinity; r.impractical = r.feasible && r.successPerAttempt < PRACTICAL_MIN; });
    return { impossible: !methods.length, prefixTargets: pfx, suffixTargets: sfx, trials, methods };
  }
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
  methods.push(simulateFracture(mods, targetGroups, trials, cap, rnd)); // Fracturing Orb (lock a hit, reroll rest)
  methods.push(simulateDirected(mods, T, opts.essences, trials, rnd)); // Exaltation omens
  const ess = simulateEssence(mods, T, opts.essences, trials, rnd);    // essence, undirected (no omens)
  if (ess) methods.push(ess);
  const tiered = simulateTiered(mods, T, opts.essences, trials, rnd);  // Greater/Perfect Exalt fill (high-tier targets only)
  if (tiered) methods.push(tiered);
  const homog = simulateHomogenising(mods, T, opts.essences, trials, rnd); // Homogenising Exaltation (tag-clustered targets)
  if (homog) methods.push(homog);
  const cat = simulateCatalyst(mods, T, opts.essences, trials, rnd, opts.jewellery); // Catalyst-directed Exalts (jewellery)
  if (cat) methods.push(cat);
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

module.exports = { rng, weightedPick, addMod, addModBiased, itemTags, simulateHomogenising, simulateCatalyst, simulateDesecration, removeRandom, removeLowestIlvl, removeLowestIlvlOnSide, removeRandomOnSide, directedFill, hasAllTargets, craftFresh, simulateFresh, simulateChaosSpam, simulateEssence, simulateWhittling, simulateErasureChaos, simulateAnnulExalt, simulateFracture, simulateDirected, seedItem, simulateFinish, simulateFinishAnnul, simulateFinishEssence, rankFinish, rankMethods, simulateRecipe, exactRecipeProbability, CAP, newItem };

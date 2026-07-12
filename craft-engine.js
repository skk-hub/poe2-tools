// craft-engine.js — the crafting PRIMITIVES: an item, a mod pool, and the operations a currency
// can perform on them. Zero-dep.
//
// This file used to also contain 13 hand-written simulate*() functions — one per crafting route
// somebody had bothered to implement — plus rankMethods/rankFinish and a recipe step-machine.
// That design made the engine's knowledge equal to the list of routes a human had typed out, so
// it silently "forgot" every mechanic nobody had gotten around to (Hinekora's Lock, Greater
// Exaltation, targeted Regals, the Crystallisation omens...). All of that is now in craft-plan.js,
// which ENUMERATES routes from the move catalog (poe2-kb/crafting/methods.json → method-data.js)
// and composes them out of these primitives. Adding a mechanic is a catalog entry now, not a new
// function here, and craft-plan-test.js fails if the catalog carries a move the planner can't run.
//
// What stays here: the item model, the mod-add/remove operations, and THE POOL BUILDER. The pool
// builder lives here rather than in server.js so that the server and the tests build the pool the
// SAME way. It used to be server-only, so every test hand-rolled a naive raw-PoB-weight pool —
// which meant the closed-form-vs-MC cross-validation ran on a pool no user ever gets, silently
// skipping the Craft-of-Exile spawn-weight overlay that is the whole point of craftEffWeight.
// (Symptom: a fixture documented at 3.1074% actually served 1.0790% — same code, two pools.)
//
// Odds model (community/Craft-of-Exile standard, NOT invented): a newly-added affix is drawn from
// the COMBINED pool of every eligible affix that still has an open slot, weighted by spawn weight;
// a full side is excluded, and a group already on the item is excluded. There is no 50/50
// prefix/suffix coin-flip first — the sides compete purely by weight.
// ponytail: this is the accepted model; if GGG's real algorithm differs, it's a data/model tweak
// here, not a rewrite.
//
// Caps: Magic = 1 prefix + 1 suffix; Rare = 3 prefixes + 3 suffixes. No Alteration/Scour in PoE2.

const CAP = { normal: { prefix: 0, suffix: 0 }, magic: { prefix: 1, suffix: 1 }, rare: { prefix: 3, suffix: 3 } };

// Deterministic RNG (mulberry32) so tests are reproducible; the server passes a random seed.
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

// Add one affix. typeFilter optionally restricts to "prefix"/"suffix"; minIlvl (for Greater/
// Perfect tiered currency) requires the added mod's level ≥ minIlvl (i.e. higher tiers only).
// Hot path (called millions of times per run) — no Set alloc, single-pass weighted pick.
// The RETURN VALUE IS LOAD-BEARING: on an exhausted pool (every legal group already present, or a
// minIlvl floor no mod clears) the add is a no-op, and callers must not report that as success.
function addMod(item, mods, rnd, typeFilter, minIlvl) {
  const cap = CAP[item.rarity];
  const prefFull = item.prefixes.length >= cap.prefix;
  const sufFull = item.suffixes.length >= cap.suffix;
  if (prefFull && sufFull) return false;
  const present = [];   // ≤6 groups — a linear scan beats a Set here
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

// Tag-biased add. Same as addMod but: restrictTags (Set) limits candidates to mods sharing ≥1 tag
// with it (Omen of Homogenising Exaltation — "add a mod of the same type as one already on the
// item"); boostTags (Set) multiplies matching mods' weight by boostMult (catalyst quality biasing
// a mod type). Both optional; needs mods to carry .tags (craftModList supplies them, so a
// synthetic tag-less pool simply gets no bias rather than crashing).
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
    if (restrictTags) { let okTag = false; for (const tg of tags) if (restrictTags.has(tg)) { okTag = true; break; } if (!okTag) continue; }
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

// Union of tags across every mod on the item (the "types present" for homogenising).
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
// Remove the mod with the lowest level requirement (Omen of Whittling on a Chaos).
function removeLowestIlvl(item) {
  let arr = null, idx = -1, lo = Infinity;
  for (let i = 0; i < item.prefixes.length; i++) if (item.prefixes[i].ilvl < lo) { lo = item.prefixes[i].ilvl; arr = item.prefixes; idx = i; }
  for (let i = 0; i < item.suffixes.length; i++) if (item.suffixes[i].ilvl < lo) { lo = item.suffixes[i].ilvl; arr = item.suffixes; idx = i; }
  if (arr) arr.splice(idx, 1);
  return !!arr;
}
// Remove a random mod on ONE side (Sinistral/Dextral omens on an Annul or a Chaos).
function removeRandomOnSide(item, side, rnd) {
  const arr = side === "prefix" ? item.prefixes : item.suffixes;
  if (!arr.length) return false;
  arr.splice(Math.floor(rnd() * arr.length), 1);
  return true;
}

// ── Mod pool builder (shared by server.js AND the tests — see the header note) ─────
const { archetypeKey } = require("./craft-archetype.js");

// PoB's binary tag weight decides ELIGIBILITY: the first tag in a mod's ordered `weights` list
// that the base carries wins; "default" matches everything (usually 0 = cannot spawn).
function craftWeightFor(mod, tagset) {
  for (const [tag, w] of mod.weights) { if (tag === "default" || tagset.has(tag)) return w; }
  return 0;
}

// Effective spawn weight: PoB's binary weight is authoritative for ELIGIBILITY (0 = the mod cannot
// roll on this base), but when eligible we use the REAL Craft-of-Exile weight baked as
// mod.cw[archetype]. Unmatched mods keep the binary weight, so odds are never worse than before.
// archKey = the base's CoE archetype (null → binary only).
function craftEffWeight(mod, tagset, archKey) {
  const binW = craftWeightFor(mod, tagset);
  if (binW <= 0) return 0;                         // ineligible on this base
  const cw = archKey && mod.cw ? mod.cw[archKey] : undefined;
  return cw != null ? cw : binW;                   // real weight, else binary fallback
}

// The eligible prefix/suffix pool for one base at one item level. `data` is craft-data.js.
// This is THE pool — anything that reasons about odds must build it through here, or it is
// reasoning about a base that does not exist.
function craftModList(data, baseName, itemLevel) {
  if (!data) return null;
  const base = data.bases[baseName];
  if (!base) return null;
  const ilvl = Math.max(1, Math.min(100, itemLevel | 0 || 100));
  const tagset = new Set(base.tags);
  const archKey = archetypeKey(base.class, base.tags);
  const list = [];
  for (const [key, m] of Object.entries(data.mods)) {
    if (m.ilvl > ilvl) continue;
    const w = craftEffWeight(m, tagset, archKey);
    if (w <= 0) continue;
    list.push({ key, type: m.type === "Prefix" ? "prefix" : "suffix", group: m.group, weight: w, ilvl: m.ilvl, tags: m.tags || [] });
  }
  return list;
}

// The essences applicable to one base at one item level. Lives here for the same reason
// craftModList does: it was server-only, so anything outside server.js that tried to simulate an
// essence route passed no essence list and got a FALSE "essence not applicable".
function craftEssenceOptions(data, baseName, itemLevel) {
  if (!data || !data.essences) return [];
  const base = data.bases[baseName];
  if (!base) return [];
  const cls = base.class, ilvl = Math.max(1, Math.min(100, itemLevel | 0 || 100));
  const out = [];
  for (const [name, e] of Object.entries(data.essences)) {
    const mk = e.mods && e.mods[cls];
    if (!mk) continue;
    const m = data.mods[mk];
    if (!m || m.ilvl > ilvl) continue;                 // essence-exclusive mod, or the tier needs a higher ilvl
    out.push({ name, modKey: mk, group: m.group, type: m.type === "Prefix" ? "prefix" : "suffix", stat: m.stats[0] || "", tags: m.tags || [] });
  }
  return out;
}

module.exports = {
  CAP, rng, weightedPick, newItem,
  addMod, addModBiased, itemTags, removeRandom, removeLowestIlvl, removeRandomOnSide,
  craftWeightFor, craftEffWeight, craftModList, craftEssenceOptions,
};

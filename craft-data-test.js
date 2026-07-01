// craft-data-test.js — self-check for the extracted craft-data.js. Asserts known
// PoE2 facts (base classes, a specific mod's tier/ilvl/weight) and exercises the
// weight-resolution rule so a real base's mod pool is provably non-empty and sane.
//   node craft-data-test.js
const assert = require("assert");
const D = require("./craft-data.js");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── shape ──
ok(D.bases && D.mods && D.essences, "top-level keys present");
ok(Object.keys(D.mods).length > 2000, "2000+ mods");
ok(Object.keys(D.bases).length > 1000, "1000+ bases");

// ── a known base ──
const iron = D.bases["Iron Ring"];
ok(iron && iron.class === "Ring", "Iron Ring is a Ring");
ok(iron.tags.includes("ring"), "Iron Ring has 'ring' tag");

// ── a known mod (verified against ModItem.lua) ──
const life = D.mods["IncreasedLife3"];
ok(life.type === "Prefix", "IncreasedLife3 is a Prefix");
ok(life.ilvl === 16, "IncreasedLife3 ilvl 16");
ok(life.group === "IncreasedLife", "IncreasedLife3 group");
ok(/maximum Life/.test(life.stats[0]), "IncreasedLife3 stat text");
const bodyW = life.weights.find(([t]) => t === "body_armour");
ok(bodyW && bodyW[1] === 1, "IncreasedLife3 body_armour weight 1");

// ── weight resolution: first tag the base has wins (default last) ──
function weightFor(mod, base) {
  const tagset = new Set(base.tags);
  for (const [tag, w] of mod.weights) {
    if (tag === "default" || tagset.has(tag)) return w; // first match (default matches all)
  }
  return 0;
}
// mods that can roll on a base = ilvl<=itemLevel AND resolved weight>0
function poolFor(base, itemLevel) {
  const out = { Prefix: [], Suffix: [] };
  for (const [key, m] of Object.entries(D.mods)) {
    if (m.ilvl > itemLevel) continue;
    if (weightFor(m, base) <= 0) continue;
    if (out[m.type]) out[m.type].push(key);
  }
  return out;
}

const ring = D.bases["Sapphire Ring"] || iron;
const pool = poolFor(ring, 82);
ok(pool.Prefix.length > 5, `ring has prefixes (${pool.Prefix.length})`);
ok(pool.Suffix.length > 5, `ring has suffixes (${pool.Suffix.length})`);
// IncreasedLife3 should be in a ring's prefix pool at ilvl 82
ok(pool.Prefix.includes("IncreasedLife3"), "life prefix available on ring");
// a body-armour-only mod should NOT leak onto a ring via the same weight list
const armourEvasion = Object.entries(D.mods).find(([k, m]) =>
  m.weights.length && m.weights.every(([t]) => t !== "ring" && t !== "default" || (t === "default")) &&
  m.weights.some(([t, w]) => t === "body_armour" && w > 0) &&
  !m.weights.some(([t, w]) => (t === "ring" || t === "amulet") && w > 0));
if (armourEvasion) ok(weightFor(armourEvasion[1], ring) === 0, `${armourEvasion[0]} does not leak onto ring`);

// ── essences ──
const bodyEss = D.essences["Lesser Essence of the Body"];
ok(bodyEss && bodyEss.mods["Helmet"] === "IncreasedLife3", "Body essence forces IncreasedLife3 on Helmet");

console.log(`craft-data-test: ${pass} checks passed`);
console.log(`  Sapphire Ring @ilvl82: ${pool.Prefix.length} prefixes, ${pool.Suffix.length} suffixes`);

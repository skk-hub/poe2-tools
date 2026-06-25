// Offline check for the Jewel Pricer triage logic. Loads the real jewel-data.js
// mod table and replicates evaluate()'s parse + verdict (the DOM-bound original
// lives in jewel-pricer.js's __viewInit). Fails loudly if the combo logic breaks.
// Run: node jewel-pricer-test.js
const assert = require("assert");
const path = require("path");

global.window = {};
require(path.join(__dirname, "jewel-data.js"));
const D = global.window.JEWEL_DATA;
const TIER_RANK = { S: 3, A: 2, B: 1 };

function parseJewel(block) {
  const isJewel = /Item Class:\s*Jewels/i.test(block);
  const rarityM = block.match(/Rarity:\s*([A-Za-z]+)/i);
  const rarity = rarityM ? rarityM[1].toLowerCase() : "";
  const lines = block.split(/\n/);
  const mods = [];
  for (const def of D.mods) {
    let found = false, value = 0;
    for (const line of lines) {
      if (!def.re.test(line)) continue;
      found = true;
      const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) value = Math.max(value, parseFloat(m[1]));
    }
    if (found) mods.push({ def, value });
  }
  return { isJewel, rarity, mods };
}
function verdict(parsed) {
  const s = parsed.mods.filter((m) => m.def.tier === "S").length;
  const a = parsed.mods.filter((m) => m.def.tier === "A").length;
  const b = parsed.mods.filter((m) => m.def.tier === "B").length;
  if (s + a >= 2) return "chase";
  if (s >= 1) return "strong";
  if (a >= 1 || b >= 2) return "decent";
  return "junk";
}
function topQueryMods(parsed) {
  return parsed.mods
    .filter((m) => m.def.statId)
    .sort((x, y) => (TIER_RANK[y.def.tier] - TIER_RANK[x.def.tier]) || (y.value - x.value))
    .slice(0, 3)
    .map((m) => ({ statId: m.def.statId, min: Math.floor(m.value) || 1 }));
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok -", name); };

// data sanity: every statId is a well-formed explicit id (no guesses/typos)
t("all stat ids well-formed", () => {
  for (const m of D.mods) assert(/^explicit\.stat_\d+$/.test(m.statId), "bad id on " + m.key + ": " + m.statId);
  assert(D.mods.find((m) => m.key === "critDamage").statId === "explicit.stat_3556824919", "crit damage id drifted");
});

// 1) junk: a single B-tier mod
t("single B mod -> junk", () => {
  const p = parseJewel("Item Class: Jewels\nRarity: Rare\n--------\n14% increased Fire Damage\n--------");
  assert.strictEqual(p.isJewel, true);
  assert.strictEqual(verdict(p), "junk");
});

// 2) chase: Crit Damage + Attack Speed (the liquid combo from the probe)
t("crit damage + attack speed -> chase, top mods query crit first", () => {
  const p = parseJewel("Item Class: Jewels\nRarity: Rare\nHibernation Eye\n--------\n22% increased Critical Damage Bonus\n9% increased Attack Speed\n--------");
  assert.strictEqual(verdict(p), "chase");
  const q = topQueryMods(p);
  assert.strictEqual(q.length, 2);
  assert.strictEqual(q[0].statId, "explicit.stat_3556824919"); // crit damage ranked first (S)
  assert.strictEqual(q[0].min, 22);
  assert.strictEqual(q[1].statId, "explicit.stat_681332047");  // attack speed
});

// 3) one A mod -> decent (gets a price-check, not junk)
t("single A mod -> decent", () => {
  const p = parseJewel("Item Class: Jewels\nRarity: Rare\n--------\n17% increased Spell Damage\n--------");
  assert.strictEqual(verdict(p), "decent");
});

// 4) "increased Damage" must NOT be eaten by "increased Spell Damage" ($ anchor)
t("generic Damage regex does not match Spell Damage", () => {
  const p = parseJewel("Item Class: Jewels\nRarity: Rare\n--------\n17% increased Spell Damage\n--------");
  assert(!p.mods.some((m) => m.def.key === "genericDamage"), "genericDamage wrongly matched Spell Damage");
});

// 5) non-jewel + empty are guarded
t("non-jewel guarded", () => {
  const p = parseJewel("Item Class: Body Armours\nRarity: Rare\n--------\n120 to maximum Life\n--------");
  assert.strictEqual(p.isJewel, false);
});

console.log(`\njewel-pricer-test: ${n} checks passed`);

// Guards the bug class "tablet regex token doesn't match real stash wording":
// every tablet mod token must be a valid regex AND actually match the literal mod
// text it claims to (ground truth below from odealo's 0.5 list + a live 0.5.2 tablet).
// Run: node tablet-token-test.js
const fs = require("fs");
const win = {};
new Function("window", fs.readFileSync(__dirname + "/waystone-data.js", "utf8"))(win);
const D = win.WAYSTONE_DATA;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// Real in-game mod lines (substring-matchable) keyed by the label whose token must hit them.
const SAMPLES = {
  "Additional Random Map Modifier": "Your Maps have 1 additional random Modifier",
  "Unique Monster +Rare Modifier": "Unique Monsters have 1 additional Rare Modifier",
  "Item Quantity": "12% increased Quantity of Items found in your Maps",
  "Waystone Quantity": "15% increased Quantity of Waystones found in your Maps",
  "Item Rarity": "13% increased Rarity of Items found in your Maps",
  "Pack Size": "5% increased Pack Size in your Maps",
  "Magic Monsters": "20% increased Magic Monsters in your Maps",
  "Rare Monsters": "12% increased Rare Monsters in your Maps",
  "Monster Effectiveness": "Monsters have 15% increased Effectiveness",
  "Strongbox chance": "Map has 78% increased chance to contain Strongboxes",
  "Shrine chance": "Your Maps have 40% increased chance to contain Shrines",
  "Essence chance": "Your Maps have 40% increased chance to contain Essences",
  "Azmeri Spirit chance": "Your Maps have 40% increased chance to contain Azmeri Spirits",
  "Rogue Exile chance": "Your Maps have 20% increased chance to contain Rogue Exiles",
  "Gold found": "25% increased Gold found in Map",
  "Experience gain": "8% increased Experience gain in your Maps",
  // content-specific
  "Additional Rare Monster": "Breaches in your Maps spawn an additional Rare Monster",
  "Additional Breach(es)": "Your Maps which contain Breaches have 8% chance to contain an additional Breach",
  "Breach Splinter Quantity": "8% increased Quantity of Breach Splinters dropped by Breach Monsters",
  "Additional Clasped Hand": "Breaches in your Maps contain 1 additional Clasped Hand",
  "Extra Reroll (additional time)": "Ritual Altars in your Maps allow rerolling Favours an additional time",
  "Reduced Reroll/Defer Tribute": "Rerolling Favours at Ritual Altars in your Maps costs 12% reduced Tribute",
  "Favours → Omens chance": "Ritual Favours in your Maps have 20% increased chance to be Omens",
  "Simulacrum Splinter stack": "8% increased Stack size of Simulacrum Splinters found in your Maps",
  "Fracturing Mirrors": "Delirium Fog in your Maps spawns 8% increased Fracturing Mirrors",
  "Additional Reward type": "Delirium Encounters in your Maps have 5% chance to generate an additional Reward type",
  "Unique Boss chance": "Delirium Encounters in your Maps are 8% more likely to spawn Unique Bosses",
  "Boss Item/Waystone Quantity": "12% increased Quantity of Items dropped by Map Bosses",
  "Boss spawns extra Strongbox/Shrine/Essence": "Areas with Map Bosses contain an additional Strongbox",
  "Boss Item Rarity": "20% increased Rarity of Items dropped by Map Bosses",
  "Boss Experience": "Map Bosses grant 30% increased Experience",
  "Additional Unique Modifier": "Unique Monsters in your Maps have an additional Unique Modifier",
};

const all = [...(D.tabletGeneral || []), ...(D.contentTypes || []).flatMap(c => c.desirable || [])];

// 1) Every token is a compilable regex.
for (const m of all) {
  try { new RegExp(m.token, "i"); ok(true, `token compiles: ${m.label}`); }
  catch { ok(false, `token compiles: ${m.label} (BAD REGEX: ${m.token})`); }
}

// 2) Every token with a known sample actually matches its real wording.
for (const m of all) {
  const sample = SAMPLES[m.label];
  if (!sample) continue; // Abyss/Temple-extra wording unverified — skipped, not failed
  ok(new RegExp(m.token, "i").test(sample), `token matches stash text: ${m.label}`);
}

// 3) The extra-reroll token must NOT also catch the reduced-tribute reroll mod (the
//    collision that made "rerolling Favours" ambiguous).
const reroll = all.find(m => m.label === "Extra Reroll (additional time)");
ok(reroll && !new RegExp(reroll.token, "i").test(SAMPLES["Reduced Reroll/Defer Tribute"]),
   "extra-reroll token does not also match the reduced-tribute mod");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

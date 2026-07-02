// craft-archetype.js — map a PoB base (class + tags) to the Craft of Exile base ARCHETYPE
// whose real spawn weights we baked into craft-data.js. Shared by gen-craft-weights.js (to
// look up CoE weights at generation time) and server.js (to pick the right weight per base at
// runtime). Returns a stable string that equals CoE's `name_base` (e.g. "Bow", "Body Armour
// (STR)", "Ice Wand"), or null when we have no CoE archetype for it (→ caller falls back to
// PoB's binary tag weight). Kept CoE-id-free so a CoE data refresh can't break runtime lookups.

// Weapon/jewellery classes whose PoB class name IS the CoE base name.
const DIRECT = new Set([
  "Bow", "Crossbow", "Claw", "Dagger", "Flail", "Spear", "Sceptre", "Warstaff",
  "One Hand Axe", "One Hand Mace", "One Hand Sword",
  "Two Hand Axe", "Two Hand Mace", "Two Hand Sword",
  "Focus", "Quiver", "Talisman", "Ring", "Amulet", "Belt",
]);

// PoB armour bases carry an attribute tag; CoE splits armour bases by attribute. CoE has only
// single/double attribute variants (no triple), so str_dex_int falls through to null.
function armourAttr(tagset) {
  if (tagset.has("str_dex_armour")) return "STR/DEX";
  if (tagset.has("str_int_armour")) return "STR/INT";
  if (tagset.has("dex_int_armour")) return "DEX/INT";
  if (tagset.has("str_armour")) return "STR";
  if (tagset.has("dex_armour")) return "DEX";
  if (tagset.has("int_armour")) return "INT";
  return null;
}

// A wand/staff's element is the ONE spell type NOT excluded by a `no_<elem>_spell_mods` tag.
// CoE names cold as "Ice". Generic casters (no restriction tags) → null (no clean archetype).
const CASTER_ELEMS = ["chaos", "cold", "fire", "lightning", "physical"];
const ELEM_COE = { chaos: "Chaos", cold: "Ice", fire: "Fire", lightning: "Lightning", physical: "Physical" };
function casterElem(tagset) {
  const allowed = CASTER_ELEMS.filter((e) => !tagset.has("no_" + e + "_spell_mods"));
  return allowed.length === 1 ? ELEM_COE[allowed[0]] : null;   // exactly one → that's its element
}

// class + tags → CoE archetype base name (or null).
function archetypeKey(cls, tags) {
  if (DIRECT.has(cls)) return cls;
  const t = new Set(tags || []);
  if (cls === "Body Armour" || cls === "Boots" || cls === "Gloves" || cls === "Helmet") {
    const a = armourAttr(t); return a ? `${cls} (${a})` : null;
  }
  if (cls === "Shield") { const a = armourAttr(t); return a ? `Shield (${a})` : null; }   // CoE: Shield (STR|DEX|STR/DEX|STR/INT)
  if (cls === "Wand" || cls === "Staff") { const e = casterElem(t); return e ? `${e} ${cls}` : null; }
  return null;   // Charm/Jewel/Flask/TrapTool/Fishing Rod — no CoE weight archetype
}

module.exports = { archetypeKey };

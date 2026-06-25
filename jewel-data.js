/*
 * Jewel Pricer data — Path of Exile 2.
 * PATCH: 0.5.2 "Return of the Ancients" · League: Runes of Aldur.
 *
 * THIS IS THE FILE TO EDIT WHEN THE PATCH CHANGES (and the file to re-sweep for
 * real numbers). Scope: RARE jewels only (uniques — Timeless/Megalomaniac/Cluster
 * — price by name+variant, a separate later pass).
 *
 * WHY THIS EXISTS: rare jewels are combo-driven and mostly junk, so a per-mod
 * `price: asc` floor just prices "a junk jewel that happens to share this mod".
 * Triage here is OFFLINE (tier each mod, score the COMBO) so a whole stash sorts
 * instantly with zero trade calls; the real ex number comes from the opt-in
 * per-jewel Price-check button, which ANDs the top mods (cheapest GOOD jewel like
 * this), de-baited + clustered, server-side.
 *
 * STAT IDS are VERIFIED against the live Trade2 `data/stats` endpoint (2026-06-25,
 * one-off probe through the shared queue). NEVER guess a stat id — a wrong one
 * silently returns 0 results. A mod with statId:null is offline-triaged only and
 * excluded from the live query.
 *
 * VALUES are EST (est:true): the tier + soloEx are curated from community
 * consensus (Crit Damage Bonus is the #1 jewel mod) anchored by ONE live combo
 * probe — Crit Damage + Attack Speed on jewels (nonunique, price asc) returned
 * 303 listings, de-baited floor ~3ex at min rolls, climbing past 20ex. So common
 * good combos are LIQUID (the live check returns a real depth), not thin. Re-sweep
 * per patch to replace the est numbers; the live button is the source of truth
 * for any single jewel.
 *
 * Tiers: S = universal chase (crit damage). A = widely-wanted (speed/crit/damage).
 * B = build-conditional or defensive (specific damage type, attributes, life/ES).
 * Triage reads tiers, not soloEx — soloEx is just a rough headline band.
 */
window.JEWEL_DATA = {
  patch: "0.5.2 (Return of the Ancients)",
  league: "Runes of Aldur",
  est: true,
  source: "Trade2 data/stats ids (verified 2026-06-25) + community tiers; combo anchor: critDmg+atkSpd jewels 303 listings, floor ~3ex min-roll.",
  // re: matched per-line against pasted item text (highest % wins, like map-juicer statRoll).
  // $ on the line end keeps "increased Damage" from eating "increased Spell Damage" etc.
  mods: [
    { key: "critDamage",       label: "Critical Damage Bonus",  re: /increased critical damage bonus/i,     statId: "explicit.stat_3556824919", tier: "S", soloEx: 5 },
    { key: "critChance",       label: "Critical Hit Chance",     re: /increased critical hit chance/i,        statId: "explicit.stat_587431675",  tier: "A", soloEx: 2 },
    { key: "attackSpeed",      label: "Attack Speed",            re: /increased attack speed\s*$/i,           statId: "explicit.stat_681332047",  tier: "A", soloEx: 2 },
    { key: "castSpeed",        label: "Cast Speed",              re: /increased cast speed\s*$/i,             statId: "explicit.stat_2891184298", tier: "A", soloEx: 2 },
    { key: "genericDamage",    label: "Damage",                  re: /increased damage\s*$/i,                 statId: "explicit.stat_2154246560", tier: "A", soloEx: 3 },
    { key: "spellDamage",      label: "Spell Damage",            re: /increased spell damage\s*$/i,           statId: "explicit.stat_2974417149", tier: "A", soloEx: 2 },
    { key: "projectileDamage", label: "Projectile Damage",       re: /increased projectile damage\s*$/i,      statId: "explicit.stat_1839076647", tier: "A", soloEx: 2 },
    { key: "meleeDamage",      label: "Melee Damage",            re: /increased melee damage\s*$/i,           statId: "explicit.stat_1002362373", tier: "A", soloEx: 2 },
    { key: "eleDamage",        label: "Elemental Damage",        re: /increased elemental damage\s*$/i,       statId: "explicit.stat_3141070085", tier: "A", soloEx: 2 },
    { key: "fireDamage",       label: "Fire Damage",             re: /increased fire damage\s*$/i,            statId: "explicit.stat_3962278098", tier: "B", soloEx: 1 },
    { key: "coldDamage",       label: "Cold Damage",             re: /increased cold damage\s*$/i,            statId: "explicit.stat_3291658075", tier: "B", soloEx: 1 },
    { key: "lightningDamage",  label: "Lightning Damage",        re: /increased lightning damage\s*$/i,       statId: "explicit.stat_2231156303", tier: "B", soloEx: 1 },
    { key: "chaosDamage",      label: "Chaos Damage",            re: /increased chaos damage\s*$/i,           statId: "explicit.stat_736967255",  tier: "B", soloEx: 1 },
    { key: "physDamage",       label: "Physical Damage",         re: /increased physical damage\s*$/i,        statId: "explicit.stat_1509134228", tier: "B", soloEx: 1 },
    { key: "maxLife",          label: "Maximum Life",            re: /increased maximum life\s*$/i,           statId: "explicit.stat_983749596",  tier: "B", soloEx: 1 },
    { key: "maxMana",          label: "Maximum Mana",            re: /increased maximum mana\s*$/i,           statId: "explicit.stat_2748665614", tier: "B", soloEx: 1 },
    { key: "maxES",            label: "Maximum Energy Shield",   re: /increased maximum energy shield\s*$/i,  statId: "explicit.stat_2482852589", tier: "B", soloEx: 1 },
    { key: "allAttributes",    label: "All Attributes",          re: /to all attributes\s*$/i,                statId: "explicit.stat_1379411836", tier: "B", soloEx: 1 },
    { key: "manaOnKill",       label: "Mana on Kill",            re: /maximum mana on kill/i,                 statId: "explicit.stat_1604736568", tier: "B", soloEx: 1 },
  ],
};

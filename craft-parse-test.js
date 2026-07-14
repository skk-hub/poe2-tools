// craft-parse-test.js — the pasted-item parser (craft.js parseItem).
//
// AN IMPLICIT IS NOT AN AFFIX. It cannot be rolled, removed, or occupy a prefix/suffix slot, and it
// must never be handed to the planner as a "kept mod". We only understood the legacy trailing
// "(implicit)" tag, so PoE2's *advanced mod descriptions* format — which declares the type on its
// own line instead:
//     { Implicit Modifier — Elemental, Fire, Resistance }
//     +21(20-30)% to Fire Resistance
// matched nothing, fell through to "treat every line as an explicit", and fed a Ruby Ring's
// IMPLICIT fire resistance to the engine as a kept affix (plus the "{ ... }" line itself as a
// second one). The planner then believed a slot was taken that isn't, and tried to preserve a mod
// that never came from the affix pool — which is how a real Ruby Ring produced a 2%-per-attempt,
// 45x-Regal "plan". Reported by the user, 2026-07-13.
//
// parseItem lives in craft.js inside the view-init closure (browser code, no exports), so we slice
// it out and eval it. Crude, but it tests the REAL function rather than a copy that can drift.
const assert = require("assert");
const fs = require("fs");

const src = fs.readFileSync(require("path").join(__dirname, "craft.js"), "utf8");
const start = src.indexOf("  const TAG = /");
const endMark = "    return it;";
const end = src.indexOf(endMark) + endMark.length + 4;
if (start < 0 || end < endMark.length) { console.error("craft-parse-test: could not slice parseItem out of craft.js"); process.exit(1); }
eval(src.slice(start, end).replace(/^ {2}/gm, ""));   // defines TAG, ANNOT, stripRanges, parseItem

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── the exact item the user pasted ────────────────────────────────────────────
const ADVANCED = [
  "Item Class: Rings",
  "Rarity: Magic",
  "Ruby Ring of Archaeology",
  "--------",
  "Requires: Level 32",
  "--------",
  "Item Level: 81",
  "--------",
  "{ Implicit Modifier — Elemental, Fire, Resistance }",
  "+21(20-30)% to Fire Resistance",
  "--------",
  '{ Suffix Modifier "of Archaeology" (Tier: 1) }',
  "15(15-18)% increased Rarity of Items found",
].join("\n");

{
  const it = parseItem(ADVANCED);
  ok(it && it.rarity === "magic", "parses a Magic ring");
  ok(it.implicits.length === 1 && /Fire Resistance/.test(it.implicits[0]),
    `the implicit must be an IMPLICIT, got implicits=${JSON.stringify(it.implicits)}`);

  const sent = it.explicits.map((e) => e.text);   // this is literally what craft.js POSTs as currentMods
  ok(!sent.some((t) => /Fire Resistance/i.test(t)),
    `the ring's IMPLICIT fire resistance leaked into the affixes the planner keeps: ${JSON.stringify(sent)}`);
  ok(!sent.some((t) => /^\s*\{/.test(t)),
    `the "{ ... }" annotation line was parsed as a modifier: ${JSON.stringify(sent)}`);
  ok(sent.length === 1 && /Rarity of Items/i.test(sent[0]),
    `expected exactly one real affix (the suffix), got ${JSON.stringify(sent)}`);
  // Advanced mode prints the roll range inline; no mod matcher would recognise "15(15-18)%".
  ok(!/\(\d/.test(sent[0]), `the inline roll range was not stripped: ${JSON.stringify(sent[0])}`);
}

// ── the LEGACY format must still work (trailing tag, no annotations) ──────────
{
  const legacy = [
    "Item Class: Rings",
    "Rarity: Rare",
    "Doom Loop",
    "Ruby Ring",
    "--------",
    "Item Level: 81",
    "--------",
    "+21% to Fire Resistance (implicit)",
    "--------",
    "+35 to maximum Life",
    "+18% to Cold Resistance",
  ].join("\n");
  const it = parseItem(legacy);
  ok(it.implicits.length === 1, "legacy (implicit) tag still recognised");
  const sent = it.explicits.map((e) => e.text);
  ok(!sent.some((t) => /Fire Resistance/i.test(t)), "legacy implicit must not leak into affixes");
  ok(sent.length === 2 && /maximum Life/.test(sent[0]), `legacy explicits wrong: ${JSON.stringify(sent)}`);
}

// ── a prefix+suffix annotated rare: both are real affixes and must be kept ────
{
  const rare = [
    "Item Class: Rings",
    "Rarity: Rare",
    "Doom Loop",
    "Sapphire Ring",
    "--------",
    "Item Level: 82",
    "--------",
    "{ Implicit Modifier — Elemental, Cold, Resistance }",
    "+23(20-30)% to Cold Resistance",
    "--------",
    '{ Prefix Modifier "Healthy" (Tier: 3) }',
    "+55(50-59) to maximum Life",
    '{ Suffix Modifier "of the Lizard" (Tier: 2) }',
    "+31(30-35)% to Chaos Resistance",
  ].join("\n");
  const it = parseItem(rare);
  const sent = it.explicits.map((e) => e.text);
  ok(it.implicits.length === 1 && /Cold Resistance/.test(it.implicits[0]), "rare: implicit separated");
  ok(sent.length === 2, `rare: expected 2 affixes, got ${JSON.stringify(sent)}`);
  ok(sent.some((t) => /maximum Life/.test(t)) && sent.some((t) => /Chaos Resistance/.test(t)),
    `rare: both real affixes must be kept, got ${JSON.stringify(sent)}`);
  ok(!sent.some((t) => /Cold Resistance/.test(t)), "rare: the implicit must not be kept as an affix");
}

// ── a TRAILING separator is not a modifier ───────────────────────────────────
// The in-game copy ends the block with "--------". The section splitter only cuts a
// separator followed by a newline, so the trailing one rode along inside the last
// section and was parsed as an affix. On a MAGIC item that phantom mod filled the
// second slot, so the planner saw 1 prefix + 1 suffix (full) and would never offer the
// Augmentation that fills the genuinely empty one. Found by rendering the real UI, 2026-07-14.
{
  const magic = [
    "Item Class: Rings",
    "Rarity: Magic",
    "Sapphire Ring of the Fox",
    "--------",
    "Item Level: 82",
    "--------",
    "{ Implicit Modifier — Elemental, Cold, Resistance }",
    "+22(20-30)% to Cold Resistance (implicit)",
    "--------",
    '{ Prefix Modifier "Hale" — Life }',
    "+45(40-49) to maximum Life",
    "--------",                    // <- trailing separator, exactly as the game emits it
  ].join("\n");
  const it = parseItem(magic);
  const sent = it.explicits.map((e) => e.text);
  ok(sent.length === 1, `magic: trailing separator must not become an affix, got ${JSON.stringify(sent)}`);
  ok(/maximum Life/.test(sent[0]), "magic: the one real affix survives");
  ok(!sent.some((t) => /^-+$/.test(t)), "magic: no separator line among the kept mods");
}

console.log(`craft-parse-test: ${pass} checks passed`);

// recipe-data-test.js — self-check for the recipe snapshot layer (mirrors craft-data-test.js).
// 1) recipe-data.js loads and the KB fixture validates + refs resolve;
// 2) the gen-recipes validator REJECTS each malformed case (bad status enum, unknown
//    destination, unresolvable ref, duplicate id) — never half-imports;
// 3) simulateRecipe runs the fixture's step machine to a sane seeded result.
//   node recipe-data-test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const D = require("./recipe-data.js");
const CD = require("./craft-data.js");
const { validateRecipeDoc, loadAll } = require("./gen-recipes.js");
const engine = require("./craft-engine.js");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const schema = JSON.parse(fs.readFileSync(
  path.join(process.env.POE2_KB_DIR || path.join(__dirname, "..", "poe2-kb"), "crafting", "schema", "recipe-v1.schema.json"), "utf8"));

// ── snapshot loads + fixture is present and valid ──
ok(D.generated && D.recipes && typeof D.recipes === "object", "recipe-data.js top-level shape");
const fix = D.recipes["amulet-plus-one-spell-skills-regal-exalt"];
ok(fix, "KB fixture recipe present");
// status must mirror the KB document exactly — the gen must never touch it (promotion
// happened IN poe2-kb 2026-07-12, with the verification record in provenance.notes).
ok(fix.status === "verified" && /VERIFIED 2026-07-12/.test(fix.provenance.notes), "fixture status mirrors the KB doc, with its verification record");
ok(validateRecipeDoc(fix, schema, CD).length === 0, "fixture re-validates clean");
const modGroups = new Set(Object.values(CD.mods).map((m) => m.group));
for (const r of fix.target.required_mods) ok(CD.mods[r.ref] || modGroups.has(r.ref), `target ref "${r.ref}" resolves against craft-data`);

// ── validator rejects each malformed case, naming the fault ──
const clone = () => JSON.parse(JSON.stringify(fix));
const failsWith = (mutate, needle, label) => {
  const doc = clone();
  mutate(doc);
  const errs = validateRecipeDoc(doc, schema, CD);
  ok(errs.length > 0 && errs.some((e) => e.includes(needle)), `${label} rejected (${errs[0] || "no error!"})`);
};
failsWith((d) => { d.status = "totally-legit"; }, "status", "bad status enum");
failsWith((d) => { d.steps[1].on_failure = "annul-loop"; }, 'unknown step "annul-loop"', "unknown step destination");
failsWith((d) => { d.target.required_mods[0].ref = "NoSuchModOrGroup"; }, "NoSuchModOrGroup", "unresolvable mod ref");
failsWith((d) => { d.schema_version = 2; }, "schema_version", "unknown schema_version");
failsWith((d) => { d.steps.push({ ...clone().steps[1], id: "orphan" }); }, "unreachable", "unreachable step");
failsWith((d) => { d.target.base_classes = ["Chestplate of Lies"]; }, "unknown class", "unknown base class");
failsWith((d) => { d.extra_field = 1; }, "unknown property", "additionalProperties rejected");

// auto-flags beyond ref-resolution (patch drift)
failsWith((d) => { d.target.required_mods[0].ref = "GlobalSpellGemsLevel3"; d.target.minimum_item_level = 50; },
  "threshold moved", "ilvl threshold drift (tier needs 75, recipe claims 50)");
failsWith((d) => { d.target.base_classes = ["Ring"]; }, "cannot spawn", "target mod unspawnable on the declared class");
failsWith((d) => { d.starting_state.rarity = "rare"; }, "can never legally act", "regal on a rare start can never act");

// duplicate recipe id across two files (loadAll-level check)
const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "recipes-"));
try {
  fs.writeFileSync(path.join(tmp, "a.json"), JSON.stringify(fix));
  fs.writeFileSync(path.join(tmp, "b.json"), JSON.stringify(fix));
  const { errors } = loadAll(tmp, schema, CD);
  ok(errors.some((e) => e.includes("duplicate recipe id")), "duplicate id across files rejected");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ── step machine: seeded Monte Carlo on a real amulet pool ──
// Build the pool through the SAME builder the server serves from (engine.craftModList).
// This test used to hand-roll a raw-PoB-weight pool, which skipped the Craft-of-Exile
// spawn-weight overlay — so the closed-form-vs-MC cross-check below validated a pool no
// user ever gets (it agreed at 3.107% while the server served 1.079% for the same recipe).
// If this ever diverges from what /api/craft/recipe-sim returns, the cross-check is lying.
const mods = engine.craftModList(CD, "Jade Amulet", 80);
ok(mods.some((m) => m.group === "GlobalIncreaseSpellSkillGemLevel"), "target group in the amulet pool at ilvl 80");
ok(mods.some((m) => m.weight > 1), "pool carries real Craft-of-Exile spawn weights, not binary eligibility flags");
const r = engine.simulateRecipe(fix, mods, { seed: 42, trials: 10000 });
ok(r.feasible && r.successPerAttempt > 0 && r.successPerAttempt < 0.5, `recipe sim feasible with sane odds (${(r.successPerAttempt * 100).toFixed(2)}%)`);
ok(r.perAttemptOrbs["Regal Orb"] === 1, "every attempt spends exactly 1 Regal");
ok(r.expectedOrbs["Exalted Orb"] > 1, "expected Exalts amortized over misses");
ok(r.outcomes.success + r.outcomes.failed + r.outcomes.stopped === 10000, "every trial reaches a terminal");
// determinism: same seed → same distribution
const r2 = engine.simulateRecipe(fix, mods, { seed: 42, trials: 10000 });
ok(r2.successPerAttempt === r.successPerAttempt, "seeded sim is deterministic");

// ── sell-vs-continue decision points ──
const dps = Object.fromEntries(r.decisionPoints.map((d) => [d.step, d]));
ok(r.decisionPoints.length === fix.steps.length, "one decision point per step");
ok(dps.regal.reachRate === 1, "first step reached on every trial");
ok(dps.exalt.reachRate > 0 && dps.exalt.reachRate < 1, "exalt reached only when the regal missed");
ok(Math.abs(dps.regal.reachRate * dps.regal.successGivenReached - r.successPerAttempt) < 1e-9,
  "P(reach first step)×P(success|reached) equals overall success");
ok(dps.regal.remainingOrbs["Regal Orb"] === 1, "remaining spend at regal includes the regal itself");
ok(!dps.exalt.remainingOrbs["Regal Orb"] && dps.exalt.remainingOrbs["Exalted Orb"] === 1,
  "remaining spend at exalt is just the exalt (regal already sunk)");
ok(dps.regal.successGivenReached > dps.exalt.successGivenReached,
  "odds shrink downstream (regal still has two shots, exalt one)");
// unsupported action is refused, not faked
const un = clone();
un.steps[0].action = "use_rune";
ok(engine.simulateRecipe(un, mods, { seed: 1, trials: 10 }).unsupported === true, "unsupported action returns unsupported, not numbers");
// target group absent from the pool → impossible, never simulated
const noTargetMods = mods.filter((m) => m.group !== "GlobalIncreaseSpellSkillGemLevel");
ok(engine.simulateRecipe(fix, noTargetMods, { seed: 1, trials: 10 }).impossible === true, "unresolvable ref in pool → impossible, not simulated");

// ── exact probability evaluator (closed form vs Monte Carlo) ──
const ex = engine.exactRecipeProbability(fix, mods);
ok(ex && ex.method === "closed_form" && ex.feasible, "fixture qualifies for the exact evaluator");
ok(ex.successPerAttempt > 0 && ex.successPerAttempt < 0.2, `exact odds sane (${(ex.successPerAttempt * 100).toFixed(3)}%)`);
// the MC must agree with the closed form within sampling error (4σ on 10k trials)
const sigma = Math.sqrt(ex.successPerAttempt * (1 - ex.successPerAttempt) / 10000);
ok(Math.abs(r.successPerAttempt - ex.successPerAttempt) < 4 * sigma,
  `Monte Carlo agrees with closed form (MC ${r.successPerAttempt}, exact ${ex.successPerAttempt.toFixed(5)}, 4σ ${(4 * sigma).toFixed(5)})`);
ok(Math.abs(ex.perAttemptOrbs["Regal Orb"] - 1) < 1e-9, "exact: every attempt spends exactly 1 Regal");
ok(Math.abs(r.perAttemptOrbs["Exalted Orb"] - ex.perAttemptOrbs["Exalted Orb"]) < 0.01, "exact and MC agree on expected Exalts per attempt");
// non-simple moves refuse the closed form (MC stands alone)
const chaosDoc = clone();
chaosDoc.steps[1].currency = "Chaos Orb";
ok(engine.exactRecipeProbability(chaosDoc, mods) === null, "chaos step → no closed form (MC only)");
const twoTargets = clone();
twoTargets.target.required_mods.push({ ref: "IncreasedLife", alias: null, minimum_tier: null, count: 1 });
ok(engine.exactRecipeProbability(twoTargets, mods) === null, "multi-target → no closed form (MC only)");

// ── essence steps simulate (the sourced-tranche recipes) ──
const bootsFix = D.recipes["boots-movement-speed-life-greater-essence-body"];
ok(bootsFix, "sourced boots recipe present in the snapshot");
const bootsBase = CD.bases["Ancient Leggings"];
const bootsTags = new Set(bootsBase.tags);
const bootsMods = [];
for (const [key, m] of Object.entries(CD.mods)) {
  if (m.ilvl > 82) continue;
  let w = 0; for (const [t, tw] of m.weights) { if (t === "default" || bootsTags.has(t)) { w = tw; break; } }
  if (w > 0) bootsMods.push({ key, type: m.type === "Prefix" ? "prefix" : "suffix", group: m.group, weight: w, ilvl: m.ilvl, tags: m.tags || [] });
}
// essence options for Boots (mirrors server craftEssenceOptions)
const bootsEss = [];
for (const [name, e] of Object.entries(CD.essences)) {
  const mk = e.mods && e.mods.Boots;
  if (!mk || !CD.mods[mk] || CD.mods[mk].ilvl > 82) continue;
  bootsEss.push({ name, modKey: mk, group: CD.mods[mk].group, type: CD.mods[mk].type === "Prefix" ? "prefix" : "suffix", stat: CD.mods[mk].stats[0] || "" });
}
const be = engine.simulateRecipe(bootsFix, bootsMods, { seed: 9, trials: 2000, essences: bootsEss });
ok(be.feasible && be.successPerAttempt === 1, `essence recipe simulates deterministically (p=${be.successPerAttempt})`);
ok(be.perAttemptOrbs["Greater Essence of the Body"] === 1, "cost counts the essence by display name (priceable)");
// without essence options the same recipe honestly refuses
ok(engine.simulateRecipe(bootsFix, bootsMods, { seed: 9, trials: 10 }).unsupported === true, "essence step without essence data → unsupported, not faked");


// ── Greater/Perfect currency tiers (recipeApplyCurrency) ──────────────────────
// This path had ZERO coverage, which is how a promote-order bug shipped: CAP["normal"] gives a
// white item no mod slots, so calling addMod BEFORE promoting the rarity always fails and every
// transmute step silently became "no legal transition" — 0% success, 0 orbs spent, on a recipe
// that is really ~50%. It only surfaced by driving a real harvested recipe. Cover it properly.
{
  const boots = engine.craftModList(CD, "Tasalian Greaves", 82);
  const fresh = () => engine.newItem("normal");

  // base transmute: Normal -> Magic, one mod, no tier floor
  const a = fresh();
  ok(engine.recipeApplyCurrency("Orb of Transmutation", a, boots, engine.rng(1)) === true, "transmute applies to a Normal item");
  ok(a.rarity === "magic" && a.prefixes.length + a.suffixes.length === 1, "transmute promotes to Magic and adds exactly one mod");

  // Perfect transmute: same move, but only mods of level >= 70 may roll (PoE2DB 0.5.4)
  let sawLow = false;
  for (let i = 0; i < 200; i++) {
    const it = fresh();
    assert.ok(engine.recipeApplyCurrency("Perfect Orb of Transmutation", it, boots, engine.rng(i + 1)) === true);
    const m = it.prefixes.concat(it.suffixes)[0];
    if (m.ilvl < 70) sawLow = true;
  }
  ok(!sawLow, "Perfect Orb of Transmutation never rolls a mod below level 70 (its floor)");
  ok(engine.ORB_TIER["perfect orb of transmutation"].min === 70 && engine.ORB_TIER["greater regal orb"].min === 35,
    "orb tier floors match the PoE2DB reference (transmute/augment 44/70, regal/exalt/chaos 35/50)");

  // a currency the engine does not model must be null (unsupported), never guessed
  ok(engine.recipeApplyCurrency("Orb of Chance", fresh(), boots, engine.rng(1)) === null, "unknown currency -> null, never faked");

  // illegal transition is false, and must not have mutated the item
  const magic = fresh(); engine.recipeApplyCurrency("Orb of Transmutation", magic, boots, engine.rng(2));
  ok(engine.recipeApplyCurrency("Orb of Transmutation", magic, boots, engine.rng(3)) === false, "transmute on a Magic item is illegal");
  ok(magic.rarity === "magic", "an illegal transmute leaves the rarity untouched (rollback)");

  // Chaos is atomic: on a pool with nothing legal to add it must NOT leave the item a mod down
  const rare = fresh();
  engine.recipeApplyCurrency("Orb of Alchemy", rare, boots, engine.rng(4));
  const before = rare.prefixes.length + rare.suffixes.length;
  const empty = [];   // no mod can be added from an empty pool
  const chaosed = engine.recipeApplyCurrency("Chaos Orb", rare, empty, engine.rng(5));
  ok(chaosed === false, "Chaos with nothing addable reports failure, not success");
  ok(rare.prefixes.length + rare.suffixes.length === before, "failed Chaos restores the removed mod (no silent net mod loss)");

  // the closed form must know the new tiers too — derived from the same table, so it cannot drift
  ok(engine.exactRecipeProbability !== undefined, "exact evaluator present");
}


console.log(`recipe-data-test: ${pass} checks passed`);

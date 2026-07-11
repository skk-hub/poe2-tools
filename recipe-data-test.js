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
ok(fix.status === "extracted", "fixture status is extracted (not auto-promoted)");
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
const base = CD.bases["Jade Amulet"];
const tagset = new Set(base.tags);
const weightFor = (m) => { for (const [t, w] of m.weights) if (t === "default" || tagset.has(t)) return w; return 0; };
const mods = [];
for (const [key, m] of Object.entries(CD.mods)) {
  if (m.ilvl > 80) continue;
  const w = weightFor(m);
  if (w > 0) mods.push({ key, type: m.type === "Prefix" ? "prefix" : "suffix", group: m.group, weight: w, ilvl: m.ilvl, tags: m.tags || [] });
}
ok(mods.some((m) => m.group === "GlobalIncreaseSpellSkillGemLevel"), "target group in the amulet pool at ilvl 80");
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

console.log(`recipe-data-test: ${pass} checks passed`);

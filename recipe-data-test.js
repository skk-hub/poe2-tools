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
// unsupported action is refused, not faked
const un = clone();
un.steps[0].action = "use_rune";
ok(engine.simulateRecipe(un, mods, { seed: 1, trials: 10 }).unsupported === true, "unsupported action returns unsupported, not numbers");
// target group absent from the pool → impossible, never simulated
const noTargetMods = mods.filter((m) => m.group !== "GlobalIncreaseSpellSkillGemLevel");
ok(engine.simulateRecipe(fix, noTargetMods, { seed: 1, trials: 10 }).impossible === true, "unresolvable ref in pool → impossible, not simulated");

console.log(`recipe-data-test: ${pass} checks passed`);

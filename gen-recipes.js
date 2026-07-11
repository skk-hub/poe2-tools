// gen-recipes.js — snapshot poe2-kb crafting recipes into a committed recipe-data.js,
// the same shape as gen-craft-data.lua → craft-data.js: the deployed container has no
// poe2-kb checkout, so a build-time snapshot is the only thing that works with the
// current deploy flow. Zero-dep.
//
//   node gen-recipes.js            (reads ../poe2-kb/crafting/recipes, writes recipe-data.js)
//
// Validation is REJECT-with-path, fail the gen, never half-import:
//   1. structural — checked against the KB's recipe-v1 JSON Schema (a small evaluator for
//      exactly the keyword subset that schema uses; not a general JSON Schema engine).
//   2. semantic — the checks a schema can't express: unknown schema_version, duplicate
//      recipe ids, step destinations resolve, no unreachable steps, cycles have a stop
//      condition, every mod ref resolves against craft-data.js (PoB id or group), base
//      classes/names resolve, only allowlisted predicates.
// Recipe documents are DATA ONLY — this file validates them, never evaluates anything in them.

const fs = require("fs");
const path = require("path");

const KB_DIR = process.env.POE2_KB_DIR || path.join(__dirname, "..", "poe2-kb");
const RECIPES_DIR = path.join(KB_DIR, "crafting", "recipes");
const SCHEMA_FILE = path.join(KB_DIR, "crafting", "schema", "recipe-v1.schema.json");
const OUT_FILE = path.join(__dirname, "recipe-data.js");

// ── structural: minimal JSON Schema evaluator ─────────────────────────────────
// Supports the keywords recipe-v1 actually uses: $ref(#/$defs/…), type (incl. arrays +
// "integer"), const, enum, required, properties, additionalProperties:false, items,
// minItems, minLength, pattern, minimum, maximum, oneOf. format/default are annotations.
function typeOk(t, v) {
  if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
  if (t === "array") return Array.isArray(v);
  if (t === "string") return typeof v === "string";
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number";
  if (t === "boolean") return typeof v === "boolean";
  if (t === "null") return v === null;
  return true;
}
function schemaErrors(schema, data, at, root) {
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!m || !root.$defs || !root.$defs[m[1]]) return [`${at}: unresolvable $ref ${schema.$ref}`];
    return schemaErrors(root.$defs[m[1]], data, at, root);
  }
  const errs = [];
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => schemaErrors(s, data, at, root).length === 0).length;
    if (hits !== 1) errs.push(`${at}: matches ${hits} of the allowed condition shapes (must match exactly 1)`);
    return errs; // oneOf branches carry the detail; a combined dump is noise
  }
  if (schema.const !== undefined && data !== schema.const) { errs.push(`${at}: must be ${JSON.stringify(schema.const)}`); return errs; }
  if (schema.enum && !schema.enum.includes(data)) { errs.push(`${at}: "${data}" not in [${schema.enum.join(", ")}]`); return errs; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, data))) { errs.push(`${at}: expected ${types.join("|")}`); return errs; }
    if (data === null) return errs; // nullable and null → nothing more to check
  }
  if (typeof data === "string") {
    if (schema.minLength != null && data.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errs.push(`${at}: "${data}" does not match ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if (schema.minimum != null && data < schema.minimum) errs.push(`${at}: ${data} < minimum ${schema.minimum}`);
    if (schema.maximum != null && data > schema.maximum) errs.push(`${at}: ${data} > maximum ${schema.maximum}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) for (let i = 0; i < data.length; i++) errs.push(...schemaErrors(schema.items, data[i], `${at}[${i}]`, root));
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const r of schema.required || []) if (!(r in data)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, v] of Object.entries(data)) {
      if (schema.properties && schema.properties[k]) errs.push(...schemaErrors(schema.properties[k], v, at ? `${at}.${k}` : k, root));
      else if (schema.additionalProperties === false && schema.properties) errs.push(`${at ? at + "." : ""}${k}: unknown property`);
    }
  }
  return errs;
}

// ── semantic: everything the schema can't say ─────────────────────────────────
const TERMINALS = new Set(["finish", "stop", "fail"]);
const PREDICATES = new Set(["has_mod", "missing_mod", "open_prefixes_at_least", "open_suffixes_at_least", "rarity_is"]);
const EXPRESSIONS = new Set(["target_satisfied", "no_legal_transition"]);

// Walk a condition tree, collecting {ref} mod refs and flagging unknown predicates.
function walkCondition(c, at, refs, errs) {
  if (!c || typeof c !== "object") { errs.push(`${at}: not a condition object`); return; }
  if (c.all || c.any) {
    const arr = c.all || c.any;
    if (Array.isArray(arr)) arr.forEach((sub, i) => walkCondition(sub, `${at}.${c.all ? "all" : "any"}[${i}]`, refs, errs));
    return;
  }
  if (c.expression !== undefined) { if (!EXPRESSIONS.has(c.expression)) errs.push(`${at}: unknown expression "${c.expression}"`); return; }
  if (c.predicate !== undefined) {
    if (!PREDICATES.has(c.predicate)) errs.push(`${at}: predicate "${c.predicate}" not allowlisted`);
    if (c.ref !== undefined) refs.push({ ref: c.ref, at: `${at}.ref` });
    return;
  }
  errs.push(`${at}: condition has no expression/predicate/all/any`);
}

function semanticErrors(doc, craftData) {
  const errs = [];
  if (doc.schema_version !== 1) { errs.push(`schema_version: unknown version ${JSON.stringify(doc.schema_version)} (this generator understands 1)`); return errs; }

  // step graph: unique ids, destinations resolve, all reachable from steps[0], cycles need a stop condition
  const stepIds = new Set();
  for (const [i, s] of (doc.steps || []).entries()) {
    if (stepIds.has(s.id)) errs.push(`steps[${i}].id: duplicate step "${s.id}"`);
    stepIds.add(s.id);
  }
  const dests = new Map(); // step id → [dest ids]
  for (const [i, s] of (doc.steps || []).entries()) {
    const out = [];
    for (const k of ["on_success", "on_failure"]) {
      const d = s[k];
      if (!TERMINALS.has(d)) {
        if (!stepIds.has(d)) errs.push(`steps[${i}].${k}: unknown step "${d}"`);
        else out.push(d);
      }
    }
    dests.set(s.id, out);
  }
  if (doc.steps && doc.steps.length) {
    const seen = new Set([doc.steps[0].id]);
    const queue = [doc.steps[0].id];
    while (queue.length) for (const d of dests.get(queue.pop()) || []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    for (const [i, s] of doc.steps.entries()) if (!seen.has(s.id)) errs.push(`steps[${i}]: step "${s.id}" unreachable from "${doc.steps[0].id}"`);
    // cycle detection (DFS colors); a cycle is only legal when a stop condition can break it
    const color = new Map();
    let cyclic = false;
    const dfs = (id) => {
      color.set(id, 1);
      for (const d of dests.get(id) || []) {
        if (color.get(d) === 1) cyclic = true;
        else if (!color.get(d)) dfs(d);
      }
      color.set(id, 2);
    };
    dfs(doc.steps[0].id);
    if (cyclic && !(Array.isArray(doc.stop_conditions) && doc.stop_conditions.length))
      errs.push(`steps: the step graph has a cycle but no stop_conditions to break it`);
  }

  // collect every mod ref: target lists, starting_state lists, and all conditions
  const refs = [];
  const modList = (arr, at) => (arr || []).forEach((m, i) => { if (m && m.ref !== undefined) refs.push({ ref: m.ref, at: `${at}[${i}].ref` }); });
  modList((doc.target || {}).required_mods, "target.required_mods");
  modList((doc.target || {}).optional_mods, "target.optional_mods");
  modList((doc.target || {}).forbidden_mods, "target.forbidden_mods");
  modList((doc.starting_state || {}).required_mods, "starting_state.required_mods");
  modList((doc.starting_state || {}).forbidden_mods, "starting_state.forbidden_mods");
  for (const [i, s] of (doc.steps || []).entries()) {
    (s.preconditions || []).forEach((c, j) => walkCondition(c, `steps[${i}].preconditions[${j}]`, refs, errs));
    if (s.success_when) walkCondition(s.success_when, `steps[${i}].success_when`, refs, errs);
  }
  (doc.stop_conditions || []).forEach((sc, i) => { if (sc && sc.expression) walkCondition(sc.expression, `stop_conditions[${i}].expression`, refs, errs); });

  // every ref resolves against craft-data.js: a PoB mod id (key) or a mod group
  const modKeys = new Set(Object.keys(craftData.mods));
  const modGroups = new Set(Object.values(craftData.mods).map((m) => m.group));
  for (const { ref, at } of refs) if (!modKeys.has(ref) && !modGroups.has(ref)) errs.push(`${at}: "${ref}" is neither a craft-data mod id nor a mod group`);

  // base classes / base names are craft-data display names
  const classes = new Set(Object.values(craftData.bases).map((b) => b.class));
  for (const [i, c] of ((doc.target || {}).base_classes || []).entries()) if (!classes.has(c)) errs.push(`target.base_classes[${i}]: unknown class "${c}"`);
  for (const [i, b] of ((doc.target || {}).bases || []).entries()) if (!craftData.bases[b]) errs.push(`target.bases[${i}]: unknown base "${b}"`);

  // ── auto-flags beyond ref-resolution (patch drift) ──
  // (a) ilvl thresholds: every required target mod must be SPAWNABLE on at least one of
  // the declared bases AT the declared minimum_item_level — catches GGG moving a tier's
  // ilvl (recipe says 75, the mod now needs 81 → the doc is mechanically wrong).
  const weightFor = (mod, base) => {   // same first-tag-wins rule as server craftWeightFor
    const tagset = new Set(base.tags);
    for (const [tag, w] of mod.weights) if (tag === "default" || tagset.has(tag)) return w;
    return 0;
  };
  const declaredBases = ((doc.target || {}).bases || []).length
    ? (doc.target.bases || []).map((n) => craftData.bases[n]).filter(Boolean)
    : Object.values(craftData.bases).filter((b) => ((doc.target || {}).base_classes || []).includes(b.class));
  const minIlvl = (doc.target || {}).minimum_item_level || 100;
  if (declaredBases.length) {
    for (const [i, r] of ((doc.target || {}).required_mods || []).entries()) {
      const tiers = Object.entries(craftData.mods).filter(([k, m]) => k === r.ref || m.group === r.ref);
      if (!tiers.length) continue;   // unresolvable — already reported above
      let spawnIlvl = Infinity;
      for (const [, m] of tiers) if (declaredBases.some((b) => weightFor(m, b) > 0)) spawnIlvl = Math.min(spawnIlvl, m.ilvl);
      if (spawnIlvl === Infinity) errs.push(`target.required_mods[${i}]: "${r.ref}" cannot spawn on the declared bases at all`);
      else if (spawnIlvl > minIlvl) errs.push(`target.required_mods[${i}]: "${r.ref}" needs item level ${spawnIlvl} on these bases, but the recipe claims minimum_item_level ${minIlvl} (threshold moved?)`);
    }
  }
  // (b) a step that can never legally act: propagate the possible arrival RARITIES through
  // the step graph from starting_state; a step whose currency's required rarity is disjoint
  // from every rarity it can arrive with can't produce its claimed result. Only PROVABLE
  // breaks flag — unknown currencies/actions pass "any rarity" through (no false positives).
  const CURRENCY_RARITY = {   // display name (lowercased) → [fromRarity, toRarity]
    "orb of transmutation": ["normal", "magic"], "orb of augmentation": ["magic", "magic"],
    "regal orb": ["magic", "rare"], "orb of alchemy": ["normal", "rare"],
    "exalted orb": ["rare", "rare"], "greater exalted orb": ["rare", "rare"], "perfect exalted orb": ["rare", "rare"],
    "chaos orb": ["rare", "rare"], "orb of annulment": ["rare", "rare"],
  };
  if (doc.steps && doc.steps.length && doc.starting_state && !errs.length) {
    const stepByIdx = new Map(doc.steps.map((s, i) => [s.id, i]));
    const arrive = doc.steps.map(() => new Set());
    arrive[0].add(doc.starting_state.rarity);
    const queue = [0];
    while (queue.length) {
      const i = queue.shift();
      const s = doc.steps[i];
      const cr = s.action === "use_currency" || s.action === "use_omen_combo" ? CURRENCY_RARITY[String(s.currency || "").toLowerCase()] : null;
      // exit rarities: known currency → its result rarity iff it can legally act here
      // (an "any" arrival keeps "any" alive — could be anything); unknown → "any".
      let exits;
      if (!cr) exits = ["any"];
      else {
        exits = [];
        if ([...arrive[i]].some((x) => x === cr[0])) exits.push(cr[1]);
        if (arrive[i].has("any")) exits.push("any");
      }
      for (const d of [s.on_success, s.on_failure]) {
        if (!stepByIdx.has(d)) continue;
        const j = stepByIdx.get(d);
        let grew = false;
        for (const x of exits) if (!arrive[j].has(x)) { arrive[j].add(x); grew = true; }
        if (grew) queue.push(j);
      }
    }
    for (const [i, s] of doc.steps.entries()) {
      const cr = s.action === "use_currency" || s.action === "use_omen_combo" ? CURRENCY_RARITY[String(s.currency || "").toLowerCase()] : null;
      if (!cr || !arrive[i].size || arrive[i].has("any")) continue;
      if (![...arrive[i]].some((x) => x === cr[0])) errs.push(`steps[${i}]: "${s.currency}" needs a ${cr[0]} item but this step is only reached with ${[...arrive[i]].join("/")} — it can never legally act`);
    }
  }

  return errs;
}

// Validate one recipe document (structural + semantic). Returns [errors]; empty = valid.
function validateRecipeDoc(doc, schema, craftData) {
  const errs = schemaErrors(schema, doc, "", schema);
  if (errs.length) return errs; // structure broken → semantic checks would just cascade noise
  return semanticErrors(doc, craftData);
}

// Load + validate every recipe under dir. Returns {recipes:{id:doc}, errors:[…]} —
// callers must treat ANY error as fatal (never half-import).
function loadAll(dir, schema, craftData) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".json")) files.push(path.join(d, e.name));
    }
  })(dir);
  files.sort();
  const recipes = {};
  const errors = [];
  const idFile = {};
  for (const f of files) {
    const rel = path.relative(dir, f).split(path.sep).join("/");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { errors.push(`${rel}: invalid JSON — ${e.message}`); continue; }
    for (const err of validateRecipeDoc(doc, schema, craftData)) errors.push(`${rel}: ${err}`);
    if (doc && doc.id) {
      if (idFile[doc.id]) errors.push(`${rel}: duplicate recipe id "${doc.id}" (also in ${idFile[doc.id]})`);
      else { idFile[doc.id] = rel; recipes[doc.id] = doc; }
    }
  }
  return { recipes, errors };
}

module.exports = { schemaErrors, semanticErrors, validateRecipeDoc, loadAll };

if (require.main === module) {
  let craftData;
  try { craftData = require("./craft-data.js"); }
  catch { console.error("craft-data.js not generated — run gen-craft-data.lua first"); process.exit(1); }
  let schema;
  try { schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")); }
  catch (e) { console.error(`cannot read schema ${SCHEMA_FILE}: ${e.message}`); process.exit(1); }
  if (!fs.existsSync(RECIPES_DIR)) { console.error(`recipes dir not found: ${RECIPES_DIR} (set POE2_KB_DIR)`); process.exit(1); }

  const { recipes, errors } = loadAll(RECIPES_DIR, schema, craftData);
  if (errors.length) {
    console.error(`gen-recipes: ${errors.length} error(s) — nothing written:`);
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }
  const out = { generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"), source: "poe2-kb/crafting/recipes", recipes };
  fs.writeFileSync(OUT_FILE, "// recipe-data.js — GENERATED by gen-recipes.js from poe2-kb crafting recipes. Do not edit;\n// edit the recipe documents in ../poe2-kb/crafting/recipes and re-run: node gen-recipes.js\n" +
    "module.exports = " + JSON.stringify(out) + ";\n");
  console.log(`gen-recipes: wrote ${Object.keys(recipes).length} recipe(s) to recipe-data.js`);
}

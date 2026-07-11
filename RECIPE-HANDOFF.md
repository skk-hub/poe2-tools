# Recipe layer handoff — poe2-kb → poe-tools (2026-07-11)

`../poe2-kb` now ships a declarative crafting-recipe contract. This repo owns
everything executable about it. Design rationale: `poe2-kb/meta/recipe-schema-proposal.md`.

## What exists (in `../poe2-kb`, pushed to `skk-hub/poe2-kb-knowledge`)

- `crafting/schema/recipe-v1.schema.json` — JSON Schema 2020-12 for recipe documents.
- `crafting/recipes/**/*.json` — recipe documents. First fixture:
  `crafting/recipes/amulets/plus-one-spell-skills-amulet.json` (`status: extracted`,
  already validated against the schema).
- Recipes are **JSON, not YAML** — chosen because this repo is zero-dep Node:
  `JSON.parse` is the whole "safe loader".

## The contract

- **Mod refs are THIS repo's canonical ids**: a PoB mod id (`GlobalSpellGemsLevel3`)
  or mod group (`GlobalIncreaseSpellSkillGemLevel`) from `craft-data.js`. A group ref
  means "any tier of the group" — same semantics as `rankMethods`' `targetGroups`.
  `alias` fields are display-only, never resolved.
- Base classes / base names are `craft-data.js` display names (`"Amulet"`, `"Jade Amulet"`).
- Step graph: each step's `on_success`/`on_failure` is another step id or a terminal
  (`finish` | `stop` | `fail`). Conditions are a small structured vocabulary
  (`target_satisfied`, `has_mod`/`missing_mod` + ref, `open_prefixes_at_least`/
  `open_suffixes_at_least` + value, `rarity_is` + value, `all`/`any` combinators,
  `no_legal_transition`) — see the schema's `$defs.condition`. No free-form strings.
- Recipe `status` lifecycle: `draft | extracted | verified | superseded`. Treat only
  `verified` as trustworthy; `extracted` may be mechanically wrong. `superseded` is
  ignored by default.

## Work in this repo (proposal "Adoption sequence" steps 2+)

1. **Snapshot recipes into the image** the same way the mod pool already works
   (`gen-craft-data.lua` → `craft-data.js`): a small `gen-recipes.js` that reads
   `../poe2-kb/crafting/recipes/**/*.json` + the schema, validates, and writes a
   committed `recipe-data.js`. The deployed container has no `poe2-kb` checkout, so
   a build-time snapshot is the only shape that works with the current deploy flow.
2. **Validator** (build-time, in `gen-recipes.js`): structural check against the
   schema's shape, then the checks a schema can't express — unknown `schema_version`,
   duplicate recipe ids, step destinations that resolve, no unreachable steps, cycles
   have a stop condition, every `ref` resolves against `craft-data.js` (id or group),
   only allowlisted predicates. Reject with the document path
   (`steps[1].on_failure: unknown step "annul-loop"`), fail the gen, never
   half-import.
3. **Engine hookup**: a recipe is a step machine over moves the engine already
   simulates (`simulateFresh`/`simulateDirected`/… in `craft-engine.js`). Suggested
   surface: `GET /api/craft/recipes` (list: id, name, status, target) and
   `POST /api/craft/recipe-sim` `{id, base, ilvl}` → Monte Carlo cost/success
   distribution priced in divine like `/api/craft/simulate`. Reuse the existing
   seeded-RNG pattern from the engine tests.
4. **Tests**: `recipe-data-test.js` mirroring `craft-data-test.js` — fixture loads
   + validates; malformed cases rejected (bad status enum, unknown destination,
   unresolvable ref, duplicate id). Wire into `smoke-test.js`.

## Boundaries (hard rules)

- **Nothing flows back into poe2-kb**: no simulation output, cached probabilities,
  prices, or generated recommendations in that repo. It is data-only and is the
  confined ingest Claude's cwd.
- Never execute/simulate a recipe whose refs didn't resolve; never auto-promote
  `extracted` → `verified` (promotion happens in poe2-kb, with sources).
- Recipe documents must stay free of executable content — the validator enforces,
  never evaluates.

## Definition of done

`gen-recipes.js` produces `recipe-data.js` from the KB fixture; validator rejects
each malformed-case test; `/api/craft/recipes` lists the fixture;
`/api/craft/recipe-sim` returns a priced distribution for it; smoke green.

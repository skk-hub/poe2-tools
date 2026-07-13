// craft-plan.js — the crafting PLANNER: composes routes out of the move-set instead of
// hard-coding them.
//
// WHY THIS EXISTS (read before changing it)
// -----------------------------------------
// This replaces 13 bespoke simulate*() functions in craft-engine.js. Each of those was one
// frozen route someone had written by hand, which meant the engine's knowledge was exactly the
// list of routes a human had bothered to implement — and so it "forgot" mechanics nobody had
// gotten around to: Hinekora's Lock, Greater Exaltation, targeted Regals, Crystallisation
// omens, the desecration steering omens. You cannot fix that by writing a 14th function; the
// shape of the code was the bug.
//
// So: a MOVE is data (poe2-kb/crafting/methods.json → method-data.js), a ROUTE is a composition
// of moves, and the planner ENUMERATES routes and simulates them. Adding a mechanic to the
// engine is now a catalog entry, not a new function, and plan-coverage-test.js fails if the
// catalog carries a searchable move this file cannot execute. The engine can no longer silently
// forget a path.
//
// A route is (start → guarantee? → {fill | fix}* ) with an optional Hinekora's Lock on the
// slams. That is not a simplification of PoE2 crafting, it IS PoE2 crafting: every one of the
// old 13 methods is an instance of it, and the equivalence test in craft-plan-test.js pins
// that (the planner reproduces the old hand-written odds within sampling error).
//
// Odds model is unchanged and still the community/Craft-of-Exile standard — see craft-engine.js.

const E = require("./craft-engine.js");
const METHODS = require("./method-data.js");

const CAP = E.CAP;
const PRACTICAL_MIN = 0.02;      // below this per-attempt success, a route is a fantasy (see rank())
const REFINE_TRIALS = 3000;      // accurate pass over the survivors — these are the REPORTED odds
const REFINE_KEEP = 8;           // (±0.9% at p=0.5 — well inside the precision a whole-% display needs)
const CHURN_CAP = 120;           // max fix-moves in one attempt before the item is scrapped
// The SCREEN pass only has to RANK routes well enough to pick the survivors — the numbers it
// produces are THROWN AWAY and re-measured at REFINE_TRIALS. So it runs fewer trials AND a
// shallower churn cap: a chaos-spam route iterates up to CHURN_CAP times per trial, and that is
// what actually costs the time (enumerating hundreds of routes instead of 13 made this the whole
// budget — advise was 5.5s per candidate, i.e. 21s on the VM, before this split). A shallow cap
// understates spam routes' success, but it understates them CONSISTENTLY, so the ORDERING it
// hands to refine survives — and whatever it promotes is then measured honestly at full depth.
// ponytail: a route sitting near p=PRACTICAL_MIN can miss the shortlist on screen noise; it would
// have been flagged impractical anyway. Raise SCREEN_TRIALS if that ever bites.
const SCREEN_TRIALS = 80;
const SCREEN_CHURN_CAP = 30;

const MOVES = {};
for (const m of METHODS.moves) MOVES[m.id] = m;

// Searchable moves this planner deliberately does NOT compose into routes, with the reason.
// plan-coverage-test.js requires every search:true move to be either executable here or named
// in this map — that is the whole anti-forgetting contract, so a reason must be a real reason.
const UNSUPPORTED = {
  "desecrate-putrefaction": "replaces ALL mods and corrupts — a total reroll, not a step toward a target; only ever a deliberate last resort",
  "desecrate-faction": "narrows the reveal pool to one faction, but poe2db publishes no per-faction reveal weights, so any odds we produced would be invented",
};

// ── item helpers (the primitives live in craft-engine; targets/state logic lives here) ──
const clone = (it) => ({
  rarity: it.rarity, quality: it.quality || 0, corrupted: !!it.corrupted,
  prefixes: it.prefixes.map((m) => ({ ...m })), suffixes: it.suffixes.map((m) => ({ ...m })),
});
const openOn = (item, side) => CAP[item.rarity][side] - item[side === "prefix" ? "prefixes" : "suffixes"].length;
const openAffixes = (item) => openOn(item, "prefix") + openOn(item, "suffix");
const affixCount = (item) => item.prefixes.length + item.suffixes.length;
const hasGroup = (item, g) => item.prefixes.some((m) => m.group === g) || item.suffixes.some((m) => m.group === g);

function targetMet(item, t) {
  const hit = (m) => m.group === t.group && (!t.keys || t.keys.has(m.key));
  return item.prefixes.some(hit) || item.suffixes.some(hit);
}
const allMet = (item, T) => T.every((t) => targetMet(item, t));
// The side of the first unmet target — what a steered move should aim at.
function unmetSide(item, T) {
  for (const t of T) if (!targetMet(item, t)) return t.type;
  return null;
}
// Normalize targets and resolve each one's SIDE from the pool (a target is a prefix or a
// suffix; the planner needs to know which, to steer omens and to check the 3/3 cap).
function prepTargets(targets, mods) {
  const byGroup = {};
  for (const m of mods) if (!byGroup[m.group]) byGroup[m.group] = m;
  return (targets || []).map((t) => {
    const o = typeof t === "string" ? { group: t } : { ...t };
    const keys = o.keys && o.keys.length ? new Set(o.keys) : null;
    const pool = byGroup[o.group];
    return {
      group: o.group, keys, desecrated: !!o.desecrated, poolN: o.poolN, key: o.key,
      // kept = already ON the pasted item. It is a target only in the sense that LOSING it is a
      // failure; no move has to roll it, so it must not constrain which moves are legal (see rollT).
      kept: !!o.kept,
      type: o.type || (pool ? pool.type : "prefix"),
    };
  });
}
// Lowest mod level among the tiers a target ACCEPTS — a min_mod_level move that floors above
// this can never roll the target, so it must not be offered as that target's fill.
function targetMinLevel(mods, t) {
  let lo = Infinity;
  for (const m of mods) {
    if (m.group !== t.group) continue;
    if (t.keys && !t.keys.has(m.key)) continue;
    if (m.ilvl < lo) lo = m.ilvl;
  }
  return lo === Infinity ? 0 : lo;
}
function targetTags(mods, t) {
  const s = new Set();
  for (const m of mods) {
    if (m.group !== t.group) continue;
    if (t.keys && !t.keys.has(m.key)) continue;
    for (const tg of m.tags || []) s.add(tg);
  }
  return s;
}
const groupWeight = (mods, t) =>
  mods.filter((m) => m.group === t.group && (!t.keys || t.keys.has(m.key))).reduce((s, m) => s + m.weight, 0);

// The essence that guarantees the HARDEST unmet target (rarest by spawn weight = biggest payoff).
// perfect=true selects the Rare-applicable essences, false the Magic-applicable ones.
function pickEssence(mods, T, essences, perfect) {
  const pool = (essences || []).filter((e) => perfect === /^(Perfect|Corrupted)\b/i.test(e.name));
  let best = null;
  for (const t of T) {
    if (t.desecrated) continue;
    const opts = pool.filter((e) => e.group === t.group && (!t.keys || t.keys.has(e.modKey)));
    if (!opts.length) continue;
    const w = groupWeight(mods, t);
    if (!best || w < best.w) best = { e: opts[0], w };
  }
  return best ? best.e : null;
}

// ── move execution ───────────────────────────────────────────────────────────
// legal(): the move's `requires` block, evaluated against the item. Generic — a new move with
// a new requires key needs a case here, and the coverage test will catch it if it doesn't.
function legal(move, item, ctx) {
  const r = move.requires || {};
  if (item.corrupted) return false;                                   // corrupted = no more crafting, ever
  if (r.rarity && item.rarity !== r.rarity) return false;
  if (r.open_affix && openAffixes(item) < r.open_affix) return false;
  if (r.open_prefix && openOn(item, "prefix") < r.open_prefix) return false;
  if (r.open_suffix && openOn(item, "suffix") < r.open_suffix) return false;
  if (r.has_affix && affixCount(item) < r.has_affix) return false;
  if (r.has_prefix && item.prefixes.length < r.has_prefix) return false;
  if (r.has_suffix && item.suffixes.length < r.has_suffix) return false;
  if (r.has_desecrated && !item.prefixes.concat(item.suffixes).some((m) => m.desecrated)) return false;
  // "Items with Desecrated Modifiers cannot be Desecrated again" (revealed or not). Repeat
  // desecration IS legal — but only after an Orb of Annulment + Omen of Light removes the existing
  // one, so the route must PAY for that scrub. Without this gate the planner happily boned an item
  // that already carried a desecrated mod, which is illegal in game; it bit routes chasing TWO
  // desecrated targets (the scrub loop for one target happened to respect the rule by accident).
  // Omen of Putrefaction is exempt in the catalog — it replaces every modifier.
  if (r.desecrated_absent && item.prefixes.concat(item.suffixes).some((m) => m.desecrated)) return false;
  if (r.quality && !(item.quality > 0)) return false;
  if (r.item_class === "jewellery" && !ctx.jewellery) return false;
  if (r.group_absent === "essence_group" && ctx.essence && hasGroup(item, ctx.essence.group)) return false;
  return true;
}

// apply(): run the move's effect. Returns true if it acted, false if it could not (a no-op is
// never reported as success — the old recipe machine had a bug exactly here, where a Chaos that
// couldn't add left the item a mod DOWN and still claimed to have worked).
function apply(move, item, ctx, rnd, cost) {
  const e = move.effect;
  const min = e.min_mod_level || undefined;
  const side = e.side || null;
  const restrict = e.restrict === "same_tag_as_item" ? E.itemTags(item) : null;
  const boost = e.restrict === "catalysed_tag" ? ctx.catalysedTags : null;
  const add = (sd) =>
    restrict || boost
      ? E.addModBiased(item, ctx.mods, rnd, sd, min, restrict, boost, boost ? 3 : 1)
      : E.addMod(item, ctx.mods, rnd, sd, min);

  const charge = () => {
    cost[move.currency === "<essence>" || move.currency === "<perfect essence>" ? ctx.essence.name : move.currency] =
      (cost[move.currency === "<essence>" || move.currency === "<perfect essence>" ? ctx.essence.name : move.currency] || 0) + 1;
    for (const o of move.omens || []) cost[o] = (cost[o] || 0) + 1;
  };

  switch (e.kind) {
    case "upgrade_add": {
      const from = item.rarity;
      item.rarity = e.to_rarity;
      let added = 0;
      const n = e.adds || 1;
      // max_side (Sinistral/Dextral Alchemy): fill that side to cap first, then the rest.
      if (e.max_side) {
        while (openOn(item, e.max_side) > 0 && added < n) { if (!add(e.max_side)) break; added++; }
      }
      while (added < n) { if (!add(side)) break; added++; }
      if (!added) { item.rarity = from; return false; }               // atomic: never a promoted item with no mod
      charge();
      return true;
    }
    case "add": {
      let added = 0;
      const n = e.adds || 1;
      while (added < n) { if (!add(side)) break; added++; }
      if (!added) return false;
      charge();
      return true;
    }
    case "replace": {                                                  // Chaos: remove one, add one — atomic
      const pre = item.prefixes.slice(), suf = item.suffixes.slice();
      const removed = e.remove_side
        ? E.removeRandomOnSide(item, e.remove_side, rnd)
        : e.pick === "lowest_level"
          ? E.removeLowestIlvl(item)
          : removeRandomUnfractured(item, rnd);
      if (!removed) return false;
      if (!add(null)) { item.prefixes = pre; item.suffixes = suf; return false; }
      charge();
      return true;
    }
    case "remove": {
      let n = e.removes || 1, done = 0;
      while (done < n) {
        const ok = e.pick === "desecrated"
          ? removeOneDesecrated(item, rnd)
          : e.remove_side
            ? E.removeRandomOnSide(item, e.remove_side, rnd)
            : removeRandomUnfractured(item, rnd);
        if (!ok) break;
        done++;
      }
      if (!done) return false;
      charge();
      return true;
    }
    case "guarantee_add": {                                            // essence
      const g = ctx.essence;
      if (!g || hasGroup(item, g.group)) return false;                 // one mod per group — essence is illegal
      if (e.removes) {                                                 // Perfect/Corrupted: removes first
        // The "random" removal is NOT random when the essence's own side is already full. A Rare
        // cannot hold four suffixes, so a suffix essence facing three suffixes has no legal way to
        // make room except by eating a SUFFIX — the removal is forced to that side and every prefix
        // is safe. Randomness only returns when the essence's side has a free slot.
        //   → A full target side is a Crystallisation omen FOR FREE, which is why serious crafts are
        //     built one side at a time. We previously modelled this as "remove randomly, then remove a
        //     SECOND mod to open the side" — an assumption I invented, which both destroyed an extra
        //     mod and let a Perfect essence eat a top prefix it can never touch. It made the engine
        //     reject safe crafts as risky and pay for omens the slot rule already gives away.
        // Sourced: poe2-kb/crafting/techniques/a-full-side-forces-the-essence-removal-to-that-side.md
        const side = g.type;
        const sideFull = openOn(item, side) < 1;
        const ok = e.remove_side                                       // Crystallisation omen: caller steers it
          ? E.removeRandomOnSide(item, e.remove_side, rnd)
          : sideFull
            ? E.removeRandomOnSide(item, side, rnd)                    // forced — the only legal way to make room
            : removeRandomUnfractured(item, rnd);                      // genuinely random across both sides
        if (!ok) return false;
      }
      if (e.to_rarity) item.rarity = e.to_rarity;
      if (openOn(item, g.type) < 1) return false;                      // still no room → the move cannot happen
      (g.type === "prefix" ? item.prefixes : item.suffixes).push({ key: g.modKey, group: g.group, type: g.type, ilvl: 1, tags: g.tags || [] });
      charge();
      return true;
    }
    case "reveal_pick": {                                              // desecration (Well of Souls)
      const t = ctx.desecTarget;
      if (!t) return false;
      const sd = e.side || t.type;
      if (openOn(item, sd) < 1) return false;
      // P(the mod you want is among the k revealed) ≈ reveal/poolN. ESTIMATE: poe2db publishes
      // no per-base reveal weights (the KB reference says so), so this models the STRUCTURE, not
      // exact weights — the route is flagged estimate:true and the UI must say so.
      const poolN = Math.max(e.reveal || 3, t.poolN || 30);
      let p = Math.min(1, (e.reveal || 3) / poolN);
      if (e.reroll_options) p = 1 - (1 - p) ** 2;                      // Omen of Abyssal Echoes: one reroll of the offer
      charge();
      if (rnd() >= p) {                                                // missed → a junk desecrated mod took the slot
        (sd === "prefix" ? item.prefixes : item.suffixes).push({ key: "__desec_junk", group: "__desec_junk_" + affixCount(item), type: sd, ilvl: 1, desecrated: true });
        return true;
      }
      (sd === "prefix" ? item.prefixes : item.suffixes).push({ key: t.key || t.group, group: t.group, type: sd, ilvl: 1, desecrated: true });
      return true;
    }
    case "fracture": {
      const all = item.prefixes.concat(item.suffixes);
      if (all.length < (move.requires.has_affix || 4)) return false;
      const f = all[Math.floor(rnd() * all.length)];                   // RANDOM — you do not choose
      f.fractured = true;
      charge();
      return true;
    }
    case "foresee":                                                    // handled by the lock wrapper, never applied alone
      return false;
    default:
      return false;
  }
}
function removeRandomUnfractured(item, rnd) {
  const idx = [];
  for (let i = 0; i < item.prefixes.length; i++) if (!item.prefixes[i].fractured) idx.push(["prefix", i]);
  for (let i = 0; i < item.suffixes.length; i++) if (!item.suffixes[i].fractured) idx.push(["suffix", i]);
  if (!idx.length) return false;
  const [sd, i] = idx[Math.floor(rnd() * idx.length)];
  (sd === "prefix" ? item.prefixes : item.suffixes).splice(i, 1);
  return true;
}
function removeOneDesecrated(item, rnd) {
  const idx = [];
  for (let i = 0; i < item.prefixes.length; i++) if (item.prefixes[i].desecrated) idx.push(["prefix", i]);
  for (let i = 0; i < item.suffixes.length; i++) if (item.suffixes[i].desecrated) idx.push(["suffix", i]);
  if (!idx.length) return false;
  const [sd, i] = idx[Math.floor(rnd() * idx.length)];
  (sd === "prefix" ? item.prefixes : item.suffixes).splice(i, 1);
  return true;
}

// Hinekora's Lock wrapper: foresee the next currency's result and decline it if it doesn't help.
// MODEL (explicit, because the KB's rule is never to invent mechanics): one Lock is consumed per
// LOOK; you only spend the orb on a look you accept. So a slam that helps with probability q costs
// (1/q) Locks + 1 orb instead of (1/q) orbs and a ruined item. This is why the Lock transforms an
// expensive one-shot slam and is worthless on a cheap one — and why the engine must never forget it.
// Flagged estimate:true, like desecration, since the accept/decline semantics are community-read.
const LOCK_LOOKS = 8;   // give up after 8 declines and take what comes (bounds the cost)
function applyWithLock(move, item, ctx, rnd, cost, helps) {
  for (let look = 0; look < LOCK_LOOKS; look++) {
    const probe = clone(item);
    const probeCost = {};
    if (!apply(move, probe, ctx, rnd, probeCost)) return false;
    cost["Hinekora's Lock"] = (cost["Hinekora's Lock"] || 0) + 1;
    if (helps(probe) || look === LOCK_LOOKS - 1) {                     // accept: commit the previewed outcome
      item.rarity = probe.rarity; item.prefixes = probe.prefixes; item.suffixes = probe.suffixes;
      item.quality = probe.quality; item.corrupted = probe.corrupted;
      for (const k in probeCost) cost[k] = (cost[k] || 0) + probeCost[k];
      return true;
    }
  }
  return false;
}

// ── route enumeration ────────────────────────────────────────────────────────
// A route = a start move, an optional guarantee (essence/desecration), a FILL family and an
// optional FIX family. The families are policies, not paths: at each step the executor asks the
// family which concrete catalog move to use given the item's current state (which side is
// missing a target, whether the other side is open, ...). That is what makes this composition
// rather than 13 hard-coded scripts.
//
// "Steered" families pick sinistral/dextral by NEED. The omen is only charged when it actually
// steers: if the other side is already full, a plain orb is FORCED onto the side you want and the
// omen would be wasted. (This subtlety was in the old hand-written code and is worth keeping.)
const FILL_FAMILIES = [
  { id: "exalt", label: "Exalts", moves: ["exalt"] },
  { id: "exalt-greater", label: "Greater Exalts (high tiers)", moves: ["exalt-greater"], minLevel: 35 },
  { id: "exalt-perfect", label: "Perfect Exalts (top tiers)", moves: ["exalt-perfect"], minLevel: 50 },
  { id: "exalt-steered", label: "directed Exalts (Exaltation omens)", steered: { prefix: "exalt-sinistral", suffix: "exalt-dextral" }, plain: "exalt" },
  { id: "exalt-steered-greater", label: "directed Greater Exalts (high tiers)", steered: { prefix: "exalt-sinistral", suffix: "exalt-dextral" }, plain: "exalt-greater", minLevel: 35, tierMove: "exalt-greater" },
  { id: "exalt-homogenising", label: "Homogenising Exalts (same-type mods)", moves: ["exalt-homogenising"], needsCluster: true },
  { id: "exalt-greater-omen", label: "Omen of Greater Exaltation (2 mods per Exalt)", moves: ["exalt-greater-omen"] },
  { id: "exalt-catalysing", label: "Catalyst-directed Exalts (bias a mod type)", moves: ["exalt-catalysing"], needsJewellery: true },
];
const FIX_FAMILIES = [
  { id: "none", label: null, moves: [] },
  { id: "chaos", label: "Chaos spam", moves: ["chaos"] },
  { id: "chaos-greater", label: "Greater Chaos spam (high tiers)", moves: ["chaos-greater"], minLevel: 35 },
  { id: "chaos-perfect", label: "Perfect Chaos spam (top tiers)", moves: ["chaos-perfect"], minLevel: 50 },
  { id: "chaos-whittling", label: "Chaos + Omen of Whittling (eat the lowest tier)", moves: ["chaos-whittling"] },
  { id: "chaos-erasure", label: "Chaos + Erasure omens (protect a side)", steered: { prefix: "chaos-sinistral-erasure", suffix: "chaos-dextral-erasure" } },
  { id: "annul", label: "Annul + re-fill (undirected — can eat a good mod)", moves: ["annul"] },
  { id: "annul-steered", label: "Annul + Exalt (Annulment omens unjam a side)", steered: { prefix: "annul-sinistral", suffix: "annul-dextral" } },
  { id: "annul-greater", label: "Omen of Greater Annulment (strip two at once)", moves: ["annul-greater"] },
  { id: "fracture", label: "Fracturing Orb (lock a hit) → Chaos the rest", moves: ["chaos"], fractureFirst: true },
];
// The Magic stage has its own fill: an item transmuted to Magic has a second affix slot, and
// filling it BEFORE the Regal is the classic opener (Transmute → Augment → Regal), because the
// Regal then lands on a two-mod item. Leaving this out would have quietly deleted the single
// most common opening in the game — which is exactly the class of bug this rewrite exists to kill.
const AUGMENT_MOVES = [
  { id: "none", label: null },
  { id: "augment", label: "Augment", move: "augment" },
  { id: "augment-greater", label: "Greater Augment (high tiers)", move: "augment-greater", minLevel: 44 },
  { id: "augment-perfect", label: "Perfect Augment (top tiers)", move: "augment-perfect", minLevel: 70 },
];

// The targets a move actually has to ROLL. On a pasted item the kept mods are targets too (losing
// one is a failure), but they are already on the item — nothing has to roll them. Letting them into
// the tier floor below was silently deleting every Greater/Perfect variant from a seeded plan: one
// low-ilvl mod you happen to be keeping (a 15% Rarity ring mod) dragged the floor under 35 and the
// Greater Regal / Greater Augment / Greater Exalt / Greater Chaos families all vanished.
const rollT = (ctx) => {
  const need = ctx.T.filter((t) => !t.kept);
  return need.length ? need : ctx.T;
};
const tierFloor = (ctx) => {
  const T = rollT(ctx);
  return T.length ? Math.min(...T.map((t) => targetMinLevel(ctx.mods, t))) : 0;
};

// Which start moves make sense for this craft. Magic-route starts (transmute) pair with a
// guarantee/fill; rare-route starts (alchemy) come out with 4 random mods and need a fix.
function startMoves(ctx) {
  const out = [];
  const floor = tierFloor(ctx);
  out.push("transmute");
  if (floor >= 44) out.push("transmute-greater");
  if (floor >= 70) out.push("transmute-perfect");
  out.push("alchemy");
  // A max-side Alchemy only helps when that side actually carries more than one target.
  const pfx = ctx.T.filter((t) => t.type === "prefix").length, sfx = ctx.T.filter((t) => t.type === "suffix").length;
  if (pfx >= 2) out.push("alchemy-sinistral");
  if (sfx >= 2) out.push("alchemy-dextral");
  return out;
}
// Magic → Rare promotions (used after a transmute start, before/instead of an essence).
function promoteMoves(ctx) {
  const out = ["regal"];
  const floor = tierFloor(ctx);
  if (floor >= 35) out.push("regal-greater");
  if (floor >= 50) out.push("regal-perfect");
  const pfx = ctx.T.some((t) => t.type === "prefix"), sfx = ctx.T.some((t) => t.type === "suffix");
  if (pfx) out.push("regal-sinistral");
  if (sfx) out.push("regal-dextral");
  if (ctx.clustered) out.push("regal-homogenising");
  return out;
}

// opts.seeded — we are advising on an item that ALREADY EXISTS, so there is no white base to
// start from. Enumerating start/augment/promote moves for it would be worse than wasteful: those
// moves are illegal on the item (legal() rejects them), so they silently no-op at runtime while
// still appearing in the route's label and steps — the plan would TELL you to Regal an item that
// is already Rare. It also floods the route space with hundreds of behaviourally-identical
// routes, which crowds the genuinely cheap ones out of the refine shortlist and blows the costs
// up. A seeded item's route space is: guarantee? → fill → fix? (→ lock?).
function enumerateRoutes(ctx, opts) {
  opts = opts || {};
  const routes = [];
  const desec = ctx.T.filter((t) => t.desecrated);

  if (opts.seeded) {
    const magic = opts.startRarity === "magic";
    // A pasted MAGIC item still needs promoting to Rare; a pasted Rare does not.
    const promotions = magic
      ? [...promoteMoves(ctx).map((p) => ({ promote: p })), ...(ctx.magicEss ? [{ essence: "essence-magic" }] : [])]
      : [{}, ...(ctx.rareEss ? [{ essence: "essence-rare" }, { essence: "essence-rare-sinistral" }, { essence: "essence-rare-dextral" }] : [])];
    // A pasted Magic item with only ONE mod still has its second Magic slot open, and filling it
    // with an Augment before the Regal is far cheaper than paying an Exalt for that slot later.
    // Omitting this was the seeded path's version of the same bug the scratch path guards against:
    // it told you to Regal a one-mod Magic ring and then buy the slot back with Exalts.
    // Gated on a slot actually being open: legal() would no-op the Augment on a two-mod Magic item
    // anyway, but the move would still be printed in the route's label — a plan that tells you to
    // Augment an item that cannot be Augmented (the same lie the `seeded` guard above exists for).
    const augments = magic && opts.magicSlotOpen
      ? AUGMENT_MOVES.filter((a) => !a.minLevel || fillOk(a, ctx))
      : [AUGMENT_MOVES[0]];
    for (const promo of promotions) {
      for (const aug of augments) {
        for (const fill of FILL_FAMILIES) {
          if (!fillOk(fill, ctx)) continue;
          for (const fix of FIX_FAMILIES) {
            if (!fixOk(fix, ctx)) continue;
            const r = { ...promo, augment: aug.move || null, fill: fill.id, fix: fix.id };
            routes.push({ ...r, lock: false });
            routes.push({ ...r, lock: true });
          }
        }
      }
    }
    return routes;
  }

  // Desecrated targets can ONLY come from the Well of Souls — no orb can add them. So when one
  // is present the route space collapses to the desecration moves, and everything else is a lie.
  if (desec.length) {
    for (const g of ["desecrate", "desecrate-sinistral", "desecrate-dextral", "desecrate-echoes"]) {
      const mv = MOVES[g];
      if (mv.requires.open_prefix && !desec.some((t) => t.type === "prefix")) continue;
      if (mv.requires.open_suffix && !desec.some((t) => t.type === "suffix")) continue;
      for (const fill of FILL_FAMILIES) {
        if (!fillOk(fill, ctx)) continue;
        routes.push({ start: "alchemy", desecrate: g, fill: fill.id, fix: "none", lock: false, estimate: true });
      }
    }
    return routes;
  }

  const magicEss = pickEssence(ctx.mods, ctx.T, ctx.essences, false);
  const rareEss = pickEssence(ctx.mods, ctx.T, ctx.essences, true);

  for (const start of startMoves(ctx)) {
    const isMagicStart = MOVES[start].effect.to_rarity === "magic";
    // What gets the item to Rare: a Regal variant, or an essence (which promotes AND guarantees).
    const promotions = isMagicStart
      ? [...promoteMoves(ctx).map((p) => ({ promote: p })), ...(magicEss ? [{ essence: "essence-magic" }] : [])]
      : [{}, ...(rareEss ? [{ essence: "essence-rare" }, { essence: "essence-rare-sinistral" }, { essence: "essence-rare-dextral" }] : [])];

    // On a Magic start you may fill the second Magic slot before promoting (Transmute → Augment
    // → Regal). On a Rare start there is no Magic stage, so there is nothing to augment.
    const augments = isMagicStart ? AUGMENT_MOVES.filter((a) => !a.minLevel || fillOk(a, ctx)) : [AUGMENT_MOVES[0]];
    for (const promo of promotions) {
      for (const aug of augments) {
        // An essence promotes the item itself, and it cannot add a group already present — so
        // augmenting first can only get in its way when the augment lands on the essence's group.
        // Still a legal (and sometimes correct) route, so it is enumerated, not assumed away.
        for (const fill of FILL_FAMILIES) {
          if (!fillOk(fill, ctx)) continue;
          for (const fix of FIX_FAMILIES) {
            if (!fixOk(fix, ctx)) continue;
            // A rare start with 4 random mods and no way to remove them is just "hope" — skip the
            // dead combo rather than reporting a 0% route.
            if (!isMagicStart && !promo.essence && fix.id === "none" && ctx.T.length > 1) continue;
            routes.push({ start, ...promo, augment: aug.id === "none" ? null : aug.move, fill: fill.id, fix: fix.id, lock: false });
          }
        }
      }
    }
  }
  // Hinekora's Lock variants: only on the cheapest-looking half of the space would be arbitrary,
  // so offer it on every route and let cost sort it out — a Lock is expensive, so it only wins
  // where it should (few, costly slams), and it can never be "forgotten" again.
  for (const r of routes.slice()) if (MOVES[r.fill] !== undefined || true) routes.push({ ...r, lock: true });
  return routes;
}
function fillOk(f, ctx) {
  if (f.needsJewellery && !ctx.jewellery) return false;
  if (f.needsCluster && !ctx.clustered) return false;
  // A min-level fill that floors ABOVE a target's cheapest acceptable tier can never roll it.
  // Only the targets still to be ROLLED count — a kept mod is already there (see rollT).
  if (f.minLevel) for (const t of rollT(ctx)) if (targetMinLevel(ctx.mods, t) < f.minLevel) return false;
  return true;
}
function fixOk(f, ctx) {
  if (f.minLevel) for (const t of rollT(ctx)) if (targetMinLevel(ctx.mods, t) < f.minLevel) return false;
  return true;
}

// ── route execution ──────────────────────────────────────────────────────────
// Run one route once. This is the generic executor every route shares — there is no per-route
// code anywhere in this file, which is the point.
function runRoute(route, ctx, rnd, seed, churnCap) {
  const cost = {};
  const T = ctx.T;
  const item = seed ? clone(seed) : { rarity: "normal", quality: ctx.quality || 0, corrupted: false, prefixes: [], suffixes: [] };
  const fill = FILL_FAMILIES.find((f) => f.id === route.fill);
  const fix = FIX_FAMILIES.find((f) => f.id === route.fix);
  // "helps" = the move moved us toward an unmet target. Used by the Lock to decide accept/decline.
  const metCount = (it) => T.filter((t) => targetMet(it, t)).length;

  // A step that cannot legally happen is NOT a failed route — the run simply carries on and the
  // final allMet() decides. This matters: if the Transmute happens to roll the very group the
  // essence would have guaranteed, the essence becomes illegal (one mod per group) and the item
  // is ALREADY a success. Treating "the move didn't apply" as "the craft failed" understated
  // every essence route's odds (it read p=0.70 on a craft that is p=1 by construction).
  const step = (id, wantProgress) => {
    if (!id) return;
    const mv = MOVES[id];
    if (!legal(mv, item, ctx)) return;
    const before = metCount(item);
    if (route.lock && wantProgress) applyWithLock(mv, item, ctx, rnd, cost, (probe) => metCount(probe) > before);
    else apply(mv, item, ctx, rnd, cost);
  };

  if (!seed) step(route.start, false);
  if (item.rarity === "magic") step(route.augment, true);
  if (route.essence) ctx.essence = MOVES[route.essence].requires.rarity === "rare" ? ctx.rareEss : ctx.magicEss;
  if (item.rarity === "magic") step(route.promote, true);
  if (route.essence && ctx.essence) step(route.essence, false);
  if (route.desecrate) {
    for (const t of T.filter((x) => x.desecrated)) {
      ctx.desecTarget = t;
      for (let n = 0; n < 40 && !targetMet(item, t); n++) {
        if (!legal(MOVES[route.desecrate], item, ctx)) break;
        if (!apply(MOVES[route.desecrate], item, ctx, rnd, cost)) break;
        if (targetMet(item, t)) break;
        if (!apply(MOVES["annul-light"], item, ctx, rnd, cost)) break;   // scrub the miss, try again
      }
    }
  }

  // Main loop: fill toward unmet targets; when the needed side is jammed, fix.
  const cap = churnCap || CHURN_CAP;
  let churn = 0;
  while (!allMet(item, T) && churn < cap) {
    const side = unmetSide(item, T);
    if (!side) break;
    const canFill = openOn(item, side) > 0;
    if (canFill) {
      const mv = pickFill(fill, item, ctx, side);
      if (!mv) break;
      const before = metCount(item);
      const ok = route.lock
        ? applyWithLock(mv, item, ctx, rnd, cost, (probe) => metCount(probe) > before)
        : apply(mv, item, ctx, rnd, cost);
      if (!ok) break;
    } else {
      if (!fix || !fix.id || fix.id === "none") break;                  // side jammed and no way to unjam → dead
      if (fix.fractureFirst && !item.prefixes.concat(item.suffixes).some((m) => m.fractured)) {
        if (metCount(item) > 0 && legal(MOVES["fracture"], item, ctx)) apply(MOVES["fracture"], item, ctx, rnd, cost);
      }
      const mv = pickFix(fix, item, ctx, side);
      if (!mv) break;
      if (!apply(mv, item, ctx, rnd, cost)) break;
      churn++;
    }
    // A fix family that churns a full item (chaos spam) also counts toward the cap.
    if (!canFill) continue;
    if (openAffixes(item) === 0 && !allMet(item, T)) {
      if (!fix || fix.id === "none") break;
      churn++;
    }
  }
  return { item, cost, ok: allMet(item, T) };
}
// Which concrete catalog move this fill family uses right now.
function pickFill(f, item, ctx, side) {
  if (f.steered) {
    const otherFull = openOn(item, side === "prefix" ? "suffix" : "prefix") === 0;
    // Other side full → a plain orb is FORCED onto the side we want. Don't buy an omen.
    const id = otherFull ? (f.tierMove || f.plain) : f.steered[side];
    return legal(MOVES[id], item, ctx) ? MOVES[id] : null;
  }
  for (const id of f.moves) if (legal(MOVES[id], item, ctx)) return MOVES[id];
  return null;
}
function pickFix(f, item, ctx, side) {
  if (f.steered) {
    const id = f.steered[side];
    return MOVES[id] && legal(MOVES[id], item, ctx) ? MOVES[id] : null;
  }
  for (const id of f.moves) if (legal(MOVES[id], item, ctx)) return MOVES[id];
  return null;
}

// Human label for a route — built from the moves it actually uses, so it can never describe a
// route the planner didn't run.
function labelRoute(route, ctx) {
  const bits = [];
  if (route.start) bits.push(MOVES[route.start].name.replace(/^Orb of /, ""));   // absent when advising an existing item
  if (route.augment) bits.push(MOVES[route.augment].name.replace(/^Orb of /, "").replace(/ Orb of /, " "));
  if (route.promote) bits.push(MOVES[route.promote].name.replace(/^Regal Orb \+ /, ""));
  if (route.essence) bits.push(ctx[MOVES[route.essence].requires.rarity === "rare" ? "rareEss" : "magicEss"].name);
  if (route.desecrate) bits.push(MOVES[route.desecrate].name);
  const fill = FILL_FAMILIES.find((f) => f.id === route.fill);
  const fix = FIX_FAMILIES.find((f) => f.id === route.fix);
  if (fill) bits.push(fill.label);
  if (fix && fix.label) bits.push(fix.label);
  if (route.lock) bits.push("with Hinekora's Lock");
  return bits.join(" → ");
}

// Ordered, human step list DERIVED from the route's actual moves. It used to be a hand-written
// narrator in server.js that told the same story (Regal → omen-steered Exalts) whatever the route
// really was — which is why it needed a regex to stop the label contradicting its own steps. Steps
// built from the move list cannot describe a route the planner did not run.
function describeRoute(route, ctx, expectedOrbs, p) {
  const steps = [];
  const targets = ctx.T.map((t) => t.group).join(" + ");
  if (route.start && !route.seeded) steps.push(`${MOVES[route.start].name} → ${MOVES[route.start].effect.to_rarity === "magic" ? "Magic" : "Rare"}${MOVES[route.start].effect.adds > 1 ? ` (${MOVES[route.start].effect.adds} random mods)` : ""}.`);
  if (route.augment) steps.push(`${MOVES[route.augment].name} → fill the second Magic slot before promoting.`);
  if (route.promote) steps.push(`${MOVES[route.promote].name} → Rare.`);
  if (route.essence) {
    const e = ctx[MOVES[route.essence].requires.rarity === "rare" ? "rareEss" : "magicEss"];
    steps.push(`${e.name} → GUARANTEES ${e.stat || e.group}${MOVES[route.essence].effect.removes ? " (removes a random mod first — it can eat a mod you wanted)" : ""}.`);
  }
  if (route.desecrate) steps.push(`${MOVES[route.desecrate].name} → reveal 3, keep 1; scrub a miss with Orb of Annulment + Omen of Light and go again.`);

  const fill = FILL_FAMILIES.find((f) => f.id === route.fill);
  if (fill) {
    if (fill.steered) {
      steps.push(`${fill.label} → aim each Exalt at the side still missing ${targets}. When the OTHER side is already full, a plain Exalt is forced onto the side you want — skip the omen, it is wasted.`);
    } else {
      steps.push(`${fill.label} → add mods until ${targets} land.`);
    }
  }
  const fix = FIX_FAMILIES.find((f) => f.id === route.fix);
  if (fix && fix.label) steps.push(`If the side you need jams with junk: ${fix.label}.`);
  if (route.lock) steps.push("Hinekora's Lock before each slam → foresee the result and decline it if it misses. Only worth it when the slam is expensive or the item is.");

  const pct = Math.round(p * 100);
  const cost = Object.entries(expectedOrbs).filter(([, n]) => n > 0)
    .map(([k, n]) => `${Math.round(n * 10) / 10} × ${k}`).join(" + ");
  steps.push(`≈ ${cost} expected to land one${pct < 100 ? ` · ~${pct}% per attempt (redo on a fresh base if it misses)` : ""}.`);
  return steps;
}

function simulateRoute(route, ctx, trials, rnd, seed, churnCap) {
  let hits = 0;
  const costSum = {};
  for (let i = 0; i < trials; i++) {
    const { cost, ok } = runRoute(route, ctx, rnd, seed, churnCap);
    if (ok) hits++;
    for (const k in cost) costSum[k] = (costSum[k] || 0) + cost[k];
  }
  const p = hits / trials;
  const perAttemptOrbs = {}, expectedOrbs = {};
  for (const k in costSum) perAttemptOrbs[k] = costSum[k] / trials;
  // Expected TOTAL spend to land one: per-attempt average ÷ p (you retry on a fresh base when an
  // attempt fails, and the currency burned on the failures is real money).
  if (p > 0) for (const k in costSum) expectedOrbs[k] = costSum[k] / trials / p;
  return {
    key: routeKey(route), label: labelRoute(route, ctx),
    essenceName: route.essence ? ctx[MOVES[route.essence].requires.rarity === "rare" ? "rareEss" : "magicEss"].name : undefined,
    successPerAttempt: p, perAttemptOrbs, expectedOrbs, feasible: p > 0,
    estimate: !!route.desecrate || !!route.lock,
    moves: routeMoveIds(route),
    steps: describeRoute({ ...route, seeded: !!seed }, ctx, expectedOrbs, p),
  };
}
const routeKey = (r) => [r.start, r.augment, r.promote, r.essence, r.desecrate, r.fill, r.fix, r.lock ? "lock" : ""].filter(Boolean).join("+");
function routeMoveIds(r) {
  const f = FILL_FAMILIES.find((x) => x.id === r.fill), x = FIX_FAMILIES.find((y) => y.id === r.fix);
  return [r.start, r.augment, r.promote, r.essence, r.desecrate, ...(f ? f.moves || Object.values(f.steered || {}) : []),
    ...(x ? x.moves || Object.values(x.steered || {}) : []), r.lock ? "hinekora" : null].filter(Boolean);
}

// ── entry points ─────────────────────────────────────────────────────────────
function buildCtx(mods, targets, opts) {
  const T = prepTargets(targets, mods);
  const tagSets = T.map((t) => targetTags(mods, t));
  let clustered = false;
  for (let a = 0; a < tagSets.length && !clustered; a++)
    for (let b = a + 1; b < tagSets.length && !clustered; b++)
      for (const tg of tagSets[a]) if (tagSets[b].has(tg)) { clustered = true; break; }
  // The catalyst biases the RAREST target's tag — the biggest payoff.
  let catalysedTags = null, lo = Infinity;
  for (let i = 0; i < T.length; i++) {
    const w = groupWeight(mods, T[i]);
    if (tagSets[i].size && w < lo) { lo = w; catalysedTags = tagSets[i]; }
  }
  const ctx = {
    mods, T, essences: opts.essences || [], jewellery: !!opts.jewellery,
    clustered, catalysedTags, quality: opts.quality || 0,
  };
  ctx.magicEss = pickEssence(mods, T, ctx.essences, false);
  ctx.rareEss = pickEssence(mods, T, ctx.essences, true);
  return ctx;
}
// Rank routes. priceOf(currencyName) -> divine value, or null if the market does not price it.
//
// RANK ON MONEY, NOT ORB COUNT. This used to sort by raw orb count and let the server price the
// survivors afterwards — which was survivable when there were 13 hand-written methods (all of them
// priced) and is catastrophic now that hundreds of routes are enumerated: a route spending 3
// exotic omens "beats" one spending 30 cheap Exalts, so the cheap route never even reaches the
// pricer. Worse, an UNPRICED currency counted as just another orb, so a route leaning on an omen
// nobody sells looked like the cheapest route on the board — it ranked first *because* nothing bid
// its price up. (Observed live: every top-5 route for a Sapphire Ring used Omen of Homogenising
// Exaltation, which the market does not price at all, and the quoted cost silently excluded it.)
//
// So: a route whose currency we cannot price has an UNKNOWN cost, not a zero one, and unknown
// sinks below every route we can actually cost. If you cannot buy it, we do not recommend it.
function rank(methods, priceOf) {
  const totalOrbs = (r) => Object.values(r.expectedOrbs).reduce((s, n) => s + n, 0);
  methods.forEach((r) => {
    r.totalOrbs = r.feasible ? totalOrbs(r) : Infinity;
    // <2% per attempt = you reroll the whole item 50+ times; the "expected cost" is an
    // extrapolation nobody actually runs. Flag it and sink it below real plans.
    r.impractical = r.feasible && r.successPerAttempt < PRACTICAL_MIN;
    r.priceMissing = undefined;
    r.divineCost = null;
    if (!priceOf || !r.feasible) return;
    let cost = 0;
    const missing = [];
    for (const [orb, n] of Object.entries(r.expectedOrbs)) {
      const p = priceOf(orb);
      if (p > 0) cost += n * p; else missing.push(orb);
    }
    if (missing.length) r.priceMissing = missing;      // cost is a FLOOR — do not treat it as the price
    else r.divineCost = Math.round(cost * 10000) / 10000;
  });
  const key = (r) => (r.divineCost != null ? r.divineCost : Infinity);
  methods.sort((a, b) =>
    (a.impractical ? 1 : 0) - (b.impractical ? 1 : 0)      // brick-prone routes last
    || (a.divineCost == null ? 1 : 0) - (b.divineCost == null ? 1 : 0)   // unbuyable/unpriced below buyable
    || key(a) - key(b)                                     // then cheapest real money
    || a.totalOrbs - b.totalOrbs);                         // no prices at all → fall back to orb count
  return methods;
}
// Reachability: a target that isn't in the pool at this item level is not a hard route, it is
// an impossible one — say so instead of returning a 0% plan.
function reachability(mods, T) {
  const byGroup = {}; for (const m of mods) if (!byGroup[m.group]) byGroup[m.group] = m;
  const keys = new Set(mods.map((m) => m.key));
  const missing = [];
  for (const t of T) {
    if (t.desecrated) continue;                                        // desecrated mods live outside the pool
    if (!byGroup[t.group]) { missing.push(t.group); continue; }
    if (t.keys && ![...t.keys].some((k) => keys.has(k))) missing.push(t.group + " (selected tier needs a higher item level)");
  }
  const pfx = T.filter((t) => t.type === "prefix").length;
  const sfx = T.filter((t) => t.type === "suffix").length;
  // At most ONE desecrated modifier can ever sit on a finished item. You may retry a bad reveal as
  // often as you like (Orb of Annulment + Omen of Light scrubs the miss, restoring eligibility),
  // but you cannot KEEP one and then bone again — "Items with Desecrated Modifiers cannot be
  // Desecrated again". So two desecrated targets is not a hard craft, it is an impossible one, and
  // saying so beats simulating a route that always fails.
  const desec = T.filter((t) => t.desecrated).length;
  if (desec > 1) missing.push(`${desec} desecrated modifiers — an item can only ever keep ONE (a bone is illegal while a Desecrated mod is on the item, and Omen of Light removes it rather than adding a second)`);
  return { missing, pfx, sfx, overCap: pfx > CAP.rare.prefix || sfx > CAP.rare.suffix };
}

// Narrow hundreds of enumerated routes down to the handful worth measuring properly, then measure
// THOSE properly. Enumerating from the catalog means the route space is ~50× what the old
// hand-written engine had, so a single full-depth pass over all of it would take ten seconds; a
// single cheap pass would report noisy odds to the user. Hence a funnel:
//
//   PRESCREEN (coarse, only when the space is big) → SCREEN (cheap) → REFINE (accurate, reported)
//
// Only the REFINE numbers are ever shown. The earlier passes exist purely to ORDER routes, and
// they order them consistently (same shallow cap for everyone), so the shortlist survives.
// The prescreen bails out if it would leave too few candidates — on a genuinely hard craft every
// route has low odds, and a coarse pass could otherwise throw the real answer away as "infeasible".
const PRESCREEN_AT = 200;        // route counts above this get the coarse pass first
const PRESCREEN_TRIALS = 30;
const PRESCREEN_CHURN_CAP = 20;
const PRESCREEN_KEEP = 120;
const PRESCREEN_MIN_FEASIBLE = 40;   // fewer survivors than this → distrust the coarse pass, skip it

function shortlist(routes, ctx, opts, seedItem) {
  const seed = (opts.seed >>> 0) || 12345;
  const priceOf = typeof opts.priceOf === "function" ? opts.priceOf : null;
  const sim = (r, trials, cap) => simulateRoute(r, ctx, trials, E.rng(seed), seedItem, cap);
  const routesOf = (scored, keep) =>
    rank(scored.filter((s) => s.m.feasible).map((s) => s.m), priceOf)
      .slice(0, keep)
      .map((m) => scored.find((s) => s.m.key === m.key).r);

  let pool = routes;
  if (pool.length > PRESCREEN_AT) {
    const pre = pool.map((r) => ({ r, m: sim(r, PRESCREEN_TRIALS, PRESCREEN_CHURN_CAP) }));
    const kept = routesOf(pre, PRESCREEN_KEEP);
    if (kept.length >= PRESCREEN_MIN_FEASIBLE) pool = kept;   // else: hard craft — keep the full space
  }
  const screened = pool.map((r) => ({ r, m: sim(r, SCREEN_TRIALS, SCREEN_CHURN_CAP) }));
  const survivors = routesOf(screened, REFINE_KEEP);

  const rnd = E.rng(seed);
  return rank(survivors.map((r) => simulateRoute(r, ctx, opts.trials || REFINE_TRIALS, rnd, seedItem)), priceOf);
}

// Plan a craft from a WHITE BASE. Drop-in replacement for the old rankMethods (same return shape),
// but the routes are enumerated from the catalog instead of hand-written.
function planRoutes(mods, targets, opts) {
  opts = opts || {};
  const ctx = buildCtx(mods, targets, opts);
  const { missing, pfx, sfx, overCap } = reachability(mods, ctx.T);
  if (missing.length || overCap) return { impossible: true, missing, overCap, prefixTargets: pfx, suffixTargets: sfx, methods: [] };

  const routes = enumerateRoutes(ctx);
  const methods = shortlist(routes, ctx, opts, null);
  return {
    impossible: !methods.length, prefixTargets: pfx, suffixTargets: sfx,
    trials: opts.trials || REFINE_TRIALS, routesConsidered: routes.length, methods,
  };
}

// Advise on an item ALREADY IN PROGRESS (the "I pasted my item, what now" flow). currentMods =
// what is on it; fillTargets = what it still needs. Returns the same ranked-routes shape plus a
// verdict — and the verdict is allowed to be BRICKED, which is the honest answer more often than
// this kind of tool likes to admit.
function adviseItem(mods, currentMods, fillTargets, opts) {
  opts = opts || {};
  const ctx = buildCtx(mods, fillTargets, opts);
  const startRarity = opts.startRarity === "magic" ? "magic" : "rare";
  const seed = {
    rarity: startRarity, quality: opts.quality || 0, corrupted: !!opts.corrupted,
    prefixes: (currentMods || []).filter((m) => m.type === "prefix").map((m) => ({ ...m })),
    suffixes: (currentMods || []).filter((m) => m.type === "suffix").map((m) => ({ ...m })),
  };
  const { missing, pfx, sfx } = reachability(mods, ctx.T);

  // The kept mods occupy slots — the fills have to fit in what's LEFT, not in an empty item.
  const freeP = CAP.rare.prefix - seed.prefixes.length;
  const freeS = CAP.rare.suffix - seed.suffixes.length;
  const needP = ctx.T.filter((t) => t.type === "prefix").length;
  const needS = ctx.T.filter((t) => t.type === "suffix").length;

  if (seed.corrupted) return { verdict: "BRICKED", reason: "The item is corrupted — no currency can modify it again.", methods: [] };
  if (missing.length) return { verdict: "IMPOSSIBLE", reason: `Not in this base's pool at this item level: ${missing.join(", ")}.`, missing, methods: [] };

  // Routes that keep the item: fill the open slots, or unjam a side and re-fill. Losing a KEPT
  // mod is a failure, so the kept groups are targets too — that is what makes an Annul route's
  // risk show up in its odds instead of hiding in a footnote.
  const keptTargets = (currentMods || []).map((m) => ({ group: m.group, type: m.type, keys: m.key ? [m.key] : null, kept: true }));
  const ctxAll = buildCtx(mods, [...keptTargets, ...fillTargets], opts);
  const magicSlotOpen = startRarity === "magic" && seed.prefixes.length + seed.suffixes.length < CAP.magic.prefix + CAP.magic.suffix;
  const routes = enumerateRoutes(ctxAll, { seeded: true, startRarity, magicSlotOpen })
    .filter((r) => r.fix !== "none" || (needP <= freeP && needS <= freeS));

  const methods = shortlist(routes, ctxAll, opts, seed);

  const best = methods[0];
  if (!best || !best.feasible) {
    return {
      verdict: "BRICKED",
      reason: needP > freeP || needS > freeS
        ? `No slots left: ${needP} prefix / ${needS} suffix still wanted, but only ${freeP} / ${freeS} free — and no removal route recovers it without destroying what you kept.`
        : "No sequence of moves reaches the target from this state. Drop it and start on a fresh base.",
      prefixTargets: needP, suffixTargets: needS, methods: [],
    };
  }
  return {
    verdict: best.impractical ? "LONGSHOT" : "CONTINUE",
    prefixTargets: needP, suffixTargets: needS, freePrefixes: freeP, freeSuffixes: freeS,
    trials: opts.trials || REFINE_TRIALS, routesConsidered: routes.length, methods,
  };
}

// Every move id the planner can actually put into a route. This is the other half of the
// anti-forgetting contract: plan-coverage-test.js asserts that every searchable move in the
// catalog is in here or in UNSUPPORTED, so a mechanic added to the KB cannot sit unnoticed.
// Derived from the families and the phase handlers — never hand-listed, or it would drift.
const EXECUTABLE = new Set([
  // starts + promotions (startMoves / promoteMoves)
  "transmute", "transmute-greater", "transmute-perfect", "alchemy", "alchemy-sinistral", "alchemy-dextral",
  "regal", "regal-greater", "regal-perfect", "regal-sinistral", "regal-dextral", "regal-homogenising",
  // guarantees (runRoute: essence + desecrate branches)
  "essence-magic", "essence-rare", "essence-rare-sinistral", "essence-rare-dextral",
  "desecrate", "desecrate-sinistral", "desecrate-dextral", "desecrate-echoes", "annul-light",
  // locks
  "fracture", "hinekora",
]);
for (const f of FILL_FAMILIES) {
  for (const id of f.moves || []) EXECUTABLE.add(id);
  for (const id of Object.values(f.steered || {})) EXECUTABLE.add(id);
  if (f.plain) EXECUTABLE.add(f.plain);
  if (f.tierMove) EXECUTABLE.add(f.tierMove);
}
for (const f of FIX_FAMILIES) {
  for (const id of f.moves || []) EXECUTABLE.add(id);
  for (const id of Object.values(f.steered || {})) EXECUTABLE.add(id);
}
for (const a of AUGMENT_MOVES) if (a.move) EXECUTABLE.add(a.move);

module.exports = {
  planRoutes, adviseItem, MOVES, UNSUPPORTED, EXECUTABLE, FILL_FAMILIES, FIX_FAMILIES,
  enumerateRoutes, simulateRoute, buildCtx, runRoute, legal, apply, PRACTICAL_MIN,
};

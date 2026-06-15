// Offline determinism test for the fetchExchangeChunked page-starvation backfill.
// Requires the REAL functions from server.js (no port bound, no Trade2 calls —
// server.listen is guarded behind require.main) and stubs the network via
// __setExchangeRawImpl, so this exercises the actual shipping code, not a copy.
//
// Simulated failure: a high-liquidity "whale" currency in a 3-wide chunk fills
// the single capped response page, so its chunk-mates come back with zero offers
// (real page starvation). The backfill must re-fetch each starved item alone and
// recover it, without re-fetching the already-covered whale or wasting calls when
// nothing is starved.
const { fetchExchangeChunked, collectExchangeOffers, bestExchangeOffer, sanitizeLeague, buildExchangeCatalog, analyzeGearSearch, buildGearSearchQuery, gearSearchSlots, __setExchangeRawImpl } = require("./server.js");

const EXALTED_ID = "exalted";
const WHALE = "divine";
let rawCalls = [];
let gid = 0; // globally-unique listing ids (real exchange ids never collide across pages)

__setExchangeRawImpl(async (league, haveIds, wantIds) => {
  const have = Array.isArray(haveIds) ? haveIds : [haveIds];
  const want = Array.isArray(wantIds) ? wantIds : [wantIds];
  rawCalls.push({ have: [...have], want: [...want] });
  const result = {};
  const multi = have.length >= want.length ? have : want;
  const whaleCrowds = multi.length > 1 && multi.includes(WHALE);
  for (const h of have) for (const w of want) {
    if (h === w) continue;
    const item = multi === have ? h : w;
    if (whaleCrowds && item !== WHALE) continue; // starved by the whale's page
    result["L" + (gid++)] = { exchange: { currency: h, amount: 1 }, item: { currency: w, amount: 2 } };
  }
  return { result };
});

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

  // want = [divine(whale), regal, vaal, chaos, alch] vs have=[exalted].
  // First chunk [divine,regal,vaal] starves regal+vaal; backfill must recover them.
  const want = ["divine", "regal", "vaal", "chaos", "alch"];
  rawCalls = [];
  const out = await fetchExchangeChunked("L", EXALTED_ID, want);
  for (const w of want) ok(collectExchangeOffers(out, EXALTED_ID, w).length > 0, "covered after backfill: " + w);
  const solo = rawCalls.filter((c) => c.want.length === 1).map((c) => c.want[0]);
  ok(solo.includes("regal") && solo.includes("vaal"), "backfill re-fetched the starved items (" + solo.join(",") + ")");
  ok(!solo.includes("divine"), "whale (divine) was NOT re-fetched (already covered)");

  // Control: no whale -> the batched pass covers everything, backfill adds nothing.
  rawCalls = [];
  const want2 = ["regal", "vaal", "chaos", "alch"];
  const out2 = await fetchExchangeChunked("L", EXALTED_ID, want2);
  ok(want2.every((w) => collectExchangeOffers(out2, EXALTED_ID, w).length > 0), "no-whale: all covered by batched pass");
  ok(rawCalls.length === 2, "no-whale: no extra backfill calls beyond the 2 batched chunks (no waste)");

  // sanitizeLeague: a proxy that appended its origin onto the league must not
  // reach the upstream API (this caused the live HTTP 400 "Invalid query").
  ok(sanitizeLeague("Runes of Aldurhttp://docker:8098") === "Runes of Aldur", "sanitizeLeague strips an appended proxy origin");
  ok(sanitizeLeague("Runes of Aldur") === "Runes of Aldur", "sanitizeLeague leaves a clean league untouched");
  ok(sanitizeLeague("") === "Runes of Aldur" && sanitizeLeague(null) === "Runes of Aldur", "sanitizeLeague falls back to default on empty");
  ok(sanitizeLeague("  Hardcore  ") === "Hardcore", "sanitizeLeague trims/collapses whitespace");

  // buildExchangeCatalog: walks the grouped static structure into a
  // normalizedName -> {id,name,category} map so the Rune Picker can resolve any
  // pasted rune/essence/soul-core to its exchange id.
  const cat = buildExchangeCatalog({ result: [
    { label: "Runes", entries: [{ id: "lesser-desert-rune", text: "Lesser Desert Rune" }] },
    { label: "Vaal", entries: [{ id: "soul-core-of-tacati", text: "Soul Core of Tacati" }] },
    { label: "Currency", entries: [{ id: "divine", text: "Divine Orb" }] },
  ] });
  const rune = [...cat.values()].find((e) => e.id === "lesser-desert-rune");
  const core = [...cat.values()].find((e) => e.id === "soul-core-of-tacati");
  ok(cat.size === 3, "buildExchangeCatalog maps every entry (" + cat.size + ")");
  ok(rune && rune.category === "Runes" && rune.name === "Lesser Desert Rune", "buildExchangeCatalog keeps id+name+category for runes");
  ok(core && core.category === "Vaal", "buildExchangeCatalog resolves soul cores (Vaal group)");

  // bestExchangeOffer: the Currency Exchange is littered with spam "par" listings
  // that swap the base unit 1:1 (e.g. 1 exalted : 1 divine). For an above-1ex
  // currency these sort to the top and used to be taken as "cheapest", poisoning
  // the rate (Divine read 1 ex instead of ~166). Must drop par offers and pick the
  // cheapest real one — while leaving sub-1ex currencies (whose floor is below the
  // par junk) untouched, and falling back to par only when nothing else exists.
  const offer = (payAmt, recvCur, recvAmt, recvStock) =>
    ({ exchange: { currency: "exalted", amount: payAmt }, item: { currency: recvCur, amount: recvAmt, stock: recvStock } });
  const divineData = { result: { a: offer(1, "divine", 1, 67), b: offer(166, "divine", 1, 373), c: offer(169, "divine", 1, 53) } };
  const dBest = bestExchangeOffer(divineData, EXALTED_ID, "divine", 5);
  ok(dBest && Math.round(dBest.payPerReceive) === 166, "bestExchangeOffer drops the par 1:1 spam (divine -> " + (dBest && dBest.payPerReceive) + " ex, not 1)");

  const transData = { result: { a: offer(1, "transmute", 3, 5000), b: offer(1, "transmute", 1, 100), c: offer(1, "transmute", 2, 200) } };
  const tBest = bestExchangeOffer(transData, EXALTED_ID, "transmute", 5);
  ok(tBest && Math.abs(tBest.payPerReceive - 1 / 3) < 0.01, "bestExchangeOffer keeps the sub-1ex floor (transmute -> " + (tBest && tBest.payPerReceive.toFixed(3)) + ", par drop doesn't touch it)");

  const allPar = { result: { a: offer(1, "x", 1, 9), b: offer(5, "x", 5, 9) } };
  const pBest = bestExchangeOffer(allPar, EXALTED_ID, "x", 5);
  ok(pBest && pBest.payPerReceive === 1, "bestExchangeOffer falls back to par only when nothing else exists");

  // Multi-weapon + slot-aware stat-id resolution (no network). The same
  // conceptual key must resolve to the slot-correct Trade2 id: weapon-local on
  // martial weapons, the SPELL variants on caster weapons, generic elsewhere.
  const slots = gearSearchSlots();
  ok(["bow", "spear", "crossbow", "wand", "staff", "sceptre", "twomace", "quarterstaff"].every((s) => slots[s]), "gearSearchSlots exposes the new weapon classes");
  const qids = (slot, filters) => {
    const { query } = buildGearSearchQuery({ slot, matchMode: "all", filters }, slots[slot]);
    return (query.query.stats || []).flatMap((g) => (g.filters || []).map((f) => f.id));
  };
  const spearIds = qids("spear", [{ key: "critChance", min: 1 }, { key: "critDamage", min: 1 }, { key: "localPhysDamage", min: 1 }]);
  ok(spearIds.includes("explicit.stat_518292764") && spearIds.includes("explicit.stat_2694482655"), "spear crit -> weapon-local ids (like bow)");
  const wandIds = qids("wand", [{ key: "critChance", min: 1 }, { key: "critDamage", min: 1 }, { key: "spellDamage", min: 1 }]);
  ok(wandIds.includes("explicit.stat_737908626") && wandIds.includes("explicit.stat_274716455") && wandIds.includes("explicit.stat_2974417149"), "wand crit -> SPELL crit ids + spell damage");
  const amuIds = qids("amulet", [{ key: "critChance", min: 1 }]);
  ok(amuIds.includes("explicit.stat_587431675"), "amulet crit stays generic (587431675)");
  const sp = analyzeGearSearch("Item Class: Spears\nRarity: Rare\nWidowmaker\n--------\n+1.4% to Critical Hit Chance\n45% increased Physical Damage");
  ok(sp.equipped && sp.equipped.spear, "analyzeGearSearch detects a pasted Spear as the spear slot");
  const wd = analyzeGearSearch("Item Class: Wands\nRarity: Rare\nStorm Branch\n--------\n38% increased Spell Damage\n+2 to Level of all Spell Skills");
  ok(wd.equipped && wd.equipped.wand && Number(wd.equipped.wand.stats.spellDamage) === 38, "analyzeGearSearch detects a Wand + parses spell damage");

  // Slot-aware local/global: "% increased Attack Speed" is LOCAL on a martial
  // weapon, GLOBAL on gloves (was a fragile whole-text class scan).
  const spAs = analyzeGearSearch("Item Class: Spears\nRarity: Rare\nPike\n--------\n12% increased Attack Speed\n8% increased Critical Hit Chance");
  ok(spAs.equipped.spear && Number(spAs.equipped.spear.stats.localAttackSpeed) === 12 && Number(spAs.equipped.spear.stats.localCritChance) === 8, "spear: increased AS/crit parse as LOCAL");
  const glAs = analyzeGearSearch("Item Class: Gloves\nRarity: Rare\nMitts\n--------\n12% increased Attack Speed");
  ok(glAs.equipped.gloves && Number(glAs.equipped.gloves.stats.attackSpeed) === 12 && !glAs.equipped.gloves.stats.localAttackSpeed, "gloves: increased AS parses as GLOBAL");
  // chest no longer offers the dead "deflection" filter (chests roll 0 of it; it
  // is a shield/off-hand mod) — verified live to return 0 listings.
  ok(slots.chest && !slots.chest.statKeys.includes("deflection"), "chest no longer offers the dead deflection filter");

  // P0-A: count-mode threshold is computed from the real count group (which
  // EXCLUDES dps/equipment + composite groups), and never collapses to strict
  // AND. Six UI rows here -> only 4 are count-group filters.
  const bowQ = buildGearSearchQuery({ slot: "bow", matchMode: "count", filters: [
    { key: "dps", min: 100 }, { key: "critChance", min: 1 }, { key: "critDamage", min: 1 },
    { key: "localPhysDamage", min: 1 }, { key: "totalFlatAttack", min: 1 }, { key: "localFlatCold", min: 1 },
  ] }, slots.bow);
  ok(bowQ.matchOf === 4, "count group excludes dps(equipment)+composites (matchOf=" + bowQ.matchOf + ")");
  ok(bowQ.matchMin < bowQ.matchOf && bowQ.matchMin === Math.max(1, Math.round(4 * 0.6)), "auto count min is relaxed not strict-AND (" + bowQ.matchMin + " of " + bowQ.matchOf + ")");
  ok(bowQ.query.query.stats[0].value.min === bowQ.matchMin, "query encodes the auto count min");
  const bowQ2 = buildGearSearchQuery({ slot: "bow", matchMode: "count", minMatches: 99, filters: [{ key: "critChance", min: 1 }, { key: "critDamage", min: 1 }] }, slots.bow);
  ok(bowQ2.matchMin === 2, "user minMatches is capped to the count-group size");
  // P0-B: no single-currency price filter (price.option=divine hid ~80% of the
  // market — every exalt/chaos listing); budget is enforced locally instead.
  ok(!bowQ.query.query.filters.trade_filters, "no trade_filters.price filter (whole-market coverage)");

  // D: per-slot affix pools contain ONLY affixes that item type can actually
  // roll (verified vs live explicit-affix sampling). Guards the "bow offered
  // Cold Resistance" class of bug.
  const pool = (s) => slots[s].statKeys;
  ok(!pool("bow").includes("coldRes") && !pool("bow").includes("life"), "bow pool excludes resistances + life");
  ok(!pool("ring1").includes("critChance"), "ring pool excludes crit chance (rings don't roll it)");
  ok(!pool("belt").includes("energyShield") && !pool("belt").includes("evasion"), "belt pool excludes ES/evasion");
  ok(!pool("jewel").includes("life") && !pool("jewel").includes("flatPhysAttack"), "jewel pool is %-mods only (no flat life/damage)");
  ok(["armour", "evasion", "energyShield", "coldRes", "critChance", "levelAllMinionSkills"].every((k) => pool("helmet").includes(k)), "helmet pool includes armour/evasion/ES/res/crit/minion-levels");
  const hq = buildGearSearchQuery({ slot: "helmet", matchMode: "all", filters: [{ key: "armour", min: 100 }] }, slots.helmet);
  ok(hq.query.query.filters.equipment_filters && hq.query.query.filters.equipment_filters.filters.ar, "armour resolves to the 'ar' equipment filter, not a stat id");

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

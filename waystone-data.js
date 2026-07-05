/*
 * Waystone Juicer data — Path of Exile 2.
 * PATCH: 0.5.0 "Return of the Ancients" (2026-05-29) · League: Runes of Aldur.
 *
 * THIS IS THE FILE TO EDIT WHEN THE PATCH CHANGES. It is best-effort curated
 * from current-patch sources; verify mod wording against your stash and the
 * dedicated regex tools (poe2.re / poe2way.com) before relying on it.
 *
 * Model (0.5): Waystones carry only GENERIC reward/risk mods (rarity, quantity,
 * pack size, monster mods, waystone sustain). The CONTENT mechanics
 * (Breach/Abyss/Delirium/Expedition/Ritual) come from Tablets socketed
 * in Towers — so the per-content regex below is the TABLET regex, while the
 * waystone "run" / "blue" regex are content-agnostic.
 *
 * Stash regex (Ctrl-F): 250-char limit · quoted blocks = AND · | = OR inside a
 * block · !"..." = exclude · ^ start / $ end. Matching is case-insensitive
 * substring/regex against the visible mod text.
 *
 * Sources: mmopixel 0.5 endgame overhaul; aoeah 0.5 currency strats; VULKK regex
 * (2026-05-29); Fextralife Waystones. Tablet mod WORDING ground-truthed from
 * odealo's 0.5 precursor-tablet modifier list + a live 0.5.2 Irradiated tablet
 * tooltip (2026-06-29). Tablet VALUES from community guides (timesaver, mmoexp,
 * maxroll, 2026-06-29): Ritual extra-reroll ~17div, Temple +Unique-Modifier 45+div,
 * Breach +Rare-Monster 10-30div paired.
 */
window.WAYSTONE_DATA = {
  patch: "0.5.4 (Return of the Ancients)",
  league: "Runes of Aldur",
  regexLimit: 250,

  // ── Stash Ctrl-F regex tokens (PoE2 0.5) ────────────────────────────────
  // A WAYSTONE shows its reward mods as a compact "Label: +X%" block, so the
  // correct tokens bridge each label up to its colon and can be made %-AWARE by
  // appending a value range — e.g. `i.+ty: \+([6-9].|1..)%` = Item Rarity ≥60%.
  // (Verified against the official forum regex guide, view-thread/3858429, and
  // poe2.re / poe2way.com. The old presence-only substrings like "ack s" were
  // wrong: they ignored the % and could match unrelated text.) Each quoted
  // block = one AND condition; `|` = OR inside a block; `"!…"` = exclude.
  tokens: {
    // Literal label substrings for the waystone "Label: +X%" reward block, read
    // from a live Tier-15 stash tooltip (2026-06-22): Item Rarity / Pack Size /
    // Monster Rarity / Monster Effectiveness / Waystone Drop Chance. The %-aware
    // builder appends ": \+(range)%" (see map-juicer.js atLeast). Use the
    // distinctive part of each label; "drop chance" handles the hidden word in
    // "Waystone Drop *Chance*:". (The old `i.+ty:`-style bridges were broken — the
    // greedy `.+` matched the WRONG stat and `m.+e:` matched no real label.)
    line: {
      itemRarity:           "item rarity",            // Item Rarity: +X%
      packSize:             "pack size",              // Pack Size: +X%
      monsterRarity:        "monster rarity",         // Monster Rarity: +X%
      monsterEffectiveness: "monster effectiveness",  // Monster Effectiveness: +X%
      waystoneDrop:         "drop chance",            // Waystone Drop Chance: +X%
    },
    corrupted: "corrupted",      // the red "Corrupted" line on a corrupted waystone
    // A fully-juiced 6-modifier waystone has 0 revives — shown as this line.
    // (Revives = 6 at 0 mods, down to 0 at 6+ mods; it is NOT a rolled mod.)
    revivesZero: "revives available: 0",
    // Risk SUFFIXES print as full debuff text (no colon), so match by substring:
    // less Recovery / reduced Flask Charges / -max Player Resistances / less Cooldown.
    danger: "ess rec|educed flask|aximum player|ess cool",
    // Tablets render their mods differently (not the colon block), so tablet
    // matching stays presence-based on the content keyword + these.
    tabletDesirable: "ack s|onster|rar",
  },

  // TABLET mods — used both as Regex Forge chips AND the Tablet Mod Value table.
  // Tokens are case-insensitive regex SUBSTRINGS of the REAL mod text (`|` = OR), so
  // a stash Ctrl-F finds the tablet. Rule (2026-06-29 rewrite): use the SHORTEST
  // distinctive keyword from the actual wording — the old breakage was guessed phrases
  // ("Stabilised", "Hiveblood", "Summoning Circle") that no live mod contains, so the
  // search matched nothing. Wording verified vs odealo's 0.5 list + a live 0.5.2 tablet.
  // VALUES are in DIVINE, COMBINATION-driven: each mod carries `div` (solo), optional
  // `comboDiv` (paired peak), a `note`, and flags `pairs` (low solo / high paired) or
  // `priceCheck` (value only emerges stacked). `tabletGeneral` = the shared prefix/suffix
  // pool every tablet can roll (enablers: low alone, they multiply the mechanic chase).
  tabletGeneral: [
    { label: "Additional Random Map Modifier", token: "dditional random modifier|dditional map modifier", div: 1, note: "\"1 additional random Modifier\" — ≈1 div solo; much more stacked with juicing + mechanic mods" },
    { label: "Unique Monster +Rare Modifier", token: "dditional rare modifier|are modifier", pairs: true, note: "\"Unique Monsters have 1 additional Rare Modifier\" — more rare-mod loot/risk; pairs with rarity" },
    { label: "Item Quantity", token: "uantity of item", enabler: true },
    { label: "Waystone Quantity", token: "uantity of waystone", enabler: true },
    { label: "Item Rarity", token: "arity of item", enabler: true },
    { label: "Pack Size", token: "ack size", enabler: true },
    { label: "Magic Monsters", token: "agic monster", enabler: true },
    { label: "Rare Monsters", token: "are monster", enabler: true },
    { label: "Monster Effectiveness", token: "ffectiveness", enabler: true },
    { label: "Strongbox chance", token: "trongbox", enabler: true },
    { label: "Shrine chance", token: "hrine", enabler: true },
    { label: "Essence chance", token: "ssence", enabler: true },
    { label: "Azmeri Spirit chance", token: "zmeri", enabler: true },
    { label: "Rogue Exile chance", token: "ogue exile", enabler: true },
    { label: "Gold found", token: "old found", enabler: true },
    { label: "Experience gain", token: "xperience gain", enabler: true },
  ],

  // The avoid-list shown in the UI (matches `tokens.danger`).
  dangerousMods: [
    "X% less Recovery Rate of Life and Energy Shield",
    "X% reduced Flask Charges gained",
    "-X% to maximum Player Resistances",
    "X% less Cooldown Recovery Rate",
  ],
  // Removed in 0.5 — do NOT target these (they no longer roll).
  removedInPatch: [
    "Baron's", "Beastly", "Brambled", "Doryani's", "Enervating", "Faridun's",
    "Hallowed", "of Nemeses", "Perennial's", "Rusted", "Sacrificial",
  ],

  // ── Market value of waystone reward stats (%-AWARE) ──────────────────────
  // Oracle: live PoE2 Trade2 "Waystone (Tier 16)" price-floor sweep. For each
  // stat we read the cheapest EXALTED-priced Tier-16 listing at several % of
  // that stat → a price-vs-% CURVE. Key lesson: the same absolute % is NOT
  // comparable across stats because their roll CEILINGS differ (live-probed
  // Tier-16 maxes: Rarity ~87%, Pack ~51%, Effectiveness ~70%, Monster Rarity
  // ~103%, Waystone Drop ~125%), so a flat per-stat weight is misleading —
  // price the rolled % against the stat's own curve. `weight` is the peak
  // value normalised to the best stat (ranking by ceiling). Floors are
  // whole-map and correlated, so a map's value ≈ its single best stat, not the
  // sum. Re-run the sweep each patch.
  marketWeights: {
    source: "PoE2 Trade2 — Waystone (Tier 16) price-vs-% BUY-side floor sweep, GATED corrupted+0-revives (cheapest ask)",
    analyzed: "2026-07-05 (live re-sweep — Item Rarity ≥70% is THE chase (~2200ex cliff); everything else is bulk; combos have ZERO sell market)",
    league: "Runes of Aldur",
    baselineEx: 1, // a junk Tier-16 waystone floors at ~1ex
    note: "2026-07-05 LIVE re-sweep (patch 0.5.4, gated corrupted+0-revives = the real buyable class). ITEM RARITY IS THE ONLY REAL SELL CHASE and it's a CLIFF: ~1ex @50%, ~20ex @60-65%, then ~2200ex @70%+. Everything else is bulk — Pack Size ~25ex @40% (cooled hard from ~150ex in June), Monster Effectiveness ~10ex @40%, Monster Rarity ~1ex, Waystone Drop worthless to BUY. COMBOS HAVE ZERO SELL MARKET: 2-stat gated searches (Rarity≥55+Pack≥30, Rarity≥55+Eff≥40) both returned 0 listings — people RUN good combo maps, they don't sell them. So a multi-decent-roll stone is worth RUNNING but its sell-floor is ~junk, and the dump (which prices on sell-floor) will always mark it 'dump'. That mismatch (run-value vs sell-value) is why scanned combo stones read as low value. The dump keeps SOLO signals only (stash regex can't AND two keeps); the paste evaluator + your own judgment cover combo run-value. Waystone Gold & Experience have no liquid buy market, not priced. Curves are SELL floors — a stone's worth to RUN yourself is higher.",
    // `curve` = [rolled %, floor ex]. `ceiling` = the stat's max roll — the evaluator
    // normalizes pasted rolls against it. These are the HIGHEST ROLL SEEN in the gated
    // live sweep (a lower bound on the true cap; the true theoretical cap can be a few %
    // higher since cheap listings rarely show a max roll). Monster Rarity's old 103 was
    // impossible — the stat maxes ~55%.
    stats: [
      { key: "itemRarity", label: "Item Rarity", weight: 1.0, ceiling: 84, peakEx: 2200,
        curve: [[50, 1], [60, 20], [65, 20], [70, 2200]],
        tip: "BY FAR the top chase (2026-07-05 live). Flat ~20ex through 60-65%, then a CLIFF — ≥70% floors ~2200ex. The whole waystone sell market is basically this one stat. Below 70% it's bulk. (Thin chase market — treat 2200 as the live floor, not a guaranteed sale.)" },
      { key: "packSize", label: "Pack Size", weight: 0.01, ceiling: 49, peakEx: 25,
        curve: [[30, 1], [40, 25]],
        tip: "Cooled hard (2026-07-05: ~25ex @40%, was ~150ex in June). Only a few × the ~5ex bulk floor." },
      { key: "monsterEffectiveness", label: "Monster Effectiveness", weight: 0.005, ceiling: 70, peakEx: 10,
        curve: [[20, 1], [40, 10]],
        tip: "Marginal ~10ex @40% (2026-07-05). Barely above the ~5ex bulk floor." },
      { key: "waystoneDrop", label: "Waystone Drop Chance", weight: 0, ceiling: 125, peakEx: 1, est: true,
        curve: [[40, 1], [105, 1]],
        tip: "Worthless to BUY — even a ~105% roll floors at ~1ex. Not live-swept (est). Sustain only helps YOUR own endless-T16 farming; the market won't pay for it." },
      { key: "monsterRarity", label: "Monster Rarity", weight: 0, ceiling: 55, peakEx: 1,
        curve: [[40, 1]],
        tip: "~1ex even at high rolls (2026-07-05). Real cap ~55% (the old 103 was wrong). Kept in the dump only by your explicit rule." },
    ],
  },

  // `scalesWith`: how much each content type benefits from a waystone's reward
  // stats (0–1 per stat). Used by the evaluator to suggest the best content to
  // PAIR a pasted map with (waystone mods are content-agnostic in 0.5; the
  // mechanic comes from the tablet, so this is a synergy hint).
  contentTypes: [
    {
      id: "breach",
      label: "Breach",
      tabletToken: "reach",
      desirable: [
        { label: "Additional Rare Monster", token: "pawn an additional rare|dditional rare monster", div: 3, comboDiv: 30, note: "\"Breaches spawn an additional Rare Monster\" — ~3 div solo · 10–30 div with Rarity/Effectiveness/extra map mods (was the broken \"Stabilised\" token)" },
        { label: "Additional Breach(es)", token: "dditional breach", pairs: true, note: "chance to contain extra Breaches; strong with splinter/density mods" },
        { label: "Breach Splinter Quantity", token: "reach splinter", pairs: true, note: "low solo; scales splinter income with density" },
        { label: "Additional Clasped Hand", token: "lasped hand", pairs: true, note: "+1 Clasped Hand per Breach" },
      ],
      scalesWith: { packSize: 1.0, monsterRarity: 0.85, itemRarity: 0.4 },
      blurb: "Breaches drop Splinters & Clasped Hands; scale hard with Pack Size, Rare Monsters and Rarity. Stack Breach atlas nodes + Breach tablets.",
      juiceNote: "Pair with Breach Tablets (rolled Rarity/Quantity/Monsters). Pack size & rare-monster mods convert directly into Breach loot.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "All Pack Size = far more monsters per Clasped Hand." },
        { name: "Omen of Chaotic Monsters", why: "More rares/magics in Breaches = more splinters & drops." },
      ],
    },
    {
      id: "abyss",
      label: "Abyss",
      tabletToken: "byss",
      valueNote: "Price-check if you have 2+ of these",
      desirable: [
        { label: "Additional Abyss(es)", token: "dditional abyss", priceCheck: true },          // chance to contain additional Abysses
        { label: "Effectiveness per Closed Pit", token: "losed pit", priceCheck: true },          // Effectiveness for each closed Pit
        { label: "Abyssal Modifiers chance", token: "byssal modifier", priceCheck: true },         // chance for Abyssal monsters to have Abyssal Modifiers
        { label: "Rare Monsters from Abysses", token: "rom abyss", priceCheck: true },             // additional Rare Monsters spawned from Abysses
      ],
      scalesWith: { packSize: 1.0, monsterEffectiveness: 0.7 },
      blurb: "Abyss pits lead to Abyssal Depths; reward scales with monster density / pack size. Atlas: From Below, Dark Depths, then Lord of the Pit.",
      juiceNote: "Pair with Abyss Tablets + monster-effectiveness. Density and pack size matter more than raw quantity.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "Pack Size feeds the Abyss line with more monsters." },
        { name: "Omen of Chaotic Monsters", why: "Denser rares along the pit for better Depths." },
      ],
    },
    {
      id: "delirium",
      label: "Delirium",
      tabletToken: "eliri",
      valueNote: "Price-check if you have 2+ of these",
      desirable: [
        { label: "Simulacrum Splinter stack", token: "imulacrum", pairs: true },          // increased Stack size of Simulacrum Splinters
        { label: "Fracturing Mirrors", token: "racturing mirror", pairs: true },          // fog spawns increased Fracturing Mirrors
        { label: "Additional Reward type", token: "dditional reward type", priceCheck: true }, // chance to generate an additional Reward type
        { label: "Unique Boss chance", token: "nique boss", priceCheck: true },           // more likely to spawn Unique Bosses
      ],
      scalesWith: { packSize: 1.0, monsterEffectiveness: 0.65 },
      blurb: "Delirium fog grants reward per % progress; scales with Pack Size and monster density. Delirium tablets add Mirrors of Delirium in range.",
      juiceNote: "Pair with Delirium Tablets. Prioritise Pack Size + clear speed so you push deep into the fog before it ends.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "Pack Size is king for Delirium — more monsters before the fog ends." },
      ],
    },
    {
      id: "ritual",
      label: "Ritual",
      tabletToken: "itual",
      desirable: [
        { label: "Extra Reroll (additional time)", token: "llow rerolling", div: 17, comboDiv: 35, note: "\"Altars allow rerolling Favours an additional time\" — ~17 div solo (top Ritual mod) · ~34 div with omen-chance/tribute mods. Token is \"llow rerolling\" so it doesn't also match the reduced-tribute reroll mod." },
        { label: "Reduced Reroll/Defer Tribute", token: "educed tribute", pairs: true, note: "rerolling/deferring Favours costs reduced Tribute; strong paired with extra-reroll + omens" },
        { label: "Favours → Omens chance", token: "o be omen", div: 2, comboDiv: 20, note: "\"Favours...increased chance to be Omens\" — low solo; high paired with reroll mods (omen farming)" },
      ],
      scalesWith: { monsterRarity: 1.0, packSize: 0.6 },
      blurb: "Ritual altars give Tribute to spend; scales with rare-monster density. Ritual tablets add altars / increase Tribute & rerolls.",
      juiceNote: "Pair with Ritual Tablets. Rare-monster and pack-size mods raise Tribute generated.",
      omenPicks: [
        { name: "Omen of Chaotic Monsters", why: "Rare monsters generate the most Tribute at altars." },
      ],
    },
    {
      id: "irradiated",
      label: "Irradiated (Rarity farm)",
      tabletToken: "rradiat",
      scalesWith: { itemRarity: 1.0, packSize: 0.5 },
      blurb: "Pure rarity/quantity farming with no specific mechanic — Irradiated Tablets (Rarity/Quantity/Pack) on max-reward waystones.",
      juiceNote: "Use Irradiated Tablets. Stack Rarity first, then Quantity and Pack Size.",
      omenPicks: [
        { name: "Omen of Chaotic Rarity", why: "Pure loot-quality farming — convert the whole map to Rarity." },
      ],
    },
    {
      id: "temple",
      label: "Vaal / Temple",
      tabletToken: "emple",   // base is "Temple Tablet" (confirmed live); mods reference Vaal Beacons
      desirable: [
        { label: "Additional Unique Modifier", token: "nique modifier", div: 5, comboDiv: 45, note: "5–6 div solo · 40–50 div with Vaal Beacon unique-monster mods" }, // Unique Monsters have an additional Unique Modifier
        { label: "Extra Crystal", token: "dditional crystal|extra crystal", div: 1, comboDiv: 3, note: "1–3 div depending on roll" }, // chance to gain an additional Crystal from Vaal Beacons
      ],
      blurb: "Temple Tablets add Vaal Beacons; the Unique-Modifier roll (huge with Vaal Beacon unique monsters) + extra Crystals are the chase.",
    },
    {
      id: "overseer",
      label: "Overseer (Map Boss)",
      tabletToken: "verseer",   // base = "Overseer Tablet" (confirmed live); mods buff Map Bosses
      desirable: [
        { label: "Boss Item/Waystone Quantity", token: "ropped by map boss", pairs: true },  // Quantity of Items/Waystones dropped by Map Bosses
        { label: "Boss spawns extra Strongbox/Shrine/Essence", token: "ontain an additional" }, // Areas with Map Bosses contain an additional Strongbox/Shrine/Essence/Azmeri (was the broken "additional Modifier" guess)
        { label: "Boss Item Rarity", token: "arity of items dropped|arity of .+dropped by", pairs: true }, // increased Rarity of Items dropped by Map Bosses
        { label: "Boss Experience", token: "rant.+xperience" },        // Map Bosses grant increased Experience
      ],
      scalesWith: { itemRarity: 0.8, monsterRarity: 0.4 },
      blurb: "Overseer Tablets buff Map Bosses — boss item/waystone quantity + extra boss modifiers. Chase the drop-quantity and additional-modifier rolls; pair with high Item Rarity waystones.",
    },
  ],
};

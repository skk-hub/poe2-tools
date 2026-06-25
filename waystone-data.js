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
 * (2026-05-29); Fextralife Waystones.
 */
window.WAYSTONE_DATA = {
  patch: "0.5.2 (Return of the Ancients)",
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
  // Tokens are case-insensitive regex substrings (`|` = OR). VALUES are in DIVINE,
  // ground-truthed from the user's market knowledge (2026-06-22): tablet value is
  // COMBINATION-driven, so each mod carries `div` (solo), optional `comboDiv` (paired
  // peak), a `note`, and flags `pairs` (low solo / high paired) or `priceCheck` (value
  // only emerges stacked — "price-check if 2+"). `tabletGeneral` = generic "juicing"
  // enablers: low value alone, they multiply the mechanic chase mods.
  tabletGeneral: [
    { label: "2 Additional Map Modifiers", token: "dditional map modifier|dditional random modifier", div: 1, note: "≈1 div solo; much more stacked with juicing + mechanic mods" },
    { label: "Item Quantity", token: "uantity of item", enabler: true },
    { label: "Waystone Quantity", token: "uantity of waystone", enabler: true },
    { label: "Item Rarity", token: "arity of item", enabler: true },
    { label: "Pack Size", token: "ack size", enabler: true },
    { label: "Magic Monsters", token: "agic monster", enabler: true },
    { label: "Rare Monsters", token: "are monster", enabler: true },
    { label: "Irradiated", token: "rradiat", enabler: true },
    { label: "Effectiveness", token: "ffectiveness", enabler: true },
    { label: "Strongbox chance", token: "trongbox", enabler: true },
    { label: "Summoning Circle", token: "ummoning circle", enabler: true },
    { label: "Essence chance", token: "ssence", enabler: true },
    { label: "Gold found", token: "old found", enabler: true },
    { label: "Rare Chests", token: "are chest", enabler: true },
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
    source: "PoE2 Trade2 — Waystone (Tier 16) price-vs-% BUY-side floor sweep (cheapest ask)",
    analyzed: "2026-06-13 (Drop Chance + Monster Rarity re-probed buy-side 2026-06-24)",
    league: "Runes of Aldur",
    baselineEx: 1, // a junk Tier-16 waystone floors at ~1ex
    note: "Value depends on the rolled %, not just which stat. High Item Rarity is the top chase; Pack Size / Monster Effectiveness win on value-per-% at mid rolls but peak lower. Buy-side recheck (2026-06-24): Waystone Drop Chance is worthless to BUY (~1ex even at 105%), Monster Rarity is a mild ~5ex at ≥60%. The other waystone reward mods — Waystone Gold & Waystone Experience — have no liquid Tier-16 buy market (0 listings at modest rolls), so they're not priced here. COMBO CAVEAT (key): waystone value is largely COMBINATION-driven and these per-stat solo curves can't express it — a single high stat is ~5ex, but high Monster Rarity + Drop Chance ≥100% + Pack together is a real chase (only ~3 on market, sampled 25/100/400ex). The dump filter (map-juicer buildDump) keeps Item Rarity ≥60% OR Monster Effectiveness ≥40% OR Drop ≥100% OR Monster Rarity ≥100% precisely to catch those combos; don't rely on the solo curves to value a multi-high map. GATED PROBE 2026-06-25 (corrupted+0-revives T16, sort price asc — the dump's exact class): Monster Effectiveness ≥40% floors ~10–50ex (real value, now kept), but Pack Size ≥35% still sits at ~1ex buy-side — so the packSize/monsterEffectiveness solo curves below (peakEx 37–40, from an UNGATED sweep) OVERSTATE Pack: gated-on-class, Pack alone is junk. Trust the gated dump rules over those curves until the curves are re-swept gated.",
    // ranked by peak (ceiling) value; `curve` = [rolled %, floor ex]
    stats: [
      { key: "itemRarity", label: "Item Rarity", weight: 1.0, ceiling: 66, peakEx: 180,
        curve: [[30, 1], [55, 5], [60, 50], [66, 180]],
        tip: "The one SOLO stat the market pays for — but only at the top: ~5ex until ~55%, then jumps (≥60% floored 50ex, up to ~180ex; 2026-06-24 buy probe). ≥70% doesn't exist on the market. Below 60% it's 5ex bulk like everything else." },
      { key: "packSize", label: "Pack Size", weight: 0.12, ceiling: 51, peakEx: 40,
        curve: [[20, 1], [30, 20], [40, 40]],
        tip: "Best value per % at mid rolls (~2ex/%). Caps ~40% → ~40ex; can't reach Rarity's top end." },
      { key: "monsterEffectiveness", label: "Monster Effectiveness", weight: 0.11, ceiling: 70, peakEx: 37,
        curve: [[20, 1], [40, 37]],
        tip: "Tracks Pack Size — strong mid-roll value, peaks ~40% → ~37ex." },
      { key: "waystoneDrop", label: "Waystone Drop Chance", weight: 0, ceiling: 105, peakEx: 1,
        curve: [[40, 1], [105, 1]],
        tip: "Worthless to BUY — even a ~105% roll floors at ~1ex (2026-06-24 Trade2 buy probe). Sustain only helps YOUR own endless-T16 farming; the market won't pay for it." },
      { key: "monsterRarity", label: "Monster Rarity", weight: 0.02, ceiling: 103, peakEx: 5,
        curve: [[40, 1], [60, 5]],
        tip: "Mild value — maps with ≥60% floor ~5ex buy-side (2026-06-24 probe), up from ~1ex. Minor stat; the 5ex floor may partly reflect other mods on the same map." },
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
        { label: "Unstable: +3 Rare Monsters", token: "tabilised|tabilized", div: 3, comboDiv: 30, note: "3 div solo · 10–30 div paired with other Breach mods" }, // spawn 3 additional Rare Monsters when Stabilised
        { label: "Hiveblood Quantity", token: "iveblood", pairs: true, note: "low solo; good with generic juicing" },
        { label: "Rare Breach Monster Effectiveness", token: "reach monster", pairs: true, note: "low solo; only worth it with other mods" },
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
        { label: "Four Additional Abysses", token: "dditional abyss", priceCheck: true },        // chance to contain four additional Abysses
        { label: "Effectiveness per Closed Pit", token: "closed pit", priceCheck: true },          // Effectiveness for each closed Pit, up to 100%
        { label: "Abyssal Modifiers chance", token: "byssal modifier", priceCheck: true },         // chance for Abyssal monsters to have Abyssal Modifiers
        { label: "Rare Monsters from Abysses", token: "pawned from abyss|are spawned from", priceCheck: true }, // additional Rare Monsters spawned from Abysses
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
        { label: "Simulacrum Splinter stack", token: "imulacrum", priceCheck: true },   // increased Stack size of Simulacrum Splinters
        { label: "Fracturing Mirrors", token: "racturing mirror", priceCheck: true },   // fog spawns increased Fracturing Mirrors
        { label: "Mirror Shards", token: "irror shard", priceCheck: true },              // fog spawns increased Mirror Shards
        { label: "Unique Boss chance", token: "nique boss", priceCheck: true },          // more likely to spawn Unique Bosses
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
        { label: "Extra Reroll Favours", token: "olling favours|eroll favour|dditional time", div: 15, comboDiv: 60, note: "13–17 div solo · 20–60 div paired with other Ritual mods" }, // roll Favours 1–3 additional times
        { label: "Reduced Reroll Tribute", token: "educed tribute|eferring", pairs: true, note: "high value paired with rerolls / omens" }, // deferring/rerolling costs reduced Tribute
        { label: "Omen Chance", token: "be omen|men", pairs: true, note: "low solo; high paired with Ritual mods" }, // Favours have increased chance to be Omens
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
        { label: "Boss Item Quantity", token: "ropped by" },          // Quantity of Items/Waystones dropped by Map Bosses (confirmed)
        { label: "Additional Boss Modifier", token: "dditional modifier|dditional .+modifier" }, // Map Bosses have an additional Modifier (confirmed)
        { label: "Boss Experience", token: "rant.+xperience" },        // Map Bosses grant increased Experience (confirmed)
      ],
      scalesWith: { itemRarity: 0.8, monsterRarity: 0.4 },
      blurb: "Overseer Tablets buff Map Bosses — boss item/waystone quantity + extra boss modifiers. Chase the drop-quantity and additional-modifier rolls; pair with high Item Rarity waystones.",
    },
  ],
};

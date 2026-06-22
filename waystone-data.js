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
    // Per-label bridge tokens for the waystone "Label: +X%" reward block.
    line: {
      itemRarity:    "i.+ty:",   // Item Rarity: +X%
      packSize:      "m.+e:",    // Monster Pack Size: +X%
      magicMonsters: "ma.+s:",   // Magic Monsters: +X%
      rareMonsters:  "r.+s:",    // Rare Monsters: +X%
      waystoneDrop:  "w.+e:",    // Waystone Drop Chance: +X%
    },
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

  // Desirable TABLET mods, surfaced as toggle chips in the Regex Forge. Tokens are
  // case-insensitive substrings; `|` = OR (so one chip can cover spelling variants).
  // Wording grounded in a live Trade2 sweep of tablets priced ≥20–300ex (2026-06-22):
  // the mods below recur on the expensive tier. `tabletGeneral` applies to any tablet.
  tabletGeneral: [
    { label: "Item Quantity", token: "uantity of item" },
    { label: "Waystone Quantity", token: "uantity of waystone" },  // % increased Quantity of Waystones found
    { label: "Item Rarity", token: "arity of item" },
    { label: "Pack Size", token: "ack size" },
    { label: "Magic Monsters", token: "agic monster" },
    { label: "Rare Monsters", token: "are monster" },
    { label: "Irradiated", token: "rradiat" },
    { label: "Effectiveness", token: "ffectiveness" },
    // High-value content mods seen across the 100–300ex tier (content-agnostic):
    { label: "Strongbox chance", token: "trongbox" },           // chance to contain Strongboxes
    { label: "Summoning Circle", token: "ummoning circle" },    // chance to contain a Summoning Circle
    { label: "Essence chance", token: "ssence" },               // chance to contain Essences
    { label: "Gold found", token: "old found" },                // increased Gold found in Map
    { label: "Rare Chests", token: "are chest" },               // additional Rare Chests
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
    source: "PoE2 Trade2 — Waystone (Tier 16) price-vs-% curve sweep",
    analyzed: "2026-06-13",
    league: "Runes of Aldur",
    baselineEx: 1, // a junk Tier-16 waystone floors at ~1ex
    note: "Value depends on the rolled %, not just which stat. High Item Rarity is the top chase; Pack Size / Monster Effectiveness win on value-per-% at mid rolls but peak lower.",
    // ranked by peak (ceiling) value; `curve` = [rolled %, floor ex]
    stats: [
      { key: "itemRarity", label: "Item Rarity", weight: 1.0, ceiling: 87, peakEx: 325,
        curve: [[30, 1], [50, 20], [70, 325]],
        tip: "Highest ceiling and the top chase — explodes past ~60% (70%+ ≈ 325ex). Mid rarity (≤50%) is cheap." },
      { key: "packSize", label: "Pack Size", weight: 0.12, ceiling: 51, peakEx: 40,
        curve: [[20, 1], [30, 20], [40, 40]],
        tip: "Best value per % at mid rolls (~2ex/%). Caps ~40% → ~40ex; can't reach Rarity's top end." },
      { key: "monsterEffectiveness", label: "Monster Effectiveness", weight: 0.11, ceiling: 70, peakEx: 37,
        curve: [[20, 1], [40, 37]],
        tip: "Tracks Pack Size — strong mid-roll value, peaks ~40% → ~37ex." },
      { key: "waystoneDrop", label: "Waystone Drop Chance", weight: 0.07, ceiling: 125, peakEx: 22, est: true,
        curve: [[40, 1], [70, 8], [125, 22]],
        tip: "Rolls past 100% (live max ~125%, NOT capped). Price is an ESTIMATE (not yet swept) — sustain has market value for endless T16 farming. Re-sweep Trade2 to confirm." },
      { key: "monsterRarity", label: "Monster Rarity", weight: 0.01, ceiling: 103, peakEx: 1,
        curve: [[40, 1]],
        tip: "Worthless even at high rolls (~1ex). Never pay for it." },
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
        { label: "Hiveblood", token: "iveblood" },                  // Quantity of Hiveblood found (confirmed)
        { label: "Unstable Breaches", token: "nstable" },           // Unstable Breaches spawn/contain extra (confirmed)
        { label: "Additional Breach", token: "dditional breach" },
        { label: "Extra Rare Monster", token: "dditional rare monster|extra rare monster" },
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
      desirable: [
        { label: "Desecrated Currency", token: "esecrated" },       // chance for Desecrated Currency (confirmed, top chase)
        { label: "Additional Abysses", token: "dditional abyss" },  // chance to contain additional Abysses (confirmed)
        { label: "Pit Rewards", token: "wice as likely" },          // Pits twice as likely to have Rewards (confirmed)
        { label: "Effectiveness per Pit", token: "closed pit" },    // Effectiveness for each closed Pit (confirmed)
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
      desirable: [
        { label: "Unique Boss", token: "nique boss" },              // more likely to spawn Unique Bosses (confirmed)
        { label: "Simulacrum Splinter", token: "imulacrum" },       // increased Stack size of Simulacrum Splinters (confirmed)
        { label: "Fog never dissipates", token: "issipate" },       // Delirium Fog never dissipates (confirmed)
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
        { label: "Tribute", token: "ribute" },                     // increased Tribute (confirmed, top chase)
        { label: "Reroll Favours", token: "eroll favour|eroll" },   // Reroll Favours twice as many times (confirmed)
        { label: "Omens", token: "men" },
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
        { label: "Extra Crystal", token: "dditional crystal|extra crystal" }, // chance to gain an additional Crystal from Vaal Beacons (confirmed)
        { label: "Vaal Beacon scaling", token: "aal beacon" },               // packs / Pack Size around Vaal Beacons (confirmed)
      ],
      blurb: "Temple Tablets add Vaal Beacons; extra Crystals around the beacons are the chase.",
    },
  ],
};

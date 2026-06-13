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
 * (Breach/Abyss/Delirium/Expedition/Ritual) come from Precursor Tablets socketed
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
  patch: "0.5.0 Return of the Ancients",
  league: "Runes of Aldur",
  regexLimit: 250,

  // Short tokens chosen to match the in-game mod text without colliding with
  // unrelated mods (e.g. "ack s" matches "Pack Size" but not "Attack Speed").
  // Order = market value (see marketWeights): Pack Size first, then Monster
  // Effectiveness / Rarity. NOTE 0.5: waystones no longer roll "Quantity of
  // Items" — that token was removed.
  tokens: {
    // Desirable WAYSTONE reward mods (used for the magic/blue upgrade pick).
    rewardBlue: "ack s|agic monst|onster eff|rar|aystone f",
    // Desirable TABLET mods (pack size / monsters / rarity).
    tabletDesirable: "ack s|onster|rar",
    // Risky suffixes to exclude (less Recovery / reduced Flask Charges /
    // -% maximum Player Resistances / less Cooldown Recovery).
    danger: "ess rec|educed flask|aximum player|ess cool",
  },

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

  // Top waystone reward mods to target when juicing, ORDERED BY MARKET VALUE
  // (see marketWeights below — derived from live Trade2 price floors). Target
  // %s are the thresholds where the market starts paying a premium.
  waystoneTargets: [
    "increased Pack Size — aim ≥35% (top-paid stat, ~40ex premium tier)",
    "increased Monster Effectiveness / Magic Monsters — aim ≥30% (≈ as valued as Pack Size)",
    "increased Rarity of Items found — only pays high: aim ≥50% (mid rarity is near-worthless)",
    "increased Monster Rarity — cheapest reward stat; nice-to-have, don't pay for it",
    "more Waystones found in Area (sustain) — utility, not priced",
  ],

  // ── Market value of waystone reward stats ───────────────────────────────
  // Oracle: live PoE2 Trade2 "Waystone (Tier 16)" price-floor sweep. For each
  // stat we read the cheapest EXALTED-priced Tier-16 listing meeting a
  // threshold; that floor = the market's marginal price for that roll. Single
  // "1 ex" listings are AFK/mispriced and ignored — figures read the 2nd–5th
  // cheapest cluster. Stats correlate (premium maps stack several), so treat
  // `weight` as a RELATIVE ranking, not an isolated currency value. Re-run the
  // sweep each patch to refresh. `weight` is normalised to Pack Size = 1.0.
  marketWeights: {
    source: "PoE2 Trade2 — Waystone (Tier 16) price-floor sweep",
    analyzed: "2026-06-13",
    league: "Runes of Aldur",
    baselineEx: 1, // a junk Tier-16 waystone floors at ~1ex
    // ranked best → worst by premium over baseline
    stats: [
      { key: "packSize", label: "Pack Size", weight: 1.0, premiumAt: 35,
        floors: [[25, 20], [35, 40]],
        tip: "Density — the #1 paid stat. ≥35% is the ~40ex premium tier." },
      { key: "monsterEffectiveness", label: "Monster Effectiveness", weight: 0.95, premiumAt: 30,
        floors: [[30, 40]],
        tip: "Magic-monster density/effectiveness. Nearly as valued as Pack Size." },
      { key: "itemRarity", label: "Item Rarity", weight: 0.55, premiumAt: 50,
        floors: [[35, 4], [50, 25]],
        tip: "Only pays at high rolls (≥50 → ~25ex). Mid rarity barely moves price." },
      { key: "monsterRarity", label: "Monster Rarity", weight: 0.15, premiumAt: null,
        floors: [[30, 6], [40, 6]],
        tip: "Cheapest reward stat — flat ~6ex even at ≥40%. Don't pay for it." },
    ],
  },

  // Shared blue->juiced crafting path (content-agnostic). Per-content notes add
  // the right tablet + scaling tip.
  juiceBase: [
    "Pick a Magic (blue) waystone of your map tier that already rolled Rarity or Quantity (use the Blue regex).",
    "Orb of Augmentation -> add the 2nd mod (aim for the other of Rarity / Quantity / Pack Size).",
    "Regal Orb -> upgrade to Rare (3rd mod).",
    "Exalted Orb x3 -> fill toward 6 mods. Use Omen of Sinistral Exaltation so each Exalt adds a PREFIX (the reward mods), and/or Omen of Greater Exaltation to add 2 at once.",
    "If a risky suffix lands (less Recovery / reduced Flask / -max Player Res / less Cooldown), use Omen of Whittling + a Chaos Orb to strip your worst mod, or keep it for cheap throwaway maps.",
    "Identify the waystone (0.5 requires ID before the Map Device).",
    "In the Tower covering this map, socket up to 3 Precursor Tablets (see the content tablet below).",
    "Shortcut: on a Rare waystone, use Omen of Chaotic Rarity / Quantity / Monsters + a Chaos Orb to replace ALL mods with that one theme (pure-rarity / all-pack-size / all-monster maps).",
  ],

  // Omens that help juice waystones. On waystones, PREFIXES are the reward mods
  // and SUFFIXES are the risk mods, so prefix-forcing omens are the MVP. Omens
  // trigger automatically when you use the matching orb — carry ONLY the omen
  // you want so they don't conflict. (Verify left/right side naming in-game.)
  omens: [
    { name: "Omen of Chaotic Rarity", orb: "Chaos", effect: "Next Chaos Orb replaces ALL waystone mods with mods that grant Item Rarity",
      use: "Map-juicing shortcut: turn a rare waystone into a pure-Rarity map in one Chaos. Best for loot-quality / currency farming." },
    { name: "Omen of Chaotic Quantity", orb: "Chaos", effect: "Next Chaos Orb replaces ALL waystone mods with mods that grant Pack Size (note: 'Quantity' omen = Pack Size)",
      use: "Turn a rare waystone into an all-Pack-Size map — max monster count for Delirium / Breach / density farming." },
    { name: "Omen of Chaotic Monsters", orb: "Chaos", effect: "Next Chaos Orb replaces ALL waystone mods with mods that grant Rare & Magic Monsters",
      use: "All-monster map: more rares/magics for Ritual tribute, drops, and elite farming. Raises difficulty too." },
    { name: "Omen of Sinistral Exaltation", orb: "Exalted", effect: "Next Exalted Orb adds a PREFIX only",
      use: "Best juice omen — reward mods (Rarity, Quantity, Pack Size, Waystones found) are prefixes, so this forces a good mod instead of a risky suffix." },
    { name: "Omen of Greater Exaltation", orb: "Exalted", effect: "Next Exalted Orb adds 2 modifiers",
      use: "Fill toward 6 mods twice as fast. Strong once your prefixes are the open slots." },
    { name: "Omen of Whittling", orb: "Chaos", effect: "Next Chaos Orb removes the lowest-tier modifier",
      use: "Clean a bricked map — strip your worst/risky mod instead of a random one, then re-Exalt." },
    { name: "Omen of Dextral Exaltation", orb: "Exalted", effect: "Next Exalted Orb adds a SUFFIX only",
      use: "Usually AVOID for safe juicing (suffixes are the risk/monster mods). Use only if you specifically want monster-difficulty mods." },
    { name: "Omen of Homogenising Exaltation", orb: "Exalted", effect: "Next Exalted adds a modifier of a type already present",
      use: "Legacy — no longer drops since 0.4, but existing copies still work." },
    { name: "Omen of Corruption", orb: "Vaal", effect: "Next Vaal Orb cannot 'do nothing' — forces a corruption outcome",
      use: "Gamble a finished map for a corrupt upgrade (extra mod / tier shift). High risk, no take-backs." },
  ],

  contentTypes: [
    {
      id: "breach",
      label: "Breach",
      tabletToken: "reach",
      blurb: "Breaches drop Splinters & Clasped Hands; scale hard with Pack Size, Rare Monsters and Rarity. Stack Breach atlas nodes + Breach tablets.",
      juiceNote: "Pair with Breach Precursor Tablets (rolled Rarity/Quantity/Monsters). Pack size & rare-monster mods convert directly into Breach loot.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "All Pack Size = far more monsters per Clasped Hand." },
        { name: "Omen of Chaotic Monsters", why: "More rares/magics in Breaches = more splinters & drops." },
      ],
    },
    {
      id: "abyss",
      label: "Abyss",
      tabletToken: "byss",
      blurb: "Abyss pits lead to Abyssal Depths; reward scales with monster density / pack size. Atlas: From Below, Dark Depths, then Lord of the Pit.",
      juiceNote: "Pair with Abyss Precursor Tablets + monster-effectiveness. Density and pack size matter more than raw quantity.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "Pack Size feeds the Abyss line with more monsters." },
        { name: "Omen of Chaotic Monsters", why: "Denser rares along the pit for better Depths." },
      ],
    },
    {
      id: "delirium",
      label: "Delirium",
      tabletToken: "eliri",
      blurb: "Delirium fog grants reward per % progress; scales with Pack Size and monster density. Delirium tablets add Mirrors of Delirium in range.",
      juiceNote: "Pair with Delirium Precursor Tablets. Prioritise Pack Size + clear speed so you push deep into the fog before it ends.",
      omenPicks: [
        { name: "Omen of Chaotic Quantity", why: "Pack Size is king for Delirium — more monsters before the fog ends." },
      ],
    },
    {
      id: "expedition",
      label: "Expedition",
      tabletToken: "xpediti",
      blurb: "Expedition Remnants & Logbooks; among the strongest this league when stacked with the Runes of Aldur mechanic.",
      juiceNote: "Pair with Expedition Precursor Tablets. Quantity/Rarity on the waystone plus Remnant-scaling on the tablet.",
      omenPicks: [
        { name: "Omen of Chaotic Rarity", why: "Expedition reward is loot-quality driven — stack Rarity." },
      ],
    },
    {
      id: "ritual",
      label: "Ritual",
      tabletToken: "itual",
      blurb: "Ritual altars give Tribute to spend; scales with rare-monster density. Ritual tablets add altars / increase Tribute & rerolls.",
      juiceNote: "Pair with Ritual Precursor Tablets. Rare-monster and pack-size mods raise Tribute generated.",
      omenPicks: [
        { name: "Omen of Chaotic Monsters", why: "Rare monsters generate the most Tribute at altars." },
      ],
    },
    {
      id: "general",
      label: "General (Rarity farm)",
      tabletToken: "recursor",
      blurb: "Pure rarity/quantity farming with no specific mechanic — generic Precursor Tablets (Rarity/Quantity/Pack) on max-reward waystones.",
      juiceNote: "Use generic Precursor Tablets. Stack Rarity first, then Quantity and Pack Size.",
      omenPicks: [
        { name: "Omen of Chaotic Rarity", why: "Pure loot-quality farming — convert the whole map to Rarity." },
      ],
    },
  ],
};

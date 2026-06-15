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
  // (see marketWeights below). Value is %-DEPENDENT — these notes say where on
  // the curve each stat is worth chasing.
  waystoneTargets: [
    "increased Item Rarity — the top chase: value explodes past ~60% (70%+ ≈ 325ex). Mid rarity (≤50%) is cheap.",
    "increased Pack Size — best value per % at mid rolls; aim ≥30%. Caps ~40% ≈ 40ex (lower ceiling than Rarity).",
    "increased Monster Effectiveness / Magic Monsters — tracks Pack Size; aim ≥40% ≈ 37ex.",
    "increased Monster Rarity — worthless even at high rolls (~1ex); never pay for it.",
    "more Waystones found in Area (sustain) — utility, not priced.",
  ],

  // ── Market value of waystone reward stats (%-AWARE) ──────────────────────
  // Oracle: live PoE2 Trade2 "Waystone (Tier 16)" price-floor sweep. For each
  // stat we read the cheapest EXALTED-priced Tier-16 listing at several % of
  // that stat → a price-vs-% CURVE. Key lesson: the same absolute % is NOT
  // comparable across stats because their roll CEILINGS differ (Rarity rolls
  // to ~84%, Pack Size only ~41%), so a flat per-stat weight is misleading —
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
      { key: "itemRarity", label: "Item Rarity", weight: 1.0, ceiling: 84, peakEx: 325,
        curve: [[30, 1], [50, 20], [70, 325]],
        tip: "Highest ceiling and the top chase — explodes past ~60% (70%+ ≈ 325ex). Mid rarity (≤50%) is cheap." },
      { key: "packSize", label: "Pack Size", weight: 0.12, ceiling: 41, peakEx: 40,
        curve: [[20, 1], [30, 20], [40, 40]],
        tip: "Best value per % at mid rolls (~2ex/%). Caps ~40% → ~40ex; can't reach Rarity's top end." },
      { key: "monsterEffectiveness", label: "Monster Effectiveness", weight: 0.11, ceiling: 44, peakEx: 37,
        curve: [[20, 1], [40, 37]],
        tip: "Tracks Pack Size — strong mid-roll value, peaks ~40% → ~37ex." },
      { key: "monsterRarity", label: "Monster Rarity", weight: 0.01, ceiling: 62, peakEx: 1,
        curve: [[40, 1]],
        tip: "Worthless even at ≥40% (~1ex). Never pay for it." },
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

  // `scalesWith`: how much each content type benefits from a waystone's reward
  // stats (0–1 per stat). Used by the evaluator to suggest the best content to
  // PAIR a pasted map with (waystone mods are content-agnostic in 0.5; the
  // mechanic comes from the tablet, so this is a synergy hint).
  contentTypes: [
    {
      id: "breach",
      label: "Breach",
      tabletToken: "reach",
      scalesWith: { packSize: 1.0, monsterRarity: 0.85, itemRarity: 0.4 },
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
      scalesWith: { packSize: 1.0, monsterEffectiveness: 0.7 },
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
      scalesWith: { packSize: 1.0, monsterEffectiveness: 0.65 },
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
      scalesWith: { itemRarity: 1.0, packSize: 0.35 },
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
      scalesWith: { monsterRarity: 1.0, packSize: 0.6 },
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
      scalesWith: { itemRarity: 1.0, packSize: 0.5 },
      blurb: "Pure rarity/quantity farming with no specific mechanic — generic Precursor Tablets (Rarity/Quantity/Pack) on max-reward waystones.",
      juiceNote: "Use generic Precursor Tablets. Stack Rarity first, then Quantity and Pack Size.",
      omenPicks: [
        { name: "Omen of Chaotic Rarity", why: "Pure loot-quality farming — convert the whole map to Rarity." },
      ],
    },
  ],

  // ── Masters of the Atlas (PoE2 0.5.x "Masters of the Atlas") ─────────────
  // Atlas-tree Ascendancy. You pick ONE master per map (free to swap before you
  // enter), and spend 4 points down a 12-node tree (4 rows × 3 choices) — so a
  // build is ONE node PER ROW. Masters are organized by GOAL — loot (Jado),
  // bossing/density (Hilda), survival/utility/targeting (Doryani) — NOT by
  // mechanic, so there is no "Abyss master" or "Ritual master": pick by your
  // STRATEGY + whether you're dying. Each node carries its `row` (1–4); the 4
  // `take:true` nodes are the recommended build (one per row). Node NAMES are
  // cross-verified vs poe2db + community (Jun 2026); exact %s approximate.
  // 0.5.2 (2026-06-12) tweaks folded in: Jado Partial Translations nerfed to a
  // random 0–40% (was 20% chance to double); Expedition & Ritual rewards buffed
  // (no direct Hilda/Doryani nerfs). Community consensus: Jado is the currency
  // default ("most never leave it"); Doryani for survivability/juice/citadel on
  // deep atlas; Hilda for boss/pinnacle fragment farming.
  mastersNote: "Pick by goal, not mechanic. One master per map (free swap), 4 points = one node per row. Verified vs poe2db + community (Jun 2026, incl. 0.5.2); exact %s approximate.",
  patchNote: "0.5.2 (2026-06-12): Jado 'Partial Translations' nerfed to random 0–40% tablet-mod effect (was 20% chance to double). Expedition (guaranteed Grand Expedition per ocean section) and Ritual (Mysterious Rites +10 omens) buffed. No direct Hilda/Doryani nerfs.",
  progression: "Community flow: start Doryani (revives cover gear gaps) → switch to Jado once you sustain red maps (most currency farmers stay here) → only swap to Hilda when you're specifically farming boss/pinnacle fragments.",
  masters: {
    jado: {
      name: "Jado", tree: "Spycraft", role: "Loot & profit engine", short: "Magic-find · currency", conf: "med",
      why: "The currency default (community: 'most never leave Jado') — Reliquary & Cryptic keys, unique strongboxes, exceptional items, boss uniques. No defence, so only when you already survive.",
      nodes: [
        { row: 1, name: "Trove Seekers", effect: "+100% Rare Chests; Strongboxes far likelier to be Unique", take: true },
        { row: 1, name: "In The Wrong Hands", effect: "Powerful Map Bosses drop an extra Unique (boss-heavy maps)" },
        { row: 1, name: "Unexpected Missions", effect: "Corrupted Waystones gain extra mods + Mortuary Map (corrupted runs)" },
        { row: 2, name: "Mysterious Gifts", effect: "Rare/Unique Strongbox monsters drop Cryptic Keys", take: true },
        { row: 2, name: "Unforeseen Threats", effect: "5% chance to reveal Anomaly Maps on completion" },
        { row: 3, name: "Stolen Relics", effect: "Unique Strongboxes can drop Twilight Reliquary Keys", take: true },
        { row: 3, name: "Partial Translations", effect: "Random 0–40% increased Tablet explicit-mod effect (0.5.2 nerf: was 20% chance to double)", conf: "low" },
        { row: 4, name: "Keen Appraisal", effect: "+50% Exceptional Items found", take: true },
        { row: 4, name: "Untold Histories", effect: "+Lineage Supports; Pinnacle Bosses tougher" },
      ],
    },
    hilda: {
      name: "Hilda", tree: "Hunting", role: "Bosses & density", short: "Bossing · mixed tablets", conf: "med",
      why: "Boss/density engine — upgrades & adds Map Bosses, scales unique monsters, and (Ancient Inscriptions) scales tablet effect PER tablet TYPE, so it uniquely rewards running DIFFERENT tablets.",
      nodes: [
        { row: 1, name: "Mighty Prey", effect: "25% chance to upgrade Map Bosses to Powerful Map Bosses", take: true },
        { row: 1, name: "Breeding Season", effect: "+15% Rare Monsters (raw density)" },
        { row: 2, name: "Soul Eaters", effect: "Map Bosses scale by monsters defeated in the map", take: true },
        { row: 2, name: "Will of the Draíocht", effect: "Azmeri Spirits cannot possess Rare monsters" },
        { row: 3, name: "Ancient Inscriptions", effect: "+Tablet explicit-mod effect for EACH tablet type (rewards mixed tablets)", take: true, conf: "low" },
        { row: 3, name: "Lethal Adaptation", effect: "+40% effectiveness of Unique monsters with modifiers" },
        { row: 4, name: "Patient Battue", effect: "Chance to replace Rare Monsters with random Map Bosses", take: true },
        { row: 4, name: "Gutting and Skinning", effect: "Pinnacle Bosses & Unique monsters drop additional items (pinnacle)" },
      ],
    },
    doryani: {
      name: "Doryani", tree: "Science", role: "Survival, utility & targeting", short: "Revives · citadel · juice", conf: "med",
      why: "Keeps you alive and adds juice/targeting: extra revive, irradiated maps, +waystone effect, Citadel reveal, Terraformers, expedition radius. Pure-safety value is wasted if you're not dying.",
      nodes: [
        { row: 1, name: "Stitch the Flesh", effect: "Maps gain an additional Revival", take: true },
        { row: 1, name: "Refined Formula", effect: "+150% Expedition Explosive Radius (expedition)", conf: "low" },
        { row: 2, name: "Improved Calibration", effect: "Waystone modifiers gain ~25% increased effect (more juice)", take: true, conf: "low" },
        { row: 2, name: "Disengaged Safeties", effect: "Maps become Irradiated — harder, more reward (juice if you survive)" },
        { row: 3, name: "Volatile Connection", effect: "15% chance areas are Cleansed or Corrupted", take: true },
        { row: 3, name: "Hidden Patterns", effect: "10% chance to unlock nearby maps (atlas traversal)" },
        { row: 4, name: "Head of the Snake", effect: "Pinnacle Bosses gain drops & revival, and REVEAL Citadels", take: true },
        { row: 4, name: "Remnants of Greatness", effect: "Map Bosses may guard a Precursor Terraformer" },
      ],
    },
  },

  // Control-bar selector options (the dashboard reads these).
  strategies: [
    { id: "profit", label: "Profit" },
    { id: "safe", label: "Safe" },
    { id: "corrupted", label: "Corrupted" },
    { id: "boss", label: "Boss / Citadel" },
    { id: "pinnacle", label: "Pinnacle" },
    { id: "strongbox", label: "Strongbox / Keys" },
  ],
  tabletMixes: [
    { id: "same", label: "Same content spam" },
    { id: "2plus1", label: "2 content + 1 irradiated" },
    { id: "3plus1", label: "3 content + 1 irradiated" },
    { id: "mixed", label: "Mixed tablet types" },
  ],

  // Dense situation → master table (the "Replace long cards with tables" ask).
  // `conf`: high = mechanically clear; med = sound inference from verified nodes.
  masterSituations: [
    { sit: "General rarity / currency farm", master: "Jado", nodes: "Trove Seekers, Keen Appraisal, In The Wrong Hands", when: "You clear comfortably and want raw loot", avoid: "You're dying — Jado has no defence", conf: "med" },
    { sit: "Strongbox / key / reliquary maps", master: "Jado", nodes: "Trove Seekers, Mysterious Gifts", when: "Chasing unique strongboxes / Cryptic & Reliquary keys", avoid: "—", conf: "med" },
    { sit: "Same-content tablet spam (+ irradiated)", master: "Jado", nodes: "Loot core + Partial Translations", when: "Profit-focused, surviving fine", avoid: "Running many DIFFERENT tablet types → Hilda", conf: "med" },
    { sit: "Mixed tablet types", master: "Hilda", nodes: "Ancient Inscriptions (+per type)", when: "You run 3+ different tablet types at once", avoid: "All one content (no per-type bonus)", conf: "med" },
    { sit: "Boss / powerful map bosses", master: "Hilda", nodes: "Mighty Prey, Patient Battue, Soul Eaters", when: "Farming map bosses for drops", avoid: "You die to upgraded bosses → Doryani", conf: "med" },
    { sit: "Citadel hunting", master: "Doryani", nodes: "Head of the Snake (reveals Citadels)", when: "Actively searching for Citadels", avoid: "—", conf: "med" },
    { sit: "Pinnacle bosses", master: "Hilda", nodes: "Gutting and Skinning", when: "Farming pinnacle drops & comfortable", avoid: "Need citadel reveal / revives → Doryani", conf: "med" },
    { sit: "Expedition", master: "Doryani", nodes: "Refined Formula (+explosive radius)", when: "Expedition-focused maps", avoid: "Pure density goal → Hilda also works", conf: "med" },
    { sit: "Corrupted maps", master: "Jado (value) / Doryani (if dying)", nodes: "Unexpected Missions / Stitch the Flesh", when: "Jado for extra mods+loot; Doryani only if you die", avoid: "Don't default Doryani just because it's corrupted", conf: "med" },
    { sit: "Deadly / can't survive", master: "Doryani", nodes: "Stitch the Flesh (+revive)", when: "You die, or run 0-revive 6-mods", avoid: "You're not dying — switch to a loot master", conf: "high" },
  ],
};

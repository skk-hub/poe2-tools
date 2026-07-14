# Product

## Register

product

## Users

Path of Exile 2 players, primarily during an active league session. They are mid-craft, sitting at the game client, wanting a fast answer: "how much does this route cost right now?" They know the game deeply. They don't need hand-holding. They need fast, dense, accurate information in a UI that doesn't insult the aesthetic of the game they're playing.

## Product Purpose

A self-hosted browser tool suite for PoE2 economy, crafting, and gearing decisions. Six tools under one hash-routed shell, served by a zero-dependency Node server:

- **Home** — currency strip + rolling economy chart (relative value vs. league start).
- **Crafter** — the flagship. Paste an item, get the cheapest route to the mods you want, costed in real divine, with the odds and the jam risk of the very next orb. Mod pools are offline (Path of Building data); routes are enumerated from the poe2-kb move catalog, never hand-written.
- **Gear Finder** — import a Path of Building build, rank trade candidates by real headless-PoB DPS/EHP gain.
- **Rune Picker** — paste reward choices, get them priced and ranked.
- **Regex Cheat Sheet** — a reactive builder for waystone/tablet stash regex, plus a mod-value table.
- **Filter Helper** — loot-filter linter: which currency does your filter hide?

Prices: **poe.ninja values via the EE2 proxy are the primary source**; GGG's Trade2 API supplies live buyable offers and is the fallback. Runs locally with no login; a POESESSID unlocks the build-weighted gear search.

## Brand Personality

Brutal, arcane, raw. The tool lives adjacent to a dark fantasy game about death, corruption, and power. It should feel like a cursed ledger pulled from a dungeon, not a startup dashboard. Heavy. Oppressive. Authoritative. No warmth. No softness.

## Anti-references

- Overwrought gamer UI: no neon RGB bleed, no hexagon grids, no lens flares, no "gaming peripheral" visual language
- Generic SaaS dashboard: no clean navy/teal, no light card grids, no startup sans-serif friendliness
- Flat Discord/Reddit dark: no personality-free dark gray with zero identity

## Design Principles

1. **The ledger, not the dashboard.** Information is dense, structured, and authoritative. Rows, columns, hierarchy — not airy card layouts with padding theater.
2. **Dark means dark.** Near-black backgrounds, not dark gray. The game runs at night. This tool runs beside it.
3. **Gold earns its place.** The gold accent (#c89b3c) is the single authoritative color. It marks cost totals, important labels, required actions. Not decoration.
4. **No chrome for chrome's sake.** If an element exists only for visual interest and carries no semantic weight, remove it.
5. **Speed over spectacle.** Motion only where it communicates state change. Prices loading, refresh completing. Nothing just to impress.

## Retired (do not rebuild without being asked)

Arbitrage Scanner, Jewel Pricer, Craft Pricer, the old Gear Search, the craft optimizer, and the character upgrade guide were all deliberately deleted. The recipe layer was deleted too: the corpus stores **methods**, the engine composes routes.

## Accessibility & Inclusion

Personal utility tool. Functional readability required (contrast that a tired player can parse at 2am), but strict WCAG compliance is not a goal. In practice the palette clears 4.5:1 on body text everywhere; keep it that way rather than trading it for elegance.

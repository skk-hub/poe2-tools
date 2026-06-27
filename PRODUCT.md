# Product

## Register

product

## Users

Path of Exile 2 players, primarily during an active league session. They are mid-craft, sitting at the game client, wanting a fast answer: "how much does this route cost right now?" They know the game deeply. They don't need hand-holding. They need fast, dense, accurate information in a UI that doesn't insult the aesthetic of the game they're playing.

## Product Purpose

A local browser tool suite for PoE2 economy/crafting decisions, all priced off **GGG's Trade2 API (poe.ninja is not used)**: live currency/economy prices, a Rune Picker (paste reward choices → ranked sell value), Gear Search (import gear → Trade2 candidate search), a Regex Cheat Sheet (waystone/tablet stash-regex + low-value "dump" filter), a Filter Helper (loot-filter hide linter), and a Gear Finder. Runs via a local Node.js server, no login needed. (The original craft-route cost tool is currently blanked/being reimagined.)

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

## Accessibility & Inclusion

Personal utility tool. Functional readability required (contrast that a tired player can parse at 2am), but strict WCAG compliance is not a goal.

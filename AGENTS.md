# poe-tools — project context

Read this first. Self-hosted Path of Exile 2 (PoE2) browser utility suite: pricing, crafting, rune/drop valuation, and an in-progress gear search. Local-first.
> [!session-end] Before ending a session: update the **Where we left off** section below — what changed, what's done vs open, the exact next step. If code changed, commit and push so AGENTS.md and the code stay in sync. This file is the next session's starting point; keep it current.


## Stack
- Zero-dependency Node.js — built-in http/fs/path/child_process only. No framework, no npm deps.
- Single server.js + standalone vanilla HTML/CSS/JS pages (index.html, character-upgrades.html, craft-optimizer.html).
- Run locally: node server.js -> http://127.0.0.1:17777.

## Deploy
- Repo: private GitHub skk-hub/poe-tools.
- Dev on Main PC at C:\Users\User\dev\poe2-craft-pricer-project (dir name differs from deployed name poe-tools).
- Flow: push from PC -> on Docker VM: git pull && docker compose up -d --build.
- Runs as container poe-tools on :17777. Access: LAN REDACTED-LAN-HOST:17777; Tailscale docker:17777.
- Monitor: Uptime Kuma HTTP check on /api/trade-status (no external calls).

## Data sources
- poe.ninja for prices (primary).
- GGG pathofexile.com/api/trade2 fallback — currently disabled (MAX_TRADE_FALLBACKS=0).

## Tools — status
- Main hub: working
- Craft pricer: working
- Rune picker: working
- Craft optimizer: experimental
- Character upgrade guide: being replaced by Gear Search

## In progress — Gear Search (replaces character-upgrades.html)
Approved scope:
- Free-form gear import -> slot-aware filters -> budget -> Trade2 query preview -> first 20 listings -> full current-vs-candidate stat comparison.
- Build the shared adaptive Trade2 queue FIRST (trade-queue.js), then build Gear Search on top.
- No result cache. Persistent safety state only.
- Out of scope for v1: OAuth, guide logic, scoring, multi-slot scans.

## Conventions
- Keep every tool dependency-free and local-first.
- ALL trade2 API calls go through the shared persistent adaptive queue. Never call trade2 directly.
- UI: dark, dense, PoE-themed.
- Primary author: Codex (on Main PC).

## Where we left off (update at end of each session)
- 2026-06-10: Implemented trade-queue.js shared persistent adaptive Trade2 queue and wired server.js Trade2 calls through it. /api/trade-status now includes queue metadata.
- 2026-06-10: Replaced character-upgrades.html with Gear Search v1: gear import, slot-aware editable filters, budget, query preview, first-20 listing fetch, and current-vs-candidate stat comparison. Added /api/gear-search/analyze, /api/gear-search/import-browser-export, and /api/gear-search/search.
- 2026-06-10: Updated index.html labels from Upgrade Finder to Gear Search. Dev server restarted and verified on http://127.0.0.1:17777.
- 2026-06-10: Added Gear Search total elemental resistance filter (`totalElementalRes`) using Trade2 pseudo stat `pseudo.pseudo_total_elemental_resistance`; chaos resistance remains a separate filter/stat.
- 2026-06-10: Audited Gear Search stat mappings across all slots. Added missing Trade2 mappings for evasion, energy shield, flat cold to attacks, projectile damage, and mana on kill. Gear Search now exposes only filterable stat keys, and preview returns `unsupportedFilters` instead of silently dropping unknown keys.
- 2026-06-10: Moved item equipment values to Trade2 `equipment_filters` instead of stat filters where appropriate: chest evasion uses `equipment_filters.filters.ev`, helmet energy shield uses `es`, and bow DPS uses `dps`. Keep explicit/stat filters only for affixes and pseudo stats.
- 2026-06-10: Added chest Deflection filter as Trade2 stat `explicit.stat_3040571529` (`#% increased Deflection Rating`). Gear Search price budget now uses Divine Orb (`trade_filters.price.option = "divine"`) instead of exalted.
- 2026-06-10: Tuned Gear Search default filters to use equipment filters first where appropriate: bow DPS, helmet energy shield, and chest evasion. Default filter serialization now preserves `key` values so equipment filters survive query preview/search.
- 2026-06-10: Changed Gear Search defaults to derive filter rows from the equipped item itself, default match mode to All filters, leave Min count blank, and remove the default Min ilvl control. Backend now no longer injects static slot fallback filters or ilvl constraints.
- 2026-06-10: Reworked Gear Search layout so Gear Import starts as a compact top rail and auto-collapses after Analyze/Load/Save, leaving only the reopen icon. Replaced the old equipped-slots panel with a Locked Loadout overview that aggregates projected stat changes across multiple locked listings and persists locks in localStorage.
- 2026-06-10: Extended Trade2 listings with slot and raw candidate stat payloads so the front end can lock multiple items, compare current-vs-candidate stats per item, and build a projected character overview from the combined locked loadout.
- 2026-06-11: Split Gear Search ring handling into distinct `Ring 1` and `Ring 2` slots. Imported browser-export text now preserves ring identity with synthetic slot labels, the slot selector exposes both rings, and locked/search comparisons can be made against either equipped ring independently.
- 2026-06-11: Replaced the default Gear Import body with a slot-by-slot import wizard for non-technical users. Each equipped slot has its own paste box, clipboard paste button, clear button, readiness state, and shared progress meter. Raw text / browser export import remains available under Advanced raw import.
- 2026-06-11: Added an Advanced raw import console helper at the top of Gear Import with an Open PoE2 Characters link (`https://pathofexile2.com/my-account/characters`), visible console snippet, and Copy Console Code button. The snippet now scans page JS state, scripts, and browser storage for item-like objects and copies a structured `poe2-console-export` JSON payload for pasting into Advanced raw import.
- Verification: `node --check server.js` passed. Restarted the local `server.js` process from this checkout, verified the empty state shows All filters with blank Min count and no Min ilvl, then imported a chest item and confirmed the default filters auto-filled with current values (`Evasion 900`, `Life 120`, `Total elemental resistance 67`, etc.) for the selected item. In Playwright, loaded `character-upgrades.html` with a cache-busting URL, confirmed Gear Import collapses after Load and leaves only the expand icon, searched Trade2 for a chest import, and locked a listing to verify the Locked Loadout overview and per-item unlock flow updated correctly.
- Verification: `node --check server.js` passed. Restarted `server.js`, loaded a two-ring sample in Playwright, confirmed the slot selector now exposes `Ring 1` and `Ring 2`, and switched between them to verify the default filters update to each ring's own stats (`Ring 1` life 50 / fire res 20 / cold res 20, `Ring 2` life 30 / fire res 15 / lightning res 35).
- Verification: `node --check server.js` passed. Restarted `server.js`, loaded `character-upgrades.html` in Playwright with a cache-busting URL, confirmed the import wizard renders all 10 paste slots, filled Ring 1/Ring 2 through the wizard, clicked Analyze Gear, confirmed the panel auto-collapsed, and verified Ring 1/Ring 2 default filters and query preview use each ring's own values.
- Verification: In Playwright, opened Advanced raw import and verified the console helper renders, the structured JSON-export snippet is populated, and the Copy Console Code button is present/clickable. Also POST-tested a representative `poe2-console-export` JSON payload against `/api/gear-search/import-browser-export` and confirmed it converted into copied item text with slot labels.
- Next: push the verified state, then continue Gear Search hardening with more imported item shapes and edge-case browser exports.


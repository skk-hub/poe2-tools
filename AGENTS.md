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
- Verification: `node --check server.js` passed. Restarted the stale local `server.js` process from this checkout, verified Gear Search in Playwright, and confirmed query preview shows `equipment_filters.filters.dps` for bow, `es` for helmet, and `ev` for chest. Live Trade2 chest search returned 61 total / 20 fetched listings through the shared queue with no console errors. Copied item text import parsed as chest and the second live search compared candidates against current values (`Life 120`, `Evasion 900`, `Total elemental resistance 67`) instead of zero baselines.
- Next: push the verified state if not already pushed, then continue Gear Search hardening with real player gear samples and edge-case copied-item/browser-export imports.


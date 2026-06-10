# poe-tools — project context

Read this first. Self-hosted Path of Exile 2 (PoE2) browser utility suite: pricing, crafting, rune/drop valuation, and an in-progress gear search. Local-first.

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
- 2026-06-09: Planning pass for Gear Search complete; scope approved (above). No code written this pass.
- Project moved from ~/poe2-craft-pricer-project to ~/dev/poe2-craft-pricer-project.
- Immediate next step: implement trade-queue.js (shared adaptive queue), THEN replace the old upgrade guide page with Gear Search per approved scope.
- Note: codex-optimizer-handoff.md is an older handoff, superseded by this section, safe to remove.

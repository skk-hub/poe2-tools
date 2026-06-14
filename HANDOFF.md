# Handoff — poe-tools (2026-06-14)

Scratch resume note. **Canonical context is `AGENTS.md`** (read it first); this is just "where we left off." Delete when stale.

## State
- Branch `main`, **clean and pushed**. HEAD = `0674bff`.
- Run: `node server.js` → http://127.0.0.1:17777 (fixed PORT 17777). Zero-dep Node (http/fs/path only). NOTE: `server.listen` is now guarded by `require.main === module`, and server.js exports `{fetchExchangeChunked, collectExchangeOffers, bestExchangeOffer, __setExchangeRawImpl}` so tests can require it without binding the port.
- Test: `node smoke-test.js` → **76/76** (static + HTTP + Playwright browser checks; browser checks auto-skip if Playwright/Chromium absent). Also `node backfill-test.js` (offline exchange-backfill determinism, run by smoke too).
- Recent commits (this session): `0674bff` exchange page-starvation backfill, `107cfe2` denser table polish, `235a890` self-host fonts (offline woff2), `3395332` arbitrage near-miss spreads, `3e61a0e` hub hero live Divine price, `bf0101e` currency strip 2-dec + div display, `7771273` widen currency list + drop dead `fetchCurrencyRates`.

## Architecture (1 line)
`index.html` = SHELL ONLY (head links + view markup + tiny hash router). Each tool = `<tool>.css` (prefix-scoped `.toolroot-<x>`) + `<tool>.js` (`window.__viewInit["<view>"]=fn`, lazy on first open). Tools: home (`home.js` currency strip), craft-pricer, rune-picker, gear-search, map-juicer, arbitrage. `waystone-data.js` = Map Juicer data. **All Trade2 calls go through the ONE shared queue `trade-queue.js` (`tradeQueue`).**

## What was just done (this session — 7 tasks, 75/75)
1. **Widened currency-rate list + deleted dead `fetchCurrencyRates`** — added Mirror / Transmutation / Augmentation / Fracturing Orb to `ARBITRAGE_ITEMS` as `category:"currency", enabled:false` (scanner-excluded via the `enabled` filter, but rate-included since `fetchExchangeData` ignores `enabled`), so Gear Search listings priced in those don't get dropped. transmute/aug/fracturing now price; mirror has no exalted-side exchange offer so it's skipped. Removed the unused poe.ninja `fetchCurrencyRates`.
2. **Currency strip formatting** (`home.js`) — `fmtEx` caps at **2 decimals**; any currency worth **>1 Divine** in exalts renders in **div** (e.g. Fracturing 1199ex → `7.99 div`).
3. **Hub hero live stat** — `#homePriceStatus` shows the live Divine price (`per Divine`, "· stale" when rate-limited) instead of static "Ready"; reuses the strip's fetch.
4. **Arbitrage near-miss spreads** — `scanArbitrage` returns `nearMiss` (top 3 non-qualifying spreads); `arbitrage.js` shows a "Closest spreads found" table in the empty state so a 0-opportunity result reads as a real scan.
5. **Self-hosted fonts** — theme.css `@import` (Google) → 3 `@font-face` rules on `/fonts/*.woff2` (latin-subset variable fonts, ~105KB in `fonts/`); added `.woff2→font/woff2` MIME. True offline.
6. **Denser table polish** — shared `.tablewrap` zebra `.018→.032` (was invisible), tighter padding, header hairline + gold left-accent bar on hover; gave gear-search `.projection-table`/`.comparison` the zebra+hover they lacked.
7. **Exchange page-starvation backfill** (`fetchExchangeChunked`) — re-fetches any zero-offer item alone (its own page) so a whale currency can't starve chunk-mates; bounded `EXCHANGE_BACKFILL_CAP=6`, burst-safe. Made server.js requireable + new `backfill-test.js` (9 offline assertions, in smoke).

## OPEN follow-ups
**Nothing queued.** The well-scoped backlog is done. What remains (AGENTS.md "Next" tail) needs user input, not autonomous work:
- **Map Juicer regex / new league mechanic** — needs in-game verification in a live 0.5 stash (paste a real waystone/tablet to validate `waystone-data.js` `tokens.line`).
- **Re-run the waystone price-floor sweep** — operational data refresh (Map Juicer "Refresh from market"), only worth it if the market moved since 2026-06-13.
- **Gear Search import hardening** — fully offline but open-ended; most useful given a real import/export that misbehaves.

## Known caveats / honest gaps
- **Regex tokens NOT verified in a live PoE2 stash** — sourced from the official forum guide (`view-thread/3858429`) + VULKK + poe2.re. If a 0.5 label differs, fix `waystone-data.js` `tokens.line`. UI says "verify in your stash."
- **Rune Picker still uses poe.ninja for NON-currency** items (runes/essences/soul cores/gems) — only the currency path moved to Trade2.
- **Arbitrage missing-side is often genuine market absence** — many cheap/thin currencies (Regal, Simulacrum Splinter) have NO exalted-pair exchange offer one side; the new starvation backfill can't manufacture offers that don't exist. Verified live at minStock 1 (9/11 covered).
- **Smoke test's `/api/currency/overview` httpCheck hits the real endpoint** → ~4 throttled Trade2 calls on a cold cache (cache-gated 10-min, queue-throttled). Not exhausting, but it's a live test call. Could mock it.
- **RATE LIMIT RULE (updated 2026-06-14):** careful, *spaced* live Trade2 test calls through the shared queue are FINE — the API returns its remaining call-limit when the window resets, so a measured pace won't exhaust it. Don't HAMMER/burst it (loops over many listings/slots is what blocked the IP before). Check `/api/trade-status` first; the queue self-throttles (~30s gap when tight).

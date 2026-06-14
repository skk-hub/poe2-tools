# Handoff — poe-tools (2026-06-14)

Scratch resume note. **Canonical context is `AGENTS.md`** (read it first); this is just "where we left off." Delete when stale.

## State
- Branch `main`, **clean and pushed**. HEAD = the currency-widen commit (advanced past `b5398b3` this session).
- Run: `node server.js` → http://127.0.0.1:17777 (fixed PORT 17777). Zero-dep Node (http/fs/path only).
- Test: `node smoke-test.js` → **69/69** (static + HTTP + Playwright browser checks; browser checks auto-skip if Playwright/Chromium absent).
- Recent commits: `b5398b3` unify currency→Trade2, `453a561` craft pricer + currency strip + regex, `216f465` rune CSS parity, `6f9537c`/`c9d3949` modularization.

## Architecture (1 line)
`index.html` = SHELL ONLY (head links + view markup + tiny hash router). Each tool = `<tool>.css` (prefix-scoped `.toolroot-<x>`) + `<tool>.js` (`window.__viewInit["<view>"]=fn`, lazy on first open). Tools: home (`home.js` currency strip), craft-pricer, rune-picker, gear-search, map-juicer, arbitrage. `waystone-data.js` = Map Juicer data. **All Trade2 calls go through the ONE shared queue `trade-queue.js` (`tradeQueue`).**

## What was just done (this session)
1. **Modularization finished** — index 1611→~590 lines, all 5 tools externalized; rune CSS extracted to `rune-picker.css` (full parity).
2. **Craft Pricer rebuilt** (`.toolroot-cp` + `craft-pricer.css`) — live `/api/prices` (poe.ninja material costs), per-route floor + with-optionals totals. IDs `#cp*`.
3. **Home currency strip** (`home.js` + `.fxstrip` CSS in index `<style>`) under the hero — real in-game currency **icons** + ex values, ↻ refresh.
4. **Map Juicer regex FIXED** — was broken (presence-substrings, no %, `!` outside quotes). Now **%-aware** colon-format per official forum guide: `"i.+ty: \+([6-9].|1..)%"` = Rarity ≥60%, adjustable Min-Rarity/Min-Pack selects, negation `"!…"` inside quotes. Tokens in `waystone-data.js` `tokens.line`/`tokens.revivesZero`.
5. **0-revives regex** — `"revives available: 0"` = fully-juiced 6-mod maps.
6. **Currency UNIFIED on Trade2** (poe.ninja dropped for currency): new `getExchangeData`/`getExchangeRates` in `server.js` derive ex-values for 9 currencies from the live Trade2 exchange (reuse `fetchExchangeChunked`+`bestExchangeOffer`), cached `.currency-rates.json` (10-min TTL, `?refresh=1` forces). Drop-in for old poe.ninja `fetchCurrencyRates`. Repointed home strip, Gear Search (×3), Rune Picker, Upgrades. Icons from Trade2 `data/static` (`arbitrageStaticCache.iconsById`). Rate = best offer stock≥5 (fallback any) to dodge thin-offer skew.

## OPEN follow-ups — DONE 2026-06-14
Both prior follow-ups are now complete (see AGENTS.md tail for detail):
1. ✅ **Widened currency coverage** — added Mirror / Transmutation / Augmentation / Fracturing Orb to `ARBITRAGE_ITEMS` as `category:"currency", enabled:false` (in the scanner-excluded but rate-included sweet spot). transmute/aug/fracturing now price; mirror has no exalted→mirror exchange offer (divine-denominated) so it's skipped gracefully.
2. ✅ **Deleted dead `fetchCurrencyRates`** — the unused poe.ninja currency fn is gone; no helper orphaned.

Nothing currently queued. Lower-priority ideas live in the AGENTS.md "Next" tail.

## Known caveats / honest gaps
- **Regex tokens NOT verified in a live PoE2 stash** — sourced from the official forum guide (`view-thread/3858429`) + VULKK + poe2.re. If a 0.5 label differs, fix `waystone-data.js` `tokens.line`. UI says "verify in your stash."
- **Rune Picker still uses poe.ninja for NON-currency** items (runes/essences/soul cores/gems) — only the currency path moved to Trade2.
- **Smoke test's `/api/currency/overview` httpCheck hits the real endpoint** → ~4 throttled Trade2 calls on a cold cache (cache-gated 10-min, queue-throttled). Not exhausting, but it's a live test call. Could mock it.
- **RATE LIMIT RULE (important):** never exhaust the shared Trade2 limit via test calls — check `/api/trade-status` first, prefer cache/mocks. The queue self-throttles (30s gap when tight).

## Other documented "Next" (AGENTS.md tail, lower priority)
Self-host fonts (woff2) for true offline; arbitrage chunk-starvation at cap 3; denser table polish; Gear Search import edge-cases; re-run waystone price-floor sweep each patch.

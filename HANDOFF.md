# Handoff — poe-tools (2026-06-15)

Scratch resume note. **Canonical context is `AGENTS.md`** (read it first); this is just "where we left off." Delete when stale.

## State
- Branch `main`, **clean and pushed**. HEAD = the "Rune fresh-prices button + currency skeleton" commit.
- Run: `node server.js` → http://127.0.0.1:17777 (PORT 17777). Zero-dep Node (http/fs/path/child_process only). `server.listen` is guarded by `require.main === module`; server.js exports `{fetchExchangeChunked, collectExchangeOffers, bestExchangeOffer, sanitizeLeague, buildExchangeCatalog, __setExchangeRawImpl}` so tests can require it without binding the port.
- Test: `node smoke-test.js` → **84/84**. Also `node backfill-test.js` → **16** offline asserts (exchange backfill + sanitizeLeague + buildExchangeCatalog); smoke runs it as one check.
- **Deploy (VM): `git pull && docker compose up -d --build`. The `--build` is MANDATORY** — the image bakes ALL files via `COPY . .` and there are no bind-mounts anymore, so without a rebuild the container serves stale assets (this caused a white/unstyled site earlier this session).

## Architecture (1 line)
`index.html` = SHELL ONLY (head links + view markup + tiny hash router). Each tool = `<tool>.css` (prefix-scoped `.toolroot-<x>`) + `<tool>.js` (`window.__viewInit["<view>"]=fn`, lazy on first open). Tools: home (`home.js` currency strip), craft-pricer (BLANKED placeholder), rune-picker, gear-search, map-juicer, arbitrage. `waystone-data.js` = Map Juicer data. **All Trade2 calls go through the ONE shared queue `trade-queue.js` (`tradeQueue`).**

## What was done this session (long; all pushed, 76/76)
1. Widen currency-rate list + delete dead `fetchCurrencyRates`; currency strip 2-dec + div display; hub hero live Divine price; arbitrage near-miss spreads; self-host fonts (offline woff2); denser table polish; arbitrage page-starvation backfill (`fetchExchangeChunked` re-fetches zero-offer items).
2. **Docker fix**: removed partial bind-mounts (they served a stale unstyled site); image is now single source of truth (`--build` mandatory).
3. **`sanitizeLeague`**: a `:8098` reverse proxy was appending its origin onto the `league` query value → `"Runes of Aldur" + "http://docker:8098"` → GGG HTTP 400 → empty rates. Now cut at embedded URLs / strip to league chars at all 6 GET `?league` handlers + `getExchangeData`/`scanArbitrage`. (The proxy itself still mangles query strings — user should fix it; it may corrupt other params.)
4. Currency strip stays visible + retryable when rates are unavailable (was hiding entirely → looked broken, also hid the ↻).
5. **Removed hallucinated "More Tools"** (coming-soon view, nav link, hero button, Farming Notes/Currency Watchlist/Craft Planner/Profit Notes cards). **Blanked Craft Pricer** to a `.rebuild-note` placeholder — user wants a full reimagining later (kept nav slot + `craft-pricer.js`/`.css`; CRAFTS data preserved, JS no-ops without its DOM).
6. **Rune Picker SPEED** (`0aa73c3`): currency pricing on Trade2 made `getExchangeData` BLOCK on the throttled queue whenever the 10-min cache was stale (30-90s, ≈ every check for a single user). Now **stale-while-revalidate** — stale cache served instantly + single-flight background refresh; only the home ↻ (force) and a true cold start wait. `warmExchange()` on a 2-min interval keeps it fresh. Verified: stale cache 4ms (was 30-90s).
7. **Rune Picker ACCURACY** (`3bb22c6`): poe.ninja's PoE2 coverage of runes/essences/soul cores is thin ("useless"). They're all on the Trade2 bulk exchange. Added a persistent **price book** `.rune-exchange-book.json` (gitignored) keyed by normalized name, filled lazily IN THE BACKGROUND from pasted items (`refreshRuneBook` → `fetchExchangeChunked`+`bestExchangeOffer`, single-flight). `buildExchangeCatalog` walks `data/static` into a normName→{id,name,category} map (on `arbitrageStaticCache.catalog`, 1h). **HYBRID precedence**: poe.ninja wins where it has a real price (finer for cheap sub-1ex runes; exchange is coarse there and flipped rankings in testing); the book fills ONLY poe.ninja's gaps (e.g. Soul Cores). Each result row carries a `source` (`poe.ninja` / `trade2 exchange`). Never blocks: first check = poe.ninja/instant, bg fills the book, next check = accurate.

## OPEN follow-ups
_(The two previously-queued user requests are DONE this session — see below. No queued tasks remain.)_

### DONE 2026-06-15 (both shipped, 84/84, live-verified)
1. **On-demand "Fetch fresh prices" button (Rune Picker).** `fetchRunePrices(text, league, forceFresh)` + `POST /api/rune-prices` reads `input.forceFresh`. Forced ⇒ `await refreshRuneBook(league, runePastedNorms(...), true)` (ALL pasted norms) + `getExchangeData(league, true)` BEFORE pricing, bounded by `RUNE_FRESH_DEADLINE_MS`=16s via `Promise.race`. `refreshRuneBook` is now a **promise-based single-flight** (`runeBookRefreshInFlight: Promise|null`): bg callers ride the in-flight one; a forced caller waits it out then runs its own pass. Front-end `#freshRunes` button (`rune-picker.js checkRunes(forceFresh)` + `.loading` spinner in `rune-picker.css`). Verified: forced check ~16s returned Soul Core priced `trade2 exchange` in-response (poe.ninja's gap), Desert Rune kept poe.ninja (hybrid); next default check 119ms.
2. **Currency strip loading skeleton.** `home.js` `showSkeleton()` reveals 6 `.fxchip.skel` shimmer chips + "Loading…" at the start of the first `load()` (forced ↻ keeps real chips). New `rendered` flag means a fetch THROW still hides the strip on static hosting despite skeleton chips. CSS `.fxchip.skel`/`.fxbar` + `@keyframes fxshimmer` (prefers-reduced-motion honored) in index `<style>`.

## Known caveats / honest gaps
- **Rune book is "accurate on 2nd check" by default** — first paste of a brand-new item shows poe.ninja (or NOT FOUND) while the bg fill runs (~30-90s); re-check shows Trade2. The **"Fetch fresh prices" button** (shipped 2026-06-15) is the on-demand fix: it blocks ~16s to fill the book + currency for the pasted items in one response. Book lives in the container (ephemeral; resets on `--build`, re-fills from usage).
- **Hybrid vs Trade2-everywhere knob**: to make the book win over poe.ninja everywhere, call `bookResultFor(norm,...)` BEFORE the poe.ninja branch in `fetchRunePrices`. Left as hybrid on purpose (rankings).
- **Map Juicer regex NOT verified in a live 0.5 stash** (forum-sourced). Paste a real waystone/tablet to validate `waystone-data.js` `tokens.line`.
- **Rune Picker still uses poe.ninja** for items it covers well (hybrid) — only gaps go to Trade2.
- **RATE LIMIT (clarified by user 2026-06-14):** careful, *spaced* live Trade2 calls through the shared queue are FINE — the API returns its remaining call-limit when the window resets. Don't HAMMER/burst it (loops over many listings/slots blocked the IP before). Check `/api/trade-status` first; queue self-throttles (~30s gap when tight).

## Other documented "Next" (AGENTS.md tail, lower priority)
Craft Pricer full reimagining (user wants greenfield; `craft-pricer.js` has old CRAFTS data for reference); Map Juicer league mechanic / re-run waystone sweep per patch; Gear Search import edge-cases; arbitrage chunk coverage is genuine-market-absence not starvation.

# Codex Handoff - PoE2 Craft Optimizer

Date: 2026-06-08

## Current State

- Existing `index.html` multi-tool hub was intentionally left untouched.
- Added standalone optimizer page:
  - `craft-optimizer.html`
  - URL: `http://127.0.0.1:17777/craft-optimizer.html`
- Added optimizer backend code in `server.js`:
  - `GET /api/optimizer/materials`
  - `GET /api/optimizer/opportunities`
  - `POST /api/optimizer/simulate`
- README was updated with optimizer usage notes.

## What The Optimizer Does

- V1 focuses on quiver targets.
- Fetches material prices from poe.ninja and normalizes them to exalted.
- Uses official trade2 searches for comparable rare quiver pricing.
- Runs seeded Monte Carlo/fixed-rate route estimates.
- Compares route cost vs comparable sale estimate.
- Shows only real opportunities by default; rejected rows can be shown with `show rejected`.

## Important Implementation Details

- `Greater Exalted Orb` route variants were added because `Perfect Exalted Orb` was ~222 ex while `Greater Exalted Orb` was ~6.6 ex during testing.
- Large prices in the UI now render as divines when over `1000 ex`.
- Strict `+2 Projectile` quiver searches returned zero listings in `Runes of Aldur` during testing.
- Fallback comparable searches use relaxed `+1 projectile` baselines, but fallback values are not treated as real target sale values.
- Minimum opportunity sale threshold is currently:
  - `MIN_TARGET_SALE_EX = 50`
- Comparable trade data cache:
  - `COMPARABLE_CACHE_MS = 5 * 60 * 1000`
  - In-memory only; restarting server clears it.
- While trade2 is rate-limited, optimizer exits early and does not call trade2 again.

## Known Issues / Weak Points

- Trade2 rate limits are easy to hit; current mitigation is early-exit + short-lived in-memory cache.
- Monte Carlo mod pool is a local approximation, not exact GGG mod weights.
- Current quiver targets may be too narrow or not the right market for this league.
- Strict `+2 projectile` trade stat search returned zero listings, so either:
  - market is empty,
  - stat encoding differs for the real valuable quiver mod,
  - or the target definition needs revision.
- Current route success rates are rough defaults:
  - some buy-fractured routes use `fixedSuccessRate`.
  - exact craft math still needs better game-specific modeling.

## Verification Done

- `node --check server.js` passed.
- Extracted inline JS from `craft-optimizer.html` and checked it with `node --check`; passed.
- Page served successfully at `/craft-optimizer.html`.
- During cooldown, `/api/optimizer/opportunities` returned in ~278ms, confirming it no longer hammers trade2 while limited.

## Best Next Steps

1. Stop treating broad quiver patterns as the main discovery method.
2. Identify 3-5 actually valuable finished-item markets from in-game/trade manually first.
3. For each market, create exact trade2 stat filters and verify listing counts.
4. Add persistent comparable cache on disk so restarting server does not lose cached trade results.
5. Add a one-target-at-a-time scan mode to reduce trade2 pressure.
6. Replace rough Monte Carlo weights with curated PoE2DB-derived mod tables or manual craft odds per route.

## Useful Files

- `server.js` - local server, price fetchers, trade2 helpers, optimizer endpoints.
- `craft-optimizer.html` - standalone optimizer UI.
- `.trade-status.json` - runtime trade2 cooldown state.
- `README.md` - current usage docs.

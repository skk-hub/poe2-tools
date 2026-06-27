# PoE Tools

Path of Exile 2 local pricing & utility suite — a single-page hub (`index.html`) with: live currency/economy prices (Home), a **Rune Picker** (paste reward choices → ranked sell value), **Gear Search** (import gear → Trade2 candidate search/compare), a **Regex Cheat Sheet** (waystone/tablet stash-regex builder + a low-value "dump" filter), an **Arbitrage** scanner (Currency Exchange ex-spread flips), and a **Filter Helper** (client-side loot-filter "what does my filter hide" linter). Runs as a local HTTP server with zero npm dependencies.

**All market data is GGG Trade2 only.** poe.ninja is not used anywhere (removed; do not reintroduce). Every Trade2 call goes through one shared, rate-limit-aware queue (`trade-queue.js`).

## No npm dependencies

Zero packages. Node built-ins only (`http`, `fs`, `path`, `child_process`). Nothing to install.

## Run locally

```
node server.js
```

Opens `http://localhost:17777` in your browser automatically. To suppress the auto-open:

```
POE2_NO_OPEN=1 node server.js
```

Everything is in the `index.html` hub, hash-routed (e.g. `#rune-picker`, `#gear-finder`). The old standalone pages (`arbitrage-scanner.html`, `waystone-juicer.html`, `character-upgrades.html`) are thin redirects into the hub. `craft-optimizer.html` is a separate experimental page, not surfaced in the hub nav.

## Run in Docker

```
docker compose up -d --build
```

Then open `http://<your-vm-ip>:17777` from any Tailscale peer.

To stop:

```
docker compose down
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` in the container so peers can reach it. |
| `PORT` | `17777` | Hardcoded in server.js; change there if needed. |
| `POE2_NO_OPEN` | unset | Set to any value to skip the auto-open browser call on start. |
| `POE_CONTACT` | `unset` | Included in the User-Agent header sent to pathofexile.com trade API. Set to your email or Discord handle. |
| `POE_CLIENT_ID` | unset | Registered Path of Exile OAuth client id. Required for character import. |
| `POE_CLIENT_SECRET` | unset | Optional OAuth client secret for confidential clients. Leave unset for a public PKCE client. |
| `POE_REDIRECT_URI` | `http://127.0.0.1:17777/api/oauth/callback` | Must exactly match the redirect URI registered with GGG. |

Edit `docker-compose.yml` to set `POE_CONTACT` before deploying.

## Port

`17777` — exposed in the container and mapped host-to-container in `docker-compose.yml`.

## Trade rate limits

The server makes live trade2 lookups (`pathofexile.com/api/trade2`) for the Rune Picker, Gear Finder, and the Regex Cheat Sheet's mod-value sweep. **Every call routes through one shared adaptive queue (`trade-queue.js`)** — it spaces calls (3s+ gap, adapts under load), parses the official `X-Rate-Limit-*` headers, and honors `Retry-After` on `429`. While a cooldown is active, endpoints return the timer instead of probing again. The public IP is **shared** with prod + real users, so the queue budgets conservatively — see `RATE-LIMITS.md` before any Trade2 work.

## Character OAuth import

The upgrade finder can import PoE2 equipment through the official account character API. GGG requires a registered OAuth app with the `account:characters` scope. Register a public local client using:

```
http://127.0.0.1:17777/api/oauth/callback
```

Then start the server with `POE_CLIENT_ID` set. Access tokens are stored locally in `.poe-oauth.json`, which should not be committed.

## Craft optimizer

The optimizer endpoints are:

```
GET  /api/optimizer/materials?league=Runes%20of%20Aldur
GET  /api/optimizer/opportunities?league=Runes%20of%20Aldur&family=quiver&iterations=10000
POST /api/optimizer/simulate
```

V1 focuses on quivers. It combines live material prices, targeted trade2 comparable searches, and seeded Monte Carlo route estimates. The mod pool is a local PoE2DB-derived approximation with conservative confidence labels, not exact server-side GGG mod weights.

# PoE Tools

Path of Exile 2 pricing utility. Fetches live poe.ninja economy data for crafting material costs across six defined routes, plus a rune/reward picker. Also includes a standalone craft optimizer page for quiver market scans and Monte Carlo route estimates. Runs as a local HTTP server with no external dependencies.

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

Standalone optimizer page:

```
http://127.0.0.1:17777/craft-optimizer.html
```

Standalone character upgrade page:

```
http://127.0.0.1:17777/character-upgrades.html
```

The existing `index.html` multi-tool hub is not changed by the optimizer page.

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

The server makes live trade2 lookups (`pathofexile.com/api/trade2`) for the Rune Picker, craft optimizer, and character upgrade finder. These calls share a single rate-limit bucket across all users hitting the container. The server parses the official `X-Rate-Limit-*` headers on every trade response and honors `Retry-After` on `429`. While a cooldown is active, trade endpoints return the timer instead of probing again.

The character upgrade finder searches one slot at a time and caches slot search results for 20 minutes to avoid spending trade requests on UI refreshes.

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

# PoE Tools

Path of Exile 2 pricing utility. Fetches live poe.ninja economy data for crafting material costs across six defined routes, plus a rune/reward picker. Runs as a local HTTP server with no external dependencies.

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

Edit `docker-compose.yml` to set `POE_CONTACT` before deploying.

## Port

`17777` — exposed in the container and mapped host-to-container in `docker-compose.yml`.

## Trade rate limits

The server makes live trade2 lookups (`pathofexile.com/api/trade2`) for the Rune Picker when poe.ninja has no match or low volume. These calls share a single rate-limit bucket across all users hitting the container. poe.ninja prices are fetched fresh per request and are not rate-limited this way. Live-trade lookups are best-effort: if the shared bucket is exhausted, affected rows show a notice and poe.ninja prices are still returned normally.

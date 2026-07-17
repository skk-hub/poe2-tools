# PoE Tools

Path of Exile 2 local pricing & utility suite — a single-page hub (`index.html`) with: live currency/economy prices (Home), a **Rune Picker** (paste reward choices → ranked sell value), a **Regex Cheat Sheet** (waystone/tablet stash-regex builder + a low-value "dump" filter), a **Filter Helper** (client-side loot-filter "what does my filter hide" linter), a **Gear Finder** (import gear → Trade2 candidate search/compare, optionally PoB-weighted), and a **Crafter** (mod-pool browser + craft probability/cost). Runs as a local HTTP server with zero npm dependencies.

**Market data sources:** the PRIMARY price source is poe.ninja data served through Exiled Exchange 2's proxy (`api.exiledexchange2.dev`, configurable via `EE2_PROXY_BASE`) — direct poe.ninja fetches are Cloudflare-blocked server-side, so don't bypass the proxy. Live GGG Trade2 lookups supplement it for item-level searches; every Trade2 call goes through one shared, rate-limit-aware queue (`trade-queue.js`).

## No npm dependencies

Zero packages. Node built-ins only (`http`, `fs`, `path`, `child_process`). Nothing to install.

## Run locally

```
node server.js
```

Serves `http://localhost:17777`. Opening the browser automatically is **opt-in** — set `POE2_OPEN=1`:

```powershell
$env:POE2_OPEN = "1"; node server.js
```

Everything is in the `index.html` hub, hash-routed (`#rune-picker`, `#map-juicer`, `#filter-helper`, `#gear-finder`, `#craft`). The only other page is `waystone-juicer.html`, a thin redirect into the hub.

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
| `POE2_OPEN` | unset | Set to `1` to auto-open the browser on start (default is quiet). |
| `POE_CONTACT` | unset | Included in the User-Agent header sent to pathofexile.com trade API. Set to your email or Discord handle. |
| `EE2_PROXY_BASE` | `https://api.exiledexchange2.dev/proxy` | Base URL of the EE2 poe.ninja proxy (primary price source). |
| `POE_AUTH_TOKEN` | unset | Optional shared-secret gate for API requests when `HOST` is non-local. |
| `DATA_DIR` | repo dir | Where runtime state files (`.trade-status.json` etc.) live; a mounted volume in Docker. |
| `GLUETUN_URL` | `http://127.0.0.1:8000` | Gluetun VPN control-server URL (Docker VPN setup). |
| `POB_BRIDGE_URL` | unset | URL of `pob-agent.js` on the PC with Path of Building (enables build-weighted gear ranking). |
| `POESESSID` | unset | Optional pathofexile.com session cookie for the build-weighted trade sort. |

See `.env.example` for the Docker-side values; edit `docker-compose.yml` to set `POE_CONTACT` before deploying.

## Port

`17777` — exposed in the container and mapped host-to-container in `docker-compose.yml`.

## API routes

Server endpoints are grouped under: `/api/currency`, `/api/economy`, `/api/rune-prices`, `/api/trade-price`, `/api/gear/*`, `/api/craft/*`, `/api/waystone/*`, `/api/vpn`, `/api/session`, `/api/ocr`, `/api/trade-status` (lightweight health check).

## Trade rate limits

The server makes live trade2 lookups (`pathofexile.com/api/trade2`) for the Rune Picker, Gear Finder, and the Regex Cheat Sheet's mod-value sweep. **Every call routes through one shared adaptive queue (`trade-queue.js`)** — it spaces calls (3s+ gap, adapts under load), parses the official `X-Rate-Limit-*` headers, and honors `Retry-After` on `429`. While a cooldown is active, endpoints return the timer instead of probing again. The egress IP is **shared among this app's own instances and users** (the deployed server, a dev instance, and anyone browsing it spend one budget — that is what the VPN egress isolates from the operator's game client), so the queue budgets conservatively, at half the advertised cap — see `RATE-LIMITS.md` before any Trade2 work.

## Scope & constraints

This is a personal, read-only market tool. Its operating constraints, stated plainly because the code should match them:

- **All Trade2 traffic goes through one shared, adaptive, header-respecting queue** (`trade-queue.js`, rules in `RATE-LIMITS.md`) that deliberately budgets *half* of GGG's advertised cap. No parallel fetch pools, no limit multiplication.
- **The VPN egress (gluetun sidecar in `docker-compose.yml`) exists to separate this server's API traffic from the home connection a game client plays on** — one egress at a time, same single queue behind it. The exit-country control (`gluetun-auth.toml`, local-only inside the network namespace) is a manual switch, not rotation automation; there is no IP rotation, no ban evasion, no multi-identity fetching.
- **No game-client automation.** The tool reads (OCR of on-screen reward lists, clipboard item text) and never sends input to the game.
- `POESESSID` support is optional, off by default, and only used for the build-weighted trade sort on your own account.

## How this was built

Solo project, pair-programmed with Claude Code — the commit history carries the co-author trailers, and the dense commit notes are the actual design log. The division of labor: architecture, priorities, and verification are mine; the implementation is AI-generated and verified against real behavior (tests, live probes, known market values) before it ships.

One example of why the human stays load-bearing: the 2026-06-21 currency-pricing investigation (see that commit's notes). The AI-built order-book estimator priced illiquid currencies wrong by 14-300x while looking perfectly plausible; I caught it against known market values, we proved *no* order-book estimator reproduces GGG's traded ratios, and the fix became a deliberately scoped two-sided geometric-mid band-aid for exactly three currencies plus a plan to move to GGG's official cxapi. The model writes code fast; deciding what's *true* is still my job.

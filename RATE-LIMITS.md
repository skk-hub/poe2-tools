# DON'T RATE-LIMIT YOURSELF — read before ANY Trade2 work

Tripping the GGG rate limit wastes ~9 minutes every time and the user keeps hitting
it across sessions. It is almost never "one call too fast" — it's **burst** + **shared
IP** + **trusting a stale pre-check**. Follow this. No exceptions.

## The one fact that explains every trip
The public IP is **SHARED**: the live prod app (`warmExchange` every ~2 min) + real
LAN/Tailscale users + your dev box all spend the SAME GGG budget. The binding cap is
roughly **30 searches / 5 min (~1 per 10s sustained)**. So your *own* queue can read
`9/30` and you STILL get a 429 — because prod ate the rest. **Budget yourself HALF the
cap, at most.** Assume someone else is always using it too.

## Rules (in priority order)
1. **Everything through `trade-queue.js`.** Never raw-`curl`/`Invoke-RestMethod` to
   `pathofexile.com` — that includes `data/filters`, `data/items`, `data/stats` (also
   limited, also no pre-warning). Raw calls bypass the 3s spacing AND don't record the
   block in `.trade-status.json`, so the queue can't even see the trip. Hit your OWN
   localhost endpoints (they route through the queue) — that's fine.
2. **Check `/api/trade-status` first. If `limited`, STOP.** Wait the FULL
   `secondsRemaining`. Do **not** retry in a loop — each poke can extend the window.
3. **The pre-check is a snapshot, not a promise.** `limited:false` at the START does
   NOT mean a multi-call sequence will finish — it can trip mid-way (this is the most
   common failure). So:
   - **Minimize call COUNT, not just spacing.** A tool action = a *handful* of calls,
     never dozens. Cap every loop. Stop early once you have what you need.
   - **Never stack bursts in one request:** don't force a book/price refresh AND fetch
     N chunks AND fill a cache all at once. Prefer the cached/gentle path; show
     "pricing…" / "pending" and let a SECOND click fill the rest.
   - **Wrap multi-call sequences in try/catch** and return what you collected on a
     mid-sequence 429 — don't throw the whole thing away (and don't auto-retry).
4. **One call at a time, spaced.** The queue enforces a 3s min gap and adapts up to 30s
   under load — let it. Never fire parallel calls "just to look something up."
5. **If you trip: wait the whole ~9 min.** Don't babysit it with repeated status pokes.
   Schedule a wakeup past the window and come back once.

## Bulk sweeps (waystone/tablet price floors, etc.)
- **Do NOT sweep from the dev box while prod is live** — there's no headroom to reserve.
- Sweep only when prod is quiet, in **tiny spaced batches**, or run it **on the prod
  server** through its own queue.
- One-off probe? A single throwaway node script using `createTradeQueue`
  (`statusFile: ".trade-status.json"`), **sequential** `q.request` calls, deleted after.
  Never parallel, never raw.

## The real fix (someday, retires all the hacks)
Give the shared queue a true **sliding-window limiter** (≤5/10s, ≤15/60s, ≤30/300s) so
NO tool combo can trip it. Moot once GGG `service:cxapi` lands (volume + all prices in
one call). Until then: the rules above.

const fs = require("fs");
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MIN_GAP_MS = 3000;

function createTradeQueue(options = {}) {
  const statusFile = options.statusFile;
  const headers = options.headers || {};
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const baseMinGapMs = Number(options.minGapMs) || DEFAULT_MIN_GAP_MS;
  // Record/replay so the tool can be developed + tested with ZERO live GGG calls
  // (the legit fix for "testing keeps tripping the limit" — no IP evasion). RECORD
  // saves each real response keyed by method+path+body; REPLAY serves it back and
  // never touches the network or the rate-limit budget. A replay miss throws (so a
  // missing fixture is obvious, never a silent live call).
  const recordMode = !!options.record;
  const replayMode = !!options.replay;
  const fixtureFile = options.fixtureFile || null;
  let fixturesCache = null;

  let blockedUntil = 0;
  let rateLimitState = {};
  let queue = Promise.resolve();
  let lastCall = 0;
  let active = 0;
  let queued = 0;
  let adaptiveMinGapMs = baseMinGapMs;

  function loadStatus() {
    try {
      const data = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      blockedUntil = Number(data.tradeBlockedUntil) || 0;
      rateLimitState = data.tradeRateLimitState && typeof data.tradeRateLimitState === "object" ? data.tradeRateLimitState : {};
      adaptiveMinGapMs = Math.max(baseMinGapMs, Number(data.adaptiveMinGapMs) || 0);
    } catch {
      blockedUntil = 0;
      rateLimitState = {};
      adaptiveMinGapMs = baseMinGapMs;
    }
  }

  function saveStatus() {
    if (!statusFile) return;
    try {
      fs.writeFileSync(statusFile, JSON.stringify({
        tradeBlockedUntil: blockedUntil,
        tradeRateLimitState: rateLimitState,
        adaptiveMinGapMs,
      }, null, 2));
    } catch {
      // A failed safety-state write should not break local tools.
    }
  }

  function parseRateParts(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim().split(":").map((n) => Number(n)))
      .filter((part) => part.length >= 3 && part.every((n) => Number.isFinite(n)));
  }

  // Pace like a well-behaved in-game overlay: burst while a rule's budget is fresh,
  // then settle to the steady rate that fits its window, so we APPROACH but never CROSS
  // a limit — and so never eat the long (30-min) ban. The old logic only widened the
  // gap reactively at ≥75% used AND capped it at 30s, which for the [30,300s] rule
  // (needs ≥10s/call sustained) blew through the budget early and tripped the 30-min
  // ban (a big tab read = "1h for 9 items"). For EACH GGG rule [limit, interval]:
  //   • sustained (≥50% used): hold gap = interval/limit (+12% headroom) — the exact
  //     rate that fills the window, the rate an overlay settles into.
  //   • at the edge (≤2 left): brake harder, spreading what's left over the window.
  // Take the max across rules. Bursts stay fast for small ops (a few calls never reach
  // 50%), big runs auto-throttle to the sustainable pace. Cap a single wait at 120s so
  // a worst case is a 2-min pause, never a hang; the UI's post-ban auto-wait is the
  // backstop for the rare trip that still slips through.
  function tuneGap(limitParts, stateParts) {
    let nextGap = baseMinGapMs;
    for (let i = 0; i < Math.min(limitParts.length, stateParts.length); i++) {
      const [limit, intervalSeconds] = limitParts[i];
      const [used, , activeTimeout] = stateParts[i];
      if (activeTimeout > 0) continue;
      if (!(limit > 0) || !(intervalSeconds > 0) || !(used >= 0)) continue;
      const intervalMs = intervalSeconds * 1000;
      if (used >= limit * 0.5) {
        nextGap = Math.max(nextGap, Math.ceil((intervalMs / limit) * 1.12));
      }
      const remaining = limit - used;
      if (remaining <= 2) {
        nextGap = Math.max(nextGap, Math.ceil(intervalMs / Math.max(1, remaining)));
      }
    }
    adaptiveMinGapMs = Math.max(baseMinGapMs, Math.min(nextGap, 120000));
  }

  function updateLimitFromHeaders(responseHeaders) {
    const policy = String(responseHeaders.get("x-rate-limit-policy") || "");
    const rules = String(responseHeaders.get("x-rate-limit-rules") || "")
      .split(",")
      .map((rule) => rule.trim())
      .filter(Boolean);
    const nextState = { policy, rules: {}, updated: new Date().toISOString() };
    let changed = Boolean(policy || rules.length);

    for (const rule of rules) {
      const limitParts = parseRateParts(responseHeaders.get("x-rate-limit-" + rule));
      const stateParts = parseRateParts(responseHeaders.get("x-rate-limit-" + rule + "-state"));
      nextState.rules[rule] = { limits: limitParts, states: stateParts };
      tuneGap(limitParts, stateParts);

      for (let i = 0; i < Math.min(limitParts.length, stateParts.length); i++) {
        const [, , activeTimeout] = stateParts[i];
        if (activeTimeout > 0) {
          blockedUntil = Math.max(blockedUntil, Date.now() + activeTimeout * 1000);
          changed = true;
        }
      }
    }

    if (changed) {
      rateLimitState = nextState;
      saveStatus();
    }
  }

  function status() {
    const now = Date.now();
    // Offline replay never touches GGG, so it's never rate-limited — report clear so
    // endpoints proceed to fetch (and hit fixtures) instead of short-circuiting.
    if (replayMode) {
      return { limited: false, tradeLimitedUntil: "", secondsRemaining: 0, rateLimit: {}, replay: true, queue: { active, queued, minGapMs: 0, lastCall: "" } };
    }
    if (blockedUntil && now >= blockedUntil) {
      blockedUntil = 0;
      saveStatus();
    }
    return {
      limited: now < blockedUntil,
      tradeLimitedUntil: now < blockedUntil ? new Date(blockedUntil).toISOString() : "",
      secondsRemaining: now < blockedUntil ? Math.ceil((blockedUntil - now) / 1000) : 0,
      rateLimit: rateLimitState,
      queue: {
        active,
        queued,
        minGapMs: adaptiveMinGapMs,
        lastCall: lastCall ? new Date(lastCall).toISOString() : "",
      },
    };
  }

  async function fetchWithTimeout(url, requestOptions = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...requestOptions, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitThrottle() {
    const elapsed = Date.now() - lastCall;
    if (elapsed < adaptiveMinGapMs) {
      await new Promise((resolve) => setTimeout(resolve, adaptiveMinGapMs - elapsed));
    }
    lastCall = Date.now();
  }

  function enqueue(task) {
    queued++;
    const run = queue.then(async () => {
      queued--;
      active++;
      try {
        return await task();
      } finally {
        active--;
      }
    }, async () => {
      queued--;
      active++;
      try {
        return await task();
      } finally {
        active--;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function loadFixtures() {
    if (fixturesCache) return fixturesCache;
    try { fixturesCache = JSON.parse(fs.readFileSync(fixtureFile, "utf8")); }
    catch { fixturesCache = {}; }
    return fixturesCache;
  }
  // Key a request by what determines its response: method + path/query + body.
  // (Host is stripped; the search `id` lives in the recorded search RESPONSE, so a
  // replayed search yields the same ids → the follow-up fetch URL matches too.)
  function fixtureKey(url, opts) {
    const method = (opts.method || "GET").toUpperCase();
    const pathQ = String(url).replace(/^https?:\/\/[^/]+/i, "");
    return crypto.createHash("sha1").update(method + " " + pathQ + " " + (opts.body || "")).digest("hex").slice(0, 16);
  }
  function saveFixture(url, opts, json) {
    if (!fixtureFile) return;
    const fx = loadFixtures();
    fx[fixtureKey(url, opts)] = {
      method: (opts.method || "GET").toUpperCase(),
      path: String(url).replace(/^https?:\/\/[^/]+/i, ""),
      response: json,
    };
    try { fs.writeFileSync(fixtureFile, JSON.stringify(fx, null, 1)); } catch {}
  }

  async function request(url, requestOptions = {}) {
    if (replayMode) {
      const fx = loadFixtures();
      const key = fixtureKey(url, requestOptions);
      if (Object.prototype.hasOwnProperty.call(fx, key)) return JSON.parse(JSON.stringify(fx[key].response));
      throw new Error("offline replay: no fixture for " + (requestOptions.method || "GET") + " " + url + " — run with POE_RECORD=1 once to capture it");
    }
    return enqueue(async () => {
      const current = status();
      if (current.limited) {
        throw new Error("trade2 rate limited until " + current.tradeLimitedUntil);
      }

      await waitThrottle();
      const response = await fetchWithTimeout(url, {
        ...requestOptions,
        headers: { ...headers, ...(requestOptions.headers || {}) },
      });
      updateLimitFromHeaders(response.headers);

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || status().secondsRemaining || 60;
        blockedUntil = Math.max(blockedUntil, Date.now() + retryAfter * 1000);
        saveStatus();
        throw new Error("trade2 rate limited until " + new Date(blockedUntil).toISOString());
      }

      if (!response.ok) {
        let detail = "";
        try {
          detail = await response.text();
        } catch {
          detail = "";
        }
        throw new Error("trade2 returned HTTP " + response.status + (detail ? ": " + detail.slice(0, 500) : ""));
      }

      const json = await response.json();
      if (recordMode) saveFixture(url, requestOptions, json);
      return json;
    });
  }

  loadStatus();

  return {
    request,
    status,
    loadStatus,
  };
}

module.exports = { createTradeQueue };

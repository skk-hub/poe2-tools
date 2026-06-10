const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MIN_GAP_MS = 3000;

function createTradeQueue(options = {}) {
  const statusFile = options.statusFile;
  const headers = options.headers || {};
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const baseMinGapMs = Number(options.minGapMs) || DEFAULT_MIN_GAP_MS;

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

  function tuneGap(limitParts, stateParts) {
    let nextGap = baseMinGapMs;
    for (let i = 0; i < Math.min(limitParts.length, stateParts.length); i++) {
      const [limit, intervalSeconds] = limitParts[i];
      const [used, , activeTimeout] = stateParts[i];
      if (activeTimeout > 0) continue;
      if (!(limit > 0) || !(intervalSeconds > 0) || !(used >= 0)) continue;

      const remaining = Math.max(1, limit - used);
      const ratio = used / limit;
      if (remaining <= 2 || ratio >= 0.75) {
        nextGap = Math.max(nextGap, Math.ceil((intervalSeconds * 1000) / remaining));
      }
    }
    adaptiveMinGapMs = Math.max(baseMinGapMs, Math.min(nextGap, 30000));
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

  async function request(url, requestOptions = {}) {
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

      return response.json();
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

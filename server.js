const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = 17777;
const ROOT = __dirname;
const TRADE_STATUS_FILE = path.join(ROOT, ".trade-status.json");
const TYPES = ["Currency", "Essences", "Ritual", "Abyss", "Breach"];
const RUNE_CATEGORIES = [
  { type: "Currency", slug: "currency" },
  { type: "Fragments", slug: "fragments" },
  { type: "Abyssal Bones", slug: "abyssal-bones" },
  { type: "UncutGems", slug: "uncut-gems" },
  { type: "Essences", slug: "essences" },
  { type: "Soul Cores", slug: "soul-cores" },
  { type: "Idols", slug: "idols" },
  { type: "Runes", slug: "runes" },
  { type: "Omens", slug: "omens" },
  { type: "Expedition", slug: "expedition" },
  { type: "Liquid Emotions", slug: "liquid-emotions" },
  { type: "Breach Catalysts", slug: "breach-catalysts" },
  { type: "Catalysts", slug: "breach-catalysts" },
  { type: "Verisium", slug: "verisium" },
];
const MIN_NINJA_VOLUME = 10;
const TRADE_MIN_GAP_MS = 3000;
const TRADE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "poe-tools-local/0.1 (contact: " + (process.env.POE_CONTACT || "unset") + ")",
};
const NINJA_TIMEOUT_MS = 12000;
const TRADE_TIMEOUT_MS = 3500;
const MAX_RUNE_LINES = 30;
const MAX_TRADE_FALLBACKS = 0;
const MAX_SKILL_TRADE_FALLBACKS = 1;
let lastTradeCall = 0;
let tradeBlockedUntil = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function loadTradeStatus() {
  try {
    const data = JSON.parse(fs.readFileSync(TRADE_STATUS_FILE, "utf8"));
    tradeBlockedUntil = Number(data.tradeBlockedUntil) || 0;
  } catch {
    tradeBlockedUntil = 0;
  }
}

function saveTradeStatus() {
  try {
    fs.writeFileSync(TRADE_STATUS_FILE, JSON.stringify({ tradeBlockedUntil }, null, 2));
  } catch {
    // A failed cache write should not break pricing.
  }
}

function parseRateParts(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(":").map((n) => Number(n)))
    .filter((part) => part.length >= 3 && part.every((n) => Number.isFinite(n)));
}

function updateTradeLimitFromHeaders(headers) {
  const rules = String(headers.get("x-rate-limit-rules") || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  let changed = false;

  for (const rule of rules) {
    const limitParts = parseRateParts(headers.get("x-rate-limit-" + rule));
    const stateParts = parseRateParts(headers.get("x-rate-limit-" + rule + "-state"));

    for (let i = 0; i < Math.min(limitParts.length, stateParts.length); i++) {
      const [maxHits, periodSeconds] = limitParts[i];
      const [currentHits, , activeTimeout] = stateParts[i];

      if (activeTimeout > 0) {
        tradeBlockedUntil = Math.max(tradeBlockedUntil, Date.now() + activeTimeout * 1000);
        changed = true;
      } else if (currentHits >= maxHits - 1) {
        tradeBlockedUntil = Math.max(tradeBlockedUntil, Date.now() + periodSeconds * 1000);
        changed = true;
      }
    }
  }

  if (changed) saveTradeStatus();
}

function tradeStatus() {
  const now = Date.now();
  if (tradeBlockedUntil && now >= tradeBlockedUntil) {
    tradeBlockedUntil = 0;
    saveTradeStatus();
  }
  return {
    limited: now < tradeBlockedUntil,
    tradeLimitedUntil: now < tradeBlockedUntil ? new Date(tradeBlockedUntil).toISOString() : "",
    secondsRemaining: now < tradeBlockedUntil ? Math.ceil((tradeBlockedUntil - now) / 1000) : 0,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundPriceExalted(value) {
  if (value >= 1) return Math.round(value * 100) / 100;
  if (value >= 0.01) return Math.round(value * 10000) / 10000;
  return Math.round(value * 1000000) / 1000000;
}

function stripQuantity(value) {
  const match = String(value).trim().match(/^([0-9Il|l]+)\s*x\s+(.+)$/i);
  if (!match) return { qty: 1, text: String(value).trim() };
  return {
    qty: Number(match[1].replace(/[Il|l]/g, "1")) || 1,
    text: match[2].trim(),
  };
}

function getLineVolume(line) {
  for (const key of ["volume", "count", "totalVolume", "accepted", "listingCount", "dataPointCount"]) {
    const value = Number(line && line[key]);
    if (Number.isFinite(value)) return value;
  }
  return -1;
}

function getDisplayPriceExalted(line, currencyRates) {
  const rate = Number(line && line.maxVolumeRate);
  if (rate) {
    const amount = 1 / rate;
    const currency = String(line.maxVolumeCurrency || "");
    if (currency === "exalted") return roundPriceExalted(amount);
    if (currencyRates[currency]) return roundPriceExalted(amount * currencyRates[currency]);
  }
  const primaryValue = Number(line && line.primaryValue);
  if (primaryValue > 0 && currencyRates.divine) {
    return roundPriceExalted(primaryValue * currencyRates.divine);
  }
  return 0;
}

async function waitTradeThrottle() {
  const elapsed = Date.now() - lastTradeCall;
  if (elapsed < TRADE_MIN_GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, TRADE_MIN_GAP_MS - elapsed));
  }
  lastTradeCall = Date.now();
}

async function fetchTrade(url, options = {}) {
  if (Date.now() < tradeBlockedUntil) {
    throw new Error("trade2 rate limited");
  }
  const response = await fetchWithTimeout(url, { ...options, headers: { ...TRADE_HEADERS, ...(options.headers || {}) } }, TRADE_TIMEOUT_MS);
  updateTradeLimitFromHeaders(response.headers);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after")) || 60;
    tradeBlockedUntil = Date.now() + retryAfter * 1000;
    saveTradeStatus();
    throw new Error("trade2 rate limited until " + new Date(tradeBlockedUntil).toISOString());
  }
  if (!response.ok) throw new Error("trade2 returned HTTP " + response.status);
  return response.json();
}

async function getTradePrice(name, league, currencyRates, deadline = 0) {
  try {
    if (deadline && Date.now() > deadline) return null;
    const body = JSON.stringify({
      query: {
        type: name,
        stats: [{ type: "and", filters: [] }],
        status: { option: "any" },
      },
      sort: { price: "asc" },
    });
    const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);

    await waitTradeThrottle();
    if (deadline && Date.now() > deadline) return null;
    const search = await fetchTrade(searchUrl, { method: "POST", body });
    if (!search.result || !search.result.length) return null;

    const ids = search.result.slice(0, 10).join(",");
    const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + ids + "?query=" + encodeURIComponent(search.id);
    if (deadline && Date.now() > deadline) return null;
    const fetched = await fetchTrade(fetchUrl);
    const prices = [];

    for (const entry of fetched.result || []) {
      const price = entry.listing && entry.listing.price;
      if (!price || !currencyRates[price.currency]) continue;
      const each = Math.round(Number(price.amount) * currencyRates[price.currency] * 100) / 100;
      if (each > 0) prices.push({ each, rawAmount: price.amount, rawCurrency: price.currency });
    }

    return prices.sort((a, b) => a.each - b.each)[0] || null;
  } catch (err) {
    if (String(err && err.message).includes("rate limited")) return { limited: true };
    return null;
  }
}

async function fetchCurrencyRates(league) {
  const rates = { exalted: 1 };
  const apiUrl = "https://poe.ninja/poe2/api/economy/exchange/current/overview?league=" +
    encodeURIComponent(league) + "&type=Currency";
  const response = await fetchWithTimeout(apiUrl, {}, NINJA_TIMEOUT_MS);
  if (!response.ok) return rates;
  const data = await response.json();

  if (data.core && data.core.rates && data.core.rates.exalted) {
    rates.divine = Number(data.core.rates.exalted);
  }
  if (data.core && data.core.rates && data.core.rates.chaos) {
    rates.chaos = Math.round((1 / Number(data.core.rates.chaos)) * 1000000) / 1000000;
  }

  const lineById = new Map((data.lines || []).map((line) => [line.id, line]));
  for (const item of data.items || []) {
    const line = lineById.get(item.id);
    const priceEx = getDisplayPriceExalted(line, rates);
    if (priceEx > 0) {
      rates[item.id] = priceEx;
      rates[normalizeName(item.name)] = priceEx;
    }
  }

  for (const [alias, target] of Object.entries({
    alch: "orb of alchemy",
    alchemy: "orb of alchemy",
    regal: "regal orb",
    annul: "orb of annulment",
    chance: "orb of chance",
    transmute: "orb of transmutation",
    augmentation: "orb of augmentation",
    aug: "orb of augmentation",
    vaal: "vaal orb",
    gcp: "gemcutter's prism",
    gemcutter: "gemcutter's prism",
  })) {
    const targetRate = rates[normalizeName(target)];
    if (targetRate) rates[alias] = targetRate;
  }

  return rates;
}

async function fetchPrices(league) {
  const prices = {};
  let divineRate = 0;

  for (const type of TYPES) {
    const url = "https://poe.ninja/poe2/api/economy/exchange/current/overview?league=" +
      encodeURIComponent(league) + "&type=" + encodeURIComponent(type);
    const response = await fetchWithTimeout(url, {}, NINJA_TIMEOUT_MS);
    if (!response.ok) throw new Error(type + " returned HTTP " + response.status);

    const data = await response.json();
    const rate = Number(data.core && data.core.rates && data.core.rates.chaos) || 0;
    if (rate > 0 && !divineRate) divineRate = rate;

    const names = {};
    for (const item of data.items || []) names[item.id] = item.name;
    for (const line of data.lines || []) {
      prices[line.id] = {
        n: names[line.id] || line.id,
        c: Math.round((Number(line.primaryValue) || 0) * rate * 100) / 100,
      };
    }
  }

  return {
    prices,
    divineRate,
    count: Object.keys(prices).length,
    updated: new Date().toISOString(),
  };
}

async function fetchRunePrices(text, league) {
  const initialTradeStatus = tradeStatus();
  const rawLines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/Runeshape|Combination|Game Paused/i.test(line));

  if (!rawLines.length) {
    return { results: [], best: null, count: 0, updated: new Date().toISOString() };
  }

  const limitedRawLines = rawLines.slice(0, MAX_RUNE_LINES);
  let tradeFallbacks = 0;

  const loaded = [];
  const currencyRates = { exalted: 1 };
  let currencyData = null;

  const categoryResults = await Promise.allSettled(RUNE_CATEGORIES.map(async (category) => {
    const apiUrl = "https://poe.ninja/poe2/api/economy/exchange/current/overview?league=" +
      encodeURIComponent(league) + "&type=" + encodeURIComponent(category.type);
    const response = await fetchWithTimeout(apiUrl, {}, NINJA_TIMEOUT_MS);
    if (!response.ok) throw new Error(category.type + " returned HTTP " + response.status);
    return { category, data: await response.json() };
  }));

  for (const result of categoryResults) {
    if (result.status !== "fulfilled") continue;
    const { category, data } = result.value;
    loaded.push({ category, data });
    if (category.type === "Currency") currencyData = data;
  }

  if (currencyData) {
    if (currencyData.core && currencyData.core.rates && currencyData.core.rates.exalted) {
      currencyRates.divine = Number(currencyData.core.rates.exalted);
    }
    if (currencyData.core && currencyData.core.rates && currencyData.core.rates.chaos) {
      currencyRates.chaos = Math.round((1 / Number(currencyData.core.rates.chaos)) * 1000000) / 1000000;
    }
    const lineById = new Map((currencyData.lines || []).map((line) => [line.id, line]));
    for (const item of currencyData.items || []) {
      const line = lineById.get(item.id);
      const priceEx = getDisplayPriceExalted(line, currencyRates);
      if (priceEx > 0) {
        currencyRates[item.id] = priceEx;
        currencyRates[normalizeName(item.name)] = priceEx;
      }
    }
    for (const [alias, target] of Object.entries({
      alch: "orb of alchemy",
      alchemy: "orb of alchemy",
      regal: "regal orb",
      annul: "orb of annulment",
      chance: "orb of chance",
      transmute: "orb of transmutation",
      augmentation: "orb of augmentation",
      aug: "orb of augmentation",
      vaal: "vaal orb",
      gcp: "gemcutter's prism",
      gemcutter: "gemcutter's prism",
    })) {
      const targetRate = currencyRates[normalizeName(target)];
      if (targetRate) currencyRates[alias] = targetRate;
    }
  }

  const all = [];
  const seenItemKey = new Set();
  for (const { category, data } of loaded) {
    const lineById = new Map((data.lines || []).map((line) => [line.id, line]));
    for (const item of data.items || []) {
      const line = lineById.get(item.id);
      if (!line) continue;
      const key = item.name + "|" + category.type;
      if (seenItemKey.has(key)) continue;
      seenItemKey.add(key);
      all.push({
        name: item.name,
        normalizedName: normalizeName(item.name),
        category: category.type,
        slug: category.slug,
        price: getDisplayPriceExalted(line, currencyRates),
        volume: getLineVolume(line),
        divineValue: Math.round((Number(line.primaryValue) || 0) * 10000) / 10000,
        change7d: line.sparkline && line.sparkline.totalChange ? String(line.sparkline.totalChange) + "%" : "",
      });
    }
  }

  const seenCleanNames = new Set();
  const results = [];
  let skillTradeFallbacks = 0;
  const tradeDeadline = Date.now() + 24000;
  let tradePaused = initialTradeStatus.limited;
  for (const rawName of limitedRawLines) {
    const parsed = stripQuantity(rawName);
    const lineKindMatch = parsed.text.match(/^\s*(Skill|Support)\s*:\s*(.*)$/i);
    const isSkillOrSupport = Boolean(lineKindMatch);
    const lineText = lineKindMatch ? lineKindMatch[2] : parsed.text;
    const cleanName = lineText
      .replace(/^\s*[|:\-\u2022]*\s*/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleanName.length < 3 || !/[A-Za-z]/.test(cleanName) || /^Uncut (Skill|Spirit|Support) Gem$/i.test(cleanName)) continue;

    const norm = normalizeName(cleanName);
    if (seenCleanNames.has(norm)) continue;
    seenCleanNames.add(norm);

    let match = all.find((item) => item.normalizedName === norm);
    if (!match && norm.length >= 6) {
      match = all
        .filter((item) => item.normalizedName.includes(norm) || norm.includes(item.normalizedName))
        .sort((a, b) => a.normalizedName.length - b.normalizedName.length)[0];
    }

    if (match) {
      const lowVolume = match.volume >= 0 && match.volume < MIN_NINJA_VOLUME;
      if (lowVolume && tradeFallbacks < MAX_TRADE_FALLBACKS) {
        tradeFallbacks++;
        const tradePrice = await getTradePrice(cleanName, league, currencyRates);
        if (tradePrice && tradePrice.limited) {
          results.push({ qty: parsed.qty, name: match.name, category: match.category + " (trade limited)", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — ninja prices above are live, live-trade is best-effort", change7d: match.change7d });
          continue;
        }
        if (tradePrice) {
          const total = roundPriceExalted(tradePrice.each * parsed.qty);
          results.push({
            qty: parsed.qty,
            name: match.name,
            category: match.category + " (low vol -> trade2)",
            each: tradePrice.each,
            total,
            currency: "exalted",
            source: "trade2",
            rawPrice: tradePrice.rawAmount + " " + tradePrice.rawCurrency,
            change7d: match.change7d,
          });
          continue;
        }
      }
      if (!(match.price > 0)) {
        results.push({ qty: parsed.qty, name: match.name, category: match.category + " (no price)", each: "", total: "", currency: "", source: "poe.ninja", rawPrice: "", change7d: match.change7d });
        continue;
      }
      const total = roundPriceExalted(match.price * parsed.qty);
      results.push({
        qty: parsed.qty,
        name: match.name,
        category: lowVolume ? match.category + " (low vol)" : match.category,
        each: match.price,
        total,
        currency: "exalted",
        source: "poe.ninja",
        rawPrice: "",
        divineValue: match.divineValue,
        change7d: match.change7d,
      });
      continue;
    }

    let tradePrice = null;
    if (isSkillOrSupport && tradePaused) {
      results.push({ qty: parsed.qty, name: cleanName, category: "TRADE QUEUED", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — ninja prices above are live, live-trade is best-effort", change7d: "" });
      continue;
    }

    if (isSkillOrSupport) {
      results.push({ qty: parsed.qty, name: cleanName, category: "TRADE QUEUED", each: "", total: "", currency: "", source: "trade2", rawPrice: "queued — shared rate-limit bucket, live-trade is best-effort", change7d: "" });
      continue;
    } else if (tradeFallbacks < MAX_TRADE_FALLBACKS) {
      tradeFallbacks++;
      tradePrice = await getTradePrice(cleanName, league, currencyRates, tradeDeadline);
      if (tradePrice && tradePrice.limited) tradePaused = true;
    }
    if (tradePrice) {
      if (tradePrice.limited) {
        results.push({ qty: parsed.qty, name: cleanName, category: "TRADE LIMITED", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — ninja prices above are live, live-trade is best-effort", change7d: "" });
        continue;
      }
      const total = roundPriceExalted(tradePrice.each * parsed.qty);
      results.push({
        qty: parsed.qty,
        name: cleanName,
        category: "TradeMarket",
        each: tradePrice.each,
        total,
        currency: "exalted",
        source: "trade2",
        rawPrice: tradePrice.rawAmount + " " + tradePrice.rawCurrency,
        change7d: "",
      });
      continue;
    }

    results.push({ qty: parsed.qty, name: cleanName, category: "NOT FOUND", each: "", total: "", currency: "", source: "", rawPrice: "", change7d: "" });
  }

  results.sort((a, b) => (Number(b.total) || -1) - (Number(a.total) || -1));
  const best = results.find((item) => Number(item.total) > 0) || null;
  return {
    results,
    best,
    count: results.length,
    truncated: rawLines.length > limitedRawLines.length,
    tradeFallbacks,
    skillTradeFallbacks,
    tradeLimitedUntil: tradeBlockedUntil > Date.now() ? new Date(tradeBlockedUntil).toISOString() : "",
    updated: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + HOST + ":" + PORT);

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/prices") {
      const league = url.searchParams.get("league") || "Runes of Aldur";
      const body = JSON.stringify(await fetchPrices(league));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/trade-status") {
      send(res, 200, JSON.stringify(tradeStatus()), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/rune-prices" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || "Runes of Aldur";
      const body = JSON.stringify(await fetchRunePrices(input.text || "", league));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/trade-price" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || "Runes of Aldur";
      const name = String(input.name || "").trim();
      const status = tradeStatus();
      if (!name) {
        send(res, 400, JSON.stringify({ error: "Missing name" }), "application/json; charset=utf-8");
        return;
      }
      if (status.limited) {
        send(res, 200, JSON.stringify({ name, limited: true, tradeLimitedUntil: status.tradeLimitedUntil }), "application/json; charset=utf-8");
        return;
      }

      const rates = await fetchCurrencyRates(league);
      const price = await getTradePrice(name, league, rates, Date.now() + 12000);
      if (price && price.limited) {
        send(res, 200, JSON.stringify({ name, limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8");
        return;
      }
      if (!price) {
        send(res, 200, JSON.stringify({ name, found: false }), "application/json; charset=utf-8");
        return;
      }

      send(res, 200, JSON.stringify({
        name,
        found: true,
        qty: Number(input.qty) || 1,
        category: "TradeMarket",
        each: price.each,
        total: roundPriceExalted(price.each * (Number(input.qty) || 1)),
        currency: "exalted",
        source: "trade2",
        rawPrice: price.rawAmount + " " + price.rawCurrency,
      }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/ocr" && req.method === "POST") {
      const ct = (req.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
      if (!allowed.includes(ct)) {
        send(res, 400, JSON.stringify({ error: "Expected an image/* content-type" }), "application/json; charset=utf-8");
        return;
      }
      const buf = await readRawBody(req);
      const tid = Date.now() + "-" + Math.random().toString(36).slice(2);
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("gif") ? "gif" : "jpg";
      const tmpIn   = path.join(os.tmpdir(), "poe-ocr-" + tid + "." + ext);
      const tmpProc = path.join(os.tmpdir(), "poe-ocr-" + tid + "-proc.png");
      const tmpBase = path.join(os.tmpdir(), "poe-ocr-" + tid + "-out");
      const cleanup = () => { for (const f of [tmpIn, tmpProc, tmpBase + ".txt"]) fs.unlink(f, () => {}); };
      try {
        await fs.promises.writeFile(tmpIn, buf);
        await new Promise((resolve, reject) =>
          exec(`convert "${tmpIn}" -colorspace gray -normalize -threshold 55% -negate -morphology Dilate Disk:1 -resize 300% "${tmpProc}"`,
            (err, _, stderr) => err ? reject(new Error(stderr || err.message)) : resolve())
        );
        const text = await new Promise((resolve, reject) =>
          exec(`tesseract "${tmpProc}" "${tmpBase}" --oem 1 --psm 6`,
            (err, _, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              fs.readFile(tmpBase + ".txt", "utf8", (e, d) => e ? reject(e) : resolve(d || ""));
            })
        );
        send(res, 200, JSON.stringify({ text: text.trim() }), "application/json; charset=utf-8");
      } catch (err) {
        send(res, 500, JSON.stringify({ error: "OCR failed: " + err.message }), "application/json; charset=utf-8");
      } finally {
        cleanup();
      }
      return;
    }

    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const fullPath = path.resolve(ROOT, requested);
    if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) {
      send(res, 403, "Forbidden");
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        send(res, 404, "Not found");
        return;
      }
      send(res, 200, data, MIME[path.extname(fullPath).toLowerCase()] || "application/octet-stream");
    });
  } catch (err) {
    send(res, 500, err.message);
  }
});

loadTradeStatus();

server.listen(PORT, HOST, () => {
  const url = "http://" + HOST + ":" + PORT + "/";
  console.log("PoE Tools running at " + url);
  if (!process.env.POE2_NO_OPEN) exec('start "" "' + url + '"');
});

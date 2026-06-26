const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { exec } = require("child_process");
const { createTradeQueue } = require("./trade-queue");
const pob = require("./pob.js");   // headless Path of Building bridge (Gear Finder)
// base type name -> { slot, implicit? } from PoB's bundled GGG item data (gen-pob-bases.js).
// Optional: a missing file just falls the weapon-slot detection back to keyword sniffing.
let POB_BASES = {};
try { POB_BASES = require("./pob-bases.js"); } catch { /* not generated → keyword fallback */ }

const HOST = process.env.HOST || "127.0.0.1";
const PORT = 17777;
const ROOT = __dirname;
// Runtime state (caches, economy history, rate-limit safety, oauth) lives here.
// Defaults to ROOT for local dev; in Docker set DATA_DIR to a mounted volume so a
// `--build` redeploy doesn't wipe the container's writable layer (e.g. the rolling
// economy-history graph). ponytail: one dir, no per-file mounts.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const POE_OAUTH_FILE = path.join(DATA_DIR, ".poe-oauth.json");
const POE_OAUTH_STATE_FILE = path.join(DATA_DIR, ".poe-oauth-state.json");
const TYPES = ["Currency", "Essences", "Ritual", "Abyss", "Breach"];
const MIN_NINJA_VOLUME = 10;
const TRADE_MIN_GAP_MS = 3000;
// POESESSID (a logged-in pathofexile.com session cookie, set in .env — NEVER committed)
// unlocks the build-weighted `statgroup` sort that 400s anonymously, so realrank can
// fetch the BEST candidates for the build instead of a price spread. Use a throwaway
// account: this cookie = full account access.
const POESESSID = (process.env.POESESSID || "").trim();
const TRADE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "poe-tools-local/0.1 (contact: " + (process.env.POE_CONTACT || "unset") + ")",
  ...(POESESSID ? { "Cookie": "POESESSID=" + POESESSID } : {}),
};
const TRADE_TIMEOUT_MS = 3500;
// Record/replay Trade2 traffic so the tool develops + tests with zero live GGG
// calls (the legit alternative to IP-rotation evasion). POE_RECORD=1 captures real
// responses to trade-fixtures.json; POE_OFFLINE=1 serves them back, never hitting
// the network or the shared rate-limit budget. Both off = normal live behaviour.
const TRADE_RECORD = process.env.POE_RECORD === "1";
const TRADE_OFFLINE = process.env.POE_OFFLINE === "1";
const TRADE_FIXTURE_FILE = path.join(__dirname, "trade-fixtures.json");
const MAX_RUNE_LINES = 30;
const MAX_TRADE_FALLBACKS = 0;
const MAX_SKILL_TRADE_FALLBACKS = 1;
const OPTIMIZER_ITERATIONS = 10000;
const MIN_TARGET_SALE_EX = 50;
const COMPARABLE_CACHE_MS = 5 * 60 * 1000;
const QUIVER_CATEGORY = "armour.quiver";
const STAT = {
  projectileLevels: "explicit.stat_1202301673",
  attackCrit: "explicit.stat_2194114101",
  flatPhysAttack: "explicit.stat_3032590688",
  attackSpeed: "explicit.stat_681332047",
  bowDamage: "explicit.stat_1241625305",
  projectileSpeed: "explicit.stat_3759663284",
  twoProjMoving: "explicit.stat_3932115504",
};
const QUIVER_MOD_POOL = {
  projectileLevels: 45,
  attackCrit: 750,
  flatPhysAttack: 850,
  attackSpeed: 750,
  bowDamage: 900,
  projectileSpeed: 1000,
  twoProjMoving: 60,
  fillerPrefix: 5200,
  fillerSuffix: 5200,
};
const QUIVER_TARGETS = [
  {
    id: "proj-crit-flat",
    name: "+2 Projectile / Crit / Flat Phys Quiver Market",
    family: "quiver",
    notes: "Bow quiver package. Comparable search requires +2 projectile, attack crit, and flat physical attack damage.",
    tradeStats: [
      { id: STAT.projectileLevels, value: { min: 2 } },
      { id: STAT.attackCrit, value: { min: 20 } },
      { id: STAT.flatPhysAttack },
    ],
    fallbackTradeStats: [
      { id: STAT.projectileLevels, value: { min: 1 } },
      { id: STAT.attackCrit, value: { min: 20 } },
      { id: STAT.flatPhysAttack },
    ],
    routes: ["self-fracture-flat-greater", "self-fracture-flat", "buy-fractured-flat-greater", "buy-fractured-flat", "transmute-regal-gamble"],
  },
  {
    id: "proj-speed-bow",
    name: "+2 Projectile / Attack Speed / Bow Damage Quiver Market",
    family: "quiver",
    notes: "Speed-focused attack package. Comparable search requires +2 projectile, attack speed, and bow skill damage.",
    tradeStats: [
      { id: STAT.projectileLevels, value: { min: 2 } },
      { id: STAT.attackSpeed, value: { min: 8 } },
      { id: STAT.bowDamage, value: { min: 35 } },
    ],
    fallbackTradeStats: [
      { id: STAT.projectileLevels, value: { min: 1 } },
      { id: STAT.attackSpeed, value: { min: 8 } },
      { id: STAT.bowDamage, value: { min: 35 } },
    ],
    routes: ["buy-fractured-projectile-greater", "buy-fractured-projectile", "transmute-regal-gamble"],
  },
  {
    id: "extra-projectile-premium",
    name: "Extra Projectile Chance / Projectile Speed / Bow Damage Quiver",
    family: "quiver",
    notes: "Premium projectile behavior package. Comparable search uses projectile speed and bow skill damage, then treats extra-projectile rolling as the craft upside.",
    tradeStats: [
      { id: STAT.projectileSpeed, value: { min: 34 } },
      { id: STAT.bowDamage, value: { min: 35 } },
    ],
    routes: ["self-fracture-extra-projectile-greater", "self-fracture-extra-projectile", "buy-fractured-projectile-greater", "buy-fractured-projectile"],
  },
];
const QUIVER_ROUTES = {
  "self-fracture-flat": {
    id: "self-fracture-flat",
    name: "Self-fracture flat phys, finish with omen/essence",
    baseCostEx: 0.25,
    salvageEx: 0.08,
    materials: [
      { id: "fracturing-orb", qty: 1 },
      { id: "gnawed-jawbone", qty: 1 },
      { id: "omen-of-dextral-necromancy", qty: 1 },
      { id: "perfect-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["flatPhysAttack"] },
      { accepts: ["projectileLevels"] },
      { accepts: ["attackCrit", "attackSpeed"] },
    ],
    fractureChance: 1 / 3,
    confidence: "medium",
  },
  "self-fracture-flat-greater": {
    id: "self-fracture-flat-greater",
    name: "Self-fracture flat phys, finish with Greater Exalted",
    baseCostEx: 0.25,
    salvageEx: 0.08,
    materials: [
      { id: "fracturing-orb", qty: 1 },
      { id: "gnawed-jawbone", qty: 1 },
      { id: "omen-of-dextral-necromancy", qty: 1 },
      { id: "greater-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["flatPhysAttack"] },
      { accepts: ["projectileLevels"] },
      { accepts: ["attackCrit", "attackSpeed"] },
    ],
    fractureChance: 1 / 3,
    confidence: "medium",
  },
  "buy-fractured-flat": {
    id: "buy-fractured-flat",
    name: "Buy fractured flat phys base, finish suffixes",
    baseCostEx: 2.5,
    salvageEx: 1.5,
    materials: [
      { id: "greater-essence-of-seeking", qty: 1 },
      { id: "omen-of-dextral-necromancy", qty: 1 },
      { id: "perfect-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["projectileLevels"] },
      { accepts: ["attackCrit", "attackSpeed"] },
    ],
    fractureChance: 1,
    fixedSuccessRate: 0.25,
    confidence: "medium",
  },
  "buy-fractured-flat-greater": {
    id: "buy-fractured-flat-greater",
    name: "Buy fractured flat phys base, finish with Greater Exalted",
    baseCostEx: 2.5,
    salvageEx: 1.5,
    materials: [
      { id: "greater-essence-of-seeking", qty: 1 },
      { id: "omen-of-dextral-necromancy", qty: 1 },
      { id: "greater-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["projectileLevels"] },
      { accepts: ["attackCrit", "attackSpeed"] },
    ],
    fractureChance: 1,
    fixedSuccessRate: 0.25,
    confidence: "medium",
  },
  "buy-fractured-projectile": {
    id: "buy-fractured-projectile",
    name: "Buy fractured projectile base, finish damage package",
    baseCostEx: 3.5,
    salvageEx: 2,
    materials: [
      { id: "essence-of-hysteria", qty: 1 },
      { id: "omen-of-sinistral-crystallisation", qty: 1 },
      { id: "perfect-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["attackSpeed", "attackCrit", "projectileSpeed"] },
      { accepts: ["bowDamage", "flatPhysAttack"] },
    ],
    fractureChance: 1,
    fixedSuccessRate: 1,
    confidence: "medium",
  },
  "buy-fractured-projectile-greater": {
    id: "buy-fractured-projectile-greater",
    name: "Buy fractured projectile base, finish with Greater Exalted",
    baseCostEx: 3.5,
    salvageEx: 2,
    materials: [
      { id: "essence-of-hysteria", qty: 1 },
      { id: "omen-of-sinistral-crystallisation", qty: 1 },
      { id: "greater-exalted-orb", qty: 1 },
    ],
    checks: [
      { accepts: ["attackSpeed", "attackCrit", "projectileSpeed"] },
      { accepts: ["bowDamage", "flatPhysAttack"] },
    ],
    fractureChance: 1,
    fixedSuccessRate: 1,
    confidence: "medium",
  },
  "self-fracture-extra-projectile": {
    id: "self-fracture-extra-projectile",
    name: "Self-fracture extra projectile mod",
    baseCostEx: 0.4,
    salvageEx: 0.1,
    materials: [
      { id: "fracturing-orb", qty: 1 },
      { id: "perfect-exalted-orb", qty: 2 },
      { id: "omen-of-abyssal-echoes", qty: 1 },
    ],
    checks: [
      { accepts: ["twoProjMoving"] },
      { accepts: ["projectileSpeed"] },
      { accepts: ["bowDamage"] },
    ],
    fractureChance: 1 / 3,
    confidence: "low",
  },
  "self-fracture-extra-projectile-greater": {
    id: "self-fracture-extra-projectile-greater",
    name: "Self-fracture extra projectile, finish with Greater Exalted",
    baseCostEx: 0.4,
    salvageEx: 0.1,
    materials: [
      { id: "fracturing-orb", qty: 1 },
      { id: "greater-exalted-orb", qty: 2 },
      { id: "omen-of-abyssal-echoes", qty: 1 },
    ],
    checks: [
      { accepts: ["twoProjMoving"] },
      { accepts: ["projectileSpeed"] },
      { accepts: ["bowDamage"] },
    ],
    fractureChance: 1 / 3,
    confidence: "low",
  },
  "transmute-regal-gamble": {
    id: "transmute-regal-gamble",
    name: "Transmute / regal / exalt gamble",
    baseCostEx: 0.15,
    salvageEx: 0.03,
    materials: [
      { id: "perfect-orb-of-transmutation", qty: 1 },
      { id: "perfect-orb-of-augmentation", qty: 1 },
      { id: "perfect-regal-orb", qty: 1 },
      { id: "perfect-exalted-orb", qty: 2 },
    ],
    checks: [
      { accepts: ["projectileLevels", "twoProjMoving"] },
      { accepts: ["attackCrit", "attackSpeed", "projectileSpeed"] },
      { accepts: ["flatPhysAttack", "bowDamage"] },
    ],
    fractureChance: 1,
    confidence: "low",
  },
};
const tradeQueue = createTradeQueue({
  statusFile: path.join(DATA_DIR, ".trade-status.json"),
  headers: TRADE_HEADERS,
  minGapMs: TRADE_MIN_GAP_MS,
  timeoutMs: TRADE_TIMEOUT_MS,
  record: TRADE_RECORD,
  replay: TRADE_OFFLINE,
  fixtureFile: TRADE_FIXTURE_FILE,
});
if (TRADE_OFFLINE) console.log("[trade] OFFLINE replay mode — serving trade-fixtures.json, zero live GGG calls");
else if (TRADE_RECORD) console.log("[trade] RECORD mode — live calls captured to trade-fixtures.json");
const comparableCache = new Map();
const ARBITRAGE_CACHE_FILE = path.join(DATA_DIR, ".arbitrage-scan-cache.json");
const ARBITRAGE_CACHE_MS = 2 * 60 * 1000;
const EXALTED_ID = "exalted";
const ARBITRAGE_ITEMS = [
  { id: "divine", name: "Divine Orb", category: "currency", enabled: true },
  { id: "chaos", name: "Chaos Orb", category: "currency", enabled: true },
  { id: "regal", name: "Regal Orb", category: "currency", enabled: true },
  { id: "vaal", name: "Vaal Orb", category: "currency", enabled: true },
  { id: "alch", name: "Orb of Alchemy", category: "currency", enabled: true },
  { id: "chance", name: "Orb of Chance", category: "currency", enabled: true },
  { id: "annul", name: "Orb of Annulment", category: "currency", enabled: true },
  { id: "artificers", name: "Artificer's Orb", category: "currency", enabled: true, aliases: ["Artificers Orb"] },
  { id: "gcp", name: "Gemcutter's Prism", category: "currency", enabled: true, aliases: ["Gemcutters Prism"] },
  // Rate-only currencies (enabled:false → kept OUT of the arbitrage scanner by the
  // `item.enabled` filter, but still picked up by fetchExchangeData's currency
  // filter so Gear Search listings priced in these don't get dropped for lack of a
  // rate). poe.ninja used to cover every currency; the Trade2 move narrowed it to
  // the 9 scanner currencies, so these backfill the common exotic gear-price orbs.
  // Append more here as needed — each adds at most a fraction of a chunked call.
  { id: "mirror", name: "Mirror of Kalandra", category: "currency", enabled: false },
  { id: "transmute", name: "Orb of Transmutation", category: "currency", enabled: false },
  { id: "aug", name: "Orb of Augmentation", category: "currency", enabled: false },
  { id: "fracturing-orb", name: "Fracturing Orb", category: "currency", enabled: false, aliases: ["Orb of Fracturing"] },
  // Exalted family — priced here (one shared exchange call) so the home economy
  // panel reads them off the SAME live rates the currency strip uses, instead of a
  // separate twice-a-day fetch that drifted out of sync. enabled:false = rate-only.
  { id: "greater-exalted-orb", name: "Greater Exalted Orb", category: "currency", enabled: false },
  { id: "perfect-exalted-orb", name: "Perfect Exalted Orb", category: "currency", enabled: false },
  { id: "simulacrum-splinter", name: "Simulacrum Splinter", category: "fragments", enabled: true },
  { id: "breach-splinter", name: "Breach Splinter", category: "fragments", enabled: true },
  { id: "cowards-fate", name: "Coward's Fate", category: "fragments", enabled: false },
  { id: "deadly-fate", name: "Deadly Fate", category: "fragments", enabled: false },
  { id: "victorious-fate", name: "Victorious Fate", category: "fragments", enabled: false },
];
let arbitrageStaticCache = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function tradeStatus() {
  return tradeQueue.status();
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

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
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

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// The league name goes straight into upstream GGG/poe.ninja URLs, so never trust
// the raw query value. A reverse proxy was seen appending its own origin onto it
// ("Runes of Aldur" + "http://docker:8098"), producing an invalid league and an
// HTTP 400 from Trade2. Cut anything from an embedded URL, keep only characters a
// real PoE league name uses, and fall back to the default if nothing sane is left.
const DEFAULT_LEAGUE = "Runes of Aldur";
function sanitizeLeague(raw) {
  const cleaned = String(raw || "")
    .split(/https?:\/\//i)[0]
    .replace(/[^A-Za-z0-9 '\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || DEFAULT_LEAGUE;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function normalizeExchangeOffer(raw, haveId, wantId) {
  const offer = raw && raw.exchange && raw.item ? raw : raw && raw.offer ? raw.offer : null;
  if (!offer || !offer.exchange || !offer.item) return null;
  const pay = offer.exchange;
  const receive = offer.item;
  const currencyId = (side) => {
    const cur = side.currency;
    if (cur && typeof cur === "object") return String(cur.id || cur.currency || cur.text || "");
    return String(cur || side.id || "");
  };
  const payCurrency = currencyId(pay).toLowerCase();
  const receiveCurrency = currencyId(receive).toLowerCase();
  if (payCurrency && payCurrency !== String(haveId).toLowerCase()) return null;
  if (receiveCurrency && receiveCurrency !== String(wantId).toLowerCase()) return null;
  const payAmount = Number(pay.amount);
  const receiveAmount = Number(receive.amount);
  if (!(payAmount > 0) || !(receiveAmount > 0)) return null;
  return {
    payAmount,
    receiveAmount,
    receiveStock: Number(receive.stock) || receiveAmount,
    payStock: Number(pay.stock) || payAmount,
    account: offer.account && offer.account.name ? offer.account.name : "",
  };
}

function collectExchangeOffers(data, haveId, wantId) {
  const out = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const offer = normalizeExchangeOffer(value, haveId, wantId);
    if (offer) out.push(offer);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const key of ["result", "offers", "listing", "listings", "entries", "data"]) {
      if (value[key]) visit(value[key]);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(data);
  return out;
}

// The cheapest standing offer that isn't junk. The bulk Currency Exchange is
// littered with mispriced/spam listings that poison the derived rate:
//   1. PAR swaps that trade the base unit one-for-one (e.g. 1 exalted : 1 divine
//      — giving away ~250 ex). No legit seller does this, so drop exact-par.
//   2. LOWBALL bait priced far below the market (e.g. a lone "165 exalted : 1 divine"
//      with real stock when the book is clustered at ~250). These pass every stock
//      filter and sort to the very top as the "cheapest", dragging the rate down.
//      You can't actually fill them; they're traps.
// So: drop par, then take the cheapest offer that sits in a CLUSTER — has >=3 peers
// within ±15%, i.e. where real sellers agree. Lone lowball bait and lone walls have
// no cluster and are skipped no matter how cheap they sort. (This is the same robust
// rule the divine-side omen pricing uses; it supersedes the old quarter-of-median
// floor, which let a lone bait like 165 through when the real book sat at ~250.)
// Thin books (<4 real offers) can't tell a bait from the floor → take the cheapest.
// (offers sorted ascending by ratio.)
function robustCheapestOffer(sortedOffers) {
  if (!sortedOffers.length) return undefined;
  const real = sortedOffers.filter((o) => o.payAmount !== o.receiveAmount);
  const pool = real.length ? real : sortedOffers;
  if (pool.length < 4) return pool[0];   // too thin to tell a bait from the floor
  const ratio = (o) => o.payAmount / o.receiveAmount;
  const ratios = pool.map(ratio);
  const clustered = pool.filter((o) => {
    const r = ratio(o);
    return ratios.reduce((n, y) => n + (y >= r * 0.85 && y <= r * 1.15 ? 1 : 0), 0) >= 3;
  });
  return (clustered.length ? clustered : pool)[0];
}

function bestExchangeOffer(data, haveId, wantId, minStock) {
  const stockForItem = (offer) => String(haveId).toLowerCase() === EXALTED_ID ? offer.receiveStock : offer.payStock;
  const offers = collectExchangeOffers(data, haveId, wantId)
    .filter((offer) => stockForItem(offer) >= minStock);
  if (!offers.length) return null;
  offers.sort((a, b) => (a.payAmount / a.receiveAmount) - (b.payAmount / b.receiveAmount));
  const best = robustCheapestOffer(offers);
  return {
    payAmount: best.payAmount,
    receiveAmount: best.receiveAmount,
    payPerReceive: best.payAmount / best.receiveAmount,
    receivePerPay: best.receiveAmount / best.payAmount,
    receiveStock: best.receiveStock,
    payStock: best.payStock,
    account: best.account,
  };
}

function normalizeNameKey(value) {
  return String(value || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function collectStaticEntries(data) {
  const entries = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value.id && (value.text || value.name || value.label)) {
      entries.push({ id: String(value.id), name: String(value.text || value.name || value.label), image: value.image || value.icon || "" });
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const key of ["result", "entries", "items", "children", "data"]) {
      if (value[key]) visit(value[key]);
    }
  };
  visit(data);
  return entries;
}

// Full exchange catalog (normalized item name -> {id, name, category}) walked from
// the grouped static structure, so the Rune Picker can resolve ANY pasted
// rune/essence/soul-core/etc. to its exchange id. Uses normalizeName (the rune
// matcher's normalizer) so lookups line up with pasted text.
function buildExchangeCatalog(data) {
  const map = new Map();
  const groups = (data && data.result) || data || [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    const category = String(g.label || g.id || "Exchange");
    for (const e of (g.entries || [])) {
      if (!e || !e.id) continue;
      const name = String(e.text || e.name || "");
      if (!name) continue;
      const key = normalizeName(name);
      if (!map.has(key)) map.set(key, { id: String(e.id), name, category });
    }
  }
  return map;
}

async function resolveArbitrageItems(league) {
  if (arbitrageStaticCache && Date.now() - arbitrageStaticCache.loadedAt < 60 * 60 * 1000) {
    return arbitrageStaticCache.items;
  }
  const byName = new Map();
  const iconsById = {};
  let catalog = new Map();
  try {
    const endpoint = "https://www.pathofexile.com/api/trade2/data/static";
    const data = await tradeQueue.request(endpoint, { method: "GET" });
    for (const entry of collectStaticEntries(data)) {
      byName.set(normalizeNameKey(entry.name), entry.id);
      if (entry.image) iconsById[String(entry.id)] = entry.image;
    }
    catalog = buildExchangeCatalog(data);
  } catch {
    // Static-data lookup is a convenience. Hardcoded fallbacks keep the scanner usable.
  }
  const items = ARBITRAGE_ITEMS.map((item) => {
    const names = [item.name, ...(item.aliases || [])];
    const resolved = names.map((name) => byName.get(normalizeNameKey(name))).find(Boolean);
    return { ...item, id: resolved || item.id, fallbackId: item.id };
  });
  arbitrageStaticCache = { loadedAt: Date.now(), items, iconsById, catalog };
  return items;
}

// The full normalized-name -> {id,name,category} exchange catalog (ensures the
// static fetch has run; 1h-cached inside resolveArbitrageItems).
async function getExchangeCatalog(league) {
  await resolveArbitrageItems(league);
  return (arbitrageStaticCache && arbitrageStaticCache.catalog) || new Map();
}

// Batched exchange fetch: `have`/`want` accept arrays, so one call returns
// offers across MANY currency pairs. The whole scan needs just 2 of these
// (all buy legs, all sell legs) instead of 2 calls per item — the key fix for
// repeatedly tripping the shared Trade2 rate limit.
async function fetchExchangeRaw(league, haveIds, wantIds, status = "online") {
  const endpoint = "https://www.pathofexile.com/api/trade2/exchange/poe2/" + encodeURIComponent(league);
  const body = JSON.stringify({
    exchange: {
      status: { option: status },
      have: Array.isArray(haveIds) ? haveIds : [haveIds],
      want: Array.isArray(wantIds) ? wantIds : [wantIds],
    },
    engine: "new",
  });
  return tradeQueue.request(endpoint, { method: "POST", body });
}
// Indirection so tests can stub the network without touching the real queue.
let exchangeRawImpl = fetchExchangeRaw;

// The exchange API rejects ~11+ have/want items ("Too many items"), and even a
// 6-wide batch returns a capped page that starves some currencies (a 9-want buy
// dropped Divine entirely). A 3-wide batch was verified to cover every currency,
// so chunk small and merge the offer maps. One side is always [exalted]. Cost:
// ceil(items/3) calls per leg — ~8 for a full currency+fragment scan vs 22 for
// the old per-item path.
const EXCHANGE_BATCH_CAP = 3;
// A high-liquidity currency (e.g. Divine) in a 3-wide chunk can fill the single
// capped response page and starve its chunk-mates (Regal/Simulacrum) of offers.
// After the batched pass, re-fetch any item that came back with ZERO offers,
// alone, so it gets its own page. Bounded so a systemic failure can't turn into
// a per-item burst.
const EXCHANGE_BACKFILL_CAP = 6;
// batchCap: items per exchange call (default 3 = precise, used by arbitrage). The
// book passes a bigger cap to cut total calls on big tabs (the rate limit is the
// bottleneck). skipBackfill: don't re-fetch zero-offer items one-by-one — for the
// book a starved item just means "thin/no buyers", not worth a call to confirm.
async function fetchExchangeChunked(league, haveIds, wantIds, batchCap = EXCHANGE_BATCH_CAP, skipBackfill = false, status = "online") {
  const haveArr = Array.isArray(haveIds) ? haveIds : [haveIds];
  const wantArr = Array.isArray(wantIds) ? wantIds : [wantIds];
  const multiOnHave = haveArr.length >= wantArr.length;
  const list = multiOnHave ? haveArr : wantArr;
  const fixed = multiOnHave ? wantArr : haveArr;
  const merged = {};
  const fetchChunk = async (chunk) => {
    const data = await exchangeRawImpl(league, multiOnHave ? chunk : fixed, multiOnHave ? fixed : chunk, status);
    if (data && data.result && typeof data.result === "object") Object.assign(merged, data.result);
  };
  for (let i = 0; i < list.length; i += batchCap) {
    await fetchChunk(list.slice(i, i + batchCap));
  }
  // Skip backfill on a total miss (empty merged = rate-limit / systemic failure,
  // not page starvation) so we don't hammer with N individual retries.
  if (!skipBackfill && Object.keys(merged).length) {
    const covered = (id) => fixed.some((f) => {
      const [h, w] = multiOnHave ? [id, f] : [f, id];
      return collectExchangeOffers(merged, h, w).length > 0;
    });
    const starved = list.filter((id) => !covered(id)).slice(0, EXCHANGE_BACKFILL_CAP);
    for (const id of starved) await fetchChunk([id]);
  }
  return { result: merged };
}

function arbitrageCacheFresh(cache) {
  return cache && cache.updated && Date.now() - new Date(cache.updated).getTime() < ARBITRAGE_CACHE_MS;
}

async function scanArbitrage(input = {}) {
  const league = sanitizeLeague(input.league);
  const budgetEx = clampNumber(input.budgetEx, 100, 1, 100000);
  const minProfitEx = clampNumber(input.minProfitEx, 5, 0, 100000);
  const minProfitPct = clampNumber(input.minProfitPct, 3, 0, 1000);
  const minStock = clampNumber(input.minStock, 5, 1, 1000000);
  const slippagePct = clampNumber(input.slippagePct, 2, 0, 50);
  const categories = input.categories && typeof input.categories === "object" ? input.categories : { currency: true, fragments: true };
  const status = tradeStatus();
  const cached = readJsonFile(ARBITRAGE_CACHE_FILE, null);
  if (status.limited) {
    return { limited: true, stale: Boolean(cached), cachedAt: cached && cached.updated, tradeStatus: status, ...(cached || { opportunities: [], errors: [] }) };
  }
  if (!input.force && arbitrageCacheFresh(cached)) {
    return { ...cached, cached: true, tradeStatus: status };
  }

  const resolvedItems = await resolveArbitrageItems(league);
  const items = resolvedItems.filter((item) => item.enabled && categories[item.category] !== false && item.id !== EXALTED_ID);
  const opportunities = [];
  const evaluated = [];
  const errors = [];

  // Two batched calls cover every item: all buy legs (give ex, get item) and
  // all sell legs (give item, get ex). Per-item bestExchangeOffer then filters
  // the shared response down to each pair.
  const itemIds = items.map((item) => item.id);
  let buyData, sellData;
  try {
    buyData = await fetchExchangeChunked(league, EXALTED_ID, itemIds);
    sellData = await fetchExchangeChunked(league, itemIds, EXALTED_ID);
  } catch (err) {
    const limited = /rate limited/i.test(String(err && err.message));
    return {
      limited,
      error: limited ? undefined : String(err && err.message).slice(0, 180),
      stale: Boolean(cached),
      cachedAt: cached && cached.updated,
      tradeStatus: tradeStatus(),
      ...(cached || { opportunities: [], errors: [] }),
    };
  }

  for (const item of items) {
    try {
      const buy = bestExchangeOffer(buyData, EXALTED_ID, item.id, minStock);
      const sell = bestExchangeOffer(sellData, item.id, EXALTED_ID, minStock);
      if (!buy || !sell) {
        errors.push({ item: item.name, reason: "missing-side" });
        continue;
      }
      const askExPerItem = buy.payPerReceive;
      const bidExPerItem = sell.receivePerPay;
      const netBidExPerItem = bidExPerItem * (1 - slippagePct / 100);
      const executableByBudget = Math.floor(budgetEx / askExPerItem);
      const executableByBuyStock = Math.floor(buy.receiveStock);
      const executableBySellStock = Math.floor(sell.payStock || sell.receiveAmount || executableByBudget);
      const executableItems = Math.max(0, Math.min(executableByBudget, executableByBuyStock, executableBySellStock));
      const spendEx = executableItems * askExPerItem;
      const grossProfitEx = executableItems * (bidExPerItem - askExPerItem);
      const netProfitEx = executableItems * (netBidExPerItem - askExPerItem);
      const roiPct = spendEx > 0 ? (netProfitEx / spendEx) * 100 : 0;
      const flags = [];
      if (buy.receiveStock < minStock * 2 || executableBySellStock < minStock * 2) flags.push("thin-stock");
      if (grossProfitEx > 0 && netProfitEx <= 0) flags.push("slippage-eats-spread");
      const record = {
        id: item.id,
        name: item.name,
        category: item.category,
        askExPerItem: round4(askExPerItem),
        bidExPerItem: round4(bidExPerItem),
        netBidExPerItem: round4(netBidExPerItem),
        executableItems,
        spendEx: round2(spendEx),
        grossProfitEx: round2(grossProfitEx),
        netProfitEx: round2(netProfitEx),
        roiPct: round2(roiPct),
        buyStock: round2(buy.receiveStock),
        sellStock: round2(executableBySellStock),
        flags,
      };
      evaluated.push(record);
      if (netProfitEx >= minProfitEx && roiPct >= minProfitPct && executableItems > 0) {
        opportunities.push(record);
      }
    } catch (err) {
      const limited = /rate limited/i.test(String(err && err.message));
      errors.push({ item: item.name, reason: limited ? "rate-limited" : String(err && err.message).slice(0, 180) });
      if (limited) break;
    }
  }

  opportunities.sort((a, b) => (b.netProfitEx - a.netProfitEx) || (b.roiPct - a.roiPct) || (b.buyStock - a.buyStock));
  // Best spreads that did NOT clear the thresholds — so an empty result still
  // proves the scan ran and shows how close the market got (round-trip spreads
  // are usually negative, which is the honest answer, not a broken scan).
  const nearMiss = evaluated
    .filter((r) => !opportunities.includes(r))
    .sort((a, b) => (b.netProfitEx - a.netProfitEx) || (b.roiPct - a.roiPct))
    .slice(0, 3);
  const result = {
    league,
    updated: new Date().toISOString(),
    settings: { budgetEx, minProfitEx, minProfitPct, minStock, slippagePct, categories },
    universe: items.map((item) => ({ id: item.id, name: item.name, category: item.category })),
    opportunities,
    nearMiss,
    errors,
    tradeStatus: tradeStatus(),
  };
  try { writeJsonFile(ARBITRAGE_CACHE_FILE, result); } catch {}
  return result;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function oauthConfig() {
  const clientId = process.env.POE_CLIENT_ID || "";
  return {
    clientId,
    clientSecret: process.env.POE_CLIENT_SECRET || "",
    redirectUri: process.env.POE_REDIRECT_URI || ("http://" + HOST + ":" + PORT + "/api/oauth/callback"),
    scope: "account:profile account:characters",
    configured: Boolean(clientId),
  };
}

function readOauthToken() {
  try {
    return JSON.parse(fs.readFileSync(POE_OAUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeOauthToken(token) {
  fs.writeFileSync(POE_OAUTH_FILE, JSON.stringify({ ...token, savedAt: Date.now() }, null, 2));
}

function clearOauthToken() {
  try { fs.unlinkSync(POE_OAUTH_FILE); } catch {}
}

function writeOauthState(state) {
  fs.writeFileSync(POE_OAUTH_STATE_FILE, JSON.stringify(state, null, 2));
}

function readOauthState() {
  try {
    return JSON.parse(fs.readFileSync(POE_OAUTH_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function oauthStatus() {
  const cfg = oauthConfig();
  const token = readOauthToken();
  const expiresAt = token && token.expires_in ? Number(token.savedAt || 0) + Number(token.expires_in) * 1000 : 0;
  return {
    configured: cfg.configured,
    clientId: cfg.clientId ? cfg.clientId.replace(/.(?=.{4})/g, "*") : "",
    redirectUri: cfg.redirectUri,
    scope: cfg.scope,
    authenticated: Boolean(token && token.access_token && (!expiresAt || Date.now() < expiresAt)),
    username: token && token.username ? token.username : "",
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "",
  };
}

function buildOauthStartUrl() {
  const cfg = oauthConfig();
  if (!cfg.configured) throw new Error("Set POE_CLIENT_ID and restart the server first.");
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  writeOauthState({ state, codeVerifier, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: cfg.scope,
    state,
    redirect_uri: cfg.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return "https://www.pathofexile.com/oauth/authorize?" + params.toString();
}

async function exchangeOauthCode(code, returnedState) {
  const cfg = oauthConfig();
  const saved = readOauthState();
  if (!cfg.configured) throw new Error("OAuth client is not configured.");
  if (!saved || saved.state !== returnedState) throw new Error("OAuth state mismatch.");
  if (Date.now() - Number(saved.createdAt || 0) > 5 * 60 * 1000) throw new Error("OAuth state expired.");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    code_verifier: saved.codeVerifier,
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  const response = await fetchWithTimeout("https://www.pathofexile.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": TRADE_HEADERS["User-Agent"] },
    body: params.toString(),
  }, 12000);
  const text = await response.text();
  if (!response.ok) throw new Error("OAuth token exchange failed: " + text.slice(0, 500));
  const token = JSON.parse(text);
  writeOauthToken(token);
  try { fs.unlinkSync(POE_OAUTH_STATE_FILE); } catch {}
  return token;
}

async function poeApiRequest(pathname, token) {
  const response = await fetchWithTimeout("https://api.pathofexile.com" + pathname, {
    headers: {
      "Authorization": "Bearer " + token.access_token,
      "User-Agent": TRADE_HEADERS["User-Agent"],
    },
  }, 12000);
  const text = await response.text();
  if (!response.ok) throw new Error("PoE API returned HTTP " + response.status + ": " + text.slice(0, 500));
  return JSON.parse(text);
}

function itemToPseudoCopyText(item) {
  const lines = [
    "Item Class: " + guessItemClass(item),
    "Rarity: " + (item.rarity || "Rare"),
    item.name || item.typeLine || "Imported Item",
  ];
  const slotLabel = guessGearSearchSlotLabel(item);
  if (slotLabel) lines.splice(2, 0, "Slot: " + slotLabel);
  if (item.name && item.typeLine) lines.push(item.typeLine);
  lines.push("--------");
  const groups = [
    ["implicitMods", "Implicit"],
    ["explicitMods", "Explicit"],
    ["craftedMods", "Crafted"],
    ["fracturedMods", "Fractured"],
    ["enchantMods", "Enchant"],
    ["runeMods", "Rune"],
    ["desecratedMods", "Desecrated"],
  ];
  for (const [group, label] of groups) {
    for (const mod of item[group] || []) lines.push(label + ": " + normalizePoeMarkup(mod));
  }
  if (item.properties) {
    for (const prop of item.properties) {
      const values = (prop.values || []).map((entry) => Array.isArray(entry) ? entry[0] : entry).join(" ");
      if (prop.name && values) lines.push(normalizePoeMarkup(prop.name) + ": " + values);
    }
  }
  return lines.join("\n");
}

function guessItemClass(item) {
  const category = item && item.inventoryId ? String(item.inventoryId).toLowerCase() : "";
  const type = String((item && item.typeLine) || "");
  if (category.includes("weapon")) return "Bows";
  if (/bow/i.test(type)) return "Bows";
  if (/quiver/i.test(type) || category.includes("offhand")) return "Quivers";
  if (/amulet/i.test(type) || category.includes("amulet")) return "Amulets";
  if (/ring/i.test(type) || category.includes("ring")) return "Rings";
  if (/belt/i.test(type) || category.includes("belt")) return "Belts";
  if (/boots/i.test(type) || category.includes("boots")) return "Boots";
  if (/gloves/i.test(type) || category.includes("gloves")) return "Gloves";
  if (/helmet|cap|hood|helm/i.test(type) || category.includes("helm")) return "Helmets";
  if (/body|robe|jacket|vest|coat|armour|armor/i.test(type) || category.includes("bodyarmour")) return "Body Armours";
  if (/jewel/i.test(type)) return "Jewels";
  return "Unknown";
}

function guessGearSearchSlotLabel(item) {
  const category = item && item.inventoryId ? String(item.inventoryId).toLowerCase() : "";
  if (!category) return "";
  if (category.includes("ring2") || category.includes("right")) return "Ring 2";
  if (category.includes("ring")) return "Ring 1";
  return "";
}

async function importOauthCharacter(characterName, realm = "poe2") {
  const token = readOauthToken();
  if (!token || !token.access_token) throw new Error("Not authenticated with Path of Exile.");
  const data = await poeApiRequest("/character/" + encodeURIComponent(realm) + "/" + encodeURIComponent(characterName), token);
  const character = data.character || data;
  const items = (character.items || character.equipment || []).filter((item) => item && item.inventoryId);
  const text = items.map(itemToPseudoCopyText).join("\n");
  return {
    character,
    itemCount: items.length,
    text,
    analysis: analyzeUpgradeState(text),
  };
}

function normalizeName(value) {
  return String(value)
    // Strip combining diacritics first: OCR / odd copy-paste turns an apostrophe+
    // letter ("t'") into a caron letter ("\u0165"), so "Girt's" arrives as "Gir\u0165s". NFD
    // splits \u0165 -> t + combining caron; dropping the mark leaves "t", and the lost
    // apostrophe doesn't matter (it's stripped below anyway). Without this, \u0165\u013e\u010f fell
    // into the [^a-z0-9] catch-all and became spaces, so the name never matched.
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tier qualifiers make a DIFFERENT item — "Greater Orb of Transmutation" is not
// "Orb of Transmutation". The loose substring matcher below would otherwise treat
// the base name (a substring of the qualified one) as a match and strip the tier,
// mispricing Greater/Perfect orbs as their base. Require the tier words to agree.
const TIER_RE = /\b(?:greater|perfect|lesser|grand|advanced)\b/g;
function tierKey(value) { return (String(value).match(TIER_RE) || []).sort().join(" "); }

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

// poe.ninja exposes no trade count, but volumePrimaryValue is total turnover
// (in divine) and primaryValue is the unit price, so their quotient is the
// number of units traded in the window. More units = deeper, more reliable price.
function unitsTraded(line) {
  const pv = Number(line && line.primaryValue) || 0;
  const vv = Number(line && line.volumePrimaryValue) || 0;
  if (pv <= 0 || vv <= 0) return -1;
  return vv / pv;
}

function priceConfidence(units) {
  if (!Number.isFinite(units) || units < 0) return "unknown";
  if (units >= 300) return "high";
  if (units >= 30) return "medium";
  return "low";
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

async function fetchTrade(url, options = {}) {
  return tradeQueue.request(url, options);
}

// Tab Tracker — read a public stash tab's contents via Trade2 ONLY (no OAuth, no
// cookie: PoE2's get-stash-items returns 403 unauthenticated). The user makes
// tab(s) public and prices every item at a MARKER divine price to mark it apart
// from real sales. We find them with ONE ranged account search (min..max marker),
// then sort each result into its band by exact price — so a normal tab is ~1 search
// + a fetch or two, NOT one search per marker (that burst tripped the tight search
// limit and made a 9-item scan take an hour of cooldowns; see readTrackedBands).
// Trade2 caps a search at 100 results, so only a >100-item range falls back to a
// per-marker read to span the cap. Every kept result IS a tracked item (price ==
// a marker). ponytail: a genuine sale priced at exactly a marker is picked up too;
// reserve the marker prices.
const TAB_MARKERS_DEFAULT = [11, 12, 13, 14];
const TAB_CACHE_FILE = path.join(DATA_DIR, ".tab-tracker.json");
const TAB_CACHE_TTL_MS = 10 * 60 * 1000;
// Unique names to price per request. With RUNE_BOOK_BATCH=10 + 2 legs that's ~4
// exchange calls/visit, so a typical tab (~40 unique types) finishes in ~2 visits
// without tripping GGG's 30-per-5-min ban. The UI auto-polls the CACHED path to
// fill any remainder. (Was 6 with batch-3 → ~28 calls for a big tab = a 30-min ban.)
const TAB_FILL_PER_VISIT = 20;
const RUNE_BOOK_BATCH = 10;

// Parse a "11,12,13,14" markers string → distinct positive numbers (≤8, to bound
// the per-price search count). Falls back to the default set.
function parseTabMarkers(raw) {
  const set = [];
  for (const part of String(raw || "").split(/[, ]+/)) {
    const n = Number(part);
    if (Number.isFinite(n) && n > 0 && !set.includes(n)) set.push(n);
  }
  return set.length ? set.slice(0, 8) : TAB_MARKERS_DEFAULT.slice();
}

function readTabCache(account, league) {
  try {
    const c = JSON.parse(fs.readFileSync(TAB_CACHE_FILE, "utf8"));
    if (c && c.account === account && c.league === league) return c;
  } catch {}
  return null;
}

// Read the marker bands via Trade2, RESUMING from prior progress: each marker price
// is one exact-price search (≤100 results/band), and a band already read (done) is
// reused, not re-fetched. So a read cut short by a 429 caches the bands it finished,
// and the next call continues with the rest — clicking "Value tab" makes progress
// instead of restarting. Returns the per-band map {price: {lines, done}}.
// Per-marker search+fetch for ONE price band (the cap-spanning fallback). ≤100 results.
async function readOneBand(searchUrl, account, league, m) {
  const body = JSON.stringify({
    query: { status: { option: "any" }, filters: { trade_filters: { filters: {
      account: { input: account },
      price: { option: "divine", min: m, max: m },
    } } } },
    sort: { price: "desc" },
  });
  let search;
  try { search = await fetchTrade(searchUrl, { method: "POST", body }); }
  catch (e) { return { lines: [], done: false, hitLimit: true, truncated: false }; }
  const ids = search.result || [];
  const truncated = (search.total || 0) > ids.length;   // this one price has 100+ items
  const lines = [];
  for (let i = 0; i < ids.length; i += 10) {
    let fetched;
    try { fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + ids.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(search.id)); }
    catch (e) { return { lines, done: false, hitLimit: true, truncated }; }
    for (const r of fetched.result || []) {
      const item = r.item || {};
      const name = item.typeLine || item.baseType || item.name;
      if (name) lines.push(name + " x" + (item.stackSize || 1));
    }
  }
  return { lines, done: true, hitLimit: false, truncated };
}

async function readTrackedBands(account, league, markers, prior) {
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const bands = Object.assign({}, prior || {});
  const remaining = markers.filter((m) => !(bands[String(m)] && bands[String(m)].done));
  if (!remaining.length) return { bands, hitLimit: false, truncated: false };
  if (tradeStatus().limited) return { bands, hitLimit: true, truncated: false };

  // ONE ranged search across ALL remaining markers (min..max) instead of one search
  // PER marker. That per-marker burst hit the tight Trade2 SEARCH limit and turned a
  // 9-item scan into an hour of 30-min cooldowns. Trade2 caps a search at 100 results,
  // so for the normal case (a handful of tracked items) one search returns them all and
  // we sort each into its marker band by the item's EXACT listed price (so a wide range
  // over non-contiguous markers still keeps only true marker items — same result as the
  // old per-marker union, at a fraction of the calls). Only a capped range (>100 items)
  // falls back to per-marker to span the 100-cap.
  const min = Math.min(...remaining), max = Math.max(...remaining);
  const markerSet = new Set(remaining.map(Number));
  const body = JSON.stringify({
    query: { status: { option: "any" }, filters: { trade_filters: { filters: {
      account: { input: account },
      price: { option: "divine", min, max },
    } } } },
    sort: { price: "desc" },
  });
  let search;
  try { search = await fetchTrade(searchUrl, { method: "POST", body }); }
  catch (e) { return { bands, hitLimit: true, truncated: false }; }
  const ids = search.result || [];
  const capped = (search.total || 0) > ids.length;

  if (capped && remaining.length > 1) {
    // >100 items in the range → the single page missed some. Span the cap per-marker.
    let hitLimit = false, truncated = false;
    for (const m of remaining) {
      if (tradeStatus().limited) { hitLimit = true; break; }
      const r = await readOneBand(searchUrl, account, league, m);
      bands[String(m)] = { lines: r.lines, done: r.done };
      truncated = truncated || r.truncated;
      if (r.hitLimit) { hitLimit = true; break; }
    }
    return { bands, hitLimit, truncated };
  }

  // Single-search path: fetch the ids, sort each item into its marker band by price.
  for (const m of remaining) bands[String(m)] = { lines: [], done: true };
  let hitLimit = false;
  for (let i = 0; i < ids.length; i += 10) {
    let fetched;
    try { fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + ids.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(search.id)); }
    catch (e) { hitLimit = true; break; }
    for (const r of fetched.result || []) {
      const item = r.item || {};
      const name = item.typeLine || item.baseType || item.name;
      const price = r.listing && r.listing.price;
      if (!name || !price || price.currency !== "divine" || !markerSet.has(Number(price.amount))) continue;
      bands[String(price.amount)].lines.push(name + " x" + (item.stackSize || 1));
    }
  }
  if (hitLimit) for (const m of remaining) bands[String(m)].done = false;   // resume next click
  return { bands, hitLimit, truncated: false };
}

function parseTabLine(l) {
  const m = /^(.*?)\s*x(\d+)\s*$/.exec(l);
  return m ? { name: m[1], qty: Number(m[2]) } : { name: l, qty: 1 };
}

// Shared valuation: price items off the exchange book (cap-fill ≤TAB_FILL_PER_VISIT
// unbooked/visit so it can't burst), build rows + totals. `meta` carries read-state
// fields (markers/unreadBands/truncated/pasted) onto the response.
async function valueTabItems(account, league, items, meta) {
  const nk = (n) => normalizeName(n);
  let book = readRuneBook(league) || { prices: {} };
  // "Booked" = we have a settled answer: a real bid price OR a thin/no-buyers verdict.
  // Both count so a thin item isn't re-fetched on every visit.
  const booked = (n) => { const b = book.prices[nk(n)]; return b && (b.ex > 0 || b.thin); };
  // Fill by UNIQUE name — a 212-item tab is only ~40 distinct types, and the book is
  // keyed by name, so pricing one name values every stack of it. Batching by item
  // (dupes) wasted the per-visit budget and made big tabs take dozens of passes.
  const unbookedNames = [...new Set(items.filter((it) => !booked(it.name)).map((it) => nk(it.name)))];
  if (unbookedNames.length && !tradeStatus().limited) {
    const batch = unbookedNames.slice(0, TAB_FILL_PER_VISIT);
    await Promise.race([
      refreshRuneBook(league, batch, true).catch(() => {}),
      new Promise((r) => setTimeout(r, RUNE_FRESH_DEADLINE_MS)),
    ]);
    book = readRuneBook(league) || book;
  }
  const rates = await getExchangeRates(league);
  const results = items.map((it) => {
    const b = book.prices[nk(it.name)];
    if (b && b.ex > 0) return { qty: it.qty, name: it.name, each: b.ex, total: roundPriceExalted(b.ex * it.qty), source: b.rough ? "exchange · rough" : "trade2 exchange", rough: !!b.rough };
    // Sellers list it but no buyers stand on the exchange — can't value a sale, so
    // say so plainly instead of quoting the aspirational ask. `thin` = settled (not
    // still loading), so the poll completes and it isn't re-fetched.
    if (b && b.thin) {
      // No live buyers, so no firm sell price — but show the cheapest LISTING (ask)
      // as a rough indicative ceiling so the scan can still rank it for triage.
      // Flagged `indicative` + "no live buyers" so it's never mistaken for a firm bid.
      const ask = Number(b.ask) || 0;
      return { qty: it.qty, name: it.name, each: "", total: "", thin: true,
        askTotal: ask > 0 ? roundPriceExalted(ask * it.qty) : "",   // sub-sort hint only; not shown (ask is noisy)
        source: "no live buyers" };
    }
    // Base/curated currencies (Divine, Chaos, …) aren't in the rune book — price
    // them off the exchange rates (keyed by normalized name).
    const rx = rates[nk(it.name)];
    if (rx > 0) return { qty: it.qty, name: it.name, each: rx, total: roundPriceExalted(rx * it.qty), source: "trade2 exchange" };
    return { qty: it.qty, name: it.name, each: "", total: "", source: "pricing…" };
  });
  // Rank so what's actually worth selling is on top. Two tiers: anything with a FIRM
  // (bid) sell value ranks first, by value desc — that's the real "sell these" list.
  // Thin/no-buyer items always sit BELOW the firm ones (their ask is noisy and must
  // never outrank a real price); within that group, higher ask floats up as a weak
  // hint of what might be worth a manual look.
  results.sort((a, b) => {
    const fa = Number(a.total) || 0, fb = Number(b.total) || 0;
    if (fa > 0 || fb > 0) return fb - fa;
    return (Number(b.askTotal) || 0) - (Number(a.askTotal) || 0);
  });
  const totalEx = results.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  const pricedCount = results.filter((r) => r.total).length;
  // Thin items have no firm price but ARE resolved — exclude them from "remaining" so
  // the valuation poll finishes instead of looping on unpriceable items.
  const resolvedCount = results.filter((r) => r.total || r.thin).length;
  return Object.assign({
    account, league, results,
    count: results.length,
    pricedCount,
    thinCount: results.filter((r) => r.thin).length,
    remaining: results.length - resolvedCount,
    totalEx: Math.round(totalEx * 100) / 100,
    totalDiv: rates.divine ? Math.round((totalEx / rates.divine) * 100) / 100 : 0,
    limited: tradeStatus().limited,
    updated: new Date().toISOString(),
  }, meta || {});
}

async function fetchTrackedTab(account, league, refresh, markers, pastedItems, pasteMode) {
  account = String(account || "").trim();
  if (!account) return { error: "Missing account name.", results: [] };

  // PASTE MODE — items came from the browser-side reader (run on pathofexile.com
  // through your VPN), so we skip ALL trade2 reads and just value them. POST sends
  // the items once; auto-poll GETs reuse the cached pasted set to fill prices.
  if (pastedItems != null || pasteMode) {
    let cache = readTabCache(account, league);
    if (pastedItems != null) {
      const lines = String(pastedItems).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return { account, league, results: [], note: "No items pasted.", pasted: true };
      cache = { account, league, markerSig: "pasted", bands: { pasted: { lines, done: true } }, updated: new Date().toISOString() };
      try { fs.writeFileSync(TAB_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
    }
    if (!cache || cache.markerSig !== "pasted" || !cache.bands || !cache.bands.pasted) {
      return { account, league, results: [], note: "Paste your browser-read items first.", pasted: true };
    }
    const items = (cache.bands.pasted.lines || []).map(parseTabLine);
    if (!items.length) return { account, league, results: [], note: "No pasted items.", pasted: true };
    return await valueTabItems(account, league, items, { pasted: true, unreadBands: 0 });
  }

  markers = (markers && markers.length) ? markers : TAB_MARKERS_DEFAULT.slice();
  const markerSig = markers.join(",");

  // 1. Tab contents — per-band cache (10 min). Reuse bands already read; on refresh,
  //    RESUME any not-yet-done bands (a 429 mid-read caches the finished bands so the
  //    next click continues instead of restarting). Price-only polls (refresh=false)
  //    never touch the network — they just re-price the cached lines.
  let cache = readTabCache(account, league);
  const sameSig = cache && cache.markerSig === markerSig && cache.bands;
  const fresh = sameSig && (Date.now() - new Date(cache.updated).getTime() < TAB_CACHE_TTL_MS);
  // ALWAYS serve the cached contents for this marker set, ANY age — so reopening the tab
  // shows your last scan instantly with no Trade2 call. A network re-read happens ONLY on
  // an explicit refresh that needs one: to RESUME unread bands, or to refresh a COMPLETE-
  // but-stale read. (A cooldown can outlast the TTL; partial progress is never wiped.)
  let bands = sameSig ? cache.bands : {};
  let truncated = sameSig ? !!cache.truncated : false;
  let scannedAt = sameSig ? cache.updated : null;
  const isDone = (m) => bands[String(m)] && bands[String(m)].done;
  const allDone = markers.every(isDone);
  const needRead = refresh && !tradeStatus().limited && !(allDone && fresh);

  if (needRead) {
    // Stale-complete → start over (else readTrackedBands skips every done band and re-reads
    // nothing); partial → keep finished bands and resume.
    const base = (allDone && !fresh) ? {} : bands;
    const read = await readTrackedBands(account, league, markers, base);
    bands = read.bands;
    truncated = !!read.truncated;
    scannedAt = new Date().toISOString();
    cache = { account, league, markerSig, bands, truncated, updated: scannedAt };
    try { fs.writeFileSync(TAB_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
  }

  const lines = [];
  for (const m of markers) { const b = bands[String(m)]; if (b && b.lines) lines.push(...b.lines); }
  const unreadBands = markers.filter((m) => !isDone(m)).length;
  const items = lines.map(parseTabLine);

  if (!items.length) {
    if (unreadBands === 0) return { account, league, results: [], note: "No items found priced at " + markerSig + " divine under that account. Price your tracked items at one of those divine values.", markers, unreadBands: 0 };
    return { account, league, results: [], limited: tradeStatus().limited, tradeLimitedUntil: tradeStatus().tradeLimitedUntil, unreadBands, markers };
  }

  return await valueTabItems(account, league, items, { markers, markerSig, unreadBands, truncated, partial: unreadBands > 0, scannedAt });
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

    prices.sort((a, b) => a.each - b.each);
    // Drop lowball baits: a chase item gets a stray "1 ex" listing far under the real
    // cluster (Cadigan's Epiphany lists at ~1 divine but has a 1ex bait on top). An
    // entry under HALF the next is bait → skip it (chained baits drop one at a time),
    // so the returned price is the real cheapest cluster, not the scam.
    let i = 0;
    while (i < prices.length - 1 && prices[i].each < prices[i + 1].each * 0.5) i++;
    return prices[i] || null;
  } catch (err) {
    if (String(err && err.message).includes("rate limited")) return { limited: true };
    return null;
  }
}

// Jewel Pricer floor: a stat-filtered sibling of getTradePrice. Prices a RARE
// jewel by AND-ing its top 2-3 mods (each at the jewel's own rolled floor) so the
// result is "cheapest GOOD jewel like this", not the per-mod junk floor (junk
// jewels vastly outnumber good ones, so a single-mod sort:asc just prices a junk
// jewel that happens to share one mod). De-bait/cluster floor is reused verbatim
// from getTradePrice; `depth` = total matching listings, so a scarce combo reads
// thin (the front end caveats it) instead of fabricating a confident number.
// statFilters: [{ statId, min }]. Verified ids only (jewel-data.js); a wrong id
// silently returns 0 → found:false (a safe failure, never a wrong price).
async function getJewelFloor(league, statFilters, rates, deadline = 0) {
  try {
    if (deadline && Date.now() > deadline) return null;
    if (!statFilters || !statFilters.length) return null;
    const body = JSON.stringify({
      query: {
        status: { option: "any" },
        filters: {
          type_filters: { filters: { category: { option: "jewel" }, rarity: { option: "nonunique" } } },
        },
        stats: [{ type: "and", filters: statFilters.map((f) => ({ id: f.statId, value: { min: Math.floor(f.min) || 1 } })) }],
      },
      sort: { price: "asc" },
    });
    const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
    const search = await fetchTrade(searchUrl, { method: "POST", body });
    const total = Number(search && search.total) || ((search && search.result) ? search.result.length : 0);
    if (!search.result || !search.result.length) return { found: false, ex: 0, depth: 0 };

    const ids = search.result.slice(0, 10).join(",");
    const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + ids + "?query=" + encodeURIComponent(search.id);
    if (deadline && Date.now() > deadline) return null;
    const fetched = await fetchTrade(fetchUrl);
    const prices = [];
    for (const entry of fetched.result || []) {
      const price = entry.listing && entry.listing.price;
      if (!price || !rates[price.currency]) continue;
      const each = Math.round(Number(price.amount) * rates[price.currency] * 100) / 100;
      if (each > 0) prices.push(each);
    }
    prices.sort((a, b) => a - b);
    if (!prices.length) return { found: false, ex: 0, depth: total };
    // Same lowball-bait drop as getTradePrice: skip an entry under HALF the next.
    let i = 0;
    while (i < prices.length - 1 && prices[i] < prices[i + 1] * 0.5) i++;
    return { found: true, ex: prices[i], depth: total, thin: total <= 3 };
  } catch (err) {
    if (String(err && err.message).includes("rate limited")) return { limited: true };
    return null;
  }
}

// ── Unified currency exchange rates (Trade2, cached) ────────────────────────
// THE single source of currency ex-values for the whole app: home strip, Gear
// Search price conversion, Rune Picker currency pricing. Reads GGG's live Trade2
// Currency Exchange (NOT poe.ninja) via the one shared queue (trade-queue.js),
// reusing the arbitrage exchange machinery. File-cached with a TTL so reads are
// instant and the shared rate limit isn't touched unless data is stale / forced;
// when limited it serves the last cache. `rates` is keyed by trade currency id
// AND normalised name (drop-in for the old fetchCurrencyRates); `items` carries
// per-currency ex value + stock + icon for display.
const CURRENCY_RATES_FILE = path.join(DATA_DIR, ".currency-rates.json");
const CURRENCY_RATES_TTL_MS = 10 * 60 * 1000;
const CURRENCY_ALIASES = {
  alch: "orb of alchemy", alchemy: "orb of alchemy", regal: "regal orb",
  annul: "orb of annulment", chance: "orb of chance", transmute: "orb of transmutation",
  augmentation: "orb of augmentation", aug: "orb of augmentation", vaal: "vaal orb",
  gcp: "gemcutter's prism", gemcutter: "gemcutter's prism", artificers: "artificer's orb",
};

function normalizeIconUrl(src) {
  const s = String(src || "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return "https://www.pathofexile.com" + s;
  return s;
}

function readCurrencyRatesCache() {
  try { return JSON.parse(fs.readFileSync(CURRENCY_RATES_FILE, "utf8")); }
  catch { return null; }
}

// Illiquid orbs whose SELL side (asks) is thin and aspirational, so the cheapest
// ask is structurally far above the real market (Transmute resolved 30ex vs a true
// ~0.1; Greater Exalted 44 vs ~3). For these the true rate sits between the deep
// bid and deep ask, so we price them by the GEOMETRIC MID of both sides instead of
// the one-sided cheapest ask. Verified vs the in-game market ratio: within ~1.6x,
// where one-sided was 14-300x high. The liquid staples (divine/chaos/alch/…) stay
// one-sided — they're correct there, and geo-mid would wrongly drag them toward
// their lowball bids. INTERIM: the official cxapi currency-exchange endpoint gives
// exact traded ratios and supersedes all of this once its service scope is granted.
// (Perfect Exalted is NOT here: its book is 1-2 offers, so two-sided is meaningless
// — geo-mid gave 200 vs a ~660 truth where the one-sided cheapest ask gave ~560.)
const TWO_SIDED_IDS = new Set(["transmute", "aug", "greater-exalted-orb"]);

// Geometric mid of the robust deep bid and deep ask, in exalt-per-item. ASK =
// cheapest offer with real stock (skips thin baits) BUT the raw cheapest, not the
// densest cluster (the cluster IS the overpriced wall for these). BID = highest
// buy offer with stock, not crossed above the ask (drops highball baits). Returns
// {ex, stock}; falls back to whichever side exists. The bid side is one extra
// exchange call per item — only paid for the ~4 ids in TWO_SIDED_IDS.
async function geoMidRate(league, id, askData) {
  const asks = collectExchangeOffers(askData, EXALTED_ID, id)
    .filter((o) => o.payAmount > 0 && o.receiveAmount > 0 && (o.receiveStock || 0) >= 5)
    .map((o) => ({ px: o.payAmount / o.receiveAmount, stock: o.receiveStock || 0 }))
    .sort((a, b) => a.px - b.px);
  const askPx = asks.length ? asks[0].px : 0;
  let bidPx = 0;
  try {
    const bidData = await fetchExchangeChunked(league, id, [EXALTED_ID]);
    const bids = collectExchangeOffers(bidData, id, EXALTED_ID)
      .filter((o) => o.payAmount > 0 && o.receiveAmount > 0)
      .map((o) => ({ px: o.receiveAmount / o.payAmount, stock: o.payStock || 0 }))  // exalt per item
      .sort((a, b) => b.px - a.px);
    const ok = (b) => !askPx || b.px <= askPx * 1.05;       // drop bids crossed above ask
    bidPx = (bids.find((b) => b.stock >= 5 && ok(b)) || bids.find(ok) || bids[0] || {}).px || 0;
  } catch {}
  const ex = (askPx > 0 && bidPx > 0) ? Math.sqrt(askPx * bidPx) : (askPx || bidPx || 0);
  return { ex, stock: asks.length ? Math.floor(asks[0].stock) : 0 };
}

// Highest standing BID (exalt-per-item) for `id` from a pre-fetched item→exalted
// exchange page — i.e. what a buyer will actually pay, the real liquidation value.
// Same robust rule as geoMidRate's bid side: prefer real stock (>=5), drop highball
// bids crossed above the ask. Returns 0 if NO buyer stands on the exchange — the
// caller treats that as "thin / no buyers" rather than trusting the aspirational ask.
function robustBidPx(bidData, id, askPx) {
  const bids = collectExchangeOffers(bidData, id, EXALTED_ID)
    .filter((o) => o.payAmount > 0 && o.receiveAmount > 0)
    .map((o) => ({ px: o.receiveAmount / o.payAmount, stock: o.payStock || 0 }))   // exalt per item
    .sort((a, b) => b.px - a.px);
  // Drop bids "crossed" above the ask — a buy offer far over what the item sells for
  // is bait/noise (e.g. a lone "10 ex for an idol" that lists at 3). If nothing passes,
  // return 0 (no real bid) rather than trusting the bait — do NOT fall back to bids[0].
  const ok = (b) => !askPx || b.px <= askPx * 1.05;
  return (bids.find((b) => b.stock >= 5 && ok(b)) || bids.find(ok) || {}).px || 0;
}

// Cheapest ASK (exalt-per-item) = the realistic sell floor: the lowest offer with a
// bit of stock (≥2 skips lone stock-1 baits), falling back to the outright cheapest.
// NOT the clustered "wall" — many books (e.g. idols) have a few cheap real sellers
// under a big overpriced wall, and the cheap ones are what you'd actually undercut to.
function cheapestAsk(askData, id) {
  let asks = collectExchangeOffers(askData, EXALTED_ID, id)
    .filter((o) => o.payAmount > 0 && o.receiveAmount > 0)
    .map((o) => ({ px: o.payAmount / o.receiveAmount, stock: o.receiveStock || 0 }))
    .sort((a, b) => a.px - b.px);
  // Drop par/sub-par floor spam (px ≤ 1). The exchange's practical single-item floor is
  // "1 ex : 1 item", so cheap runes get flooded with ≤1ex asks (especially with the
  // status:"any" read, which pulls in offline spam) — that's NOT a real price for a
  // valuable item, just the floor everyone defaults to. (And an item genuinely worth
  // ≤1ex has no real two-sided exchange market anyway.) What remains is the real book.
  // Without this, Ire/Passion/Breath of Aldur floored at 1ex and read "no buyers"; the
  // old stock≥2 skip hid the spam but wrongly inflated thin chase items (stock-1 = real).
  asks = asks.filter((a) => a.px > 1);
  if (!asks.length) return { px: 0, stock: 0 };
  // De-bait: skip a lone lowball far under the next real ask (Cadigan's Epiphany had a
  // stray cheap ask sitting under a 4444ex one). An ask under HALF the next-cheapest is
  // bait → skip it (chained baits drop one at a time).
  let i = 0;
  while (i < asks.length - 1 && asks[i].px < asks[i + 1].px * 0.5) i++;
  const chosen = asks[i];
  // depth = how many above-floor sellers there are. A deep book (many) = a trustworthy
  // exchange price; a lone wall (1-2) means the exchange ASK is unreliable for this item
  // and the real price lives on the item-search trade board (see refreshRuneBook).
  return { px: chosen.px, stock: chosen.stock, depth: asks.length };
}

// One batched ex→currency exchange call; the best (cheapest) offer per currency
// gives its ex-per-unit value. Goes through fetchExchangeChunked (cap 3) + the
// shared queue, so a full refresh is ~3 calls for the 9 main currencies. The few
// illiquid orbs in TWO_SIDED_IDS each add one bid-side call (see geoMidRate).
// Drop the chained sub-½ lowball bait, return the cheapest remaining ratio + its depth.
function sideCheapestRatio(data, haveId, wantId) {
  const r = collectExchangeOffers(data, haveId, wantId)
    .filter((o) => o.payAmount > 0 && o.receiveAmount > 0)
    .map((o) => o.payAmount / o.receiveAmount)   // have-currency per want-item = price in `have`
    .sort((a, b) => a - b);
  if (!r.length) return null;
  let i = 0;
  while (i < r.length - 1 && r[i] < r[i + 1] * 0.5) i++;   // chained bait drop (Exiled's rule)
  return { px: r[i], depth: r.length - i };
}
// Exiled-Exchange's currency method, ported. ONE bulk-exchange call with
// have=[divine,exalted,chaos], want=[id]; per side take the bait-dropped cheapest
// ratio; prefer the EXALTED side (base unit, the real market for sub-divine items),
// falling back to divine/chaos × their ex-rate only when exalted has no offer.
// Returns ex-per-item. This is why Exiled prices the "unpriceable" alloys/chase orbs:
// the old override claim was wrong — we read only the junk exalted FLOOR (1ex spam) /
// the placeholder divine side, never the real per-item book on the right side.
async function exchangePriceEx(league, wantId, divineEx = 0, chaosEx = 0) {
  if (String(wantId).toLowerCase() === EXALTED_ID) return { ex: 1, side: "exalted", depth: 99 };
  let data;
  try { data = await fetchExchangeRaw(league, ["divine", "exalted", "chaos"], wantId); }
  catch { return null; }
  if (!data || data.limited) return null;
  const ex = sideCheapestRatio(data, "exalted", wantId);
  if (ex) return { ex: round4(ex.px), side: "exalted", depth: ex.depth };
  if (divineEx > 0) { const d = sideCheapestRatio(data, "divine", wantId); if (d) return { ex: round4(d.px * divineEx), side: "divine", depth: d.depth }; }
  if (chaosEx > 0) { const c = sideCheapestRatio(data, "chaos", wantId); if (c) return { ex: round4(c.px * chaosEx), side: "chaos", depth: c.depth }; }
  return null;
}

async function fetchExchangeData(league) {
  const resolved = await resolveArbitrageItems(league);
  const icons = (arbitrageStaticCache && arbitrageStaticCache.iconsById) || {};
  const currencies = resolved.filter((it) => it.category === "currency" && it.id !== EXALTED_ID);
  const buyData = await fetchExchangeChunked(league, EXALTED_ID, currencies.map((c) => c.id));
  const rates = { exalted: 1 };
  const items = [{ id: "exalted", name: "Exalted Orb", ex: 1, stock: 0, icon: normalizeIconUrl(icons.exalted), base: true }];
  for (const c of currencies) {
    let ex, stock;
    if (TWO_SIDED_IDS.has(c.id)) {
      // Illiquid orb: price by the two-sided geo-mid (cheapest ask is far too high).
      const g = await geoMidRate(league, c.id, buyData);
      ex = round4(g.ex); stock = g.stock;
    } else {
      // Prefer a reasonably-stocked offer so one thin lowball listing can't skew
      // the rate; fall back to any offer for genuinely thin currencies.
      const best = bestExchangeOffer(buyData, EXALTED_ID, c.id, 5) || bestExchangeOffer(buyData, EXALTED_ID, c.id, 1);
      if (!best) continue;
      ex = round4(best.payPerReceive); stock = Math.floor(best.receiveStock) || 0;
    }
    if (!(ex > 0)) continue;
    rates[c.id] = ex;
    rates[normalizeName(c.name)] = ex;
    items.push({ id: c.id, name: c.name, ex, stock, icon: normalizeIconUrl(icons[c.id]) });
  }
  for (const [alias, target] of Object.entries(CURRENCY_ALIASES)) {
    const t = rates[normalizeName(target)];
    if (t) rates[alias] = t;
  }
  return { league, rates, items, updated: new Date().toISOString() };
}

// Single-flight background refresh: only one live exchange fetch runs at a time,
// no matter how many readers ask. Writes the cache on success; never throws to
// callers that don't await it.
let exchangeRefreshInFlight = null;
function refreshExchangeData(league) {
  if (exchangeRefreshInFlight) return exchangeRefreshInFlight;
  exchangeRefreshInFlight = (async () => {
    try {
      const data = await fetchExchangeData(league);
      if (data.items.length > 1) { try { fs.writeFileSync(CURRENCY_RATES_FILE, JSON.stringify(data, null, 2)); } catch {} }
      return data;
    } finally {
      exchangeRefreshInFlight = null;
    }
  })();
  return exchangeRefreshInFlight;
}

// THE key to fast-AND-correct: never block a user request on the throttled
// Trade2 queue. If we have ANY cache for this league we serve it immediately and
// kick off a background refresh (stale-while-revalidate) — Trade2 accuracy at
// cache speed. Only the explicit ↻ button (force) waits for fresh numbers, and a
// true cold start (no cache at all) fetches once. A background warmer keeps the
// cache fresh so the cold path almost never hits a user. (Rune/currency prices
// don't move second-to-second, so a few-minutes-stale rate is correct enough.)
async function getExchangeData(league, force) {
  league = sanitizeLeague(league);
  const cached = readCurrencyRatesCache();
  const fresh = cached && cached.league === league && cached.updated &&
    Date.now() - new Date(cached.updated).getTime() < CURRENCY_RATES_TTL_MS;
  if (cached && fresh && !force) return { ...cached, cached: true };

  const haveCacheForLeague = cached && cached.league === league;

  // Explicit refresh (home ↻): wait for fresh data.
  if (force) {
    if (tradeStatus().limited) {
      return haveCacheForLeague ? { ...cached, cached: true, stale: true, limited: true } : { league, rates: { exalted: 1 }, items: [], limited: true };
    }
    try {
      const data = await refreshExchangeData(league);
      return { ...data, cached: false };
    } catch (err) {
      const limited = /rate limited/i.test(String(err && err.message));
      if (haveCacheForLeague) return { ...cached, cached: true, stale: true, limited };
      return { league, rates: { exalted: 1 }, items: [], limited, error: limited ? undefined : String(err && err.message).slice(0, 180) };
    }
  }

  // Stale-while-revalidate: stale cache exists → return it now, refresh in bg.
  if (haveCacheForLeague) {
    if (!tradeStatus().limited) refreshExchangeData(league).catch(() => {});
    return { ...cached, cached: true, stale: true };
  }

  // Cold start (no cache for this league): we have to fetch once.
  if (tradeStatus().limited) return { league, rates: { exalted: 1 }, items: [], limited: true };
  try {
    const data = await refreshExchangeData(league);
    return { ...data, cached: false };
  } catch (err) {
    const limited = /rate limited/i.test(String(err && err.message));
    return { league, rates: { exalted: 1 }, items: [], limited, error: limited ? undefined : String(err && err.message).slice(0, 180) };
  }
}

// Background warmer: refresh the cache shortly BEFORE its TTL expires so user
// requests almost always hit a fresh (or at worst instantly-served stale) cache,
// never the slow path. Single-flight + rate-limit aware = gentle on the shared IP.
async function warmExchange(league = DEFAULT_LEAGUE) {
  const cached = readCurrencyRatesCache();
  const ageMs = cached && cached.updated ? Date.now() - new Date(cached.updated).getTime() : Infinity;
  if (ageMs < CURRENCY_RATES_TTL_MS - 2 * 60 * 1000) return;  // still comfortably fresh
  if (tradeStatus().limited) return;
  try { await refreshExchangeData(sanitizeLeague(league)); } catch {}
}

// ── Economy history (home dashboard) ────────────────────────────────────────
// Sample a handful of HIGH-VALUE currencies (all >= ~1ex; nothing sub-exalt) on a
// twice-a-day cadence and keep a rolling history so the home page can graph what's
// inflating vs. what. Divine is the display unit; values are stored in EXALTS (+
// the ex/div rate) so the front end can render in divine and compute relative
// movement. Prices come from the same bulk Currency Exchange (= the in-game currency
// exchange) the rest of the app uses. Liquid currency is priced against EXALTED; but
// high-value items (omens, Hinekora's Lock) have only junk offers on the exalted side
// and their REAL liquid market is the DIVINE side (e.g. Hinekora's = ~680 div), so
// those are flagged `div: true` and priced against divine, then converted to ex.
const ECONOMY_FILE = path.join(DATA_DIR, ".economy-history.json");
const ECONOMY_SAMPLE_MS = 12 * 60 * 60 * 1000;   // twice a day
const ECONOMY_DEDUPE_MS = 60 * 60 * 1000;        // a manual refresh within 1h updates the last point instead of appending
const ECONOMY_MAX_POINTS = 200;                  // ~3 months at 2/day; caps file size
const ECONOMY_ITEMS = [
  { id: "divine", name: "Divine Orb" },
  { id: "greater-exalted-orb", name: "Greater Exalted Orb" },
  { id: "perfect-exalted-orb", name: "Perfect Exalted Orb" },
  { id: "omen-of-whittling", name: "Omen of Whittling", div: true },
  { id: "omen-of-light", name: "Omen of Light", div: true },
  { id: "hinekoras-lock", name: "Hinekora's Lock", div: true },
  // Mirror is absent: it doesn't trade on the bulk currency exchange (a single
  // ~10k-div price wall on one side, a lowball on the other) so there's no honest
  // Trade2 price to sample. Would need Trade2 item-search to add back.
];
let economySampleInFlight = null;

function readEconomy() {
  try { return JSON.parse(fs.readFileSync(ECONOMY_FILE, "utf8")); } catch { return null; }
}

// Market divine-per-item for high-value items (omens, Hinekora's) off the divine
// side of the bulk exchange. The cheapest offer is NOT the price: these books are
// littered with lowball bait BELOW the real cluster (live omen books ramp 1·2·3·4
// then a wall of 5·6·7 — the 1-4 are traps) plus the odd lone over-priced wall.
// The price is the cheapest offer that sits in a CLUSTER — has >=3 peers within
// ±15%, i.e. where real sellers agree. Isolated baits and lone walls have no peers
// and are skipped no matter how many; taking the cheapest CLUSTERED offer (not the
// densest band) tracks the real fill price without the high bias that standing
// offers create (cheap offers fill and vanish, dear ones pile up). Drops exact-par
// swaps first. Verified vs the live books: Whittling 5, Light 7, Hinekora's 655 div
// (poe.ninja's volume-weighted values were 4.92 / 7.4 / 662.9 — within ~5%).
function divineMarketPrice(data, wantId, minStock) {
  const r = collectExchangeOffers(data, "divine", wantId)
    .filter((o) => o.receiveStock >= minStock && o.receiveAmount > 0 && o.payAmount !== o.receiveAmount)
    .map((o) => o.payAmount / o.receiveAmount)
    .sort((a, b) => a - b);
  if (!r.length) return 0;
  const clustered = r.filter((x) => r.reduce((n, y) => n + (y >= x * 0.85 && y <= x * 1.15 ? 1 : 0), 0) >= 3);
  return (clustered.length ? clustered : r)[0];   // cheapest clustered price (or cheapest if too thin)
}

// Div-side prices (omens, Hinekora's) for the economy panel, in divine-per-item.
// These aren't on the currency strip (the exalted side is junk for them), so they
// get their own divine-side exchange call — but SWR-cached on the SAME 10-min TTL
// the strip uses, so a panel load is cheap and the numbers track live, not a
// twice-a-day snapshot. In-memory: a restart refetches once. (ponytail: no file.)
let economyDivCache = null;        // { league, perDiv:{id:divPrice}, updated }
let economyDivInFlight = null;
function refreshEconomyDivSide(league) {
  if (economyDivInFlight) return economyDivInFlight;
  economyDivInFlight = (async () => {
    try {
      const divIds = ECONOMY_ITEMS.filter((i) => i.div).map((i) => i.id);
      if (!divIds.length) return economyDivCache;
      const buyD = await fetchExchangeChunked(league, "divine", divIds);
      const perDiv = {};
      for (const id of divIds) {
        const p = divineMarketPrice(buyD, id, 2) || divineMarketPrice(buyD, id, 1);
        if (p > 0) perDiv[id] = p;
      }
      if (Object.keys(perDiv).length) economyDivCache = { league, perDiv, updated: new Date().toISOString() };
      return economyDivCache;
    } finally { economyDivInFlight = null; }
  })();
  return economyDivInFlight;
}
async function economyDivSide(league) {
  const mine = economyDivCache && economyDivCache.league === league ? economyDivCache : null;
  const fresh = mine && Date.now() - new Date(mine.updated).getTime() < CURRENCY_RATES_TTL_MS;
  if (fresh) return mine;
  if (tradeStatus().limited) return mine;                 // serve stale if any
  if (mine) { refreshEconomyDivSide(league).catch(() => {}); return mine; }  // stale-while-revalidate
  return refreshEconomyDivSide(league).catch(() => null);  // cold: fetch once
}

// The live "current" economy point. Exalt-side items (Divine, Greater/Perfect
// Exalted) come straight from getExchangeData — the SAME live, SWR-cached rates the
// home currency strip renders — so a shared price like Divine is identical in both
// places and refreshes together. Div-side items are anchored to that same Divine.
async function economyCurrent(league) {
  league = sanitizeLeague(league);
  const exData = await getExchangeData(league).catch(() => null);
  const exPerDiv = (exData && exData.rates && exData.rates.divine) || 0;
  if (!exPerDiv) return null;                              // no Divine anchor → nothing to show
  const chaosEx = (exData.rates && exData.rates.chaos) || 0; // exalted-per-chaos, so the home page can show chaos as the base unit
  const ex = {};
  for (const it of ECONOMY_ITEMS) {
    if (it.div) continue;
    const v = exData.rates[it.id];
    if (v > 0) ex[it.id] = Math.round(v * 100) / 100;
  }
  const dz = await economyDivSide(league);
  if (dz && dz.perDiv) for (const [id, perDiv] of Object.entries(dz.perDiv)) {
    if (perDiv > 0) ex[id] = Math.round(perDiv * exPerDiv * 100) / 100;
  }
  if (Object.keys(ex).length < 2) return null;
  return { t: new Date().toISOString(), exPerDiv, chaosEx, ex };
}

async function sampleEconomy(league) {
  league = sanitizeLeague(league);
  if (tradeStatus().limited) return readEconomy();
  const point = await economyCurrent(league);
  if (!point) return readEconomy();  // nothing useful this pass
  const prev = readEconomy();
  const points = (prev && prev.league === league && Array.isArray(prev.points)) ? prev.points.slice() : [];
  const lastP = points[points.length - 1];
  if (lastP && Date.now() - new Date(lastP.t).getTime() < ECONOMY_DEDUPE_MS) points[points.length - 1] = point;
  else points.push(point);
  while (points.length > ECONOMY_MAX_POINTS) points.shift();
  const out = { league, items: ECONOMY_ITEMS, points, updated: point.t };
  try { fs.writeFileSync(ECONOMY_FILE, JSON.stringify(out, null, 2)); } catch {}
  return out;
}

// Single-flight; only samples when the last point is >= ECONOMY_SAMPLE_MS old
// (twice a day) and the queue is clear. Fire-and-forget from the timer + endpoint.
function maybeSampleEconomy(league = DEFAULT_LEAGUE) {
  if (economySampleInFlight) return economySampleInFlight;
  const prev = readEconomy();
  const last = prev && prev.points && prev.points.length ? new Date(prev.points[prev.points.length - 1].t).getTime() : 0;
  if (Date.now() - last < ECONOMY_SAMPLE_MS) return Promise.resolve(prev);
  if (tradeStatus().limited) return Promise.resolve(prev);
  economySampleInFlight = sampleEconomy(league).catch(() => prev).finally(() => { economySampleInFlight = null; });
  return economySampleInFlight;
}


// ── Rune Picker price book: accurate Trade2 exchange prices for runes/essences/
// soul cores (poe.ninja's PoE2 coverage of these is thin = "useless"). Same bulk
// exchange the currency uses. Served from a persistent cache INSTANTLY (poe.ninja
// stays the fallback for anything not booked yet); missing/stale entries refresh
// in the BACKGROUND off one batched exchange call, so the book fills in from real
// usage and the user never waits. Cheap/illiquid items with no exalted-side offer
// simply stay on the poe.ninja fallback. ───────────────────────────────────────
const RUNE_BOOK_FILE = path.join(DATA_DIR, ".rune-exchange-book.json");
const RUNE_BOOK_TTL_MS = 30 * 60 * 1000;
// Bump when the PRICING LOGIC changes so cached entries written by old logic are
// auto-discarded and re-fetched — otherwise a stale book on the prod volume (which
// survives `--build` redeploys) keeps serving old prices and silently defeats the
// fix. v7 = BID-ONLY (dropped the v5 ask fallback): no standing buyer → thin/no-buyers
// instead of an aspirational ask. The bulk exchange floods cheap items (e.g. Greater
// Storm Rune, real ~79/ex) with par/overpriced asks (1:1, 2:1) + zero bids, which the
// ask-fallback mis-priced at a fake ~1-2ex. v6 = v5 + `rough` flag; v5 = bid-else-ask
// (ignores the overpriced wall); v4 = clustered ask; v3 = deep-ask; v2 = bid-only.
const RUNE_BOOK_VERSION = 10;
// Bound the on-demand "Fetch fresh prices" wait — the shared queue self-throttles
// (its inter-call gap grows to several seconds under load), so a forced refresh of
// a handful of items can take 20-40s. Give it real headroom so a SINGLE press
// usually returns live prices; past this we fall back to the book/poe.ninja rather
// than hang forever. The front-end shows a spinner for the duration.
const RUNE_FRESH_DEADLINE_MS = 35 * 1000;
let runeBookRefreshInFlight = null; // Promise | null while a refresh is running

function readRuneBook(league) {
  try {
    const b = JSON.parse(fs.readFileSync(RUNE_BOOK_FILE, "utf8"));
    // Ignore a book from an older pricing-logic version → it gets re-fetched fresh.
    if (!b || b.league !== league || b.version !== RUNE_BOOK_VERSION) return null;
    return b;
  } catch { return null; }
}

// Batch-price the given normalized names off the exchange and merge into the
// book. Single-flight: if a refresh is already running, a background caller is
// satisfied by it (won't pile on); a forced on-demand caller (`force`, the "Fetch
// fresh prices" button) waits it out then runs its own pass for its exact norms so
// the response reflects fresh prices. Skips currency (priced elsewhere).
async function refreshRuneBook(league, normNames, force, opts = {}) {
  if (tradeStatus().limited || !normNames.length) return;
  while (runeBookRefreshInFlight) {
    try { await runeBookRefreshInFlight; } catch {}
    if (!force) return;
  }
  runeBookRefreshInFlight = (async () => {
    try {
      const catalog = await getExchangeCatalog(league);
      // Skip only the base unit + the curated currencies getExchangeData already
      // prices (avoid redundant exchange calls). Everything else on the exchange —
      // runes, essences, soul cores, AND utility currencies the curated set doesn't
      // cover (whetstones, scraps, etchers, …) — is fair game for the book. (The old
      // blanket `category !== "Currency"` skip wrongly dropped those utilities, so
      // they came back NOT FOUND.)
      const curatedIds = new Set(
        (await resolveArbitrageItems(league))
          .filter((it) => it.category === "currency")
          .map((it) => String(it.id))
      );
      const targets = [];
      const seenId = new Set();
      for (const nn of normNames) {
        const entry = catalog.get(nn);
        if (entry && entry.id !== EXALTED_ID && !curatedIds.has(String(entry.id)) && !seenId.has(entry.id)) {
          seenId.add(entry.id);
          targets.push({ ...entry, norm: nn });
        }
      }
      if (!targets.length) return;
      // Two batched legs (same pattern as the arbitrage scan): the ASK side (give
      // exalted, get item) and the BID side (give item, get exalted). The cheapest
      // ASK is aspirational for thin currency — a lone "1 essence : 5 ex" single —
      // so we price off the BID (what buyers actually pay = the real liquidation
      // value). When NO buyer stands on the exchange, we DON'T trust the ask: the
      // item is marked `thin` so consumers show "no buyers" instead of a fake price.
      // Bigger batch (10, just under the API's ~11 cap) + no per-item backfill →
      // far fewer calls so a big tab doesn't trip GGG's 30-per-5-min ban. Illiquid
      // items that get no offers in a batch correctly fall through to thin/no-buyers.
      // status:"any" (NOT online-only): high-value chase items (Cadigan's Epiphany,
      // Astrid's Creativity) often have NO seller online at any given moment, so an
      // online-only book read returned ZERO offers → priced them "no buyers" despite a
      // real market. "any" includes offline listings (you still whisper/trade them).
      // ASK leg. The exchange returns ONE capped page (~100 listings TOTAL across all
      // want-items), so a single high-volume SPAM item (Greater Storm Rune: 99 of 100
      // listings, all 1ex) starves every other item in a shared batch to ZERO asks →
      // they wrongly read "no buyers". No batch size fixes this — one whale floods any
      // batch. So the Rune Picker (`opts.perItemAsk`) fetches the ask leg PER ITEM
      // (batchCap 1 → each item gets its own full page; reward-screen pastes are small,
      // so the extra calls are fine and the queue self-paces). Tab Tracker keeps the
      // batched read (triage over big tabs — protect its call budget) with starvation
      // backfill (skipBackfill=false) to recover the fully-starved few it can.
      // ASK leg: batched (one ~10-item page covers a whole reward paste) + starvation
      // backfill. If a spam whale (Greater Storm Rune = 99/100 listings) floods the
      // shared page and zeroes an item to no offers, fetchExchangeChunked re-fetches
      // just that item solo (skipBackfill=false). This is FAST for the common paste —
      // ~1 call, not one-per-item — and still recovers the starved few. (Was blanket
      // per-item = N calls every time, needlessly slow when no whale is even pasted;
      // that was the Rune Picker "slow" regression.) The item-search fallback below
      // still gives chase items their real price.
      const askData = await fetchExchangeChunked(league, EXALTED_ID, targets.map((t) => t.id), RUNE_BOOK_BATCH, false, "any");
      const bidData = await fetchExchangeChunked(league, targets.map((t) => t.id), [EXALTED_ID], RUNE_BOOK_BATCH, true, "any");
      const existing = readRuneBook(league);
      const prices = existing ? { ...existing.prices } : {};
      const now = new Date().toISOString();
      // Item-search fallback budget (Rune Picker only). The bulk exchange is the WRONG
      // source for chase items: the real trades clear instantly at the market ratio and
      // don't sit as standing offers, so the offer book is just a lone bait + a greedy
      // wall (Cadigan's Epiphany: 1ex + 4444ex, while the in-game Market Ratio is 576:1).
      // The actual price lives on the item-search trade board. When the exchange ask book
      // is too thin to trust (a lone wall, not a real cluster) we look it up there — but
      // BUDGETED LOW: item-search is search+fetch per item on a MUCH tighter rate policy
      // than the exchange — a few in a row trip it and poison the whole fill. 2 per fill
      // covers the real workflow (price a chase item or two); the rest of a big paste
      // fall back to the exchange ask and resolve over later checks.
      let searchBudget = opts.perItemAsk ? 2 : 0;
      const rates = opts.perItemAsk ? await getExchangeRates(league).catch(() => null) : null;
      for (const t of targets) {
        // Price off the BID (what buyers actually pay = real liquidation value). The ASK
        // side is NOT a price for thin items: GGG's bulk exchange floods cheap items
        // (e.g. Greater Storm Rune, real ~79/ex) with aspirational/par asks (1:1, 2:1 …)
        // and no buyers — an ask-fallback mis-priced those at a fake ~1-2ex. So: a real
        // standing bid IS the price; NO bid → thin / "no buyers" (don't fabricate from
        // the ask). Same handling as essences. (ask kept only for stock + crossed-bid ref.)
        const ask = cheapestAsk(askData, t.id);
        const bidPx = robustBidPx(bidData, t.id, ask.px || 0);   // real, non-crossed bid only
        const common = { id: t.id, name: t.name, category: t.category, updated: now };
        // The exchange ASK book is "thin/wall-y" when there are ≤3 above-floor sellers —
        // a lone greedy wall, not a real cluster, so its price isn't trustworthy (Cadigan's
        // one 4444ex wall vs the true 576ex). A deep book (≥4) is a real market we trust.
        const thinAskBook = ask.depth >= 1 && ask.depth <= 3;
        if (bidPx > 0) {
          prices[t.norm] = { ...common, ex: round4(bidPx), stock: Math.floor(ask.stock) || 0, side: "bid" };
        } else if (rates && ask.depth >= 1 && thinAskBook && searchBudget > 0) {
          // Valuable item (someone's asking real ex for it) but the exchange book is a
          // thin wall → get the true price from the item-search trade board, where chase
          // items actually list and cluster. De-baited + ex-converted in getTradePrice.
          searchBudget--;
          const tp = await getTradePrice(t.name, league, rates);
          if (tp && tp.limited) searchBudget = 0;   // hit the tight search limit → stop; rest fall back to ask
          if (tp && !tp.limited && tp.each >= 2) {
            prices[t.norm] = { ...common, ex: round4(tp.each), stock: 0, side: "market" };
          } else if (ask.px >= 2) {
            prices[t.norm] = { ...common, ex: round4(ask.px), stock: Math.floor(ask.stock) || 0, side: "ask" };
          } else {
            prices[t.norm] = { ...common, ex: 0, thin: true, stock: 0 };
          }
        } else if (ask.px >= 2) {
          // No bid, but a real (deep-enough) ask cluster. Price off the lowest de-baited
          // ask — the sell-side floor. Covers the liquid "of Aldur" runes (many sellers)
          // and Astrid's-style items. GATE: ≥ 2 ex/item — the spam guard, since sub-1ex
          // runes (Greater Storm/Iron) all floor at par 1ex and get filtered to nothing.
          prices[t.norm] = { ...common, ex: round4(ask.px), stock: Math.floor(ask.stock) || 0, side: "ask" };
        } else {
          // No bid AND no real ask market → not liquidatable on the exchange. Mark thin
          // so it shows "no buyers" instead of a fabricated price (or looping "pricing…").
          prices[t.norm] = { ...common, ex: 0, thin: true, stock: 0 };
        }
      }
      try { fs.writeFileSync(RUNE_BOOK_FILE, JSON.stringify({ league, version: RUNE_BOOK_VERSION, prices, updated: now }, null, 2)); } catch {}
    } catch {
      // best-effort; the poe.ninja fallback already served the user
    } finally {
      runeBookRefreshInFlight = null;
    }
  })();
  return runeBookRefreshInFlight;
}

// Drop-in for the old poe.ninja fetchCurrencyRates: just the id/name→ex map.
async function getExchangeRates(league) {
  return (await getExchangeData(league)).rates;
}
// Back-compat alias for the home strip endpoint.
const getCurrencyOverview = getExchangeData;

// ── Waystone market-weight sweep (Map Juicer "refresh weights") ─────────────
// Re-derives how much the market pays for each waystone reward stat by reading
// the cheapest exalted-priced Tier-N listing at increasing stat thresholds.
// Goes through the shared adaptive Trade2 queue; cached to a file + rate-limit
// + cooldown guarded so a button click can't exhaust the shared limit.
const WAYSTONE_WEIGHTS_FILE = path.join(DATA_DIR, ".waystone-weights.json");
const WAYSTONE_SWEEP_COOLDOWN_MS = 2 * 60 * 1000;
const WAYSTONE_SWEEP = {
  tier: 16,
  // Multiple thresholds per stat → a price-vs-% CURVE (the same % isn't
  // comparable across stats, so a flat weight misleads). 10 searches incl.
  // baseline; cooldown + queue keep it gentle on the shared limit.
  stats: [
    { key: "itemRarity", label: "Item Rarity", filter: "map_iir", prop: "Item Rarity", thresholds: [30, 50, 70], tip: "Highest ceiling and the top chase — explodes past ~60%." },
    { key: "packSize", label: "Pack Size", filter: "map_packsize", prop: "Pack Size", thresholds: [20, 30, 40], tip: "Best value per % at mid rolls; caps ~40%." },
    { key: "monsterEffectiveness", label: "Monster Effectiveness", filter: "map_magic_monsters", prop: "Monster Effectiveness", thresholds: [20, 40], tip: "Tracks Pack Size; peaks ~40%." },
    { key: "monsterRarity", label: "Monster Rarity", filter: "map_rare_monsters", prop: "Monster Rarity", thresholds: [40], tip: "Worthless even at high rolls." },
  ],
};

function readWaystoneWeights() {
  try { return JSON.parse(fs.readFileSync(WAYSTONE_WEIGHTS_FILE, "utf8")); }
  catch { return null; }
}

// Robust floor: dodge a single AFK/mispriced listing by preferring the 2nd
// cheapest when the cheapest is less than half of it.
function robustWaystoneFloor(prices) {
  const sorted = prices.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length >= 2 && sorted[0] < sorted[1] * 0.5) return sorted[1];
  return sorted[0];
}

function waystonePropVal(item, key) {
  const p = (item.properties || []).find((pr) => String(pr.name || "").includes(key));
  if (!p) return 0;
  return Number(String(((p.values || [])[0] || [])[0] || "").replace(/[+%]/g, "")) || 0;
}

async function waystoneFloor(league, mapFilters, prop) {
  const body = JSON.stringify({
    query: {
      status: { option: "any" },
      filters: {
        type_filters: { filters: { category: { option: "map.waystone" } } },
        map_filters: { filters: Object.assign({ map_tier: { min: WAYSTONE_SWEEP.tier, max: WAYSTONE_SWEEP.tier } }, mapFilters) },
        trade_filters: { filters: { price: { option: "exalted" } } },
      },
    },
    sort: { price: "asc" },
  });
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const search = await fetchTrade(searchUrl, { method: "POST", body });
  const ids = (search.result || []).slice(0, 8);
  const total = (search.result || []).length;
  if (!ids.length) return { total: 0, floor: null, maxRoll: 0 };
  const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + ids.join(",") + "?query=" + encodeURIComponent(search.id);
  const fetched = await fetchTrade(fetchUrl);
  const rows = (fetched.result || [])
    .filter((e) => e && e.item && e.listing && e.listing.price && e.listing.price.currency === "exalted")
    .map((e) => ({ p: Number(e.listing.price.amount), roll: prop ? waystonePropVal(e.item, prop) : 0 }))
    .filter((r) => r.p > 0);
  return { total, floor: robustWaystoneFloor(rows.map((r) => r.p)), maxRoll: Math.max(0, ...rows.map((r) => r.roll)) };
}

// One sweep is ~30 Trade2 calls; a single slow request used to abort (timeout) and
// throw, nuking the whole refresh with "This operation was aborted". Make each point
// best-effort: a transient failure (abort/timeout/network) just skips that point, the
// curve fills from the rest. Only a real rate-limit propagates (so the UI can show
// the cooldown); a sweep that collected NOTHING throws so the cache is kept.
async function waystoneFloorSafe(league, mapFilters, prop) {
  try {
    return await waystoneFloor(league, mapFilters, prop);
  } catch (err) {
    if (/rate limited/i.test(String(err && err.message))) throw err;
    return { total: 0, floor: null, maxRoll: 0, skipped: true };
  }
}

async function runWaystoneSweep(league) {
  const baseline = await waystoneFloorSafe(league, {});
  const base = baseline.floor || 1;
  const stats = [];
  let points = 0;
  for (const s of WAYSTONE_SWEEP.stats) {
    const curve = [];
    let ceiling = 0;
    for (const t of s.thresholds) {
      const r = await waystoneFloorSafe(league, { [s.filter]: { min: t } }, s.prop);
      if (r.floor != null) { curve.push([t, Math.round(r.floor)]); points++; }
      ceiling = Math.max(ceiling, r.maxRoll || 0);
    }
    const peakEx = curve.length ? curve[curve.length - 1][1] : 0;
    stats.push({ key: s.key, label: s.label, tip: s.tip, curve, ceiling, peakEx });
  }
  if (!points) throw new Error("sweep returned no data — market may be slow, try again");
  const maxPeak = Math.max(1, ...stats.map((st) => st.peakEx));
  for (const st of stats) st.weight = Math.round((st.peakEx / maxPeak) * 100) / 100;
  stats.sort((a, b) => b.peakEx - a.peakEx);
  return {
    source: "PoE2 Trade2 — Waystone (Tier " + WAYSTONE_SWEEP.tier + ") price-vs-% curve sweep (live refresh)",
    analyzed: new Date().toISOString().slice(0, 10),
    league,
    baselineEx: Math.round(base),
    note: "Value depends on the rolled %, not just which stat. Read each stat's curve.",
    stats,
    updated: new Date().toISOString(),
  };
}

// ── Official Currency Exchange rate (Map Juicer div↔ex readout) ────────────
// Reads GGG's live bulk Currency Exchange (the in-game book), NOT poe.ninja.
// Cached with a TTL so a page load triggers at most one trade call per window;
// falls back to the last cached value (or {limited}) when the queue is blocked.
const WAYSTONE_EXCHANGE_FILE = path.join(DATA_DIR, ".waystone-exchange.json");
const EXCHANGE_TTL_MS = 5 * 60 * 1000;

function readExchangeCache() {
  try { return JSON.parse(fs.readFileSync(WAYSTONE_EXCHANGE_FILE, "utf8")); }
  catch { return null; }
}

// Best buyer rate (cheapest exalted-per-divine) with non-trivial stock, so a
// single tiny-stock outlier can't skew the headline number.
function bestExchangeRate(result) {
  const offers = [];
  for (const k of Object.keys(result || {})) {
    const o = result[k];
    const arr = (o.listing && o.listing.offers) || o.offers || (Array.isArray(o) ? o : []);
    for (const off of arr) {
      if (off && off.exchange && off.item && off.item.amount > 0) {
        offers.push({ rate: off.exchange.amount / off.item.amount, stock: Number(off.item.stock) || 0 });
      }
    }
  }
  if (!offers.length) return null;
  offers.sort((a, b) => a.rate - b.rate);
  const solid = offers.find((o) => o.stock >= 5) || offers[0];
  return Math.round(solid.rate * 100) / 100;
}

async function fetchExchangeRate(league) {
  const url = "https://www.pathofexile.com/api/trade2/exchange/poe2/" + encodeURIComponent(league);
  const body = JSON.stringify({ query: { status: { option: "online" }, have: ["exalted"], want: ["divine"] }, sort: { have: "asc" }, engine: "new" });
  const d = await fetchTrade(url, { method: "POST", body });
  return { exPerDiv: bestExchangeRate(d.result), offers: d.total || 0, updated: new Date().toISOString() };
}

async function getWaystoneExchange(league) {
  const cached = readExchangeCache();
  if (cached && cached.updated && Date.now() - new Date(cached.updated).getTime() < EXCHANGE_TTL_MS) {
    return { ...cached, cached: true };
  }
  if (tradeStatus().limited) {
    return cached ? { ...cached, stale: true, limited: true } : { limited: true };
  }
  try {
    const fresh = await fetchExchangeRate(league);
    if (fresh.exPerDiv) { try { fs.writeFileSync(WAYSTONE_EXCHANGE_FILE, JSON.stringify(fresh, null, 2)); } catch {} }
    return { ...fresh, cached: false };
  } catch (err) {
    const limited = /rate limited/i.test(String(err && err.message));
    return cached ? { ...cached, stale: true, limited } : { limited, error: limited ? undefined : String(err && err.message) };
  }
}

// Disabled: this powered the now-blanked craft-pricer off poe.ninja, which is BANNED.
// Returns empty so /api/prices stays a valid (dead) endpoint; rebuild on Trade2 if the
// craft-pricer comes back. ponytail: stub, not deleted — the route still references it.
async function fetchPrices() {
  return { prices: {}, divineRate: 0, count: 0, disabled: "poe.ninja removed", updated: new Date().toISOString() };
}

function seededRandom(seed) {
  let value = 2166136261;
  for (const ch of String(seed || "poe2-optimizer")) {
    value ^= ch.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mergeWeights(overrides = {}) {
  const weights = { ...QUIVER_MOD_POOL };
  for (const [key, value] of Object.entries(overrides || {})) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) weights[key] = n;
  }
  return weights;
}

function rollWeighted(weights, random) {
  const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  let roll = random() * total;
  for (const [key, value] of entries) {
    roll -= Number(value);
    if (roll <= 0) return key;
  }
  return entries.length ? entries[entries.length - 1][0] : "fillerPrefix";
}

function materialCostEx(route, materials, overrides = {}) {
  let total = Number(route.baseCostEx) || 0;
  const lines = [{ name: "Base / setup", id: "base", qty: 1, eachEx: roundPriceExalted(total), totalEx: roundPriceExalted(total), source: "default" }];

  for (const mat of route.materials || []) {
    const override = Number(overrides[mat.id]);
    const found = materials.byId[mat.id] || materials.byName[normalizeName(mat.id)];
    const each = Number.isFinite(override) && override > 0 ? override : Number(found && found.priceEx) || 0;
    const lineTotal = each * (Number(mat.qty) || 1);
    total += lineTotal;
    lines.push({
      name: found && found.name ? found.name : mat.id,
      id: mat.id,
      qty: Number(mat.qty) || 1,
      eachEx: roundPriceExalted(each),
      totalEx: roundPriceExalted(lineTotal),
      source: Number.isFinite(override) && override > 0 ? "override" : found ? found.source : "missing",
    });
  }

  return { totalEx: roundPriceExalted(total), lines };
}

function simulateRoute(target, route, materials, options = {}) {
  const iterations = Math.max(1000, Math.min(100000, Number(options.iterations) || OPTIMIZER_ITERATIONS));
  const random = seededRandom((options.seed || "") + ":" + target.id + ":" + route.id);
  const weights = mergeWeights(options.modWeightOverrides);
  const costs = materialCostEx(route, materials, options.priceOverrides || {});
  let successes = 0;

  if (Number.isFinite(Number(route.fixedSuccessRate))) {
    successes = Math.round(iterations * Math.max(0, Math.min(1, Number(route.fixedSuccessRate))));
  } else {
    for (let i = 0; i < iterations; i++) {
      let ok = random() <= (Number(route.fractureChance) || 1);
      for (const check of route.checks || []) {
        if (!ok) break;
        const hit = rollWeighted(weights, random);
        ok = (check.accepts || []).includes(hit);
      }
      if (ok) successes++;
    }
  }

  const sampledSuccessRate = successes / iterations;
  const successRate = sampledSuccessRate > 0 ? sampledSuccessRate : 1 / (iterations + 1);
  const failRate = 1 - successRate;
  const failCredit = (Number(route.salvageEx) || 0) * failRate;
  const expectedCostEx = successRate > 0
    ? roundPriceExalted(Math.max(0, costs.totalEx - failCredit) / successRate)
    : 0;
  const viable = sampledSuccessRate >= 0.005 && expectedCostEx < 100000;

  return {
    routeId: route.id,
    routeName: route.name,
    confidence: route.confidence,
    iterations,
    sampledSuccesses: successes,
    zeroHitSample: sampledSuccessRate === 0,
    viable,
    viabilityNote: viable ? "" : "Not viable with current sampled odds/material prices",
    attemptCostEx: costs.totalEx,
    expectedCostEx,
    successRate: Math.round(successRate * 1000000) / 1000000,
    brickRisk: Math.round(failRate * 1000000) / 1000000,
    materialLines: costs.lines,
  };
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return roundPriceExalted(sorted[idx]);
}

function listingPriceEx(price, currencyRates) {
  if (!price) return 0;
  const amount = Number(price.amount);
  const rate = Number(currencyRates[price.currency]);
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || amount <= 0 || rate <= 0) return 0;
  return amount * rate;
}

function buildComparableSearch(target, tradeStats = target.tradeStats) {
  return {
    query: {
      status: { option: "any" },
      filters: {
        type_filters: {
          filters: {
            category: { option: QUIVER_CATEGORY },
            rarity: { option: "nonunique" },
          },
        },
        misc_filters: {
          filters: {
            ilvl: { min: 75 },
            corrupted: { option: "false" },
          },
        },
      },
      stats: [{
        type: "and",
        filters: tradeStats.map((stat) => {
          const filter = { id: stat.id };
          if (stat.value) filter.value = stat.value;
          return filter;
        }),
      }],
    },
    sort: { price: "asc" },
  };
}

async function fetchComparablePrices(target, league, currencyRates, fallback = false) {
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const cacheKey = league + "|" + target.id + "|" + (fallback ? "fallback" : "strict");
  const cached = comparableCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < COMPARABLE_CACHE_MS) {
    return { ...cached.value, cached: true };
  }

  const status = tradeStatus();
  if (status.limited) {
    if (cached) return { ...cached.value, cached: true, stale: true, limited: true, tradeLimitedUntil: status.tradeLimitedUntil };
    return { targetId: target.id, count: 0, listings: [], quickSaleEx: 0, normalSaleEx: 0, premiumSaleEx: 0, confidence: "limited", liquidity: "unknown", limited: true, tradeLimitedUntil: status.tradeLimitedUntil };
  }

  try {
    const search = await fetchTrade(searchUrl, { method: "POST", body: JSON.stringify(buildComparableSearch(target, fallback ? target.fallbackTradeStats : target.tradeStats)) });
    const ids = (search.result || []).slice(0, 10);
    if (!ids.length) {
      if (!fallback && target.fallbackTradeStats) {
        const fallbackResult = await fetchComparablePrices(target, league, currencyRates, true);
        return {
          ...fallbackResult,
          fallbackUsed: true,
          confidence: fallbackResult.confidence === "none" ? "none" : "fallback",
          notes: "Strict target had no listings; using relaxed +1 projectile comparable baseline.",
        };
      }
      const emptyResult = { targetId: target.id, count: 0, listings: [], quickSaleEx: 0, normalSaleEx: 0, premiumSaleEx: 0, confidence: "none", liquidity: "none" };
      comparableCache.set(cacheKey, { cachedAt: Date.now(), value: emptyResult });
      return emptyResult;
    }

    const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + ids.join(",") + "?query=" + encodeURIComponent(search.id);
    const fetched = await fetchTrade(fetchUrl);
    const listings = [];

    for (const entry of fetched.result || []) {
      const price = entry.listing && entry.listing.price;
      const priceEx = listingPriceEx(price, currencyRates);
      if (!(priceEx > 0)) continue;
      const item = entry.item || {};
      if (item.corrupted) continue;
      if (item.rarity && String(item.rarity).toLowerCase() === "unique") continue;
      listings.push({
        id: entry.id,
        itemName: [item.name, item.typeLine].filter(Boolean).join(" ").trim() || item.typeLine || "Quiver",
        priceEx: roundPriceExalted(priceEx),
        rawPrice: price.amount + " " + price.currency,
        whisper: entry.listing && entry.listing.whisper ? entry.listing.whisper : "",
      });
    }

    const prices = listings.map((item) => item.priceEx).sort((a, b) => a - b);
    const confidence = prices.length >= 12 ? "high" : prices.length >= 5 ? "medium" : prices.length > 0 ? "low" : "none";
    const liquidity = prices.length >= 15 ? "high" : prices.length >= 6 ? "medium" : prices.length > 0 ? "thin" : "none";

    const result = {
      targetId: target.id,
      count: listings.length,
      tradeTotal: Number(search.total) || 0,
      listings,
      quickSaleEx: percentile(prices, 0.2),
      normalSaleEx: percentile(prices, 0.5),
      premiumSaleEx: percentile(prices, 0.75),
      confidence,
      liquidity,
      fallbackUsed: fallback,
      notes: fallback ? "Strict target had no listings; using relaxed comparable baseline." : "",
    };
    comparableCache.set(cacheKey, { cachedAt: Date.now(), value: result });
    return result;
  } catch (err) {
    if (String(err && err.message).includes("rate limited")) {
      const status = tradeStatus();
      if (cached) return { ...cached.value, cached: true, stale: true, limited: true, tradeLimitedUntil: status.tradeLimitedUntil };
      return { targetId: target.id, count: 0, listings: [], quickSaleEx: 0, normalSaleEx: 0, premiumSaleEx: 0, confidence: "limited", liquidity: "unknown", limited: true, tradeLimitedUntil: status.tradeLimitedUntil };
    }
    return { targetId: target.id, count: 0, listings: [], quickSaleEx: 0, normalSaleEx: 0, premiumSaleEx: 0, confidence: "error", liquidity: "unknown", error: err.message };
  }
}

async function fetchOptimizerMaterials(league) {
  // poe.ninja is BANNED, and it was the catalog source for runes/essences/etc. here.
  // Until the experimental optimizer is rebuilt on Trade2, materials are limited to
  // the Trade2 currency rates below (byId stays empty). ponytail: degraded, not torn
  // out — the optimizer endpoints still call this and expect the same shape.
  const currencyRates = await getExchangeRates(league);
  const byId = {};
  const byName = {};

  for (const [alias, target] of Object.entries({
    exalted: "Exalted Orb",
    divine: "Divine Orb",
    chaos: "Chaos Orb",
  })) {
    const priceEx = Number(currencyRates[alias]);
    if (priceEx > 0) byName[normalizeName(target)] = { id: alias, name: target, type: "Currency", priceEx, confidence: "high", units: null, source: "currency-rates" };
  }

  return { league, currencyRates, byId, byName, count: Object.keys(byId).length, updated: new Date().toISOString() };
}

function summarizeOpportunity(target, comparable, simulations) {
  const rawSaleEstimateEx = comparable.normalSaleEx || comparable.quickSaleEx || 0;
  const saleEstimateEx = comparable.fallbackUsed || rawSaleEstimateEx < MIN_TARGET_SALE_EX ? 0 : rawSaleEstimateEx;
  const notOpportunityReason = comparable.fallbackUsed
    ? "Strict target has no listings; relaxed baseline is not used as target value."
    : rawSaleEstimateEx > 0 && rawSaleEstimateEx < MIN_TARGET_SALE_EX
      ? "Median comparable is below " + MIN_TARGET_SALE_EX + " ex minimum target value."
      : "";
  const ranked = simulations.map((sim) => {
    const expectedProfitEx = saleEstimateEx > 0 && sim.expectedCostEx > 0 && sim.viable ? roundPriceExalted(saleEstimateEx - sim.expectedCostEx) : 0;
    return {
      ...sim,
      saleEstimateEx,
      expectedProfitEx,
      roi: sim.expectedCostEx > 0 ? Math.round((expectedProfitEx / sim.expectedCostEx) * 10000) / 10000 : 0,
      capitalRequiredEx: sim.attemptCostEx,
    };
  }).sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1;
    return b.expectedProfitEx - a.expectedProfitEx;
  });

  const bestRoute = ranked[0] || null;
  return {
    targetId: target.id,
    targetName: target.name,
    targetFamily: target.family,
    notes: target.notes,
    saleEstimateEx,
    rawSaleEstimateEx,
    minTargetSaleEx: MIN_TARGET_SALE_EX,
    isOpportunity: saleEstimateEx >= MIN_TARGET_SALE_EX,
    notOpportunityReason,
    quickSaleEx: comparable.quickSaleEx,
    normalSaleEx: comparable.normalSaleEx,
    premiumSaleEx: comparable.premiumSaleEx,
    comparableCount: comparable.count,
    tradeTotal: comparable.tradeTotal || 0,
    liquidity: comparable.liquidity,
    confidence: comparable.confidence,
    comparableFallbackUsed: Boolean(comparable.fallbackUsed),
    comparableNotes: comparable.notes || "",
    comparableCached: Boolean(comparable.cached),
    comparableStale: Boolean(comparable.stale),
    limited: Boolean(comparable.limited),
    error: comparable.error || "",
    tradeLimitedUntil: comparable.tradeLimitedUntil || "",
    bestRoute,
    routes: ranked,
    sampleListings: (comparable.listings || []).slice(0, 8),
  };
}

async function buildOptimizerOpportunities(league, options = {}) {
  const family = options.family || "quiver";
  const materials = await fetchOptimizerMaterials(league);
  const targets = QUIVER_TARGETS.filter((target) => target.family === family);
  const opportunities = [];

  for (const target of targets) {
    const comparable = await fetchComparablePrices(target, league, materials.currencyRates);
    const simulations = target.routes
      .map((routeId) => QUIVER_ROUTES[routeId])
      .filter(Boolean)
      .map((route) => simulateRoute(target, route, materials, {
        iterations: options.iterations,
        seed: league,
        priceOverrides: options.priceOverrides,
        modWeightOverrides: options.modWeightOverrides,
      }));
    opportunities.push(summarizeOpportunity(target, comparable, simulations));
  }

  opportunities.sort((a, b) => {
    const bp = b.bestRoute ? b.bestRoute.expectedProfitEx : -Infinity;
    const ap = a.bestRoute ? a.bestRoute.expectedProfitEx : -Infinity;
    return bp - ap;
  });

  return {
    league,
    family,
    currencyRates: materials.currencyRates,
    materialCount: materials.count,
    opportunities,
    targets: QUIVER_TARGETS,
    routes: Object.values(QUIVER_ROUTES),
    updated: new Date().toISOString(),
  };
}

// Pre-pass: normalized names of pasted item lines that should be priced from the
// rune book — mirrors the main loop's line cleaning so the forced-fresh path can
// refresh those exact items BEFORE pricing. Skips skill/support lines (priced via
// live trade, not the book) and bare gems / junk lines, same as the main loop.
function runePastedNorms(limitedRawLines) {
  const norms = [];
  const seen = new Set();
  for (const rawName of limitedRawLines) {
    const parsed = stripQuantity(rawName);
    if (/^\s*(Skill|Support)\s*:/i.test(parsed.text)) continue;
    const cleanName = parsed.text.replace(/^\s*[|:\-•]*\s*/, "").replace(/\s+/g, " ").trim();
    const looksLikeBareGem = /^Uncut (Skill|Spirit|Support) Gem/i.test(cleanName) && !/\d/.test(cleanName);
    if (cleanName.length < 3 || !/[A-Za-z]{3,}/.test(cleanName) || looksLikeBareGem) continue;
    const norm = normalizeName(cleanName);
    if (seen.has(norm)) continue;
    seen.add(norm);
    norms.push(norm);
  }
  return norms;
}

// ── Currency-exchange-ratio overrides ──────────────────────────────────────
// FALLBACK ONLY (2026-06-26). We used to believe the Verisium "alloys" etc. couldn't
// be priced from GGG's Trade2 offer API — but that was because the old code read only
// the placeholder exalted FLOOR (1ex spam) / the wrong side. Exiled-Exchange's method
// (exchangePriceEx: multi-have read of the real per-item book, exalted-side cluster)
// prices them live from GGG alone — proven (Celestial Alloy: live 20ex vs this seed's
// stale 160). fetchRunePrices now tries exchangePriceEx FIRST; this curated seed (and
// the poe.ninja snippet store) only fill in when the live exchange is empty/limited.
// poe.ninja's PoE2 API is still Cloudflare-blocked server-side, so the snippet remains
// the manual fallback path — but it's no longer the primary source for these.
const CURRENCY_OVERRIDE_FILE = path.join(DATA_DIR, ".currency-overrides.json");
const CURRENCY_OVERRIDE_SEED = {
  "Celestial Alloy": 160, "Sovereign Alloy": 32, "Transcendent Alloy": 42,
  "Mystic Alloy": 10, "Prismatic Alloy": 9, "The Runefather's Alloy": 4, "The Runebinder's Alloy": 10,
};
let currencyOverrideCache = null;
function readCurrencyOverrides() {
  if (currencyOverrideCache) return currencyOverrideCache;
  const out = {};
  for (const [name, ex] of Object.entries(CURRENCY_OVERRIDE_SEED)) out[normalizeName(name)] = { ex, name, source: "curated" };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CURRENCY_OVERRIDE_FILE, "utf8")) || {}; } catch {}
  for (const [k, e] of Object.entries(file.prices || {})) {
    if (e && e.ex > 0) out[normalizeName(k)] = { ex: e.ex, name: e.name || k, source: e.source || "poe.ninja", updated: e.updated };
  }
  currencyOverrideCache = out;
  return out;
}
function currencyOverride(norm) { return readCurrencyOverrides()[norm] || null; }
function writeCurrencyOverrides(prices) {
  let file = {}; try { file = JSON.parse(fs.readFileSync(CURRENCY_OVERRIDE_FILE, "utf8")) || {}; } catch {}
  file.prices = file.prices || {};
  const now = new Date().toISOString();
  let n = 0;
  for (const [name, ex] of Object.entries(prices)) {
    const v = Number(ex);
    if (!(v > 0) || !String(name).trim()) continue;
    file.prices[normalizeName(name)] = { ex: Math.round(v * 100) / 100, name: String(name).trim(), source: "poe.ninja", updated: now };
    n++;
  }
  try { fs.writeFileSync(CURRENCY_OVERRIDE_FILE, JSON.stringify(file, null, 2)); } catch {}
  currencyOverrideCache = null;
  return n;
}

async function fetchRunePrices(text, league, forceFresh) {
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

  // "Fetch fresh prices" (forceFresh) ONLY: the user explicitly waits, so block
  // BRIEFLY (bounded) to fill the book for the pasted items before pricing. The
  // DEFAULT "Check picks" must NOT block-fill here — doing so, plus the per-item
  // trade-search fallbacks below, bursts the shared queue and trips the IP rate
  // limit (5 req / 15s) on a cold multi-item paste, locking the tool out for
  // minutes. Default instead prices what's already booked instantly and kicks a
  // GENTLE background fill at the end; un-booked exchange items show "pricing…" and
  // resolve on the next check.
  if (forceFresh && !initialTradeStatus.limited) {
    const norms = runePastedNorms(limitedRawLines);
    if (norms.length) {
      await Promise.race([
        refreshRuneBook(league, norms, true, { perItemAsk: true }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, RUNE_FRESH_DEADLINE_MS)),
      ]);
    }
  }

  // Currency ex-values + the divine→ex rate come from the unified Trade2 exchange.
  // poe.ninja is BANNED (it gave prices nowhere near reality): runes/essences/soul
  // cores are priced from the Trade2 exchange book (runeBook) below; anything the
  // book hasn't scanned yet shows pending rather than a fabricated number.
  const exData = await getExchangeData(league);
  const currencyRates = exData.rates;
  // Exchange name→id catalog so any pasted currency can be priced LIVE off GGG's bulk
  // exchange (Exiled's method, exchangePriceEx) instead of the stale curated override.
  const exchangeCatalog = await getExchangeCatalog(league).catch(() => new Map());
  let liveExchangeCalls = 0;
  const MAX_LIVE_EXCHANGE = 8;   // single user, but don't burst the shared IP on a big paste

  const all = [];
  const seenItemKey = new Set();

  // Currency rewards (Exalted/Divine/Chaos/…) priced off the Trade2 exchange.
  for (const it of exData.items || []) {
    const key = it.name + "|Currency";
    if (seenItemKey.has(key)) continue;
    seenItemKey.add(key);
    all.push({
      name: it.name,
      normalizedName: normalizeName(it.name),
      category: "Currency",
      slug: "currency",
      price: it.ex,
      volume: it.stock || 0,
      units: it.stock || 0,
      base: it.base === true,
      divineValue: currencyRates.divine ? Math.round((it.ex / currencyRates.divine) * 10000) / 10000 : 0,
      change7d: "",
    });
  }

  // Trade2 exchange price book — accurate prices for runes/essences/soul cores,
  // used to FILL poe.ninja's coverage gaps (it's missing/thin for most of these).
  // poe.ninja keeps the win where it has a real volume-weighted price (it's finer
  // for cheap items, and the exchange is coarse/noisy at sub-1ex); the book steps
  // in only when poe.ninja has no usable price — that's the "useless for most
  // stuff" case the user hit (e.g. soul cores poe.ninja can't price at all).
  const runeBook = readRuneBook(league);
  const runeBookPrices = runeBook ? runeBook.prices : {};
  const bookResultFor = (nn, qty, fallbackName) => {
    const b = runeBookPrices[nn];
    if (!b || !(b.ex > 0)) return null;
    const askSide = b.side === "ask";
    const marketSide = b.side === "market";   // priced off the item-search trade board
    return {
      qty, name: b.name || fallbackName, category: (b.category || "Exchange") + " (trade2)",
      each: b.ex, total: roundPriceExalted(b.ex * qty), currency: "exalted",
      source: marketSide ? "trade2 search" : askSide ? "trade2 exchange (ask)" : "trade2 exchange",
      rawPrice: marketSide ? "cheapest item-search listing (exchange book too thin)" : askSide ? "lowest ask — no standing buyers, sell-side floor" : "",
      divineValue: currencyRates.divine ? roundPriceExalted(b.ex / currencyRates.divine) : 0,
      // Ask-side is a sell floor (cap "low"); item-search is the real trade board for a
      // chase item → "medium". Neither outranks a deep bid-priced/volume-backed pick.
      change7d: "", confidence: marketSide ? "medium" : askSide ? "low" : (b.stock >= 10 ? "high" : "medium"),
      units: Number.isFinite(b.stock) ? b.stock : null,
    };
  };

  const seenCleanNames = new Set();
  const pastedNorms = [];
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

    const looksLikeBareGem = /^Uncut (Skill|Spirit|Support) Gem/i.test(cleanName) && !/\d/.test(cleanName);
    if (cleanName.length < 3 || !/[A-Za-z]{3,}/.test(cleanName) || looksLikeBareGem) continue;

    const norm = normalizeName(cleanName);
    if (seenCleanNames.has(norm)) continue;
    seenCleanNames.add(norm);
    if (!isSkillOrSupport) pastedNorms.push(norm);

    // LIVE GGG bulk-exchange price first (Exiled's exact method, exchangePriceEx):
    // multi-have read of the real per-item book. This prices the alloys/chase orbs the
    // old code declared "unpriceable" — it was only ever reading the junk exalted floor.
    // The curated/poe.ninja override is now a FALLBACK (exchange empty / rate-limited).
    let live = null;
    const cat = !isSkillOrSupport ? exchangeCatalog.get(norm) : null;
    if (cat && cat.id && cat.id !== EXALTED_ID && liveExchangeCalls < MAX_LIVE_EXCHANGE && !tradeStatus().limited) {
      liveExchangeCalls++;
      live = await exchangePriceEx(league, cat.id, currencyRates.divine || 0, currencyRates.chaos || 0);
    }
    if (live && live.ex > 0) {
      results.push({
        qty: parsed.qty, name: cat.name || cleanName, category: "Currency Exchange",
        each: live.ex, total: roundPriceExalted(live.ex * parsed.qty), currency: "exalted",
        source: "trade2 exchange", rawPrice: "GGG exchange · " + live.side + "-side · " + live.depth + " offers",
        divineValue: currencyRates.divine ? roundPriceExalted(live.ex / currencyRates.divine) : 0,
        change7d: "", confidence: live.depth >= 3 ? "high" : "medium", units: null,
      });
      continue;
    }

    // Curated/poe.ninja override — now only a fallback when the live exchange returned
    // nothing (thin/empty book) or we were rate-limited. See CURRENCY_OVERRIDE_SEED.
    const ov = !isSkillOrSupport ? currencyOverride(norm) : null;
    if (ov && ov.ex > 0) {
      results.push({
        qty: parsed.qty, name: ov.name || cleanName, category: "Currency Exchange",
        each: ov.ex, total: roundPriceExalted(ov.ex * parsed.qty), currency: "exalted",
        source: ov.source === "curated" ? "curated" : "poe.ninja",
        rawPrice: ov.updated ? "poe.ninja ratio · " + String(ov.updated).slice(0, 10) : "curated — update from poe.ninja",
        divineValue: currencyRates.divine ? roundPriceExalted(ov.ex / currencyRates.divine) : 0,
        change7d: "", confidence: "high", units: null,
      });
      continue;
    }

    // On-demand fresh (the "Fetch fresh prices" button): the user is explicitly
    // asking for the LIVE Trade2 exchange price, so prefer the book whenever it has
    // one (the forced refresh above just filled it for these items). The row shows
    // the offer stock + a confidence badge, so the user can judge a thin/noisy
    // quote themselves. The DEFAULT "Check picks" still keeps poe.ninja's finer,
    // volume-weighted price where it has one (see the match branch below).
    if (forceFresh && !isSkillOrSupport) {
      const bk = bookResultFor(norm, parsed.qty, cleanName);
      if (bk) { results.push(bk); continue; }
    }

    let match = all.find((item) => item.normalizedName === norm);
    if (!match && norm.length >= 6) {
      match = all
        .filter((item) => (item.normalizedName.includes(norm) || norm.includes(item.normalizedName)) && tierKey(item.normalizedName) === tierKey(norm))
        .sort((a, b) => a.normalizedName.length - b.normalizedName.length)[0];
    }

    if (match) {
      const lowVolume = match.volume >= 0 && match.volume < MIN_NINJA_VOLUME;
      if (forceFresh && lowVolume && tradeFallbacks < MAX_TRADE_FALLBACKS) {
        tradeFallbacks++;
        const tradePrice = await getTradePrice(cleanName, league, currencyRates);
        if (tradePrice && tradePrice.limited) {
          results.push({ qty: parsed.qty, name: match.name, category: match.category + " (trade limited)", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — live-trade is best-effort", change7d: match.change7d });
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
        const bk = bookResultFor(norm, parsed.qty, match.name);
        if (bk) { results.push(bk); continue; }
        results.push({ qty: parsed.qty, name: match.name, category: match.category + " (no price yet)", each: "", total: "", currency: "", source: "trade2 exchange", rawPrice: "", change7d: match.change7d, confidence: "none", units: null });
        continue;
      }
      const total = roundPriceExalted(match.price * parsed.qty);
      // Exalted is the base unit — 1 ex by definition, not a scanned/thin-market
      // price. Don't flag it "Low 0" or label it as sourced from the exchange.
      const isBase = match.base === true;
      results.push({
        qty: parsed.qty,
        name: match.name,
        category: match.category,
        each: match.price,
        total,
        currency: "exalted",
        source: isBase ? "base unit" : (match.source || "trade2 exchange"),
        rawPrice: "",
        divineValue: match.divineValue,
        change7d: match.change7d,
        confidence: isBase ? "base" : priceConfidence(match.units),
        units: isBase ? null : (Number.isFinite(match.units) && match.units >= 0 ? Math.round(match.units) : null),
      });
      continue;
    }

    // No currency match → the Trade2 exchange book is the accurate source for
    // runes/essences/soul cores/etc. (the main coverage win).
    if (!isSkillOrSupport) {
      const bk = bookResultFor(norm, parsed.qty, cleanName);
      if (bk) { results.push(bk); continue; }
      // The fill already ran and found NO standing buyer → resolve to "no buyers"
      // (NOT a perpetual "pricing…"). Without this, thin items like Greater Storm Rune
      // loop on "pricing…" forever because bookResultFor returns null for ex:0/thin.
      const booked = runeBookPrices[norm];
      if (booked && booked.thin) {
        results.push({ qty: parsed.qty, name: cleanName, category: "no buyers", each: "", total: "", currency: "", source: "trade2 exchange", rawPrice: "no live buyers on the exchange", change7d: "", confidence: "none", units: null });
        continue;
      }
      // Not booked yet. On the DEFAULT check, NEVER burst the queue with a per-item
      // trade search (that + the fill is what tripped the rate limit). Show "pricing…"
      // and let the gentle background fill below book it for the next check. The fill
      // only targets real exchange items, so a genuinely off-exchange paste just stays
      // "pricing…" (harmless — no calls wasted on it); "Fetch fresh" is the explicit
      // bounded path that does the live trade search and the authoritative NOT FOUND.
      if (!forceFresh) {
        results.push({ qty: parsed.qty, name: cleanName, category: "pricing…", each: "", total: "", currency: "", source: "trade2 exchange", rawPrice: "fetching live price — check again in ~30s", change7d: "", confidence: "none", units: null });
        continue;
      }
    }

    let tradePrice = null;
    if (isSkillOrSupport && tradePaused) {
      results.push({ qty: parsed.qty, name: cleanName, category: "Trade queued", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — live-trade is best-effort", change7d: "" });
      continue;
    }

    if (isSkillOrSupport) {
      results.push({ qty: parsed.qty, name: cleanName, category: "Trade queued", each: "", total: "", currency: "", source: "trade2", rawPrice: "queued — shared rate-limit bucket, live-trade is best-effort", change7d: "" });
      continue;
    } else if (tradeFallbacks < MAX_TRADE_FALLBACKS) {
      tradeFallbacks++;
      tradePrice = await getTradePrice(cleanName, league, currencyRates, tradeDeadline);
      if (tradePrice && tradePrice.limited) tradePaused = true;
    }
    if (tradePrice) {
      if (tradePrice.limited) {
        results.push({ qty: parsed.qty, name: cleanName, category: "TRADE LIMITED", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — live-trade is best-effort", change7d: "" });
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

    results.push({ qty: parsed.qty, name: cleanName, category: "Not found", each: "", total: "", currency: "", source: "", rawPrice: "", change7d: "" });
  }

  // Background-fill the price book for pasted items that are missing or stale, so
  // the NEXT check shows accurate Trade2 prices. Fire-and-forget; never blocks.
  if (!tradeStatus().limited) {
    const stale = pastedNorms.filter((nn) => {
      const b = runeBookPrices[nn];
      return !b || !b.updated || (Date.now() - new Date(b.updated).getTime() > RUNE_BOOK_TTL_MS);
    });
    if (stale.length) refreshRuneBook(league, stale, false, { perItemAsk: true }).catch(() => {});
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
    tradeLimitedUntil: tradeStatus().tradeLimitedUntil,
    updated: new Date().toISOString(),
  };
}

const UPGRADE_GUIDE_PROFILE = {
  id: "ice-shot-deadeye-crit-hybrid",
  name: "Mobalytics Ice Shot Deadeye - Crit Hybrid",
  league: "Runes of Aldur",
  source: "https://mobalytics.gg/poe-2/builds/ice-shot-deadeye",
  hardTargets: { fireRes: 75, coldRes: 75, lightningRes: 75, chaosRes: 30, str: 40, dex: 95, int: 55, spirit: 145 },
  softTargets: { rarity: 100 },
  slots: {
    bow: {
      label: "Bow",
      category: "weapon.bow",
      priority: 100,
      stats: { dps: 3.4, critChance: 2.8, attackSpeed: 1.7, flatPhys: 1.7, flatCold: 1.4, flatEle: 1.0 },
      notes: "Crit bow is the first major guide priority.",
    },
    quiver: {
      label: "Quiver",
      category: "armour.quiver",
      priority: 92,
      stats: { projectileLevels: 4.2, attackCrit: 2.6, critDamage: 2.0, bowDamage: 1.7, projectileSpeed: 1.1, flatPhysAttack: 1.2, flatColdAttack: 1.1, rarity: 0.9 },
      notes: "Crit quiver or Cadiro's Gambit style value package.",
    },
    focus: {
      label: "Focus",
      category: "armour.focus",
      priority: 80,
      stats: { energyShield: 2.6, spellDamage: 2.4, levelAllSpellSkills: 3.0, castSpeed: 1.6, critChance: 1.4, mana: 1.0, resists: 1.0, rarity: 0.8 },
      notes: "Caster off-hand: ES, spell damage / +spell levels, then resists.",
    },
    shield: {
      label: "Shield",
      category: "armour.shield",
      priority: 78,
      stats: { energyShield: 2.2, armour: 1.8, evasion: 1.6, life: 1.4, resists: 1.4, str: 0.8, rarity: 0.8 },
      notes: "Defensive off-hand: ES/armour/evasion, life, resists.",
    },
    buckler: {
      label: "Buckler",
      category: "armour.buckler",
      priority: 77,
      stats: { evasion: 2.6, life: 1.2, resists: 1.4, dex: 0.8, rarity: 0.8 },
      notes: "Evasion off-hand with block.",
    },
    amulet: {
      label: "Amulet",
      category: "accessory.amulet",
      priority: 86,
      stats: { projectileLevels: 4.6, spirit: 3.2, critChance: 1.7, critDamage: 1.5, totalAllAttributes: 1.0, resists: 0.9, rarity: 1.1 },
      required: { spirit: 45 },
      notes: "+projectile levels and 45+ spirit are high priority.",
    },
    helmet: {
      label: "Helmet",
      category: "armour.helmet",
      priority: 70,
      stats: { energyShield: 2.8, int: 0.9, life: 0.7, resists: 1.1, rarity: 0.8 },
      target: { energyShield: 450 },
      notes: "Hybrid setup wants a high ES helmet.",
    },
    chest: {
      label: "Body Armour",
      category: "armour.chest",
      priority: 72,
      stats: { evasion: 3.0, life: 0.8, resists: 1.0, rarity: 0.8 },
      notes: "Big evasion chest is the main defensive slot.",
    },
    boots: {
      label: "Boots",
      category: "armour.boots",
      priority: 62,
      stats: { movementSpeed: 2.2, life: 1.0, resists: 1.3, rarity: 0.9 },
      notes: "Movement speed, life, and resistance fixing.",
    },
    gloves: {
      label: "Gloves",
      category: "armour.gloves",
      priority: 61,
      stats: { flatColdAttack: 1.9, flatPhysAttack: 1.7, attackSpeed: 1.5, life: 0.8, resists: 0.9, rarity: 1.0 },
      notes: "Attack damage on gloves, preferably cold or physical.",
    },
    ring: {
      label: "Ring",
      category: "accessory.ring",
      priority: 58,
      stats: { flatColdAttack: 1.8, flatPhysAttack: 1.5, life: 0.9, resists: 1.4, totalAllAttributes: 0.8, rarity: 1.2 },
      notes: "Damage rings that keep resistance and attribute requirements stable.",
    },
    belt: {
      label: "Belt",
      category: "accessory.belt",
      priority: 48,
      stats: { life: 1.2, str: 1.1, resists: 1.4, rarity: 1.0 },
      notes: "Cheap life/strength/resist belt before expensive unique upgrades.",
    },
    jewel: {
      label: "Jewel",
      category: "jewel",
      priority: 54,
      stats: { manaOnKill: 3.0, critChance: 1.5, attackSpeed: 1.4, projectileDamage: 1.4 },
      notes: "Mana on kill first, then damage and speed.",
    },
  },
  lockedUniques: {
    quiver: ["Cadiro's Gambit"],
  },
};

const UPGRADE_STAT_IDS = {
  projectileLevels: "explicit.stat_1202301673",
  attackCrit: "explicit.stat_2194114101",
  flatPhysAttack: "explicit.stat_3032590688",
  flatColdAttack: "explicit.stat_4067062424",
  flatFireAttack: "explicit.stat_1573130764",
  flatLightningAttack: "explicit.stat_1754445556",
  flatChaosAttack: "explicit.stat_674553446",
  attackSpeed: "explicit.stat_681332047",
  bowDamage: "explicit.stat_1241625305",
  projectileSpeed: "explicit.stat_3759663284",
  projectileDamage: "explicit.stat_1839076647",
  deflection: "explicit.stat_3040571529",
  spirit: "explicit.stat_3981240776",
  localPhysDamage: "explicit.stat_1509134228",
  localFlatPhys: "explicit.stat_1940865751",
  localFlatCold: "explicit.stat_1037193709",
  localFlatFire: "explicit.stat_709508406",
  localFlatLightning: "explicit.stat_3336890334",
  localFlatChaos: "explicit.stat_2223678961",
  localAttackSpeed: "explicit.stat_210067635",
  localCritChance: "explicit.stat_518292764",
  life: "explicit.stat_3299347043",
  totalLife: "pseudo.pseudo_total_life",
  energyShield: "pseudo.pseudo_total_energy_shield",
  evasion: "explicit.stat_53045048",
  coldRes: "explicit.stat_4220027924",
  lightningRes: "explicit.stat_1671376347",
  fireRes: "explicit.stat_3372524247",
  chaosRes: "explicit.stat_2923486259",
  totalElementalRes: "pseudo.pseudo_total_elemental_resistance",
  totalResistance: "pseudo.pseudo_total_resistance",
  str: "explicit.stat_4080418644",
  dex: "explicit.stat_3261801346",
  int: "explicit.stat_328541901",
  attributes: "explicit.stat_1379411836",
  explicitAttributes: "explicit.stat_1379411836",
  totalStr: "pseudo.pseudo_total_strength",
  totalDex: "pseudo.pseudo_total_dexterity",
  totalInt: "pseudo.pseudo_total_intelligence",
  totalAllAttributes: "pseudo.pseudo_total_all_attributes",
  totalAttributes: "pseudo.pseudo_total_attributes",
  movementSpeed: "explicit.stat_2250533757",
  totalMovementSpeed: "pseudo.pseudo_increased_movement_speed",
  critChance: "explicit.stat_587431675",
  critDamage: "explicit.stat_3556824919",
  rarity: "explicit.stat_3917489142",
  manaOnKill: "explicit.stat_1368271171",
  // Caster-weapon stats (wand/staff/sceptre). Verified live against real
  // listings (2026-06-15). critChance/critDamage on caster slots are redirected
  // to the spell variants via SLOT_STAT_OVERRIDES below.
  spellDamage: "explicit.stat_2974417149",        // #% increased Spell Damage
  castSpeed: "explicit.stat_2891184298",          // #% increased Cast Speed
  levelAllSpellSkills: "explicit.stat_124131830", // # to Level of all Spell Skills
  levelAllMinionSkills: "explicit.stat_2162097452", // # to Level of all Minion Skills
  levelAllMeleeSkills: "explicit.stat_9187492",   // # to Level of all Melee Skills (martial melee weapons)
  levelAllAttackSkills: "explicit.stat_3035140377", // # to Level of all Attack Skills (martial weapons + amulet)
  mana: "explicit.stat_1050105434",               // # to maximum Mana
  manaRegen: "explicit.stat_789117908",           // #% increased Mana Regeneration Rate
  spiritPct: "explicit.stat_3984865854",          // #% increased Spirit (sceptre)
};

// The SAME conceptual stat has different Trade2 ids depending on the slot it
// rolls on. The flat UPGRADE_STAT_IDS map holds the generic (amulet/jewel)
// variant; these per-slot-family overrides redirect a key to the id that the
// item type can actually roll. Without this, e.g. a bow searched for crit
// chance/crit damage hits the global ids that weapons never have -> 0 results.
// Verified live against Trade2 stat ids + real listing counts (2026-06-15):
//   bow critChance global 587431675 -> 0 listings; local 518292764 -> 6278.
//   bow attack speed global 681332047 -> 0; local 210067635 -> 5989.
//   bow "to Crit Damage Bonus" 2694482655 -> 4340; quiver "for Attack
//   Damage" 3714003708 is the quiver-only crit-damage variant.
const SLOT_STAT_OVERRIDES = {
  bow: {
    critChance: "explicit.stat_518292764",   // "#% to Critical Hit Chance" (weapon-local)
    critDamage: "explicit.stat_2694482655",  // "#% to Critical Damage Bonus" (weapon-local)
    attackSpeed: "explicit.stat_210067635",  // "#% increased Attack Speed (Local)"
  },
  quiver: {
    critDamage: "explicit.stat_3714003708",  // "#% increased Critical Damage Bonus for Attack Damage"
  },
  focus: {
    critChance: "explicit.stat_737908626",   // "#% to Critical Hit Chance for Spells" (caster off-hand)
    critDamage: "explicit.stat_274716455",   // "#% increased Critical Spell Damage Bonus"
  },
};

// Resolve a conceptual stat key to the Trade2 id correct for the given slot,
// preferring the slot-family override, then the generic map.
function gearStatId(key, slotId) {
  const baseId = slotId === "ring1" || slotId === "ring2" ? "ring" : slotId;
  const override = SLOT_STAT_OVERRIDES[baseId];
  if (override && override[key]) return override[key];
  return UPGRADE_STAT_IDS[key];
}

// Build the top-2 Trade2 stat filters for a gear search from [{statId,min}].
// Keep explicit AND pseudo ids — ES/life map to pseudo ids (pseudo.pseudo_total_*),
// and dropping them left ES/life slots with no filters → an empty "and" group,
// which PoE2 trade rejects as "Invalid query".
function gearStatFilters(mods, limit = 2) {
  return (Array.isArray(mods) ? mods : [])
    .filter((m) => m && /^(explicit\.stat_\d+|pseudo\.[a-z0-9_]+)$/.test(m.statId)).slice(0, limit)
    .map((m) => ({ id: m.statId, value: { min: Math.max(1, Math.floor(Number(m.min) || 1)) } }));
}
// PoE2 trade 400s on an empty "and" group, so omit the stats group when there are none.
const gearStatGroup = (filters) => (filters.length ? [{ type: "and", filters }] : []);

// Gear searches use status "securable" = INSTANT BUYOUT only (async Merchant-Tab
// listings). These are the actually-buyable items — no whisper, the seller can be
// offline, the buyer teleports and buys. The old "online" pool is whisper/in-person
// listings (method:psapi) that are largely stale now that trading moved in-game.
const GEAR_TRADE_STATUS = "securable";

// Run a gear trade2 SEARCH. The league lives in the URL (not the query body), and a
// stale/wrong client league makes GGG reject a perfectly valid body as "Invalid query"
// (code 2). So if a 400 comes back on a non-default league, retry ONCE on DEFAULT_LEAGUE
// — the league this build tool targets anyway. Returns { search, league } (league used).
async function gearTradeSearch(q, league) {
  const u = (lg) => "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(lg);
  try {
    return { search: await fetchTrade(u(league), { method: "POST", body: JSON.stringify(q) }), league };
  } catch (err) {
    if (league !== DEFAULT_LEAGUE && String(err && err.message).includes("HTTP 400")) {
      console.error("[gear] search 400 on league", JSON.stringify(league), "— retrying on", JSON.stringify(DEFAULT_LEAGUE));
      return { search: await fetchTrade(u(DEFAULT_LEAGUE), { method: "POST", body: JSON.stringify(q) }), league: DEFAULT_LEAGUE };
    }
    throw err;
  }
}

const GEAR_EQUIPMENT_FILTER_IDS = {
  dps: "dps",
  evasion: "ev",
  energyShield: "es",
  armour: "ar",
};

const GEAR_COMPOSITE_STAT_GROUPS = {
  totalFlatAttack: ["flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "localFlatPhys", "localFlatCold", "localFlatFire", "localFlatLightning", "localFlatChaos"],
  totalFlatElementalAttack: ["flatColdAttack", "flatFireAttack", "flatLightningAttack", "localFlatCold", "localFlatFire", "localFlatLightning"],
};

const UPGRADE_SEARCH_STATS = {
  bow: [
    { key: "dps", value: { min: 600 } },
    { id: UPGRADE_STAT_IDS.localPhysDamage, value: { min: 100 } },
    { id: UPGRADE_STAT_IDS.localCritChance },
    { key: "totalFlatElementalAttack" },
  ],
  quiver: [
    { id: UPGRADE_STAT_IDS.projectileLevels, value: { min: 1 } },
    { id: UPGRADE_STAT_IDS.attackCrit, value: { min: 20 } },
    { id: UPGRADE_STAT_IDS.critDamage },
    { key: "totalFlatElementalAttack" },
  ],
  amulet: [
    { id: UPGRADE_STAT_IDS.projectileLevels, value: { min: 1 } },
    { id: UPGRADE_STAT_IDS.spirit, value: { min: 40 } },
  ],
  helmet: [
    { key: "energyShield", value: { min: 300 } },
    { id: UPGRADE_STAT_IDS.life, value: { min: 40 } },
    { id: UPGRADE_STAT_IDS.totalElementalRes, value: { min: 50 } },
    { id: UPGRADE_STAT_IDS.chaosRes, value: { min: 10 } },
  ],
  chest: [
    { key: "evasion", value: { min: 1200 } },
    { id: UPGRADE_STAT_IDS.life, value: { min: 50 } },
    { id: UPGRADE_STAT_IDS.totalElementalRes, value: { min: 50 } },
  ],
  boots: [
    { id: UPGRADE_STAT_IDS.movementSpeed, value: { min: 30 } },
    { id: UPGRADE_STAT_IDS.life, value: { min: 50 } },
    { id: UPGRADE_STAT_IDS.coldRes, value: { min: 25 } },
    { id: UPGRADE_STAT_IDS.chaosRes, value: { min: 10 } },
  ],
  gloves: [
    { id: UPGRADE_STAT_IDS.attackSpeed, value: { min: 10 } },
    { key: "totalFlatElementalAttack" },
    { id: UPGRADE_STAT_IDS.fireRes, value: { min: 20 } },
  ],
  ring: [
    { id: UPGRADE_STAT_IDS.life, value: { min: 50 } },
    { id: UPGRADE_STAT_IDS.fireRes, value: { min: 20 } },
    { id: UPGRADE_STAT_IDS.coldRes, value: { min: 20 } },
    { key: "totalFlatElementalAttack" },
  ],
  belt: [
    { id: UPGRADE_STAT_IDS.life, value: { min: 80 } },
    { id: UPGRADE_STAT_IDS.str, value: { min: 20 } },
    { id: UPGRADE_STAT_IDS.coldRes, value: { min: 20 } },
  ],
  jewel: [
    { id: UPGRADE_STAT_IDS.critChance },
    { id: UPGRADE_STAT_IDS.attackSpeed },
  ],
};

const PRESERVE_CONTROL_STATS_BY_SLOT = {
  // Per-slot VALID affix pools — what each item type can actually roll as a
  // normal explicit (verified against live explicit-affix sampling + PoE2 rules,
  // 2026-06-15). Deliberately excludes stats that only show on listings via
  // socketed gems, enchants/instills, runes, or corruption (those aren't base
  // affixes). Weapons can't roll life/resistances; jewels are %-mods only; etc.
  // The add-filter dropdown shows EXACTLY this set per slot (no global append).
  // Martial weapons (bow + injected melee/ranged) share `bow`; casters use the
  // injected CASTER/SCEPTRE key sets.
  bow: ["dps", "critChance", "critDamage", "localPhysDamage", "localAttackSpeed", "totalFlatAttack", "totalFlatElementalAttack", "localFlatPhys", "localFlatCold", "localFlatFire", "localFlatLightning", "localFlatChaos", "levelAllAttackSkills", "levelAllMeleeSkills", "str", "dex", "int"],
  quiver: ["attackCrit", "critDamage", "bowDamage", "projectileSpeed", "projectileLevels", "totalFlatAttack", "totalFlatElementalAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "manaOnKill", "str", "dex", "int", "rarity"],
  amulet: ["life", "energyShield", "mana", "spirit", "critChance", "critDamage", "spellDamage", "castSpeed", "levelAllSpellSkills", "levelAllAttackSkills", "projectileLevels", "manaRegen", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  helmet: ["energyShield", "evasion", "armour", "life", "mana", "critChance", "levelAllMinionSkills", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  focus: ["energyShield", "mana", "manaRegen", "spellDamage", "castSpeed", "levelAllSpellSkills", "levelAllMinionSkills", "critChance", "critDamage", "spirit", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  shield: ["energyShield", "armour", "evasion", "life", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  buckler: ["evasion", "energyShield", "life", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  chest: ["energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  boots: ["movementSpeed", "energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  gloves: ["attackSpeed", "totalFlatAttack", "totalFlatElementalAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "manaOnKill", "rarity"],
  ring: ["life", "mana", "totalFlatAttack", "totalFlatElementalAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "castSpeed", "manaRegen", "manaOnKill", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  belt: ["life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  jewel: ["critChance", "critDamage", "attackSpeed", "castSpeed", "projectileDamage", "spellDamage", "manaOnKill", "str", "dex", "int"],
};

const SLOT_ALIASES = [
  [/Item Class:\s*Bows/i, "bow"],
  [/Item Class:\s*Quivers/i, "quiver"],
  [/Item Class:\s*Foci/i, "focus"],
  [/Item Class:\s*Bucklers/i, "buckler"],
  [/Item Class:\s*Shields/i, "shield"],
  [/Item Class:\s*Amulets/i, "amulet"],
  [/Item Class:\s*Helmets/i, "helmet"],
  [/Item Class:\s*Body Armours/i, "chest"],
  [/Item Class:\s*Boots/i, "boots"],
  [/Item Class:\s*Gloves/i, "gloves"],
  [/Item Class:\s*Rings/i, "ring"],
  [/Item Class:\s*Belts/i, "belt"],
  [/Item Class:\s*Jewels/i, "jewel"],
];

// --- Multi-weapon support --------------------------------------------------
// The original profile had only `bow`. Add every real PoE2 0.5 weapon class
// (categories from the live Trade2 category list). Martial weapons all share
// the SAME weapon-LOCAL stat ids (verified: bow + spear identical), so they
// reuse the bow filter set + bow's slot-stat overrides. Caster weapons
// (wand/staff) use spell stats with crit redirected to the spell variants;
// sceptres are minion/spirit support. Slots/preserve/overrides/aliases are
// injected here so the change is one compact table, not 15 literal blocks.
const CASTER_WEAPON_KEYS = ["spellDamage", "critChance", "critDamage", "castSpeed", "levelAllSpellSkills", "mana", "manaRegen"];
const SCEPTRE_KEYS = ["spiritPct", "mana", "manaRegen", "int", "levelAllMinionSkills", "levelAllSpellSkills"];
const CASTER_STAT_OVERRIDE = { critChance: "explicit.stat_737908626", critDamage: "explicit.stat_274716455" };
const EXTRA_WEAPON_SLOTS = [
  // id, label, Trade2 category, Item Class name (for paste detection), family
  ["crossbow", "Crossbow", "weapon.crossbow", "Crossbows", "martial"],
  ["spear", "Spear", "weapon.spear", "Spears", "martial"],
  ["claw", "Claw", "weapon.claw", "Claws", "martial"],
  ["dagger", "Dagger", "weapon.dagger", "Daggers", "martial"],
  ["onesword", "One-Handed Sword", "weapon.onesword", "One Hand Swords", "martial"],
  ["oneaxe", "One-Handed Axe", "weapon.oneaxe", "One Hand Axes", "martial"],
  ["onemace", "One-Handed Mace", "weapon.onemace", "One Hand Maces", "martial"],
  ["flail", "Flail", "weapon.flail", "Flails", "martial"],
  ["twosword", "Two-Handed Sword", "weapon.twosword", "Two Hand Swords", "martial"],
  ["twoaxe", "Two-Handed Axe", "weapon.twoaxe", "Two Hand Axes", "martial"],
  ["twomace", "Two-Handed Mace", "weapon.twomace", "Two Hand Maces", "martial"],
  ["quarterstaff", "Quarterstaff", "weapon.warstaff", "Quarterstaves", "martial"],
  ["wand", "Wand", "weapon.wand", "Wands", "caster"],
  ["staff", "Staff", "weapon.staff", "Staves", "caster"],
  ["sceptre", "Sceptre", "weapon.sceptre", "Sceptres", "sceptre"],
];
// Martial weapon slots (incl. bow) — where "increased Crit Chance/Attack Speed"
// is a LOCAL roll. Used by parseItemStats' slot-aware local/global decision.
const MARTIAL_WEAPON_SLOTS = new Set(["bow"]);
{
  let weaponPriority = 99; // just under bow's 100; weapons sort near the top
  for (const [id, label, category, cls, family] of EXTRA_WEAPON_SLOTS) {
    if (family === "martial") MARTIAL_WEAPON_SLOTS.add(id);
    const keys = family === "martial" ? PRESERVE_CONTROL_STATS_BY_SLOT.bow
      : family === "sceptre" ? SCEPTRE_KEYS : CASTER_WEAPON_KEYS;
    UPGRADE_GUIDE_PROFILE.slots[id] = {
      label, category, priority: weaponPriority--,
      stats: Object.fromEntries(keys
        .filter((k) => UPGRADE_STAT_IDS[k] || GEAR_EQUIPMENT_FILTER_IDS[k] || GEAR_COMPOSITE_STAT_GROUPS[k])
        .map((k) => [k, 1])),
      notes: label + " search.",
    };
    PRESERVE_CONTROL_STATS_BY_SLOT[id] = keys;
    SLOT_STAT_OVERRIDES[id] = family === "martial" ? SLOT_STAT_OVERRIDES.bow : CASTER_STAT_OVERRIDE;
    // Anchored to "Item Class:" so "Staves" can't match "Quarterstaves".
    SLOT_ALIASES.push([new RegExp("Item Class:\\s*" + cls, "i"), id]);
  }
}

function addStat(stats, key, value) {
  const number = Number(value);
  if (Number.isFinite(number)) stats[key] = (stats[key] || 0) + number;
}

// `slotHint` (a gear-search slot id, when the caller knows it) makes the
// local-vs-global decision for "increased Critical Hit Chance"/"increased Attack
// Speed" reliable: on a martial weapon those are LOCAL, elsewhere GLOBAL. When
// no hint is given we fall back to scanning the text for a weapon Item Class
// (now covering every PoE2 0.5 martial class, not just the original few).
function parseItemStats(text, slotHint) {
  const stats = {};
  const rawLines = String(text || "").split(/\r?\n/);
  let explicitSource = "";
  let inExplicit = false;
  for (const line of rawLines) {
    if (/^Explicit:|^Implicits:|^Implicit:/i.test(line)) {
      inExplicit = true;
      continue;
    }
    if (line === "---") {
      inExplicit = false;
      continue;
    }
    if (inExplicit) explicitSource += line + "\n";
  }
  const source = normalizePoeMarkup(text);
  // Is this a MARTIAL weapon, where "increased Crit Chance/Attack Speed" is a
  // local roll? Prefer the explicit slot hint; otherwise sniff the Item Class.
  const isLocalWeapon = slotHint
    ? MARTIAL_WEAPON_SLOTS.has(slotHint)
    : /Item Class:\s*(Bows|Crossbows|Quarterstaves|Spears|Flails|Claws|Daggers|One Hand \w+|Two Hand \w+|Sceptres|Wands|Staves)/i.test(source)
      || /\b(Bows|Crossbows|Quarterstaves|Spears|Flails|Claws|Daggers|Maces|Axes|Swords)\b/i.test(source);
  const avgPair = (match) => (Number(match[1]) + Number(match[2])) / 2;
  let weaponAverageHit = 0;
  let weaponAps = 0;
  let explicitDps = 0;

  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Physical Damage to Attacks/gi)) addStat(stats, "flatPhysAttack", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Physical Damage(?! to Attacks| to Spells)/gi)) {
    addStat(stats, "flatPhys", avgPair(match));
    addStat(stats, "localFlatPhys", avgPair(match));
  }
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Cold Damage to Attacks/gi)) addStat(stats, "flatColdAttack", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Fire Damage to Attacks/gi)) addStat(stats, "flatFireAttack", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Lightning Damage to Attacks/gi)) addStat(stats, "flatLightningAttack", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Chaos Damage to Attacks/gi)) addStat(stats, "flatChaosAttack", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Cold Damage(?! to Attacks| to Spells)/gi)) addStat(stats, "localFlatCold", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Fire Damage(?! to Attacks| to Spells)/gi)) addStat(stats, "localFlatFire", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Lightning Damage(?! to Attacks| to Spells)/gi)) addStat(stats, "localFlatLightning", avgPair(match));
  for (const match of source.matchAll(/Adds\s+(\d+)\s+to\s+(\d+)\s+Chaos Damage(?! to Attacks| to Spells)/gi)) addStat(stats, "localFlatChaos", avgPair(match));

  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Physical Damage/gi)) addStat(stats, "localPhysDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Critical Hit Chance for Attacks/gi)) addStat(stats, "attackCrit", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Critical Hit Chance/gi)) {
    // On a martial weapon this is the local crit roll; elsewhere it's global.
    addStat(stats, isLocalWeapon ? "localCritChance" : "critChance", match[1]);
  }
  for (const match of source.matchAll(/\+(\d+(?:\.\d+)?)% to Critical Hit Chance/gi)) addStat(stats, "critChance", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Attack Speed/gi)) {
    addStat(stats, isLocalWeapon ? "localAttackSpeed" : "attackSpeed", match[1]);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Damage with Bow Skills/gi)) addStat(stats, "bowDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Projectile Speed/gi)) addStat(stats, "projectileSpeed", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Projectile Damage/gi)) addStat(stats, "projectileDamage", match[1]);
  // Crit damage has three slot-specific texts, all folded into one key (the
  // slot-aware id resolver picks the right Trade2 id at query time):
  //   weapon-local "+X% to Critical Damage Bonus" (e.g. bows)
  //   quiver       "X% increased Critical Damage Bonus for Attack Damage"
  //   generic      "X% increased [Global] Critical Damage Bonus" (e.g. amulets)
  for (const match of source.matchAll(/\+(\d+(?:\.\d+)?)% to Critical Damage Bonus/gi)) addStat(stats, "critDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Critical Damage Bonus for Attack Damage/gi)) addStat(stats, "critDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased (?:Global )?Critical Damage Bonus(?! for Attack)/gi)) addStat(stats, "critDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Rarity of Items found/gi)) addStat(stats, "rarity", match[1]);
  for (const match of source.matchAll(/\+(\d+) to Level of all Projectile Skills/gi)) addStat(stats, "projectileLevels", match[1]);
  for (const match of source.matchAll(/\+(\d+) to Spirit/gi)) addStat(stats, "spirit", match[1]);
  for (const match of source.matchAll(/\+(\d+) to maximum Life/gi)) addStat(stats, "life", match[1]);
  for (const match of source.matchAll(/\+(\d+) to maximum Energy Shield/gi)) addStat(stats, "energyShield", match[1]);

  // Handle local equipment stats (Evasion, Energy Shield, Deflection, local Crit) separately from modifiers to avoid double-counting
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Evasion Rating/gi)) addStat(stats, "evasion", match[1]);
  for (const match of source.matchAll(/Evasion Rating:\s*(\d+(?:\.\d+)?)/gi)) {
    delete stats.evasion;
    addStat(stats, "evasion", match[1]);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Energy Shield/gi)) addStat(stats, "energyShield", match[1]);
  for (const match of source.matchAll(/Energy Shield:\s*(\d+(?:\.\d+)?)/gi)) {
    delete stats.energyShield;
    addStat(stats, "energyShield", match[1]);
  }
  // Armour rating: prefer the computed property (filtered via equipment_filter
  // "ar"), like evasion/ES above.
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Armour(?! and| Rating, Evasion)/gi)) addStat(stats, "armour", match[1]);
  for (const match of source.matchAll(/Armour:\s*(\d+(?:\.\d+)?)/gi)) {
    delete stats.armour;
    addStat(stats, "armour", match[1]);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Deflection Rating/gi)) addStat(stats, "deflection", match[1]);
  for (const match of source.matchAll(/Deflection Rating:\s*(\d+(?:\.\d+)?)/gi)) {
    delete stats.deflection;
    addStat(stats, "deflection", match[1]);
  }
  for (const match of source.matchAll(/Critical Hit Chance:\s*(\d+(?:\.\d+)?)%/gi)) {
    // This is the weapon's *computed total* crit property (base + local mods),
    // NOT a searchable explicit mod. Keep it under a display-only key so it can
    // show in the current-vs-candidate comparison, but never let it become the
    // `critChance` search filter (searching the +%-to-crit mod id with a 6.5%
    // base value would return 0 results). The real searchable crit roll comes
    // from the "+X% to Critical Hit Chance" line above.
    addStat(stats, "critChanceBase", match[1]);
  }

  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Movement Speed/gi)) addStat(stats, "movementSpeed", match[1]);
  for (const match of source.matchAll(/\+(\d+)% to Fire Resistance/gi)) addStat(stats, "fireRes", match[1]);
  for (const match of source.matchAll(/\+(\d+)% to Cold Resistance/gi)) addStat(stats, "coldRes", match[1]);
  for (const match of source.matchAll(/\+(\d+)% to Lightning Resistance/gi)) addStat(stats, "lightningRes", match[1]);
  for (const match of source.matchAll(/\+(\d+)% to all Elemental Resistances/gi)) {
    addStat(stats, "fireRes", match[1]);
    addStat(stats, "coldRes", match[1]);
    addStat(stats, "lightningRes", match[1]);
  }
  for (const match of source.matchAll(/\+(\d+)% to Chaos Resistance/gi)) addStat(stats, "chaosRes", match[1]);
  for (const match of source.matchAll(/\+(\d+) to Strength/gi)) addStat(stats, "str", match[1]);
  for (const match of source.matchAll(/\+(\d+) to Dexterity/gi)) addStat(stats, "dex", match[1]);
  for (const match of source.matchAll(/\+(\d+) to Intelligence/gi)) addStat(stats, "int", match[1]);
  for (const match of explicitSource.matchAll(/\+(\d+) to all Attributes/gi)) {
    addStat(stats, "explicitAttributes", match[1]);
  }
  for (const match of source.matchAll(/\+(\d+) to all Attributes/gi)) {
    addStat(stats, "totalAllAttributes", match[1]);
    addStat(stats, "str", match[1]);
    addStat(stats, "dex", match[1]);
    addStat(stats, "int", match[1]);
  }
  for (const match of source.matchAll(/(\d+) Mana gained on Kill/gi)) addStat(stats, "manaOnKill", match[1]);

  // Caster-weapon stats (wand/staff/sceptre). Additive — only surface as
  // filters on caster slots (via PRESERVE_CONTROL_STATS_BY_SLOT); harmless on
  // other items that happen to roll them.
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Spell Damage/gi)) addStat(stats, "spellDamage", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Cast Speed/gi)) addStat(stats, "castSpeed", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Mana Regeneration Rate/gi)) addStat(stats, "manaRegen", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Spirit/gi)) addStat(stats, "spiritPct", match[1]);
  for (const match of source.matchAll(/\+?(\d+) to maximum Mana/gi)) addStat(stats, "mana", match[1]);
  for (const match of source.matchAll(/\+?(\d+) to Level of all Spell Skills/gi)) addStat(stats, "levelAllSpellSkills", match[1]);
  for (const match of source.matchAll(/\+?(\d+) to Level of all Minion Skills/gi)) addStat(stats, "levelAllMinionSkills", match[1]);
  for (const match of source.matchAll(/\+?(\d+) to Level of all Melee Skills/gi)) addStat(stats, "levelAllMeleeSkills", match[1]);
  for (const match of source.matchAll(/\+?(\d+) to Level of all Attack Skills/gi)) addStat(stats, "levelAllAttackSkills", match[1]);
  // Caster crit (folded into critChance/critDamage; slot override picks the
  // spell-variant trade id on caster slots).
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Critical Hit Chance for Spells/gi)) addStat(stats, "critChance", match[1]);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)% increased Critical Spell Damage Bonus/gi)) addStat(stats, "critDamage", match[1]);

  for (const match of source.matchAll(/Physical DPS:\s*(\d+(?:\.\d+)?)/gi)) explicitDps += Number(match[1]);
  for (const match of source.matchAll(/Elemental DPS:\s*(\d+(?:\.\d+)?)/gi)) explicitDps += Number(match[1]);
  for (const match of source.matchAll(/Physical Damage:\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/gi)) weaponAverageHit += avgPair(match);
  for (const match of source.matchAll(/(?:Fire|Cold|Lightning) Damage:\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/gi)) weaponAverageHit += avgPair(match);
  for (const match of source.matchAll(/Attacks per Second:\s*(\d+(?:\.\d+)?)/gi)) weaponAps = Math.max(weaponAps, Number(match[1]) || 0);

  if (weaponAverageHit > 0 && weaponAps > 0) {
    addStat(stats, "dps", weaponAverageHit * weaponAps);
  } else if (explicitDps > 0) {
    addStat(stats, "dps", explicitDps);
  }

  if (weaponAps > 0) addStat(stats, "attackSpeed", weaponAps * 10);

  const flatElementalAttack = ["flatColdAttack", "flatFireAttack", "flatLightningAttack", "localFlatCold", "localFlatFire", "localFlatLightning"].reduce((total, key) => total + (Number(stats[key]) || 0), 0);
  const flatAttack = flatElementalAttack + (Number(stats.flatPhysAttack) || 0) + (Number(stats.flatChaosAttack) || 0) + (Number(stats.localFlatPhys) || 0) + (Number(stats.localFlatChaos) || 0);
  const localFlatElemental = ["localFlatCold", "localFlatFire", "localFlatLightning"].reduce((total, key) => total + (Number(stats[key]) || 0), 0);
  const localFlat = localFlatElemental + (Number(stats.localFlatPhys) || 0) + (Number(stats.localFlatChaos) || 0);
  if (flatElementalAttack > 0) stats.totalFlatElementalAttack = flatElementalAttack;
  if (flatAttack > 0) stats.totalFlatAttack = flatAttack;
  if (localFlatElemental > 0) stats.totalLocalFlatElemental = localFlatElemental;
  if (localFlat > 0) stats.totalLocalFlat = localFlat;
  if (flatElementalAttack > 0) stats.flatEle = flatElementalAttack;
  const elementalRes = (Number(stats.fireRes) || 0) + (Number(stats.coldRes) || 0) + (Number(stats.lightningRes) || 0);
  if (elementalRes > 0) stats.totalElementalRes = elementalRes;
  const totalRes = elementalRes + (Number(stats.chaosRes) || 0);
  if (totalRes > 0) stats.totalResistance = totalRes;
  if (stats.life > 0) stats.totalLife = stats.life;
  if (stats.energyShield > 0) stats.totalEnergyShield = stats.energyShield;
  if (stats.movementSpeed > 0) stats.totalMovementSpeed = stats.movementSpeed;
  if (stats.str > 0) stats.totalStr = stats.str;
  if (stats.dex > 0) stats.totalDex = stats.dex;
  if (stats.int > 0) stats.totalInt = stats.int;
  return stats;
}

function normalizePoeMarkup(value) {
  return String(value || "")
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, "$2")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/\s+/g, " ");
}

function normalizeGearSearchSlotLabel(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return "";
  if (raw === "ring 1" || raw === "ring1" || raw === "left ring") return "ring1";
  if (raw === "ring 2" || raw === "ring2" || raw === "right ring") return "ring2";
  const mapped = {
    bow: "bow",
    quiver: "quiver",
    amulet: "amulet",
    helmet: "helmet",
    "body armour": "chest",
    "body armor": "chest",
    boots: "boots",
    gloves: "gloves",
    ring: "ring1",
    belt: "belt",
    jewel: "jewel",
  }[raw];
  return mapped || "";
}

function detectSlot(text) {
  for (const [pattern, slot] of SLOT_ALIASES) {
    if (pattern.test(text)) return slot;
  }
  return "";
}

function parsePastedItems(text) {
  return String(text || "")
    .split(/\r?\n(?=Item Class:)/g)
    .map((part) => part.trim())
    .filter((part) => /^Item Class:/i.test(part))
    .map((raw, index) => {
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const slotLine = lines.find((line) => /^Slot:\s*/i.test(line));
      const slot = normalizeGearSearchSlotLabel(slotLine ? slotLine.replace(/^Slot:\s*/i, "") : "") || detectSlot(raw);
      const name = lines.find((line) => !/^Item Class:|^Rarity:|^Slot:|^--------$|^Requirements:|^Sockets:/i.test(line)) || "Item " + (index + 1);
      return { index, slot, name, stats: parseItemStats(raw, slot), raw };
    });
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function collectItemLikeObjects(value, out = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if ((value.typeLine || value.name) && (Array.isArray(value.explicitMods) || Array.isArray(value.implicitMods) || value.inventoryId)) {
    out.push(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectItemLikeObjects(item, out, seen);
  } else {
    for (const item of Object.values(value)) {
      if (typeof item === "string" && /typeLine|explicitMods|equipment|inventoryId/.test(item)) {
        const parsed = tryParseJson(item);
        if (parsed) collectItemLikeObjects(parsed, out, seen);
      } else {
        collectItemLikeObjects(item, out, seen);
      }
    }
  }
  return out;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonCandidates(text) {
  const source = htmlDecode(text);
  const candidates = [];
  const trimmed = source.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    candidates.push(trimmed);
  }
  for (const match of source.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    candidates.push(match[1].trim());
  }
  for (const match of source.matchAll(/(?:data-item|data-items|data-json|data-props)=["']([^"']{20,})["']/gi)) {
    candidates.push(htmlDecode(match[1]));
  }
  for (const match of source.matchAll(/(\{[^{}]*(?:"typeLine"|"explicitMods"|"inventoryId")[\s\S]{0,5000}?\})/gi)) {
    candidates.push(match[1]);
  }
  return candidates;
}

function importFromBrowserExport(text) {
  const pastedItems = parsePastedItems(text);
  if (pastedItems.length) {
    return { source: "item-text", itemCount: pastedItems.length, text: String(text || ""), analysis: analyzeUpgradeState(text) };
  }

  const objects = [];
  for (const candidate of extractJsonCandidates(text)) {
    const parsed = tryParseJson(candidate);
    if (parsed) collectItemLikeObjects(parsed, objects);
  }

  const unique = [];
  const seen = new Set();
  for (const item of objects) {
    const key = [item.inventoryId, item.name, item.typeLine, JSON.stringify(item.explicitMods || [])].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  const equipped = unique.filter((item) => {
    const inv = String(item.inventoryId || "").toLowerCase();
    return inv && !/stash|maininventory|flask|gem|cursor/i.test(inv);
  });
  const chosen = equipped.length ? equipped : unique;
  const importedText = chosen.map(itemToPseudoCopyText).join("\n");
  return {
    source: "browser-export",
    itemCount: chosen.length,
    text: importedText,
    analysis: analyzeUpgradeState(importedText),
  };
}

function scoreStatsForSlot(stats, slotId) {
  const slot = UPGRADE_GUIDE_PROFILE.slots[slotId];
  if (!slot) return 0;
  if (slotId === "bow") {
    return Math.round((
      Math.min(Number(stats.dps) || 0, 1200) * 4.5 +
      Math.min(Number(stats.critChance) || 0, 20) * 28 +
      Math.min(Number(stats.attackSpeed) || 0, 30) * 13 +
      Math.min(Number(stats.flatPhys) || 0, 250) * 1.2 +
      Math.min(Number(stats.flatEle) || 0, 250) * 0.8
    ) * 100) / 100;
  }
  let score = slot.priority / 10;
  for (const [key, weight] of Object.entries(slot.stats || {})) {
    score += Math.min(Number(stats[key]) || 0, 700) * weight;
  }
  return Math.round(score * 100) / 100;
}

function isGuideLockedUnique(item, slotId) {
  if (!item || !slotId) return false;
  const allowed = UPGRADE_GUIDE_PROFILE.lockedUniques[slotId] || [];
  const name = normalizeName((item.name || "") + " " + (item.raw || ""));
  return allowed.some((unique) => name.includes(normalizeName(unique)));
}

function analyzeUpgradeState(text) {
  const items = parsePastedItems(text);
  const equipped = {};
  const totals = {};
  for (const item of items) {
    if (item.slot && !equipped[item.slot]) equipped[item.slot] = item;
    for (const [key, value] of Object.entries(item.stats)) totals[key] = (totals[key] || 0) + value;
  }
  const deficits = {};
  for (const [key, target] of Object.entries(UPGRADE_GUIDE_PROFILE.hardTargets)) {
    const current = Number(totals[key]) || 0;
    if (current < target) deficits[key] = Math.round((target - current) * 100) / 100;
  }
  const slotScores = {};
  for (const [slotId, slot] of Object.entries(UPGRADE_GUIDE_PROFILE.slots)) {
    const item = equipped[slotId] || null;
    const score = item ? scoreStatsForSlot(item.stats, slotId) : 0;
    const locked = isGuideLockedUnique(item, slotId);
    slotScores[slotId] = { slot: slotId, label: slot.label, score, itemName: item ? item.name : "missing", notes: locked ? "Guide-approved unique equipped; ignored for upgrades." : slot.notes, locked };
  }
  const categories = Object.values(slotScores)
    .filter((entry) => !entry.locked)
    .map((entry) => ({
      ...entry,
      urgency: Math.round(((UPGRADE_GUIDE_PROFILE.slots[entry.slot].priority || 0) - entry.score / 10) * 100) / 100,
    }))
    .sort((a, b) => b.urgency - a.urgency);
  return { profile: UPGRADE_GUIDE_PROFILE, items, equipped, totals, deficits, slotScores, categories, updated: new Date().toISOString() };
}

function replacementTotals(totals, currentStats, candidateStats) {
  const next = { ...(totals || {}) };
  for (const [key, value] of Object.entries(currentStats || {})) next[key] = (next[key] || 0) - value;
  for (const [key, value] of Object.entries(candidateStats || {})) next[key] = (next[key] || 0) + value;
  return next;
}

function hardGateResult(beforeTotals, afterTotals) {
  const violations = [];
  let fixScore = 0;
  for (const [key, target] of Object.entries(UPGRADE_GUIDE_PROFILE.hardTargets)) {
    const before = Number(beforeTotals && beforeTotals[key]) || 0;
    const after = Number(afterTotals && afterTotals[key]) || 0;
    if (after < target && after < before) violations.push({ key, before, after, target });
    if (before < target && after > before) fixScore += Math.min(after - before, target - before) * 1.5;
  }
  return { viable: violations.length === 0, violations, fixScore: Math.round(fixScore * 100) / 100 };
}

function softGoalResult(beforeTotals, afterTotals) {
  let fixScore = 0;
  const changes = [];
  for (const [key, target] of Object.entries(UPGRADE_GUIDE_PROFILE.softTargets || {})) {
    const before = Number(beforeTotals && beforeTotals[key]) || 0;
    const after = Number(afterTotals && afterTotals[key]) || 0;
    const beforeProgress = Math.min(before, target);
    const afterProgress = Math.min(after, target);
    const improved = afterProgress - beforeProgress;
    if (improved > 0) fixScore += improved * 1.4;
    if (after !== before) changes.push({ key, before, after, target });
  }
  return { fixScore: Math.round(fixScore * 100) / 100, changes };
}

function summarizeHardLosses(beforeTotals, afterTotals) {
  const keys = ["fireRes", "coldRes", "lightningRes", "chaosRes", "str", "dex", "int", "spirit"];
  const losses = {};
  for (const key of keys) {
    const before = Number(beforeTotals && beforeTotals[key]) || 0;
    const after = Number(afterTotals && afterTotals[key]) || 0;
    const delta = Math.round((after - before) * 100) / 100;
    if (delta < 0) losses[key] = delta;
  }
  return losses;
}

function summarizeHardStatChange(beforeTotals, afterTotals) {
  const keys = ["fireRes", "coldRes", "lightningRes", "chaosRes", "str", "dex", "int", "spirit"];
  const parts = [];
  for (const key of keys) {
    const before = Number(beforeTotals && beforeTotals[key]) || 0;
    const after = Number(afterTotals && afterTotals[key]) || 0;
    const delta = Math.round((after - before) * 100) / 100;
    if (delta < 0) parts.push(key + " " + delta);
    if (delta > 0) parts.push(key + " +" + delta);
  }
  return parts.length ? parts.join(", ") : "no hard stat change";
}

function statDelta(currentStats, candidateStats, key) {
  const current = Math.round((Number(currentStats && currentStats[key]) || 0) * 100) / 100;
  const next = Math.round((Number(candidateStats && candidateStats[key]) || 0) * 100) / 100;
  const delta = Math.round((next - current) * 100) / 100;
  const pct = current ? Math.round((delta / current) * 1000) / 10 : 0;
  return { current, next, delta, pct };
}

function statDisplayRank(key) {
  const order = [
    "dps",
    "projectileLevels",
    "spirit",
    "life",
    "totalLife",
    "energyShield",
    "totalEnergyShield",
    "evasion",
    "movementSpeed",
    "totalMovementSpeed",
    "localAttackSpeed",
    "attackSpeed",
    "localCritChance",
    "critChance",
    "attackCrit",
    "critDamage",
    "localPhysDamage",
    "flatPhys",
    "localFlatPhys",
    "localFlatCold",
    "localFlatFire",
    "localFlatLightning",
    "localFlatChaos",
    "totalLocalFlat",
    "totalLocalFlatElemental",
    "totalFlatAttack",
    "totalFlatElementalAttack",
    "flatPhysAttack",
    "flatColdAttack",
    "flatFireAttack",
    "flatLightningAttack",
    "flatChaosAttack",
    "flatEle",
    "bowDamage",
    "projectileSpeed",
    "projectileDamage",
    "fireRes",
    "coldRes",
    "lightningRes",
    "totalElementalRes",
    "chaosRes",
    "totalResistance",
    "str",
    "totalStr",
    "dex",
    "totalDex",
    "int",
    "totalInt",
    "totalAllAttributes",
    "explicitAttributes",
    "rarity",
    "manaOnKill",
  ];
  const index = order.indexOf(key);
  return index === -1 ? order.length : index;
}

function totalResistance(stats) {
  return ["fireRes", "coldRes", "lightningRes", "chaosRes"].reduce((total, key) => {
    return total + (Number(stats && stats[key]) || 0);
  }, 0);
}

function replacementResistanceBand(currentStats) {
  const total = Math.round(totalResistance(currentStats));
  if (total < 15) return null;
  return {
    total,
    min: Math.max(0, total - 10),
    max: total + 10,
  };
}

function buildUpgradeExplanation(slotId, currentStats, candidateStats) {
  const keys = Array.from(new Set([
    ...Object.keys(currentStats || {}),
    ...Object.keys(candidateStats || {}),
  ]))
    .filter((key) => (Number(currentStats && currentStats[key]) || 0) || (Number(candidateStats && candidateStats[key]) || 0))
    .sort((a, b) => statDisplayRank(a) - statDisplayRank(b) || a.localeCompare(b));
  const deltas = {};
  const reasons = [];
  for (const key of keys) {
    const delta = statDelta(currentStats, candidateStats, key);
    deltas[key] = delta;
    if (delta.delta > 0) reasons.push(key + " +" + delta.delta + (delta.pct ? " (" + delta.pct + "%)" : ""));
  }
  return {
    deltas,
    reasons: reasons.slice(0, 4),
    summary: reasons.length ? reasons.slice(0, 3).join(", ") : "Minor stat profile change",
  };
}

function hardGateTradeFilters(totals, currentStats) {
  const keys = ["fireRes", "coldRes", "lightningRes", "chaosRes", "str", "dex", "int", "spirit"];
  const filters = [];
  for (const key of keys) {
    const statId = UPGRADE_STAT_IDS[key];
    if (!statId) continue;
    const target = Number(UPGRADE_GUIDE_PROFILE.hardTargets[key]) || 0;
    const before = Number(totals && totals[key]) || 0;
    const current = Number(currentStats && currentStats[key]) || 0;
    const withoutCurrent = before - current;
    const required = before < target ? current : target - withoutCurrent;
    if (required > 0) filters.push({ id: statId, value: { min: required } });
  }
  return filters;
}

function buildPreserveStatFilters(preserveStats) {
  const preserveStatIds = {
    str: UPGRADE_STAT_IDS.totalStr,
    dex: UPGRADE_STAT_IDS.totalDex,
    int: UPGRADE_STAT_IDS.totalInt,
    totalAllAttributes: UPGRADE_STAT_IDS.totalAllAttributes,
    life: UPGRADE_STAT_IDS.totalLife,
    movementSpeed: UPGRADE_STAT_IDS.totalMovementSpeed,
  };
  const filters = [];
  for (const item of preserveStats || []) {
    const statId = preserveStatIds[item && item.key] || UPGRADE_STAT_IDS[item && item.key];
    if (!statId) continue;
    const value = {};
    const min = Number(item.min);
    const max = Number(item.max);
    if (Number.isFinite(min)) value.min = min;
    if (Number.isFinite(max)) value.max = max;
    filters.push({
      id: statId,
      key: item.key,
      value: value.min === undefined && value.max === undefined ? undefined : value,
    });
  }
  return filters;
}

function preserveKeys(preserveStats) {
  const keys = new Set();
  for (const item of preserveStats || []) {
    const key = item && item.key;
    if (!key) continue;
    keys.add(key);
    if (key === "totalAllAttributes") keys.add("attributes");
    if (key === "explicitAttributes") keys.add("attributes");
    if (key === "life") keys.add("totalLife");
    if (key === "movementSpeed") keys.add("totalMovementSpeed");
  }
  return keys;
}

function equivalentStatKeys(key) {
  const equivalents = {
    attackSpeed: ["attackSpeed", "localAttackSpeed"],
    critChance: ["critChance", "localCritChance"],
    flatPhys: ["flatPhys", "localFlatPhys", "localPhysDamage"],
    totalLocalFlat: ["totalLocalFlat", "localFlatPhys", "localFlatCold", "localFlatFire", "localFlatLightning", "localFlatChaos"],
    totalLocalFlatElemental: ["totalLocalFlatElemental", "localFlatCold", "localFlatFire", "localFlatLightning"],
    totalFlatAttack: ["totalFlatAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack"],
    totalFlatElementalAttack: ["totalFlatElementalAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack"],
    dps: ["dps", "localPhysDamage", "localFlatPhys", "localAttackSpeed"],
    life: ["life", "totalLife"],
    movementSpeed: ["movementSpeed", "totalMovementSpeed"],
    str: ["str", "totalStr"],
    dex: ["dex", "totalDex"],
    int: ["int", "totalInt"],
    attributes: ["attributes", "explicitAttributes", "totalAllAttributes", "totalAttributes"],
    explicitAttributes: ["attributes", "explicitAttributes"],
    totalAllAttributes: ["attributes", "totalAllAttributes", "totalAttributes"],
    fireRes: ["fireRes", "totalElementalRes", "totalResistance"],
    coldRes: ["coldRes", "totalElementalRes", "totalResistance"],
    lightningRes: ["lightningRes", "totalElementalRes", "totalResistance"],
    totalElementalRes: ["totalElementalRes", "fireRes", "coldRes", "lightningRes"],
    chaosRes: ["chaosRes", "totalResistance"],
  };
  return equivalents[key] || [key];
}

function expandedStatKeySet(keys) {
  const expanded = new Set();
  for (const key of keys || []) {
    for (const equivalent of equivalentStatKeys(key)) expanded.add(equivalent);
  }
  return expanded;
}

function buildFocusTradeQuery(slotId, item, stats, priceEx) {
  const slot = UPGRADE_GUIDE_PROFILE.slots[slotId];
  const filters = Object.entries(stats || {})
    .filter(([key, value]) => UPGRADE_STAT_IDS[key] && key !== "totalResistance" && Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([key, value]) => ({
      id: UPGRADE_STAT_IDS[key],
      value: { min: Math.max(0, Math.floor(Number(value) * 0.95)) },
    }));
  const query = {
    query: {
      status: { option: "online" },
      type: item && item.typeLine ? normalizePoeMarkup(item.typeLine) : undefined,
      filters: {
        type_filters: { filters: { category: { option: slot ? slot.category : undefined } } },
        trade_filters: { filters: { price: { option: "exalted" } } },
      },
      stats: filters.length ? [{ type: "and", filters }] : [],
    },
    sort: { price: "asc" },
  };
  if (!query.query.type) delete query.query.type;
  if (!slot) delete query.query.filters.type_filters;
  if (Number(priceEx) > 0) query.query.filters.trade_filters.filters.price.max = Math.ceil(Number(priceEx) * 1.1);
  return query;
}

function buildUpgradeStatsFilters(slotId, maxPriceEx, resistanceBand, preserveStats, excludedStats = []) {
  const slot = UPGRADE_GUIDE_PROFILE.slots[slotId];
  const resistanceIds = new Set([UPGRADE_STAT_IDS.fireRes, UPGRADE_STAT_IDS.coldRes, UPGRADE_STAT_IDS.lightningRes, UPGRADE_STAT_IDS.chaosRes]);
  const preserveControlledKeys = expandedStatKeySet(PRESERVE_CONTROL_STATS_BY_SLOT[slotId] || []);
  const keptKeys = expandedStatKeySet(preserveKeys(preserveStats));
  const excludedKeys = expandedStatKeySet(preserveKeys((excludedStats || []).map((key) => ({ key }))));
  let filters = UPGRADE_SEARCH_STATS[slotId] || Object.keys(slot.stats || {})
    .filter((key) => UPGRADE_STAT_IDS[key])
    .slice(0, 4)
    .map((key) => ({ id: UPGRADE_STAT_IDS[key] }));
  filters = filters.filter((filter) => {
    const key = Object.keys(UPGRADE_STAT_IDS).find((statKey) => UPGRADE_STAT_IDS[statKey] === filter.id);
    return !key || (!preserveControlledKeys.has(key) && !keptKeys.has(key) && !excludedKeys.has(key));
  });
  if (resistanceBand) {
    filters = filters.filter((filter) => !resistanceIds.has(filter.id));
  }
  const statGroups = [];
  if (filters.length) {
    statGroups.push({ type: "count", filters, value: { min: Math.min(2, Math.max(1, filters.length)) } });
  }
  if (resistanceBand && !excludedKeys.has("totalResistance")) {
    statGroups.push({
      type: "and",
      filters: [{
        id: UPGRADE_STAT_IDS.totalResistance,
        value: { min: resistanceBand.min, max: resistanceBand.max },
      }],
    });
  }
  const preserveFilters = buildPreserveStatFilters(preserveStats);
  if (preserveFilters.length) {
    statGroups.push({ type: "and", filters: preserveFilters.map(({ id, value }) => value ? ({ id, value }) : ({ id })) });
  }
  const query = {
    query: {
      status: { option: "online" },
      filters: {
        type_filters: { filters: { category: { option: slot.category } } },
        trade_filters: { filters: { price: { option: "exalted" } } },
      },
      stats: statGroups,
    },
    sort: { price: "asc" },
  };
  if (slotId === "bow") {
    query.query.filters.misc_filters = {
      filters: {
        ilvl: { min: 75 },
        rarity: { option: "rare" },
      },
    };
  }
  if (Number(maxPriceEx) > 0) query.query.filters.trade_filters.filters.price.max = Number(maxPriceEx);
  return query;
}

function itemTextFromTradeEntry(entry) {
  const item = entry.item || {};
  const lines = []
    .concat(item.name || [])
    .concat(item.typeLine || [])
    .concat(item.utilityMods || [])
    .concat(item.implicitMods || [])
    .concat(item.explicitMods || [])
    .concat(item.craftedMods || [])
    .concat(item.runeMods || [])
    .concat(item.desecratedMods || [])
    .concat(item.fracturedMods || [])
    .concat(item.enchantMods || []);
  for (const prop of item.properties || []) {
    const values = (prop.values || []).map((entry) => Array.isArray(entry) ? entry[0] : entry).join(" ");
    if (prop.name && values) lines.push(prop.name + ": " + values);
  }
  return lines.map(normalizePoeMarkup).join("\n");
}

// A Trade2 fetch result → a clean, PoB-parseable item string (Rarity / name /
// base / Item Level / Implicits + mods). Used by real-DPS ranking; fetched items
// always carry the base type, unlike hand-copies from the trade page.
function pobItemFromTradeEntry(entry) {
  const item = (entry && entry.item) || {};
  const base = item.typeLine || item.baseType || "";
  if (!base) return null;
  const name = item.name || "";
  const ilvl = item.ilvl || item.itemLevel || 81;
  // PoE2 trade2 returns each mod as an OBJECT ({description, hash, mods:[...]}), not a
  // plain string like PoE1. String(obj) → "[object Object]" → PoB parses a blank item
  // (mods dropped) → every candidate scores identically. Pull the actual text.
  const modText = (m) => normalizePoeMarkup(typeof m === "string" ? m : (m && m.description) || "");
  const impl = [].concat(item.enchantMods || [], item.runeMods || [], item.implicitMods || []).map(modText).filter(Boolean);
  const expl = [].concat(item.explicitMods || [], item.fracturedMods || [], item.craftedMods || [], item.desecratedMods || []).map(modText).filter(Boolean);
  const head = name ? `Rarity: Rare\n${name}\n${base}` : `Rarity: Normal\n${base}`;
  return [head, `Item Level: ${ilvl}`, `Implicits: ${impl.length}`].concat(impl, expl).join("\n");
}

function normalizePreserveKey(key) {
  if (key === "explicitAttributes") return "explicitAttributes";
  if (key === "attributes") return "explicitAttributes";
  return key;
}

function preserveStatsSatisfied(stats, preserveStats) {
  const misses = [];
  for (const item of preserveStats || []) {
    const key = normalizePreserveKey(item && item.key);
    if (!key) continue;
    const value = Number(stats && stats[key]) || 0;
    const min = Number(item.min);
    const max = Number(item.max);
    if (!Number.isFinite(min) && !Number.isFinite(max) && value <= 0) misses.push({ key, value, required: true });
    if (Number.isFinite(min) && value < min) misses.push({ key, value, min });
    if (Number.isFinite(max) && value > max) misses.push({ key, value, max });
  }
  return { ok: misses.length === 0, misses };
}

function listingPriceFromEntry(entry, currencyRates) {
  const price = entry.listing && entry.listing.price;
  if (!price || !currencyRates[price.currency]) return null;
  const exalted = roundPriceExalted(Number(price.amount) * currencyRates[price.currency]);
  const divineRate = Number(currencyRates.divine) || 0;
  return {
    exalted,
    divine: divineRate > 0 ? roundPriceExalted(exalted / divineRate) : 0,
    raw: price.amount + " " + price.currency,
  };
}

function compactStats(stats, limit = 6) {
  return Object.fromEntries(Object.entries(stats || {})
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([key, value]) => [key, Math.round(Number(value) * 100) / 100]));
}

function gearSearchSlots() {
  const slots = {};
  for (const [id, slot] of Object.entries(UPGRADE_GUIDE_PROFILE.slots)) {
    const variants = id === "ring" ? ["ring1", "ring2"] : [id];
    for (const variant of variants) {
      const baseId = variant === "ring1" || variant === "ring2" ? "ring" : variant;
      const ringSuffix = variant === "ring1" ? " 1" : variant === "ring2" ? " 2" : "";
      slots[variant] = {
        id: variant,
        baseId,
        label: slot.label + ringSuffix,
        category: slot.category,
        statKeys: (PRESERVE_CONTROL_STATS_BY_SLOT[baseId] || Object.keys(slot.stats || {}))
          .filter((key) => UPGRADE_STAT_IDS[key] || GEAR_EQUIPMENT_FILTER_IDS[key] || GEAR_COMPOSITE_STAT_GROUPS[key]),
        defaultFilters: (UPGRADE_SEARCH_STATS[baseId] || []).map((filter) => ({
          ...filter,
          key: filter.key || Object.keys(UPGRADE_STAT_IDS).find((key) => UPGRADE_STAT_IDS[key] === filter.id) || "",
        })),
      };
    }
  }
  return slots;
}

function statLabel(key) {
  const labels = {
    dps: "DPS",
    flatPhys: "Flat physical damage",
    localFlatPhys: "Adds physical damage",
    localFlatCold: "Adds cold damage",
    localFlatFire: "Adds fire damage",
    localFlatLightning: "Adds lightning damage",
    localFlatChaos: "Adds chaos damage",
    totalLocalFlat: "Total local flat damage",
    totalLocalFlatElemental: "Total elemental flat damage",
    totalFlatAttack: "Total flat to attacks",
    totalFlatElementalAttack: "Total elemental flat to attacks",
    flatPhysAttack: "Flat physical to attacks",
    flatColdAttack: "Flat cold to attacks",
    flatFireAttack: "Flat fire to attacks",
    flatLightningAttack: "Flat lightning to attacks",
    flatChaosAttack: "Flat chaos to attacks",
    flatEle: "Flat elemental",
    attackSpeed: "Attack speed",
    critChance: "Critical chance",
    critChanceBase: "Weapon crit chance (total)",
    attackCrit: "Attack critical chance",
    critDamage: "Critical damage",
    localPhysDamage: "% increased physical damage",
    localAttackSpeed: "Local attack speed",
    localCritChance: "Local critical chance",
    bowDamage: "Bow skill damage",
    projectileLevels: "Projectile skill levels",
    projectileSpeed: "Projectile speed",
    projectileDamage: "Projectile damage",
    deflection: "Deflection rating",
    life: "Maximum life",
    totalLife: "Total life",
    energyShield: "Energy shield",
    totalEnergyShield: "Total energy shield",
    evasion: "Evasion rating",
    armour: "Armour rating",
    movementSpeed: "Movement speed",
    totalMovementSpeed: "Total movement speed",
    fireRes: "Fire resistance",
    coldRes: "Cold resistance",
    lightningRes: "Lightning resistance",
    totalElementalRes: "Total elemental res (sum)",
    chaosRes: "Chaos resistance",
    totalResistance: "Total resistance (incl. chaos)",
    str: "Strength",
    totalStr: "Total strength",
    dex: "Dexterity",
    totalDex: "Total dexterity",
    int: "Intelligence",
    totalInt: "Total intelligence",
    totalAllAttributes: "All attributes",
    explicitAttributes: "Explicit all attributes",
    spirit: "Spirit",
    spiritPct: "% increased Spirit",
    spellDamage: "% increased Spell damage",
    castSpeed: "Cast speed",
    levelAllSpellSkills: "+Level of all Spell skills",
    levelAllMinionSkills: "+Level of all Minion skills",
    levelAllMeleeSkills: "+Level of all Melee skills",
    levelAllAttackSkills: "+Level of all Attack skills",
    mana: "Maximum mana",
    manaRegen: "Mana regeneration",
    rarity: "Rarity",
    manaOnKill: "Mana on kill",
  };
  return labels[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, (ch) => ch.toUpperCase());
}

function roundStatValue(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function statComparison(currentStats, candidateStats, preferredKeys = []) {
  const keys = Array.from(new Set([
    ...preferredKeys,
    ...Object.keys(currentStats || {}),
    ...Object.keys(candidateStats || {}),
  ]))
    .filter((key) => {
      if (preferredKeys.includes(key)) return true; // Always include preferred keys
      return (Number(currentStats && currentStats[key]) || 0) || (Number(candidateStats && candidateStats[key]) || 0);
    })
    .sort((a, b) => statDisplayRank(a) - statDisplayRank(b) || a.localeCompare(b));
  return keys.map((key) => {
    const current = roundStatValue(currentStats && currentStats[key]);
    const candidate = roundStatValue(candidateStats && candidateStats[key]);
    return {
      key,
      label: statLabel(key),
      current,
      candidate,
      delta: roundStatValue(candidate - current),
    };
  });
}

function buildGearSearchStatFilters(slotId, filters) {
  const clean = [];
  const equipment = [];
  const composite = [];
  const unsupported = [];
  for (const item of filters || []) {
    const key = item && item.key;
    const equipmentId = GEAR_EQUIPMENT_FILTER_IDS[key];
    const equipmentValue = {};
    const min = Number(item && item.min);
    const max = Number(item && item.max);
    if (Number.isFinite(min)) equipmentValue.min = min;
    if (Number.isFinite(max)) equipmentValue.max = max;
    if (equipmentId) {
      equipment.push({ key, id: equipmentId, value: Object.keys(equipmentValue).length ? equipmentValue : undefined });
      continue;
    }

    const compositeKeys = GEAR_COMPOSITE_STAT_GROUPS[key];
    if (compositeKeys) {
      const compositeFilters = compositeKeys
        .map((statKey) => UPGRADE_STAT_IDS[statKey])
        .filter(Boolean)
        .map((id) => ({ id }));
      if (compositeFilters.length) {
        const value = {};
        if (Number.isFinite(min)) value.min = min;
        if (Number.isFinite(max)) value.max = max;
        // Anonymous Trade2 rejects `sum`/`weight` stat groups with HTTP 400
        // "Query is too complex" (those need a logged-in session). Use a broad
        // `count` prefilter (>=1 component present) to narrow candidates, then
        // enforce the real combined min/max locally via postValue +
        // compositeStatsSatisfied on the fetched listings.
        composite.push({
          key,
          type: "count",
          filters: compositeFilters,
          value: { min: 1 },
          postValue: Object.keys(value).length ? value : undefined,
        });
        continue;
      }
    }

    const id = gearStatId(key, slotId) || (item && item.id);
    if (!id) {
      if (key) unsupported.push(key);
      continue;
    }
    const value = {};
    const statMin = Number(item.min);
    const statMax = Number(item.max);
    if (Number.isFinite(statMin)) value.min = statMin;
    if (Number.isFinite(statMax)) value.max = statMax;
    clean.push({ key, id, value: Object.keys(value).length ? value : undefined });
  }
  return { statFilters: clean, equipmentFilters: equipment, compositeFilters: composite, unsupported };
}

function buildGearSearchQuery(input, slot) {
  const slotId = input.slot || "bow";
  const { statFilters, equipmentFilters, compositeFilters, unsupported } = buildGearSearchStatFilters(slotId, input.filters);
  const queryFilters = statFilters.map((filter) => filter.value ? ({ id: filter.id, value: filter.value }) : ({ id: filter.id }));
  const equipmentQueryFilters = {};
  for (const filter of equipmentFilters) {
    equipmentQueryFilters[filter.id] = filter.value || {};
  }
  // Count-mode threshold is computed HERE from the actual searchable (count-
  // group) filter count, NOT the UI row count. The UI row count also includes
  // dps (an equipment_filter) and composite groups, which are NOT in this count
  // group; basing the threshold on it rounded up to strict-AND for real weapons.
  // round(0.6*n) is always <= n-1 for n>=2, so auto mode never collapses to AND.
  // A user-typed minMatches overrides; capped to the group size.
  const isCount = input.matchMode !== "all";
  const userMin = Number(input.minMatches);
  const autoMin = Math.max(1, Math.round(queryFilters.length * 0.6));
  const countMin = Math.min(Number.isFinite(userMin) && userMin > 0 ? userMin : autoMin, Math.max(1, queryFilters.length));
  const query = {
    query: {
      status: { option: input.status === "any" ? "any" : "online" },
      filters: {
        type_filters: {
          filters: {
            category: { option: slot.category },
            rarity: { option: "nonunique" },
          },
        },
        misc_filters: {
          filters: {
            corrupted: { option: "false" },
          },
        },
        equipment_filters: {
          filters: equipmentQueryFilters,
        },
        // Deliberately NO trade_filters.price: setting price.option to a single
        // currency makes Trade2 return ONLY items listed in that currency (e.g.
        // "divine" hid ~80% of the market — every exalt/chaos listing). Instead
        // sort by price asc (Trade2 converts across currencies for the sort) and
        // enforce the budget LOCALLY on the converted value in searchGear.
      },
      stats: queryFilters.length ? [{
        type: isCount ? "count" : "and",
        filters: queryFilters,
        value: isCount ? { min: countMin } : undefined,
      }] : [],
    },
    sort: { price: "asc" },
  };
  for (const group of compositeFilters) {
    query.query.stats.push({
      type: group.type,
      filters: group.filters,
      value: group.value,
    });
  }
  if (!Object.keys(equipmentQueryFilters).length) delete query.query.filters.equipment_filters;
  if (query.query.stats[0] && !query.query.stats[0].value) delete query.query.stats[0].value;
  return { query, statFilters, equipmentFilters, compositeFilters, unsupported, matchMin: isCount ? countMin : queryFilters.length, matchOf: queryFilters.length };
}

function compositeStatsSatisfied(stats, compositeFilters) {
  const misses = [];
  for (const filter of compositeFilters || []) {
    const value = filter && filter.postValue;
    if (!value) continue;
    const statValue = Number(stats && stats[filter.key]) || 0;
    if (Number.isFinite(Number(value.min)) && statValue < Number(value.min)) misses.push({ key: filter.key, value: statValue, min: Number(value.min) });
    if (Number.isFinite(Number(value.max)) && statValue > Number(value.max)) misses.push({ key: filter.key, value: statValue, max: Number(value.max) });
  }
  return { ok: misses.length === 0, misses };
}

// Derived/aggregate or equipment-property keys whose stored value does not map
// 1:1 to a single explicit trade stat, so they must not become per-item filters.
const LISTING_SPEC_SKIP_KEYS = new Set([
  "totalLife", "totalElementalRes", "totalResistance", "totalFlatAttack",
  "totalFlatElementalAttack", "totalLocalFlatElemental", "totalLocalFlat", "flatEle",
  "totalEnergyShield", "totalMovementSpeed", "totalStr", "totalDex", "totalInt",
  "totalAllAttributes", "totalAttributes", "attributes", "explicitAttributes",
  "evasion", "energyShield", "deflection", "dps",
  // The parser folds "+X% to all Elemental Resistances" into fire/cold/lightning
  // and "+X to all Attributes" into str/dex/int, so these values can exceed the
  // single explicit stat the trade id filters on and would exclude the item
  // itself. chaosRes has no such folding and stays.
  "fireRes", "coldRes", "lightningRes", "str", "dex", "int",
]);

// Build a compact, self-contained spec for a single listing so the front end can
// later ask the server to open the official Trade UI focused on (essentially)
// that item. Only explicit single-mod stats are used; price + base type are the
// strongest discriminators. No server-side state is kept.
function buildListingSpec(slot, item, candidateStats, rawPrice) {
  const stats = [];
  for (const [key, value] of Object.entries(candidateStats || {})) {
    if (LISTING_SPEC_SKIP_KEYS.has(key)) continue;
    const id = UPGRADE_STAT_IDS[key];
    if (!id || !id.startsWith("explicit.")) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) continue;
    stats.push({ id, value: num });
  }
  stats.sort((a, b) => b.value - a.value);
  // Note: we deliberately do not pin query.type. For magic/rare items the trade
  // `typeLine` is the affixed name (e.g. "Virile Pearl Ring of Magma"), not a
  // valid base type, which GGG rejects. Category + exact price + a tight stat
  // band are specific enough to surface this listing.
  const spec = {
    category: slot && slot.category ? slot.category : "",
    stats: stats.slice(0, 6).map((s) => ({ id: s.id, value: s.value })),
  };
  if (rawPrice && rawPrice.currency && Number.isFinite(Number(rawPrice.amount))) {
    spec.price = { option: String(rawPrice.currency), amount: Number(rawPrice.amount) };
  }
  return spec;
}

function buildListingTradeQuery(spec) {
  const filters = { type_filters: { filters: { rarity: { option: "nonunique" } } } };
  if (spec && spec.category) {
    filters.type_filters.filters.category = { option: String(spec.category) };
  }
  if (spec && spec.price && spec.price.option && Number.isFinite(Number(spec.price.amount))) {
    const amount = Number(spec.price.amount);
    filters.trade_filters = { filters: { price: { option: String(spec.price.option), min: amount, max: amount } } };
  }
  // Filter each stat by min = its rolled value (floored). An exact band would
  // wrongly exclude the item, because GGG normalizes some mods differently than
  // our parser (e.g. "+X% to all Elemental Resistances" is its own stat, not the
  // fire/cold/lightning ids). Combined with category + exact price this yields a
  // focused, price-sorted search that always contains the listing near the top.
  const statFilters = ((spec && spec.stats) || [])
    .filter((s) => s && s.id)
    .slice(0, 8)
    .map((s) => {
      const num = Number(s.value);
      if (!Number.isFinite(num)) return { id: String(s.id) };
      return { id: String(s.id), value: { min: Math.floor(num) } };
    });
  const query = {
    // "any" so the item is viewable even if the seller is currently offline.
    query: { status: { option: "any" }, filters, stats: statFilters.length ? [{ type: "and", filters: statFilters }] : [] },
    sort: { price: "asc" },
  };
  return query;
}

async function gearListingLink(input) {
  const spec = input && input.spec;
  if (!spec || typeof spec !== "object") throw new Error("Missing listing spec");
  const league = input.league || UPGRADE_GUIDE_PROFILE.league;
  const status = tradeStatus();
  if (status.limited) return { limited: true, tradeStatus: status };
  const query = buildListingTradeQuery(spec);
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const search = await fetchTrade(searchUrl, { method: "POST", body: JSON.stringify(query) });
  const resultUrl = "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(league) + "/" + search.id;
  return { url: resultUrl, total: search.total || 0, query, tradeStatus: tradeStatus() };
}

function analyzeGearSearch(text) {
  const analysis = analyzeUpgradeState(text);
  const slots = gearSearchSlots();
  const equipped = {};
  let ringIndex = 0;
  for (const item of analysis.items || []) {
    if (item.slot === "ring") {
      ringIndex += 1;
      const ringSlot = ringIndex === 1 ? "ring1" : "ring2";
      if (!equipped[ringSlot]) equipped[ringSlot] = { ...item, slot: ringSlot };
      continue;
    }
    if (item.slot && !equipped[item.slot]) equipped[item.slot] = item;
  }
  return {
    slots,
    items: analysis.items,
    equipped,
    totals: analysis.totals,
    updated: analysis.updated,
  };
}

// ── Gear Upgrade Finder: Path of Building import ───────────────────────────
// PoB stores each equipped item as in-game item TEXT inside <Item> tags (so
// parseItemStats handles them), <Slot> maps items to equipment slots, and
// <PlayerStat> holds PoB's computed build stats. A pasted PoB export is URL-safe
// base64 of zlib-deflated XML; a saved .build/.xml is raw XML.
const POB_BUILDS_DIR = process.env.POB_BUILDS_DIR ||
  path.join(process.env.USERPROFILE || os.homedir(), "Documents", "Path of Building (PoE2)", "Builds");
const POB_SLOT_MAP = {
  "Helmet": "helmet", "Body Armour": "chest", "Gloves": "gloves", "Boots": "boots",
  "Amulet": "amulet", "Ring 1": "ring1", "Ring 2": "ring2", "Belt": "belt",
};
// Reverse: tool slot id → PoB slot name (the headless calc keys on PoB names).
const TOOL_TO_POB_SLOT = {
  helmet: "Helmet", chest: "Body Armour", gloves: "Gloves", boots: "Boots",
  amulet: "Amulet", ring1: "Ring 1", ring2: "Ring 2", belt: "Belt",
  quiver: "Weapon 2", focus: "Weapon 2", shield: "Weapon 2", buckler: "Weapon 2",
};
function toolSlotToPob(slotId) {
  return TOOL_TO_POB_SLOT[slotId] ||
    (/(bow|crossbow|wand|staff|sceptre|spear|mace|sword|axe|dagger|flail|focus|shield)/i.test(slotId) ? "Weapon 1" : slotId);
}

function decodePobCode(code) {
  const b64 = String(code).trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(b64, "base64");
  try { return zlib.inflateSync(buf).toString("utf8"); }
  catch { return zlib.inflateRawSync(buf).toString("utf8"); }
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Weapon-slot id from a PoB item's text (no "Item Class:" line). PRIMARY: match the
// base-type line against PoB's base list — authoritative, handles melee bases whose
// name lacks the class word (e.g. "Gladius"→onesword) and quarterstaves (PoB types
// them "Staff"/subType Warstaff). FALLBACK: keyword sniff for magic items (base is
// buried in the name) or bases not in the list.
const WEAPON_SLOT_IDS = new Set(["bow", "crossbow", "quarterstaff", "spear", "claw", "dagger",
  "onesword", "twosword", "oneaxe", "twoaxe", "onemace", "twomace", "flail", "wand", "staff", "sceptre",
  "quiver", "focus", "shield", "buckler"]);
function pobWeaponSlot(raw) {
  for (const line of String(raw).split(/\r?\n/, 6)) {
    const b = POB_BASES[line.trim()];
    if (b && WEAPON_SLOT_IDS.has(b.slot)) return b.slot;
  }
  const t = String(raw).toLowerCase();
  if (/quiver/.test(t)) return "quiver";
  if (/crossbow/.test(t)) return "crossbow";
  if (/\bbow\b/.test(t)) return "bow";
  if (/quarterstaff|warstaff/.test(t)) return "quarterstaff";   // martial — must beat the bare-"staff" caster match below
  if (/\bstaff\b|staves/.test(t)) return "staff";
  if (/sceptre/.test(t)) return "sceptre";
  if (/\bwand\b/.test(t)) return "wand";
  if (/\bspear\b/.test(t)) return "spear";
  if (/\bclaw\b/.test(t)) return "claw";
  if (/\bdagger\b/.test(t)) return "dagger";
  if (/\bflail\b/.test(t)) return "flail";
  return null;
}

function parsePobBuild(xml) {
  // id -> item text (strip child tags like <ModRange/>, keep mod lines)
  const items = {};
  let m;
  const itemRe = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/g;
  while ((m = itemRe.exec(xml))) {
    const id = (m[1].match(/\bid="(\d+)"/) || [])[1];
    if (!id) continue;
    items[id] = unescapeXml(m[2].replace(/<[^>]+>/g, "")).split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }
  // slot name -> itemId
  const slots = {};
  const slotRe = /<Slot\b([^>]*?)\/?>/g;
  while ((m = slotRe.exec(xml))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/) || [])[1];
    const itemId = (attrs.match(/\bitemId="(\d+)"/) || [])[1];
    if (!name || !itemId || itemId === "0" || !items[itemId]) continue;
    let slotId = POB_SLOT_MAP[name];
    if (!slotId && /^Weapon [12]$/.test(name)) slotId = pobWeaponSlot(items[itemId]);
    if (!slotId || slots[slotId]) continue; // skip flasks/jewels/sockets/swap + dupes
    const raw = items[itemId];
    const baseSlot = slotId === "ring1" || slotId === "ring2" ? "ring" : slotId;
    slots[slotId] = { pobSlot: name, name: (raw.split("\n")[1] || raw.split("\n")[0] || "").trim(), raw, stats: parseItemStats(raw, baseSlot) };
  }
  // PoB computed stats — <PlayerStat value="X" stat="Y"/> (value first)
  const build = {};
  const psRe = /<PlayerStat\b([^>]*?)\/?>/g;
  while ((m = psRe.exec(xml))) {
    const v = (m[1].match(/\bvalue="([^"]*)"/) || [])[1];
    const s = (m[1].match(/\bstat="([^"]+)"/) || [])[1];
    if (s != null && v != null) build[s] = isNaN(Number(v)) ? v : Number(v);
  }
  return { slots, build };
}

// List saved PoB builds (name + mtime), newest first. [] if the dir is absent.
function listPobBuilds() {
  try {
    return fs.readdirSync(POB_BUILDS_DIR)
      .filter((f) => /\.(xml|build)$/i.test(f))
      .map((f) => ({ file: f, name: f.replace(/\.(xml|build)$/i, ""), mtime: fs.statSync(path.join(POB_BUILDS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

// ── Per-slot stat weights via headless perturbation ────────────────────────
// For each rollable stat of a slot, add a known increment to the CURRENT item
// and recompute the build — the change in DPS (or EHP, for a 0-DPS build) per
// unit is that stat's marginal value FOR THIS BUILD. The killer feature: a
// capped resist scores ~0 (no marginal EHP), an under-cap one scores high.
// Each value is a PoB-parseable mod line + a sensible probe increment.
const GEAR_PROBE_TEMPLATES = {
  life: [50, (n) => `+${n} to maximum Life`],
  mana: [60, (n) => `+${n} to maximum Mana`],
  energyShield: [50, (n) => `+${n} to maximum Energy Shield`],
  evasion: [120, (n) => `+${n} to Evasion Rating`],
  armour: [120, (n) => `+${n} to Armour`],
  fireRes: [20, (n) => `+${n}% to Fire Resistance`],
  coldRes: [20, (n) => `+${n}% to Cold Resistance`],
  lightningRes: [20, (n) => `+${n}% to Lightning Resistance`],
  chaosRes: [15, (n) => `+${n}% to Chaos Resistance`],
  str: [30, (n) => `+${n} to Strength`],
  dex: [30, (n) => `+${n} to Dexterity`],
  int: [30, (n) => `+${n} to Intelligence`],
  spirit: [20, (n) => `+${n} to Spirit`],
  manaRegen: [30, (n) => `${n}% increased Mana Regeneration Rate`],
  movementSpeed: [15, (n) => `${n}% increased Movement Speed`],
  critChance: [40, (n) => `${n}% increased Critical Hit Chance`],
  critDamage: [40, (n) => `${n}% increased Critical Damage Bonus`],
  attackSpeed: [15, (n) => `${n}% increased Attack Speed`],
  castSpeed: [15, (n) => `${n}% increased Cast Speed`],
  spellDamage: [40, (n) => `${n}% increased Spell Damage`],
  projectileDamage: [40, (n) => `${n}% increased Projectile Damage`],
  manaOnKill: [10, (n) => `Recover ${n} Mana on Kill`],
  flatPhysAttack: [20, (n) => `Adds ${n} to ${n} Physical Damage to Attacks`],
  flatFireAttack: [20, (n) => `Adds ${n} to ${n} Fire Damage to Attacks`],
  flatColdAttack: [20, (n) => `Adds ${n} to ${n} Cold Damage to Attacks`],
  flatLightningAttack: [20, (n) => `Adds ${n} to ${n} Lightning Damage to Attacks`],
  // Skill-level mods — small increment (a single level is a big jump), so PoB measures
  // the real per-level DPS. These were in the filter lists but had NO probe template,
  // so +skills never got a weight and were never searched for. Now they are.
  levelAllSpellSkills: [2, (n) => `+${n} to Level of all Spell Skills`],
  levelAllMinionSkills: [2, (n) => `+${n} to Level of all Minion Skills`],
  levelAllMeleeSkills: [2, (n) => `+${n} to Level of all Melee Skills`],
  levelAllAttackSkills: [2, (n) => `+${n} to Level of all Attack Skills`],
  projectileLevels: [2, (n) => `+${n} to Level of all Projectile Skills`],
};
const dpsOfOut = (o) => (o && (o.FullDPS || o.CombinedDPS || o.TotalDPS)) || 0;
const ehpOfOut = (o) => (o && o.TotalEHP) || 0;

async function computeGearWeights(buildXml, pobSlot, baseSlot, currentRaw) {
  await pob.load(buildXml);
  const base = await pob.calc(pobSlot, "");
  const metric = dpsOfOut(base) > 0 ? "dps" : "ehp";
  const mf = metric === "dps" ? dpsOfOut : ehpOfOut;
  const baseVal = mf(base);
  const currentStats = parseItemStats(currentRaw || "", baseSlot);
  const keys = (PRESERVE_CONTROL_STATS_BY_SLOT[baseSlot] || []).filter((k) => GEAR_PROBE_TEMPLATES[k] && gearStatId(k, baseSlot));
  const raw = [];
  for (const k of keys) {
    const [inc, line] = GEAR_PROBE_TEMPLATES[k];
    let per = 0;
    try { per = (mf(await pob.calc(pobSlot, currentRaw + "\n" + line(inc))) - baseVal) / inc; } catch {}
    if (per > 1e-4) raw.push({ key: k, statId: gearStatId(k, baseSlot), label: statLabel(k), perUnit: Math.round(per * 100) / 100, cur: Math.round(currentStats[k] || 0) });
  }
  const max = raw.reduce((m, w) => Math.max(m, w.perUnit), 0) || 1;
  const weights = raw.map((w) => ({ ...w, weight: Math.max(1, Math.round((w.perUnit / max) * 20)) })).sort((a, b) => b.weight - a.weight);
  return { metric, base: { Life: base.Life, EnergyShield: base.EnergyShield, TotalEHP: base.TotalEHP, dps: dpsOfOut(base) }, weights };
}

// A build-weighted Trade2 query: the `weight` group ranks items by the weighted
// sum of their stats. But a pure weighted sum is LINEAR while DPS is often
// multiplicative — an item heavy on flat damage but missing your top multiplier
// (attack speed, crit) scores high yet is a real downgrade. So we also GATE the
// query: the candidate must roll at least 60% of your current item's value on
// the top-weighted stat. Anonymous POST of a weight group 400s ("log in") — so
// this is POSTed by the user's logged-in browser (the snippet).
function buildWeightedGearQuery(slot, weights, league, maxPriceDiv) {
  const stats = [{ type: "weight", filters: weights.map((w) => ({ id: w.statId, value: { weight: w.weight } })), value: {} }];
  const top = weights[0];
  if (top && top.cur > 0) stats.push({ type: "and", filters: [{ id: top.statId, value: { min: Math.floor(top.cur * 0.6) } }] });
  const q = {
    query: {
      status: { option: GEAR_TRADE_STATUS },
      filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } },
      stats,
    },
    sort: { "statgroup.0": "desc" },
  };
  if (Number(maxPriceDiv) > 0) q.query.filters.trade_filters = { filters: { price: { option: "divine", max: Number(maxPriceDiv) } } };
  return q;
}

// Trade-site copies usually OMIT the item name + base type (they start at the
// item class), and PoB can't read an item with no base. Fallback: graft the
// pasted item's MOD lines onto the user's CURRENT item's base — the DPS impact
// (mod-driven) is accurate; defences use the current base (approximate). Returns
// a PoB-parseable item string, or null if it can't.
function reconstructItem(currentRaw, candidateRaw) {
  const cl = String(currentRaw || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const rarity = ((cl[0] || "").match(/Rarity:\s*(\w+)/i) || [])[1] || "";
  const base = /RARE|UNIQUE|RELIC/i.test(rarity) ? cl[2] : cl[1]; // rarity,name,base (rare) | rarity,base (magic/normal)
  if (!base) return null;
  const ilvl = (String(candidateRaw).match(/Item Level:\s*(\d+)/i) || [])[1] || "81";
  const mods = [];
  for (const line of String(candidateRaw).split("\n").map((l) => l.trim())) {
    if (!line) continue;
    if (/^[A-Za-z][A-Za-z '/]*:\s/.test(line)) continue;   // "Label: value" property/meta line (Evasion Rating: 94, Requires:, Item Level:, Sum:)
    if (!/\d/.test(line)) continue;                        // mods carry a number; bare class/base words and flavour don't
    mods.push(line.replace(/\{[^}]*\}/g, "").trim());
  }
  if (!mods.length) return null;
  // Graft the base's real implicit (from PoB data) at mid-roll, so a baseless paste
  // scores closer to the truth. Ranges "(20-30)" → midpoint; non-ranged left as-is.
  const baseImpl = (POB_BASES[base] && POB_BASES[base].implicit) || null;
  const implLine = baseImpl ? baseImpl.replace(/\((\d+)-(\d+)\)/g, (_, a, b) => Math.round((+a + +b) / 2)) : null;
  return `Rarity: RARE\nPasted Candidate\n${base}\nItem Level: ${ilvl}\nImplicits: ${implLine ? 1 : 0}\n${implLine ? implLine + "\n" : ""}${mods.join("\n")}`;
}

// GGG's listing.account.online is null when offline, otherwise an object that
// may carry status "afk"/"dnd" (absent = plain online). Note: this reflects the
// seller, not whether the item is still in their stash.
function sellerOnlineStatus(account) {
  const online = account && account.online;
  if (!online) return "offline";
  return online.status === "afk" ? "afk" : online.status === "dnd" ? "dnd" : "online";
}

async function searchGear(input) {
  const league = input.league || UPGRADE_GUIDE_PROFILE.league;
  const slotId = input.slot || "bow";
  const slots = gearSearchSlots();
  const slot = slots[slotId] || slots[slotId === "ring1" || slotId === "ring2" ? "ring1" : slotId] || UPGRADE_GUIDE_PROFILE.slots[slotId];
  if (!slot) throw new Error("Unknown slot");
  const current = input.current || {};
  const currentStats = current.raw ? parseItemStats(current.raw, slotId) : (current.stats || {});
  const { query, statFilters, equipmentFilters, compositeFilters, unsupported, matchMin, matchOf } = buildGearSearchQuery(input, slot);
  const maxPriceDiv = Number(input.maxPriceDiv ?? input.maxPriceEx) || 0;
  const preview = {
    league,
    slot: slotId,
    query,
    statFilters,
    equipmentFilters,
    compositeFilters,
    unsupportedFilters: unsupported,
    matchMin,
    matchOf,
    maxPriceDiv,
  };
  if (input.previewOnly) return { ...preview, listings: [], tradeStatus: tradeStatus(), updated: new Date().toISOString() };

  const status = tradeStatus();
  if (status.limited) return { ...preview, limited: true, listings: [], tradeStatus: status, updated: new Date().toISOString() };

  const rates = await getExchangeRates(league);
  // Budget is enforced LOCALLY on the converted value (see buildGearSearchQuery:
  // no currency price filter is sent, so listings span exalt/chaos/divine and
  // arrive cheapest-first). Skip budget if we can't convert (no divine rate)
  // rather than wrongly hiding everything.
  const divineRate = Number(rates.divine) || 0;
  const budgetEx = maxPriceDiv > 0 && divineRate > 0 ? maxPriceDiv * divineRate : 0;
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const search = await fetchTrade(searchUrl, { method: "POST", body: JSON.stringify(query) });
  const resultUrl = "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(league) + "/" + search.id;
  const hasCompositePostFilters = compositeFilters.some((filter) => filter && filter.postValue);
  const fetchLimit = hasCompositePostFilters ? 60 : 20;
  const ids = (search.result || []).slice(0, fetchLimit);
  const fetchedResults = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    if (!chunk.length) continue;
    const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + chunk.join(",") + "?query=" + encodeURIComponent(search.id);
    const fetched = await fetchTrade(fetchUrl);
    fetchedResults.push(...(fetched.result || []));
  }

  const preferredKeys = PRESERVE_CONTROL_STATS_BY_SLOT[slot.baseId || slotId] || [];
  const listings = [];
  for (const entry of fetchedResults) {
    const price = listingPriceFromEntry(entry, rates);
    if (!price || price.exalted <= 0) continue;
    if (budgetEx > 0 && price.exalted > budgetEx) continue;
    const item = entry.item || {};
    const candidateStats = parseItemStats(itemTextFromTradeEntry(entry), slotId);
    if (!compositeStatsSatisfied(candidateStats, compositeFilters).ok) continue;
    listings.push({
      id: entry.id,
      slot: slotId,
      name: [item.name, item.typeLine].filter(Boolean).join(" ").trim() || slot.label,
      typeLine: item.typeLine || "",
      priceEx: price.exalted,
      priceDiv: price.divine,
      rawPrice: price.raw,
      seller: entry.listing && entry.listing.account ? (entry.listing.account.name || "") : "",
      sellerStatus: sellerOnlineStatus(entry.listing && entry.listing.account),
      listedAt: entry.listing ? (entry.listing.indexed || "") : "",
      whisper: entry.listing && entry.listing.whisper ? entry.listing.whisper : "",
      stats: compactStats(candidateStats, 12),
      candidateStats,
      comparison: statComparison(currentStats, candidateStats, preferredKeys),
      tradeSpec: buildListingSpec(slot, item, candidateStats, entry.listing && entry.listing.price),
    });
  }

  return {
    ...preview,
    searchId: search.id,
    total: search.total || (search.result ? search.result.length : 0),
    fetched: fetchedResults.length,
    url: resultUrl,
    currentStats: compactStats(currentStats, 20),
    listings: listings.slice(0, 20),
    tradeStatus: tradeStatus(),
    updated: new Date().toISOString(),
  };
}

async function searchUpgradeSlot(input) {
  const league = input.league || UPGRADE_GUIDE_PROFILE.league;
  const slotId = input.slot || "bow";
  const slot = UPGRADE_GUIDE_PROFILE.slots[slotId];
  if (!slot) throw new Error("Unknown slot");
  const status = tradeStatus();
  if (status.limited) return { limited: true, tradeStatus: status, options: [] };
  const current = input.current || {};
  if (isGuideLockedUnique(current, slotId)) {
    return {
      league,
      slot: slotId,
      locked: true,
      options: [],
      message: "Guide-approved unique equipped; slot ignored for upgrades.",
      tradeStatus: tradeStatus(),
    };
  }
  const currentStats = current.raw ? parseItemStats(current.raw, slotId) : (current.stats || {});
  const currentScore = scoreStatsForSlot(currentStats, slotId);
  const currentDps = Number(currentStats.dps) || 0;
  const currentTotals = input.totals || {};
  const maxPriceEx = Number(input.maxPriceEx) || 0;
  const resistanceBand = replacementResistanceBand(currentStats);
  const preserveStats = Array.isArray(input.preserveStats) ? input.preserveStats : [];
  const excludedStats = Array.isArray(input.excludedStats) ? input.excludedStats : [];
  const preserveFilters = buildPreserveStatFilters(preserveStats);
  const query = buildUpgradeStatsFilters(slotId, maxPriceEx, resistanceBand, preserveStats, excludedStats);
  const rates = await getExchangeRates(league);
  const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
  const search = await fetchTrade(searchUrl, { method: "POST", body: JSON.stringify(query) });
  const resultUrl = "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(league) + "/" + search.id;
  const allIds = search.result || [];
  const idSet = new Set();
  for (const index of [0, 1, 2, 3, 4, 5, 10, 15, 25, 40, 70, 100, 150, 220, 320]) {
    if (allIds[index]) idSet.add(allIds[index]);
  }
  const ids = Array.from(idSet).slice(0, 15);
  const baseDiagnostics = {
    searched: search.total || search.result.length || 0,
    fetched: 0,
    hardFilters: 0,
    noPrice: 0,
    hardGateRejected: 0,
    floorRejected: 0,
    preserveRejected: 0,
    lowScoreRejected: 0,
    resistanceBand: resistanceBand ? resistanceBand.min + "-" + resistanceBand.max : "",
    currentResistance: resistanceBand ? resistanceBand.total : 0,
    preserveFilters: preserveFilters.length,
    excludedStats,
    preserveStats: preserveFilters.map((item) => ({
      key: item.key,
      id: item.id,
      min: item.value && item.value.min,
      max: item.value && item.value.max,
      required: !item.value,
    })),
    currentScore,
    bestRejected: null,
    rejectSamples: [],
  };
  if (!ids.length) {
    const empty = { league, slot: slotId, query, searchId: search.id, url: resultUrl, diagnostics: baseDiagnostics, options: [], updated: new Date().toISOString() };
    return { ...empty, tradeStatus: tradeStatus() };
  }
  const fetchedResults = [];
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const fetchUrl = "https://www.pathofexile.com/api/trade2/fetch/" + chunk.join(",") + "?query=" + encodeURIComponent(search.id);
    const fetched = await fetchTrade(fetchUrl);
    fetchedResults.push(...(fetched.result || []));
  }
  const options = [];
  const diagnostics = baseDiagnostics;
  const rejected = [];
  for (const entry of fetchedResults) {
    diagnostics.fetched++;
    const price = listingPriceFromEntry(entry, rates);
    if (!price || price.exalted <= 0) { diagnostics.noPrice++; continue; }
    const stats = parseItemStats(itemTextFromTradeEntry(entry), slotId);
    const preserveCheck = preserveStatsSatisfied(stats, preserveStats);
    if (!preserveCheck.ok) {
      diagnostics.preserveRejected++;
      rejected.push({
        name: [entry.item && entry.item.name, entry.item && entry.item.typeLine].filter(Boolean).join(" ") || slot.label,
        priceEx: price.exalted,
        rawPrice: price.raw,
        score: scoreStatsForSlot(stats, slotId),
        gain: 0,
        stats: compactStats(stats),
        preserveMisses: preserveCheck.misses,
      });
      continue;
    }
    if (slotId === "bow" && currentDps > 0 && (Number(stats.dps) || 0) < currentDps * 0.9) {
      diagnostics.floorRejected++;
      continue;
    }
    const nextTotals = replacementTotals(currentTotals, currentStats, stats);
    const gate = hardGateResult(currentTotals, nextTotals);
    const soft = softGoalResult(currentTotals, nextTotals);
    const score = scoreStatsForSlot(stats, slotId);
    const gain = Math.round((score - currentScore + gate.fixScore + soft.fixScore) * 100) / 100;
    if (gain <= 0) {
      diagnostics.lowScoreRejected++;
      rejected.push({
        name: [entry.item && entry.item.name, entry.item && entry.item.typeLine].filter(Boolean).join(" ") || slot.label,
        priceEx: price.exalted,
        rawPrice: price.raw,
        score,
        gain,
        stats: compactStats(stats),
      });
      continue;
    }
    const explanation = buildUpgradeExplanation(slotId, currentStats, stats);
    const focusQuery = buildFocusTradeQuery(slotId, entry.item || {}, stats, price.exalted);
    options.push({
      id: entry.id,
      name: [entry.item && entry.item.name, entry.item && entry.item.typeLine].filter(Boolean).join(" ") || slot.label,
      priceEx: price.exalted,
      rawPrice: price.raw,
      score,
      gain,
      value: Math.round((gain / price.exalted) * 100) / 100,
      stats,
      explanation,
      hardFixScore: gate.fixScore,
      softFixScore: soft.fixScore,
      softChanges: soft.changes,
      preserveStats: preserveFilters.map((item) => ({
        key: item.key,
        id: item.id,
        min: item.value && item.value.min,
        max: item.value && item.value.max,
        required: !item.value,
      })),
      hardStatus: summarizeHardStatChange(currentTotals, nextTotals),
      hardLosses: summarizeHardLosses(currentTotals, nextTotals),
      hardViolations: gate.violations,
      guideReason: slot.notes,
      seller: entry.listing && entry.listing.account ? (entry.listing.account.name || "") : "",
      listedAt: entry.listing ? (entry.listing.indexed || "") : "",
      whisper: entry.listing && entry.listing.whisper,
      url: resultUrl,
      focusQuery,
    });
  }
  options.sort((a, b) => b.value - a.value || a.priceEx - b.priceEx);
  rejected.sort((a, b) => b.gain - a.gain || b.score - a.score);
  diagnostics.bestRejected = rejected[0] || null;
  diagnostics.rejectSamples = rejected.slice(0, 3);
  const result = { league, slot: slotId, query, searchId: search.id, url: resultUrl, diagnostics, options: options.slice(0, 3), updated: new Date().toISOString() };
  return { ...result, cached: false, tradeStatus: tradeStatus() };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + HOST + ":" + PORT);

    // Shared-secret gate — ONLY when bound beyond localhost (LAN/Tailscale) and a
    // token is set, so default 127.0.0.1 dev is untouched and a missing token can't
    // lock you out. Browsers can't add headers on navigation, so bootstrap once via
    // ?key=… → long-lived cookie. ponytail: a single shared secret, not real auth;
    // upgrade to per-user tokens only if this ever faces the open internet.
    const GATE = HOST !== "127.0.0.1" && process.env.POE_AUTH_TOKEN;
    if (GATE) {
      const qsKey = url.searchParams.get("key");
      if (qsKey === GATE) res.setHeader("Set-Cookie", "poe_auth=" + GATE + "; Path=/; Max-Age=31536000; SameSite=Lax");
      if (qsKey !== GATE && !(req.headers.cookie || "").includes("poe_auth=" + GATE)) {
        send(res, 403, "Forbidden — open this URL once with ?key=YOUR_TOKEN");
        return;
      }
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/prices") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const body = JSON.stringify(await fetchPrices(league));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/optimizer/materials") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const materials = await fetchOptimizerMaterials(league);
      send(res, 200, JSON.stringify({
        league,
        currencyRates: materials.currencyRates,
        count: materials.count,
        materials: Object.values(materials.byId).sort((a, b) => a.name.localeCompare(b.name)),
        updated: materials.updated,
      }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/optimizer/opportunities") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const family = url.searchParams.get("family") || "quiver";
      const iterations = Number(url.searchParams.get("iterations")) || OPTIMIZER_ITERATIONS;
      const body = JSON.stringify(await buildOptimizerOpportunities(league, { family, iterations }));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/optimizer/simulate" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || "Runes of Aldur";
      const target = QUIVER_TARGETS.find((item) => item.id === input.targetId) || QUIVER_TARGETS[0];
      const route = QUIVER_ROUTES[input.routeId] || QUIVER_ROUTES[target.routes[0]];
      const materials = await fetchOptimizerMaterials(league);
      const simulation = simulateRoute(target, route, materials, {
        iterations: input.iterations,
        seed: input.seed || league,
        priceOverrides: input.priceOverrides,
        modWeightOverrides: input.modWeightOverrides,
      });
      send(res, 200, JSON.stringify({ league, target, route, simulation, updated: new Date().toISOString() }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/trade-status") {
      send(res, 200, JSON.stringify(tradeStatus()), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/waystone/market-weights") {
      send(res, 200, JSON.stringify({ weights: readWaystoneWeights(), tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/waystone/exchange") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      send(res, 200, JSON.stringify(await getWaystoneExchange(league)), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/currency/overview") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const force = url.searchParams.get("refresh") === "1";
      send(res, 200, JSON.stringify(await getCurrencyOverview(league, force)), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/economy/history") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const force = url.searchParams.get("refresh") === "1";
      // Force = sample now (manual ↻, bounded by the rate limit); otherwise sample
      // in the background only when a twice-a-day point is due.
      if (force) { try { await sampleEconomy(league); } catch {} }
      else maybeSampleEconomy(league);
      const data = readEconomy() || { league, items: ECONOMY_ITEMS, points: [] };
      // Headline + cards render off `current` — the live, strip-shared rates — so
      // they show what's current, not the last twice-a-day history point. `points`
      // still drives the trend graph + "% vs start".
      let current = null;
      try { current = await economyCurrent(league); } catch {}
      const st = tradeStatus();
      send(res, 200, JSON.stringify({ ...data, items: ECONOMY_ITEMS, current, limited: st.limited, tradeLimitedUntil: st.tradeLimitedUntil, secondsRemaining: st.secondsRemaining }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/waystone/market-weights/refresh" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || "Runes of Aldur";
      const cached = readWaystoneWeights();
      const status = tradeStatus();
      if (status.limited) {
        send(res, 200, JSON.stringify({ limited: true, weights: cached, tradeStatus: status, tradeLimitedUntil: status.tradeLimitedUntil }), "application/json; charset=utf-8");
        return;
      }
      // Cooldown so a button can't hammer the shared limit (override with force).
      if (!input.force && cached && cached.updated && Date.now() - new Date(cached.updated).getTime() < WAYSTONE_SWEEP_COOLDOWN_MS) {
        send(res, 200, JSON.stringify({ cooldown: true, weights: cached, tradeStatus: status }), "application/json; charset=utf-8");
        return;
      }
      try {
        const weights = await runWaystoneSweep(league);
        try { fs.writeFileSync(WAYSTONE_WEIGHTS_FILE, JSON.stringify(weights, null, 2)); } catch {}
        send(res, 200, JSON.stringify({ refreshed: true, weights, tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
      } catch (err) {
        const limited = /rate limited/i.test(String(err && err.message));
        // Never overwrite a good cache on a partial/failed sweep.
        send(res, 200, JSON.stringify({ limited, error: limited ? undefined : String(err && err.message), weights: cached, tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
      }
      return;
    }

    if (url.pathname === "/api/arbitrage/scan" && req.method === "POST") {
      const input = await readJson(req);
      try {
        send(res, 200, JSON.stringify(await scanArbitrage(input)), "application/json; charset=utf-8");
      } catch (err) {
        const cached = readJsonFile(ARBITRAGE_CACHE_FILE, null);
        const limited = /rate limited/i.test(String(err && err.message));
        send(res, 200, JSON.stringify({
          limited,
          stale: Boolean(cached),
          error: limited ? undefined : String(err && err.message),
          tradeStatus: tradeStatus(),
          ...(cached || { opportunities: [], errors: [] }),
        }), "application/json; charset=utf-8");
      }
      return;
    }

    if (url.pathname === "/api/rune-prices" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || "Runes of Aldur";
      const body = JSON.stringify(await fetchRunePrices(input.text || "", league, input.forceFresh === true));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    // Ingest currency-exchange prices pasted from the poe.ninja browser snippet
    // (poe.ninja is Cloudflare-blocked server-side, so the user's browser fetches it).
    // Accepts {prices:{name:ex}} or {text:"Name<tab>ex\n..."}.
    if (url.pathname === "/api/currency-overrides" && req.method === "POST") {
      const input = await readJson(req);
      let prices = {};
      if (input.prices && typeof input.prices === "object") prices = input.prices;
      else if (input.text) {
        for (const line of String(input.text).split(/\r?\n/)) {
          const m = line.match(/^\s*(.+?)\s*[\t=:]\s*([\d.]+)\s*(?:ex)?\s*$/i);
          if (m) prices[m[1].trim()] = Number(m[2]);
        }
      }
      const saved = writeCurrencyOverrides(prices);
      send(res, 200, JSON.stringify({ saved }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/tab-tracker" && req.method === "POST") {
      // Paste-mode ingest: items read browser-side (on pathofexile.com via VPN).
      const input = await readJson(req);
      const account = String(input.account || "").trim();
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const body = JSON.stringify(await fetchTrackedTab(account, league, false, null, String(input.items || ""), true));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/tab-tracker") {
      const account = (url.searchParams.get("account") || "").trim();
      const league = sanitizeLeague(url.searchParams.get("league") || "Runes of Aldur");
      const refresh = url.searchParams.get("refresh") === "1";
      const pasteMode = url.searchParams.get("paste") === "1";
      const markers = parseTabMarkers(url.searchParams.get("markers"));
      const body = JSON.stringify(await fetchTrackedTab(account, league, refresh, markers, null, pasteMode));
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

      const rates = await getExchangeRates(league);
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

    if (url.pathname === "/api/jewel/price" && req.method === "POST") {
      const input = await readJson(req);
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      // Trust only well-formed explicit stat ids from jewel-data.js (a bad id is a
      // safe 0-result failure, but validate the shape so we never inject junk).
      const mods = (Array.isArray(input.mods) ? input.mods : [])
        .filter((m) => m && typeof m.statId === "string" && /^explicit\.stat_\d+$/.test(m.statId))
        .map((m) => ({ statId: m.statId, min: Number(m.min) || 1 }))
        .slice(0, 3);
      if (!mods.length) {
        send(res, 400, JSON.stringify({ error: "No valid mods" }), "application/json; charset=utf-8");
        return;
      }
      const status = tradeStatus();
      if (status.limited) {
        send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: status.tradeLimitedUntil }), "application/json; charset=utf-8");
        return;
      }
      const rates = await getExchangeRates(league);
      const r = await getJewelFloor(league, mods, rates, Date.now() + 12000);
      if (r && r.limited) {
        send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8");
        return;
      }
      if (!r || !r.found) {
        send(res, 200, JSON.stringify({ found: false, depth: (r && r.depth) || 0 }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify({ found: true, ex: r.ex, depth: r.depth, thin: !!r.thin }), "application/json; charset=utf-8");
      return;
    }

    // ── Gear Upgrade Finder (PoB-driven) ──────────────────────────────────
    if (url.pathname === "/api/gear/builds") {
      send(res, 200, JSON.stringify({ dir: POB_BUILDS_DIR, builds: listPobBuilds(), headless: await pob.ready() }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/gear/import" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      let xml;
      try {
        if (input.buildFile) {
          xml = fs.readFileSync(path.join(POB_BUILDS_DIR, path.basename(String(input.buildFile))), "utf8"); // basename = traversal guard
        } else if (input.code) {
          xml = decodePobCode(input.code);
        } else if (input.xml) {
          xml = String(input.xml); // a build saved in the browser (localStorage)
        } else {
          send(res, 400, JSON.stringify({ error: "Provide a PoB code or buildFile" }), "application/json; charset=utf-8"); return;
        }
      } catch (e) { send(res, 400, JSON.stringify({ error: "Could not read/decode build: " + e.message }), "application/json; charset=utf-8"); return; }
      let parsed;
      try { parsed = parsePobBuild(xml); } catch (e) { send(res, 400, JSON.stringify({ error: "Not a Path of Building build: " + e.message }), "application/json; charset=utf-8"); return; }
      const headless = { available: await pob.ready() };
      if (headless.available) { try { headless.stats = await pob.load(xml); } catch (e) { headless.error = String(e.message); } }
      send(res, 200, JSON.stringify({ slots: parsed.slots, build: parsed.build, headless, xml }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/gear/weights" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!pob.available()) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      const slotId = String(input.slot || "");
      const slot = gearSearchSlots()[slotId];
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(slotId));
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      try {
        const w = await computeGearWeights(String(input.buildXml || ""), pobSlot, slot.baseId || slotId, String((input.current && input.current.raw) || ""));
        const query = w.weights.length ? buildWeightedGearQuery(slot, w.weights, league, input.maxPriceDiv) : null;
        send(res, 200, JSON.stringify({ available: true, slot: slotId, metric: w.metric, base: w.base, weights: w.weights, league, query }), "application/json; charset=utf-8");
      } catch (e) { send(res, 200, JSON.stringify({ available: true, error: String(e.message) }), "application/json; charset=utf-8"); }
      return;
    }

    // On-demand basic (non-weighted) shareable search — ONE anonymous Trade2 call.
    // Mins come from your CURRENT item's rolls (`mods:[{statId,min}]`) so it only
    // surfaces equal-or-better, not "has the stat at all". Match a subset (count)
    // so requiring every top stat at once doesn't return zero.
    if (url.pathname === "/api/gear/basic-link" && req.method === "POST") {
      const input = await readJson(req, 1 * 1024 * 1024);
      const slot = gearSearchSlots()[String(input.slot || "")];
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), "application/json; charset=utf-8"); return; }
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      // Gate on the top 2 stats at your current rolls ("and" — count groups 400 on PoE2 trade).
      const mods = gearStatFilters(Array.isArray(input.mods) ? input.mods : (Array.isArray(input.statIds) ? input.statIds.map((id) => ({ statId: id, min: 1 })) : []));
      const q = {
        query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: gearStatGroup(mods) },
        sort: { price: "asc" },
      };
      if (Number(input.maxPriceDiv) > 0) q.query.filters.trade_filters = { filters: { price: { option: "divine", max: Number(input.maxPriceDiv) } } };
      try {
        const { search, league: used } = await gearTradeSearch(q, league);
        const url2 = search && search.id ? "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(used) + "/" + search.id : null;
        send(res, 200, JSON.stringify({ url: url2, total: (search && search.total) || 0 }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), "application/json; charset=utf-8"); return; }
        send(res, 200, JSON.stringify({ error: String(err.message) }), "application/json; charset=utf-8");
      }
      return;
    }

    // Paste-to-score: exact build impact of specific item(s) via headless PoB. NO
    // Trade2 — you copy an item off the trade site / in-game and get the real gain.
    if (url.pathname === "/api/gear/score" && req.method === "POST") {
      const input = await readJson(req, 4 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(String(input.slot || "")));
      const currentRaw = String((input.current && input.current.raw) || "");
      try {
        await pob.load(String(input.buildXml || ""));
        const base = await pob.calc(pobSlot, "");
        const results = [];
        for (const it of (Array.isArray(input.items) ? input.items : []).slice(0, 5)) {
          const name = String(it.name || "");
          try {
            results.push({ name, stats: await pob.calc(pobSlot, String(it.raw || "")) });
          } catch (e1) {
            // No readable base in the paste → graft its mods onto the current base.
            const synth = currentRaw ? reconstructItem(currentRaw, String(it.raw || "")) : null;
            if (synth) {
              try { results.push({ name, stats: await pob.calc(pobSlot, synth), approx: true }); }
              catch (e2) { results.push({ name, error: String(e2.message) }); }
            } else { results.push({ name, error: String(e1.message) }); }
          }
        }
        send(res, 200, JSON.stringify({ available: true, base, results }), "application/json; charset=utf-8");
      } catch (e) { send(res, 200, JSON.stringify({ available: true, error: String(e.message) }), "application/json; charset=utf-8"); }
      return;
    }

    // Score ALL pinned items TOGETHER: inject them into the build and recompute once,
    // so the gain reflects compounding (the real "buy everything" number, vs the
    // approximate per-item sum the pin board shows). One item per slot — last wins.
    if (url.pathname === "/api/gear/score-combo" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      // Keep one pin per slot (highest ΔDPS), and only pins carrying item text.
      const bySlot = {};
      for (const p of (Array.isArray(input.pins) ? input.pins : [])) {
        if (!p || !p.raw || !p.pobSlot) continue;
        const cur = bySlot[p.pobSlot];
        if (!cur || (Number(p.dDPS) || 0) > (Number(cur.dDPS) || 0)) bySlot[p.pobSlot] = p;
      }
      const swaps = Object.values(bySlot).slice(0, 12);
      const dropped = (Array.isArray(input.pins) ? input.pins.length : 0) - swaps.length;
      if (!swaps.length) { send(res, 200, JSON.stringify({ available: true, error: "no scorable pins — re-pin items so they carry the item text" }), "application/json; charset=utf-8"); return; }
      try {
        const base = await pob.load(String(input.buildXml || ""));
        // Equip them all through PoB's own item parser (same path as the per-item
        // scores), so the combined gain is consistent + compounds correctly.
        const combined = await pob.calcMulti(swaps.map((p) => ({ slot: p.pobSlot, itemText: p.raw })));
        send(res, 200, JSON.stringify({
          available: true, scored: swaps.length, dropped,
          dDPS: dpsOfOut(combined) - dpsOfOut(base), dEHP: ehpOfOut(combined) - ehpOfOut(base),
          baseDps: dpsOfOut(base),
        }), "application/json; charset=utf-8");
      } catch (e) { send(res, 200, JSON.stringify({ available: true, error: String(e.message) }), "application/json; charset=utf-8"); }
      return;
    }

    // Rank by REAL DPS: fetch a batch of in-budget candidates (one stat-min search
    // + fetch), score each through headless PoB, sort by actual ΔDPS. The accurate
    // answer the heuristic weighted search can't give.
    if (url.pathname === "/api/gear/realrank" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      const slot = gearSearchSlots()[String(input.slot || "")];
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(String(input.slot || "")));
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const mods = gearStatFilters(input.mods);
      // With a POESESSID session we can sort the search by BUILD VALUE (weighted statgroup)
      // and score the genuinely-best candidates. Logged-out that sort 400s, so fall back to
      // a stat-floor + price-spread. Weights come from the client's /api/gear/weights result.
      const weights = (Array.isArray(input.weights) ? input.weights : []).filter((w) => w && /^(explicit\.stat_\d+|pseudo\.[a-z0-9_]+)$/.test(w.statId) && Number(w.weight) > 0);
      const weighted = !!POESESSID && weights.length > 0;
      const q = weighted
        ? buildWeightedGearQuery(slot, weights, league, Number(input.maxPriceDiv) || 0)
        : { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: gearStatGroup(mods) }, sort: { price: "asc" } };
      if (!weighted && Number(input.maxPriceDiv) > 0) q.query.filters.trade_filters = { filters: { price: { option: "divine", max: Number(input.maxPriceDiv) } } };
      try {
        const { search, league: usedLeague } = await gearTradeSearch(q, league);
        const all = search.result || [];
        if (!all.length) { send(res, 200, JSON.stringify({ available: true, candidates: [], total: 0 }), "application/json; charset=utf-8"); return; }
        // Score a DEEPER pool through PoB and return the real winners — don't trust the
        // trade sort (linear weighted sum) to pre-pick the best, since real DPS is
        // multiplicative. Weighted search is best-first so take the top SCORE_CAP; the
        // price fallback samples a spread. Capped at SCORE_CAP to bound fetch calls
        // (≤10 ids/call, shared-IP rate limit) and PoB time; bail to partial on a limit.
        const SCORE_CAP = 50;   // 5 fetch calls — deeper coverage of the weight-ranked tail
        const m = Math.min(all.length, SCORE_CAP);
        const pick = weighted ? all.slice(0, m) : Array.from({ length: m }, (_, i) => all[Math.floor((i * all.length) / m)]);
        const rates = await getExchangeRates(league).catch(() => ({}));
        await pob.load(String(input.buildXml || ""));
        const base = await pob.calc(pobSlot, "");
        const cands = [];
        let fetchErr = null;
        for (let i = 0; i < pick.length; i += 10) {   // Trade2 fetch caps at 10 ids/call
          let fetched;
          try { fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + pick.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(search.id)); }
          catch (e) { fetchErr = e; break; }   // rate-limit/error mid-sweep → keep what we scored
          for (const e of fetched.result || []) {
            const txt = pobItemFromTradeEntry(e);
            if (!txt) continue;
            let stats; try { stats = await pob.calc(pobSlot, txt); } catch { continue; }
            const price = listingPriceFromEntry(e, rates) || {};
            // The item's top-weighted rolled mods → lets the value-check search "items at
            // least this good on these stats" and tell you if this listing is the cheapest
            // at that power. Parse the roll from each explicit mod's description.
            const expl = (e.item && e.item.explicitMods) || [];
            const valOf = (statId) => { const md = expl.find((x) => (x && x.hash) === "stat." + statId); if (!md) return null; const n = parseFloat(String(md.description || "").replace(/[^\d.\-]+/g, " ").trim().split(" ")[0]); return Number.isFinite(n) ? n : null; };
            const linkMods = [];
            for (const w of weights) { const v = valOf(w.statId); if (v != null) linkMods.push({ statId: w.statId, min: Math.floor(v) }); if (linkMods.length >= 3) break; }
            cands.push({
              name: [(e.item && e.item.name), (e.item && e.item.typeLine)].filter(Boolean).join(" ").trim(),
              // base type + seller account → a precise "open this listing" search (PoE
              // trade has no per-item permalink, and the linked search is sorted so the
              // item can be buried; this lands right on it).
              base: (e.item && (e.item.typeLine || e.item.baseType)) || "",
              account: (e.listing && e.listing.account && e.listing.account.name) || "",
              raw: txt,                                  // PoB-ready item text → combined "score all pinned" can re-slot it
              mods: linkMods,
              stats: parseItemStats(txt, slot.baseId),   // new item's rolls, keyed like the equipped item → old-vs-new diff
              priceDiv: price.divine || 0, priceEx: price.exalted || 0,
              dDPS: dpsOfOut(stats) - dpsOfOut(base), dEHP: ehpOfOut(stats) - ehpOfOut(base),
            });
          }
        }
        if (!cands.length && fetchErr) throw fetchErr;   // total failure → outer catch (rate-limit msg etc.)
        cands.sort((a, b) => (b.dDPS - a.dDPS) || (b.dEHP - a.dEHP));
        // The build-weighted/price search this came from — opening it lands on these
        // candidates (no per-item permalink exists on PoE trade). Each row links here.
        const searchUrl = search.id ? "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(usedLeague) + "/" + search.id : "";
        send(res, 200, JSON.stringify({ available: true, weighted, searchUrl, scored: cands.length, partial: !!fetchErr, total: Number(search.total) || pick.length, baseDps: dpsOfOut(base), candidates: cands.slice(0, 10) }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8"); return; }
        const msg = String(err.message);
        // On a 400 ("Invalid query"), surface the exact query we sent — a bad stat id
        // or category is otherwise undiagnosable from the client.
        const dbg = msg.includes("HTTP 400") ? " | league=" + JSON.stringify(league) + " query=" + JSON.stringify(q) : "";
        if (dbg) console.error("[realrank] 400 from trade2; league:", league, "query:", JSON.stringify(q));
        send(res, 200, JSON.stringify({ available: true, error: msg + dbg, league, query: q }), "application/json; charset=utf-8");
      }
      return;
    }

    // Open a specific scored candidate on the trade site: one search by base type +
    // seller account (PoE trade has no per-item permalink). Returns ~that listing so the
    // user can whisper it. One search per click — user-initiated, gentle.
    if (url.pathname === "/api/gear/item-link" && req.method === "POST") {
      const input = await readJson(req, 256 * 1024);
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true }), "application/json; charset=utf-8"); return; }
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const base = String(input.base || "").trim();
      const account = String(input.account || "").trim();
      if (!base || !account) { send(res, 400, JSON.stringify({ error: "need base + account" }), "application/json; charset=utf-8"); return; }
      const q = { query: { status: { option: GEAR_TRADE_STATUS }, type: base, filters: { trade_filters: { filters: { account: { input: account } } } } }, sort: { price: "asc" } };
      try {
        const { search, league: used } = await gearTradeSearch(q, league);
        const url2 = search.id ? "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(used) + "/" + search.id : "";
        send(res, 200, JSON.stringify({ url: url2, total: search.total || 0 }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true }), "application/json; charset=utf-8"); return; }
        send(res, 200, JSON.stringify({ error: String(err.message) }), "application/json; charset=utf-8");
      }
      return;
    }

    // Value check (PoB, not stat-thresholds): is there a CHEAPER item that gives the same
    // real DPS? Search instant-buyout items of the slot priced UNDER this one (gated on its
    // top rolls so we don't score junk), cheapest first, SCORE each in PoB, and return the
    // cheapest whose ΔDPS matches. Stat-floor matching was useless (1000s of junk clear a
    // couple thresholds); only PoB tells you an item is actually as good.
    if (url.pathname === "/api/gear/value-check" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true }), "application/json; charset=utf-8"); return; }
      const slot = gearSearchSlots()[String(input.slot || "")];
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(String(input.slot || "")));
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const mods = gearStatFilters(input.mods, 2);   // gate on the item's top 2 rolls (relevance, not equivalence)
      const maxDiv = Number(input.maxPriceDiv) || 0;  // this candidate's price — look strictly cheaper
      const targetDDPS = Number(input.targetDDPS) || 0;
      if (!mods.length || maxDiv <= 0 || targetDDPS <= 0) { send(res, 400, JSON.stringify({ error: "need rolls, price and target DPS" }), "application/json; charset=utf-8"); return; }
      const q = {
        query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } }, trade_filters: { filters: { price: { option: "divine", max: maxDiv } } } }, stats: gearStatGroup(mods) },
        sort: { price: "asc" },
      };
      try {
        const { search } = await gearTradeSearch(q, league);
        const ids = (search.result || []).slice(0, 20);   // cheapest 20 under this price, 2 fetch calls
        if (!ids.length) { send(res, 200, JSON.stringify({ best: false, scanned: 0 }), "application/json; charset=utf-8"); return; }
        const rates = await getExchangeRates(league).catch(() => ({}));
        await pob.load(String(input.buildXml || ""));
        const baseDps = dpsOfOut(await pob.calc(pobSlot, ""));
        let cheaper = null, scanned = 0;
        for (let i = 0; i < ids.length && !cheaper; i += 10) {
          let fetched;
          try { fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + ids.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(search.id)); }
          catch (e) { break; }
          for (const e of fetched.result || []) {   // already price-asc → first match IS the cheapest
            const txt = pobItemFromTradeEntry(e); if (!txt) continue;
            let st; try { st = await pob.calc(pobSlot, txt); } catch { continue; }
            scanned++;
            if (dpsOfOut(st) - baseDps >= targetDDPS * 0.9) {
              const p = listingPriceFromEntry(e, rates) || {};
              cheaper = { name: [(e.item && e.item.name), (e.item && e.item.typeLine)].filter(Boolean).join(" ").trim(), priceDiv: p.divine || 0, priceEx: p.exalted || 0 };
              break;
            }
          }
        }
        send(res, 200, JSON.stringify({ best: !cheaper, cheaper, scanned }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true }), "application/json; charset=utf-8"); return; }
        send(res, 200, JSON.stringify({ error: String(err.message) }), "application/json; charset=utf-8");
      }
      return;
    }

    if (url.pathname === "/api/gear-search/analyze" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      send(res, 200, JSON.stringify(analyzeGearSearch(input.text || "")), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/gear-search/import-browser-export" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      const result = importFromBrowserExport(input.text || "");
      if (!result.itemCount) {
        send(res, 400, JSON.stringify({ error: "No item objects found. Paste copied item text, character JSON, or page HTML with embedded item data." }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify({
        source: result.source,
        itemCount: result.itemCount,
        text: result.text,
        analysis: analyzeGearSearch(result.text),
      }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/gear-search/listing-link" && req.method === "POST") {
      const input = await readJson(req);
      try {
        send(res, 200, JSON.stringify(await gearListingLink(input)), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) {
          send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
          return;
        }
        throw err;
      }
      return;
    }

    if (url.pathname === "/api/gear-search/search" && req.method === "POST") {
      const input = await readJson(req);
      try {
        send(res, 200, JSON.stringify(await searchGear(input)), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) {
          send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus(), listings: [] }), "application/json; charset=utf-8");
          return;
        }
        throw err;
      }
      return;
    }

    if (url.pathname === "/api/upgrades/profile") {
      send(res, 200, JSON.stringify(UPGRADE_GUIDE_PROFILE), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/upgrades/currency-rates") {
      const league = sanitizeLeague(url.searchParams.get("league"));
      const rates = await getExchangeRates(league);
      send(res, 200, JSON.stringify({
        league,
        divineToExalted: Number(rates.divine) || 0,
        chaosToExalted: Number(rates.chaos) || 0,
        updated: new Date().toISOString(),
      }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/upgrades/status") {
      send(res, 200, JSON.stringify({
        ...tradeStatus(),
      }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/oauth/status") {
      send(res, 200, JSON.stringify(oauthStatus()), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/oauth/start") {
      try {
        send(res, 200, JSON.stringify({ url: buildOauthStartUrl(), status: oauthStatus() }), "application/json; charset=utf-8");
      } catch (err) {
        send(res, 400, JSON.stringify({ error: err.message, status: oauthStatus() }), "application/json; charset=utf-8");
      }
      return;
    }

    if (url.pathname === "/api/oauth/callback") {
      try {
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        const error = url.searchParams.get("error") || "";
        if (error) throw new Error(error);
        if (!code || !state) throw new Error("Missing OAuth callback code/state.");
        const token = await exchangeOauthCode(code, state);
        send(res, 200, "<!doctype html><title>PoE OAuth Connected</title><body style=\"font-family:sans-serif;background:#111;color:#eee;padding:24px\"><h1>Connected</h1><p>Authenticated as " + String(token.username || "Path of Exile user") + ".</p><p>You can close this tab and return to the upgrade finder.</p></body>", "text/html; charset=utf-8");
      } catch (err) {
        send(res, 400, "<!doctype html><title>PoE OAuth Failed</title><body style=\"font-family:sans-serif;background:#111;color:#eee;padding:24px\"><h1>OAuth failed</h1><p>" + String(err.message).replace(/[<>&]/g, "") + "</p></body>", "text/html; charset=utf-8");
      }
      return;
    }

    if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
      clearOauthToken();
      send(res, 200, JSON.stringify(oauthStatus()), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/upgrades/analyze" && req.method === "POST") {
      const input = await readJson(req);
      send(res, 200, JSON.stringify(analyzeUpgradeState(input.text || "")), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/upgrades/import-browser-export" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      const result = importFromBrowserExport(input.text || "");
      if (!result.itemCount) {
        send(res, 400, JSON.stringify({ error: "No item objects found. Paste copied item text, character JSON, or page HTML with embedded item data." }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify(result), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/upgrades/search-slot" && req.method === "POST") {
      const input = await readJson(req);
      try {
        send(res, 200, JSON.stringify(await searchUpgradeSlot(input)), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) {
          send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus(), options: [] }), "application/json; charset=utf-8");
          return;
        }
        throw err;
      }
      return;
    }

    if (url.pathname === "/api/upgrades/focus-search" && req.method === "POST") {
      const input = await readJson(req);
      const league = input.league || UPGRADE_GUIDE_PROFILE.league;
      const status = tradeStatus();
      if (status.limited) {
        send(res, 200, JSON.stringify({ limited: true, tradeStatus: status }), "application/json; charset=utf-8");
        return;
      }
      const query = input.query && input.query.query ? input.query : null;
      if (!query) {
        send(res, 400, JSON.stringify({ error: "Missing focus query" }), "application/json; charset=utf-8");
        return;
      }
      try {
        const searchUrl = "https://www.pathofexile.com/api/trade2/search/poe2/" + encodeURIComponent(league);
        const search = await fetchTrade(searchUrl, { method: "POST", body: JSON.stringify(query) });
        send(res, 200, JSON.stringify({
          league,
          id: search.id,
          total: search.total || (search.result ? search.result.length : 0),
          url: "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(league) + "/" + search.id,
          tradeStatus: tradeStatus(),
        }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) {
          send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
          return;
        }
        throw err;
      }
      return;
    }

    if (url.pathname === "/api/upgrades/import-character" && req.method === "POST") {
      const input = await readJson(req);
      const character = String(input.character || "rgnageeeen").trim();
      const realm = String(input.realm || "poe2").trim();
      if (!character) {
        send(res, 400, JSON.stringify({ error: "Missing character name" }), "application/json; charset=utf-8");
        return;
      }
      try {
        send(res, 200, JSON.stringify(await importOauthCharacter(character, realm)), "application/json; charset=utf-8");
      } catch (err) {
        send(res, 400, JSON.stringify({ error: err.message, oauth: oauthStatus() }), "application/json; charset=utf-8");
      }
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
        if (process.env.OCR_DEBUG) {
          await fs.promises.copyFile(tmpIn, path.join(os.tmpdir(), "poe-ocr-debug-in." + ext)).catch(() => {});
        }
        await new Promise((resolve, reject) =>
          exec(`magick "${tmpIn}" -gravity West -chop 40%x0 "${tmpProc}"`,
            (err, _, stderr) => err ? reject(new Error(stderr || err.message)) : resolve())
        );
        if (process.env.OCR_DEBUG) {
          await fs.promises.copyFile(tmpProc, path.join(os.tmpdir(), "poe-ocr-debug-proc.png")).catch(() => {});
        }
        const text = await new Promise((resolve, reject) =>
          exec(`tesseract "${tmpProc}" "${tmpBase}" --psm 6 -c preserve_interword_spaces=1`,
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
      // Local dev tool that changes often: never let the browser serve a stale
      // page/stylesheet from cache (this is why edits looked like "nothing changed").
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(fullPath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(data);
    });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
  }
});

// Only bind the port when run directly (node server.js). When required as a
// module (tests), expose the exchange internals so the real fetchExchangeChunked
// can be exercised with a stubbed network — no port, no Trade2 calls.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const url = "http://" + HOST + ":" + PORT + "/";
    console.log("PoE Tools running at " + url);
    if (!process.env.POE2_NO_OPEN) exec('start "" "' + url + '"');
  });
  // Keep the currency-rate cache warm in the BACKGROUND so the Rune Picker, home
  // strip, and Gear Search never wait on the throttled Trade2 queue. Warm once on
  // boot, then check every 2 min (the warmer only actually refreshes when the
  // cache is near expiry, and it's single-flight + rate-limit aware).
  warmExchange().catch(() => {});
  const warmTimer = setInterval(() => { warmExchange().catch(() => {}); }, 2 * 60 * 1000);
  if (warmTimer.unref) warmTimer.unref();
  // Economy history for the home dashboard: sample on boot if a twice-a-day point
  // is due, then check every 30 min (the sampler only actually fetches when due +
  // unthrottled, so this is cheap).
  maybeSampleEconomy();
  const econTimer = setInterval(() => { maybeSampleEconomy(); }, 30 * 60 * 1000);
  if (econTimer.unref) econTimer.unref();
}

module.exports = {
  fetchExchangeChunked,
  collectExchangeOffers,
  bestExchangeOffer,
  divineMarketPrice,
  sanitizeLeague,
  buildExchangeCatalog,
  analyzeGearSearch,
  buildGearSearchQuery,
  gearSearchSlots,
  decodePobCode,
  parsePobBuild,
  listPobBuilds,
  computeGearWeights,
  buildWeightedGearQuery,
  __setExchangeRawImpl(fn) { exchangeRawImpl = fn; },
};

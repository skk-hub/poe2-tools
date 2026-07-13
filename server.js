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
// Craftable mod pool (bases/mods/essences) from PoB's game data (gen-craft-data.lua).
// Powers the Crafter tool. Absent → the /api/craft/* endpoints return a "not generated"
// error; the rest of the app is unaffected.
let CRAFT_DATA = null;
try { CRAFT_DATA = require("./craft-data.js"); } catch { /* run gen-craft-data.lua to create */ }
const craftEngine = require("./craft-engine.js");   // crafting primitives + the mod pool builder
const craftPlan = require("./craft-plan.js");       // route planner: composes routes from the move catalog
const { archetypeKey } = require("./craft-archetype.js");   // base → Craft-of-Exile weight archetype
// Desecrated modifier REFERENCE (Abyssal Bones + Well of Souls) scraped from poe2db —
// PoB lacks this data. Browsable list only; not simulated (reveal 3, pick 1; no odds data).
let DESECRATED = null;
try { DESECRATED = require("./desecrated-data.js"); } catch { /* run gen-desecrated (browser) to create */ }

// Load a local .env (KEY=VALUE per line) into process.env — the documented home for
// POESESSID / EE2_PROXY_BASE / etc. Without this, a local `node server.js` never read
// it (only Docker passes env via compose), so a POESESSID set in .env was silently
// ignored → realrank fell back to the price-spread instead of the build-value sort.
// Zero-dep; does NOT override vars already set in the real environment (Docker wins).
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = v;
  }
} catch { /* no .env → rely on the real environment */ }

const HOST = process.env.HOST || "127.0.0.1";
const PORT = 17777;
const ROOT = __dirname;
// Runtime state (caches, economy history, rate-limit safety, oauth) lives here.
// Defaults to ROOT for local dev; in Docker set DATA_DIR to a mounted volume so a
// `--build` redeploy doesn't wipe the container's writable layer (e.g. the rolling
// economy-history graph). ponytail: one dir, no per-file mounts.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const TRADE_MIN_GAP_MS = 3000;
// POESESSID (a logged-in pathofexile.com session cookie, set in .env — NEVER committed)
// unlocks the build-weighted `statgroup` sort that 400s anonymously, so realrank can
// fetch the BEST candidates for the build instead of a price spread. Use a throwaway
// account: this cookie = full account access.
// Set at boot from env/.env AND swappable at runtime via POST /api/session (persisted to
// DATA_DIR so it survives restarts/redeploys). The cookie dies every few weeks; editing
// .env on two boxes + rebuilding the container was the cumbersome part — now it's a paste.
// Runtime-set (file) wins over env: it's the fresher one you just pasted.
const SESSION_FILE = path.join(DATA_DIR, ".poesessid.json");
let sessionId = (process.env.POESESSID || "").trim();
let sessionExpiredFlag = false;   // flipped true when a weighted query 400s (GGG logged us out); surfaced in the UI
let sessionVerifiedFlag = false;  // flipped true when a weighted query SUCCEEDS — green only ever means "confirmed working", never just "set"
let gearDefenceSortOk = true;     // trade2 defence sort (ev/ar/es) is undocumented; flipped false on the first 400 so a wrong key wastes at most ONE call, then we revert to the weighted/price sort
// "Gain Deflection Rating equal to #% of Evasion Rating" — a big EHP layer PoB models (CalcDefence
// EvasionGainAsDeflection → DeflectChance → damage-taken mult) but the raw-evasion sort can't see, so
// a mid-evasion / high-deflection chest gets buried. We pull a dedicated pool of items WITH this mod
// into defensive-slot searches so they get fetched + PoB-scored. The mod shares stat number
// 3033371881 across explicit/fractured/desecrated (meta is desecrated), so a `type:count` group ORs
// them — a chest with an explicit/fractured deflection mod was previously missed (desecrated-only).
// rune excluded: rune deflection is normalized out by the scorer, so surfacing it is pointless.
const DEFLECT_CONV_NUM = "3033371881";
const deflectConvGroup = () => ({ type: "count", value: { min: 1 }, filters: ["explicit", "fractured", "desecrated"].map((s) => ({ id: s + ".stat_" + DEFLECT_CONV_NUM })) });
try { const s = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); if (s && s.poesessid) sessionId = String(s.poesessid).trim(); } catch {}
const TRADE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "poe-tools-local/0.1 (contact: " + (process.env.POE_CONTACT || "unset") + ")",
  ...(sessionId ? { "Cookie": "POESESSID=" + sessionId } : {}),
};
// Mutate TRADE_HEADERS in place — the trade queue spreads it per-request, so the new
// cookie takes effect immediately with no restart.
function setSessionId(val) {
  sessionId = String(val || "").trim();
  if (sessionId) { TRADE_HEADERS.Cookie = "POESESSID=" + sessionId; sessionExpiredFlag = false; }
  else { delete TRADE_HEADERS.Cookie; }
  sessionVerifiedFlag = false;   // a freshly-pasted cookie is unverified until a search proves it (amber, not green)
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ poesessid: sessionId })); } catch {}
}
const TRADE_TIMEOUT_MS = 3500;
// Record/replay Trade2 traffic so the tool develops + tests with zero live GGG
// calls (the legit alternative to IP-rotation evasion). POE_RECORD=1 captures real
// responses to trade-fixtures.json; POE_OFFLINE=1 serves them back, never hitting
// the network or the shared rate-limit budget. Both off = normal live behaviour.
const TRADE_RECORD = process.env.POE_RECORD === "1";
const TRADE_OFFLINE = process.env.POE_OFFLINE === "1";
const TRADE_FIXTURE_FILE = path.join(__dirname, "trade-fixtures.json");
const MAX_RUNE_LINES = 30;
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
const EXALTED_ID = "exalted";
// Listing status for the EE2-faithful exchange read. EE2's default is "online";
// override to "any" via env if online reads too thin on the shared/VPN IP.
const EE2_EXCHANGE_STATUS = process.env.EE2_STATUS || "online";
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

// Parse Tesseract TSV (word-level, level 5) into per-line boxes for /api/ocr?boxes=1.
// Groups words by block|par|line, unions their bboxes, joins the text. Coords are in
// the (cropped-from-origin) image's pixel space. Exported for ocr-boxes-test.js.
// Columns: level page block par line word left top width height conf text
function parseOcrTsvLines(tsv) {
  const groups = new Map();
  for (const row of String(tsv).split(/\r?\n/).slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;      // words only
    const text = c[11];
    if (!text || !text.trim()) continue;
    const key = c[2] + "|" + c[3] + "|" + c[4];
    const x = +c[6], y = +c[7], w = +c[8], h = +c[9];
    let g = groups.get(key);
    if (!g) { g = { x, y, x2: x + w, y2: y + h, words: [] }; groups.set(key, g); }
    g.x = Math.min(g.x, x); g.y = Math.min(g.y, y);
    g.x2 = Math.max(g.x2, x + w); g.y2 = Math.max(g.y2, y + h);
    g.words.push(text);
  }
  return [...groups.values()].map((g) => ({
    text: g.words.join(" "), x: g.x, y: g.y, w: g.x2 - g.x, h: g.y2 - g.y,
  }));
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
  let fetched = false;
  try {
    const endpoint = "https://www.pathofexile.com/api/trade2/data/static";
    const data = await tradeQueue.request(endpoint, { method: "GET" });
    for (const entry of collectStaticEntries(data)) {
      byName.set(normalizeNameKey(entry.name), entry.id);
      if (entry.image) iconsById[String(entry.id)] = entry.image;
    }
    catalog = buildExchangeCatalog(data);
    fetched = true;
  } catch {
    // Static-data lookup is a convenience. Hardcoded fallbacks keep the scanner usable.
  }
  const items = ARBITRAGE_ITEMS.map((item) => {
    const names = [item.name, ...(item.aliases || [])];
    const resolved = names.map((name) => byName.get(normalizeNameKey(name))).find(Boolean);
    return { ...item, id: resolved || item.id, fallbackId: item.id };
  });
  // A FAILED fetch must not squat the 60-min TTL with an empty catalog: backdate it
  // so the next call ~5 min later retries, while the fallback items still serve now.
  arbitrageStaticCache = { loadedAt: fetched ? Date.now() : Date.now() - 55 * 60 * 1000, items, iconsById, catalog };
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
async function fetchExchangeRaw(league, haveIds, wantIds, status = "online", minimum = 0) {
  const endpoint = "https://www.pathofexile.com/api/trade2/exchange/poe2/" + encodeURIComponent(league);
  const exchange = {
    status: { option: status },
    have: Array.isArray(haveIds) ? haveIds : [haveIds],
    want: Array.isArray(wantIds) ? wantIds : [wantIds],
  };
  // EE2's stack-size filter: only offers with stock ≥ minimum, so a single-item
  // "1 ex : 1 rune" par-spam listing is excluded and bulk sellers surface. EE2 keys
  // this off the pasted stack count; we pass the reward quantity.
  if (Number(minimum) > 1) exchange.minimum = Math.floor(Number(minimum));
  return tradeQueue.request(endpoint, { method: "POST", body: JSON.stringify({ exchange, engine: "new" }) });
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

async function fetchTrade(url, options = {}) {
  return tradeQueue.request(url, options);
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

// Exiled-Exchange-2's EXACT bulk method (renderer/src/web/price-check/trade/
// pathofexile-bulk.ts + bulk-api.ts), ported verbatim. From ONE exchange response
// (have=[divine,exalted,chaos], want=[one id]):
//   1. keep ONLY single-offer listings (`offers.length === 1`) — drops the bulk
//      par/spam bundles that flood the cheap floor (the "1 ex for most stuff" bug);
//   2. group those listings by the have-currency they offer (exalted/divine/chaos);
//   3. per side the price = cheapest ratio `exchange.amount / item.amount`.
// EE2 has NO bid side, NO par/bait/cluster filter, NO min-stock, NO outlier drop —
// the cheapest single-offer ask IS the price. We must match it exactly. Returns the
// sorted asks per currency tag.
function ee2SidePrices(data) {
  const listings = data && data.result
    ? (Array.isArray(data.result) ? data.result : Object.values(data.result))
    : [];
  const tagOf = (cur) => (cur && typeof cur === "object" ? String(cur.id || cur.currency || cur.text || "") : String(cur || "")).toLowerCase();
  const sides = {};   // currency tag -> [{px, stock}] sorted asc by px
  for (const entry of listings) {
    const offers = entry && entry.listing && entry.listing.offers;
    if (!Array.isArray(offers) || offers.length !== 1) continue;   // EE2: single-offer listings only
    const o = offers[0];
    if (!o || !o.exchange || !o.item) continue;
    const have = tagOf(o.exchange.currency);
    const exAmt = Number(o.exchange.amount), itAmt = Number(o.item.amount);
    if (!have || !(exAmt > 0) || !(itAmt > 0)) continue;
    (sides[have] || (sides[have] = [])).push({ px: exAmt / itAmt, stock: Number(o.item.stock) || 0 });
  }
  // Drop a lone troll bait per side: a single cheapest offer far under the real cluster
  // (e.g. a "1 exalted : 1 divine" listing beneath a ~359 wall) would otherwise BE the
  // price and wreck the derived rate. EE2 shows the raw list and a human skips it; our
  // programmatic cheapest can't, so we de-bait — drop an offer < HALF the next (a >2x gap
  // is not a real price; chained baits drop one at a time). A genuine deep floor (many
  // offers at the same px, e.g. Masterwork Rune's 91× at 1 div) is untouched.
  for (const k of Object.keys(sides)) {
    const a = sides[k].sort((x, y) => x.px - y.px);
    let i = 0;
    while (i < a.length - 1 && a[i].px < a[i + 1].px * 0.5) i++;
    sides[k] = a.slice(i);
  }
  return sides;
}
// EE2's currency price + auto-side-select (bulk-api.ts, useExalts=true). ONE
// exchange call, then EE2's rule: show exalted unless the divine side has MORE
// listings (that's where the liquidity/denomination really is — picks divine for
// chase items, exalted for cheap ones, automatically). Returns ex-per-item.
async function exchangePriceEx(league, wantId, divineEx = 0, chaosEx = 0, minimum = 0) {
  if (String(wantId).toLowerCase() === EXALTED_ID) return { ex: 1, side: "exalted", depth: 99, sides: [{ tag: "exalted", px: 1, ex: 1, depth: 99 }] };
  // EXCLUDE the want currency's own side, exactly like EE2 (Divine→have:[exalted,chaos],
  // Chaos→[divine,exalted]) — otherwise the 1:1 self-par spam (e.g. divine:divine) is the
  // cheapest "ask" and the orb mis-prices to ~1, breaking every divine-side conversion.
  const have = ["divine", "exalted", "chaos"].filter((t) => t !== String(wantId).toLowerCase());
  let data;
  try { data = await exchangeRawImpl(league, have, wantId, EE2_EXCHANGE_STATUS, minimum); }
  catch { return null; }
  if (!data || data.limited) return null;
  const raw = ee2SidePrices(data);
  const toEx = (tag, px) => tag === "divine" ? px * (divineEx > 0 ? divineEx : 1) : tag === "chaos" ? px * (chaosEx > 0 ? chaosEx : 1) : px;
  // EE2 shows all three sides (cheapest single-offer ask each) as a list — keep them so
  // the user reads the right denomination, exactly like EE2.
  const sides = ["exalted", "divine", "chaos"]
    .filter((t) => raw[t] && raw[t].length)
    .map((t) => ({ tag: t, px: round4(raw[t][0].px), ex: round4(toEx(t, raw[t][0].px)), depth: raw[t].length }));
  if (!sides.length) return null;
  const exa = raw[EXALTED_ID], div = raw["divine"];
  // EE2 side auto-select (useExalts): divine only when it out-lists exalted; ties → exalted.
  let side;
  if (exa && exa.length && (!div || !div.length || exa.length >= div.length)) side = "exalted";
  else if (div && div.length) side = "divine";
  else side = sides[0].tag;
  const primary = sides.find((s) => s.tag === side) || sides[0];
  return { ex: primary.ex, side: primary.tag, depth: primary.depth, stock: (raw[primary.tag][0].stock) || 0, sides };
}

// Per-item EE2 price cache (separate from the bid-priced rune book Tab Tracker uses,
// so the Rune Picker can be pure-EE2 without disturbing it). SWR: a fresh entry serves
// instantly (no call); stale/missing → a live call within the per-check budget, the
// rest background-filled. An ex:0 entry records "no exchange offers" (also cached).
const EE2_PRICES_FILE = path.join(DATA_DIR, ".ee2-prices.json");
const EE2_PRICE_TTL_MS = 15 * 60 * 1000;
let ee2Mem = null;
function readEe2All() {
  if (ee2Mem) return ee2Mem;
  try { ee2Mem = JSON.parse(fs.readFileSync(EE2_PRICES_FILE, "utf8")) || {}; } catch { ee2Mem = {}; }
  return ee2Mem;
}
function ee2Cached(league, key) {
  const e = (readEe2All()[league] || {})[key];
  if (!e || !e.updated || Date.now() - new Date(e.updated).getTime() > EE2_PRICE_TTL_MS) return null;
  return { ...e, cached: true };
}
function writeEe2Cache(league, key, p) {
  const all = readEe2All();
  (all[league] || (all[league] = {}))[key] = { ex: (p && p.ex) || 0, side: (p && p.side) || "", depth: (p && p.depth) || 0, stock: (p && p.stock) || 0, sides: (p && p.sides) || [], updated: new Date().toISOString() };
  // Prune expired entries on write so the file (keys are catId|qty) can't grow unbounded.
  for (const lg of Object.keys(all)) {
    for (const [k, e] of Object.entries(all[lg] || {})) {
      if (!e || !e.updated || Date.now() - new Date(e.updated).getTime() > EE2_PRICE_TTL_MS) delete all[lg][k];
    }
  }
  try { fs.writeFileSync(EE2_PRICES_FILE, JSON.stringify(all)); } catch {}
}
// Background-fill EE2 prices for items shown as "pricing…" this check (over the live
// budget). Bounded + stop-on-limited so a big paste can't burst the shared IP. Each
// entry is {id, min, key} — min is the pasted qty (EE2 stack filter), key caches per qty.
async function refreshEe2Prices(league, pending, rates, budget = 12) {
  if (tradeStatus().limited) return;
  for (const it of pending) {
    if (budget-- <= 0 || tradeStatus().limited) break;
    if (!it || !it.id || String(it.id).toLowerCase() === EXALTED_ID) continue;
    const live = await exchangePriceEx(league, it.id, (rates && rates.divine) || 0, (rates && rates.chaos) || 0, it.min || 0);
    writeEe2Cache(league, it.key, live || { ex: 0 });
  }
}
// A side's cheapest ask in its OWN currency (EE2's list shows native units, not ex).
function fmtSidePx(px, tag) {
  const ab = tag === "divine" ? "div" : tag === "chaos" ? "c" : "ex";
  const n = px >= 10 ? Math.round(px) : px >= 1 ? Math.round(px * 100) / 100 : Math.round(px * 10000) / 10000;
  return n + " " + ab;
}

// ── EE2 economy data (poe.ninja, via Exiled-Exchange-2's proxy) ──────────────
// EE2's reliable per-item VALUE comes from poe.ninja, which it serves through its
// own proxy (poe.ninja blocks our server directly — Cloudflare 404). One cached
// fetch of overviewData.json gives EVERY item's divine value + 30d volume, with NO
// GGG rate-limit exposure. The user lifted the poe.ninja ban (2026-06-27) because
// EE2's volume-weighted value is more accurate than our Trade2-bulk reads (e.g.
// Masterwork Rune: bulk floor 1 div vs real 0.25 div). This is the PRIMARY price
// source now; the Trade2 bulk exchange (exchangePriceEx) stays for live offers +
// as a fallback when the proxy is unreachable.
// ── VPN country switch (gluetun control server) ──────────────────────────────
// poe-tools shares the gluetun container's network namespace (compose:
// network_mode "service:vpn"), so its control server is on localhost:8000.
// PUT /v1/vpn/settings auto-reconnects to the new country (gluetun's SetSettings
// does Stopped→Running on change) — no manual status cycle needed.
// ponytail: in-container control API is the only runtime switch — server.js
// can't recreate the container to change SERVER_COUNTRIES.
const GLUETUN_URL = process.env.GLUETUN_URL || "http://127.0.0.1:8000";
// EU realm: keep the exit in/near EU. NordVPN/gluetun country names (full names).
const VPN_COUNTRIES = ["Netherlands", "Germany", "France", "United Kingdom", "Sweden", "Poland", "Spain", "Italy", "Switzerland", "Finland", "Norway", "Denmark", "Ireland", "Czech Republic", "Austria", "Belgium"];
async function gluetun(p, method = "GET", body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(GLUETUN_URL + p, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}

const EE2_PROXY_BASE = process.env.EE2_PROXY_BASE || "https://api.exiledexchange2.dev/proxy";
const EE2_PROXY_FILE = path.join(DATA_DIR, ".ee2-proxy.json");
const EE2_PROXY_TTL_MS = 25 * 60 * 1000;   // EE2 itself refreshes ~31 min; we cache 25
function proxyLeagueSlug(league) {
  const l = String(league || "").toLowerCase();
  if (l.includes("standard")) return l.includes("hardcore") || /\bhc\b/.test(l) ? "standardhc" : "standard";
  if (l.includes("hardcore") || /\bhc\b/.test(l)) return "leaguehc";
  return "league";   // EE2's proxy maps "league" to the current challenge league (Runes of Aldur)
}
// Parse overviewData.json → { divineEx, chaosEx, items: { normName: {ex,div,volume,type} } }.
// rates are relative to divine (primary): rates.exalted = exalted-per-divine = divine's
// ex value; rates.chaos = chaos-per-divine, so chaosEx = divineEx / rates.chaos.
function parseProxyOverview(j) {
  const rates = (j && j.core && j.core.rates) || {};
  const divineEx = Number(rates.exalted) || 0;
  const chaosEx = divineEx > 0 && Number(rates.chaos) > 0 ? round4(divineEx / Number(rates.chaos)) : 0;
  const items = {};
  for (const ov of (j && j.itemOverviews) || []) {
    for (const ln of (ov && ov.lines) || []) {
      const div = Number(ln && ln.primaryValue) || 0;
      if (!ln || !ln.name || !(div > 0)) continue;
      const key = normalizeName(ln.name);
      if (!items[key]) items[key] = { ex: round4(div * divineEx), div: round4(div), volume: Math.round(Number(ln.volumePrimaryValue) || 0), type: ov.type, name: ln.name };
    }
  }
  // Exalted is the base unit (1 ex by definition); divine/chaos from the rate table.
  items[normalizeName("Exalted Orb")] = { ex: 1, div: divineEx > 0 ? round4(1 / divineEx) : 0, volume: 0, type: "Currency", name: "Exalted Orb", base: true };
  if (divineEx > 0) items[normalizeName("Divine Orb")] = { ex: divineEx, div: 1, volume: 0, type: "Currency", name: "Divine Orb" };
  return { divineEx, chaosEx, items, updated: new Date().toISOString() };
}
let proxyMem = null, proxyInFlight = null;
// Indirection so tests can stub the network (mirrors __setExchangeRawImpl).
let proxyFetchImpl = async (league) => {
  const url = EE2_PROXY_BASE + "/" + proxyLeagueSlug(league) + "/overviewData.json";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);   // a slow/hung proxy must not block requests
  try {
    const r = await fetch(url, { headers: { "User-Agent": "poe-tools-local/0.1 (Exiled-Exchange-2 proxy)" }, signal: ctrl.signal });
    if (!r.ok) throw new Error("ee2 proxy HTTP " + r.status);
    return parseProxyOverview(JSON.parse(await r.text()));
  } finally { clearTimeout(t); }
};
function readProxyCache() {
  if (proxyMem) return proxyMem;
  try { proxyMem = JSON.parse(fs.readFileSync(EE2_PROXY_FILE, "utf8")); } catch { proxyMem = null; }
  return proxyMem;
}
function refreshProxy(league) {
  if (proxyInFlight) return proxyInFlight;
  proxyInFlight = (async () => {
    try {
      const d = await proxyFetchImpl(league);
      if (d && d.divineEx > 0) { d.league = league; proxyMem = d; try { fs.writeFileSync(EE2_PROXY_FILE, JSON.stringify(d)); } catch {} }
      return proxyMem;
    } finally { proxyInFlight = null; }
  })();
  return proxyInFlight;
}
// SWR: serve cache instantly + refresh in the background; cold/forced waits once.
// Returns null if the proxy is unreachable AND nothing is cached (callers fall back
// to the Trade2 bulk method).
async function getProxyData(league, force) {
  league = sanitizeLeague(league);
  const cached = readProxyCache();
  const haveCacheForLeague = cached && cached.league === league;
  const fresh = haveCacheForLeague && cached.updated && Date.now() - new Date(cached.updated).getTime() < EE2_PROXY_TTL_MS;
  if (fresh && !force) return cached;
  // Only stale-serve a cache for the SAME league (mirrors getExchangeData) — a
  // wrong-league cache would silently price everything off another economy.
  if (haveCacheForLeague && !force) { refreshProxy(league).catch(() => {}); return cached; }
  try { return await refreshProxy(league); } catch { return haveCacheForLeague ? cached : null; }
}
function proxyPrice(proxy, name) {
  return proxy && proxy.items ? proxy.items[normalizeName(name)] || null : null;
}

async function fetchExchangeData(league) {
  const resolved = await resolveArbitrageItems(league);
  const icons = (arbitrageStaticCache && arbitrageStaticCache.iconsById) || {};
  const currencies = resolved.filter((it) => it.category === "currency" && it.id !== EXALTED_ID);
  const rates = { exalted: 1 };
  const items = [{ id: "exalted", name: "Exalted Orb", ex: 1, stock: 0, icon: normalizeIconUrl(icons.exalted), base: true }];
  // PRIMARY: poe.ninja values via EE2's proxy (one cheap cached fetch, no GGG limit,
  // volume-weighted = accurate). FALLBACK: the Trade2 bulk method (exchangePriceEx)
  // per currency, used only if the proxy is unreachable.
  const proxy = await getProxyData(league).catch(() => null);
  let divineEx = (proxy && proxy.divineEx) || 0, chaosEx = (proxy && proxy.chaosEx) || 0;
  let divAnchor = null, chAnchor = null;   // reused in the loop so divine/chaos aren't fetched twice
  if (!divineEx) {
    divAnchor = await exchangePriceEx(league, "divine");
    divineEx = divAnchor && divAnchor.ex > 0 ? divAnchor.ex : 0;
    chAnchor = await exchangePriceEx(league, "chaos", divineEx, 0);
    chaosEx = chAnchor && chAnchor.ex > 0 ? chAnchor.ex : 0;
  }
  for (const c of currencies) {
    let ex = 0, vol = 0, src = "ee2 (poe.ninja)";
    const pv = proxyPrice(proxy, c.name);
    if (pv && pv.ex > 0) { ex = round4(pv.ex); vol = pv.volume || 0; }
    else {
      const p = c.id === "divine" && divAnchor ? divAnchor
        : c.id === "chaos" && chAnchor ? chAnchor
        : await exchangePriceEx(league, c.id, divineEx, chaosEx);   // proxy miss → Trade2 bulk
      if (!p || !(p.ex > 0)) continue;
      ex = round4(p.ex); vol = p.depth || 0; src = "trade2 exchange";
    }
    rates[c.id] = ex;
    rates[normalizeName(c.name)] = ex;
    items.push({ id: c.id, name: c.name, ex, stock: vol, source: src, icon: normalizeIconUrl(icons[c.id]) });
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
  // Warm the league the user is actually working in (the one in the single cache
  // file) — always warming DEFAULT_LEAGUE clobbered a non-default league's cache.
  if (cached && cached.league) league = cached.league;
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

// Robust ITEM-SEARCH sale price (the recipe/advisor resale read) — the price a finished
// craft would actually MOVE at, from fetched Trade2 listings. One absurd listing must not
// make a bad craft look profitable, so (in order):
//   - stale listings (indexed > maxAgeDays) are dropped — they're aspirational/AFK prices
//     that haven't sold, not the market;
//   - the sale anchor is the cheapest CLUSTERED offer (≥3 within ±15%, incl. itself —
//     divineMarketPrice's pattern); no cluster → cheapest after the lowball-bait walk
//     (drop offers <50% of the next, the old resale rule);
//   - fewer than minSample fresh offers → thin:true (numbers returned, trust is the
//     caller's call);
//   - liquidationDiv = anchor × LIQUIDATION_DISCOUNT — to sell fast you undercut the
//     board; EV math should use THIS, not the ask.
// listings: [{div, indexedAt}] from the fetch; now = Date.now() (injectable for tests).
// ponytail: flat 7d/5-sample/0.9 knobs; tune when real resale data shows they're off.
const LIQUIDATION_DISCOUNT = 0.9;
function robustResalePrice(listings, opts) {
  opts = opts || {};
  const maxAgeMs = (opts.maxAgeDays || 7) * 86400000;
  const minSample = opts.minSample || 5;
  const now = opts.now || Date.now();
  const all = (listings || []).filter((l) => l && l.div > 0);
  const fresh = all.filter((l) => !l.indexedAt || now - new Date(l.indexedAt).getTime() <= maxAgeMs);
  const r = fresh.map((l) => l.div).sort((a, b) => a - b);
  if (!r.length) return { saleDiv: null, liquidationDiv: null, sample: all.length, freshSample: 0, thin: true };
  const clustered = r.filter((x) => r.reduce((n, y) => n + (y >= x * 0.85 && y <= x * 1.15 ? 1 : 0), 0) >= 3);
  let anchor;
  if (clustered.length) anchor = clustered[0];
  else { let i = 0; while (i < r.length - 1 && r[i] < r[i + 1] * 0.5) i++; anchor = r[i]; }
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    saleDiv: round(anchor),
    liquidationDiv: round(anchor * LIQUIDATION_DISCOUNT),
    sample: all.length, freshSample: r.length,
    thin: r.length < minSample,
  };
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
  // Price every economy item off the SAME poe.ninja proxy the strip uses (reliable,
  // volume-weighted — the right value for illiquid omens too, e.g. Whittling 6.96 div).
  // Exalt-side items also live in the strip rates; div-side items (omens, Hinekora's)
  // fall back to the cluster method (economyDivSide) only if the proxy lacks them.
  const proxy = await getProxyData(league).catch(() => null);
  const ex = {};
  const divMissing = [];
  for (const it of ECONOMY_ITEMS) {
    const pv = proxyPrice(proxy, it.name);
    if (pv && pv.ex > 0) { ex[it.id] = Math.round(pv.ex * 100) / 100; continue; }
    if (!it.div) { const v = exData.rates[it.id]; if (v > 0) ex[it.id] = Math.round(v * 100) / 100; }
    else divMissing.push(it.id);
  }
  if (divMissing.length) {
    const dz = await economyDivSide(league);
    if (dz && dz.perDiv) for (const [id, perDiv] of Object.entries(dz.perDiv)) {
      if (perDiv > 0 && divMissing.includes(id)) ex[id] = Math.round(perDiv * exPerDiv * 100) / 100;
    }
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
    // Rarity thresholds bracket the KNEE — the value explodes somewhere 50→70 (a
    // single low/high pair can't tell you where), so probe 50/60/65/70.
    { key: "itemRarity", label: "Item Rarity", filter: "map_iir", prop: "Item Rarity", thresholds: [50, 60, 65, 70], tip: "The top chase by far — floor explodes past ~65%." },
    { key: "packSize", label: "Pack Size", filter: "map_packsize", prop: "Pack Size", thresholds: [30, 40], tip: "Mild — cooled to ~25ex even near cap ~50%." },
    { key: "monsterEffectiveness", label: "Monster Effectiveness", filter: "map_magic_monsters", prop: "Monster Effectiveness", thresholds: [40], tip: "Marginal ~10ex @40%." },
    { key: "monsterRarity", label: "Monster Rarity", filter: "map_rare_monsters", prop: "Monster Rarity", thresholds: [40], tip: "Worthless even at high rolls; real cap ~55%." },
  ],
  // COMBO probes — the same gated buyable class, but requiring TWO good stats at
  // once. Answers "are combos a sellable market, or only worth running yourself?"
  // (buildDump can't AND two keeps, so this tells us whether that even matters.)
  combos: [
    { key: "rarityPack", label: "Rarity ≥55 + Pack ≥30", filters: { map_iir: { min: 55 }, map_packsize: { min: 30 } } },
    { key: "rarityEff", label: "Rarity ≥55 + Effectiveness ≥40", filters: { map_iir: { min: 55 }, map_magic_monsters: { min: 40 } } },
  ],
};

function readWaystoneWeights() {
  try { return JSON.parse(fs.readFileSync(WAYSTONE_WEIGHTS_FILE, "utf8")); }
  catch { return null; }
}

// Robust floor: dodge an obvious AFK/troll listing far below the rest. Use a TIGHT
// gap (cheapest < 20% of the 2nd) — the old <50% threshold discarded GENUINE cheap
// floors on naturally wide spreads (e.g. a pure-Pack-40 map at 30ex sitting under a
// Pack-47 at 150ex → 30 was wrongly dropped, overstating the floor as 150).
function robustWaystoneFloor(prices) {
  const sorted = prices.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length >= 2 && sorted[0] < sorted[1] * 0.2) return sorted[1];
  return sorted[0];
}

function waystonePropVal(item, key) {
  const p = (item.properties || []).find((pr) => String(pr.name || "").includes(key));
  if (!p) return 0;
  return Number(String(((p.values || [])[0] || [])[0] || "").replace(/[+%]/g, "")) || 0;
}

async function waystoneFloor(league, mapFilters, prop, rates) {
  const body = JSON.stringify({
    query: {
      // "securable" = the real async-buyable Merchant-Tab pool (whisper-free, seller can
      // be offline). "any" included STALE offline whisper listings — dead 1-ex bait that
      // never sells was undercutting the floor, so it read ~1ex while stones actually
      // move for ~2 chaos. See memory poe2-instant-buyout-securable.
      status: { option: "securable" },
      filters: {
        type_filters: { filters: { category: { option: "map.waystone" } } },
        // Gate to the REAL buyable class (corrupted + 0 revives = fully juiced), the same gate
        // the dump filter trusts. Ungated, a single-stat floor is contaminated: a "pack ≥40"
        // map that's ALSO rarity-juiced blames its whole combo price on pack (the 150ex pack
        // artifact). Gating isolates the class the user actually farms → trustworthy floors.
        map_filters: { filters: Object.assign({ map_tier: { min: WAYSTONE_SWEEP.tier, max: WAYSTONE_SWEEP.tier }, map_revives: { max: 0 } }, mapFilters) },
        misc_filters: { filters: { corrupted: { option: "true" } } },
        // NO price-currency gate: waystones trade mostly in CHAOS (1c ≈ 94ex in 0.5.4),
        // so the old exalted-only filter saw a thin ~1ex bulk-dump floor and missed the
        // real chaos market — pricing a 2-chaos (~188ex) stone as junk. Sort price asc
        // returns the genuinely cheapest across currencies; we normalize each to ex.
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
  const divineEx = (rates && rates.divineEx) || 0, chaosEx = (rates && rates.chaosEx) || 0;
  const toEx = (cur, amt) => cur === "exalted" ? amt : cur === "divine" ? amt * divineEx : cur === "chaos" ? amt * chaosEx : 0;
  const rows = (fetched.result || [])
    .filter((e) => e && e.item && e.listing && e.listing.price && e.listing.price.amount > 0)
    .map((e) => ({ ex: toEx(String(e.listing.price.currency || "").toLowerCase(), Number(e.listing.price.amount)), cur: e.listing.price.currency, amt: Number(e.listing.price.amount), roll: prop ? waystonePropVal(e.item, prop) : 0 }))
    .filter((r) => r.ex > 0);   // drops unknown currencies (e.g. alch) we can't convert
  const floor = robustWaystoneFloor(rows.map((r) => r.ex));
  const cheapest = rows.slice().sort((a, b) => a.ex - b.ex)[0] || null;
  return { total, floor, maxRoll: Math.max(0, ...rows.map((r) => r.roll)), floorCur: cheapest && cheapest.cur, floorAmt: cheapest && cheapest.amt };
}

// One sweep is ~30 Trade2 calls; a single slow request used to abort (timeout) and
// throw, nuking the whole refresh with "This operation was aborted". Make each point
// best-effort: a transient failure (abort/timeout/network) just skips that point, the
// curve fills from the rest. Only a real rate-limit propagates (so the UI can show
// the cooldown); a sweep that collected NOTHING throws so the cache is kept.
async function waystoneFloorSafe(league, mapFilters, prop, rates) {
  try {
    return await waystoneFloor(league, mapFilters, prop, rates);
  } catch (err) {
    if (/rate limited/i.test(String(err && err.message))) throw err;
    return { total: 0, floor: null, maxRoll: 0, skipped: true };
  }
}

async function runWaystoneSweep(league) {
  // Rate table to normalize chaos/divine listings to exalted (waystones trade in chaos).
  const eco = await economyCurrent(league).catch(() => null);
  const rates = { divineEx: (eco && eco.exPerDiv) || 0, chaosEx: (eco && eco.chaosEx) || 0 };
  const baseline = await waystoneFloorSafe(league, {}, null, rates);
  const base = baseline.floor || 1;
  const diag = [{ label: "baseline (any corrupted 0-revive)", floorEx: baseline.floor != null ? Math.round(baseline.floor) : null, cur: baseline.floorCur, amt: baseline.floorAmt }];
  const stats = [];
  let points = 0;
  for (const s of WAYSTONE_SWEEP.stats) {
    const curve = [];
    let ceiling = 0, lastCur = null, lastAmt = null;
    for (const t of s.thresholds) {
      const r = await waystoneFloorSafe(league, { [s.filter]: { min: t } }, s.prop, rates);
      if (r.floor != null) { curve.push([t, Math.round(r.floor)]); points++; lastCur = r.floorCur; lastAmt = r.floorAmt; }
      ceiling = Math.max(ceiling, r.maxRoll || 0);
    }
    const peakEx = curve.length ? curve[curve.length - 1][1] : 0;
    stats.push({ key: s.key, label: s.label, tip: s.tip, curve, ceiling, peakEx });
    diag.push({ label: s.label + " (top threshold)", floorEx: peakEx, cur: lastCur, amt: lastAmt });
  }
  if (!points) throw new Error("sweep returned no data — market may be slow, try again");
  const maxPeak = Math.max(1, ...stats.map((st) => st.peakEx));
  for (const st of stats) st.weight = Math.round((st.peakEx / maxPeak) * 100) / 100;
  stats.sort((a, b) => b.peakEx - a.peakEx);
  // Combo probes: cheapest listing that has BOTH stats at once (same gated class).
  // `total` = how many are even for sale — a near-zero total means combos are a
  // RUN-yourself value, not a sellable one (don't blame the floor for that).
  const combos = [];
  for (const c of WAYSTONE_SWEEP.combos || []) {
    const r = await waystoneFloorSafe(league, c.filters, null, rates);
    combos.push({ key: c.key, label: c.label, floor: r.floor != null ? Math.round(r.floor) : null, total: r.total || 0, cur: r.floorCur, amt: r.floorAmt });
  }
  return {
    source: "PoE2 Trade2 — Waystone (Tier " + WAYSTONE_SWEEP.tier + ") price-vs-% sweep, gated corrupted+0-revives, all-currency→ex (live refresh)",
    analyzed: new Date().toISOString().slice(0, 10),
    league,
    baselineEx: Math.round(base),
    rates,
    diag,
    note: "Value depends on the rolled %, not just which stat. Read each stat's curve. Floors are the cheapest ask across ALL currencies (chaos/divine/exalted), normalized to exalted (1 chaos ≈ " + Math.round(rates.chaosEx || 0) + "ex). Gated to corrupted + 0-revives (fully juiced).",
    stats,
    combos,
    updated: new Date().toISOString(),
  };
}

// ── Official Currency Exchange rate (Map Juicer div↔ex readout) ────────────
// Reads GGG's live bulk Currency Exchange (the in-game book), NOT poe.ninja.
// Cached with a TTL so a page load triggers at most one trade call per window;
// falls back to the last cached value (or {limited}) when the queue is blocked.

// Best buyer rate (cheapest exalted-per-divine) with non-trivial stock, so a
// single tiny-stock outlier can't skew the headline number.

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

  // forceFresh ("Fetch fresh prices") re-prices each pasted exchange item live inline
  // (EE2, bounded by MAX_LIVE_EXCHANGE); the default check serves the EE2 cache and
  // background-fills the rest. No pre-fill block needed — the per-item loop handles it.

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
  const MAX_LIVE_EXCHANGE = 20;  // live EE2 calls per check — covers a reward paste; overflow shows "pricing…" + background fill
  const ee2Pending = [];         // catalog ids shown "pricing…" this check → background-filled at the end

  // PRIMARY price source: poe.ninja values via EE2's proxy (cached, no GGG limit,
  // volume-weighted = accurate). Covers currency, runes, essences, alloys, omens, …
  // The Trade2 bulk book (exchangePriceEx) is shown alongside as the LIVE buyable
  // offers, and is the fallback for anything the proxy doesn't list.
  const proxy = await getProxyData(league).catch(() => null);

  const seenCleanNames = new Set();
  const results = [];
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

    if (!isSkillOrSupport) {
      // HEADLINE value: poe.ninja via the EE2 proxy (reliable, volume-weighted).
      const pv = proxyPrice(proxy, cleanName);
      // LIVE OFFERS: the Trade2 bulk book (cached + budgeted), shown as the side line.
      const cat = exchangeCatalog.get(norm);
      let bulk = null, sideLine = "";
      if (cat && cat.id && cat.id !== EXALTED_ID) {
        const min = parsed.qty > 1 ? parsed.qty : 0;   // EE2 stack filter — drop 1-item par-spam
        const cacheKey = cat.id + "|" + min;
        let p = ee2Cached(league, cacheKey);
        // Only spend a BLOCKING live Trade2 call when it's needed for the VALUE (poe.ninja
        // missed) or the user explicitly asked for fresh. When poe.ninja already priced the
        // item, the bulk read is just a secondary "live offers" side line — serve it from
        // cache or background-fill it, so the check returns instantly instead of waiting on
        // up to 20 sequential Trade2 calls (poe.ninja is now the primary, accurate source).
        const proxyHasPrice = !!(pv && pv.ex > 0);
        const needLive = forceFresh || (!p && !proxyHasPrice);
        if (needLive && liveExchangeCalls < MAX_LIVE_EXCHANGE && !tradeStatus().limited) {
          liveExchangeCalls++;
          const live = await exchangePriceEx(league, cat.id, currencyRates.divine || 0, currencyRates.chaos || 0, min);
          writeEe2Cache(league, cacheKey, live || { ex: 0 });
          p = live ? { ...live } : { ex: 0 };
        } else if (!p) { ee2Pending.push({ id: cat.id, min, key: cacheKey }); }   // fill live offers for next check
        if (p && p.sides && p.sides.length) {
          bulk = p;
          // Lead with the selected (deepest-liquidity) side + each side's offer count.
          sideLine = p.sides.slice().sort((a, b) => (a.tag === p.side ? -1 : b.tag === p.side ? 1 : 0)).map((s) => fmtSidePx(s.px, s.tag) + " ×" + s.depth).join(" · ");
        }
      }
      // Value = poe.ninja if known, else the live bulk floor as a fallback.
      const each = (pv && pv.ex > 0) ? round4(pv.ex) : (bulk && bulk.ex > 0 ? bulk.ex : 0);
      if (each > 0) {
        const fromProxy = !!(pv && pv.ex > 0);
        const vol = fromProxy ? (pv.volume || 0) : (bulk ? bulk.depth : 0);
        results.push({
          qty: parsed.qty, name: (pv && pv.name) || (cat && cat.name) || cleanName,
          category: fromProxy ? (pv.type || "Currency") : ((cat && cat.category) || "Exchange"),
          each, total: roundPriceExalted(each * parsed.qty), currency: "exalted",
          source: fromProxy ? "poe.ninja (EE2)" : "trade2 exchange",
          rawPrice: sideLine ? "live: " + sideLine : "", sides: bulk ? bulk.sides : [], sideLine,
          divineValue: currencyRates.divine ? roundPriceExalted(each / currencyRates.divine) : 0,
          change7d: "",
          confidence: (pv && pv.base) ? "base" : vol >= 100 ? "high" : vol >= 10 ? "medium" : "low",
          units: Number.isFinite(vol) ? Math.round(vol) : null,
        });
        continue;
      }
      // Known exchange item but no value yet (proxy miss + over the live budget / no offers).
      if (cat) {
        const pending = liveExchangeCalls >= MAX_LIVE_EXCHANGE && !tradeStatus().limited;
        results.push({ qty: parsed.qty, name: (cat.name) || cleanName, category: pending ? "pricing…" : "no price", each: "", total: "", currency: "", source: "ee2", rawPrice: pending ? "fetching — check again shortly" : "", change7d: "", confidence: "none", units: null });
        continue;
      }
      // Not in the proxy or the exchange catalog → fall through to Not found below.
    }

    if (isSkillOrSupport && tradePaused) {
      results.push({ qty: parsed.qty, name: cleanName, category: "Trade queued", each: "", total: "", currency: "", source: "trade2", rawPrice: "shared trade limit hit — live-trade is best-effort", change7d: "" });
      continue;
    }

    if (isSkillOrSupport) {
      results.push({ qty: parsed.qty, name: cleanName, category: "Trade queued", each: "", total: "", currency: "", source: "trade2", rawPrice: "queued — shared rate-limit bucket, live-trade is best-effort", change7d: "" });
      continue;
    }

    results.push({ qty: parsed.qty, name: cleanName, category: "Not found", each: "", total: "", currency: "", source: "", rawPrice: "", change7d: "" });
  }

  // Background-fill EE2 prices for items shown "pricing…" this check (over the live
  // budget), so the NEXT check shows them. Fire-and-forget; bounded; never blocks.
  if (ee2Pending.length && !tradeStatus().limited) {
    refreshEe2Prices(league, ee2Pending, currencyRates).catch(() => {});
  }

  results.sort((a, b) => (Number(b.total) || -1) - (Number(a.total) || -1));
  const best = results.find((item) => Number(item.total) > 0) || null;
  return {
    results,
    best,
    count: results.length,
    truncated: rawLines.length > limitedRawLines.length,
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

// Whether a slot can roll "increased Rarity of Items" (so a rarity search-floor is valid).
// Reads the per-slot valid-affix pool (PRESERVE_CONTROL_STATS_BY_SLOT) — weapons/jewels
// have no rarity affix; every armour piece + jewellery does.
const slotHasRarity = (baseSlot) => (PRESERVE_CONTROL_STATS_BY_SLOT[baseSlot === "ring1" || baseSlot === "ring2" ? "ring" : baseSlot] || []).includes("rarity");
// "Require Item Rarity ≥ N%" as a Trade2 stat filter. The naive `explicit.stat_…` floor
// only matched an EXPLICIT rarity mod ≥N, so it MISSED Gold Amulet's IMPLICIT rarity (and
// rarity split across mods) → 0 results even though the item's total rarity was ≥N. Trade
// has no pseudo "total rarity" and can't sum across affix types with a flat filter, so we
// OR the per-source rarity stats with a `type:"count"` group (min 1). VERIFIED LIVE
// 2026-07-01 that count groups WITH a value ARE accepted on PoE2 trade (the old "count 400s"
// note was wrong). Kept to 4 real rarity sources so the group stays under the complexity cap.
const RARITY_STAT_NUM = "3917489142";
const RARITY_SOURCES = ["explicit", "implicit", "fractured", "rune"];
function injectRarityGroup(q, baseSlot, rarityMin) {
  if (!(rarityMin > 0) || !slotHasRarity(baseSlot) || !q || !q.query) return;
  const min = Math.max(1, Math.floor(rarityMin));
  q.query.stats = q.query.stats || [];
  q.query.stats.push({ type: "count", value: { min: 1 }, filters: RARITY_SOURCES.map((s) => ({ id: s + ".stat_" + RARITY_STAT_NUM, value: { min } })) });
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
  // Caster/minion sceptre — what SELLS (build-agnostic resale), best first. Aliases resolve
  // to single-stat sceptre pool mods via ALIAS_TEMPLATE; the hybrid "increased Spirit | +Mana"
  // tiers are skipped by the pool index (single-stat only), so this targets the pure rolls.
  sceptre: [
    { key: "spiritPct" },             // up to 65% increased Spirit (the marquee sceptre stat)
    { key: "levelAllMinionSkills" },  // +Level of all Minion Skills
    { key: "levelAllSpellSkills" },   // +Level of all Spell Skills
    { key: "minionDamageIncr" },      // Minions deal increased Damage
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
  // projectileLevels/projectileDamage ARE rollable on bows and are a projectile build's biggest DPS mod
  // (the probe self-gates to ~0 for non-projectile builds, so they only weight when the build uses them).
  bow: ["dps", "critChance", "critDamage", "localPhysDamage", "localAttackSpeed", "totalFlatAttack", "totalFlatElementalAttack", "localFlatPhys", "localFlatCold", "localFlatFire", "localFlatLightning", "localFlatChaos", "levelAllAttackSkills", "levelAllMeleeSkills", "projectileLevels", "projectileDamage", "str", "dex", "int"],
  quiver: ["attackCrit", "critDamage", "bowDamage", "projectileSpeed", "projectileLevels", "totalFlatAttack", "totalFlatElementalAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "manaOnKill", "str", "dex", "int", "rarity"],
  amulet: ["life", "energyShield", "mana", "spirit", "critChance", "critDamage", "spellDamage", "castSpeed", "levelAllSpellSkills", "levelAllAttackSkills", "projectileLevels", "manaRegen", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  helmet: ["energyShield", "evasion", "armour", "life", "mana", "critChance", "levelAllMinionSkills", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  focus: ["energyShield", "mana", "manaRegen", "spellDamage", "castSpeed", "levelAllSpellSkills", "levelAllMinionSkills", "critChance", "critDamage", "spirit", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  shield: ["energyShield", "armour", "evasion", "life", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  buckler: ["evasion", "energyShield", "life", "str", "dex", "int", "totalAllAttributes", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  chest: ["energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  boots: ["movementSpeed", "energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "rarity"],
  // projectileLevels/projectileDamage: only rollable on gloves with a Marksman rune (Kolr's Hunt,
  // 0.5) socketed, but on trade they're plain explicits. Self-gating — the weight perturbation gives
  // ~0 for non-projectile builds, so they only surface marksman gloves for builds that actually use them.
  gloves: ["attackSpeed", "projectileLevels", "projectileDamage", "totalFlatAttack", "totalFlatElementalAttack", "flatPhysAttack", "flatColdAttack", "flatFireAttack", "flatLightningAttack", "flatChaosAttack", "energyShield", "evasion", "armour", "life", "mana", "str", "dex", "int", "fireRes", "coldRes", "lightningRes", "chaosRes", "totalElementalRes", "manaOnKill", "rarity"],
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
  let weaponPhysAvg = 0;      // physical portion of the average hit (for a phys-DPS floor)
  let explicitPhysDps = 0;    // trade-copied "Physical DPS:" line

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

  for (const match of source.matchAll(/Physical DPS:\s*(\d+(?:\.\d+)?)/gi)) { explicitDps += Number(match[1]); explicitPhysDps += Number(match[1]); }
  for (const match of source.matchAll(/Elemental DPS:\s*(\d+(?:\.\d+)?)/gi)) explicitDps += Number(match[1]);
  for (const match of source.matchAll(/Physical Damage:\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/gi)) { weaponAverageHit += avgPair(match); weaponPhysAvg += avgPair(match); }
  for (const match of source.matchAll(/(?:Fire|Cold|Lightning) Damage:\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/gi)) weaponAverageHit += avgPair(match);
  for (const match of source.matchAll(/Attacks per Second:\s*(\d+(?:\.\d+)?)/gi)) weaponAps = Math.max(weaponAps, Number(match[1]) || 0);

  if (weaponAverageHit > 0 && weaponAps > 0) {
    addStat(stats, "dps", weaponAverageHit * weaponAps);
  } else if (explicitDps > 0) {
    addStat(stats, "dps", explicitDps);
  }
  // Physical DPS on its own — a phys build wants "more phys than mine", not total (which an
  // elemental weapon can inflate). Prefer physAvg×aps; fall back to the trade "Physical DPS:" line.
  if (weaponPhysAvg > 0 && weaponAps > 0) addStat(stats, "pdps", weaponPhysAvg * weaponAps);
  else if (explicitPhysDps > 0) addStat(stats, "pdps", explicitPhysDps);

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

function totalResistance(stats) {
  return ["fireRes", "coldRes", "lightningRes", "chaosRes"].reduce((total, key) => {
    return total + (Number(stats && stats[key]) || 0);
  }, 0);
}

// A Trade2 fetch result → a clean, PoB-parseable item string (Rarity / name /
// base / Item Level / Implicits + mods). Used by real-DPS ranking; fetched items
// always carry the base type, unlike hand-copies from the trade page.
// The amulet ANOINT line(s) ("Allocates <Notable>", PoB → GrantedPassive) from an item's
// text, markup-stripped. Used to transfer your current anoint onto un-anointed trade
// candidates so the swap comparison holds the anoint constant. Matches "Allocates " (present
// tense) only — never "…Notable Passive Skill Allocated" multiplier mods.
function extractAnoint(raw) {
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    const m = line.match(/Allocates\s+\S.*$/i);
    if (m) out.push(normalizePoeMarkup(m[0]).trim());
  }
  return out;
}

// Your CURRENT item's rune contribution, as PLAIN stackable mod text + how many sockets
// it spans. PoB exports rune mods tagged {enchant}{rune} (and combines identical runes
// into one summed line, e.g. 2× Iron → "40% increased AES"); the {enchant} tag makes PoB
// treat the value as a fixed enchant that WON'T stack on duplication — so we strip all
// {..} markup (and the "Bonded:" prefix) to plain text, which DOES stack/sum in PoB
// (verified). `sockets` = filled rune sockets on the current item ("Rune:" lines), so a
// candidate's rune value can be scaled by candidateSockets/sockets.
function extractRuneFill(raw) {
  const lines = [];
  for (const line of String(raw || "").split("\n")) {
    if (!/\{rune\}/i.test(line)) continue;
    const t = line.replace(/\{[^}]*\}/g, "").replace(/^\s*Bonded:\s*/i, "").trim();
    if (t) lines.push(t);
  }
  const sockets = (String(raw || "").match(/^\s*Rune:\s/gim) || []).length || (lines.length ? 1 : 0);
  return { lines, sockets };
}

// extraImplicits: enchant-section lines to graft on (your anoint, transferred from your
// current amulet). Added to the implicit block + count so PoB reads them as enchants. Any
// anoint the candidate ALREADY has is REPLACED with yours — you can only run one anoint and
// you'd re-anoint whatever you buy with your own notable, so its existing one is irrelevant.
// runeFill {lines, sockets}: your rune contribution from extractRuneFill. When given, the
// listing's own runeMods are DROPPED (seller's choice + base "Bonded" lines) and the
// candidate's sockets are filled with YOUR rune instead, scaled by candidateSockets/yours
// — so an extra socket adds rune value, an unsocketable base loses it. item.sockets.length
// = total sockets incl. empty (GGG schema). Omit runeFill to keep the legacy behaviour.
// ponytail: scaling assumes a uniform rune across your sockets (true for the common case
// of the same rune in every socket); a mix of different runes scales proportionally rather
// than exactly. Dropping base "Bonded" mods slightly undervalues niche Shaman bases.
function pobItemFromTradeEntry(entry, extraImplicits, runeFill) {
  const item = (entry && entry.item) || {};
  const base = item.typeLine || item.baseType || "";
  if (!base) return null;
  const name = item.name || "";
  const ilvl = item.ilvl || item.itemLevel || 81;
  // PoE2 trade2 returns each mod as an OBJECT ({description, hash, mods:[...]}), not a
  // plain string like PoE1. String(obj) → "[object Object]" → PoB parses a blank item
  // (mods dropped) → every candidate scores identically. Pull the actual text.
  const modText = (m) => normalizePoeMarkup(typeof m === "string" ? m : (m && m.description) || "");
  const fillRunes = runeFill && runeFill.lines && runeFill.lines.length && runeFill.sockets > 0;
  const sCand = (item.sockets || []).length;
  const factor = fillRunes ? sCand / runeFill.sockets : 0;
  const scale = (line) => line.replace(/\d+(?:\.\d+)?/g, (m) => String(Math.round(parseFloat(m) * factor)));
  const myRunes = fillRunes && sCand > 0 ? runeFill.lines.map(scale) : [];
  let impl = [].concat(item.enchantMods || [], fillRunes ? [] : (item.runeMods || []), item.implicitMods || []).map(modText).filter(Boolean).concat(myRunes);
  if (extraImplicits && extraImplicits.length) impl = impl.filter((l) => !/Allocates\s/i.test(l)).concat(extraImplicits);
  const expl = [].concat(item.explicitMods || [], item.fracturedMods || [], item.craftedMods || [], item.desecratedMods || []).map(modText).filter(Boolean);
  const head = name ? `Rarity: Rare\n${name}\n${base}` : `Rarity: Normal\n${base}`;
  // Item quality (from properties) boosts local weapon/armour values — PoB scores 0% if omitted, so a fetched
  // item scored materially LOWER than the same item pasted (which carries "Quality: +N%"). Include it.
  const qProp = (item.properties || []).find((p) => p && /quality/i.test(p.name || ""));
  const quality = qProp && qProp.values && qProp.values[0] ? (parseInt(String(qProp.values[0][0]).replace(/[^\d]/g, ""), 10) || 0) : 0;
  const lines = [head];
  if (quality > 0) lines.push(`Quality: +${quality}%`);
  lines.push(`Item Level: ${ilvl}`, `Implicits: ${impl.length}`);
  return lines.concat(impl, expl).join("\n");
}

// The item's top-weighted rolled mods (statId + floored roll), for narrowing an
// "open this listing" search to the exact item. Critical for jewels: their base type
// ("Diamond"/"Sapphire") is generic, so base+account alone matches a seller's OTHER
// jewels — adding 2-3 of its mods pins it.
function linkModsFromEntry(entry, weights) {
  const expl = (entry && entry.item && entry.item.explicitMods) || [];
  const valOf = (statId) => { const md = expl.find((x) => (x && x.hash) === "stat." + statId); if (!md) return null; const n = parseFloat(String(md.description || "").replace(/[^\d.\-]+/g, " ").trim().split(" ")[0]); return Number.isFinite(n) ? n : null; };
  const out = [];
  for (const w of (weights || [])) { const v = valOf(w.statId); if (v != null) out.push({ statId: w.statId, min: Math.floor(v) }); if (out.length >= 3) break; }
  return out;
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

// Resolve a slot's search config. Tree-jewel slot ids are dynamic ("jewel<nodeId>",
// one per socket) so they aren't in the static map — they all share the "jewel" config
// (category/baseId/stat list); the per-socket identity only matters for the PoB slot name.
function gearSlotCfg(slotId) {
  const slots = gearSearchSlots();
  return slots[slotId] || (/^jewel\d+$/.test(slotId) ? slots.jewel : undefined);
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

// Derived/aggregate or equipment-property keys whose stored value does not map
// 1:1 to a single explicit trade stat, so they must not become per-item filters.

// Build a compact, self-contained spec for a single listing so the front end can
// later ask the server to open the official Trade UI focused on (essentially)
// that item. Only explicit single-mod stats are used; price + base type are the
// strongest discriminators. No server-side state is kept.

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
  const jm = /^jewel(\d+)$/.exec(slotId); if (jm) return "Jewel " + jm[1];   // tree socket → PoB slot name
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

function parsePobBuild(xml, setId) {
  // id -> item text (strip child tags like <ModRange/>, keep mod lines). Items are shared
  // children of <Items>; the per-set <Slot>s just reference them by id.
  const items = {};
  let m;
  const itemRe = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/g;
  while ((m = itemRe.exec(xml))) {
    const id = (m[1].match(/\bid="(\d+)"/) || [])[1];
    if (!id) continue;
    items[id] = unescapeXml(m[2].replace(/<[^>]+>/g, "")).split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }
  // Item sets: PoB stores each gear loadout in its own <ItemSet id title>…</ItemSet> holding
  // that set's <Slot>s. Scope slot parsing to ONE set (else 2+ sets mix, first-slot-wins).
  const sets = [];
  const setBodies = {};
  const setRe = /<ItemSet\b([^>]*)>([\s\S]*?)<\/ItemSet>/g;
  while ((m = setRe.exec(xml))) {
    const id = (m[1].match(/\bid="(\d+)"/) || [])[1];
    if (!id) continue;
    const title = unescapeXml((m[1].match(/\btitle="([^"]*)"/) || [])[1] || "");
    sets.push({ id, title: title || ("Set " + id) });
    setBodies[id] = m[2];
  }
  const activeAttr = (xml.match(/<Items\b[^>]*\bactiveItemSet="(\d+)"/) || [])[1];
  // Resolve which set to read: explicit setId → build's active set → first set. Falls back to
  // the whole XML when a build has no <ItemSet> wrapper at all.
  const activeSet = (setId && setBodies[setId]) ? String(setId)
    : (activeAttr && setBodies[activeAttr]) ? activeAttr
    : (sets[0] && sets[0].id) || null;
  const slotSrc = (activeSet && setBodies[activeSet]) || xml;
  // PoE2 weapon swap: on Weapon Set II (useSecondWeaponSet) the ACTIVE weapons live in
  // the "Weapon N Swap" slots — read those, not the inactive "Weapon N". PoB's calc keys
  // off the slot name, so pobSlot stays the swap name and the headless what-if hits the
  // weapon the build actually attacks with. (Else a swap build shows the wrong/no weapon.)
  const useSecondWeapon = /<Items\b[^>]*\buseSecondWeaponSet="true"/.test(xml);
  const weaponSlotRe = useSecondWeapon ? /^Weapon [12] Swap$/ : /^Weapon [12]$/;
  // slot name -> itemId
  const slots = {};
  const slotRe = /<Slot\b([^>]*?)\/?>/g;
  while ((m = slotRe.exec(slotSrc))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/) || [])[1];
    const itemId = (attrs.match(/\bitemId="(\d+)"/) || [])[1];
    if (!name || !itemId || itemId === "0" || !items[itemId]) continue;
    let slotId = POB_SLOT_MAP[name];
    if (!slotId && weaponSlotRe.test(name)) slotId = pobWeaponSlot(items[itemId]);
    if (!slotId || slots[slotId]) continue; // skip flasks/jewels/sockets/inactive-weapon-set + dupes
    const raw = items[itemId];
    const baseSlot = slotId === "ring1" || slotId === "ring2" ? "ring" : slotId;
    slots[slotId] = { pobSlot: name, name: (raw.split("\n")[1] || raw.split("\n")[0] || "").trim(), raw, stats: parseItemStats(raw, baseSlot) };
  }
  // Tree-socketed jewels live in <Socket nodeId itemId>, not <Slot>. Surface the RARE
  // ones as optimizer slots "jewel<nodeId>" — uniques are build-defining (skipped, like
  // unique gear); Time-Lost jewels are uniques too, so they fall out here. PoB exposes each
  // socket as a real slot named "Jewel <nodeId>", so the headless calc swaps it like gear.
  const seenJewel = new Set();
  const sockRe = /<Socket\b([^>]*?)\/?>/g;
  while ((m = sockRe.exec(xml))) {
    const nodeId = (m[1].match(/\bnodeId="(\d+)"/) || [])[1];
    const itemId = (m[1].match(/\bitemId="(\d+)"/) || [])[1];
    if (!nodeId || !itemId || itemId === "0" || !items[itemId] || seenJewel.has(itemId)) continue;
    const raw = items[itemId];
    if (/Rarity:\s*UNIQUE/i.test(raw)) continue;
    seenJewel.add(itemId);
    const slotId = "jewel" + nodeId;
    if (slots[slotId]) continue;
    slots[slotId] = { pobSlot: "Jewel " + nodeId, name: (raw.split("\n")[1] || raw.split("\n")[0] || "").trim(), raw, stats: parseItemStats(raw, "jewel"), jewel: true };
  }
  // PoB computed stats — <PlayerStat value="X" stat="Y"/> (value first)
  const build = {};
  const psRe = /<PlayerStat\b([^>]*?)\/?>/g;
  while ((m = psRe.exec(xml))) {
    const v = (m[1].match(/\bvalue="([^"]*)"/) || [])[1];
    const s = (m[1].match(/\bstat="([^"]+)"/) || [])[1];
    if (s != null && v != null) build[s] = isNaN(Number(v)) ? v : Number(v);
  }
  return { slots, build, sets, activeSet };
}

// Flip which item set a build XML treats as active — so headless PoB computes stats for the
// set the user picked in the UI (its <Slot>s become the equipped gear).
function setActiveItemSet(xml, id) {
  if (!id) return xml;
  return String(xml).replace(/(<Items\b[^>]*\bactiveItemSet=")\d+(")/, `$1${id}$2`);
}

// "Ignore Rakiata's Flow" toggle. Rakiata's Flow inverts enemy elemental resistance, which PoB scores
// against its default high-res enemy → inflates ELEMENTAL damage (~2.8x on the user's build) and makes
// the Gear Finder over-recommend elemental gear over physical. We can't set enemy res headlessly
// (FullDPS is computed vs a fixed enemy — the <Config> never reaches it), but DISABLING the gem removes
// the inversion, so scoring reflects damage WITHOUT the situational elemental boost. Regex matches the
// XML-escaped nameSpec ("Rakiata&apos;s Flow"). `buildHasRakiata` gates the UI checkbox.
const RAKIATA_NAME_RE = /nameSpec="[^"]*Rakiata/i;
const buildHasRakiata = (xml) => RAKIATA_NAME_RE.test(String(xml || ""));
const disableRakiata = (xml) => String(xml || "").replace(/<Gem\b[^>]*?\/?>/g, (t) => RAKIATA_NAME_RE.test(t) ? t.replace(/enabled="[^"]*"/, 'enabled="false"') : t);
// The build XML to score with: drops Rakiata's Flow when the caller ticked "ignore" it. Used by every
// gear endpoint that loads/scores the build, so weights, ranking, set optimize and paste-score agree.
const prepBuildXml = (input) => { const xml = String((input && input.buildXml) || ""); return (input && input.ignoreRakiata) ? disableRakiata(xml) : xml; };

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

// The boots' OWN movement-speed roll, EXCLUDING {rune}/{enchant}-granted MS (that comes
// from a socketed rune you carry to new boots, not the base item) — so the preserve floor
// reflects your real roll (e.g. 35%), not a flat default or a rune-polluted total.
function explicitMovementSpeed(raw) {
  let total = 0;
  for (const line of String(raw || "").split("\n")) {
    if (/\{(rune|enchant)\}/i.test(line)) continue;
    const m = line.match(/(\d+(?:\.\d+)?)%\s+increased Movement Speed/i);
    if (m) total += parseFloat(m[1]);
  }
  return total;
}

async function computeGearWeights(buildXml, pobSlot, baseSlot, currentRaw) {
  await pob.load(buildXml);
  const base = await pob.calc(pobSlot, "");
  const currentStats = parseItemStats(currentRaw || "", baseSlot);
  const keys = (PRESERVE_CONTROL_STATS_BY_SLOT[baseSlot] || []).filter((k) => GEAR_PROBE_TEMPLATES[k] && gearStatId(k, baseSlot));
  // Per-stat marginal value under a chosen metric (DPS or EHP).
  const probe = async (metric) => {
    const mf = metric === "dps" ? dpsOfOut : ehpOfOut;
    const baseVal = mf(base);
    const raw = [];
    for (const k of keys) {
      const [inc, line] = GEAR_PROBE_TEMPLATES[k];
      let per = 0;
      try { per = (mf(await pob.calc(pobSlot, currentRaw + "\n" + line(inc))) - baseVal) / inc; } catch {}
      if (per > 1e-4) raw.push({ key: k, statId: gearStatId(k, baseSlot), label: statLabel(k), perUnit: Math.round(per * 100) / 100, cur: Math.round(currentStats[k] || 0) });
    }
    return raw;
  };
  // The item's TOTAL base defences (ev/ar/es) from its property lines → realrank
  // equipment_filters so a replacement keeps the item's CORE value (e.g. an evasion
  // chest's ~2800 evasion). The % stat-floors + marginal weights can't express this.
  const equip = {};
  const evM = String(currentRaw || "").match(/^\s*Evasion(?: Rating)?:\s*(\d+)/im); if (evM) equip.ev = Number(evM[1]);
  const arM = String(currentRaw || "").match(/^\s*Armour(?: Rating)?:\s*(\d+)/im); if (arM) equip.ar = Number(arM[1]);
  const esM = String(currentRaw || "").match(/^\s*Energy Shield:\s*(\d+)/im); if (esM) equip.es = Number(esM[1]);
  // Weapon slots: carry the current weapon's PHYSICAL dps (or total, as fallback) so the
  // search can floor a replacement at "more phys than mine" — the phys-build value the
  // marginal stat weights can't express (and total dps overstates for an elemental weapon).
  if ((Number(currentStats.pdps) || 0) > 0) equip.pdps = Math.round(currentStats.pdps);
  else if ((Number(currentStats.dps) || 0) > 0) equip.dps = Math.round(currentStats.dps);
  // Metric: a slot with base defences (helmet/body/boots/belt/shield) is FIRST a
  // survivability item — rank it by EHP even when it also moves some DPS ("the DPS is
  // extra"). EXCEPT gloves: they're an armour piece but carry the build's offensive rolls
  // (attack/cast speed, crit, %damage), so they're DPS-ranked despite base defence. Pure-
  // offence slots (weapons, amulet, rings) rank by DPS; a slot that moves no DPS at all
  // falls back to EHP rather than reporting "nothing improves this slot".
  const hasDefence = (equip.ev || 0) + (equip.ar || 0) + (equip.es || 0) > 0;
  const ehpSlot = hasDefence && baseSlot !== "gloves";
  let metric = ehpSlot ? "ehp" : (dpsOfOut(base) > 0 ? "dps" : "ehp");
  let raw = await probe(metric);
  if (metric === "dps" && !raw.length) { metric = "ehp"; raw = await probe("ehp"); }
  const max = raw.reduce((m, w) => Math.max(m, w.perUnit), 0) || 1;
  const weights = raw.map((w) => ({ ...w, weight: Math.max(1, Math.round((w.perUnit / max) * 20)) })).sort((a, b) => b.weight - a.weight);
  // PRESERVE floors: must-keep stats that PoB's DPS/EHP metric CAN'T see (so they score
  // 0 and never become weighted floors), yet a replacement without them is a non-starter.
  // Boots = movement speed: a fixed ≥25% floor (every build wants it). NOT the current
  // roll — that's polluted by socketed-gem/rune movement speed, which doesn't move with
  // the boots, so it reads low/wrong.
  const preserve = [];
  // Boots: keep movement speed at the boots' OWN explicit roll (your 35%), not a flat 25 —
  // but floor at ≥25 so a weak current roll still demands a sensible minimum. Rune/enchant
  // MS is excluded (you carry the rune separately).
  if (baseSlot === "boots") preserve.push({ statId: gearStatId("movementSpeed", baseSlot), min: Math.max(25, Math.round(explicitMovementSpeed(currentRaw))) });
  // Spirit: if the build RESERVES spirit (auras/heralds) and the current item carries it, a
  // replacement must KEEP it — floor candidates at your current spirit roll. We do NOT
  // subtract unreserved "slack": headless PoB's reservation reading is nondeterministic
  // across loads (SpiritUnreserved came back 33 one load, -88 another — TotalDPS swings too),
  // so a slack-aware floor is unreliable. The user has only ~3 slack anyway, so flooring at
  // the full roll costs nothing and is STABLE (a slack-derived floor leaked no-spirit necks).
  const spiritStatId = gearStatId("spirit", baseSlot);
  if ((Number(base.SpiritReserved) || 0) > 0 && (currentStats.spirit || 0) > 0 && spiritStatId)
    preserve.push({ statId: spiritStatId, min: Math.round(currentStats.spirit) });
  return { metric, base: { Life: base.Life, EnergyShield: base.EnergyShield, TotalEHP: base.TotalEHP, dps: dpsOfOut(base) }, weights, equip, preserve };
}

// A build-weighted Trade2 query: the `weight` group ranks items by the weighted
// sum of their stats. But a pure weighted sum is LINEAR while DPS is often
// multiplicative — an item heavy on flat damage but missing your top multiplier
// (attack speed, crit) scores high yet is a real downgrade. So we also GATE the
// query: the candidate must roll at least 60% of your current item's value on
// the top-weighted stat. Anonymous POST of a weight group 400s ("log in") — so
// this is POSTed by the user's logged-in browser (the snippet).
function buildWeightedGearQuery(slot, weights, league, maxPriceDiv, preserve, opts = {}) {
  // Cap the weight group: GGG 400s a query with too many filters ("too complex").
  // Top 4 weights rank fine; PoB scores the real winners anyway.
  const top4 = weights.slice(0, 4);
  const stats = [{ type: "weight", filters: top4.map((w) => ({ id: w.statId, value: { weight: w.weight } })), value: {} }];
  // Hard AND gate = "this item or better". Two sources, deduped by stat id:
  //   (1) PRESERVE floors (spirit, boots movement speed) at the FULL current roll — the
  //       weight SUM can trade these away (a high-DPS neck with 0 spirit still scores top),
  //       so without this the weighted browse search surfaces no-spirit necks.
  //   (2) "Or better" floors: the stats the current item ACTUALLY HAS, floored at 70% of
  //       their roll (same rule realrank uses) — a pure weighted sum only RANKS, it doesn't
  //       filter, so without these the copied search lists a flood of strict downgrades.
  //       Capped at the top 3 by weight so gate + preserve + equipment stay under GGG's
  //       "query too complex" limit. Preserve wins ties (its floor is the full roll).
  // Only floor stats that MEANINGFULLY drive the metric: a trivial-weight stat with a
  // near-BiS current roll (e.g. a ×1 proj-damage floor at 42% next to a ×20 proj-levels
  // sort) prunes the whole market and returns 0, even though it barely affects DPS. Gate
  // floors at ≥20% of the top weight so the sort + PoB scoring (not a marginal floor) picks
  // the winners. ponytail: static 0.2 cutoff; if a HIGH-weight floor still zeroes the pool,
  // add an auto-relax-on-empty retry in realrank.
  const topW = Math.max(1, ...((Array.isArray(weights) ? weights : []).map((w) => Number(w && w.weight) || 0)));
  const orBetter = (Array.isArray(weights) ? weights : [])
    .filter((w) => w && (w.cur || 0) > 0 && (Number(w.weight) || 0) >= topW * 0.2)
    .slice(0, 3)
    .map((w) => ({ statId: w.statId, min: Math.floor((w.cur || 1) * 0.7) }));
  const andFilters = [];
  const seen = new Set();
  for (const f of [...gearStatFilters(preserve, 4), ...gearStatFilters(orBetter, 3)]) {
    if (!seen.has(f.id)) { seen.add(f.id); andFilters.push(f); }
  }
  if (andFilters.length) stats.push({ type: "and", filters: andFilters });
  const q = {
    query: {
      status: { option: GEAR_TRADE_STATUS },
      filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } },
      stats,
    },
    sort: { "statgroup.0": "desc" },
  };
  // Price band — respects BOTH the "Min div" (skip junk below the floor) and "Max div" inputs.
  const minDiv = Number(opts.minPriceDiv) || 0, maxDiv = Number(maxPriceDiv) || 0;
  if (minDiv > 0 || maxDiv > 0) {
    const price = { option: "divine" };
    if (minDiv > 0) price.min = minDiv;
    if (maxDiv > 0) price.max = maxDiv;
    q.query.filters.trade_filters = { filters: { price } };
  }
  // Keep the item's CORE value the marginal weights can't see, floored at 70%:
  const equip = opts.equip;
  if (equip && typeof equip === "object") {
    const ef = {};
    // Armour: the dominant base defence, only when SUBSTANTIAL (≥500) — a saturated base stat
    // (evasion ~2800). Minor defence (boots ~300) skips it (and stays under the complexity cap).
    let bestK = null, bestV = 0;
    for (const k of ["ev", "ar", "es"]) { const v = Number(equip[k]) || 0; if (v > bestV) { bestV = v; bestK = k; } }
    if (bestK && bestV >= 500) ef[bestK] = { min: Math.floor(bestV * 0.7) };
    // Weapon: PHYSICAL dps ("more phys than mine") — a phys build's real value; total dps can be
    // inflated by an elemental weapon. Falls back to total dps when phys isn't separable.
    // ONLY on opts.weaponFloor (the raw browse/copy query, which the user reads unscored): a bow's
    // phys dps is set almost entirely by its BASE TYPE, so a 70% floor near a top bow collapses the
    // pool to just the highest base (Obliterator). realrank/optimize DON'T set it — they PoB-score
    // every candidate and only surface real gains, so the floor there just hides varied bases.
    if (opts.weaponFloor) {
      const wdKey = Number(equip.pdps) > 0 ? "pdps" : Number(equip.dps) > 0 ? "dps" : null;
      if (wdKey) ef[wdKey] = { min: Math.floor(Number(equip[wdKey]) * 0.7) };
    }
    if (Object.keys(ef).length) q.query.filters.equipment_filters = { filters: ef };
  }
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

// ── Set Optimizer (multi-slot, breakpoint-preserving) ──────────────────────
// The breakpoints a candidate SET must hold, read off the build's PoB stats. Each
// floor defaults to your CURRENT value (so a set never makes a breakpoint worse) but
// is OVERRIDABLE per-run (the user dials one down to probe what's hidden just under).
function optimizeBreakpoints(base, targets) {
  const t = targets || {};
  const cur = {
    fireRes: Math.round(Number(base.FireResist) || 0),
    coldRes: Math.round(Number(base.ColdResist) || 0),
    lightRes: Math.round(Number(base.LightningResist) || 0),
    chaosRes: Math.round(Number(base.ChaosResist) || 0),
    spiritFree: Math.round(Number(base.SpiritUnreserved) || 0),  // relative: don't lose aura headroom
    rarityPct: Math.round(((Number(base.EffectiveLootRarityMod) || 1) - 1) * 100),
  };
  const num = (v, d) => (v == null || v === "" || isNaN(Number(v))) ? d : Number(v);
  const floors = {};
  // CAPPED stats (resistances): a floor must never exceed your CURRENT value — you can't require
  // KEEPING more than you have, and overcap is hidden, so clamp to the live reading (also guards the
  // old stale-resident-PoB bug where a default came in above the real value → every set illegal).
  // UNCAPPED stats (rarity, free spirit): the user can legitimately TARGET a value ABOVE current —
  // e.g. "find a set that pushes rarity 73→100" — so honor what they type. The default equals current
  // (always satisfiable by keep-all); only an explicit raise turns it into a reach-this target, and an
  // unreachable target just yields "no legal set" (dial it down to find the ceiling).
  const CAPPED = new Set(["fireRes", "coldRes", "lightRes", "chaosRes"]);
  for (const k of Object.keys(cur)) { const f = num(t[k], cur[k]); floors[k] = CAPPED.has(k) ? Math.min(f, cur[k]) : f; }
  floors._cur = cur;
  return floors;
}

// Read the same breakpoint stats off any calc output → the set's combined state.
function breakpointStats(stats) {
  return {
    fireRes: Math.round(Number(stats.FireResist) || 0),
    coldRes: Math.round(Number(stats.ColdResist) || 0),
    lightRes: Math.round(Number(stats.LightningResist) || 0),
    chaosRes: Math.round(Number(stats.ChaosResist) || 0),
    spiritFree: Math.round(Number(stats.SpiritUnreserved) || 0),
    rarityPct: Math.round(((Number(stats.EffectiveLootRarityMod) || 1) - 1) * 100),
  };
}
// An item's OWN contribution to each breakpoint (from its rolled mods, via parseItemStats).
// NB parseItemStats keys lightning as `lightningRes` (not `lightRes`) and spirit as `spirit`.
function itemBreakpointContrib(st) {
  st = st || {};
  return { fireRes: st.fireRes || 0, coldRes: st.coldRes || 0, lightRes: st.lightningRes || 0, chaosRes: st.chaosRes || 0, spiritFree: st.spirit || 0, rarityPct: st.rarity || 0 };
}
const BP_LABELS = { fireRes: "Fire", coldRes: "Cold", lightRes: "Light", chaosRes: "Chaos", spiritFree: "Spirit free", rarityPct: "Rarity%" };
function checkBreakpoints(stats, floors) {
  const have = breakpointStats(stats);
  const violations = [];
  for (const k of Object.keys(BP_LABELS)) if (have[k] < floors[k] - 0.5) violations.push({ key: k, label: BP_LABELS[k], have: have[k], need: floors[k] });
  return { ok: !violations.length, violations, have };
}

// Drop strictly-DOMINATED candidates: another option in the same slot is ≥ on DPS AND
// every breakpoint contribution AND ≤ price. A dominated item can never be in the best
// set, so this trims the combo space WITHOUT hiding any real winner. `keep` (current item)
// is never pruned. `contrib` = this item's own breakpoint-stat contribution (from its rolls).
function dominationPrune(pool) {
  const keys = ["fireRes", "coldRes", "lightRes", "chaosRes", "spiritFree", "rarityPct"];
  const dominates = (a, b) => {
    if (b.keep) return false;                         // never drop "keep current"
    if (!(a.dDPS >= b.dDPS && (a.priceDiv || 0) <= (b.priceDiv || 0))) return false;
    for (const k of keys) if ((a.contrib[k] || 0) < (b.contrib[k] || 0)) return false;
    return (a.dDPS > b.dDPS) || (a.priceDiv || 0) < (b.priceDiv || 0) || keys.some((k) => (a.contrib[k] || 0) > (b.contrib[k] || 0));
  };
  return pool.filter((b) => !pool.some((a) => a !== b && dominates(a, b)));
}

// GGG's listing.account.online is null when offline, otherwise an object that
// may carry status "afk"/"dnd" (absent = plain online). Note: this reflects the
// seller, not whether the item is still in their stash.

// ── Crafter (Phase 1) ─────────────────────────────────────────────────────────
// The pool builder now lives in craft-engine.js so the server and the tests build the pool
// the SAME way. It used to be defined only here, so the tests reimplemented a naive
// raw-PoB-weight version — and the closed-form-vs-MC cross-validation therefore ran on a
// pool no user ever gets, skipping the Craft-of-Exile spawn-weight overlay entirely.
const { craftWeightFor, craftEffWeight } = craftEngine;
// Bases that can roll at least one explicit mod (early-exits) — filters out jewels/
// flasks whose pools live in other PoB files we don't extract. Memoized (data is static).
let _craftBaseList = null;
function craftBaseList() {
  if (_craftBaseList || !CRAFT_DATA) return _craftBaseList || [];
  const mods = Object.values(CRAFT_DATA.mods);
  const out = [];
  for (const [name, b] of Object.entries(CRAFT_DATA.bases)) {
    const tagset = new Set(b.tags);
    if (mods.some((m) => craftWeightFor(m, tagset) > 0)) {
      out.push({ name, class: b.class, ilvl: b.ilvl, implicit: b.implicit || null });
    }
  }
  out.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
  _craftBaseList = out;
  return out;
}
// Grouped prefix/suffix pool for one base at a given item level. Mods sharing a `group`
// (mutually exclusive — one per item) are collapsed into tiers, highest ilvl first.
function craftPool(baseName, itemLevel) {
  if (!CRAFT_DATA) return null;
  const base = CRAFT_DATA.bases[baseName];
  if (!base) return null;
  const ilvl = Math.max(1, Math.min(100, itemLevel | 0 || 100));
  const tagset = new Set(base.tags);
  const archKey = archetypeKey(base.class, base.tags);
  const buckets = { Prefix: new Map(), Suffix: new Map() };
  for (const [key, m] of Object.entries(CRAFT_DATA.mods)) {
    if (m.ilvl > ilvl) continue;
    const w = craftEffWeight(m, tagset, archKey);
    if (w <= 0) continue;
    const bucket = buckets[m.type];
    if (!bucket) continue;
    if (!bucket.has(m.group)) bucket.set(m.group, { group: m.group, tiers: [] });
    bucket.get(m.group).tiers.push({ key, name: m.name || "", ilvl: m.ilvl, weight: w, stats: m.stats });
  }
  const finish = (map) => {
    const groups = [...map.values()];
    for (const g of groups) {
      g.tiers.sort((a, b) => b.ilvl - a.ilvl);          // best (highest-ilvl) tier first
      g.totalWeight = g.tiers.reduce((s, t) => s + t.weight, 0);
      g.label = (g.tiers[0].stats[0] || g.group);        // display by the top tier's stat text
    }
    groups.sort((a, b) => a.label.localeCompare(b.label));
    return groups;
  };
  const prefixes = finish(buckets.Prefix), suffixes = finish(buckets.Suffix);
  const sumW = (gs) => gs.reduce((s, g) => s + g.totalWeight, 0);
  return {
    base: baseName, class: base.class, ilvl, implicit: base.implicit || null,
    prefixes, suffixes,
    // total spawn weight per side — the denominator the Phase 2 engine will use for odds.
    prefixWeight: sumW(prefixes), suffixWeight: sumW(suffixes),
  };
}

// Flat eligible-mod list for a base at an item level — the craft-engine's input.
// Same weight rule as craftPool; type lowercased to match the engine's "prefix"/"suffix".
const craftModList = (baseName, itemLevel) => craftEngine.craftModList(CRAFT_DATA, baseName, itemLevel);

// ── Craft Advisor: map mod TEXT → craft-data group ─────────────────────────────
// Normalize a stat line to a template (roll ranges/numbers → #, drop commas) — same rule as
// gen-craft-weights.js, so it collides across tiers of the same mod onto one template.
const craftNorm = (s) => String(s)
  .replace(/\([^)]*?\d[^)]*?\)/g, "#").replace(/\d+(\.\d+)?/g, "#")
  .replace(/,/g, "").replace(/#+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
const craftStripTag = (l) => String(l).replace(/\s*\((?:implicit|enchant|rune|fractured|crafted|desecrated|scourge|veiled)\)\s*$/i, "").trim();

// Build a template → {group,type} index over the SINGLE-STAT mods eligible on ONE base (the pool
// from craftModList). Pool-scoping + single-stat + carrying type is what avoids the mis-maps a
// global text match makes (e.g. "+X to maximum Life" hitting a suffix unique-mutation, or "Rarity"
// hitting a fishing mod) — only mods that can actually roll on this base are in the index.
function buildCraftGroupIndex(poolMods) {
  const idx = new Map();
  for (const pm of poolMods) {
    const m = CRAFT_DATA.mods[pm.key];
    if (!m || !m.stats || m.stats.length !== 1) continue;   // hybrids handled separately (Phase 2)
    const t = craftNorm(m.stats[0]);
    if (!idx.has(t)) idx.set(t, { group: pm.group, type: pm.type });
  }
  return idx;
}
const mapCraftLine = (line, idx) => idx.get(craftNorm(craftStripTag(line))) || null;

// Desirable-mod aliases (from UPGRADE_SEARCH_STATS / PRESERVE_CONTROL_STATS_BY_SLOT) → the exact
// normalized stat template, resolved to a group via the pool index. Composite aliases expand to
// several concrete aliases at generation time. Unknown aliases → null (skipped as a fill).
const ALIAS_TEMPLATE = {
  life: "+# to maximum life", mana: "+# to maximum mana", energyShield: "+# to maximum energy shield",
  fireRes: "+#% to fire resistance", coldRes: "+#% to cold resistance", lightningRes: "+#% to lightning resistance", chaosRes: "+#% to chaos resistance",
  str: "+# to strength", dex: "+# to dexterity", int: "+# to intelligence", totalAllAttributes: "+# to all attributes",
  rarity: "#% increased rarity of items found", spirit: "+# to spirit", movementSpeed: "#% increased movement speed",
  manaRegen: "#% increased mana regeneration rate", castSpeed: "#% increased cast speed", attackSpeed: "#% increased attack speed",
  manaOnKill: "recover # mana on kill",
  flatFireAttack: "adds # to # fire damage to attacks", flatColdAttack: "adds # to # cold damage to attacks",
  flatLightningAttack: "adds # to # lightning damage to attacks", flatPhysAttack: "adds # to # physical damage to attacks",
  flatChaosAttack: "adds # to # chaos damage to attacks",
  // Caster/minion sceptre sellables (templates match craftNorm of the pool mod text):
  spiritPct: "#% increased spirit", levelAllMinionSkills: "+# to level of all minion skills",
  levelAllSpellSkills: "+# to level of all spell skills", minionDamageIncr: "minions deal #% increased damage",
};
// Composite/pseudo aliases → the concrete single-mod aliases they stand for. Base/quality stats
// (dps/evasion/armour) aren't craftable target mods → not listed (skipped).
const ALIAS_EXPAND = {
  totalElementalRes: ["fireRes", "coldRes", "lightningRes"],
  totalFlatElementalAttack: ["flatFireAttack", "flatColdAttack", "flatLightningAttack"],
  totalFlatAttack: ["flatPhysAttack", "flatFireAttack", "flatColdAttack", "flatLightningAttack"],
};
const aliasCraftGroup = (alias, idx) => { const t = ALIAS_TEMPLATE[alias]; return t ? (idx.get(t) || null) : null; };

// Reverse of UPGRADE_STAT_IDS — a desirable entry that carries a trade `id` maps back to its alias.
const STATID_TO_ALIAS = Object.fromEntries(Object.entries(UPGRADE_STAT_IDS).map(([k, v]) => [v, k]));
// craft-data class → the advisor's slot key (a key in UPGRADE_SEARCH_STATS). Martial weapons share
// the `bow` desirable set; casters have no resale profile yet (best-effort, Phase 2).
const CRAFT_CLASS_SLOT = {
  Ring: "ring", Amulet: "amulet", Belt: "belt", "Body Armour": "chest", Boots: "boots",
  Gloves: "gloves", Helmet: "helmet", Focus: "focus", Quiver: "quiver", Jewel: "jewel", Shield: "shield", Buckler: "buckler",
  Sceptre: "sceptre",
};
// The auto-advisor only has a real resale/desirable profile for BOWS among weapons.
// The old catch-all mapped EVERY martial weapon (and even the caster Sceptre) to "bow",
// so a non-bow weapon was checked against bow mods it can't roll → zero candidates → the
// misleading "already carries the desirable mods" message. Map only actual Bows to the
// bow profile; every other weapon falls through to null → the honest "no profile yet,
// pick target mods manually" path (the manual mode works for any base).
const craftAdviseSlot = (cls) => CRAFT_CLASS_SLOT[cls] || (cls === "Bow" ? "bow" : null);
// advisor slot → a gear-finder slot id (for gearSlotCfg category + gearStatId). ring→ring1 (variants share category).
const ADVISE_TO_GEAR_SLOT = { ring: "ring1", amulet: "amulet", belt: "belt", chest: "chest", boots: "boots", gloves: "gloves", helmet: "helmet", quiver: "quiver", jewel: "jewel", shield: "shield", buckler: "buckler", bow: "bow", focus: "focus", sceptre: "sceptre" };

// Human label for a group: its top-tier stat text with roll ranges shown as #.
function craftGroupLabel(group) {
  for (const m of Object.values(CRAFT_DATA.mods)) if (m.group === group) return m.stats.join(", ").replace(/\([^)]*?\d[^)]*?\)/g, "#").replace(/\b\d+\b/g, "#");
  return group;
}

// Auto-pick 1–3 candidate finished-item targets: keep the pasted item's mapped mods, fill open
// prefix/suffix slots from the slot's curated meta desirables (UPGRADE_SEARCH_STATS), respecting
// the 3/3 caps. Returns [{fills:[{group,type,alias,label}], targets:[group]}] deepest-first.
function generateCraftCandidates(slot, kept, poolMods, idx) {
  const desir = UPGRADE_SEARCH_STATS[slot] || [];
  const poolGroups = new Set(poolMods.map((m) => m.group));
  let freeP = 3 - kept.filter((k) => k.type === "prefix").length;
  let freeS = 3 - kept.filter((k) => k.type === "suffix").length;
  const seen = new Set(kept.map((k) => k.group));
  const fills = [];
  for (const d of desir) {
    const baseAlias = d.key || STATID_TO_ALIAS[d.id];
    if (!baseAlias) continue;
    for (const a of (ALIAS_EXPAND[baseAlias] || [baseAlias])) {
      const g = aliasCraftGroup(a, idx);
      if (!g || !poolGroups.has(g.group) || seen.has(g.group)) continue;
      if (g.type === "prefix" ? freeP <= 0 : freeS <= 0) continue;
      fills.push({ group: g.group, type: g.type, alias: a, label: craftGroupLabel(g.group) });
      seen.add(g.group);
      if (g.type === "prefix") freeP--; else freeS--;
    }
  }
  if (!fills.length) return [];
  // Full fill + shallower alternates (fewer mods = cheaper), deepest first, deduped.
  const sizes = [...new Set([fills.length, Math.min(2, fills.length), 1])].sort((a, b) => b - a);
  return sizes.map((n) => ({ fills: fills.slice(0, n), targets: fills.slice(0, n).map((f) => f.group) }));
}

// Resale search filters for a finished item (kept + fills): top-2 stat ids + a rarity floor.
function buildResaleFilters(gearSlot, kept, fills, idx) {
  const g2a = {}; for (const a in ALIAS_TEMPLATE) { const g = aliasCraftGroup(a, idx); if (g && !g2a[g.group]) g2a[g.group] = a; }
  const items = [...fills.map((f) => f.alias), ...kept.map((k) => g2a[k.group])].filter(Boolean);
  let rarityMin = 0; const filters = [];
  for (const alias of items) {
    if (alias === "rarity") { rarityMin = Math.max(rarityMin, 15); continue; }
    const statId = gearStatId(alias, gearSlot);
    if (statId && !filters.some((f) => f.statId === statId)) filters.push({ statId, min: 1 });
  }
  return { statFilters: filters.slice(0, 2), rarityMin };
}

// Essences that can guarantee a mod on this base's class, at this item level — the
// Estimated reveal-pool size for a desecrated target: mods of that faction on the target's side.
// After you commit to a faction (its bones / a faction-guarantee omen), the reveal draws from that
// faction's eligible mods. poe2db gives no per-base weights, so this faction+side count is an
// ESTIMATE (the engine flags the method estimate:true). 30 is a neutral fallback.
function desecratedPoolN(faction, type) {
  if (!DESECRATED || !Array.isArray(DESECRATED.mods)) return 30;
  const n = DESECRATED.mods.filter((m) => m.faction === faction && m.type === type).length;
  return n || 30;
}

// craft-engine's essence input. Only essences whose forced mod exists in the normal
// pool (some Perfect/essence-exclusive mods aren't in ModItem) and is reachable at ilvl.
// moved into craft-engine.js so the tests/tools build the same essence list the server serves
const craftEssenceOptions = (baseName, itemLevel) => craftEngine.craftEssenceOptions(CRAFT_DATA, baseName, itemLevel);

// Price each route in Divine via the poe.ninja proxy, then rank by real cost (not raw orb count) —
// Chaos/omens are far pricier than Transmute/Alchemy, so this reshuffles the ranking.
//
// There is no orb-label→proxy-name table any more: the planner charges costs under the EXACT
// currency and omen names from the move catalog ("Exalted Orb", "Omen of Dextral Exaltation"),
// which are already the market names, so they price directly. The old table mapped a generic
// "Exaltation omen" to Omen of SINISTRAL Exaltation, which silently priced every dextral and
// homogenising route at the sinistral omen's price. An unpriced currency (a new omen the proxy
// doesn't track yet) lands in priceMissing and the cost is reported as a floor — never invented.
// A currency-name -> divine price lookup for the PLANNER (craft-plan ranks routes with it).
// Returns null for anything the market does not price — and the planner treats null as UNKNOWN,
// not free, sinking that route below every route it can actually cost. This is what stops an
// unbuyable omen from winning the ranking by costing nothing.
const craftPriceOf = (proxy) => (name) => {
  if (!proxy || !name) return null;
  try { const pv = proxyPrice(proxy, name); return pv && pv.div > 0 ? pv.div : null; } catch { return null; }
};

function priceCraftMethods(result, proxy) {
  if (!result || result.impossible || !proxy) return;
  for (const m of result.methods) {
    if (!m.feasible) { m.divineCost = null; continue; }
    let cost = 0; const missing = [];
    for (const [orb, count] of Object.entries(m.expectedOrbs || {})) {
      const name = orb;                       // catalog names ARE proxy names — see the note above
      const pv = name ? proxyPrice(proxy, name) : null;
      if (pv && pv.div > 0) cost += count * pv.div; else missing.push(orb);
    }
    // ALL orbs unpriced → no cost at all (null sorts last below); a 0 would sort as "cheapest".
    m.divineCost = missing.length && !(cost > 0) ? null : Math.round(cost * 100) / 100;
    if (missing.length) m.priceMissing = missing;   // e.g. an omen the proxy doesn't track → cost is a floor
  }
  // rank feasible fully-priced by Divine cost (cheapest first); partial/unpriced last.
  // Impractical routes (<2% per attempt — the engine's flag) always sink below realistic ones,
  // even if their theoretical divine cost looks cheap (cheap chaos × a 0.02% success is a
  // fantasy number, not a plan).
  result.methods.sort((a, b) => {
    const av = a.feasible && a.divineCost != null ? a.divineCost : Infinity;
    const bv = b.feasible && b.divineCost != null ? b.divineCost : Infinity;
    return (a.impractical ? 1 : 0) - (b.impractical ? 1 : 0) || av - bv;
  });
  result.priced = true;
}

// Expected-profit route scoring (recipe layer "Later phases" 2). Labels the Pareto
// corners of a PRICED ranking so the UI can say WHY a route, instead of one opaque sort:
//   cheapest    — lowest expected total to land one (the current default sort)
//   safest      — best one-shot odds (least brick/reroll churn)
//   low_budget  — least spent per attempt (what a miss actually costs you)
//   best_ev     — highest per-attempt expected profit p×value − perAttemptCost; only
//                 when the caller supplies the finished item's market value (from
//                 /api/craft/resale) — we never invent prices.
// perAttemptDivineCost = divineCost × p (expectedOrbs is the ÷p amortized number).
function tagRouteClasses(methods, targetValueDiv) {
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const live = (methods || []).filter((m) => m.feasible && !m.impractical && m.divineCost != null);
  for (const m of live) {
    m.perAttemptDivineCost = round4(m.divineCost * m.successPerAttempt);
    if (targetValueDiv != null) m.expectedProfitDiv = round4(m.successPerAttempt * targetValueDiv - m.perAttemptDivineCost);
  }
  if (!live.length) return;
  const tag = (m, c) => { (m.routeClasses = m.routeClasses || []).push(c); };
  tag(live.reduce((a, b) => (b.divineCost < a.divineCost ? b : a)), "cheapest");
  tag(live.reduce((a, b) => (b.successPerAttempt > a.successPerAttempt ? b : a)), "safest");
  tag(live.reduce((a, b) => (b.perAttemptDivineCost < a.perAttemptDivineCost ? b : a)), "low_budget");
  if (targetValueDiv != null) tag(live.reduce((a, b) => (b.expectedProfitDiv > a.expectedProfitDiv ? b : a)), "best_ev");
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
      // Parse cookies properly (exact value match) — a substring check would accept
      // any token that merely starts with the real one.
      const cookies = String(req.headers.cookie || "").split(";").map((c) => c.trim());
      if (qsKey !== GATE && !cookies.includes("poe_auth=" + GATE)) {
        send(res, 403, "Forbidden — open this URL once with ?key=YOUR_TOKEN");
        return;
      }
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/trade-status") {
      send(res, 200, JSON.stringify(tradeStatus()), "application/json; charset=utf-8");
      return;
    }

    // POESESSID: GET whether one is set + last-known liveness; POST to swap it at runtime
    // (persisted, no restart — see setSessionId). Same trust model as /api/vpn: the cookie
    // is full account access, so this is reachable only on your trusted LAN/Tailscale.
    if (url.pathname === "/api/session") {
      const J = "application/json; charset=utf-8";
      if (req.method === "POST") {
        const input = await readJson(req);
        const v = String(input.poesessid || "").trim().replace(/^POESESSID=/i, "");
        if (v.length < 10) { send(res, 400, JSON.stringify({ error: "paste a POESESSID value" }), J); return; }
        setSessionId(v);
        send(res, 200, JSON.stringify({ ok: true, set: true }), J);
        return;
      }
      send(res, 200, JSON.stringify({ set: !!sessionId, expired: sessionExpiredFlag, verified: sessionVerifiedFlag }), J);
      return;
    }

    // VPN exit-country: GET current, POST to switch (see gluetun helper above).
    if (url.pathname === "/api/vpn") {
      const J = "application/json; charset=utf-8";
      if (req.method === "POST") {
        const input = await readJson(req);
        const country = String(input.country || "").trim();
        if (!VPN_COUNTRIES.includes(country)) { send(res, 400, JSON.stringify({ error: "unknown country" }), J); return; }
        const upd = await gluetun("/v1/vpn/settings", "PUT", { provider: { server_selection: { countries: [country] } } });
        if (!upd.ok) { send(res, 502, JSON.stringify({ error: "gluetun: " + (upd.json && upd.json.error || upd.status) }), J); return; }
        send(res, 200, JSON.stringify({ ok: true, country }), J);
        return;
      }
      const ip = await gluetun("/v1/publicip/ip").catch((e) => ({ ok: false, json: String(e && e.message || e) }));
      send(res, 200, JSON.stringify({
        ok: !!ip.ok,
        country: (ip.json && ip.json.country) || null,
        city: (ip.json && ip.json.city) || null,
        ip: (ip.json && ip.json.public_ip) || null,
        countries: VPN_COUNTRIES,
      }), J);
      return;
    }

    if (url.pathname === "/api/waystone/market-weights") {
      send(res, 200, JSON.stringify({ weights: readWaystoneWeights(), tradeStatus: tradeStatus() }), "application/json; charset=utf-8");
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
      // in the background only when a twice-a-day point is due. Forced refreshes share
      // one in-flight sample (same guard as maybeSampleEconomy) so two concurrent ↻
      // can't append a duplicate history point.
      if (force) {
        if (!economySampleInFlight) economySampleInFlight = sampleEconomy(league).catch(() => null).finally(() => { economySampleInFlight = null; });
        await economySampleInFlight;
      } else maybeSampleEconomy(league);
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
      const league = sanitizeLeague(input.league || "Runes of Aldur");
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

    if (url.pathname === "/api/rune-prices" && req.method === "POST") {
      const input = await readJson(req);
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const body = JSON.stringify(await fetchRunePrices(input.text || "", league, input.forceFresh === true));
      send(res, 200, body, "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/trade-price" && req.method === "POST") {
      const input = await readJson(req);
      const league = sanitizeLeague(input.league || "Runes of Aldur");
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

    // ── Gear Upgrade Finder (PoB-driven) ──────────────────────────────────
    if (url.pathname === "/api/gear/builds") {
      send(res, 200, JSON.stringify({ dir: POB_BUILDS_DIR, builds: listPobBuilds(), headless: await pob.ready(), poesessid: !!sessionId }), "application/json; charset=utf-8");
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
      try { parsed = parsePobBuild(xml, input.setId); } catch (e) { send(res, 400, JSON.stringify({ error: "Not a Path of Building build: " + e.message }), "application/json; charset=utf-8"); return; }
      // Make the XML's active set match the parsed set, so headless PoB (and every downstream
      // scoring call that reuses this xml) computes against the same gear the UI shows.
      if (parsed.activeSet) xml = setActiveItemSet(xml, parsed.activeSet);
      const headless = { available: await pob.ready() };
      if (headless.available) { try { headless.stats = await pob.load(xml); } catch (e) { headless.error = String(e.message); } }
      // STALE-AGENT DETECTOR: every PoE2 character has a Spirit pool, so the bridge always
      // returns a numeric `Spirit` IF its STAT_KEYS include it. If it's missing, the resident
      // PoB (esp. a split-host `pob-agent` that wasn't restarted after a pob-bridge.lua change)
      // predates the spirit keys → spirit floor/guard silently no-op. Flag it LOUDLY instead of
      // shipping no-spirit recommendations. (This cost ~5 debugging passes once; never again.)
      if (headless.stats && headless.stats.Spirit === undefined) headless.staleAgent = true;
      send(res, 200, JSON.stringify({ slots: parsed.slots, build: parsed.build, sets: parsed.sets, activeSet: parsed.activeSet, headless, xml, hasRakiata: buildHasRakiata(xml) }), "application/json; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/gear/weights" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!pob.available()) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      const slotId = String(input.slot || "");
      const slot = gearSlotCfg(slotId);
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(slotId));
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      try {
        const w = await computeGearWeights(prepBuildXml(input), pobSlot, slot.baseId || slotId, String((input.current && input.current.raw) || ""));
        const query = w.weights.length ? buildWeightedGearQuery(slot, w.weights, league, input.maxPriceDiv, w.preserve, { minPriceDiv: input.minPriceDiv, equip: w.equip, weaponFloor: true }) : null;
        send(res, 200, JSON.stringify({ available: true, slot: slotId, metric: w.metric, base: w.base, weights: w.weights, equip: w.equip, preserve: w.preserve, league, query }), "application/json; charset=utf-8");
      } catch (e) { send(res, 200, JSON.stringify({ available: true, error: String(e.message) }), "application/json; charset=utf-8"); }
      return;
    }

    // On-demand basic (non-weighted) shareable search — ONE anonymous Trade2 call.
    // Mins come from your CURRENT item's rolls (`mods:[{statId,min}]`) so it only
    // surfaces equal-or-better, not "has the stat at all". Match a subset (count)
    // so requiring every top stat at once doesn't return zero.
    if (url.pathname === "/api/gear/basic-link" && req.method === "POST") {
      const input = await readJson(req, 1 * 1024 * 1024);
      const slot = gearSlotCfg(String(input.slot || ""));
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
        await pob.load(prepBuildXml(input));
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
        const base = await pob.load(prepBuildXml(input));
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

    // Passive-tree move planner: which points to MOVE for DPS. Pure PoB (no Trade2) — asks
    // the headless engine to value every reachable unallocated notable (DPS/EHP gained by
    // pathing to it) and every allocated notable (DPS/EHP lost by removing it). Lets you find
    // "respec these dead points → these high-value notables → net +X DPS". Jewel sockets are
    // excluded by the engine (they're tree Sockets, not Notables). Slow (~20-40s): one PoB
    // calc per candidate, so it's an on-demand analysis, not a hot path.
    if (url.pathname === "/api/gear/tree-moves" && req.method === "POST") {
      const J = "application/json; charset=utf-8";
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), J); return; }
      const buildXml = prepBuildXml(input);
      const maxDepth = Math.min(8, Math.max(1, Number(input.maxDepth) || 4));
      try {
        await pob.load(buildXml);
        const d = await pob.tree(maxDepth);
        const add = (d.add || []).filter((x) => x.dDPS > 0).sort((a, b) => b.dDPS - a.dDPS);
        const remove = (d.remove || []).sort((a, b) => a.dDPS - b.dDPS);   // weakest first = respec-out candidates
        send(res, 200, JSON.stringify({ available: true, maxDepth, baseDps: d.baseDps, baseEhp: d.baseEhp, add, remove }), J);
      } catch (e) { send(res, 200, JSON.stringify({ error: String(e.message) }), J); }
      return;
    }

    // Set Optimizer (multi-slot): pick 2-3 slots, fetch a pool each, then try EVERY
    // in-budget combination (incl. keep-current per slot) — score each set with one real
    // calcMulti and keep only those that hold ALL breakpoints (res/spirit/rarity, each an
    // editable floor). Finds "break a breakpoint on slot A, recover it on slot B, net DPS up"
    // that single-slot ranking can't. Cheap on trade (one search/slot); the combinatorics are
    // local PoB calcs. Domination-pruned pools keep it exhaustive for 2-3 slots.
    if (url.pathname === "/api/gear/optimize-set" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8"); return; }
      const buildXml = prepBuildXml(input);
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const maxPriceDiv = Number(input.maxPriceDiv) || 0;
      const minPriceDiv = Number(input.minPriceDiv) || 0;   // optional listing-price floor (mirrors realrank's minDiv)
      // Divine price range shared by every non-weighted query below (same shape realrank uses).
      const priceRange = () => { const price = { option: "divine" }; if (minPriceDiv > 0) price.min = minPriceDiv; if (maxPriceDiv > 0) price.max = maxPriceDiv; return { filters: { price } }; };
      const slotIds = (Array.isArray(input.slots) ? input.slots : []).map(String).filter(Boolean).slice(0, 5);
      if (slotIds.length < 2) { send(res, 400, JSON.stringify({ error: "Pick 2-5 slots" }), "application/json; charset=utf-8"); return; }
      let parsed; try { parsed = parsePobBuild(buildXml); } catch (e) { send(res, 400, JSON.stringify({ error: "Not a PoB build: " + e.message }), "application/json; charset=utf-8"); return; }
      // Per-slot candidates fetched (chunked by 10/fetch), then domination-pruned before the cartesian
      // product. Deep (30) for 2-3 slots; modest (12) for 4-5 where the combo count already balloons
      // (pool^slots) — the prune only drops STRICTLY-dominated items so most of a deep pool survives.
      // `deep` (opt-in, triggered by the "search deeper" button after a no-legal-set result) ~doubles the
      // per-slot pool and the verify cap — more /fetch calls (10/id-chunk) + PoB calcs, so it hits trade harder.
      const deep = !!input.deep;
      // 2-3 slots: deepen the pool (30→60) — more /fetch + PoB calcs. 4-5 slots: keep the pool (cartesian is
      // pool^slots — 24^5≈8M arrays would blow memory) and only lift the verify cap.
      const POOL = slotIds.length <= 3 ? (deep ? 60 : 30) : 12, COMBO_CAP = deep ? 900 : 450;   // COMBO_CAP = max combos PoB verifies
      try {
        let fetchErr = null;
        const pools = [];
        for (const slotId of slotIds) {
          const slot = gearSlotCfg(slotId);
          if (!slot) continue;
          const pobSlot = toolSlotToPob(slotId);
          const baseSlot = slot.baseId || slotId;
          const currentRaw = (parsed.slots[slotId] && parsed.slots[slotId].raw) || "";
          const w = await computeGearWeights(buildXml, pobSlot, baseSlot, currentRaw);   // loads the build
          const base = await pob.calc(pobSlot, "");
          const baseDps = dpsOfOut(base), baseEhp = ehpOfOut(base);
          const topW = Math.max(1, ...((w.weights || []).map((x) => Number(x && x.weight) || 0)));   // skip trivial-weight floors (< 20% of top) — matches realrank/buildWeightedGearQuery
          const mods = (w.weights || []).filter((x) => (x.cur || 0) > 0 && (Number(x.weight) || 0) >= topW * 0.2).slice(0, 3).map((x) => ({ statId: x.statId, min: Math.max(1, Math.floor((x.cur || 1) * 0.7)) }));
          const rarityMin = Number(input.rarityMin) || 0;   // require rarity items in the pool (count-group, injected per query below)
          // NOTE: we deliberately do NOT add per-slot resistance preserve floors here. They were
          // added (2026-06-29) to stop a swap dropping a breakpoint, but they DEFEAT the optimizer's
          // whole purpose — requiring EACH replacement to keep its current res excludes the very
          // rebalance items it should find (a great chest with 0 chaos res can't enter the pool even
          // when another slot would recover the chaos), so single-slot finds upgrades the set can't.
          // The COMBINED breakpoint check (checkBreakpoints on the real calcMulti) is the correct,
          // sufficient guard — it judges total res across the whole set, allowing break-here/recover-
          // there. Per-slot pools now match single-slot's breadth (defence-sorted, ungated).
          // Pool sort: with a POESESSID + weights, rank by BUILD VALUE (weighted statgroup) —
          // same as single-slot realrank. The old price-desc sort fetched only the 10 PRICIEST
          // in-budget items, burying well-priced upgrades (a 235-div chest never made the top 10
          // under a wall of 400-500-div listings — the user's missed upgrade). Falls back to
          // price-desc when logged-out or if the weighted query 400s (dead session).
          const wts = (w.weights || []).filter((x) => x && /^(explicit\.stat_\d+|pseudo\.[a-z0-9_]+)$/.test(x.statId) && Number(x.weight) > 0);
          let weighted = !!sessionId && wts.length > 0 && !/^jewel\d+$/.test(slotId);
          // Defence slots (chest/helmet/boots/shield, ev/ar/es ≥500, not gloves): a DEDICATED query —
          // category + budget + preserve, sorted by the dominant DEFENCE (ev/ar/es desc), with NO
          // per-stat gates (the weighted top-3 floors at 70% EXCLUDE a single-axis EHP item, e.g. a
          // pure-evasion chest with 0 chaos res / 0 ES) and no equipment floor. Same fix as realrank.
          let defK = null, defV = 0;
          if (w.equip) for (const k of ["ev", "ar", "es"]) { const v = Number(w.equip[k]) || 0; if (v > defV) { defV = v; defK = k; } }
          const defenceSlot = gearDefenceSortOk && !!defK && defV >= 500 && baseSlot !== "gloves";
          if (defenceSlot) weighted = false;
          const buildQ = (useW) => {
            const q = useW
              ? buildWeightedGearQuery(slot, wts, league, maxPriceDiv, w.preserve, { minPriceDiv, equip: w.equip })
              : { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: gearStatGroup(gearStatFilters(mods)) }, sort: { price: "desc" } };
            if (!useW) {
              if (maxPriceDiv > 0 || minPriceDiv > 0) q.query.filters.trade_filters = priceRange();
              const pf = gearStatFilters(w.preserve, 4);
              if (pf.length) { q.query.stats = q.query.stats || []; let andG = q.query.stats.find((g) => g && g.type === "and"); if (!andG) { andG = { type: "and", filters: [] }; q.query.stats.push(andG); } const have = new Set(andG.filters.map((f) => f.id)); for (const f of pf) if (!have.has(f.id)) andG.filters.push(f); }
            }
            injectRarityGroup(q, baseSlot, rarityMin);
            return q;
          };
          const buildDefenceQ = () => {
            const q = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: [] }, sort: { [defK]: "desc" } };
            if (maxPriceDiv > 0 || minPriceDiv > 0) q.query.filters.trade_filters = priceRange();
            const pf = gearStatFilters(w.preserve, 4);
            if (pf.length) q.query.stats.push({ type: "and", filters: pf });
            injectRarityGroup(q, baseSlot, rarityMin);
            return q;
          };
          // Jewel sockets all label as "jewel" in the UI, so carry the current jewel's name to disambiguate which socket a "keep current" row means.
          const keepName = /^jewel\d+$/.test(slotId) && parsed.slots[slotId] && parsed.slots[slotId].name ? parsed.slots[slotId].name : "(keep current)";
          const cands = [{ keep: true, pobSlot, raw: currentRaw, name: keepName, base: "", account: "", priceDiv: 0, priceEx: 0, dDPS: 0, dEHP: 0, contrib: itemBreakpointContrib(parseItemStats(currentRaw, baseSlot)) }];
          let q = defenceSlot ? buildDefenceQ() : buildQ(weighted);
          let search, usedLeague;
          try { ({ search, league: usedLeague } = await gearTradeSearch(q, league)); }
          catch (e) {
            if (defenceSlot && /HTTP 400/.test(String(e && e.message))) {
              gearDefenceSortOk = false; q = buildQ(false);
              try { ({ search, league: usedLeague } = await gearTradeSearch(q, league)); }
              catch (e2) { fetchErr = e2; pools.push({ slotId, pobSlot, slotName: slot.label || slotId, candidates: dominationPrune(cands) }); break; }
            } else if (weighted && /HTTP 400/.test(String(e && e.message))) {
              weighted = false; sessionExpiredFlag = true;
              try { ({ search, league: usedLeague } = await gearTradeSearch(buildQ(false), league)); }
              catch (e2) { fetchErr = e2; pools.push({ slotId, pobSlot, slotName: slot.label || slotId, candidates: dominationPrune(cands) }); break; }
            } else { fetchErr = e; pools.push({ slotId, pobSlot, slotName: slot.label || slotId, candidates: dominationPrune(cands) }); break; }
          }
          const ids = (search.result || []).slice(0, POOL);
          if (ids.length) {
            const rates = await getExchangeRates(usedLeague || league).catch(() => ({}));
            const anointLines = baseSlot === "amulet" ? extractAnoint(currentRaw) : [];
            const runeFill = extractRuneFill(currentRaw);   // scale each candidate's sockets to YOUR rune
            const seen = new Set(ids);
            // Fetch (chunked by 10) + PoB-score a list of listing ids into `cands`. Shared by the main
            // pool and the deflection / rarity sub-pools below.
            const scoreInto = async (idList, searchId) => {
              for (let i = 0; i < idList.length; i += 10) {
                const fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + idList.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(searchId));
                for (const e of (fetched && fetched.result) || []) {
                  const txt = pobItemFromTradeEntry(e, anointLines, runeFill); if (!txt) continue;
                  let st; try { st = await pob.calc(pobSlot, txt); } catch { continue; }
                  const price = listingPriceFromEntry(e, rates) || {};
                  cands.push({ pobSlot, raw: txt, name: [(e.item && e.item.name), (e.item && e.item.typeLine)].filter(Boolean).join(" ").trim(), base: (e.item && (e.item.typeLine || e.item.baseType)) || "", account: (e.listing && e.listing.account && e.listing.account.name) || "", mods: linkModsFromEntry(e, w.weights), priceDiv: price.divine || 0, priceEx: price.exalted || 0, dDPS: dpsOfOut(st) - baseDps, dEHP: ehpOfOut(st) - baseEhp, contrib: itemBreakpointContrib(parseItemStats(txt, baseSlot)) });
                }
              }
            };
            try { await scoreInto(ids, search.id); } catch (e) { fetchErr = e; }   // main pool; a rate-limit here stops the whole scan
            // Deflection-conversion pool (defence slots): high-deflection items the evasion sort buries.
            if (!fetchErr && defenceSlot) {
              try {
                const dq = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: [deflectConvGroup()] }, sort: { [defK]: "desc" } };
                if (maxPriceDiv > 0 || minPriceDiv > 0) dq.query.filters.trade_filters = priceRange();
                const dRes = await gearTradeSearch(dq, usedLeague || league);
                const dFresh = ((dRes.search && dRes.search.result) || []).slice(0, 10).filter((id) => !seen.has(id));
                dFresh.forEach((id) => seen.add(id));
                await scoreInto(dFresh, dRes.search.id);
              } catch { /* sub-pool is a bonus; never break the slot */ }
            }
            // Rarity sub-pool: when the user TARGETS rarity ABOVE the build's current (a "push 73→100"
            // probe), merge HIGH-rarity items for rarity-capable slots. Deliberately NOT a per-item hard
            // floor on the main pool — forcing every slot ≥N wrongly drops valid mixes where ONE slot
            // carries the rarity; the total-rarity breakpoint keeps whatever combo SUMS to the target.
            const curRarity = Math.round(((Number(base.EffectiveLootRarityMod) || 1) - 1) * 100);
            const rarityTarget = Number((input.breakpoints || {}).rarityPct) || 0;
            if (!fetchErr && UPGRADE_STAT_IDS.rarity && slotHasRarity(baseSlot) && rarityTarget > curRarity) {
              try {
                const rid = UPGRADE_STAT_IDS.rarity;
                const mk = (wtd) => {
                  const q = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: wtd ? [{ type: "weight", filters: [{ id: rid, value: { weight: 1 } }], value: {} }, { type: "and", filters: [{ id: rid, value: { min: 1 } }] }] : [{ type: "and", filters: [{ id: rid, value: { min: 15 } }] }] }, sort: wtd ? { "statgroup.0": "desc" } : { price: "desc" } };
                  if (maxPriceDiv > 0 || minPriceDiv > 0) q.query.filters.trade_filters = priceRange();
                  return q;
                };
                let rRes;
                try { rRes = await gearTradeSearch(mk(true), usedLeague || league); }   // rarity-sorted (needs POESESSID)
                catch (e) { if (/HTTP 400/.test(String(e && e.message))) rRes = await gearTradeSearch(mk(false), usedLeague || league); else throw e; }   // logged-out: rarity-floor + price
                const rFresh = ((rRes.search && rRes.search.result) || []).slice(0, 10).filter((id) => !seen.has(id));
                rFresh.forEach((id) => seen.add(id));
                await scoreInto(rFresh, rRes.search.id);
              } catch { /* rarity sub-pool is a bonus; never break the slot */ }
            }
          }
          pools.push({ slotId, pobSlot, slotName: slot.label || slotId, candidates: dominationPrune(cands) });
          if (fetchErr) break;
        }
        if (pools.length < 2) { if (fetchErr) throw fetchErr; send(res, 200, JSON.stringify({ available: true, error: "Couldn't build pools for 2+ slots" }), "application/json; charset=utf-8"); return; }
        // Base = your full equipped build (empty itemText = keep the slot's current item).
        await pob.load(buildXml);
        const base = await pob.calc(pools[0].pobSlot, "");
        const baseDps = dpsOfOut(base), baseEhp = ehpOfOut(base);
        const floors = optimizeBreakpoints(base, input.breakpoints || {});
        // Cartesian product → in-budget combos that change ≥1 slot.
        let combos = [[]];
        for (const p of pools) { const next = []; for (const c of combos) for (const cand of p.candidates) next.push(c.concat([cand])); combos = next; }
        combos = combos.filter((combo) => combo.some((c) => !c.keep) && combo.reduce((s, c) => s + (c.priceDiv || 0), 0) <= (maxPriceDiv > 0 ? maxPriceDiv : Infinity));
        const inBudget = combos.length;
        // ADDITIVE PRE-SCREEN (so 4-5 slots stay feasible): breakpoint contributions sum
        // across gear, so estimate each combo's combined breakpoints cheaply (base + Σ(new −
        // current contribution per changed slot) and drop ones that clearly fail — BEFORE
        // spending a PoB calc. Spirit/Rarity are uncapped → accurate, screen at floor−10.
        // Resists are CAPPED (base hides overcap) → screen LENIENTLY (floor−50) so an
        // overcapped-but-dropping set is never wrongly cut; calcMulti makes the precise call.
        const baseBp = floors._cur;
        const keepContrib = pools.map((p) => ((p.candidates.find((c) => c.keep) || {}).contrib) || {});
        const RES = ["fireRes", "coldRes", "lightRes", "chaosRes"];
        const additiveLegal = (combo) => {
          const a = Object.assign({}, baseBp);
          for (let i = 0; i < combo.length; i++) { const kc = keepContrib[i], cc = combo[i].contrib || {}; for (const k in a) a[k] += (cc[k] || 0) - (kc[k] || 0); }
          if (a.spiritFree < floors.spiritFree - 10 || a.rarityPct < floors.rarityPct - 10) return false;
          for (const r of RES) if (a[r] < floors[r] - 50) return false;
          return true;
        };
        combos = combos.filter(additiveLegal);
        const screened = combos.length;
        // Rank by APPROX combined DPS (sum of single-swap deltas) only to choose which to
        // verify when over the cap; ≤cap means EVERY screened combo is really scored.
        combos.sort((a, b) => b.reduce((s, c) => s + c.dDPS, 0) - a.reduce((s, c) => s + c.dDPS, 0));
        const verifyN = Math.min(combos.length, COMBO_CAP);
        const legal = [];
        let evaluated = 0;
        for (let i = 0; i < verifyN; i++) {
          const changed = combos[i].filter((c) => !c.keep);
          let combined; try { combined = await pob.calcMulti(changed.map((c) => ({ slot: c.pobSlot, itemText: c.raw }))); } catch { continue; }
          evaluated++;
          const bp = checkBreakpoints(combined, floors);
          if (!bp.ok) continue;
          legal.push({ combo: combos[i], dDPS: Math.round(dpsOfOut(combined) - baseDps), dEHP: Math.round(ehpOfOut(combined) - baseEhp), priceDiv: Math.round(combos[i].reduce((s, c) => s + (c.priceDiv || 0), 0) * 100) / 100, have: bp.have });
        }
        // Only sets that actually IMPROVE the build (DPS or EHP up) are results — a set that
        // merely holds the breakpoints but is +0 DPS / −EHP is a downgrade, not an upgrade.
        const upgrades = legal.filter((L) => L.dDPS > 0 || L.dEHP > 0).sort((a, b) => b.dDPS - a.dDPS);
        const results = upgrades.slice(0, 5).map((L) => ({
          dDPS: L.dDPS, dEHP: L.dEHP, priceDiv: L.priceDiv, have: L.have,
          picks: L.combo.map((c, i) => ({ slot: pools[i].slotId, keep: !!c.keep, name: c.name, base: c.base || "", account: c.account || "", mods: c.mods || [], priceDiv: c.priceDiv || 0, dDPS: Math.round(c.dDPS), contrib: c.contrib })),
        }));
        send(res, 200, JSON.stringify({ available: true, baseDps: Math.round(baseDps), baseEhp: Math.round(baseEhp), floors, cur: floors._cur, slots: pools.map((p) => ({ slotId: p.slotId, slotName: p.slotName, pool: p.candidates.length })), inBudget, screened, combos: inBudget, evaluated, capped: screened > COMBO_CAP, legal: legal.length, upgrades: upgrades.length, results, partial: !!fetchErr }), "application/json; charset=utf-8");
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8"); return; }
        send(res, 200, JSON.stringify({ available: true, error: String(err && err.message) }), "application/json; charset=utf-8");
      }
      return;
    }

    // Rank by REAL DPS: fetch a batch of in-budget candidates (one stat-min search
    // + fetch), score each through headless PoB, sort by actual ΔDPS. The accurate
    // answer the heuristic weighted search can't give.
    if (url.pathname === "/api/gear/realrank" && req.method === "POST") {
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!(await pob.ready())) { send(res, 200, JSON.stringify({ available: false }), "application/json; charset=utf-8"); return; }
      const slot = gearSlotCfg(String(input.slot || ""));
      if (!slot) { send(res, 400, JSON.stringify({ error: "Unknown slot" }), "application/json; charset=utf-8"); return; }
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true, tradeLimitedUntil: tradeStatus().tradeLimitedUntil }), "application/json; charset=utf-8"); return; }
      const pobSlot = String(input.pobSlot || toolSlotToPob(String(input.slot || "")));
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const mods = gearStatFilters(input.mods);
      // Rarity floor (user's "Item rarity ≥ N%"): injected as a count-group into the final
      // query (see injectRarityGroup) so it REQUIRES rarity from ANY source (explicit OR
      // implicit/fractured/rune) — the old explicit-only preserve gate missed Gold Amulet's
      // implicit rarity → 0 results. Only for slots that can roll it.
      const raritySlot = slot.baseId || String(input.slot || "");
      const rarityMin = Number(input.rarityMin) || 0;
      // With a POESESSID session we can sort the search by BUILD VALUE (weighted statgroup)
      // and score the genuinely-best candidates. Logged-out that sort 400s, so fall back to
      // a stat-floor + price-spread. Weights come from the client's /api/gear/weights result.
      const weights = (Array.isArray(input.weights) ? input.weights : []).filter((w) => w && /^(explicit\.stat_\d+|pseudo\.[a-z0-9_]+)$/.test(w.statId) && Number(w.weight) > 0);
      // Jewels skip the weighted (statgroup) sort: it's anchored by the defence/preserve
      // floors that hold a candidate's core value, but jewels have NEITHER, so a pure
      // weighted-sum ranks attack-speed-heavy / low-crit jewels top — which PoB scores as
      // downgrades vs a strong-crit current jewel. The price-desc + 70%-current-roll floor
      // path (same as the optimizer) surfaces the real upgrades instead.
      const isJewel = /^jewel\d+$/.test(String(input.slot || ""));
      let weighted = !!sessionId && weights.length > 0 && !isJewel;
      // Sort DESC by default: without a POESESSID value-sort, the search only sees the
      // first 100 results, and the CHEAPEST 100 of a slot are always junk far below
      // decent gear (→ "no upgrade found"). The priciest 100 are where real upgrades
      // live. (Verified: a 224k-DPS bow's only ranked upgrades are 1000+ div.) A budget
      // cap (maxPriceDiv) then makes this "best item I can afford". asc only on request.
      const sortDir = input.sort === "asc" ? "asc" : "desc";
      const maxDiv = Number(input.maxPriceDiv) || 0, minDiv = Number(input.minPriceDiv) || 0;
      // Build the search query for the weighted (value-sort) OR non-weighted (price-sort)
      // path. Same equip/preserve/price augmentation either way, so we can rebuild it if
      // the weighted query 400s (an expired/missing POESESSID is treated as logged-out →
      // "too complex"/"log in") and fall back to non-weighted.
      const buildQ = (useWeighted) => {
        const q = useWeighted
          ? buildWeightedGearQuery(slot, weights, league, maxDiv, input.preserve, { minPriceDiv: minDiv, equip: input.equip })
          : { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: gearStatGroup(mods) }, sort: { price: sortDir } };
        if (!useWeighted && (maxDiv > 0 || minDiv > 0)) {
          const price = { option: "divine" };
          if (minDiv > 0) price.min = minDiv;
          if (maxDiv > 0) price.max = maxDiv;
          q.query.filters.trade_filters = { filters: { price } };
        }
        // Equipment filter: the DOMINANT total defence/offence, only when SUBSTANTIAL (≥500)
        // — the chest/armour case where a saturated base stat (evasion ~2800) wrecks the
        // marginal weighting. Minor-defence slots (boots ~300) skip it (and avoid the
        // complexity cap). Keeps a replacement from dropping the item's core value.
        if (input.equip && typeof input.equip === "object") {
          let bestK = null, bestV = 0;
          for (const k of ["ev", "ar", "es", "dps"]) { const v = Number(input.equip[k]) || 0; if (v > bestV) { bestV = v; bestK = k; } }
          if (bestK && bestV >= 500) { q.query.filters = q.query.filters || {}; q.query.filters.equipment_filters = { filters: { [bestK]: { min: Math.floor(bestV * 0.7) } } }; }
        }
        // Preserve floors (e.g. boots movement speed): ALWAYS required — the metric can't
        // see them, but a replacement without them is a downgrade.
        const pf = gearStatFilters(input.preserve, 4);
        if (pf.length) {
          q.query.stats = q.query.stats || [];
          let andG = q.query.stats.find((g) => g && g.type === "and");
          if (!andG) { andG = { type: "and", filters: [] }; q.query.stats.push(andG); }
          const have = new Set(andG.filters.map((f) => f.id));
          for (const f of pf) if (!have.has(f.id)) andG.filters.push(f);
        }
        injectRarityGroup(q, raritySlot, rarityMin);   // require rarity from any source (count group)
        return q;
      };
      // Defensive slots (chest/helmet/boots/shield — dominant ev/ar/es ≥500, NOT gloves which are
      // DPS-ranked) are EHP-driven, and the build-weighted SUM sort BURIES a defence-strong item
      // that lacks your top-weighted res stat — a pure-evasion chest with 0 chaos res ranks low in
      // the sum though its real EHP is the highest (the +556 EHP Blood Suit the user found by hand,
      // missed because it scored 0 on chaos res ×20 + ES ×7). Sort these by the dominant DEFENCE
      // instead (a plain stat-floored query, no weight group → works logged-out too) so the genuine
      // EHP upgrades reach the fetched+scored pool. The trade2 defence sort key isn't documented, so
      // fall back to the original (price) sort on a 400 — zero regression if the key turns out wrong.
      const bSlot = slot.baseId || String(input.slot || "");
      let defK = null, defV = 0;
      if (input.equip && typeof input.equip === "object") for (const k of ["ev", "ar", "es"]) { const v = Number(input.equip[k]) || 0; if (v > defV) { defV = v; defK = k; } }
      const defenceSlot = gearDefenceSortOk && !!defK && defV >= 500 && bSlot !== "gloves";
      // Defence slots get a DEDICATED query: category + budget + preserve, sorted by the dominant
      // defence (ev/ar/es desc). Deliberately NO per-stat gates and NO equipment floor — the weighted
      // path floors your top-4 stats at 70% of current, which EXCLUDES a single-axis EHP upgrade (the
      // +556 EHP pure-evasion chest with 0 chaos res + 0 ES failed the chaos/ES gates and never reached
      // the ranker). With no gates, the defence sort + deep PoB scoring (top 100) finds the real winner.
      const buildDefenceQ = () => {
        const q = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: [] }, sort: { [defK]: "desc" } };
        if (maxDiv > 0 || minDiv > 0) { const price = { option: "divine" }; if (minDiv > 0) price.min = minDiv; if (maxDiv > 0) price.max = maxDiv; q.query.filters.trade_filters = { filters: { price } }; }
        const pf = gearStatFilters(input.preserve, 4);
        if (pf.length) q.query.stats.push({ type: "and", filters: pf });
        return q;
      };
      if (defenceSlot) weighted = false;   // defence sort replaces the weighted sum for these slots
      let usedDefenceSort = defenceSlot;
      let q = defenceSlot ? buildDefenceQ() : buildQ(weighted);
      let sessionExpired = false;
      try {
        let search, usedLeague;
        try {
          ({ search, league: usedLeague } = await gearTradeSearch(q, league));
        } catch (e) {
          // (a) Defence-sorted query 400s → sort key unsupported; self-disable for the process and
          // fall back to the full weighted/price query. (b) Weighted (statgroup) query 400s when
          // POESESSID is missing/EXPIRED (GGG treats us as logged-out → "too complex"/"log in"); flag
          // it so the UI prompts a refresh + drop to price.
          if (defenceSlot && /HTTP 400/.test(String(e && e.message))) { gearDefenceSortOk = false; usedDefenceSort = false; q = buildQ(false); ({ search, league: usedLeague } = await gearTradeSearch(q, league)); }
          else if (weighted && /HTTP 400/.test(String(e && e.message))) { sessionExpired = true; sessionExpiredFlag = true; weighted = false; q = buildQ(false); ({ search, league: usedLeague } = await gearTradeSearch(q, league)); }
          else throw e;
        }
        // Weighted query went through (no 400) → the cookie is confirmed live this session.
        if (weighted) { sessionVerifiedFlag = true; sessionExpiredFlag = false; }
        // Defence/jewel slots use a NON-weighted search (defence sort), which works logged-out too,
        // so it can't prove the cookie → the 🔑 pill would never go green for someone who only
        // searches armour. Fire ONE lightweight weighted query to confirm the session honestly
        // (200 = cookie valid → green, 400 = expired → red). Once-per-process: gated on
        // !sessionVerifiedFlag, so later searches add no extra call. Non-fatal.
        // Also gated on !sessionExpiredFlag: a 400 only sets the expired flag, and without
        // this gate the probe refired (one wasted live call) on every search until a new
        // cookie was pasted (setSessionId clears the flag, re-arming the probe).
        if (!weighted && sessionId && !sessionVerifiedFlag && !sessionExpiredFlag && weights.length) {
          try {
            await gearTradeSearch(buildWeightedGearQuery(slot, weights, league, maxDiv, input.preserve), league);
            sessionVerifiedFlag = true; sessionExpiredFlag = false;
          } catch (e) { if (/HTTP 400/.test(String(e && e.message))) { sessionExpiredFlag = true; } }
        }
        const all = search.result || [];
        if (!all.length) { send(res, 200, JSON.stringify({ available: true, candidates: [], total: 0 }), "application/json; charset=utf-8"); return; }
        // Score a DEEPER pool through PoB and return the real winners — don't trust the
        // trade sort (linear weighted sum) to pre-pick the best, since real DPS is
        // multiplicative. Weighted search is best-first so take the top SCORE_CAP; the
        // price fallback samples a spread. Capped at SCORE_CAP to bound fetch calls
        // (≤10 ids/call, shared-IP rate limit) and PoB time; bail to partial on a limit.
        // Default 100 (the search's full result page) for a deliberate single-slot rank — score the
        // WHOLE returned page in PoB so a real upgrade the heuristic sort ranks low (e.g. a deflection
        // chest that's mid-pack on raw evasion but top on real EHP) still gets scored. 100 ids = 10
        // fetch calls (~30s through the 3s-spaced queue, on the VM's own VPN IP — fine for a user
        // action). The all-slots SCAN passes scoreCap:10 (1 fetch/slot) to stay cheap across ~12 slots.
        // Score the FULL returned page (100) for weapons too — the extra depth is just spaced fetches
        // (no extra searches), and the queue's adaptive 3s+ gap keeps it under the rate limit (grows
        // the gap as a window fills, so it slows near the cap rather than tripping). Was capped at 40
        // for weapons to save the shared budget; the queue's pacing makes the deeper scan safe. Scans still pass scoreCap:10.
        const isWeaponSlot = MARTIAL_WEAPON_SLOTS.has(slot.baseId || String(input.slot || ""));
        const SCORE_CAP = Math.max(10, Math.min(100, Number(input.scoreCap) || 100));
        const m = Math.min(all.length, SCORE_CAP);
        // Weighted = best-value-first, score the top m. Otherwise sample a SPREAD across
        // the result page: for price-DESC that's the priciest 100 (where real upgrades
        // live, spanning mirror-tier down to mid-price — the best upgrade is often
        // mid-range, NOT the single priciest, so a spread beats top-m). asc spreads the
        // cheap page (mostly junk, but cheap real upgrades surface if your gear is weak).
        // Weighted OR defence-sorted = best-first (highest build-value / highest defence), so take
        // the top m. Only the plain price fallback samples a spread.
        const pick = (weighted || usedDefenceSort) ? all.slice(0, m) : Array.from({ length: m }, (_, i) => all[Math.floor((i * all.length) / m)]);
        // Deflection-conversion pool (defence slots): PoB values deflection in EHP, but the raw-evasion
        // sort buries a mid-evasion / high-deflection chest so it never reaches the fetch. Pull items
        // WITH the conversion mod (evasion-sorted — deflection scales with evasion) and PREPEND the
        // fresh ones so they're fetched + scored. A 400/empty here must never break the main rank.
        if (usedDefenceSort) {
          try {
            const dq = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: [deflectConvGroup()] }, sort: { [defK]: "desc" } };
            if (maxDiv > 0 || minDiv > 0) { const price = { option: "divine" }; if (minDiv > 0) price.min = minDiv; if (maxDiv > 0) price.max = maxDiv; dq.query.filters.trade_filters = { filters: { price } }; }
            const dRes = await gearTradeSearch(dq, league);
            const dIds = ((dRes.search && dRes.search.result) || []).slice(0, 20);
            const seen = new Set(pick);
            const fresh = dIds.filter((id) => !seen.has(id));
            if (fresh.length) pick.unshift(...fresh);
          } catch { /* deflection pool is a bonus; never let it break the rank */ }
        }
        const rates = await getExchangeRates(league).catch(() => ({}));
        await pob.load(prepBuildXml(input));
        const base = await pob.calc(pobSlot, "");
        // Rank metric: the client sends the slot's metric (DPS for damage slots, EHP for
        // pure-defensive ones). Default by whether the build deals damage.
        const metric = (input.metric === "ehp" || input.metric === "dps") ? input.metric : (dpsOfOut(base) > 0 ? "dps" : "ehp");
        // Spirit guard: if the build reserves spirit (auras/heralds/persistent gems), a
        // candidate that drops Spirit headroom is a FAKE upgrade — PoB still counts those
        // buffs in the DPS even when you couldn't run them. RELATIVE test (not "< 0"):
        // headless PoB's reservation reading is miscalibrated for some builds (computes
        // SpiritUnreserved = -88 where the GUI shows +33), so an absolute "< 0" rejected
        // EVERY candidate. Compare to the BASE's unreserved in the SAME load state instead —
        // skip only a candidate with LESS headroom than your current build. Robust to the
        // miscalibration; the search's spirit floor already excludes outright no-spirit items.
        const spiritGuard = (Number(base.SpiritReserved) || 0) > 0;
        const baseUnreserved = Number(base.SpiritUnreserved) || 0;
        // Anoint transfer (amulet): traded amulets are listed UN-anointed (you re-anoint after
        // buying), but YOUR amulet's anoint is in the build → counted in `base`. Scoring a bare
        // candidate vs your anointed base penalizes it by the anoint's full worth → real upgrades
        // get buried. Graft your current anoint onto each un-anointed candidate so it's held
        // constant (apples-to-apples). Amulet only (the only PoE2 anoint slot).
        const baseSlot = slot.baseId || String(input.slot || "");
        const anointLines = baseSlot === "amulet" ? extractAnoint(input.current && input.current.raw) : [];
        const runeFill = extractRuneFill(input.current && input.current.raw);   // scale each candidate's sockets to YOUR rune
        // Current weapon's total sheet DPS (phys+ele × aps), parsed from the equipped item — used as a hard search
        // floor for weapon sub-pools below ("more DPS than mine", the user's manual recipe). 0 if the raw carries
        // no damage lines (then the floor is simply skipped).
        const curWeaponDps = MARTIAL_WEAPON_SLOTS.has(baseSlot) ? Math.round((parseItemStats((input.current && input.current.raw) || "", baseSlot) || {}).dps || 0) : 0;
        let spiritSkipped = 0;
        let cands = [];
        let fetchErr = null;
        const seenId = new Set();   // dedup listings across the main pool + weapon-DPS sub-pool
        // Fetch (chunked by 10) + PoB-score a list of listing ids into `cands`. `qid` is the search id
        // those ids belong to — each (sub-)pool MUST be fetched with its OWN id (the set path's scoreInto
        // does the same; a mismatched query id can return nothing for foreign ids).
        const scoreIds = async (ids, qid) => {
          ids = ids.filter((id) => !seenId.has(id));   // skip ids an earlier pool already fetched → sub-pools/price-slices only spend calls on NEW listings
          for (let i = 0; i < ids.length; i += 10) {   // Trade2 fetch caps at 10 ids/call
            let fetched;
            try { fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + ids.slice(i, i + 10).join(",") + "?query=" + encodeURIComponent(qid)); }
            catch (e) { fetchErr = e; break; }   // rate-limit/error mid-sweep → keep what we scored
            for (const e of fetched.result || []) {
              if (e.id != null) { if (seenId.has(e.id)) continue; seenId.add(e.id); }
              const txt = pobItemFromTradeEntry(e, anointLines, runeFill);
              if (!txt) continue;
              let stats; try { stats = await pob.calc(pobSlot, txt); } catch { continue; }
              if (spiritGuard && Number(stats.SpiritUnreserved) < baseUnreserved - 0.5) { spiritSkipped++; continue; }   // less spirit headroom than your current build → can't run its auras
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
        };
        await scoreIds(pick, search.id);
        // Key-stat sub-pools (martial weapons): with ~10k bows in budget, the weighted statgroup sort (dominated
        // by the build's #1 weight, e.g. +Attack-skill levels ×20) AND a raw-dps sort BOTH bury a bow whose real
        // value is a mod-combo — the user's bow scored +32k in PoB yet ranked mid-pack on every trade-visible
        // metric. Fix: ONE sub-pool PER top weighted stat — require that stat present, then PRICE-DESC — to narrow
        // the 10k to the priciest bows that carry the build's defining stats (proj-levels, attack-levels, …). Each
        // fetched with its OWN search id, deduped by listing id; a 400/empty never breaks the main rank. (Only
        // `dps`/`price` are valid weapon sort keys — pdps/edps/statgroup.0 all 400, verified live.)
        if (MARTIAL_WEAPON_SLOTS.has(baseSlot)) {
          const weaponSubPool = async (extraStat, extraMin, sort, cap) => {
            try {
              const wq = { query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: slot.category }, rarity: { option: "nonunique" } } } }, stats: [] }, sort };
              if (maxDiv > 0 || minDiv > 0) { const price = { option: "divine" }; if (minDiv > 0) price.min = minDiv; if (maxDiv > 0) price.max = maxDiv; wq.query.filters.trade_filters = { filters: { price } }; }
              // DPS floor: only consider bows in the ballpark of your current weapon DPS. 70% (not 90%)
              // — a 90% floor on TOTAL sheet dps collapses the pool to just the top base (Obliterator),
              // since base type sets most of a bow's dps; 70% lets near-top bases in and PoB sorts the rest.
              if (curWeaponDps > 0) wq.query.filters.equipment_filters = { filters: { dps: { min: Math.floor(curWeaponDps * 0.7) } } };
              const andF = gearStatFilters(input.preserve, 4).slice();
              if (extraStat) andF.push({ id: extraStat, value: { min: extraMin } });
              if (andF.length) wq.query.stats.push({ type: "and", filters: andF });
              const kRes = await gearTradeSearch(wq, league);
              const kIds = ((kRes.search && kRes.search.result) || []).slice(0, cap);
              if (kIds.length && kRes.search && kRes.search.id) await scoreIds(kIds, kRes.search.id);
            } catch { /* weapon sub-pool is a bonus; never let it break the rank */ }
          };
          // One pool per top weighted stat, each floored at YOUR CURRENT roll of that stat (≥mine, min 1) plus the
          // DPS floor — i.e. "bows with at least my DPS that are at least as good as mine on my key stat", priciest
          // first. This is the user's recipe generalised: read my item's top stats, require ≥ them — so a +2 bow
          // that beats mine still surfaces (a hard ≥3 would have dropped it). `w.cur` = current roll (from weights).
          const topStats = weights.slice(0, 2);
          const seenStat = new Set();
          for (const w of topStats) {
            if (fetchErr) break;   // a mid-sweep 429 stops deepening; the queue's pacing avoids tripping
            if (!w || !w.statId || seenStat.has(w.statId)) continue;
            seenStat.add(w.statId);
            await weaponSubPool(w.statId, Math.max(1, Math.round(Number(w.cur) || 0)), { price: "desc" }, 40);
          }
          // Min gain/div is set → also pull the CHEAPEST bows that still clear the DPS floor +
          // your #1 key stat. The price-DESC pools above only score the priciest bows, which have
          // inherently LOW DPS-per-divine — so a "45/div" filter finds nothing in them. High ROI
          // (cheap + real upgrade) lives at the price-ASC end; without this pool it's never fetched.
          // Gated on minRoi so a normal rank doesn't spend the extra ~4 fetches.
          if (!fetchErr && (Number(input.minRoi) || 0) > 0 && topStats[0] && topStats[0].statId) {
            await weaponSubPool(topStats[0].statId, Math.max(1, Math.round(Number(topStats[0].cur) || 0)), { price: "asc" }, 40);
          }
        }
        // PRICE-BAND PAGINATION (weighted, bounded band): a single wide-band search only returns the
        // top ~100 by the LINEAR weighted proxy, so a PoB-great bow that sorts mid-pack is dropped —
        // and a NARROWER band surfaces it (its own top-100). That's the "I lowered Max div and a better
        // bow appeared that the wider scan missed" bug. Fix: slice the band and search each segment, so
        // a wide scan ≈ the union of narrow scans. scoreIds skips already-seen ids, so each slice only
        // spends fetch calls on the NEW (mid-proxy) listings it surfaces.
        if (weighted && !fetchErr && maxDiv > 0 && maxDiv - minDiv >= 75) {
          const band = maxDiv - minDiv;
          const K = Math.min(3, Math.max(2, Math.round(band / 60)));   // ~60-div slices, 2–3 of them
          const step = band / K;
          for (let i = 0; i < K && !fetchErr; i++) {
            const lo = Math.round(minDiv + i * step);
            const hi = i === K - 1 ? maxDiv : Math.round(minDiv + (i + 1) * step);
            const sq = buildWeightedGearQuery(slot, weights, league, hi, input.preserve, { minPriceDiv: lo, equip: input.equip });
            injectRarityGroup(sq, raritySlot, rarityMin);
            try {
              const sRes = await gearTradeSearch(sq, league);
              const sIds = ((sRes.search && sRes.search.result) || []).slice(0, 40);
              if (sIds.length && sRes.search && sRes.search.id) await scoreIds(sIds, sRes.search.id);
            } catch { /* a price slice is a bonus; never break the rank */ }
          }
        }
        if (!cands.length && fetchErr) throw fetchErr;   // total failure → outer catch (rate-limit msg etc.)
        // Preserve-the-OTHER-metric (pre-scan toggle): drop any candidate that lowers the
        // SECONDARY stat BEFORE ranking, so a slightly-lower-primary but safe item still
        // surfaces in the top 25 (a client post-filter on the ranked list would miss it). On a
        // DPS slot the secondary is EHP; on an EHP slot (helmet/chest hybrids) it's DPS.
        let scoredCount = cands.length, otherDropped = 0;
        if (input.preserveOther) {
          const safe = metric === "dps" ? (c) => (c.dEHP || 0) >= 0 : (c) => (c.dDPS || 0) >= 0;
          const kept = cands.filter(safe);
          otherDropped = cands.length - kept.length;
          cands = kept;
        }
        const gainOf = (c) => metric === "ehp" ? c.dEHP : c.dDPS;   // rank by the slot's metric
        cands.sort((a, b) => (gainOf(b) - gainOf(a)) || (b.dEHP - a.dEHP));
        // The build-weighted/price search this came from — opening it lands on these
        // candidates (no per-item permalink exists on PoE trade). Each row links here.
        const searchUrl = search.id ? "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(usedLeague) + "/" + search.id : "";
        const sortMode = usedDefenceSort ? "defence" : (weighted ? "weighted" : "price");
        // Base distribution of everything scored — so the UI can SHOW whether the fetched pool
        // is genuinely one base (market reality at this price) or the search is biasing it.
        const bases = {};
        for (const c of cands) { const b = String(c.base || "").trim() || "?"; bases[b] = (bases[b] || 0) + 1; }
        // canDeepen: more of the returned result page is still unscored (true for weapons,
        // whose main pool is capped at 40 of a ~100-id page) → the client can re-rank with a
        // bigger scoreCap to hunt for higher gain/div. False once the page is fully scored.
        send(res, 200, JSON.stringify({ available: true, weighted, sortMode, sessionExpired, metric, spiritSkipped, otherDropped, searchUrl, scored: scoredCount, canDeepen: m < all.length, partial: !!fetchErr, total: Number(search.total) || pick.length, baseDps: dpsOfOut(base), baseEhp: ehpOfOut(base), bases, candidates: cands.slice(0, 25) }), "application/json; charset=utf-8");
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
      // Narrow to the exact item with its mods (a seller may list several of the same base
      // type — especially jewels, whose base alone matches many of their listings).
      const linkMods = gearStatFilters(input.mods, 3);
      if (linkMods.length) q.query.stats = gearStatGroup(linkMods);
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
      const slot = gearSlotCfg(String(input.slot || ""));
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
        await pob.load(prepBuildXml(input));
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
      const cleanup = () => { for (const f of [tmpIn, tmpProc, tmpBase + ".txt", tmpBase + ".tsv"]) fs.unlink(f, () => {}); };
      // boxes mode (poe2-overlay): return per-line bounding boxes so the overlay can
      // draw a price beside each reward row. Crops to the left `left` fraction of the
      // image (the book column) INSTEAD of chopping — a full-screen capture is mostly
      // game map, and cropping from x=0 keeps the returned coords in screen space (no
      // offset). `left` default 0.34 covers the book (icons + reward text); the caller
      // filters lines to priced rewards by name, so keeping the icon column is harmless.
      const wantBoxes = url.searchParams.has("boxes");
      const leftFrac = Math.min(1, Math.max(0.05, Number(url.searchParams.get("left")) || 0.34));
      // boxes-mode preprocessing knobs (tuned live from the overlay, then baked as its
      // defaults). Gold-on-parchment reward text OCRs badly raw; grayscale + contrast
      // stretch + upscaling helps a lot, an optional brightness threshold isolates the
      // bright text from the textured page. Coords come back in PROCESSED-image space,
      // so the caller divides box coords by (scale/100) to map back to screen px.
      const q = url.searchParams;
      const ppScale   = Math.min(400, Math.max(100, Number(q.get("scale")) || 100));
      const ppThr     = Math.min(99, Math.max(0, Number(q.get("thr")) || 0)); // 0 = no threshold
      const ppNeg     = q.get("neg") === "1";
      const ppGray    = q.get("gray") !== "0";     // default on in boxes mode
      const ppStretch = q.get("stretch") !== "0";  // default on in boxes mode
      const ppPsm     = /^\d{1,2}$/.test(q.get("psm") || "") ? q.get("psm") : "6";
      try {
        await fs.promises.writeFile(tmpIn, buf);
        if (process.env.OCR_DEBUG) {
          await fs.promises.copyFile(tmpIn, path.join(os.tmpdir(), "poe-ocr-debug-in." + ext)).catch(() => {});
        }
        let cropArg;
        if (wantBoxes) {
          const ops = [`-crop ${Math.round(leftFrac * 100)}%x100%+0+0 +repage`];
          if (ppGray) ops.push("-colorspace Gray");
          if (ppStretch) ops.push("-contrast-stretch 2%x2%");
          if (ppThr > 0) ops.push(`-threshold ${ppThr}%`);
          if (ppNeg) ops.push("-negate");
          if (ppScale !== 100) ops.push(`-resize ${ppScale}%`);
          cropArg = ops.join(" ");
        } else {
          cropArg = `-gravity West -chop 40%x0`;
        }
        await new Promise((resolve, reject) =>
          exec(`magick "${tmpIn}" ${cropArg} "${tmpProc}"`,
            (err, _, stderr) => err ? reject(new Error(stderr || err.message)) : resolve())
        );
        if (process.env.OCR_DEBUG) {
          await fs.promises.copyFile(tmpProc, path.join(os.tmpdir(), "poe-ocr-debug-proc.png")).catch(() => {});
        }
        if (wantBoxes) {
          const tsv = await new Promise((resolve, reject) =>
            exec(`tesseract "${tmpProc}" "${tmpBase}" --psm ${ppPsm} tsv -c preserve_interword_spaces=1`,
              (err, _, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                fs.readFile(tmpBase + ".tsv", "utf8", (e, d) => e ? reject(e) : resolve(d || ""));
              })
          );
          send(res, 200, JSON.stringify({ lines: parseOcrTsvLines(tsv), scale: ppScale / 100 }), "application/json; charset=utf-8");
          return;
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

    // Crafter: list craftable bases (for the picker) + a base's mod pool.
    if (url.pathname === "/api/craft/bases") {
      const J = "application/json; charset=utf-8";
      if (!CRAFT_DATA) { send(res, 503, JSON.stringify({ error: "craft-data.js not generated — run gen-craft-data.lua" }), J); return; }
      send(res, 200, JSON.stringify({ bases: craftBaseList() }), J);
      return;
    }
    if (url.pathname === "/api/craft/pool" && req.method === "POST") {
      const J = "application/json; charset=utf-8";
      if (!CRAFT_DATA) { send(res, 503, JSON.stringify({ error: "craft-data.js not generated — run gen-craft-data.lua" }), J); return; }
      const input = await readJson(req);
      const pool = craftPool(String(input.base || ""), Number(input.ilvl) || 100);
      if (!pool) { send(res, 404, JSON.stringify({ error: "unknown base" }), J); return; }
      send(res, 200, JSON.stringify(pool), J);
      return;
    }
    // Desecrated modifier reference list (Abyssal Bones + Well of Souls). Browsable only.
    if (url.pathname === "/api/craft/desecrated") {
      const J = "application/json; charset=utf-8";
      if (!DESECRATED) { send(res, 503, JSON.stringify({ error: "desecrated-data.js not generated" }), J); return; }
      send(res, 200, JSON.stringify(DESECRATED), J);
      return;
    }
    // Simulate crafting: rank known methods to hit the target mod groups on a base.
    if (url.pathname === "/api/craft/simulate" && req.method === "POST") {
      const J = "application/json; charset=utf-8";
      if (!CRAFT_DATA) { send(res, 503, JSON.stringify({ error: "craft-data.js not generated — run gen-craft-data.lua" }), J); return; }
      const input = await readJson(req);
      const mods = craftModList(String(input.base || ""), Number(input.ilvl) || 100);
      if (!mods) { send(res, 404, JSON.stringify({ error: "unknown base" }), J); return; }
      // targets: group strings, {group, keys:[tier keys]}, or a desecrated mod
      // {desecrated:true, name, faction, type} (reveal-3-pick-1 via Well of Souls).
      const targets = (Array.isArray(input.targets) ? input.targets : [])
        .map((t) => {
          if (typeof t === "string") return { group: t };
          if (t && t.desecrated) {
            const faction = String(t.faction || ""), type = t.type === "suffix" ? "suffix" : "prefix";
            return { group: "desecrated:" + String(t.name || "") + ":" + faction, desecrated: true, type, poolN: desecratedPoolN(faction, type) };
          }
          return { group: String(t.group || ""), keys: Array.isArray(t.keys) ? t.keys.map(String) : undefined };
        })
        .filter((t) => t.group);
      if (!targets.length) { send(res, 400, JSON.stringify({ error: "pick at least one target mod" }), J); return; }
      if (targets.length > 6) { send(res, 400, JSON.stringify({ error: "at most 6 targets (3 prefixes + 3 suffixes)" }), J); return; }
      const seed = (Math.random() * 4294967296) >>> 0;
      const essences = craftEssenceOptions(String(input.base || ""), Number(input.ilvl) || 100);
      const baseCls = (CRAFT_DATA && CRAFT_DATA.bases[String(input.base || "")] || {}).class;
      const jewellery = baseCls === "Ring" || baseCls === "Amulet";   // catalysts apply to jewellery
      // Prices go INTO the planner, not just onto its output. The planner shortlists hundreds of
      // enumerated routes down to the few it measures properly, and shortlisting on orb count let
      // a route spending 3 exotic omens beat one spending 30 cheap Exalts — the cheap route never
      // reached the pricer at all. Worse, an omen the market does not price counted as a free orb,
      // so unbuyable routes ranked FIRST. craftPriceOf() makes the funnel rank on money throughout.
      const proxy = await getProxyData(sanitizeLeague(input.league)).catch(() => null);
      const result = craftPlan.planRoutes(mods, targets, { seed, essences, jewellery, priceOf: craftPriceOf(proxy) });
      try { priceCraftMethods(result, proxy); } catch { /* pricing is a bonus; fall back to orb-count ranking */ }
      // route classes on the priced ranking; targetValueDiv (optional, from /api/craft/resale) adds best_ev
      if (result.priced) tagRouteClasses(result.methods, Number(input.targetValueDiv) > 0 ? Number(input.targetValueDiv) : null);
      send(res, 200, JSON.stringify(result), J);
      return;
    }

    // Craft Advisor: paste an item → auto-suggest valuable finished items + the route to each,
    // KEEPING the item's current mods (offline, no Trade2). Resale value is a separate on-demand call.
    if (url.pathname === "/api/craft/advise" && req.method === "POST") {
      const J = "application/json; charset=utf-8";
      if (!CRAFT_DATA) { send(res, 503, JSON.stringify({ error: "craft-data.js not generated — run gen-craft-data.lua" }), J); return; }
      const input = await readJson(req, 1 * 1024 * 1024);
      const baseName = String(input.base || "");
      const b = CRAFT_DATA.bases[baseName];
      if (!b) { send(res, 404, JSON.stringify({ error: "unknown base" }), J); return; }
      const ilvl = Math.max(1, Math.min(100, Number(input.ilvl) || 100));
      const slot = craftAdviseSlot(b.class);
      if (!slot || !UPGRADE_SEARCH_STATS[slot]) { send(res, 200, JSON.stringify({ advisable: false, reason: `No resale profile for ${b.class} yet — pick target mods manually below.` }), J); return; }
      const gearSlot = ADVISE_TO_GEAR_SLOT[slot] || slot;
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const poolMods = craftModList(baseName, ilvl);
      const idx = buildCraftGroupIndex(poolMods);
      // Map the pasted item's explicit lines → kept mods (dedup by group; skip unmappable lines).
      const kept = [];
      const keptGroups = new Set();
      for (const line of (Array.isArray(input.currentMods) ? input.currentMods : [])) {
        const g = mapCraftLine(String(line), idx);
        if (g && !keptGroups.has(g.group)) { keptGroups.add(g.group); kept.push({ group: g.group, type: g.type, text: craftStripTag(String(line)) }); }
      }
      const startRarity = String(input.rarity || "").toLowerCase() === "rare" ? "rare" : "magic";
      const candidates = generateCraftCandidates(slot, kept, poolMods, idx);
      if (!candidates.length) { send(res, 200, JSON.stringify({ advisable: true, base: baseName, ilvl, slot, startRarity, kept: kept.map((k) => k.text), candidates: [], note: "This item already carries the desirable mods, or has no open slots to add value." }), J); return; }
      const proxy = await getProxyData(league).catch(() => null);
      const seed = (Math.random() * 4294967296) >>> 0;
      const keptForEngine = kept.map((k) => ({ group: k.group, type: k.type }));
      const essences = craftEssenceOptions(baseName, ilvl);   // lets the planner offer an essence-guarantee route
      const category = (() => { try { const s = gearSlotCfg(gearSlot); return s ? s.category : null; } catch { return null; } })();
      const out = [];
      for (const c of candidates) {
        // adviseItem returns a VERDICT as well as routes: CONTINUE / LONGSHOT / BRICKED /
        // IMPOSSIBLE. A candidate with no route left is not rendered as a 0% plan — it is dropped
        // here, and if EVERY candidate drops out the client shows the item as bricked.
        const r = craftPlan.adviseItem(poolMods, keptForEngine, c.targets, { startRarity, seed, essences, jewellery: b.class === "Ring" || b.class === "Amulet", priceOf: craftPriceOf(proxy) });
        if (!r.methods.length) continue;
        try { priceCraftMethods(r, proxy); } catch { /* orb-count ranking is fine */ }
        const feas = r.methods.filter((m) => m.feasible);
        if (!feas.length) continue;
        // Methods are sorted cheapest-AMORTIZED first (expected orbs to obtain the item). The best
        // route is the cheapest that isn't brick-prone; a pricier "more reliable on THIS item" route
        // (usually the Annul reroll) is surfaced separately so the user can trade cost for one-shot odds.
        const best = feas.find((m) => !m.impractical) || feas[0];
        const reliable = feas.filter((m) => m !== best && m.successPerAttempt > best.successPerAttempt + 0.10).sort((a, b) => b.successPerAttempt - a.successPerAttempt)[0] || null;
        const rf = buildResaleFilters(gearSlot, kept, c.fills, idx);
        // Steps come from the ROUTE (craft-plan's describeRoute), not from a narrator here — a
        // step list rebuilt server-side could describe a route the planner never ran, and did.
        const keptLine = `Start with your ${baseName} (${startRarity === "magic" ? "Magic" : "Rare"}) — keep ${kept.length ? kept.map((k) => k.text).join(", ") : "its current mods"}.`;
        const packMethod = (m) => ({
          label: m.label, steps: [keptLine, ...m.steps], expectedOrbs: m.expectedOrbs,
          divineCost: m.divineCost != null ? m.divineCost : null,
          successPerAttempt: m.successPerAttempt, impractical: !!m.impractical, estimate: !!m.estimate,
        });
        out.push({
          label: c.fills.map((f) => f.label).join(" + "),
          fillCount: c.fills.length,
          fills: c.fills.map((f) => ({ group: f.group, type: f.type, label: f.label })),
          method: packMethod(best),
          reliable: reliable ? packMethod(reliable) : null,
          resale: category ? { category, statFilters: rf.statFilters, rarityMin: rf.rarityMin, baseSlot: gearSlot } : null,
        });
      }
      // Recommend the deepest WORTH-IT finish: most mods (resale value) among routes whose expected
      // (amortized) craft cost stays sane — a 3-mod finish costing ~170 div isn't a real rec for a
      // ring, so it sinks below the sane 2-mod one (shown dimmed as a stretch). The resale button
      // reveals true value; a cost cap is the offline proxy. ponytail: flat cap, tune per feedback.
      const FINISH_DIV_CAP = 15, FINISH_ORB_CAP = 400;
      out.forEach((o) => { const m = o.method; o.achievable = !m.impractical && (m.divineCost != null ? m.divineCost <= FINISH_DIV_CAP : Object.values(m.expectedOrbs).reduce((s, n) => s + n, 0) <= FINISH_ORB_CAP); });
      out.sort((a, b2) => (a.achievable ? 0 : 1) - (b2.achievable ? 0 : 1)
        || b2.fillCount - a.fillCount
        || (a.method.divineCost == null ? Infinity : a.method.divineCost) - (b2.method.divineCost == null ? Infinity : b2.method.divineCost));
      // Nothing survived: every worthwhile finish for this item is unreachable from where it now
      // stands. That is the BRICKED answer, and saying it plainly is the point — the alternative
      // is a 0.3%-per-attempt "plan" that quietly eats your currency.
      if (!out.length) {
        send(res, 200, JSON.stringify({
          advisable: true, base: baseName, ilvl, slot, startRarity, kept: kept.map((k) => k.text),
          verdict: "BRICKED", candidates: [], league,
          reason: "No route reaches a worthwhile finish from this item's current mods without destroying what makes it worth keeping. Drop it and start on a fresh base.",
        }), J);
        return;
      }
      send(res, 200, JSON.stringify({ advisable: true, base: baseName, ilvl, slot, startRarity, kept: kept.map((k) => k.text), verdict: "CONTINUE", candidates: out, league }), J);
      return;
    }

    // Craft Advisor: on-demand RESALE price of a finished item (the only arbitrary-rare pricer —
    // 1 Trade2 search + 1 fetch, gated on trade-status). Mirrors /api/gear/basic-link + the
    // cheapest-cluster/bait-drop read used across the gear search.
    if (url.pathname === "/api/craft/resale" && req.method === "POST") {
      const J = "application/json; charset=utf-8";
      if (tradeStatus().limited) { send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), J); return; }
      const input = await readJson(req, 256 * 1024);
      const category = String(input.category || "");
      if (!category) { send(res, 400, JSON.stringify({ error: "missing category" }), J); return; }
      const league = sanitizeLeague(input.league || "Runes of Aldur");
      const mods = gearStatFilters(Array.isArray(input.statFilters) ? input.statFilters : []);
      const q = {
        query: { status: { option: GEAR_TRADE_STATUS }, filters: { type_filters: { filters: { category: { option: category }, rarity: { option: "nonunique" } } } }, stats: gearStatGroup(mods) },
        sort: { price: "asc" },
      };
      injectRarityGroup(q, String(input.baseSlot || ""), Number(input.rarityMin) || 0);
      try {
        const { search, league: used } = await gearTradeSearch(q, league);
        const total = (search && search.total) || 0;
        const url2 = search && search.id ? "https://www.pathofexile.com/trade2/search/poe2/" + encodeURIComponent(used) + "/" + search.id : null;
        if (!search || !search.result || !search.result.length) { send(res, 200, JSON.stringify({ priced: true, cheapestDiv: null, count: total, url: url2, league: used }), J); return; }
        const rates = await getExchangeRates(used).catch(() => ({}));
        const ids = search.result.slice(0, 10).join(",");
        const fetched = await fetchTrade("https://www.pathofexile.com/api/trade2/fetch/" + ids + "?query=" + encodeURIComponent(search.id));
        const listings = [];
        for (const e of (fetched.result || [])) {
          const p = listingPriceFromEntry(e, rates);
          if (p && p.divine > 0) listings.push({ div: p.divine, indexedAt: e.listing && e.listing.indexed });
        }
        const rp = robustResalePrice(listings);
        // cheapestDiv kept for existing callers (now the robust sale anchor, not the raw ask)
        send(res, 200, JSON.stringify({ priced: true, cheapestDiv: rp.saleDiv, saleDiv: rp.saleDiv, liquidationDiv: rp.liquidationDiv, thin: rp.thin, sample: rp.sample, freshSample: rp.freshSample, count: total, url: url2, league: used }), J);
      } catch (err) {
        if (String(err && err.message).includes("rate limited")) { send(res, 200, JSON.stringify({ limited: true, tradeStatus: tradeStatus() }), J); return; }
        send(res, 200, JSON.stringify({ error: String(err.message) }), J);
      }
      return;
    }

    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const fullPath = path.resolve(ROOT, requested);
    if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) {
      send(res, 403, "Forbidden");
      return;
    }
    // Never serve dotfiles (.env, .poesessid.json, .git/…) — they hold secrets/state.
    if (requested.split(/[\\/]/).some((seg) => seg.startsWith("."))) {
      send(res, 404, "Not found");
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
    // Auto-open the browser is OPT-IN (POE2_OPEN=1) — the default is quiet. `exec('start …')`
    // flashes a cmd.exe console window AND steals focus (bad while gaming); you already know
    // the URL. Set POE2_OPEN=1 if you want the old auto-open. POE2_NO_OPEN still forces quiet.
    if (process.env.POE2_OPEN === "1" && process.env.POE2_NO_OPEN !== "1") exec('start "" "' + url + '"');
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
  robustResalePrice,
  tagRouteClasses,
  sanitizeLeague,
  buildExchangeCatalog,
  gearSearchSlots,
  decodePobCode,
  parsePobBuild,
  listPobBuilds,
  computeGearWeights,
  parseItemStats,
  optimizeBreakpoints, checkBreakpoints, dominationPrune, itemBreakpointContrib,
  pobItemFromTradeEntry, extractRuneFill,
  buildWeightedGearQuery,
  ee2SidePrices,
  exchangePriceEx,
  parseProxyOverview,
  getProxyData,
  proxyPrice,
  parseOcrTsvLines,
  __setExchangeRawImpl(fn) { exchangeRawImpl = fn; },
  __setProxyFetchImpl(fn) { proxyFetchImpl = fn; },
};

#!/usr/bin/env node
/* ============================================================================
   PoE Tools — smoke test.  Run:  node smoke-test.js
   Catches the classes of regression that bit us during the SPA merge:
   pages/scripts broken, @scope/iframe leftovers, deep-link views not
   initialising, horizontal overflow, console errors, and the data-table
   styling. Zero-dep static + HTTP checks always run; the browser checks run
   if Playwright + a Chromium build can be located (npx cache or a global
   install), and are skipped (not failed) otherwise.
   Exit code is non-zero if any check fails.
   ============================================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = __dirname;
const BASE = "http://127.0.0.1:17777";
let fails = 0, passes = 0, skips = 0;
const ok = (m) => { passes++; console.log("  ✓ " + m); };
const bad = (m) => { fails++; console.log("  ✗ " + m); };
const skip = (m) => { skips++; console.log("  - (skip) " + m); };
function check(cond, m) { cond ? ok(m) : bad(m); return cond; }

// ---- helpers ----
function read(f) { return fs.readFileSync(path.join(ROOT, f), "utf8"); }
function parses(js, label) { try { new Function(js); return true; } catch (e) { bad(label + " parse error: " + e.message); return false; } }
function get(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d, type: res.headers["content-type"] || "" })); })
      .on("error", () => resolve({ status: 0, body: "", type: "" }));
  });
}
function post(url, obj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(obj);
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end(body);
  });
}
function waitUp(tries) {
  return new Promise((resolve) => {
    const t = () => get(BASE + "/").then(r => { if (r.status === 200) resolve(true); else if (--tries <= 0) resolve(false); else setTimeout(t, 400); });
    t();
  });
}
function loadPlaywright() {
  try { return require("playwright"); } catch {}
  const base = path.join(os.homedir(), "AppData/Local/npm-cache/_npx");
  try { for (const d of fs.readdirSync(base)) { const p = path.join(base, d, "node_modules/playwright"); if (fs.existsSync(path.join(p, "package.json"))) return require(p); } } catch {}
  return null;
}
function chromiumExe() {
  const base = path.join(os.homedir(), "AppData/Local/ms-playwright");
  try {
    // Prefer chrome-headless-shell: it's TRULY windowless. Full chrome.exe — even
    // launched headless — briefly opens a window on Windows that steals focus from the
    // foreground app (the user's game). The headless shell never creates a window, so
    // browser checks stay silent/background. Fall back to full chrome only if absent.
    const shellDirs = fs.readdirSync(base).filter(d => /^chromium_headless_shell-\d/.test(d)).sort().reverse();
    for (const d of shellDirs) for (const sub of ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-win/chrome-headless-shell.exe"]) { const e = path.join(base, d, sub); if (fs.existsSync(e)) return e; }
  } catch {}
  // No full-chrome.exe fallback on purpose: full Chrome flashes a focus-stealing window
  // even headless. If the windowless shell is missing, browserChecks skips entirely.
  return undefined;
}

// ---- 1) static checks ----
function staticChecks() {
  console.log("Static checks:");
  const idx = read("index.html");
  check(/rel="stylesheet" href="theme.css"/.test(idx), "index links theme.css");
  const themeCss = read("theme.css");
  check(/@font-face/.test(themeCss) && !/fonts\.googleapis\.com/.test(themeCss), "theme.css self-hosts fonts (no Google @import)");
  check(["inter", "jetbrains-mono"].every(f => themeCss.includes("/fonts/" + f + ".woff2")), "theme.css references the self-hosted woff2 fonts");
  const views = ["home", "rune-picker", "map-juicer", "gear-finder", "filter-helper", "craft"];
  check(views.every(v => idx.includes(`id="${v}"`)), "index has all core view sections");
  check(["toolroot-mj", "toolroot-rune", "toolroot-gear"].every(t => idx.includes(t)), "index has the active inline tool roots");
  check(idx.includes('id="fxStrip"') && idx.includes('id="fxStripRefresh"'), "home has currency strip + refresh button");
  check(/\.fxchip\.skel/.test(idx) && /@keyframes fxshimmer/.test(idx), "home currency strip has loading-skeleton CSS");
  check(/showSkeleton/.test(read("home.js")), "home.js renders a loading skeleton on first fetch");
  // Home: tool cards replaced by the economy dashboard.
  check(idx.includes('id="econ"') && !/class="tools"/.test(idx) && !/class="tool /.test(idx), "home shows the economy dashboard (tool cards removed)");
  check(/api\/economy\/history/.test(read("home.js")) && /lineChart/.test(read("home.js")), "home.js draws the economy chart from /api/economy/history");
  check(idx.includes('id="freshRunes"'), "rune-picker has a Fetch fresh prices button");
  check(/forceFresh\s*:/.test(read("rune-picker.js")), "rune-picker.js sends forceFresh to the API");
  check(!/coming-soon/i.test(idx) && !/more tools/i.test(idx) && !/farming notes/i.test(idx), "More Tools + hallucinated placeholder pages removed");
  check(!/@scope\s*\(/.test(idx), "no @scope rules left (browser-portable scoping)");
  check(!/<iframe/.test(idx), "no iframes left (true inline views)");
  // every index inline <script> parses
  const scripts = [...idx.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  check(scripts.length > 0 && scripts.every((s, i) => parses(s, "index script #" + (i + 1))), "index inline scripts parse");
  const toolJs = ["map-juicer.js", "rune-picker.js", "home.js", "gear-finder.js"];
  for (const f of toolJs) check(parses(read(f), f), f + " parses");
  check(["map-juicer.css", "rune-picker.css", "gear-finder.css"].every(c => idx.includes(`href="${c}"`)), "index links all tool stylesheets");
  check(toolJs.every(j => idx.includes(`src="${j}"`)), "index loads all view scripts");
  // Gear Upgrade Finder: PoB import endpoints + headless engine wiring + zero-dep decode.
  {
    const srvG = read("server.js");
    check(["/api/gear/import", "/api/gear/builds", "/api/gear/weights", "/api/gear/basic-link"].every(p => srvG.includes(p)), "server has the gear-finder endpoints");
    check(!srvG.includes('"/api/gear/search"') && !srvG.includes('"/api/gear/rank"'), "old fetch-and-score endpoints retired");
    check(/require\("\.\/pob\.js"\)/.test(srvG) && /function parsePobBuild/.test(srvG) && /zlib\.inflate/.test(srvG), "server wires pob.js + PoB decode/parse (zlib)");
    check(/async function computeGearWeights/.test(srvG) && /GEAR_PROBE_TEMPLATES/.test(srvG) && /type: "weight"/.test(srvG), "server computes PoB stat-weights + builds the weighted query");
    check(fs.existsSync("pob.js") && fs.existsSync("pob-bridge.lua") && /GetMiscCalculator/.test(read("pob-bridge.lua")), "headless bridge present (pob.js + pob-bridge.lua)");
    check(/snippetText/.test(read("gear-finder.js")) && /BOOKMARKLET/.test(read("gear-finder.js")) && idx.includes('id="gfBookmarklet"') && idx.includes('id="gfCopyQuery"') && idx.includes('id="gfWeights"'), "gear-finder: weight breakdown + bookmarklet/copy-search (+ console fallback)");
    check(/\/api\/gear\/score/.test(srvG) && /scoreItems/.test(read("gear-finder.js")) && idx.includes('id="gfItem"'), "gear-finder has paste-an-item exact DPS/EHP gain (headless, no trade)");
    check(/poe2\.gearFinder\.builds/.test(read("gear-finder.js")) && idx.includes('id="gfSaved"') && /else if \(input\.xml\)/.test(srvG), "gear-finder has named localStorage build saves (+ import accepts xml)");
    check(/\/api\/gear\/realrank/.test(srvG) && /function pobItemFromTradeEntry/.test(srvG) && /realRank/.test(read("gear-finder.js")) && idx.includes('id="gfRealOut"'), "gear-finder has real-DPS ranking (fetch + headless score)");
    check(/POB_BRIDGE_URL/.test(read("pob.js")) && /async function ready/.test(read("pob.js")) && fs.existsSync("pob-agent.js"), "pob.js remote mode + pob-agent.js (VM→PC headless bridge)");
    check(fs.existsSync("ecosystem.config.js") && /pob-agent/.test(read("ecosystem.config.js")), "pm2 ecosystem config for the pob-agent");
    const zlib = require("zlib");
    const sample = "<PathOfBuilding2><Build/></PathOfBuilding2>";
    const code = zlib.deflateSync(Buffer.from(sample)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    check(require("./server.js").decodePobCode(code) === sample, "PoB code decode (base64url + zlib) round-trips");
  }
  // Retired tools are fully gone (UI + files): user is rebuilding them from scratch.
  check(["craft-pricer", "gear-search", "arbitrage"].every(t => !idx.includes(`data-view-link="${t}"`) && !idx.includes(`id="${t}" class="view"`)), "retired tools removed from index (nav + views)");
  check(["arbitrage.js", "gear-search.js", "craft-pricer.js", "arbitrage-scanner.html", "character-upgrades.html"].every(f => !fs.existsSync(f)), "retired tool + redirect files deleted");
  // Record/replay: develop + test the tool with zero live GGG calls (no IP evasion).
  const srvJ = read("server.js");
  check(/replayMode/.test(read("trade-queue.js")) && /recordMode/.test(read("trade-queue.js")), "trade-queue.js has record/replay");
  check(/POE_OFFLINE/.test(srvJ) && /POE_RECORD/.test(srvJ) && /fixtureFile:\s*TRADE_FIXTURE_FILE/.test(srvJ), "server wires POE_OFFLINE / POE_RECORD into the queue");
  // Map Juicer regex is %-aware (the fix): value range + the 0-revives regex.
  const mj = read("map-juicer.js"), wd = read("waystone-data.js");
  check(/revives available: 0/.test(wd) && /line:\s*{/.test(wd), "waystone-data has revives + colon-format line tokens");
  check(/\\\\\+\(\$\{tens/.test(mj) || /atLeast\(/.test(mj), "map-juicer builds %-aware threshold regex");
  check(/noRevivesRegex/.test(mj), "map-juicer has the 0-revives regex generator");
  // Unification: one Trade2 exchange-rate provider; no poe.ninja currency calls.
  const srv = read("server.js");
  check(/\/api\/economy\/history/.test(srv) && /function sampleEconomy/.test(srv) && /ECONOMY_ITEMS/.test(srv), "server has the economy history sampler + endpoint");
  check(/async function getExchangeData/.test(srv) && /async function getExchangeRates/.test(srv), "server has the unified Trade2 exchange-rate provider");
  check(!/await fetchCurrencyRates\(/.test(srv), "no poe.ninja fetchCurrencyRates calls remain (currency unified on Trade2)");
  check(/iconsById/.test(srv), "server resolves currency icons from Trade2 static data");
  check(/async function fetchRunePrices\([^)]*forceFresh/.test(srv) && /input\.forceFresh/.test(srv), "server fetchRunePrices honors a forceFresh flag (on-demand fresh prices)");
  check(!/let P=\{\}|function showView\(\)\{[^]*CRAFTS/.test(idx) && !idx.includes("const CRAFTS="), "index is shell-only (tool logic externalised)");
  // CSS parity: rune-only selectors must have left index's <style> for rune-picker.css
  const idxStyle = (idx.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
  const runeOnly = [".toolpanel", ".bestbox", ".paste-zone", ".split", ".conf-hi"];
  check(runeOnly.every(s => !idxStyle.includes(s)), "index <style> purged of rune-only selectors (CSS parity)");
  const runeCss = read("rune-picker.css");
  check(runeOnly.every(s => runeCss.includes(s)) && /\.toolroot-rune\s+\.toolpanel/.test(runeCss), "rune-picker.css holds the rune-only rules, prefix-scoped");
  // redirect stubs
  for (const [f, hash] of [["waystone-juicer.html", "#map-juicer"]]) {
    check(read(f).includes("index.html" + hash), `${f} redirects to ${hash}`);
  }
  // theme.css: no self-referential var cycle (the bug that blanked tokens)
  const theme = read("theme.css");
  const cyc = [...theme.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*\1\s*\)/g)];
  check(cyc.length === 0, "theme.css has no self-referential var cycles" + (cyc.length ? " (" + cyc.map(c => c[1]).join(",") + ")" : ""));
  // exchange page-starvation backfill (offline determinism test against real code)
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "backfill-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "exchange backfill recovers page-starved currencies (backfill-test.js)");
  } catch {
    check(false, "exchange backfill recovers page-starved currencies (backfill-test.js)");
  }
  // economy divine-anchor: thin lowball offers can't poison exPerDiv (stock floor)
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "economy-rate-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "economy divine anchor rejects thin lowball offers (economy-rate-test.js)");
  } catch {
    check(false, "economy divine anchor rejects thin lowball offers (economy-rate-test.js)");
  }
  // Filter Helper only scans items the filter HIDES (no over-scan of shown items)
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "filter-helper-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "filter helper cascade flags hidden currency (filter-helper-test.js)");
  } catch {
    check(false, "filter helper cascade flags hidden currency (filter-helper-test.js)");
  }
  // Crafter: extracted mod-pool data + Monte Carlo engine self-checks (only if generated)
  if (fs.existsSync(path.join(ROOT, "craft-data.js"))) {
    try {
      require("child_process").execFileSync("node", [path.join(ROOT, "craft-data-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
      check(true, "craft-data pool extraction is sane (craft-data-test.js)");
    } catch {
      check(false, "craft-data pool extraction is sane (craft-data-test.js)");
    }
  }
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "craft-engine-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "craft Monte Carlo engine probabilities are correct (craft-engine-test.js)");
  } catch {
    check(false, "craft Monte Carlo engine probabilities are correct (craft-engine-test.js)");
  }
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "craft-plan-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "planner covers the KB move catalog + ranks on money (craft-plan-test.js)");
  } catch {
    check(false, "planner covers the KB move catalog + ranks on money (craft-plan-test.js)");
  }
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "craft-parse-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "pasted-item parser keeps IMPLICITS out of the affixes (craft-parse-test.js)");
  } catch {
    check(false, "pasted-item parser keeps IMPLICITS out of the affixes (craft-parse-test.js)");
  }
  // Resale pricing realism + expected-profit route classes (offline, pure functions)
  try {
    require("child_process").execFileSync("node", [path.join(ROOT, "craft-profit-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
    check(true, "resale price is lowball/stale-proof + route classes tag honestly (craft-profit-test.js)");
  } catch {
    check(false, "resale price is lowball/stale-proof + route classes tag honestly (craft-profit-test.js)");
  }
  // Recipe snapshot (poe2-kb recipe-v1 → gen-recipes.js → recipe-data.js) validates + simulates.
  // Needs the poe2-kb checkout for the schema — skipped where it's absent (e.g. the container).
  if (fs.existsSync(path.join(ROOT, "recipe-data.js")) && fs.existsSync(path.join(ROOT, "..", "poe2-kb", "crafting", "schema", "recipe-v1.schema.json"))) {
    try {
      require("child_process").execFileSync("node", [path.join(ROOT, "recipe-data-test.js")], { stdio: "ignore", env: { ...process.env, POE2_NO_OPEN: "1" } });
      check(true, "recipe snapshot validates + step machine simulates (recipe-data-test.js)");
    } catch {
      check(false, "recipe snapshot validates + step machine simulates (recipe-data-test.js)");
    }
  }
  // Desecrated reference data (scraped from poe2db) loads with the expected shape (if present)
  if (fs.existsSync(path.join(ROOT, "desecrated-data.js"))) {
    try {
      const D = require("./desecrated-data.js");
      check(Array.isArray(D.mods) && D.mods.length > 100 && D.mods.every((m) => m.name && m.type && Array.isArray(m.stats)), "desecrated-data.js loads (100+ mods, well-formed)");
    } catch { check(false, "desecrated-data.js loads (100+ mods, well-formed)"); }
  }
}

// ---- 2) HTTP checks ----
async function httpChecks() {
  console.log("HTTP checks:");
  for (const [p, type] of [["/", "html"], ["/theme.css", "css"], ["/map-juicer.css", "css"], ["/rune-picker.css", "css"], ["/map-juicer.js", "javascript"], ["/rune-picker.js", "javascript"], ["/gear-finder.css", "css"], ["/gear-finder.js", "javascript"], ["/home.js", "javascript"], ["/waystone-data.js", "javascript"], ["/fonts/inter.woff2", "font/woff2"], ["/fonts/jetbrains-mono.woff2", "font/woff2"]]) {
    const r = await get(BASE + p); check(r.status === 200 && r.type.includes(type), `GET ${p} -> 200 ${type}`);
  }
  const ts = await get(BASE + "/api/trade-status"); check(ts.status === 200 && ts.body.includes("limited"), "GET /api/trade-status -> 200 JSON");
  const co = await get(BASE + "/api/currency/overview?league=Runes%20of%20Aldur"); check(co.status === 200 && /"items"/.test(co.body), "GET /api/currency/overview -> 200 JSON (items)");

  // The planner enumerates routes from the move catalog rather than a hand-written list, so a real
  // craft must come back with MANY routes considered — a collapse to a handful means enumeration
  // silently gated everything out, which is the failure mode this whole layer exists to prevent.
  const sim = await post(BASE + "/api/craft/simulate",
    { base: "Sapphire Ring", ilvl: 82, targets: ["ChaosResistance", "LightningResistance"], league: "Runes of Aldur" });
  if (sim.status === 200) {
    const r = JSON.parse(sim.body);
    check(!r.impossible && r.methods.length > 0, "POST /api/craft/simulate -> ranked routes");
    check(r.routesConsidered > 50, `planner enumerated the route space (${r.routesConsidered} routes considered)`);
    // Costs must be charged under REAL currency/omen names, because those are the names the
    // poe.ninja proxy prices. A short internal alias ("Exaltation omen") prices as the wrong omen.
    const orbs = Object.keys(r.methods[0].expectedOrbs || {});
    check(orbs.length > 0 && orbs.every((o) => /Orb|Omen|Essence|Bone|Lock|Catalyst/.test(o)),
      `route costs use real market names [${orbs.slice(0, 3).join(", ")}]`);
    check(Array.isArray(r.methods[0].steps) && r.methods[0].steps.length > 1,
      "each route carries step-by-step instructions derived from its own moves");
  } else check(false, "POST /api/craft/simulate -> 200");
}

// ---- 3) browser checks ----
async function browserChecks() {
  console.log("Browser checks:");
  // SMOKE_NO_BROWSER=1 skips launching Chromium entirely. On Windows even headless
  // Chromium briefly opens a window that STEALS FOCUS from the foreground app (the
  // user's game) — so this env lets a run stay fully background/non-disruptive.
  if (process.env.SMOKE_NO_BROWSER === "1") { skip("SMOKE_NO_BROWSER=1; browser checks skipped (no focus-stealing window)"); return; }
  const pw = loadPlaywright();
  if (!pw) { skip("Playwright not found; browser checks skipped"); return; }
  const exe = chromiumExe();
  if (!exe) { skip("No windowless chrome-headless-shell found; browser checks skipped (won't launch full Chrome — it flashes a focus-stealing window)"); return; }
  let browser;
  try { browser = await pw.chromium.launch({ headless: true, executablePath: exe }); }
  catch (e) { skip("Chromium launch failed (" + e.message.split("\n")[0] + "); browser checks skipped"); return; }
  try {
    // desktop walk: every view, no errors / overflow / iframes
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errs = []; page.on("pageerror", e => errs.push(e.message)); page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    // Mock the currency strip so the walk never waits on (or errors from) live Trade2
    // — a throttled IP must NOT hang the home page and crash the whole browser suite.
    await page.route("**/api/currency/overview**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({
      league: "Runes of Aldur", updated: new Date().toISOString(), cached: true,
      items: [{ id: "divine", name: "Divine Orb", ex: 320 }, { id: "exalted", name: "Exalted Orb", ex: 1, base: true }, { id: "chaos", name: "Chaos Orb", ex: 2.4 }],
    }) }));
    await page.goto(BASE + "/#home", { waitUntil: "domcontentloaded" });
    let maxOv = 0, ifr = 0;
    for (const v of ["map-juicer", "rune-picker", "gear-finder", "filter-helper", "home"]) {
      await page.click(`[data-view-link="${v}"]`).catch(() => {});
      await page.waitForTimeout(500);
      maxOv = Math.max(maxOv, await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)));
      if (await page.evaluate(k => !!document.querySelector("#" + k + " iframe"), v)) ifr++;
    }
    check(maxOv === 0, "desktop: no horizontal overflow on any view");
    check(ifr === 0, "desktop: no iframes");
    check(errs.length === 0, "desktop walk: 0 console errors" + (errs.length ? " (" + errs[0] + ")" : ""));
    // a11y: focus + live region after nav
    await page.click('[data-view-link="map-juicer"]'); await page.waitForTimeout(400);
    check(await page.evaluate(() => /H1|H2/.test(document.activeElement.tagName)), "a11y: focus moves to view heading on nav");
    check(await page.evaluate(() => (document.getElementById("view-live").textContent || "").length > 0), "a11y: live region announces view");
    await page.close();

    // deep-link init (the bug that regressed): load a tool hash directly -> its JS ran
    for (const [hash, sel, what] of [["#map-juicer", ".toolroot-mj .regexbox", "regex rows"], ["#gear-finder", "#gear-finder #gfMode", "PoB mode badge"]]) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await p.goto(BASE + "/index.html" + hash, { waitUntil: "networkidle" }); await p.waitForTimeout(1400);
      const got = await p.evaluate(s => { const el = document.querySelector(s); return !!el && (el.children.length > 0 || /\S/.test(el.textContent)); }, sel);
      check(got, `deep-link ${hash} initialises (${what} populated)`);
      await p.close();
    }

    // Rune Picker wiring (init bound the button): an empty check shows the guard
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await p.goto(BASE + "/index.html#rune-picker", { waitUntil: "networkidle" }); await p.waitForTimeout(1200);
      // extracted rune-picker.css applies: scoped .toolpanel is painted (not a bare transparent box)
      const styled = await p.evaluate(() => {
        const el = document.querySelector(".toolroot-rune .toolpanel"); if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.backgroundImage !== "none" && cs.borderTopWidth !== "0px";
      });
      check(styled, "rune-picker.css applies on live view (.toolpanel painted)");
      const freshBtn = await p.evaluate(() => { const b = document.getElementById("freshRunes"); return !!(b && b.offsetParent !== null); });
      check(freshBtn, "Rune Picker shows a visible Fetch fresh prices button");
      await p.click("#checkRunes"); await p.waitForTimeout(600);
      const msg = await p.evaluate(() => (document.getElementById("runeStatus") || {}).textContent || "");
      check(/Paste item names/i.test(msg), "Rune Picker wired (empty check shows guard message)");
      // Results table must fit its (widened) panel — all 8 columns, no clipped 7d /
      // internal horizontal scroll. Mock a realistic full-width row and measure.
      const fit = await p.evaluate(() => {
        const tb = document.getElementById("runeRows");
        tb.innerHTML = '<tr><td class="num">3</td><td>Greater Essence of Enhancement</td>' +
          '<td>Currency (trade2)</td><td class="num">7.92 ex</td><td class="num">23.76 ex</td>' +
          '<td><span class="conf conf-hi">High 412</span></td>' +
          '<td>trade2 exchange<div class="muted">stock 88</div></td><td class="num">-60.1%</td></tr>';
        const w = document.querySelector(".toolroot-rune .tablewrap");
        return w.scrollWidth - w.clientWidth;
      });
      check(fit <= 2, "rune results table fits its panel (no clipped column / internal scroll)");
      await p.close();
    }

    // Rune results SORT: default is confidence-then-value; clicking a header re-sorts
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.route("**/api/rune-prices", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        count: 4, results: [
          { qty: 1, name: "LowHigh", category: "x", each: 100, total: 100, confidence: "low", source: "s" },
          { qty: 1, name: "HighLow", category: "x", each: 5, total: 5, confidence: "high", source: "s" },
          { qty: 1, name: "HighHigh", category: "x", each: 50, total: 50, confidence: "high", source: "s" },
          { qty: 1, name: "MedMid", category: "x", each: 20, total: 20, confidence: "medium", source: "s" },
        ], best: { qty: 1, name: "LowHigh", each: 100, total: 100, category: "x", source: "s" },
      }) }));
      await p.goto(BASE + "/index.html#rune-picker", { waitUntil: "networkidle" }); await p.waitForTimeout(800);
      await p.evaluate(() => { document.getElementById("runeInput").value = "x"; });
      await p.click("#checkRunes"); await p.waitForTimeout(500);
      const names = () => p.evaluate(() => [...document.querySelectorAll("#runeRows tr")].map(r => r.children[1] && r.children[1].textContent));
      const def = await names();
      // confidence first (high tier by value, then medium, then low) — LowHigh last despite top value
      check(def[0] === "HighHigh" && def[1] === "HighLow" && def[3] === "LowHigh", "rune table default sort is confidence-then-value");
      await p.click('.toolroot-rune thead th[data-sort="total"]'); await p.waitForTimeout(200);
      const byVal = await names();
      check(byVal[0] === "LowHigh" && byVal[3] === "HighLow", "rune table re-sorts by value when Total header clicked");
      await p.close();
    }


    // Rune Picker: "pricing…" items get an auto-updating status + show in the shared bar
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.route("**/api/trade-status**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ limited: false }) }));
      await p.route("**/api/rune-prices", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        count: 1, results: [{ qty: 1, name: "Desert Rune", category: "pricing…", each: "", total: "", source: "trade2 exchange", confidence: "none" }],
      }) }));
      await p.goto(BASE + "/index.html#rune-picker", { waitUntil: "networkidle" }); await p.waitForTimeout(400);
      await p.evaluate(() => { document.getElementById("runeInput").value = "Desert Rune"; });
      await p.click("#checkRunes"); await p.waitForTimeout(500);
      const st = await p.evaluate(() => (document.getElementById("runeStatus") || {}).textContent || "");
      check(/auto-updat/i.test(st), "rune picker shows an auto-updating status for pricing… items");
      await p.evaluate(() => { location.hash = "#home"; }); await p.waitForTimeout(200);
      const barShown = await p.evaluate(() => { const b = document.getElementById("bgBar"); return !!(b && !b.hidden && /rune picker/i.test(b.textContent)); });
      check(barShown, "rune picker background scan shows in the shared top bar");
      await p.close();
    }

    // (retired 2026-06-26: Arbitrage Scanner + Gear Search browser checks removed
    //  with the tools — user is rebuilding those from scratch.)

    // Home currency strip (mocked overview): chips render + refresh re-fetches
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      let hits = 0;
      await p.route("**/api/currency/overview**", route => { hits++; route.fulfill({ contentType: "application/json", body: JSON.stringify({
        league: "Runes of Aldur", updated: new Date().toISOString(), cached: true,
        items: [{ id: "divine", name: "Divine Orb", ex: 320, icon: "https://web.poecdn.com/divine.png" }, { id: "exalted", name: "Exalted Orb", ex: 1, base: true, icon: "https://web.poecdn.com/ex.png" }, { id: "chaos", name: "Chaos Orb", ex: 2.4, icon: "https://web.poecdn.com/chaos.png" }],
      }) }); });
      await p.route("**/api/trade-status**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ limited: false, secondsRemaining: 0, tradeLimitedUntil: "" }) }));
      // economy history would otherwise hit the live EE2 proxy server-side and keep networkidle pending
      await p.route("**/api/economy/history**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ points: [], updated: new Date().toISOString() }) }));
      await p.goto(BASE + "/index.html#home", { waitUntil: "networkidle" }); await p.waitForTimeout(600);
      const strip = await p.evaluate(() => { const s = document.getElementById("fxStrip"); const c = document.getElementById("fxStripChips"); const t = document.getElementById("tradeStatus"); const base = [...(c ? c.children : [])].find(el => /\(base\)/.test(el.textContent)); return { shown: s && !s.hidden, chips: c ? c.children.length : 0, icons: c ? c.querySelectorAll("img.fxicon").length : 0, baseTxt: base ? base.textContent : "", tradeOk: t ? t.classList.contains("ok") : false, tradeTxt: t ? t.textContent : "" }; });
      check(strip.shown && strip.chips === 3, "home currency strip renders chips from cache");
      check(strip.icons === 3, "home currency chips render currency icons");
      check(/Chaos/.test(strip.baseTxt) && /\(base\)/.test(strip.baseTxt), "home currency strip uses Chaos as the base unit");
      check(strip.tradeOk && /ready/i.test(strip.tradeTxt), "home Trade2 status pill shows ready when not limited");
      await p.click("#fxStripRefresh"); await p.waitForTimeout(400);
      check(hits >= 2, "home currency refresh button re-fetches (force)");
      await p.close();
    }

    // Currency strip shows a loading SKELETON before data arrives (was a blank gap)
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.route("**/api/currency/overview**", async route => {
        await new Promise(r => setTimeout(r, 800));
        route.fulfill({ contentType: "application/json", body: JSON.stringify({
          league: "Runes of Aldur", updated: new Date().toISOString(), cached: true,
          items: [{ id: "divine", name: "Divine Orb", ex: 320 }, { id: "exalted", name: "Exalted Orb", ex: 1, base: true }, { id: "chaos", name: "Chaos Orb", ex: 2.4 }],
        }) });
      });
      const nav = p.goto(BASE + "/index.html#home", { waitUntil: "domcontentloaded" });
      // Wait for the skeleton to APPEAR (bounded, < the mock's 800ms delay) rather
      // than a fixed sleep — kills the long-standing timing flake on slow runs.
      await p.waitForSelector("#fxStripChips .skel", { timeout: 700 }).catch(() => {});
      const loading = await p.evaluate(() => { const s = document.getElementById("fxStrip"); return { shown: s && !s.hidden, skel: document.querySelectorAll("#fxStripChips .skel").length }; });
      check(loading.shown && loading.skel > 0, "home currency strip shows a loading skeleton before data");
      await nav.catch(() => {}); await p.waitForTimeout(1000);
      const done = await p.evaluate(() => ({ skel: document.querySelectorAll("#fxStripChips .skel").length, chips: document.querySelectorAll("#fxStripChips .fxchip:not(.skel)").length }));
      check(done.skel === 0 && done.chips >= 2, "home currency skeleton is replaced by real chips");
      await p.close();
    }

    // Home currency strip stays VISIBLE (with retry) when the server returns no
    // rates — e.g. a fresh VM whose cold-cache fetch hit the Trade2 limit. Hiding
    // it looked broken and removed the only way to re-fetch.
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.route("**/api/currency/overview**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ league: "Runes of Aldur", items: [], limited: true }) }));
      await p.route("**/api/economy/history**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ points: [], updated: new Date().toISOString() }) }));
      await p.goto(BASE + "/index.html#home", { waitUntil: "networkidle" }); await p.waitForTimeout(500);
      const empty = await p.evaluate(() => { const s = document.getElementById("fxStrip"); const m = document.getElementById("fxStripMeta"); const r = document.getElementById("fxStripRefresh"); return { shown: s && !s.hidden, meta: m ? m.textContent : "", hasRefresh: !!(r && r.offsetParent !== null) }; });
      check(empty.shown && empty.hasRefresh && /retry/i.test(empty.meta), "home currency strip stays visible + retryable when rates unavailable");
      await p.close();
    }


    // Regex Forge: %-aware floor by default, steppers rebuild it, toggle adds the 0-revives block
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.goto(BASE + "/index.html#map-juicer", { waitUntil: "networkidle" }); await p.waitForTimeout(900);
      const out = () => p.evaluate(() => document.querySelector(".toolroot-mj .forge-out .regexbox").textContent);
      check(/Set a minimum/.test(await out()), "regex forge starts empty (no floors, nothing ticked)");
      // step Min Item Rarity up four times (0 -> 10 -> 20 -> 30 -> 40) -> range becomes [4-9]
      for (let i = 0; i < 4; i++) { await p.click('.toolroot-mj [data-step="rarity"][data-dir="1"]'); await p.waitForTimeout(80); }
      check(/item rarity: \\\+\(\[4-9\]\[0-9\]\|/.test(await out()), "regex forge stepper rebuilds the regex (Rarity 40%)");
      // set Min Waystone Drop to 100 (now a stepper, not a toggle) -> its 100+ token joins the AND floor
      await p.evaluate(() => { const i = document.querySelector('.toolroot-mj [data-stepin="wdrop"]'); i.value = "100"; i.dispatchEvent(new Event("change", { bubbles: true })); });
      await p.waitForTimeout(120);
      check(/drop chance: \\\+\[0-9\]\[0-9\]\[0-9\]%/.test(await out()), "regex forge adds waystone-drop ≥100% via the stepper");
      // Monster Rarity floor (new stepper) -> its block joins the AND floor
      await p.evaluate(() => { const i = document.querySelector('.toolroot-mj [data-stepin="monRar"]'); i.value = "45"; i.dispatchEvent(new Event("change", { bubbles: true })); });
      await p.waitForTimeout(120);
      check(/monster rarity: \\\+\(4\[5-9\]\|\[5-9\]\[0-9\]\)%/.test(await out()), "regex forge floor adds Monster Rarity ≥45 (new stepper)");
      // toggle "fully juiced" -> the 0-revives block appears in the live output
      await p.click('.toolroot-mj [data-tog="revives"]'); await p.waitForTimeout(120);
      check(/"revives available: 0"/.test(await out()), "regex forge emits the 0-revives block when toggled");
      // toggle "Corrupted only" -> the corrupted block appears
      await p.click('.toolroot-mj [data-tog="corrupt"]'); await p.waitForTimeout(120);
      check(/"corrupted"/.test(await out()), "regex forge emits the corrupted block when toggled");
      // dump default: keeps are now DERIVED from the live market curve at a chaos cutoff
      // (~2.5× baseline). Every value stat that can clear the cutoff gets a !keep block —
      // Monster Effectiveness especially (it was wrongly OFF before, dumping ~div stones).
      await p.click('.toolroot-mj [data-wmatch="dump"]'); await p.waitForTimeout(150);
      const dump = await out();
      check(/"corrupted"/.test(dump) && /revives available: 0/.test(dump) && /!monster effectiveness:/.test(dump) && /!item rarity:/.test(dump) && /!drop chance:/.test(dump), "regex forge dump derives value keeps from the curve (Effectiveness/Rarity/Drop present)");
      // Cutoff control: crank it far above every stat's peak -> no value stat can clear it,
      // so all value keeps drop out, leaving only corrupted + revives + the flat Drop sustain keep.
      await p.evaluate(() => { const i = document.querySelector('.toolroot-mj [data-cutin]'); i.value = "200"; i.dispatchEvent(new Event("change", { bubbles: true })); });
      await p.waitForTimeout(120);
      const dumpHi = await out();
      check(!/item rarity/.test(dumpHi) && !/monster effectiveness/.test(dumpHi) && !/pack size/.test(dumpHi) && /drop chance/.test(dumpHi), "regex forge dump cutoff drops value keeps that can't reach it");
      // back to a sane cutoff for the remaining checks
      await p.evaluate(() => { const i = document.querySelector('.toolroot-mj [data-cutin]'); i.value = "5"; i.dispatchEvent(new Event("change", { bubbles: true })); });
      await p.waitForTimeout(120);
      // Drop keep selector: set to 0 -> drop-chance keep drops out of the regex entirely
      await p.evaluate(() => { const i = document.querySelector('.toolroot-mj [data-stepin="dropKeep"]'); i.value = "0"; i.dispatchEvent(new Event("change", { bubbles: true })); });
      await p.waitForTimeout(120);
      check(!/drop chance/.test(await out()), "regex forge dump: Drop keep set to 0 removes drop-chance from the filter");
      await p.click('.toolroot-mj [data-wmatch="floor"]'); await p.waitForTimeout(120);
      // switch to tablets, pick Breach -> just the content keyword (no mods pre-ticked)
      await p.click('.toolroot-mj [data-target="tablets"]'); await p.waitForTimeout(120);
      await p.click('.toolroot-mj [data-chip="breach"]'); await p.waitForTimeout(120);
      const tabBase = await out();
      check(/reach/.test(tabBase) && !/iveblood/i.test(tabBase), "regex forge tablet starts with just the content keyword (no mods pre-ticked)");
      // ticking a desirable mod adds it to the regex
      await p.click('.toolroot-mj [data-mod]'); await p.waitForTimeout(120);
      const tabMod = await out();
      check(tabMod.length > tabBase.length, "regex forge adds a tablet mod when ticked");
      // Tablet Mod Value table renders curated divine values + a "stack" price-check badge
      const tv = await p.evaluate(() => {
        const items = [...document.querySelectorAll(".toolroot-mj #mjAsideT .tvlist .tv-item")];
        const hasDiv = items.some(li => /\bdiv\b/.test(li.textContent));
        const hasStack = items.some(li => /stack/i.test(li.textContent));
        return { count: items.length, hasDiv, hasStack };
      });
      check(tv.count >= 8 && tv.hasDiv && tv.hasStack, "tablet mod-value table shows divine values + price-check (stack) mods");
      await p.close();
    }

    // mobile overflow
    const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await m.route("**/api/currency/overview**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({
      league: "Runes of Aldur", updated: new Date().toISOString(), cached: true,
      items: [{ id: "divine", name: "Divine Orb", ex: 320 }, { id: "exalted", name: "Exalted Orb", ex: 1, base: true }, { id: "chaos", name: "Chaos Orb", ex: 2.4 }],
    }) }));
    const pm = await m.newPage(); await pm.goto(BASE + "/#home", { waitUntil: "domcontentloaded" }); await pm.waitForTimeout(400);
    let mOv = await pm.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    for (const v of ["map-juicer", "rune-picker", "gear-finder", "filter-helper"]) { await pm.click(`[data-view-link="${v}"]`); await pm.waitForTimeout(700); mOv = Math.max(mOv, await pm.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))); }
    check(mOv === 0, "mobile: no horizontal overflow on tool views");
    await m.close();
  } finally { await browser.close(); }
}

(async () => {
  console.log("== PoE Tools smoke test ==\n");
  let spawned = null;
  if (!(await waitUp(1))) {
    console.log("server not up — starting it...");
    spawned = spawn("node", [path.join(ROOT, "server.js")], { stdio: "ignore", detached: false, env: { ...process.env, POE2_NO_OPEN: "1" } });
    if (!(await waitUp(15))) { console.log("could not start server.js"); process.exit(2); }
  }
  try {
    staticChecks();
    await httpChecks();
    // A browser-level flake (e.g. a goto timeout) must degrade to a skip, never
    // crash the run and swallow the summary/exit code.
    try { await browserChecks(); }
    catch (e) { skip("browser checks aborted: " + String(e && e.message || e).split("\n")[0]); }
  } finally {
    if (spawned) spawned.kill();
  }
  console.log(`\n== ${passes} passed, ${fails} failed, ${skips} skipped ==`);
  process.exit(fails ? 1 : 0);
})();

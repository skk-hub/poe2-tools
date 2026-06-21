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
    const dirs = fs.readdirSync(base).filter(d => /^chromium-\d/.test(d)).sort().reverse();
    for (const d of dirs) for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]) { const e = path.join(base, d, sub); if (fs.existsSync(e)) return e; }
  } catch {}
  return undefined;
}

// ---- 1) static checks ----
function staticChecks() {
  console.log("Static checks:");
  const idx = read("index.html");
  check(/rel="stylesheet" href="theme.css"/.test(idx), "index links theme.css");
  const themeCss = read("theme.css");
  check(/@font-face/.test(themeCss) && !/fonts\.googleapis\.com/.test(themeCss), "theme.css self-hosts fonts (no Google @import)");
  check(["inter", "cinzel", "jetbrains-mono"].every(f => themeCss.includes("/fonts/" + f + ".woff2")), "theme.css references all 3 self-hosted woff2");
  const views = ["home", "craft-pricer", "rune-picker", "gear-search", "map-juicer", "arbitrage"];
  check(views.every(v => idx.includes(`id="${v}"`)), "index has all 6 view sections");
  check(["toolroot-arb", "toolroot-mj", "toolroot-gs", "toolroot-rune"].every(t => idx.includes(t)), "index has all 4 active inline tool roots");
  check(idx.includes('id="fxStrip"') && idx.includes('id="fxStripRefresh"'), "home has currency strip + refresh button");
  check(/\.fxchip\.skel/.test(idx) && /@keyframes fxshimmer/.test(idx), "home currency strip has loading-skeleton CSS");
  check(/showSkeleton/.test(read("home.js")), "home.js renders a loading skeleton on first fetch");
  // Home: tool cards replaced by the economy dashboard.
  check(idx.includes('id="econ"') && !/class="tools"/.test(idx) && !/class="tool /.test(idx), "home shows the economy dashboard (tool cards removed)");
  check(/api\/economy\/history/.test(read("home.js")) && /lineChart/.test(read("home.js")), "home.js draws the economy chart from /api/economy/history");
  check(idx.includes('id="freshRunes"'), "rune-picker has a Fetch fresh prices button");
  check(/forceFresh\s*:/.test(read("rune-picker.js")), "rune-picker.js sends forceFresh to the API");
  check(/being rebuilt/i.test(idx) && !idx.includes('id="cpGrid"'), "craft-pricer is a blanked placeholder (no cpGrid)");
  check(!/coming-soon/i.test(idx) && !/more tools/i.test(idx) && !/farming notes/i.test(idx), "More Tools + hallucinated placeholder pages removed");
  check(!/@scope\s*\(/.test(idx), "no @scope rules left (browser-portable scoping)");
  check(!/<iframe/.test(idx), "no iframes left (true inline views)");
  // every index inline <script> parses
  const scripts = [...idx.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  check(scripts.length > 0 && scripts.every((s, i) => parses(s, "index script #" + (i + 1))), "index inline scripts parse");
  const toolJs = ["arbitrage.js", "map-juicer.js", "gear-search.js", "rune-picker.js", "craft-pricer.js", "home.js"];
  for (const f of toolJs) check(parses(read(f), f), f + " parses");
  check(["arbitrage.css", "map-juicer.css", "gear-search.css", "rune-picker.css", "craft-pricer.css"].every(c => idx.includes(`href="${c}"`)), "index links all 5 tool stylesheets");
  check(toolJs.every(j => idx.includes(`src="${j}"`)), "index loads all 6 view scripts");
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
  for (const [f, hash] of [["arbitrage-scanner.html", "#arbitrage"], ["waystone-juicer.html", "#map-juicer"], ["character-upgrades.html", "#gear-search"]]) {
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
    check(true, "filter helper hides = not-shown, never over-scans (filter-helper-test.js)");
  } catch {
    check(false, "filter helper hides = not-shown, never over-scans (filter-helper-test.js)");
  }
}

// ---- 2) HTTP checks ----
async function httpChecks() {
  console.log("HTTP checks:");
  for (const [p, type] of [["/", "html"], ["/theme.css", "css"], ["/arbitrage.css", "css"], ["/map-juicer.css", "css"], ["/gear-search.css", "css"], ["/rune-picker.css", "css"], ["/craft-pricer.css", "css"], ["/arbitrage.js", "javascript"], ["/map-juicer.js", "javascript"], ["/gear-search.js", "javascript"], ["/rune-picker.js", "javascript"], ["/craft-pricer.js", "javascript"], ["/home.js", "javascript"], ["/waystone-data.js", "javascript"], ["/arbitrage-scanner.html", "html"], ["/fonts/inter.woff2", "font/woff2"], ["/fonts/cinzel.woff2", "font/woff2"], ["/fonts/jetbrains-mono.woff2", "font/woff2"]]) {
    const r = await get(BASE + p); check(r.status === 200 && r.type.includes(type), `GET ${p} -> 200 ${type}`);
  }
  const ts = await get(BASE + "/api/trade-status"); check(ts.status === 200 && ts.body.includes("limited"), "GET /api/trade-status -> 200 JSON");
  const co = await get(BASE + "/api/currency/overview?league=Runes%20of%20Aldur"); check(co.status === 200 && /"items"/.test(co.body), "GET /api/currency/overview -> 200 JSON (items)");
}

// ---- 3) browser checks ----
async function browserChecks() {
  console.log("Browser checks:");
  const pw = loadPlaywright();
  if (!pw) { skip("Playwright not found; browser checks skipped"); return; }
  const exe = chromiumExe();
  let browser;
  try { browser = await pw.chromium.launch({ headless: true, executablePath: exe }); }
  catch (e) { skip("Chromium launch failed (" + e.message.split("\n")[0] + "); browser checks skipped"); return; }
  try {
    // desktop walk: every view, no errors / overflow / iframes
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errs = []; page.on("pageerror", e => errs.push(e.message)); page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    await page.goto(BASE + "/#home", { waitUntil: "networkidle" });
    let maxOv = 0, ifr = 0;
    for (const v of ["gear-search", "map-juicer", "arbitrage", "rune-picker", "craft-pricer", "home"]) {
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
    for (const [hash, sel, what] of [["#gear-search", "#gear-search #preview, #gear-search pre", "query preview"], ["#map-juicer", ".toolroot-mj .regexbox", "regex rows"]]) {
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

    // arbitrage RESULT TABLE styling, with mocked rows (the exchange has no real arbitrage)
    {
      const p = await browser.newPage({ viewport: { width: 1366, height: 900 } });
      await p.route("**/api/arbitrage/scan", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        updated: "now", universe: [{}, {}], opportunities: [
          { name: "Divine Orb", category: "currency", askExPerItem: 125, bidExPerItem: 124, netBidExPerItem: 121, executableItems: 1, spendEx: 125, grossProfitEx: -1, netProfitEx: -4, roiPct: -3.2, buyStock: 400, sellStock: 40, flags: [] },
          { name: "Chaos Orb", category: "currency", askExPerItem: 0.3, bidExPerItem: 0.29, netBidExPerItem: 0.28, executableItems: 300, spendEx: 90, grossProfitEx: -3, netProfitEx: -6, roiPct: -6.6, buyStock: 9000, sellStock: 800, flags: ["thin-stock"] },
        ], errors: [] }) }));
      await p.goto(BASE + "/index.html#arbitrage", { waitUntil: "networkidle" }); await p.waitForTimeout(800);
      await p.click("#scanBtn"); await p.waitForTimeout(400);
      const tbl = await p.evaluate(() => {
        const t = document.querySelector("#abResults .tablewrap table"); if (!t) return null;
        const rows = t.querySelectorAll("tbody tr");
        const th = t.querySelector("th");
        const r1 = rows[0] && getComputedStyle(rows[0]).backgroundColor;
        const r2 = rows[1] && getComputedStyle(rows[1]).backgroundColor;
        return { rows: rows.length, thSticky: th && getComputedStyle(th).position === "sticky", zebra: r1 !== r2 };
      });
      check(tbl && tbl.rows === 2, "arbitrage table renders rows (mocked data)");
      check(tbl && tbl.thSticky, "arbitrage table: sticky header applied");
      check(tbl && tbl.zebra, "arbitrage table: zebra striping applied");
      await p.close();
    }

    // arbitrage empty state shows near-miss spreads (no opportunities cleared filters)
    {
      const p = await browser.newPage({ viewport: { width: 1366, height: 900 } });
      await p.route("**/api/arbitrage/scan", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        updated: "now", universe: [{}, {}], opportunities: [], errors: [],
        nearMiss: [
          { name: "Divine Orb", category: "currency", askExPerItem: 150, bidExPerItem: 148, netProfitEx: -2.5, roiPct: -1.7 },
          { name: "Chaos Orb", category: "currency", askExPerItem: 5, bidExPerItem: 4.9, netProfitEx: -6, roiPct: -2.1 },
        ],
      }) }));
      await p.goto(BASE + "/index.html#arbitrage", { waitUntil: "networkidle" }); await p.waitForTimeout(800);
      await p.click("#scanBtn"); await p.waitForTimeout(400);
      const nm = await p.evaluate(() => {
        const t = document.querySelector("#abResults .nearmiss table"); if (!t) return null;
        return { rows: t.querySelectorAll("tbody tr").length, head: !!document.querySelector("#abResults .nearmiss-head") };
      });
      check(nm && nm.rows === 2 && nm.head, "arbitrage empty state shows near-miss spreads");
      await p.close();
    }

    // gear-search empty state DIAGNOSES an over-strict (total=0) search
    {
      const p = await browser.newPage({ viewport: { width: 1366, height: 900 } });
      await p.route("**/api/gear-search/search", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        slot: "bow", total: 0, fetched: 0, listings: [], url: "https://www.pathofexile.com/trade2/search/poe2/x",
        statFilters: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], compositeFilters: [], unsupportedFilters: [],
        query: { query: {} }, tradeStatus: { limited: false },
      }) }));
      await p.goto(BASE + "/index.html#gear-search", { waitUntil: "networkidle" }); await p.waitForTimeout(800);
      await p.evaluate(() => { document.getElementById("matchMode").value = "count"; document.getElementById("minMatches").value = "3"; });
      await p.click("#searchBtn"); await p.waitForTimeout(400);
      const diag = await p.evaluate(() => { const e = document.querySelector("#results .empty"); return e ? e.textContent : ""; });
      check(/too strict/i.test(diag) && /Match at least N/i.test(diag) && /3 of 4/.test(diag), "gear-search empty state diagnoses over-strict search");
      await p.close();
    }

    // Home currency strip (mocked overview): chips render + refresh re-fetches
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      let hits = 0;
      await p.route("**/api/currency/overview**", route => { hits++; route.fulfill({ contentType: "application/json", body: JSON.stringify({
        league: "Runes of Aldur", updated: new Date().toISOString(), cached: true,
        items: [{ id: "divine", name: "Divine Orb", ex: 320, icon: "https://web.poecdn.com/divine.png" }, { id: "exalted", name: "Exalted Orb", ex: 1, base: true, icon: "https://web.poecdn.com/ex.png" }, { id: "chaos", name: "Chaos Orb", ex: 2.4, icon: "https://web.poecdn.com/chaos.png" }],
      }) }); });
      await p.goto(BASE + "/index.html#home", { waitUntil: "networkidle" }); await p.waitForTimeout(600);
      const strip = await p.evaluate(() => { const s = document.getElementById("fxStrip"); const c = document.getElementById("fxStripChips"); const h = document.getElementById("homePriceStatus"); return { shown: s && !s.hidden, chips: c ? c.children.length : 0, icons: c ? c.querySelectorAll("img.fxicon").length : 0, hero: h ? h.textContent : "" }; });
      check(strip.shown && strip.chips === 3, "home currency strip renders chips from cache");
      check(strip.icons === 3, "home currency chips render currency icons");
      check(/^320\s*ex/.test(strip.hero), "home hero stat shows live Divine price");
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
      await p.waitForTimeout(350);
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
      await p.goto(BASE + "/index.html#home", { waitUntil: "networkidle" }); await p.waitForTimeout(500);
      const empty = await p.evaluate(() => { const s = document.getElementById("fxStrip"); const m = document.getElementById("fxStripMeta"); const r = document.getElementById("fxStripRefresh"); return { shown: s && !s.hidden, meta: m ? m.textContent : "", hasRefresh: !!(r && r.offsetParent !== null) }; });
      check(empty.shown && empty.hasRefresh && /retry/i.test(empty.meta), "home currency strip stays visible + retryable when rates unavailable");
      await p.close();
    }

    // Craft Pricer blanked: opening it shows the rebuild placeholder, no script error
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errs = [];
      p.on("pageerror", e => errs.push(String(e)));
      await p.goto(BASE + "/index.html#craft-pricer", { waitUntil: "networkidle" }); await p.waitForTimeout(700);
      const note = await p.evaluate(() => { const n = document.querySelector("#craft-pricer .rebuild-note"); return { shown: !!(n && n.offsetParent !== null), grid: !!document.querySelector("#cpGrid") }; });
      check(note.shown && !note.grid && errs.length === 0, "craft-pricer shows the rebuild placeholder (no grid, no error)");
      await p.close();
    }

    // Regex Forge: %-aware floor by default, steppers rebuild it, toggle adds the 0-revives block
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.goto(BASE + "/index.html#map-juicer", { waitUntil: "networkidle" }); await p.waitForTimeout(900);
      const out = () => p.evaluate(() => document.querySelector(".toolroot-mj .forge-out .regexbox").textContent);
      check(/\\\+\(\[6-9\]\.\|1\.\.\)%/.test(await out()), "regex forge default is the %-aware floor (Rarity ≥60% range)");
      // step Min Item Rarity down twice (60 -> 50 -> 40) -> range becomes [4-9]
      await p.click('.toolroot-mj [data-step="rarity"][data-dir="-1"]'); await p.waitForTimeout(120);
      await p.click('.toolroot-mj [data-step="rarity"][data-dir="-1"]'); await p.waitForTimeout(120);
      check(/\\\+\(\[4-9\]\.\|1\.\.\)%/.test(await out()), "regex forge stepper rebuilds the regex (Rarity 40%)");
      // step Min Waystone Drop up once (0 -> 10) -> its token joins the OR floor
      await p.click('.toolroot-mj [data-step="wdrop"][data-dir="1"]'); await p.waitForTimeout(120);
      check(/w\.\+e:/.test(await out()), "regex forge adds the waystone-drop stat when stepped above 0");
      // toggle "fully juiced" -> the 0-revives block appears in the live output
      await p.click('.toolroot-mj [data-tog="revives"]'); await p.waitForTimeout(120);
      check(/"revives available: 0"/.test(await out()), "regex forge emits the 0-revives block when toggled");
      // switch to tablets, pick Breach -> content keyword + its pre-picked desirable mods
      await p.click('.toolroot-mj [data-target="tablets"]'); await p.waitForTimeout(120);
      await p.click('.toolroot-mj [data-chip="breach"]'); await p.waitForTimeout(120);
      const tab = await out();
      check(/reach/.test(tab) && /ombgift/.test(tab), "regex forge builds a tablet regex with the content's desirable mods");
      await p.close();
    }

    // mobile overflow
    const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pm = await m.newPage(); await pm.goto(BASE + "/#home", { waitUntil: "networkidle" }); await pm.waitForTimeout(400);
    let mOv = await pm.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    for (const v of ["craft-pricer", "gear-search", "map-juicer", "arbitrage", "rune-picker"]) { await pm.click(`[data-view-link="${v}"]`); await pm.waitForTimeout(700); mOv = Math.max(mOv, await pm.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))); }
    check(mOv === 0, "mobile: no horizontal overflow on tool views");
    await m.close();
  } finally { await browser.close(); }
}

(async () => {
  console.log("== PoE Tools smoke test ==\n");
  let spawned = null;
  if (!(await waitUp(1))) {
    console.log("server not up — starting it...");
    spawned = spawn("node", [path.join(ROOT, "server.js")], { stdio: "ignore", detached: false });
    if (!(await waitUp(15))) { console.log("could not start server.js"); process.exit(2); }
  }
  try {
    staticChecks();
    await httpChecks();
    await browserChecks();
  } finally {
    if (spawned) spawned.kill();
  }
  console.log(`\n== ${passes} passed, ${fails} failed, ${skips} skipped ==`);
  process.exit(fails ? 1 : 0);
})();

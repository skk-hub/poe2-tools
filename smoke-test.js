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
  const views = ["home", "craft-pricer", "rune-picker", "gear-search", "map-juicer", "arbitrage", "coming-soon"];
  check(views.every(v => idx.includes(`id="${v}"`)), "index has all 7 view sections");
  check(["toolroot-arb", "toolroot-mj", "toolroot-gs", "toolroot-rune", "toolroot-cp"].every(t => idx.includes(t)), "index has all 5 inline tool roots");
  check(idx.includes('id="fxStrip"') && idx.includes('id="fxStripRefresh"'), "home has currency strip + refresh button");
  check(idx.includes('id="cpGrid"') && idx.includes('id="cpRefresh"'), "craft-pricer rebuilt (grid + refresh, not placeholder)");
  check(!/being rebuilt/i.test(idx), "craft-pricer placeholder text removed");
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
  check(/async function getExchangeData/.test(srv) && /async function getExchangeRates/.test(srv), "server has the unified Trade2 exchange-rate provider");
  check(!/await fetchCurrencyRates\(/.test(srv), "no poe.ninja fetchCurrencyRates calls remain (currency unified on Trade2)");
  check(/iconsById/.test(srv), "server resolves currency icons from Trade2 static data");
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
    for (const v of ["gear-search", "map-juicer", "arbitrage", "rune-picker", "craft-pricer", "coming-soon", "home"]) {
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
    for (const [hash, sel, what] of [["#gear-search", "#gear-search #preview, #gear-search pre", "query preview"], ["#map-juicer", "#tabs .tab", "content tabs"]]) {
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
      await p.click("#checkRunes"); await p.waitForTimeout(600);
      const msg = await p.evaluate(() => (document.getElementById("runeStatus") || {}).textContent || "");
      check(/Paste item names/i.test(msg), "Rune Picker wired (empty check shows guard message)");
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

    // Craft Pricer rebuilt: opening it renders the route cards (static, no network needed)
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.goto(BASE + "/index.html#craft-pricer", { waitUntil: "networkidle" }); await p.waitForTimeout(900);
      const cards = await p.evaluate(() => document.querySelectorAll(".toolroot-cp #cpGrid .card").length);
      check(cards >= 6, "craft-pricer renders the route cards (" + cards + ")");
      await p.close();
    }

    // Map Juicer regex: %-aware run regex + 0-revives, and threshold select updates it
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await p.goto(BASE + "/index.html#map-juicer", { waitUntil: "networkidle" }); await p.waitForTimeout(900);
      const rx = await p.evaluate(() => [...document.querySelectorAll(".toolroot-mj .regexbox")].map(e => e.textContent));
      const blob = rx.join("\n");
      check(/\\\+\(\[6-9\]\.\|1\.\.\)%/.test(blob), "map-juicer run regex is %-aware (Rarity ≥60% range)");
      check(/"revives available: 0"/.test(blob), "map-juicer emits the 0-revives regex");
      // change Min Item Rarity to 40 -> regex range becomes [4-9]
      await p.selectOption(".toolroot-mj #rxRarity", "40"); await p.waitForTimeout(300);
      const rx40 = await p.evaluate(() => [...document.querySelectorAll(".toolroot-mj .regexbox")].map(e => e.textContent).join("\n"));
      check(/\\\+\(\[4-9\]\.\|1\.\.\)%/.test(rx40), "map-juicer threshold select rebuilds the regex");
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

window.__viewInit = window.__viewInit || {};
window.__viewInit["gear-finder"] = function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    mode: $("gfMode"), builds: $("gfBuilds"), load: $("gfLoad"), folderRow: $("gfFolderRow"),
    saved: $("gfSaved"), savedRow: $("gfSavedRow"), loadSaved: $("gfLoadSaved"), delSaved: $("gfDelSaved"),
    code: $("gfCode"), importBtn: $("gfImport"), paste: $("gfPaste"), saveName: $("gfSaveName"), saveBuild: $("gfSaveBuild"), saveRow: $("gfSaveRow"),
    build: $("gfBuild"), slots: $("gfSlots"),
    panel: $("gfSearchPanel"), slot: $("gfSlot"), budget: $("gfBudget"), analyze: $("gfAnalyze"),
    status: $("gfStatus"), weights: $("gfWeights"),
    actions: $("gfActions"), realRankBtn: $("gfRealRank"), realOut: $("gfRealOut"), copyQuery: $("gfCopyQuery"), bookmarklet: $("gfBookmarklet"), showSnippet: $("gfShowSnippet"), basicBtn: $("gfBasic"), snippetBox: $("gfSnippetBox"),
    item: $("gfItem"), scoreBtn: $("gfScoreBtn"), scoreOut: $("gfScoreOut"),
    pins: $("gfPins"), pinCount: $("gfPinCount"), pinBody: $("gfPinBody"),
  };
  const PINS_KEY = "poe2.gearFinder.pins";
  const loadPins = () => { try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; } };
  const savePins = () => { try { localStorage.setItem(PINS_KEY, JSON.stringify(state.pinned)); } catch {} };
  const prettyStat = (k) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  // One-time bookmarklet: reads the {league,query} you copied and runs the
  // weighted search in your logged-in pathofexile.com session. Static, so it's
  // dragged to the bookmarks bar once; "Copy search" supplies the per-slot query.
  const BOOKMARKLET = `javascript:(async()=>{try{let t='';try{t=await navigator.clipboard.readText()}catch(_){alert('Could not read the clipboard. Allow clipboard permission for this page (or use the console snippet).');return}let c=null;try{c=JSON.parse(t)}catch(_){}if(!c||!c.query){alert('No PoB search on the clipboard.\\n\\nIn PoE Tools: Analyze a slot, click "Copy search", then click this bookmark — and do not copy anything in between.');return}const L=encodeURIComponent(c.league||'Runes of Aldur');const r=await fetch('/api/trade2/search/poe2/'+L,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(c.query)});const d=await r.json();if(d.id){location.href='/trade2/search/poe2/'+L+'/'+d.id}else{alert('Trade rejected the search: '+JSON.stringify(d).slice(0,300))}}catch(e){alert('PoB Search: '+e.message)}})()`;
  if (els.bookmarklet) els.bookmarklet.href = BOOKMARKLET;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Math.round(n * 10) / 10;
  const ehpOf = (s) => (s && s.TotalEHP) || 0;
  const dpsOf = (s) => (s && (s.FullDPS || s.CombinedDPS || s.TotalDPS)) || 0;
  const deltaSpan = (d, unit) => { const c = d > 0 ? "up" : d < 0 ? "down" : "flat"; return `<span class="gf-delta ${c}">${d > 0 ? "+" : ""}${fmt(d)} ${unit}</span>`; };

  const state = { xml: null, slots: {}, headless: false, curSlot: null, weights: [], query: null, league: "Runes of Aldur", realSearchUrl: "", realCands: [], pinned: [] };
  state.pinned = loadPins();

  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return r.json();
  }
  function setStatus(t, err) { els.status.className = "status" + (err ? " err" : ""); els.status.textContent = t || ""; }

  async function copyText(txt) {
    if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(txt); return true; } catch {} }
    const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta); return ok;
  }

  async function loadBuildsList() {
    const d = await api("/api/gear/builds").catch(() => null);
    if (!d) return;
    state.headless = !!d.headless;
    els.mode.className = "gf-badge " + (d.headless ? "live" : "fallback");
    els.mode.textContent = d.headless ? "Headless DPS" : "Stat-only (no PoB)";
    els.builds.innerHTML = (d.builds || []).map((b) => `<option value="${esc(b.file)}">${esc(b.name)}</option>`).join("");
    els.folderRow.hidden = !(d.builds || []).length;   // PoB-folder picker only useful where the server sees the Builds dir
    refreshSaved();
  }

  // Named build saves in this browser (localStorage) — so you don't re-paste the
  // PoB code every visit. Stores the parsed build XML under a name.
  const SAVES_KEY = "poe2.gearFinder.builds";
  const loadSaves = () => { try { return JSON.parse(localStorage.getItem(SAVES_KEY) || "{}"); } catch { return {}; } };
  const persistSaves = (o) => { try { localStorage.setItem(SAVES_KEY, JSON.stringify(o)); } catch {} };
  function refreshSaved() {
    const saves = loadSaves();
    const names = Object.keys(saves).sort((a, b) => a.localeCompare(b));
    els.saved.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    els.savedRow.hidden = !names.length;
    if (els.paste) els.paste.open = !names.length && els.folderRow.hidden;  // first visit → open the paste box
  }

  function renderBuild(d) {
    if (d.error) { setStatus(d.error, true); return; }
    state.xml = d.xml; state.slots = d.slots || {};
    els.saveRow.hidden = false;
    const b = (d.headless && d.headless.stats) || d.build || {};
    const tiles = [["Life", b.Life], ["Energy Shield", b.EnergyShield], ["EHP", ehpOf(b) || b.TotalEHP],
      ["DPS", (b.FullDPS || b.CombinedDPS || b.TotalDPS)], ["Fire", b.FireResist], ["Cold", b.ColdResist],
      ["Light", b.LightningResist], ["Chaos", b.ChaosResist]].filter(([, v]) => v != null);
    els.build.innerHTML = tiles.map(([k, v]) => `<span class="gf-stat">${k} <b>${fmt(v)}</b></span>`).join("");
    els.slots.innerHTML = Object.entries(state.slots).map(([id, s]) =>
      `<button class="gf-slot" type="button" data-slot="${esc(id)}">${esc(id)}<span class="gf-slot-name">${esc(s.name || "—")}</span></button>`).join("");
    els.panel.hidden = true; setStatus("");
  }

  // Comparison board: pinned candidates (persisted), each with an old-vs-new stat diff.
  function renderPins() {
    const pins = state.pinned || [];
    if (els.pinCount) els.pinCount.textContent = pins.length;
    if (els.pins) els.pins.hidden = !pins.length;
    if (!els.pinBody) return;
    els.pinBody.innerHTML = pins.map((p, i) => {
      const price = p.priceDiv ? `${fmt(p.priceDiv)} div` : `${fmt(p.priceEx || 0)} ex`;
      const keys = Array.from(new Set([...Object.keys(p.oldStats || {}), ...Object.keys(p.newStats || {})])).sort();
      const rows = keys.map((k) => {
        const o = Math.round(Number((p.oldStats || {})[k]) || 0), n = Math.round(Number((p.newStats || {})[k]) || 0);
        if (!o && !n) return "";
        const d = n - o, cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
        return `<tr><td>${esc(prettyStat(k))}</td><td>${o || "—"}</td><td>${n || "—"}</td><td class="gf-delta ${cls}">${d > 0 ? "+" : ""}${d || ""}</td></tr>`;
      }).join("");
      return `<div class="gf-pincard">
        <div class="gf-pinhead"><b>${esc(p.slotName || p.slot)}</b> ${esc(p.name || "Item")} <span class="gf-price">${price}</span> ${p.metricDps ? deltaSpan(p.dDPS, "DPS") : ""} ${deltaSpan(p.dEHP, "EHP")}<button type="button" class="gf-unpin" data-i="${i}" title="remove">✕</button></div>
        <table class="gf-pintable"><thead><tr><th>Stat</th><th>Was</th><th>Now</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join("");
  }

  function selectSlot(id) {
    state.curSlot = id; state.weights = []; state.query = null;
    els.slots.querySelectorAll(".gf-slot").forEach((b) => b.classList.toggle("on", b.dataset.slot === id));
    els.slot.textContent = id + " — " + ((state.slots[id] && state.slots[id].name) || "");
    els.panel.hidden = false; els.weights.innerHTML = ""; els.actions.hidden = true; els.snippetBox.hidden = true;
    els.item.value = ""; els.scoreOut.innerHTML = "";
    setStatus("Set a budget and analyze this slot — or paste an item below to score it directly.");
  }

  // Exact build impact of a pasted item (or items), straight from headless PoB.
  async function scoreItems() {
    if (!state.curSlot || !state.xml) { return; }
    const text = (els.item.value || "").trim();
    if (!text) { els.scoreOut.textContent = "Paste an item first."; return; }
    const blocks = text.split(/(?=Item Class:)/i).map((b) => b.trim()).filter(Boolean);
    const items = (blocks.length ? blocks : [text]).slice(0, 5).map((b) => ({ raw: b, name: ((b.match(/Rarity:[^\n]*\n([^\n]+)/i) || [])[1] || "Pasted item").trim() }));
    els.scoreBtn.disabled = true; els.scoreOut.textContent = "Checking with Path of Building…";
    const sl = state.slots[state.curSlot] || {};
    const d = await api("/api/gear/score", { buildXml: state.xml, slot: state.curSlot, pobSlot: sl.pobSlot, current: { raw: sl.raw }, items }).catch((e) => ({ error: String(e) }));
    els.scoreBtn.disabled = false;
    if (d.available === false) { els.scoreOut.textContent = "Headless Path of Building isn't available."; return; }
    if (d.error) { els.scoreOut.textContent = "Failed: " + d.error; return; }
    const hasDps = dpsOf(d.base) > 0;
    els.scoreOut.innerHTML = (d.results || []).map((r) => {
      if (r.error || !r.stats) return `<div class="gf-srow">${esc(r.name)} — <span class="gf-delta down">${esc((r.error || "couldn't read this item").replace(/^pob:\s*/, ""))}</span></div>`;
      const dD = dpsOf(r.stats) - dpsOf(d.base), dE = ehpOf(r.stats) - ehpOf(d.base);
      const note = r.approx ? ` <span class="gf-approx">≈ base assumed (copy had no base type) — DPS accurate, EHP rough</span>` : "";
      return `<div class="gf-srow"><b>${esc(r.name)}</b> ${hasDps ? deltaSpan(dD, "DPS") : ""} ${deltaSpan(dE, "EHP")}${note}</div>`;
    }).join("") || "No items parsed.";
  }

  async function analyzeSlot() {
    const id = state.curSlot; if (!id) return;
    els.analyze.disabled = true; setStatus("Asking Path of Building what this slot is worth…");
    const d = await api("/api/gear/weights", {
      buildXml: state.xml, slot: id, pobSlot: state.slots[id] && state.slots[id].pobSlot,
      current: { raw: state.slots[id] && state.slots[id].raw }, maxPriceDiv: Number(els.budget.value) || 0, league: state.league,
    }).catch((e) => ({ error: String(e) }));
    els.analyze.disabled = false;
    if (d.error) { setStatus("Failed: " + d.error, true); return; }
    if (d.available === false) { setStatus("Headless Path of Building isn't available — install PoB + LuaJIT for build-weighted search.", true); return; }
    state.weights = d.weights || []; state.query = d.query; state.league = d.league || state.league;
    renderWeights(d);
  }

  function renderWeights(d) {
    if (!state.weights.length) { setStatus("Nothing improves this build's " + (d.metric || "stats") + " on this slot.", true); els.actions.hidden = true; return; }
    const max = state.weights[0].weight || 1;
    const metricTxt = d.metric === "dps" ? "DPS" : "survivability (EHP — this build has no active skill set)";
    els.weights.innerHTML = `<p class="gf-metric">For your build, a better <b>${esc(state.curSlot)}</b> is ranked by <b>${metricTxt}</b>. Highest-value stats:</p>` +
      state.weights.map((w) => `<div class="gf-wrow"><span class="gf-wlabel">${esc(w.label || w.key)}</span><span class="gf-wbar"><span style="width:${Math.round((w.weight / max) * 100)}%"></span></span><span class="gf-wval">×${w.weight}</span></div>`).join("");
    els.actions.hidden = false; els.snippetBox.hidden = true;
    setStatus("");
  }

  // Rank by REAL DPS: fetch in-budget candidates and score each in PoB.
  async function realRank() {
    if (!state.curSlot || !state.weights.length) { setStatus("Analyze the slot first.", true); return; }
    const cur = (state.slots[state.curSlot] && state.slots[state.curSlot].stats) || {};
    // Floor at 70% of current rolls, not 100% — a near-BIS item rarely beats itself on
    // every top stat at once, so requiring ≥ current returns nothing. PoB ΔDPS sorts the rest.
    const mods = state.weights.slice(0, 4).map((w) => ({ statId: w.statId, min: Math.max(1, Math.floor((cur[w.key] || 1) * 0.7)) }));
    els.realRankBtn.disabled = true; els.realOut.innerHTML = ""; setStatus("Fetching candidates and scoring them in Path of Building…");
    const d = await api("/api/gear/realrank", { buildXml: state.xml, slot: state.curSlot, pobSlot: state.slots[state.curSlot] && state.slots[state.curSlot].pobSlot, mods, weights: state.weights.slice(0, 8), maxPriceDiv: Number(els.budget.value) || 0, league: state.league }).catch((e) => ({ error: String(e) }));
    els.realRankBtn.disabled = false;
    if (d.available === false) { setStatus("Headless PoB isn't available.", true); return; }
    if (d.limited) { setStatus("Trade2 is rate-limited — try again shortly.", true); return; }
    if (d.error) { setStatus("Failed: " + d.error, true); return; }
    const cands = d.candidates || [];
    if (!cands.length) { setStatus("No listings matched on your top stats — your current rolls may already be near best-in-slot for this slot.", false); return; }
    const hasDps = d.baseDps > 0;
    state.realHasDps = hasDps;
    state.realSearchUrl = d.searchUrl || "";   // fallback when an item lacks base/account
    state.realCands = cands;                   // referenced by the value-check + pin handlers
    // Best value = most gain (DPS, else EHP) per exalted spent, among upgrades. Free —
    // we already have real gain + price for every candidate, no extra trade call.
    const gainOf = (c) => (hasDps ? c.dDPS : c.dEHP);
    // ROI = gain per divine spent. Compact (k/M) since cheap items give huge ratios.
    const roi = (c) => (gainOf(c) > 0 && c.priceDiv > 0 ? gainOf(c) / c.priceDiv : 0);
    const fmtRoi = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : Math.round(v);
    let bestIdx = -1, bestVal = 0;
    cands.forEach((c, i) => { const g = gainOf(c); if (g > 0 && c.priceEx > 0 && g / c.priceEx > bestVal) { bestVal = g / c.priceEx; bestIdx = i; } });
    els.realOut.innerHTML = cands.map((c, i) => {
      const price = c.priceDiv ? `${fmt(c.priceDiv)} div` : `${fmt(c.priceEx || 0)} ex`;
      // No seller-status badge: these are instant-buyout (async) listings, buyable even
      // when the seller is offline, so online/afk/offline would just mislead.
      const r = roi(c);
      const roiHtml = r > 0 ? ` <span class="gf-roi" title="${hasDps ? "DPS" : "EHP"} gained per divine — your ROI">${fmtRoi(r)}/div</span>` : "";
      const best = i === bestIdx ? ` <span class="gf-best" title="most ${hasDps ? "DPS" : "EHP"} per exalted of these upgrades">★ best value</span>` : "";
      // "Best price?" scores cheaper instant-buyout items in PoB — is any as good for less?
      // Only worth it for items costing ≥1 div (cheap ones aren't worth a price hunt).
      const check = (c.mods && c.mods.length && c.priceDiv >= 1 && c.dDPS > 0) ? ` <button type="button" class="gf-check" data-idx="${i}" title="score cheaper instant-buyout items in PoB — is any as good for less?">best price?</button><span class="gf-verdict"></span>` : "";
      const inner = `<button type="button" class="gf-pin" data-idx="${i}" title="pin to the comparison board">📌</button> <b>${esc(c.name || "Item")}</b> ${hasDps ? deltaSpan(c.dDPS, "DPS") : ""} ${deltaSpan(c.dEHP, "EHP")} <span class="gf-price">${price}</span>${roiHtml}${best}${check}`;
      const canOpen = (c.base && c.account) || state.realSearchUrl;
      return `<div class="gf-srow${canOpen ? " gf-srow-link" : ""}"${canOpen ? ' role="link" tabindex="0"' : ""} data-base="${esc(c.base || "")}" data-account="${esc(c.account || "")}">${inner}</div>`;
    }).join("");
    setStatus(`Scored ${d.scored || cands.length} instant-buyout candidates in PoB, showing the top ${cands.length}${d.weighted ? " (best for your build)" : " (price spread — set POESESSID for build-ranked results)"}${d.partial ? " — stopped early on the rate limit" : ""}.`);
  }

  function snippetText() {
    const league = state.league, q = JSON.stringify(state.query);
    return `fetch("/api/trade2/search/poe2/${encodeURIComponent(league)}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(${q})}).then(r=>r.json()).then(d=>{if(d.id){location.href="/trade2/search/poe2/${encodeURIComponent(league)}/"+d.id}else{alert("Search failed: "+JSON.stringify(d))}}).catch(e=>alert(e));`;
  }

  els.load.addEventListener("click", async () => {
    const file = els.builds.value; if (!file) { setStatus("No build selected.", true); return; }
    setStatus("Loading build…"); renderBuild(await api("/api/gear/import", { buildFile: file }));
  });
  els.importBtn.addEventListener("click", async () => {
    const code = (els.code.value || "").trim(); if (!code) { setStatus("Paste a PoB code first.", true); return; }
    setStatus("Importing…"); renderBuild(await api("/api/gear/import", { code }));
  });
  els.saveBuild.addEventListener("click", () => {
    const name = (els.saveName.value || "").trim();
    if (!name) { setStatus("Type a name to save this build.", true); return; }
    if (!state.xml) { setStatus("Import a build first, then save it.", true); return; }
    const saves = loadSaves(); saves[name] = state.xml; persistSaves(saves);
    els.saveName.value = ""; refreshSaved(); els.saved.value = name;
    setStatus(`Saved "${name}" in this browser — pick it from My builds next time.`);
  });
  els.loadSaved.addEventListener("click", async () => {
    const name = els.saved.value, saves = loadSaves();
    if (!name || !saves[name]) { setStatus("No saved build selected.", true); return; }
    setStatus(`Loading "${name}"…`);
    renderBuild(await api("/api/gear/import", { xml: saves[name] }));
  });
  els.delSaved.addEventListener("click", () => {
    const name = els.saved.value, saves = loadSaves();
    if (!name || !saves[name]) return;
    delete saves[name]; persistSaves(saves); refreshSaved();
    setStatus(`Deleted "${name}".`);
  });
  els.slots.addEventListener("click", (e) => { const b = e.target.closest("[data-slot]"); if (b) selectSlot(b.dataset.slot); });
  els.analyze.addEventListener("click", analyzeSlot);
  els.realRankBtn.addEventListener("click", realRank);
  if (els.pinBody) els.pinBody.addEventListener("click", (ev) => {
    const x = ev.target.closest(".gf-unpin"); if (!x) return;
    state.pinned.splice(+x.dataset.i, 1); savePins(); renderPins();
  });
  renderPins();   // restore persisted pins on load
  // Click a scored row → open that exact listing on the trade site. Per-item search by
  // base+account; falls back to the whole search if the item lacks those. Opens a blank
  // tab synchronously (user gesture) so the popup isn't blocked, then redirects it.
  els.realOut.addEventListener("click", async (ev) => {
    // "Check price" → is this the cheapest at its power? (one search + fetch). Handle
    // first so it doesn't also trigger the row's open-listing click.
    // Pin → add to the comparison board (with old-vs-new stats). First, so it doesn't
    // also open the listing.
    const pinBtn = ev.target.closest(".gf-pin");
    if (pinBtn) {
      ev.stopPropagation(); ev.preventDefault();
      const c = state.realCands[+pinBtn.dataset.idx]; if (!c) return;
      const slot = state.curSlot, sl = state.slots[slot] || {};
      const key = (x) => `${x.slot}|${x.name}|${x.priceEx}`;
      const entry = { slot, slotName: sl.name || slot, name: c.name, base: c.base, account: c.account, mods: c.mods, priceDiv: c.priceDiv, priceEx: c.priceEx, dDPS: c.dDPS, dEHP: c.dEHP, metricDps: !!state.realHasDps, oldStats: sl.stats || {}, newStats: c.stats || {} };
      if (!state.pinned.some((p) => key(p) === key(entry))) { state.pinned.push(entry); savePins(); renderPins(); }
      pinBtn.textContent = "✓"; pinBtn.disabled = true; pinBtn.title = "pinned";
      return;
    }
    const chk = ev.target.closest(".gf-check");
    if (chk) {
      ev.stopPropagation(); ev.preventDefault();
      const c = state.realCands[+chk.dataset.idx]; if (!c) return;
      const out = chk.parentElement.querySelector(".gf-verdict");
      chk.disabled = true; out.className = "gf-verdict"; out.textContent = "scoring cheaper options in PoB…";
      const slot = state.curSlot, pobSlot = state.slots[slot] && state.slots[slot].pobSlot;
      // PoB-based: are any CHEAPER instant-buyout items actually this good (real ΔDPS)?
      const d = await api("/api/gear/value-check", { league: state.league, slot, pobSlot, buildXml: state.xml, mods: c.mods, maxPriceDiv: c.priceDiv, targetDDPS: c.dDPS }).catch(() => null);
      if (!d || d.error || d.limited || d.available === false) { chk.disabled = false; out.textContent = d && d.limited ? "rate-limited — retry" : d && d.available === false ? "PoB unavailable" : "check failed"; return; }
      if (d.cheaper) { const cp = d.cheaper.priceDiv ? `${fmt(d.cheaper.priceDiv)} div` : `${fmt(d.cheaper.priceEx || 0)} ex`; out.textContent = `↓ same DPS for ${cp}: ${esc(d.cheaper.name)} — you'd overpay`; out.classList.add("warn"); }
      else if (d.scanned > 0) { out.textContent = `✓ best price — none of ${d.scanned} cheaper items match this DPS`; out.classList.add("good"); }
      else { out.textContent = "✓ nothing cheaper to compare — best price"; out.classList.add("good"); }
      chk.remove();
      return;
    }
    const row = ev.target.closest(".gf-srow-link"); if (!row) return;
    const base = row.dataset.base, account = row.dataset.account;
    if (!base || !account) { if (state.realSearchUrl) window.open(state.realSearchUrl, "_blank", "noopener"); return; }
    const w = window.open("about:blank", "_blank");   // sync open keeps it out of the popup blocker
    const d = await api("/api/gear/item-link", { league: state.league, base, account }).catch(() => null);
    const dest = d && d.url ? d.url : state.realSearchUrl;
    if (dest && w) { try { w.opener = null; } catch {} w.location = dest; }
    else { if (w) w.close(); setStatus(d && d.limited ? "Trade2 rate-limited — try again shortly." : "Couldn't open that listing.", true); }
  });
  els.scoreBtn.addEventListener("click", scoreItems);
  els.copyQuery.addEventListener("click", () => {
    if (!state.query) { setStatus("Analyze a slot first.", true); return; }
    copyText(JSON.stringify({ league: state.league, query: state.query })).then((ok) => {
      els.copyQuery.textContent = ok ? "Copied ✓" : "Copy failed";
      setStatus(ok ? "Copied — now switch to a logged-in pathofexile.com tab and click your ⚡ PoB Trade Search bookmark." : "Copy failed — try the console snippet.");
      setTimeout(() => { els.copyQuery.textContent = "Copy search"; }, 1600);
    });
  });
  els.showSnippet.addEventListener("click", (e) => {
    e.preventDefault();
    if (!state.query) { setStatus("Analyze a slot first.", true); return; }
    const txt = snippetText();
    els.snippetBox.hidden = false;
    els.snippetBox.innerHTML = `<p class="sub">Fallback: open <b>pathofexile.com</b> (logged in), F12 → Console, paste this, Enter:</p><code>${esc(txt)}</code>`;
    copyText(txt);
  });
  els.basicBtn.addEventListener("click", async () => {
    if (!state.curSlot || !state.weights.length) return;
    els.basicBtn.disabled = true; setStatus("Building a basic search (one Trade2 call)…");
    const cur = (state.slots[state.curSlot] && state.slots[state.curSlot].stats) || {};
    const mods = state.weights.slice(0, 4).map((w) => ({ statId: w.statId, min: Math.floor(cur[w.key] || 1) }));
    const d = await api("/api/gear/basic-link", { slot: state.curSlot, league: state.league, mods, maxPriceDiv: Number(els.budget.value) || 0 }).catch((e) => ({ error: String(e) }));
    els.basicBtn.disabled = false;
    if (d.limited) { setStatus("Trade2 is rate-limited — try again shortly.", true); return; }
    if (d.url) { setStatus("Opened a basic search (" + (d.total || 0) + " hits) — sort it yourself."); window.open(d.url, "_blank", "noopener"); }
    else { setStatus("Couldn't build a basic search: " + (d.error || "no results"), true); }
  });

  refreshSaved();
  loadBuildsList();
};

window.__viewInit = window.__viewInit || {};
window.__viewInit["gear-finder"] = function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    mode: $("gfMode"), builds: $("gfBuilds"), load: $("gfLoad"),
    code: $("gfCode"), importBtn: $("gfImport"),
    build: $("gfBuild"), slots: $("gfSlots"),
    panel: $("gfSearchPanel"), slot: $("gfSlot"), budget: $("gfBudget"), analyze: $("gfAnalyze"),
    status: $("gfStatus"), weights: $("gfWeights"),
    actions: $("gfActions"), snippetBtn: $("gfSnippet"), basicBtn: $("gfBasic"), snippetBox: $("gfSnippetBox"),
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Math.round(n * 10) / 10;
  const ehpOf = (s) => (s && s.TotalEHP) || 0;

  const state = { xml: null, slots: {}, headless: false, curSlot: null, weights: [], query: null, league: "Runes of Aldur" };

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
    els.builds.innerHTML = (d.builds || []).map((b) => `<option value="${esc(b.file)}">${esc(b.name)}</option>`).join("")
      || `<option value="">(no saved builds found)</option>`;
  }

  function renderBuild(d) {
    if (d.error) { setStatus(d.error, true); return; }
    state.xml = d.xml; state.slots = d.slots || {};
    const b = (d.headless && d.headless.stats) || d.build || {};
    const tiles = [["Life", b.Life], ["Energy Shield", b.EnergyShield], ["EHP", ehpOf(b) || b.TotalEHP],
      ["DPS", (b.FullDPS || b.CombinedDPS || b.TotalDPS)], ["Fire", b.FireResist], ["Cold", b.ColdResist],
      ["Light", b.LightningResist], ["Chaos", b.ChaosResist]].filter(([, v]) => v != null);
    els.build.innerHTML = tiles.map(([k, v]) => `<span class="gf-stat">${k} <b>${fmt(v)}</b></span>`).join("");
    els.slots.innerHTML = Object.entries(state.slots).map(([id, s]) =>
      `<button class="gf-slot" type="button" data-slot="${esc(id)}">${esc(id)}<span class="gf-slot-name">${esc(s.name || "—")}</span></button>`).join("");
    els.panel.hidden = true; setStatus("");
  }

  function selectSlot(id) {
    state.curSlot = id; state.weights = []; state.query = null;
    els.slots.querySelectorAll(".gf-slot").forEach((b) => b.classList.toggle("on", b.dataset.slot === id));
    els.slot.textContent = id + " — " + ((state.slots[id] && state.slots[id].name) || "");
    els.panel.hidden = false; els.weights.innerHTML = ""; els.actions.hidden = true; els.snippetBox.hidden = true;
    setStatus("Set a budget and analyze this slot.");
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
  els.slots.addEventListener("click", (e) => { const b = e.target.closest("[data-slot]"); if (b) selectSlot(b.dataset.slot); });
  els.analyze.addEventListener("click", analyzeSlot);
  els.snippetBtn.addEventListener("click", () => {
    if (!state.query) return;
    const txt = snippetText();
    els.snippetBox.hidden = false;
    els.snippetBox.innerHTML = `<p class="sub">Open <b>pathofexile.com</b> (logged in), press F12 → Console, paste this, Enter — it opens a search ranked for your build:</p><code>${esc(txt)}</code>`;
    copyText(txt).then((ok) => { els.snippetBtn.textContent = ok ? "Copied ✓" : "Copy failed"; setTimeout(() => { els.snippetBtn.textContent = "Copy logged-in search snippet"; }, 1400); });
  });
  els.basicBtn.addEventListener("click", async () => {
    if (!state.curSlot || !state.weights.length) return;
    els.basicBtn.disabled = true; setStatus("Building a basic search (one Trade2 call)…");
    const d = await api("/api/gear/basic-link", { slot: state.curSlot, league: state.league, statIds: state.weights.map((w) => w.statId), maxPriceDiv: Number(els.budget.value) || 0 }).catch((e) => ({ error: String(e) }));
    els.basicBtn.disabled = false;
    if (d.limited) { setStatus("Trade2 is rate-limited — try again shortly.", true); return; }
    if (d.url) { setStatus("Opened a basic search (" + (d.total || 0) + " hits) — sort it yourself."); window.open(d.url, "_blank", "noopener"); }
    else { setStatus("Couldn't build a basic search: " + (d.error || "no results"), true); }
  });

  loadBuildsList();
};

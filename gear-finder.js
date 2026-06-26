window.__viewInit = window.__viewInit || {};
window.__viewInit["gear-finder"] = function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    mode: $("gfMode"), builds: $("gfBuilds"), load: $("gfLoad"),
    code: $("gfCode"), importBtn: $("gfImport"),
    build: $("gfBuild"), slots: $("gfSlots"),
    panel: $("gfSearchPanel"), slot: $("gfSlot"), budget: $("gfBudget"),
    find: $("gfFind"), status: $("gfStatus"), results: $("gfResults"),
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Math.round(n * 10) / 10;
  const dpsOf = (s) => (s && (s.FullDPS || s.CombinedDPS || s.TotalDPS)) || 0;
  const ehpOf = (s) => (s && s.TotalEHP) || 0;

  const state = { xml: null, slots: {}, build: {}, headless: false, base: null, curSlot: null };
  let LEAGUE = "Runes of Aldur";

  async function api(path, body) {
    const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    const r = await fetch(path, opt);
    return r.json();
  }

  function setStatus(t, err) { els.status.className = "status" + (err ? " err" : ""); els.status.textContent = t; }

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
    state.xml = d.xml; state.slots = d.slots || {}; state.build = d.build || {};
    const hs = d.headless && d.headless.stats;
    state.base = hs || null;
    const b = hs || state.build;
    const tiles = [
      ["Life", b.Life], ["Energy Shield", b.EnergyShield], ["EHP", ehpOf(b) || b.TotalEHP],
      ["DPS", dpsOf(b)], ["Fire", b.FireResist], ["Cold", b.ColdResist], ["Light", b.LightningResist], ["Chaos", b.ChaosResist],
    ].filter(([, v]) => v != null);
    els.build.innerHTML = tiles.map(([k, v]) => `<span class="gf-stat">${k} <b>${fmt(v)}</b></span>`).join("");
    els.slots.innerHTML = Object.entries(state.slots).map(([id, s]) =>
      `<button class="gf-slot" type="button" data-slot="${esc(id)}">${esc(id)}<span class="gf-slot-name">${esc(s.name || "—")}</span></button>`).join("");
    els.panel.hidden = true;
    setStatus("");
  }

  function selectSlot(id) {
    state.curSlot = id;
    els.slots.querySelectorAll(".gf-slot").forEach((b) => b.classList.toggle("on", b.dataset.slot === id));
    els.slot.textContent = id + " — " + (state.slots[id] && state.slots[id].name || "");
    els.panel.hidden = false;
    els.results.innerHTML = "";
    setStatus("Set a budget and Find upgrades.");
  }

  // Derive light search filters from the current item's strongest stats so we get
  // comparable-or-better candidates (then headless ranks them by real impact).
  function filtersForSlot(id) {
    const stats = (state.slots[id] && state.slots[id].stats) || {};
    return Object.entries(stats)
      .filter(([k, v]) => typeof v === "number" && v > 0 && !/^total/i.test(k))
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => ({ key: k, value: { min: Math.floor(v * 0.7) } }));
  }

  async function findUpgrades() {
    const id = state.curSlot; if (!id) return;
    els.find.disabled = true;
    setStatus("Searching Trade2…");
    const search = await api("/api/gear/search", {
      league: LEAGUE, slot: id,
      current: { raw: state.slots[id] && state.slots[id].raw },
      filters: filtersForSlot(id), matchMode: "count",
      maxPriceDiv: Number(els.budget.value) || 0,
    }).catch((e) => ({ error: String(e) }));
    els.find.disabled = false;
    if (search.limited) { setStatus("Trade2 is rate-limited — try again shortly.", true); return; }
    if (search.error) { setStatus("Search failed: " + search.error, true); return; }
    const listings = search.listings || [];
    if (!listings.length) { setStatus("No listings under that budget — raise it or loosen the slot."); return; }

    // Headless ranking by real ΔDPS/ΔEHP (falls back to price order if unavailable).
    let base = state.base, byId = {};
    if (state.headless && state.xml) {
      setStatus(`Ranking ${listings.length} candidates in Path of Building…`);
      const rank = await api("/api/gear/rank", {
        buildXml: state.xml, pobSlot: state.slots[id] && state.slots[id].pobSlot, slot: id,
        items: listings.map((l) => ({ id: l.id, raw: l.raw })),
      }).catch(() => ({ available: false }));
      if (rank.available && rank.results) {
        base = rank.base || base;
        for (const r of rank.results) byId[r.id] = r.stats;
      }
    }
    for (const l of listings) {
      const cand = byId[l.id];
      l._dDPS = cand ? dpsOf(cand) - dpsOf(base) : 0;
      l._dEHP = cand ? ehpOf(cand) - ehpOf(base) : 0;
      l._primary = l._dDPS || l._dEHP;
    }
    listings.sort((a, b) => (b._primary - a._primary) || (a.priceDiv || 0) - (b.priceDiv || 0));
    renderResults(listings, !!Object.keys(byId).length);
    setStatus(`${listings.length} candidates` + (Object.keys(byId).length ? " — ranked by real build impact." : " — ranked by price (headless unavailable)."));
  }

  function deltaTag(d, unit) {
    if (!d) return `<span class="gf-delta flat">±0 ${unit}</span>`;
    const cls = d > 0 ? "up" : "down";
    return `<span class="gf-delta ${cls}">${d > 0 ? "+" : ""}${fmt(d)} ${unit}</span>`;
  }

  function renderResults(listings, headless) {
    els.results.innerHTML = listings.map((l) => {
      const price = l.priceDiv ? `${fmt(l.priceDiv)} div` : `${fmt(l.priceEx || 0)} ex`;
      const delta = headless
        ? (dpsOf(state.base) ? deltaTag(l._dDPS, "DPS") : "") + deltaTag(l._dEHP, "EHP")
        : "";
      const cmp = (l.comparison || []).filter((c) => c.delta).slice(0, 6)
        .map((c) => `<span class="${c.delta > 0 ? "up" : "down"}">${esc(c.label || c.key)} ${c.delta > 0 ? "+" : ""}${fmt(c.delta)}</span>`).join("");
      return `<div class="gf-card"><div class="gf-card-head"><span class="gf-name">${esc(l.name || l.typeLine || "Item")}</span><span>${delta} <span class="gf-price">${price}</span></span></div>${cmp ? `<div class="gf-cmp">${cmp}</div>` : ""}</div>`;
    }).join("");
  }

  els.load.addEventListener("click", async () => {
    const file = els.builds.value; if (!file) { setStatus("No build selected.", true); return; }
    setStatus("Loading build…");
    renderBuild(await api("/api/gear/import", { buildFile: file }));
  });
  els.importBtn.addEventListener("click", async () => {
    const code = (els.code.value || "").trim(); if (!code) { setStatus("Paste a PoB code first.", true); return; }
    setStatus("Importing…");
    renderBuild(await api("/api/gear/import", { code }));
  });
  els.slots.addEventListener("click", (e) => { const b = e.target.closest("[data-slot]"); if (b) selectSlot(b.dataset.slot); });
  els.find.addEventListener("click", findUpgrades);

  loadBuildsList();
};

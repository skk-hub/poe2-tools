window.__viewInit = window.__viewInit || {};
window.__viewInit["gear-finder"] = function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    mode: $("gfMode"),
    saved: $("gfSaved"), savedRow: $("gfSavedRow"), myBuilds: $("gfMyBuilds"), loadSaved: $("gfLoadSaved"), delSaved: $("gfDelSaved"),
    code: $("gfCode"), importBtn: $("gfImport"), paste: $("gfPaste"), saveName: $("gfSaveName"), saveBuild: $("gfSaveBuild"), saveBox: $("gfSaveBox"), saveConfirm: $("gfSaveConfirm"),
    build: $("gfBuild"), slots: $("gfSlots"),
    scanRow: $("gfScanRow"), scanAll: $("gfScanAll"), scanMin: $("gfScanMin"), scanOut: $("gfScanOut"),
    panel: $("gfSearchPanel"), slot: $("gfSlot"), budget: $("gfBudget"), budgetMin: $("gfBudgetMin"),
    findBar: $("gfFindBar"), find: $("gfFind"), findHint: $("gfFindHint"), rarityChk: $("gfRarityChk"), rarityVal: $("gfRarityVal"),
    status: $("gfStatus"), weights: $("gfWeights"),
    actions: $("gfActions"), realRankBtn: $("gfRealRank"), realOut: $("gfRealOut"),
    optBreaks: $("gfOptBreaks"), optOut: $("gfOptOut"),
    treeRow: $("gfTreeRow"), treeDepth: $("gfTreeDepth"), treeRun: $("gfTreeRun"), treeHint: $("gfTreeHint"), treeOut: $("gfTreeOut"), preserveBox: $("gfPreserveBox"), preserveRow: $("gfPreserveRow"), preserveLabel: $("gfPreserveLabel"), preserveSub: $("gfPreserveSub"), copyQuery: $("gfCopyQuery"), bookmarklet: $("gfBookmarklet"), showSnippet: $("gfShowSnippet"), basicBtn: $("gfBasic"), snippetBox: $("gfSnippetBox"),
    item: $("gfItem"), scoreBtn: $("gfScoreBtn"), scoreOut: $("gfScoreOut"),
    pins: $("gfPins"), pinCount: $("gfPinCount"), pinBody: $("gfPinBody"),
  };
  const PINS_KEY = "poe2.gearFinder.pins";
  const loadPins = () => { try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; } };
  const savePins = () => { try { localStorage.setItem(PINS_KEY, JSON.stringify(state.pinned)); } catch {} };
  const prettyStat = (k) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  // Tree-jewel slot ids are "jewel<nodeId>" (one per socket) — show "jewel"; the jewel's
  // item name (rendered alongside) is what tells the sockets apart.
  const slotLabel = (id) => /^jewel\d+$/.test(id) ? "jewel" : id;
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

  const state = { xml: null, slots: {}, headless: false, curSlot: null, sel: new Set(), weights: [], metric: "dps", query: null, league: "Runes of Aldur", realSearchUrl: "", realCands: [], preserveOther: false, pinned: [] };
  const isUnique = (raw) => /rarity:\s*unique/i.test(String(raw || ""));
  state.pinned = loadPins();

  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return r.json();
  }
  function setStatus(t, err) { els.status.className = "status" + (err ? " err" : ""); els.status.textContent = t || ""; }

  // Open one listing on the trade site by base+account (per-item link). Opens a blank
  // tab synchronously (keeps it out of the popup blocker), then redirects it.
  async function openItemListing(base, account, fallbackUrl, mods) {
    if (!base || !account) { if (fallbackUrl) window.open(fallbackUrl, "_blank", "noopener"); return; }
    const w = window.open("about:blank", "_blank");
    const d = await api("/api/gear/item-link", { league: state.league, base, account, mods: mods || [] }).catch(() => null);
    const dest = d && d.url ? d.url : fallbackUrl;
    if (dest && w) { try { w.opener = null; } catch {} w.location = dest; }
    else { if (w) w.close(); setStatus(d && d.limited ? "Trade2 is rate-limited — try again shortly." : "Couldn't open that listing.", true); }
  }

  async function copyText(txt) {
    if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(txt); return true; } catch {} }
    const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta); return ok;
  }

  // Only used for the headless-PoB availability badge now (the PoB-folder picker was removed).
  async function loadBuildsList() {
    const d = await api("/api/gear/builds").catch(() => null);
    if (!d) return;
    state.headless = !!d.headless;
    els.mode.className = "gf-badge " + (d.headless ? "live" : "fallback");
    // Show whether POESESSID is active — it's what unlocks the build-value-ranked
    // search (vs price-only, which can only reach the cheapest/priciest listings).
    els.mode.textContent = (d.headless ? "Headless DPS" : "Stat-only (no PoB)") + (d.poesessid ? " · weighted search" : " · price-only (no POESESSID)");
    els.mode.title = d.poesessid ? "Logged-in session active — upgrade search is ranked by your build's value across all price tiers." : "No POESESSID — the search can only see the priciest 100 listings per slot. Put POESESSID=<cookie> in a .env file (project root) to enable the build-value search.";
    refreshSaved();
  }

  // GGG logged out our POESESSID mid-session → realrank fell back to price-ranked.
  // Show it so you know to refresh the cookie (and that it still works, just not value-ranked).
  function markSessionExpired() {
    els.mode.className = "gf-badge fallback";
    els.mode.textContent = (state.headless ? "Headless DPS" : "Stat-only") + " · POESESSID expired";
    els.mode.title = "Your logged-in session expired (GGG logged it out) — the search fell back to price-ranked (still finds upgrades). Click the red 🔑 pill (top bar) to paste a FRESH POESESSID — no restart.";
    if (window.__sessRefresh) window.__sessRefresh();   // turn the top-bar 🔑 pill red
  }

  // The saved-builds row holds two things: "My builds" (only if any saved) and a
  // "Save this build as…" button (only after a build is imported). Show the row when
  // either is present.
  function syncSaveRow() {
    els.savedRow.hidden = els.myBuilds.hidden && els.saveBuild.hidden && els.saveBox.hidden;
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
    els.myBuilds.hidden = !names.length;
    if (els.paste) els.paste.open = !names.length;   // first visit → open the paste box
    syncSaveRow();
  }

  function renderBuild(d) {
    if (d.error) { setStatus(d.error, true); return; }
    state.xml = d.xml; state.slots = d.slots || {};
    els.saveBuild.hidden = false; els.saveBox.hidden = true; syncSaveRow();   // a build is loaded → offer to save it
    const b = (d.headless && d.headless.stats) || d.build || {};
    const tiles = [["Life", b.Life], ["Energy Shield", b.EnergyShield], ["EHP", ehpOf(b) || b.TotalEHP],
      ["DPS", (b.FullDPS || b.CombinedDPS || b.TotalDPS)], ["Fire", b.FireResist], ["Cold", b.ColdResist],
      ["Light", b.LightningResist], ["Chaos", b.ChaosResist], ["Spirit free", b.SpiritUnreserved]].filter(([, v]) => v != null);
    els.build.innerHTML = tiles.map(([k, v]) => `<span class="gf-stat">${k} <b>${fmt(v)}</b></span>`).join("");
    // Stale PoB agent: returns DPS/EHP but no Spirit data → spirit floor + guard silently off,
    // so the scan leaks no-spirit items. Loud banner with the exact fix (it's a split-host
    // pob-agent that wasn't restarted after a bridge change).
    if (d.headless && d.headless.staleAgent) {
      els.build.innerHTML += `<span class="gf-warn gf-warn-stale" title="The headless Path of Building process is out of date — it doesn't report Spirit, so spirit-keep and cap checks can't run. Restart it: pm2 restart pob-agent (on the PC that runs PoB).">⛔ PoB agent is out of date — Spirit/cap checks are OFF. Run <b>pm2 restart pob-agent</b> on your PoB PC.</span>`;
    }
    // Over-reserved spirit (Unreserved < 0) = PoB has more auras toggled on than your Spirit
    // can sustain — usually a fresh import enabling every gem. The build can't run as shown,
    // so its DPS/EHP are INFLATED and every upgrade here is scored against an impossible setup.
    if (Number(b.SpiritUnreserved) < 0) {
      els.build.innerHTML += `<span class="gf-warn" title="Toggle off the auras you don't actually run in Path of Building so the build matches your in-game character, then re-import. Until then, DPS/EHP and spirit-based filtering use an unrunnable aura setup.">⚠ over-reserved spirit by ${fmt(-b.SpiritUnreserved)} — auras exceed your Spirit; DPS/EHP inflated. Fix toggles in PoB &amp; re-import.</span>`;
    }
    els.slots.innerHTML = Object.entries(state.slots).map(([id, s]) =>
      `<button class="gf-slot" type="button" data-slot="${esc(id)}">${esc(slotLabel(id))}<span class="gf-slot-name">${esc(s.name || "—")}</span></button>`).join("");
    els.scanRow.hidden = !Object.keys(state.slots).length;
    state.sel = new Set();
    renderBreaks(b);
    els.findBar.hidden = !Object.keys(state.slots).length;
    els.optOut.innerHTML = "";
    updateFindUI();
    if (els.treeRow) { els.treeRow.hidden = false; els.treeOut.innerHTML = ""; }
    els.panel.hidden = true; setStatus("");
  }

  // Editable breakpoint floors (default to your current build values) — shown in the picker
  // bar only when 2+ slots are selected (the set optimizer holds them).
  function renderBreaks(b) {
    const rar = Math.round(((Number(b.EffectiveLootRarityMod) || 1) - 1) * 100);
    const bk = [["fireRes", "Fire", b.FireResist], ["coldRes", "Cold", b.ColdResist], ["lightRes", "Light", b.LightningResist], ["chaosRes", "Chaos", b.ChaosResist], ["spiritFree", "Spirit free", b.SpiritUnreserved], ["rarityPct", "Rarity %", rar]];
    els.optBreaks.innerHTML = `<div class="gf-opt-bklabel">Breakpoints — every set must stay <b>at or above</b> these. Editable: dial one down to probe what's hidden just under it.</div>`
      + `<div class="gf-opt-bkrow">` + bk.map(([k, label, v]) =>
        `<label class="gf-optbk"><span class="gf-optbk-l">${label}</span><span class="gf-optbk-ge">≥</span><input class="gf-optbkin" data-k="${k}" type="number" value="${Math.round(Number(v) || 0)}" inputmode="numeric"></label>`).join("") + `</div>`;
  }

  // Unified slot picker: click a chip to toggle it. 1 selected → single-slot rank; 2+ → set
  // optimizer (breakpoints shown). One "Find upgrades" button dispatches on the count.
  function toggleSlot(id) {
    if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
    updateFindUI();
  }
  function updateFindUI() {
    const n = state.sel.size;
    els.slots.querySelectorAll(".gf-slot").forEach((b) => b.classList.toggle("on", state.sel.has(b.dataset.slot)));
    els.optBreaks.hidden = n < 2;
    els.findHint.textContent = n === 0 ? "select one or more slots"
      : n === 1 ? "1 slot — ranks the best buyable items for it"
      : (n > 5 ? "pick at most 5 slots for a set" : `${n} slots — optimizes a set holding your breakpoints${n >= 4 ? " (~1–2 min)" : ""}`);
  }
  function optSelected() { return Array.from(state.sel); }
  // User's "Require Item Rarity ≥ N%" — 0 when unchecked. Sent to both search paths so
  // rarity-bearing items actually surface (the search ignores rarity otherwise).
  function rarityMin() { return els.rarityChk && els.rarityChk.checked ? Math.max(1, Number(els.rarityVal.value) || 0) : 0; }

  // "Find upgrades": dispatch on how many slots are selected.
  async function findUpgrades() {
    const n = state.sel.size;
    if (n === 0) { els.findHint.textContent = "select one or more slots"; return; }
    if (n === 1) {
      els.optOut.innerHTML = "";
      selectSlot([...state.sel][0]);
      els.panel.scrollIntoView({ behavior: "smooth", block: "start" });
      await analyzeSlot();
      if (state.weights.length) await realRank();
      return;
    }
    els.panel.hidden = true;
    await optimize();
  }

  async function optimize() {
    const picked = optSelected();
    if (picked.length < 2 || picked.length > 5) { els.findHint.textContent = "pick 2–5 slots"; return; }
    const breakpoints = {};
    els.optBreaks.querySelectorAll(".gf-optbkin").forEach((i) => { if (i.value !== "") breakpoints[i.dataset.k] = Number(i.value); });
    els.find.disabled = true;
    els.optOut.innerHTML = `<p class="status">Fetching ${picked.length} pools + scoring combinations in Path of Building… ${picked.length >= 4 ? "(4–5 slots: ~1–2 min, lots of Trade2 calls)" : "(~30s)"}</p>`;
    const d = await api("/api/gear/optimize-set", { buildXml: state.xml, slots: picked, breakpoints, maxPriceDiv: Number(els.budget.value) || 0, rarityMin: rarityMin(), league: state.league }).catch((e) => ({ error: String(e) }));
    els.find.disabled = false;
    if (d.available === false) { els.optOut.innerHTML = `<p class="status err">Headless Path of Building isn't available.</p>`; return; }
    if (d.limited) { els.optOut.innerHTML = `<p class="status err">Trade2 is rate-limited — try again shortly.</p>`; return; }
    if (d.error) { els.optOut.innerHTML = `<p class="status err">Failed: ${esc(d.error)}</p>`; return; }
    if (d.sessionExpired) markSessionExpired();
    if (!d.results || !d.results.length) {
      els.optOut.innerHTML = `<p class="status">No legal set found — every in-budget combination either lost a breakpoint or there were no upgrades. Evaluated ${d.evaluated || 0}/${d.combos || 0} combos. Try a bigger budget or dial a breakpoint down.</p>`;
      return;
    }
    els.optOut.innerHTML = renderOptResults(d);
  }

  function renderOptResults(d) {
    const bkRow = (have) => [["Fire", "fireRes"], ["Cold", "coldRes"], ["Light", "lightRes"], ["Chaos", "chaosRes"], ["Spirit", "spiritFree"], ["Rarity%", "rarityPct"]]
      .map(([lab, k]) => `<span class="gf-bk">${lab} ${have[k]}</span>`).join("");
    const funnel = `${d.inBudget} in-budget → ${d.screened} plausible → ${d.evaluated} PoB-scored → <b>${d.legal} legal</b>`;
    const head = `<p class="status">${funnel}. Pools: ${d.slots.map((s) => esc(s.slotId) + " (" + s.pool + ")").join(", ")}.${d.capped ? " (capped at " + d.evaluated + " PoB scores by best approx-DPS — tighten budget or fewer slots for full coverage)" : ""}</p>`;
    return head + d.results.map((r, i) => `
      <div class="gf-optcard${i === 0 ? " best" : ""}">
        <div class="gf-opthead">${i === 0 ? "★ " : ""}<b>+${fmt(r.dDPS)} DPS</b> · ${deltaSpan(r.dEHP, "EHP")} · <b class="gf-opttotal">Total ${fmt(r.priceDiv)} div</b><span class="muted"> (${r.picks.filter((p) => !p.keep).length} item${r.picks.filter((p) => !p.keep).length === 1 ? "" : "s"})</span></div>
        <div class="gf-optbks">${bkRow(r.have)}</div>
        <table class="gf-opttbl"><tbody>${r.picks.map((p) => { const link = !p.keep && p.base && p.account; return `<tr${link ? ` class="gf-opt-link" role="link" tabindex="0" data-base="${esc(p.base)}" data-account="${esc(p.account)}" data-mods="${esc(JSON.stringify(p.mods || []))}" title="open this listing on the trade site"` : ""}><td>${esc(slotLabel(p.slot))}</td><td>${p.keep ? "<span class='muted'>keep current</span>" : "<b>" + esc(p.name || "item") + "</b>"}</td><td>${p.keep ? "" : deltaSpan(p.dDPS, "DPS")}</td><td>${p.keep ? "" : fmt(p.priceDiv) + " div"}</td></tr>`; }).join("")}</tbody></table>
      </div>`).join("");
  }

  // Passive-tree move planner: value reachable notables (DPS to path to them) + your
  // allocated notables (DPS lost if removed). Pure PoB, no trade.
  async function analyzeTree() {
    if (!state.xml) { els.treeHint.textContent = "import a build first"; return; }
    const depth = Math.min(8, Math.max(1, Number(els.treeDepth.value) || 4));
    els.treeRun.disabled = true;
    els.treeOut.innerHTML = `<p class="status">Asking Path of Building to value every node within ${depth} points… (a few seconds)</p>`;
    const d = await api("/api/gear/tree-moves", { buildXml: state.xml, maxDepth: depth }).catch((e) => ({ error: String(e) }));
    els.treeRun.disabled = false;
    if (d.available === false) { els.treeOut.innerHTML = `<p class="status err">Headless Path of Building isn't available.</p>`; return; }
    if (d.error) { els.treeOut.innerHTML = `<p class="status err">Failed: ${esc(d.error)}</p>`; return; }
    els.treeOut.innerHTML = renderTree(d);
  }
  function renderTree(d) {
    const add = (d.add || []), rem = (d.remove || []);
    if (!add.length && !rem.length) { return `<p class="status">No notables found within range — try a larger search radius.</p>`; }
    // "Free to drop" = loses no DPS AND only negligible EHP. EHP-giving notables are NOT free
    // — dropping them costs survivability, which the user wants to avoid where possible.
    const baseEhp = d.baseEhp || 0;
    const freeEhp = Math.max(80, Math.round(baseEhp * 0.005));   // ≤0.5% EHP ≈ negligible
    const isFree = (r) => r.dDPS <= 0 && r.dEHP <= freeEhp;
    const perPt = (a) => a.dDPS / Math.max(1, a.pts);
    // Adds: show the EHP change too (some notables also move EHP) so a DPS grab that tanks
    // survivability is visible.
    const adds = add.slice(0, 15).map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${deltaSpan(a.dDPS, "DPS")}</td><td>${a.dEHP ? deltaSpan(a.dEHP, "EHP") : ""}</td><td>${a.pts} pt</td><td class="muted">${fmt(perPt(a))}/pt</td></tr>`).join("");
    // Allocated: safest-to-drop first (lowest combined DPS+EHP cost). Show BOTH costs so you
    // see the EHP you'd give up. Struck through only when truly free.
    const have = rem.slice().sort((a, b) => (a.dDPS + a.dEHP) - (b.dDPS + b.dEHP)).slice(0, 18).map((r) => {
      const dpsCell = r.dDPS > 0 ? deltaSpan(-r.dDPS, "DPS") : "<span class='muted'>no DPS</span>";
      const ehpCell = r.dEHP > 0 ? deltaSpan(-r.dEHP, "EHP") : "<span class='muted'>no EHP</span>";
      return `<tr class="${isFree(r) ? "gf-tree-dead" : ""}"><td><b>${esc(r.name)}</b></td><td>${dpsCell}</td><td>${ehpCell}</td><td>${r.pts} pt</td></tr>`;
    }).join("");
    const dead = rem.filter(isFree);
    const deadPts = dead.reduce((s, r) => s + (r.pts || 1), 0);
    const top = add[0];
    const summary = (deadPts && top)
      ? `<div class="gf-pinsum">Free up ~${deadPts} low-cost point${deadPts > 1 ? "s" : ""} (${dead.slice(0, 3).map((r) => esc(r.name)).join(", ")}${dead.length > 3 ? "…" : ""}) — each loses no DPS and ≤${fmt(freeEhp)} EHP → e.g. <b>${esc(top.name)}</b> for <b><span class="gf-delta up">+${fmt(top.dDPS)} DPS</span></b> (${top.pts} pt). <span class="gf-note" title="Gains are exact PoB calcs, one node at a time. Pairing freed points with a new notable is a suggestion — confirm the real respec path is legal in Path of Building, and that several moves together compound differently.">ⓘ</span></div>`
      : `<div class="gf-pinsum">No truly free points — every allocated notable gives DPS or meaningful EHP, so moving points will cost some survivability. The EHP column shows what each drop costs; pick the lowest.</div>`;
    return summary + `<div class="gf-tree-cols">
      <div><p class="gf-scan-h">Move points INTO — best DPS within ${d.maxDepth} pts</p><table class="gf-opttbl"><tbody>${adds || "<tr><td class='muted'>none</td></tr>"}</tbody></table></div>
      <div><p class="gf-scan-h">Your allocated notables — safest to drop first</p><table class="gf-opttbl"><tbody>${have || "<tr><td class='muted'>none</td></tr>"}</tbody></table></div>
    </div>`;
  }

  // Comparison board: pinned candidates (persisted), each with an old-vs-new stat diff.
  function renderPins() {
    const pins = state.pinned || [];
    if (els.pinCount) els.pinCount.textContent = pins.length;
    if (els.pins) els.pins.hidden = !pins.length;
    if (!els.pinBody) return;
    // Net total if you bought everything pinned. Sum is APPROXIMATE: each item's gain was
    // scored alone vs your current build, so combined gain differs (stats compound).
    const anyDps = pins.some((p) => p.metricDps);
    const totDps = pins.reduce((s, p) => s + (p.metricDps ? (p.dDPS || 0) : 0), 0);
    const totEhp = pins.reduce((s, p) => s + (p.dEHP || 0), 0);
    const totDiv = pins.reduce((s, p) => s + (p.priceDiv || 0), 0);
    // "Score together" = one real PoB calc with every pin slotted in (compounds correctly,
    // and accounts for +skills etc. that the per-item sum can't). Only pins with item text
    // (raw) can be re-slotted; older pins lack it.
    const scorable = pins.filter((p) => p.raw && p.pobSlot).length;
    const comboBtn = scorable >= 2 && state.headless
      ? ` <button type="button" class="gf-btn-sm" id="gfComboBtn" title="one PoB calc with all pins equipped — the real combined gain">⚖ Score together</button><span id="gfComboOut" class="gf-combo-out"></span>`
      : "";
    const summary = `<div class="gf-pinsum">Buy all ${pins.length}: ${anyDps ? deltaSpan(totDps, "DPS") + " · " : ""}${deltaSpan(totEhp, "EHP")} · <b>${fmt(totDiv)} div</b> total <span class="gf-note" title="Approximate — each item's gain was scored on its own against your current build, so buying several together usually does a bit better (stats compound). Includes every pin, even two for the same slot.">ⓘ</span>${comboBtn}</div>`;
    els.pinBody.innerHTML = summary + pins.map((p, i) => {
      const price = p.priceDiv ? `${fmt(p.priceDiv)} div` : `${fmt(p.priceEx || 0)} ex`;
      const keys = Array.from(new Set([...Object.keys(p.oldStats || {}), ...Object.keys(p.newStats || {})])).sort();
      const rows = keys.map((k) => {
        const o = Math.round(Number((p.oldStats || {})[k]) || 0), n = Math.round(Number((p.newStats || {})[k]) || 0);
        if (!o && !n) return "";
        const d = n - o, cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
        return `<tr><td>${esc(prettyStat(k))}</td><td>${o || "—"}</td><td>${n || "—"}</td><td class="gf-delta ${cls}">${d > 0 ? "+" : ""}${d || ""}</td></tr>`;
      }).join("");
      const open = p.base && p.account;
      const head = `<b>${esc(p.slotName || p.slot)}</b> ${esc(p.name || "Item")}`;
      return `<div class="gf-pincard">
        <div class="gf-pinhead">${open ? `<span class="gf-pinopen" data-i="${i}" title="open this listing on the trade site to buy">${head}</span>` : head} <span class="gf-price">${price}</span> ${p.metricDps ? deltaSpan(p.dDPS, "DPS") : ""} ${deltaSpan(p.dEHP, "EHP")}<button type="button" class="gf-unpin" data-i="${i}" title="remove">✕</button></div>
        <table class="gf-pintable"><thead><tr><th>Stat</th><th>Was</th><th>Now</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join("");
  }

  function selectSlot(id) {
    state.curSlot = id; state.weights = []; state.query = null;
    state.sel = new Set([id]);   // focusing one slot (scan/pin click) = single-slot selection
    updateFindUI();
    els.slot.textContent = id + " — " + ((state.slots[id] && state.slots[id].name) || "");
    els.panel.hidden = false; els.weights.innerHTML = ""; els.actions.hidden = true; els.snippetBox.hidden = true;
    els.item.value = ""; els.scoreOut.innerHTML = "";
    // Clear the previous slot's "Rank by real DPS" results + their state — else the stale
    // rows stay visible and pinning one records it under the NEW slot (wrong-slot pins).
    els.realOut.innerHTML = ""; state.realCands = []; state.realSearchUrl = ""; state.realHasDps = false; els.preserveRow.hidden = true;
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
    const reservesSpirit = (Number(d.base && d.base.SpiritReserved) || 0) > 0;
    const baseUnreserved = Number(d.base && d.base.SpiritUnreserved) || 0;
    els.scoreOut.innerHTML = (d.results || []).map((r) => {
      if (r.error || !r.stats) return `<div class="gf-srow">${esc(r.name)} — <span class="gf-delta down">${esc((r.error || "couldn't read this item").replace(/^pob:\s*/, ""))}</span></div>`;
      const dD = dpsOf(r.stats) - dpsOf(d.base), dE = ehpOf(r.stats) - ehpOf(d.base);
      const note = r.approx ? ` <span class="gf-approx">≈ base assumed (copy had no base type) — DPS accurate, EHP rough</span>` : "";
      // Spirit deficit → this item can't run the build's auras; the DPS/EHP above is fake.
      // RELATIVE to your current build's headroom (headless reservation is miscalibrated for
      // some builds, so an absolute "< 0" mis-flags every item) — flag only a real reduction.
      const dSpirit = baseUnreserved - Number(r.stats.SpiritUnreserved);
      const spirit = (reservesSpirit && dSpirit > 0.5)
        ? ` <span class="gf-delta down" title="this item drops Spirit headroom below your current build — auras/persistent gems would turn off, so the gain above isn't real">⚠ −${fmt(dSpirit)} spirit (breaks auras)</span>` : "";
      return `<div class="gf-srow"><b>${esc(r.name)}</b> ${hasDps ? deltaSpan(dD, "DPS") : ""} ${deltaSpan(dE, "EHP")}${spirit}${note}</div>`;
    }).join("") || "No items parsed.";
  }

  async function analyzeSlot() {
    const id = state.curSlot; if (!id) return;
    els.find.disabled = true; setStatus("Asking Path of Building what this slot is worth…");
    const d = await api("/api/gear/weights", {
      buildXml: state.xml, slot: id, pobSlot: state.slots[id] && state.slots[id].pobSlot,
      current: { raw: state.slots[id] && state.slots[id].raw }, maxPriceDiv: Number(els.budget.value) || 0, league: state.league,
    }).catch((e) => ({ error: String(e) }));
    els.find.disabled = false;
    if (d.error) { setStatus("Failed: " + d.error, true); return; }
    if (d.available === false) { setStatus("Headless Path of Building isn't available — install PoB + LuaJIT for build-weighted search.", true); return; }
    state.weights = d.weights || []; state.query = d.query; state.league = d.league || state.league; state.metric = d.metric || "dps"; state.equip = d.equip || null; state.preserve = d.preserve || null;
    renderWeights(d);
  }

  function renderWeights(d) {
    if (!state.weights.length) { setStatus("Nothing improves this build's " + (d.metric || "stats") + " on this slot.", true); els.actions.hidden = true; return; }
    const max = state.weights[0].weight || 1;
    const metricTxt = d.metric === "dps" ? "DPS" : "survivability (EHP — this build has no active skill set)";
    els.weights.innerHTML = `<p class="gf-metric">For your build, a better <b>${esc(state.curSlot)}</b> is ranked by <b>${metricTxt}</b>. Highest-value stats:</p>` +
      state.weights.map((w) => `<div class="gf-wrow"><span class="gf-wlabel">${esc(w.label || w.key)}</span><span class="gf-wbar"><span style="width:${Math.round((w.weight / max) * 100)}%"></span></span><span class="gf-wval">×${w.weight}</span></div>`).join("");
    els.actions.hidden = false; els.snippetBox.hidden = true;
    // Pre-scan "preserve the OTHER metric" toggle: a DPS-ranked slot (amulet/weapon) can
    // protect EHP; an EHP-ranked slot (helmet/chest — hybrids that also do some damage) can
    // protect DPS. Ticked, the scan drops candidates that lower the secondary stat BEFORE
    // ranking, so a deeper safe upgrade can surface. Label flips to match the slot's metric.
    const sec = d.metric === "dps" ? "EHP" : "DPS";
    els.preserveLabel.textContent = "Preserve " + sec;
    els.preserveSub.textContent = "— hide upgrades that lower your " + (sec === "EHP" ? "survivability" : "damage");
    els.preserveRow.hidden = false;
    els.preserveBox.checked = state.preserveOther;
    setStatus("");
  }

  // Rank by REAL DPS: fetch in-budget candidates and score each in PoB.
  async function realRank() {
    if (!state.curSlot || !state.weights.length) { setStatus("Analyze the slot first.", true); return; }
    // Floor at 70% of current rolls on stats the item HAS (cur>0); `equip` keeps the
    // item's core total defence. A near-BIS item rarely beats itself on every stat, so
    // 70% (not 100%) — PoB ΔDPS sorts the rest.
    const mods = state.weights.filter((w) => (w.cur || 0) > 0).slice(0, 4).map((w) => ({ statId: w.statId, min: Math.max(1, Math.floor((w.cur || 1) * 0.7)) }));
    els.realRankBtn.disabled = true; els.realOut.innerHTML = ""; setStatus("Fetching candidates and scoring them in Path of Building…");
    const d = await api("/api/gear/realrank", { buildXml: state.xml, slot: state.curSlot, pobSlot: state.slots[state.curSlot] && state.slots[state.curSlot].pobSlot, current: { raw: state.slots[state.curSlot] && state.slots[state.curSlot].raw }, mods, weights: state.weights.slice(0, 8), metric: state.metric, equip: state.equip, preserve: state.preserve, preserveOther: state.preserveOther, minPriceDiv: Number(els.budgetMin.value) || 0, maxPriceDiv: Number(els.budget.value) || 0, rarityMin: rarityMin(), league: state.league }).catch((e) => ({ error: String(e) }));
    els.realRankBtn.disabled = false;
    if (d.available === false) { setStatus("Headless Path of Building isn't available.", true); return; }
    if (d.limited) { setStatus("Trade2 is rate-limited — try again shortly.", true); return; }
    if (d.sessionExpired) markSessionExpired();
    else if (window.__sessRefresh) window.__sessRefresh();   // weighted search succeeded → pill confirms green
    if (d.error) { setStatus("Failed: " + d.error, true); return; }
    const secLabel = (d.metric === "ehp" || (d.metric == null && !(d.baseDps > 0))) ? "DPS" : "EHP";
    const cands = d.candidates || [];
    if (!cands.length) {
      const why = (state.preserveOther && d.otherDropped)
        ? `All ${d.otherDropped} matching candidate(s) would lower your ${secLabel} — untick “Preserve ${secLabel}” to see them.`
        : "No listings matched on your top stats — your current rolls may already be near best-in-slot for this slot." + (d.spiritSkipped ? ` (${d.spiritSkipped} skipped — would break your auras on spirit)` : "");
      setStatus(why, false); return;
    }
    const hasDps = (d.metric || (d.baseDps > 0 ? "dps" : "ehp")) === "dps";
    state.realHasDps = hasDps;
    state.realSearchUrl = d.searchUrl || "";   // fallback when an item lacks base/account
    state.realCands = cands;                   // referenced by the value-check + pin handlers
    els.preserveLabel.textContent = "Preserve " + secLabel;
    els.preserveSub.textContent = "— hide upgrades that lower your " + (secLabel === "EHP" ? "survivability" : "damage");
    els.preserveRow.hidden = false;
    els.preserveBox.checked = state.preserveOther;
    renderRealCands();
    setStatus(`Scored ${d.scored || cands.length} instant-buyout candidates in PoB${d.weighted ? " (best for your build)" : " (price spread — set POESESSID for build-ranked results)"}${state.preserveOther && d.otherDropped ? ` — Preserve ${secLabel} dropped ${d.otherDropped}` : ""}${d.spiritSkipped ? ` — ${d.spiritSkipped} skipped (would break your auras on spirit)` : ""}${d.partial ? " — stopped early on the rate limit" : ""}.`);
  }

  // Render the realrank pool: sort by the slot's gain metric, show the top 10. The Preserve-EHP
  // drop happens SERVER-side before ranking (so a deeper EHP-safe upgrade can surface), so this
  // just renders. data-idx stays the index into state.realCands so the pin / best-price /
  // open-listing handlers keep working.
  function renderRealCands() {
    const all = state.realCands || [];
    const hasDps = state.realHasDps;
    const gainOf = (c) => (hasDps ? c.dDPS : c.dEHP);
    const roi = (c) => (gainOf(c) > 0 && c.priceDiv > 0 ? gainOf(c) / c.priceDiv : 0);
    const fmtRoi = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : Math.round(v);
    // Drop downgrades — only show real upgrades (positive gain on the slot's metric).
    let list = all.map((c, idx) => ({ c, idx })).filter(({ c }) => gainOf(c) > 0);
    list.sort((a, b) => gainOf(b.c) - gainOf(a.c));
    const top = list.slice(0, 10);
    if (!top.length) {
      const unit = hasDps ? "DPS" : "EHP";
      els.realOut.innerHTML = `<p class="status">All ${all.length} in-budget listing(s) were ${unit} downgrades — your current ${slotLabel(state.curSlot)} is likely near best-in-slot here. Try a higher Max div or dial a breakpoint down.</p>`;
      return;
    }
    let bestK = -1, bestVal = 0;
    top.forEach(({ c }, k) => { const g = gainOf(c); if (g > 0 && c.priceEx > 0 && g / c.priceEx > bestVal) { bestVal = g / c.priceEx; bestK = k; } });
    els.realOut.innerHTML = top.map(({ c, idx }, k) => {
      const price = c.priceDiv ? `${fmt(c.priceDiv)} div` : `${fmt(c.priceEx || 0)} ex`;
      // No seller-status badge: these are instant-buyout (async) listings, buyable even
      // when the seller is offline, so online/afk/offline would just mislead.
      const r = roi(c);
      const roiHtml = r > 0 ? ` <span class="gf-roi" title="${hasDps ? "DPS" : "EHP"} gained per divine — your ROI">${fmtRoi(r)}/div</span>` : "";
      const best = k === bestK ? ` <span class="gf-best" title="most ${hasDps ? "DPS" : "EHP"} per exalted of these upgrades">★ best value</span>` : "";
      // "Best price?" scores cheaper instant-buyout items in PoB — is any as good for less?
      // Only worth it for items costing ≥1 div (cheap ones aren't worth a price hunt).
      const check = (c.mods && c.mods.length && c.priceDiv >= 1 && c.dDPS > 0) ? ` <button type="button" class="gf-check" data-idx="${idx}" title="score cheaper instant-buyout items in PoB — is any as good for less?">best price?</button><span class="gf-verdict"></span>` : "";
      const inner = `<button type="button" class="gf-pin" data-idx="${idx}" title="pin to the comparison board">📌</button> <b>${esc(c.name || "Item")}</b> ${hasDps ? deltaSpan(c.dDPS, "DPS") : ""} ${deltaSpan(c.dEHP, "EHP")} <span class="gf-price">${price}</span>${roiHtml}${best}${check}`;
      const canOpen = (c.base && c.account) || state.realSearchUrl;
      return `<div class="gf-srow${canOpen ? " gf-srow-link" : ""}"${canOpen ? ' role="link" tabindex="0"' : ""} data-idx="${idx}" data-base="${esc(c.base || "")}" data-account="${esc(c.account || "")}">${inner}</div>`;
    }).join("");
  }

  // Scan EVERY slot and rank them by upgrade ROI (gain per divine). Per slot:
  // weights (local PoB, no trade) → realrank with a small scoreCap (1 fetch) so a
  // ~12-slot sweep stays cheap on the search rate limit. Stops on a rate-limit and
  // reports partial. The ROI unit is consistent across slots (baseDps is global),
  // so the ranking is apples-to-apples within one build.
  const scanRoi = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : Math.round(v);
  // Two ranked tables — damage slots by DPS/div, defensive slots by EHP/div — since a
  // chest's value is survivability, not DPS. Mixing the two units in one sort would be
  // dishonest (DPS numbers dwarf EHP), so they're grouped.
  function renderScan(rows, tail) {
    const withBest = rows.filter((r) => r.best);
    const without = rows.filter((r) => !r.best);
    const tableFor = (mk, unit) => {
      const g = withBest.filter((r) => r.best.metric === mk).sort((a, b) => b.best.roi - a.best.roi);
      if (!g.length) return "";
      const body = g.map((r, i) => {
        const b = r.best, price = b.priceDiv ? `${fmt(b.priceDiv)} div` : `${fmt(b.priceEx || 0)} ex`;
        return `<tr class="gf-scan-link" data-slot="${esc(r.id)}" title="click to analyze this slot"><td>${i + 1}</td><td><b>${esc(r.id)}</b> <span class="muted">${esc(r.name || "")}</span></td><td>${esc(b.name || "Item")}</td><td class="gf-delta up">+${fmt(b.gain)} ${unit}</td><td>${price}</td><td><b>${scanRoi(b.roi)} ${unit}/div</b></td></tr>`;
      }).join("");
      return `<p class="gf-scan-h">Best <b>${unit}</b> per divine</p><table class="gf-scantable"><thead><tr><th>#</th><th>Slot</th><th>Best upgrade</th><th>Gain</th><th>Price</th><th>ROI</th></tr></thead><tbody>${body}</tbody></table>`;
    };
    let html = tableFor("dps", "DPS") + tableFor("ehp", "EHP");
    if (without.length) {
      // Clickable (except uniques) so you can drill into a "none" slot — the quick scan
      // only scores 10 candidates/slot; "Rank by real DPS" scores 50 and digs deeper.
      const rest = without.map((r) => { const link = !/unique/.test(r.none || "") && !/unavailable/.test(r.none || ""); return `<tr class="gf-scan-none${link ? " gf-scan-link" : ""}"${link ? ` data-slot="${esc(r.id)}" title="click to search this slot deeper"` : ""}><td><b>${esc(r.id)}</b> <span class="muted">${esc(r.name || "")}</span></td><td class="muted">${esc(r.none)}</td></tr>`; }).join("");
      html += `<table class="gf-scantable gf-scan-rest"><tbody>${rest}</tbody></table>`;
    }
    return html + (tail || "");
  }
  async function scanAll() {
    if (!state.xml) { setStatus("Import a build first.", true); return; }
    if (!state.headless) { els.scanOut.innerHTML = `<p class="status err">Headless Path of Building isn't available — it's needed to score upgrades.</p>`; return; }
    const slots = Object.entries(state.slots);
    if (!slots.length) return;
    const minDiv = Number(els.scanMin.value) || 0;
    els.scanAll.disabled = true;
    const rows = []; let partial = false, spiritTotal = 0;
    for (let i = 0; i < slots.length; i++) {
      const [id, sl] = slots[i];
      els.scanOut.innerHTML = renderScan(rows, `<p class="status">Scanning ${esc(id)} (${i + 1}/${slots.length})…</p>`);
      // Uniques are build-defining (their value isn't raw DPS) — keep them, don't suggest replacing.
      if (isUnique(sl.raw)) { rows.push({ id, name: sl.name, none: "unique — kept (build-defining)" }); continue; }
      const w = await api("/api/gear/weights", { buildXml: state.xml, slot: id, pobSlot: sl.pobSlot, current: { raw: sl.raw }, league: state.league }).catch(() => null);
      if (!w || w.available === false) { rows.push({ id, name: sl.name, none: "PoB unavailable" }); continue; }
      if (!w.weights || !w.weights.length) { rows.push({ id, name: sl.name, none: "nothing improves this slot" }); continue; }
      const metric = w.metric || "dps";
      // Floor only on stats the item actually HAS (cur>0) — what it IS, not what it could
      // gain. `equip` requires comparable total defence so candidates keep the item's core
      // value. Weights let a POESESSID session rank by build value; logged-out sorts DESC.
      const mods = w.weights.filter((x) => (x.cur || 0) > 0).slice(0, 4).map((x) => ({ statId: x.statId, min: Math.max(1, Math.floor((x.cur || 1) * 0.7)) }));
      const r = await api("/api/gear/realrank", { buildXml: state.xml, slot: id, pobSlot: sl.pobSlot, current: { raw: sl.raw }, mods, weights: w.weights.slice(0, 8), metric, equip: w.equip, preserve: w.preserve, minPriceDiv: minDiv, maxPriceDiv: 0, league: state.league, scoreCap: 10 }).catch(() => null);
      if (r && r.limited) { partial = true; break; }
      if (r && r.sessionExpired) markSessionExpired();
      if (!r || r.error || !Array.isArray(r.candidates)) { rows.push({ id, name: sl.name, none: "search failed" }); continue; }
      spiritTotal += r.spiritSkipped || 0;
      const mk = r.metric || metric;
      const gainOf = (c) => mk === "ehp" ? c.dEHP : c.dDPS;
      let best = null;
      for (const c of r.candidates) { const g = gainOf(c); if (g > 0 && c.priceDiv > 0) { const roi = g / c.priceDiv; if (!best || roi > best.roi) best = { ...c, gain: g, roi, metric: mk }; } }
      rows.push(best ? { id, name: sl.name, best } : { id, name: sl.name, none: "none in quick scan — click to rank deeper" });
    }
    els.scanAll.disabled = false;
    const tail = partial
      ? `<p class="status err">Stopped early — Trade2 rate-limited. Re-run shortly to finish the rest.</p>`
      : `<p class="status">Done — click any row to analyze that slot.${spiritTotal ? ` ${spiritTotal} candidate(s) skipped (would break your auras on spirit).` : ""}</p>`;
    els.scanOut.innerHTML = renderScan(rows, tail);
  }

  function snippetText() {
    const league = state.league, q = JSON.stringify(state.query);
    return `fetch("/api/trade2/search/poe2/${encodeURIComponent(league)}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(${q})}).then(r=>r.json()).then(d=>{if(d.id){location.href="/trade2/search/poe2/${encodeURIComponent(league)}/"+d.id}else{alert("Search failed: "+JSON.stringify(d))}}).catch(e=>alert(e));`;
  }

  els.importBtn.addEventListener("click", async () => {
    const code = (els.code.value || "").trim(); if (!code) { setStatus("Paste a PoB code first.", true); return; }
    setStatus("Importing…"); renderBuild(await api("/api/gear/import", { code }));
  });
  // "Save this build as…" is a button that reveals the name box; the box's Save confirms.
  els.saveBuild.addEventListener("click", () => {
    els.saveBuild.hidden = true; els.saveBox.hidden = false; syncSaveRow(); els.saveName.focus();
  });
  els.saveName.addEventListener("keydown", (e) => { if (e.key === "Enter") els.saveConfirm.click(); });
  els.saveConfirm.addEventListener("click", () => {
    const name = (els.saveName.value || "").trim();
    if (!name) { setStatus("Type a name to save this build.", true); return; }
    if (!state.xml) { setStatus("Import a build first, then save it.", true); return; }
    const saves = loadSaves(); saves[name] = state.xml; persistSaves(saves);
    els.saveName.value = ""; els.saveBox.hidden = true; els.saveBuild.hidden = false;
    refreshSaved(); els.saved.value = name;   // refreshSaved → syncSaveRow
    setStatus(`Saved "${name}" — pick it from My builds next time.`);
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
  els.slots.addEventListener("click", (e) => { const b = e.target.closest("[data-slot]"); if (b) toggleSlot(b.dataset.slot); });
  els.find.addEventListener("click", findUpgrades);
  els.scanAll.addEventListener("click", scanAll);
  // Click a scanned slot → focus it as a single-slot rank (select + analyze + rank).
  els.scanOut.addEventListener("click", async (e) => { const tr = e.target.closest(".gf-scan-link"); if (tr) { els.optOut.innerHTML = ""; selectSlot(tr.dataset.slot); els.panel.scrollIntoView({ behavior: "smooth", block: "start" }); await analyzeSlot(); if (state.weights.length) await realRank(); } });
  els.realRankBtn.addEventListener("click", realRank);
  els.treeRun.addEventListener("click", analyzeTree);
  // Click an optimizer pick row → open that listing on trade (same per-item link as the ranked rows).
  els.optOut.addEventListener("click", (ev) => { const row = ev.target.closest(".gf-opt-link"); if (!row) return; let mods = []; try { mods = JSON.parse(row.dataset.mods || "[]"); } catch {} openItemListing(row.dataset.base, row.dataset.account, "", mods); });
  // Preserve EHP is a PRE-scan setting (applied server-side before ranking), so changing it
  // after results prompts a re-rank rather than silently re-filtering — no surprise re-fetch.
  els.preserveBox.addEventListener("change", () => {
    state.preserveOther = els.preserveBox.checked;
    const sec = state.realHasDps ? "EHP" : "DPS";
    if (state.realCands && state.realCands.length) setStatus(`Preserve ${sec} ${state.preserveOther ? "on" : "off"} — click “Rank by real DPS” to apply.`);
  });
  if (els.pinBody) els.pinBody.addEventListener("click", async (ev) => {
    // Score all pins together in one PoB calc (real compounded gain).
    const combo = ev.target.closest("#gfComboBtn");
    if (combo) {
      const out = document.getElementById("gfComboOut");
      combo.disabled = true; if (out) { out.className = "gf-combo-out"; out.textContent = " scoring all pins in PoB…"; }
      const pins = (state.pinned || []).filter((p) => p.raw && p.pobSlot).map((p) => ({ pobSlot: p.pobSlot, raw: p.raw, dDPS: p.dDPS }));
      const d = await api("/api/gear/score-combo", { buildXml: state.xml, pins }).catch(() => null);
      combo.disabled = false;
      if (!d || d.available === false || d.error) { if (out) out.textContent = " " + ((d && d.error) || (d && d.available === false ? "PoB unavailable" : "scoring failed")); return; }
      if (out) {
        const note = d.dropped ? ` (best ${d.scored} of ${d.scored + d.dropped} — one per slot)` : ` (all ${d.scored})`;
        out.innerHTML = ` → equipped together${note}: ${deltaSpan(d.dDPS, "DPS")} · ${deltaSpan(d.dEHP, "EHP")}`;
      }
      return;
    }
    const x = ev.target.closest(".gf-unpin");
    if (x) { state.pinned.splice(+x.dataset.i, 1); savePins(); renderPins(); return; }
    // Open a pinned item's listing on trade — same per-item search as the ranked rows,
    // so you can buy it after moving away from that slot.
    const op = ev.target.closest(".gf-pinopen");
    if (op) {
      const p = state.pinned[+op.dataset.i]; if (!p || !p.base || !p.account) return;
      const w = window.open("about:blank", "_blank");
      const d = await api("/api/gear/item-link", { league: p.league || state.league, base: p.base, account: p.account }).catch(() => null);
      if (d && d.url && w) { try { w.opener = null; } catch {} w.location = d.url; }
      else { if (w) w.close(); setStatus(d && d.limited ? "Trade2 is rate-limited — try again shortly." : "Couldn't open that listing.", true); }
    }
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
      const entry = { slot, slotName: sl.name || slot, pobSlot: sl.pobSlot || "", raw: c.raw || "", name: c.name, base: c.base, account: c.account, league: state.league, mods: c.mods, priceDiv: c.priceDiv, priceEx: c.priceEx, dDPS: c.dDPS, dEHP: c.dEHP, metricDps: !!state.realHasDps, oldStats: sl.stats || {}, newStats: c.stats || {} };
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
    const c = state.realCands[+row.dataset.idx] || {};
    openItemListing(c.base || row.dataset.base, c.account || row.dataset.account, state.realSearchUrl, c.mods);
  });
  els.scoreBtn.addEventListener("click", scoreItems);
  els.copyQuery.addEventListener("click", () => {
    if (!state.query) { setStatus("Analyze a slot first.", true); return; }
    copyText(JSON.stringify({ league: state.league, query: state.query })).then((ok) => {
      els.copyQuery.textContent = ok ? "Copied" : "Copy failed";
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

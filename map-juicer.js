window.__viewInit=window.__viewInit||{};
window.__viewInit["map-juicer"]=function(){
  const D = window.WAYSTONE_DATA;
  const T = D.tokens;
  let liveWeights = null;
  let weightStatus = "";
  function MW(){ return liveWeights || D.marketWeights; }
  const els = {
    tabs: document.getElementById("tabs"),
    reco: document.getElementById("mjReco"),
    left: document.getElementById("mjLeft"),
    right: document.getElementById("mjRight"),
    strat: document.getElementById("mjStrat"),
    count: document.getElementById("mjCount"),
    mix: document.getElementById("mjMix"),
    corrupt: document.getElementById("mjCorrupt"),
    safe: document.getElementById("mjSafe"),
    patchline: document.getElementById("patchline"),
    fx: document.getElementById("fxRate"),
    footPatch: document.getElementById("footPatch"),
    evalInput: document.getElementById("evalInput"),
    evalBtn: document.getElementById("evalBtn"),
    evalOut: document.getElementById("evalOut"),
  };
  els.patchline.textContent = "Pick a master + juice your maps · Patch " + D.patch + " · " + D.league;
  els.footPatch.textContent = D.patch;
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

  // ── Control-bar state ─────────────────────────────────────────────────────
  const state = { mech: D.contentTypes[0].id, strat: "profit", count: "3", mix: "2plus1", corrupted: false, safe: true };
  function ct(){ return D.contentTypes.find(c => c.id === state.mech) || D.contentTypes[0]; }
  function stratLabel(){ const s = (D.strategies||[]).find(x => x.id === state.strat); return s ? s.label : state.strat; }
  const confLabel = { high: "High", med: "Medium", low: "Needs verify" };
  const confShort = { high: "High", med: "Med", low: "Low" };

  // ── %-aware regex (unchanged generators; smoke-tested) ────────────────────
  const L = D.tokens.line;
  let rarityMin = 60, packMin = 30;
  function tens(pct){ const d = Math.max(2, Math.floor(pct / 10)); return d >= 2 && d <= 9 ? `[${d}-9].` : "\\d."; }
  function atLeast(token, pct){ return `${token} \\+(${tens(pct)}|1..)%`; }
  function runRegex(){ return `"(${atLeast(L.itemRarity, rarityMin)}|${atLeast(L.packSize, packMin)})" "!${T.danger}"`; }
  function blueRegex(){ return `"(${L.itemRarity}|${L.packSize}|${L.magicMonsters}|${L.rareMonsters}|${L.waystoneDrop})" "!${T.danger}"`; }
  function noRevivesRegex(){ return `"${T.revivesZero}"`; }
  function tabletRegex(token){ return `"${token}" "${T.tabletDesirable}"`; }
  function regexRow(title, regex, sub){
    const len = regex.length, over = len > D.regexLimit;
    return `
      <div class="rx">
        <div class="rx-top"><span class="rx-title">${esc(title)}</span><span class="rx-len ${over?"over":""}">${len}/${D.regexLimit}</span></div>
        <div class="regexrow"><code class="regexbox">${esc(regex)}</code><button class="copy" type="button" data-copy="${esc(regex)}">Copy</button></div>
        ${sub?`<div class="rx-sub">${esc(sub)}</div>`:""}
      </div>`;
  }

  // ── Master recommendation engine ──────────────────────────────────────────
  // Drives off STRATEGY + safety + tablet mix (+ corrupted), because the masters
  // are organized by goal, not by mechanic. Returns the pick, why, and swaps.
  function recommendMaster(s){
    const danger = !s.safe, mixed = s.mix === "mixed";
    let id = "jado", conf = "med";
    const why = [], swaps = [];
    if (s.strat === "safe"){
      id = "doryani"; conf = danger ? "high" : "med";
      why.push("Survival first — Stitch the Flesh adds a revive and safer maps protect your tablet/waystone investment.");
      if (!danger) swaps.push("You're not actually dying — a loot master (Jado) earns more; Doryani's safety is wasted.");
    } else if (s.strat === "strongbox"){
      id = "jado";
      why.push("Jado is the strongbox/key master — unique strongboxes (Trove Seekers) plus Cryptic & Reliquary keys (Mysterious Gifts).");
    } else if (s.strat === "pinnacle"){
      id = "hilda";
      why.push("Hilda scales pinnacle drops (Gutting and Skinning) and high-difficulty monsters.");
      swaps.push("Need to REVEAL Citadels or want pinnacle revival → Doryani (Head of the Snake).");
    } else if (s.strat === "boss"){
      if (danger){ id = "doryani"; why.push("Boss farming while dying → Doryani: extra revive + Remnants of Greatness (Terraformers off bosses)."); swaps.push("Once you clear comfortably → Hilda for far more boss drops."); }
      else { id = "hilda"; why.push("Hilda turns maps into a boss engine — upgrades bosses (Mighty Prey) and replaces rares with bosses (Patient Battue)."); }
      swaps.push("Citadel HUNTING specifically → Doryani (Head of the Snake reveals Citadels).");
    } else if (s.strat === "corrupted"){
      if (danger){ id = "doryani"; why.push("Corrupted maps are killing you → Doryani for the extra revive."); }
      else { id = "jado"; why.push("Corrupted ≠ Doryani by default. Surviving fine → Jado: Unexpected Missions gives corrupted waystones extra mods, on top of the loot core."); }
    } else { // profit (default)
      if (mixed){ id = "hilda"; why.push("Mixed tablet types → Hilda's Ancient Inscriptions scales tablet effect per type, plus boss/monster density."); }
      else { id = "jado"; why.push("Pure profit → Jado is the loot engine: uniques, strongboxes, exceptional items, plus a tablet-value boost."); }
    }
    // Cross-situation swap hints (these encode the critique of the old assumptions).
    if (mixed && id !== "hilda" && s.strat !== "safe") swaps.push("Running many DIFFERENT tablet types? Hilda's Ancient Inscriptions (+ per type) likely beats this.");
    if (danger && id !== "doryani") swaps.push("If you start dying → Doryani (extra revive) over raw loot.");
    if (s.corrupted && id !== "doryani" && s.strat !== "corrupted") swaps.push("Corrupted map: only switch to Doryani if you actually die — corruption alone isn't a reason.");
    if (!danger && id === "doryani" && s.strat !== "safe") swaps.push("Comfortable clears? A loot/boss master out-earns Doryani's safety.");
    // Strategy/mechanic-specific node swap (one node, keeps the one-per-row build).
    let nodeNote = "";
    if (id === "hilda" && s.strat === "pinnacle") nodeNote = "Pinnacle: take Gutting and Skinning (row 4) over Patient Battue for extra pinnacle drops.";
    else if (id === "jado" && (s.strat === "corrupted" || s.corrupted)) nodeNote = "Corrupted: take Unexpected Missions (row 1) over Trove Seekers — corrupted waystones gain extra mods.";
    else if (id === "doryani" && s.mech === "expedition") nodeNote = "Expedition: take Refined Formula (row 1, +explosive radius) over Stitch the Flesh once you survive.";
    else if (id === "jado" && s.strat === "boss") nodeNote = "Boss loot: take In The Wrong Hands (row 1) for an extra boss Unique.";
    return { id, master: D.masters[id], conf, why, swaps, nodeNote };
  }

  // ── Recommendation panel ──────────────────────────────────────────────────
  function nodeChips(nodes){
    return nodes.map(n => `<div class="nodechip ${n.conf==="low"?"q":""}"><b>${n.row?`<span class="rowtag">R${n.row}</span> `:""}${esc(n.name)}</b><span>${esc(n.effect)}</span></div>`).join("");
  }
  function renderReco(){
    const r = recommendMaster(state), m = r.master;
    const nodes = m.nodes.filter(n => n.take).slice(0, 4);
    const swaps = r.swaps.length
      ? `<details class="mj-d"><summary>Advanced swaps — change master if…</summary><ul class="reco-swaps">${r.swaps.map(s=>`<li>${esc(s)}</li>`).join("")}</ul></details>`
      : "";
    const why = r.why.length > 1
      ? `<div class="reco-why">${esc(r.why[0])}</div><details class="mj-d"><summary>Why this is best</summary><div class="reco-why" style="margin:0">${r.why.slice(1).map(esc).join(" ")}</div></details>`
      : `<div class="reco-why">${r.why.map(esc).join(" ")}</div>`;
    els.reco.innerHTML = `
      <div class="reco-top">
        <span class="reco-eyebrow">Best master · ${esc(stratLabel())} · ${esc(ct().label)}</span>
        <span class="conf ${r.conf}">${confLabel[r.conf]} confidence</span>
      </div>
      <div class="reco-name">${esc(m.name)} <small>${esc(m.tree)} · ${esc(m.role)}</small></div>
      ${why}
      <div class="reco-sub">Take these nodes — one per row (4 points)</div>
      <div class="nodechips">${nodeChips(nodes)}</div>
      ${r.nodeNote?`<div class="reco-note">↳ ${esc(r.nodeNote)}</div>`:""}
      ${swaps}`;
  }

  // ── Left column: tablet / waystone regex + avoid ──────────────────────────
  function regexCard(title, kind, regex, mods){
    const len = regex.length, over = len > D.regexLimit;
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">${esc(title)}</span><span class="card-kind">${esc(kind)}</span></div>
        <div class="card-body">
          <div class="regexrow"><code class="regexbox">${esc(regex)}</code><button class="copy" type="button" data-copy="${esc(regex)}">Copy</button></div>
          <div class="meta"><span>quoted=AND · | =OR · !"…"=exclude</span><span class="${over?"over":""}">${len}/${D.regexLimit} chars</span></div>
          ${mods&&mods.length?`<ul class="modlist">${mods.map(m=>`<li>${esc(m)}</li>`).join("")}</ul>`:""}
        </div>
      </div>`;
  }
  function waystoneRegexCard(){
    const opt = (v, cur) => `<option value="${v}"${v===cur?" selected":""}>${v}%</option>`;
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Waystone reward mods (Ctrl-F)</span><span class="card-kind">%-aware</span></div>
        <div class="card-body">
          <div class="rx-thresholds">
            <label>Min Item Rarity <select id="rxRarity">${[40,50,60,70].map(v=>opt(v,rarityMin)).join("")}</select></label>
            <label>Min Pack Size <select id="rxPack">${[20,30,40].map(v=>opt(v,packMin)).join("")}</select></label>
          </div>
          ${regexRow(`Best maps to run — Rarity ≥${rarityMin}% or Pack ≥${packMin}%, no risk suffixes`, runRegex())}
          ${regexRow("Only fully-juiced maps — 6 mods / 0 revives left", noRevivesRegex(), "Revives drop 6→0 as mods are added; 0 revives means a 6-mod map (one death = fail).")}
          ${regexRow("Any reward mod — blue waystones worth upgrading", blueRegex())}
          <div class="note">Matches the waystone's "<b>Label: +X%</b>" reward block (0.5). Verify wording in your stash.</div>
        </div>
      </div>`;
  }
  function avoidCard(){
    const danger = (D.dangerousMods||[]).map(m=>`<li>${esc(m)}</li>`).join("");
    const removed = (D.removedInPatch||[]).join(", ");
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Avoid / bait mods</span><span class="card-kind">skip</span></div>
        <div class="card-body">
          <ul class="avoidlist">${danger}</ul>
          <div class="note">Risk suffixes — strip with Omen of Whittling + Chaos, or run as cheap throwaways. The run / blue regex already exclude these.</div>
          ${removed?`<div class="note">Removed in 0.5 (don't target): <b>${esc(removed)}</b></div>`:""}
        </div>
      </div>`;
  }
  function renderLeft(){
    els.left.innerHTML =
      regexCard(`Best ${ct().label} tablet mods`, "tablet", tabletRegex(ct().tabletToken),
        ["Pack Size / increased Monsters — content scaling", "Item Rarity"]) +
      waystoneRegexCard() +
      avoidCard();
  }

  // ── Right column: masters / notes / market / warnings ─────────────────────
  function mastersCard(){
    const pick = recommendMaster(state).id;
    const minis = Object.entries(D.masters).map(([key, m]) => `
      <div class="mcard ${key===pick?"is-pick":""}">
        <div class="mcard-top"><span class="mcard-name">${esc(m.name)}</span><span class="mcard-tree">${esc(m.tree)}</span><span class="mcard-role">${esc(m.short)}</span></div>
        <div class="mcard-why">${esc(m.why)}</div>
      </div>`).join("");
    const rows = (D.masterSituations||[]).map(r => `
      <tr><td>${esc(r.sit)}</td><td class="m">${esc(r.master)}</td><td><span class="x">${esc(r.nodes)}</span></td><td>${esc(r.when)}</td><td>${esc(r.avoid)}</td><td><span class="conf ${r.conf}">${confShort[r.conf]}</span></td></tr>`).join("");
    const allNodes = Object.values(D.masters).map(m => `
      <div class="reco-sub">${esc(m.name)} — ${esc(m.role)}</div>
      <div class="nodechips">${nodeChips(m.nodes)}</div>`).join("");
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Masters — situation → pick</span><span class="card-kind">atlas</span></div>
        <div class="card-body">
          <div class="mw-note-top">${esc(D.mastersNote)}</div>
          ${minis}
          <details class="mj-d"><summary>Full situation → master table</summary>
            <div class="mj-tablewrap"><table class="mj-table">
              <thead><tr><th>Situation</th><th>Master</th><th>Nodes</th><th>Use when</th><th>Avoid when</th><th>Conf</th></tr></thead>
              <tbody>${rows}</tbody></table></div>
          </details>
          <details class="mj-d"><summary>All master nodes (Jado · Hilda · Doryani)</summary><div>${allNodes}</div></details>
        </div>
      </div>`;
  }
  function contentNotesCard(){
    const c = ct();
    const picks = (c.omenPicks||[]).map(p=>`<div class="omen-rec-item"><b>${esc(p.name)}</b> — ${esc(p.why)}</div>`).join("");
    const steps = D.juiceBase.map(s=>`<li>${esc(s)}</li>`).join("");
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">${esc(c.label)} notes</span><span class="card-kind">content</span></div>
        <div class="card-body">
          <p class="mcard-why" style="font-size:12.5px">${esc(c.blurb)}</p>
          ${picks?`<div class="reco-sub">Best omens</div><div class="omen-rec">${picks}</div>`:""}
          <details class="mj-d"><summary>Blue → juiced path</summary><ol class="steps">${steps}</ol><div class="note"><b>${esc(c.label)}:</b> ${esc(c.juiceNote)}</div></details>
        </div>
      </div>`;
  }
  function peakEx(s){ return s.peakEx || (s.curve && s.curve.length ? s.curve[s.curve.length-1][1] : 0) || 0; }
  function marketRows(){
    const mw = MW(); if (!mw || !mw.stats || !mw.stats.length) return "";
    const live = /live refresh/i.test(mw.source || "") || !!liveWeights;
    const maxLog = Math.log10(Math.max(10, ...mw.stats.map(peakEx)));
    const rows = mw.stats.map(s => {
      const pk = peakEx(s);
      const pct = Math.round((Math.log10(Math.max(1, pk)) / maxLog) * 100);
      const curveTxt = (s.curve || []).map(([p, ex]) => `${p}%→${ex}ex`).join("  ");
      return `
        <div class="mw-row">
          <div class="mw-top"><span class="mw-name">${esc(s.label)}</span><span class="mw-aim">peak ~${pk}ex</span><span class="mw-floor">${s.ceiling?`rolls to ~${s.ceiling}%`:""}</span></div>
          <div class="mw-bar"><span style="width:${pct}%"></span></div>
          <div class="mw-curve">${esc(curveTxt)}</div>
          <div class="mw-tip">${esc(s.tip)}</div>
        </div>`;
    }).join("");
    return `
      ${mw.note?`<div class="mw-note-top">${esc(mw.note)}</div>`:""}
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="copy mw-refresh" id="weightRefresh" type="button" title="Re-sweep live Trade2 prices (rate-limited)">Refresh from market</button></div>
      <div class="mw-list">${rows}</div>
      ${weightStatus?`<div class="mw-status">${esc(weightStatus)}</div>`:""}
      <div class="note">Trade2 Tier-16 price-vs-% sweep — ${live?"live":"baked"} (${esc(mw.analyzed)}, ${esc(mw.league)}). Read the curve, not the bar (stats have different ceilings). Re-run each patch.</div>`;
  }
  function marketCard(){
    const mw = MW(); if (!mw || !mw.stats || !mw.stats.length) return "";
    const top = mw.stats.slice().sort((a,b)=>peakEx(b)-peakEx(a))[0];
    const live = /live refresh/i.test(mw.source || "") || !!liveWeights;
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Mod value (market)</span><span class="card-kind">${live?"live":"baked"}</span></div>
        <div class="card-body">
          <div class="scoreline">Top chase <b>${esc(top.label)}</b><span>peak ~${peakEx(top)}ex · price scales with rolled %</span></div>
          <details class="mj-d"><summary>Market data — full price curves</summary>${marketRows()}</details>
        </div>
      </div>`;
  }
  function warningsCard(){
    const items = [
      "Masters are organized by GOAL (loot / boss / survival), not by mechanic — the Strategy + 'clear speed is fine' toggles drive the master; the Mechanic drives tablets & regex.",
      "Master node NAMES are cross-verified vs poe2db + community (Jun 2026); exact %s (e.g. Partial Translations, Improved Calibration) are approximate — verify in-game.",
      "Regex uses the 0.5 'Label: +X%' format (forum guide); confirm exact wording in your stash.",
      "Market curves are a Tier-16 price sweep — re-run 'Refresh from market' each patch.",
    ];
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Warnings & caveats</span><span class="card-kind">read</span></div>
        <div class="card-body">
          <div class="mw-note-top">Pick the master by your <b>Strategy + safety</b>, not by the mechanic. Node names verified; exact %s approximate.</div>
          ${D.progression?`<div class="reco-note">↳ ${esc(D.progression)}</div>`:""}
          ${D.patchNote?`<div class="reco-note">↳ <b>Patch</b> ${esc(D.patchNote)}</div>`:""}
          <details class="mj-d"><summary>Patch / source notes</summary><ul class="reco-swaps">${items.map(i=>`<li>${esc(i)}</li>`).join("")}</ul></details>
        </div>
      </div>`;
  }
  function renderRight(){
    els.right.innerHTML = mastersCard() + contentNotesCard() + marketCard() + warningsCard();
  }

  // ── Render orchestration ──────────────────────────────────────────────────
  function renderAll(){
    renderReco();
    renderLeft();
    renderRight();
    bindCopy();
    bindRegexThresholds();
    bindWeightRefresh();
  }
  function bindCopy(){
    document.querySelectorAll(".toolroot-mj [data-copy]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const txt = b.getAttribute("data-copy"), orig = b.textContent;
        try { await navigator.clipboard.writeText(txt); b.textContent="Copied"; }
        catch { b.textContent="Copy failed"; }
        setTimeout(()=>{ b.textContent=orig; }, 1200);
      });
    });
  }
  function bindRegexThresholds(){
    const r = els.left.querySelector("#rxRarity"), p = els.left.querySelector("#rxPack");
    if (r) r.addEventListener("change", () => { rarityMin = Number(r.value) || 60; renderLeft(); bindCopy(); bindRegexThresholds(); });
    if (p) p.addEventListener("change", () => { packMin = Number(p.value) || 30; renderLeft(); bindCopy(); bindRegexThresholds(); });
  }
  function bindWeightRefresh(){
    const btn = els.right.querySelector("#weightRefresh");
    if (btn) btn.addEventListener("click", () => refreshWeights(false));
  }

  // ── Mechanic tabs ─────────────────────────────────────────────────────────
  function renderTabs(){
    els.tabs.innerHTML = D.contentTypes.map(c =>
      `<button class="tab ${c.id===state.mech?"active":""}" data-tab="${esc(c.id)}">${esc(c.label)}</button>`).join("");
    els.tabs.querySelectorAll("[data-tab]").forEach(b=>{
      b.addEventListener("click", ()=>{ state.mech = b.getAttribute("data-tab"); renderTabs(); renderAll(); });
    });
  }
  function fillSelects(){
    els.strat.innerHTML = (D.strategies||[]).map(o=>`<option value="${esc(o.id)}"${o.id===state.strat?" selected":""}>${esc(o.label)}</option>`).join("");
    els.count.innerHTML = ["0","1","2","3","4"].map(v=>`<option value="${v}"${v===state.count?" selected":""}>${v} tablet${v==="1"?"":"s"}</option>`).join("");
    els.mix.innerHTML = (D.tabletMixes||[]).map(o=>`<option value="${esc(o.id)}"${o.id===state.mix?" selected":""}>${esc(o.label)}</option>`).join("");
    els.strat.addEventListener("change", ()=>{ state.strat = els.strat.value; renderAll(); });
    els.count.addEventListener("change", ()=>{ state.count = els.count.value; });
    els.mix.addEventListener("change", ()=>{ state.mix = els.mix.value; renderAll(); });
    els.corrupt.addEventListener("change", ()=>{ state.corrupted = els.corrupt.checked; renderAll(); });
    els.safe.addEventListener("change", ()=>{ state.safe = els.safe.checked; renderAll(); });
  }

  // ── Market refresh (live Trade2 sweep) ────────────────────────────────────
  let refreshing = false;
  async function refreshWeights(force){
    if (refreshing) return;
    refreshing = true;
    weightStatus = "Sweeping live market prices… (~1 min, shared rate limit)";
    renderRight(); bindCopy(); bindWeightRefresh();
    const btn = els.right.querySelector("#weightRefresh");
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/api/waystone/market-weights/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: !!force }) });
      const d = await r.json();
      if (d.weights) liveWeights = d.weights;
      if (d.limited) weightStatus = "Trade2 rate-limited — showing last result. Try again in a few minutes.";
      else if (d.cooldown) weightStatus = "Refreshed recently — showing latest (cooldown ~2 min).";
      else if (d.refreshed) weightStatus = "Updated from live market just now.";
      else if (d.error) weightStatus = "Refresh failed: " + d.error;
      else weightStatus = "No market data returned.";
    } catch (e) { weightStatus = "Refresh failed (is the local server running?)."; }
    finally { refreshing = false; renderRight(); bindCopy(); bindWeightRefresh(); }
  }
  async function loadCachedWeights(){
    try {
      const r = await fetch("/api/waystone/market-weights");
      const d = await r.json();
      if (d && d.weights && d.weights.stats && d.weights.stats.length && d.weights.stats[0].curve){ liveWeights = d.weights; renderRight(); bindCopy(); bindWeightRefresh(); }
    } catch {}
  }
  async function loadExchange(){
    const el = els.fx; if (!el) return;
    try {
      const r = await fetch("/api/waystone/exchange");
      const d = await r.json();
      if (d && d.exPerDiv){
        el.textContent = `1 div ≈ ${d.exPerDiv} ex` + (d.stale ? " (stale)" : "");
        el.title = `Official Currency Exchange · ${d.offers||"?"} offers` + (d.cached?" · cached":"") + (d.stale?" · rate-limited, last known":" · live");
        el.classList.toggle("stale", !!d.stale);
        el.style.display = "";
      } else if (d && d.limited){ el.textContent = "div↔ex: trade rate-limited"; el.classList.add("stale"); el.style.display = ""; }
      else { el.style.display = "none"; }
    } catch { el.style.display = "none"; }
  }

  // ── Paste evaluator (kept; now also hints master fit) ─────────────────────
  const STAT_RE = { packSize: /pack size/i, monsterEffectiveness: /monster effectiveness|magic monster/i, itemRarity: /rarity of items|item rarity/i, monsterRarity: /monster rarity|rare monster/i };
  const SUSTAIN_RE = /waystones? (found|in area)|waystone drop/i;
  function statRoll(text, re){
    let found=false, value=0;
    for (const line of String(text).split(/\n/)){ if (!re.test(line)) continue; found = true; const m = line.match(/(\d+(?:\.\d+)?)\s*%/); if (m) value = Math.max(value, parseFloat(m[1])); }
    return { found, value };
  }
  const DANGER = [ ["less Recovery Rate", /less recovery rate/i], ["reduced Flask Charges", /reduced flask/i], ["-max Player Resistances", /maximum (player )?.*resistanc/i], ["less Cooldown Recovery", /less cooldown/i] ];
  function detectContent(t){ for (const c of D.contentTypes){ if (c.id!=="general" && new RegExp(c.tabletToken,"i").test(t)) return c; } return null; }
  function curveEx(curve, pct){
    if (!curve || !curve.length || pct <= 0) return 0;
    if (pct <= curve[0][0]) return curve[0][1] * (pct / curve[0][0]);
    for (let i = 1; i < curve.length; i++){ if (pct <= curve[i][0]){ const [x0,y0] = curve[i-1], [x1,y1] = curve[i]; return y0 + (y1 - y0) * (pct - x0) / (x1 - x0); } }
    const a = curve[curve.length-2] || curve[0], b = curve[curve.length-1];
    const slope = (b[1]-a[1]) / Math.max(1, b[0]-a[0]);
    return Math.max(b[1], b[1] + slope * (pct - b[0]));
  }
  function marketScore(text){
    const stats = (MW() && MW().stats) || [];
    let best = null, rows = [];
    for (const s of stats){ const re = STAT_RE[s.key]; if (!re) continue; const { found, value } = statRoll(text, re); if (!found) continue; const ex = Math.round(curveEx(s.curve, value)); const tagCls = ex >= 60 ? "good" : ex >= 15 ? "mid" : "bad"; const tagTxt = ex >= 60 ? "premium" : ex >= 15 ? "good roll" : "low value"; rows.push({ key: s.key, label: s.label, value, ex, tagCls, tagTxt, ceiling: s.ceiling || 0 }); if (!best || ex > best.ex) best = { label: s.label, value, ex }; }
    rows.sort((a,b)=>b.ex - a.ex);
    return { headlineEx: best ? best.ex : 0, best, rows };
  }
  function statLabel(key){ const s = (MW().stats || []).find(x => x.key === key); return s ? s.label : key; }
  function contentFit(rolls){
    const ceil = {}; (MW().stats || []).forEach(s => { ceil[s.key] = s.ceiling || 100; });
    return (D.contentTypes || []).filter(c => c.scalesWith).map(c => {
      let fit = 0, top = null;
      for (const [k, w] of Object.entries(c.scalesWith)){ const norm = Math.min(1, (rolls[k] || 0) / (ceil[k] || 100)); const contrib = w * norm; fit += contrib; if (contrib > 0 && (!top || contrib > top.c)) top = { k, c: contrib }; }
      return { ct: c, fit, top };
    }).filter(x => x.fit > 0).sort((a, b) => b.fit - a.fit);
  }
  function evaluate(){
    const text = els.evalInput.value || "";
    if (!text.trim()){ els.evalOut.innerHTML=""; return; }
    const rarityM = text.match(/Rarity:\s*([A-Za-z]+)/i);
    const rarity = rarityM ? rarityM[1].toLowerCase() : "";
    const isTablet = /precursor tablet|\btablet\b/i.test(text);
    const isWaystone = /waystone/i.test(text);
    const dangers = DANGER.filter(r=>r[1].test(text)).map(r=>r[0]);
    const sustain = SUSTAIN_RE.test(text);
    const ms = marketScore(text);
    let cls="warn", head="", lines=[], scoreHtml="";
    const rolls = {}; ms.rows.forEach(r => { rolls[r.key] = r.value; });
    const fits = contentFit(rolls);
    if (isTablet){
      const c = detectContent(text);
      const name = c ? c.label : "Generic / Precursor";
      const n = ms.rows.length;
      const norm = ms.rows.map(r => r.ceiling ? Math.min(1, r.value / r.ceiling) : 0);
      const q = norm.length ? norm.reduce((a,b)=>a+b,0)/norm.length : 0;
      const band = (n>=2 && q>=0.5) ? "Strong" : (n>=2 || q>=0.4) ? "Decent" : n>=1 ? "Light" : "Weak";
      if (band==="Strong"){ cls="good"; head=`✓ Strong ${name} tablet — use it`; }
      else if (band==="Decent"){ cls="good"; head=`✓ Decent ${name} tablet — worth using`; }
      else if (band==="Light"){ cls="warn"; head=`~ Light ${name} tablet — low roll, okay for cheap runs`; }
      else { cls="bad"; head=`✗ Weak ${name} tablet — sell/skip`; }
      scoreHtml = `<div class="scoreline">Approx. value <b>${esc(band)}</b><span>${c?`for ${esc(c.label)} content`:`generic`} · roll quality ${Math.round(q*100)}%</span></div>`;
      for (const r of ms.rows){ lines.push(`<span class="tag ${r.tagCls}">${esc(r.tagTxt)}</span>${esc(r.label)} ${r.value?`<b>${r.value}%</b>`:""}`); }
      if (c) lines.push(`<span class="tag mid">content</span>This is a <b>${esc(c.label)}</b> tablet — socket it in a Tower covering maps you run for ${esc(c.label)}.`);
      lines.push(`<span class="tag mid">master</span>Tablet effect scales with <b>Hilda</b> (Ancient Inscriptions, + per tablet type) when you run mixed tablets; otherwise pick your strategy master above.`);
    } else if (isWaystone){
      const ex = ms.headlineEx;
      const bestTxt = ms.best ? `${ms.best.label} ${ms.best.value}% ≈ ${ms.best.ex}ex` : "no reward stats";
      if (rarity==="normal"){ cls="warn"; head="White waystone — Alch (or Transmute→Aug→Regal), chase high Rarity / Pack Size"; }
      else if (rarity==="magic"){
        if (ex >= 20){ cls="good"; head=`Good blue (best: ${bestTxt}) — Regal then Exalt, push that roll higher`; }
        else if (ex > 0){ cls="warn"; head=`Weak blue (best: ${bestTxt}) — Aug toward Rarity / Pack Size, or reroll`; }
        else { cls="warn"; head="Weak blue — Augment for a reward mod, or Transmute-reroll"; }
      } else {
        if (ex >= 100){ cls="good"; head=`✓ Premium juice (best: ${bestTxt})${dangers.length?" — has risk mods, run anyway":""}`; }
        else if (ex >= 30){ cls=dangers.length?"warn":"good"; head=`Solid map (best: ${bestTxt}) — run it`; }
        else if (dangers.length){ cls="bad"; head="⚠ Risky rare, weak rewards — cheap throwaway only"; }
        else { cls="warn"; head=`Mediocre rare (best: ${bestTxt}) — okay to run, low market value`; }
      }
      scoreHtml = `<div class="scoreline">Est. floor value <b>≈ ${Math.round(ex)} ex</b><span>(its best stat priced off the curve)</span></div>`;
      for (const r of ms.rows){ lines.push(`<span class="tag ${r.tagCls}">${esc(r.tagTxt)}</span>${esc(r.label)} ${r.value?`<b>${r.value}%</b>`:""} <span style="color:var(--mu)">≈ ${r.ex}ex</span>`); }
      if (sustain) lines.push(`<span class="tag mid">sustain</span>Waystone drop chance — utility, not priced`);
      if (fits.length && fits[0].fit > 0.15){ const top = fits[0], driver = top.top ? statLabel(top.top.k) : ""; let pair = `<span class="tag mid">pair</span>Best for <b>${esc(top.ct.label)}</b>${driver?` (${esc(driver)}-heavy)`:""} — socket ${esc(top.ct.label)} tablets`; if (fits[1] && fits[1].fit >= top.fit * 0.8) pair += `, or ${esc(fits[1].ct.label)}`; lines.push(pair); }
    } else { cls="warn"; head="Couldn't tell if this is a waystone or tablet — paste the full copied item text"; }
    if (dangers.length) lines.push(`<span class="tag bad">risk</span>${dangers.join(", ")}`);
    els.evalOut.innerHTML = `<div class="verdict ${cls}"><div class="head">${esc(head)}</div>${scoreHtml}${lines.length?`<ul>${lines.map(l=>`<li>${l}</li>`).join("")}</ul>`:""}</div>`;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  els.evalBtn.addEventListener("click", evaluate);
  renderTabs();
  fillSelects();
  renderAll();
  loadCachedWeights();
  loadExchange();
};

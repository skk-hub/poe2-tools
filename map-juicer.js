window.__viewInit=window.__viewInit||{};
window.__viewInit["map-juicer"]=function(){
  const D = window.WAYSTONE_DATA;
  const T = D.tokens;
  let liveWeights = null;
  let weightStatus = "";
  function MW(){ return liveWeights || D.marketWeights; }
  const els = {
    tabs: document.getElementById("tabs"),
    panel: document.getElementById("panel"),
    patchline: document.getElementById("patchline"),
    fx: document.getElementById("fxRate"),
    footPatch: document.getElementById("footPatch"),
    evalInput: document.getElementById("evalInput"),
    evalBtn: document.getElementById("evalBtn"),
    evalOut: document.getElementById("evalOut"),
  };
  els.patchline.textContent = "Waystone juicing & stash regex · Patch " + D.patch + " · " + D.league;
  els.footPatch.textContent = D.patch;
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
  function runRegex(){ return `"ack s" "agic monst|onster eff|rar" !"${T.danger}"`; }
  function blueRegex(){ return `"${T.rewardBlue}" !"${T.danger}"`; }
  function tabletRegex(token){ return `"${token}" "${T.tabletDesirable}"`; }
  function regexCard(title, kind, regex, mods){
    const len = regex.length;
    const over = len > D.regexLimit;
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">${esc(title)}</span><span class="card-kind">${esc(kind)}</span></div>
        <div class="card-body">
          <div class="regexrow">
            <code class="regexbox">${esc(regex)}</code>
            <button class="copy" type="button" data-copy="${esc(regex)}">Copy</button>
          </div>
          <div class="meta"><span>quoted=AND · | =OR · !"…"=exclude</span><span class="${over?"over":""}">${len}/${D.regexLimit} chars</span></div>
          ${mods&&mods.length?`<ul class="modlist">${mods.map(m=>`<li>${esc(m)}</li>`).join("")}</ul>`:""}
        </div>
      </div>`;
  }
  function marketCard(){
    const mw = MW();
    if (!mw || !mw.stats || !mw.stats.length) return "";
    const live = /live refresh/i.test(mw.source || "") || !!liveWeights;
    const peak = (s) => s.peakEx || (s.curve && s.curve.length ? s.curve[s.curve.length-1][1] : 0) || 0;
    const maxLog = Math.log10(Math.max(10, ...mw.stats.map(peak)));
    const rows = mw.stats.map(s => {
      const pk = peak(s);
      const pct = Math.round((Math.log10(Math.max(1, pk)) / maxLog) * 100);
      const curveTxt = (s.curve || []).map(([p, ex]) => `${p}%→${ex}ex`).join("  ");
      const ceil = s.ceiling ? `rolls to ~${s.ceiling}%` : "";
      return `
        <div class="mw-row">
          <div class="mw-top">
            <span class="mw-name">${esc(s.label)}</span>
            <span class="mw-aim">peak ~${pk}ex</span>
            <span class="mw-floor">${esc(ceil)}</span>
          </div>
          <div class="mw-bar"><span style="width:${pct}%"></span></div>
          <div class="mw-curve">${esc(curveTxt)}</div>
          <div class="mw-tip">${esc(s.tip)}</div>
        </div>`;
    }).join("");
    return `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Mod value — price vs rolled %</span>
          <span class="card-kind">${live ? "live" : "baked"}</span>
          <button class="copy mw-refresh" id="weightRefresh" type="button" title="Re-sweep live Trade2 prices (rate-limited)">Refresh from market</button>
        </div>
        <div class="card-body">
          ${mw.note ? `<div class="mw-note-top">${esc(mw.note)}</div>` : ""}
          <div class="mw-list">${rows}</div>
          ${weightStatus ? `<div class="mw-status">${esc(weightStatus)}</div>` : ""}
          <div class="note">Trade2 Tier-16 price-vs-% sweep — ${live ? "live" : "baked"} (${esc(mw.analyzed)}, ${esc(mw.league)}). Curve = cheapest exalted listing at each rolled %. Same % isn't comparable across stats (different ceilings), so read the curve, not just the bar. <b>Refresh</b> re-runs it live (shared rate limit — at most once every ~2 min).</div>
        </div>
      </div>`;
  }
  function renderPanel(ct){
    const steps = D.juiceBase.slice();
    const juice = `
      <div class="card">
        <div class="card-head"><span class="card-title">Best way to juice (blue → juiced)</span><span class="card-kind">path</span></div>
        <div class="card-body">
          <ol class="steps">${steps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>
          <div class="note"><b>${esc(ct.label)}:</b> ${esc(ct.juiceNote)}</div>
        </div>
      </div>`;
    const picks = ct.omenPicks || [];
    const pickWhy = {}; picks.forEach(p => { pickWhy[p.name] = p.why; });
    const recBlock = picks.length ? `
          <div class="omen-rec">
            <div class="omen-rec-title">★ Best omens for ${esc(ct.label)}</div>
            ${picks.map(p => `<div class="omen-rec-item"><b>${esc(p.name)}</b> — ${esc(p.why)}</div>`).join("")}
          </div>` : "";
    const omens = `
      <div class="card">
        <div class="card-head"><span class="card-title">Omens that help juicing</span><span class="card-kind">omens</span></div>
        <div class="card-body">
          ${recBlock}
          <ul class="omenlist">${(D.omens||[]).map(o=>`
            <li class="${pickWhy[o.name]?"picked":""}">
              <div class="omen-name">${pickWhy[o.name]?`<span class="omen-star">★</span>`:""}${esc(o.name)} <span class="omen-orb">${esc(o.orb)}</span></div>
              <div class="omen-eff">${esc(o.effect)}</div>
              <div class="omen-use">${esc(pickWhy[o.name] || o.use)}</div>
            </li>`).join("")}</ul>
          <div class="note">Omens trigger automatically when you use the matching orb — carry only the one you want so they don't conflict.</div>
        </div>
      </div>`;
    els.panel.innerHTML =
      `<p class="panel-blurb">${esc(ct.blurb)}</p>` +
      marketCard() +
      regexCard(`Best ${ct.label} tablets`, "tablet", tabletRegex(ct.tabletToken),
        ["Pack Size / increased Monsters (content scaling)", "Rarity"]) +
      regexCard("Best 6-mod waystones to run", "waystone", runRegex(), D.waystoneTargets) +
      regexCard("Best blue waystones to upgrade", "waystone (magic)", blueRegex(),
        ["Any top reward mod already rolled", "no risky suffixes"]) +
      juice + omens;
    bindCopy();
    bindWeightRefresh();
  }
  function rerenderActive(){ renderPanel(D.contentTypes.find(c=>c.id===active) || D.contentTypes[0]); }
  function bindWeightRefresh(){
    const btn = els.panel.querySelector("#weightRefresh");
    if (!btn) return;
    btn.addEventListener("click", () => refreshWeights(false));
  }
  let refreshing = false;
  async function refreshWeights(force){
    if (refreshing) return;
    refreshing = true;
    weightStatus = "Sweeping live market prices… (~1 min, shared rate limit)";
    rerenderActive();
    const btn = els.panel.querySelector("#weightRefresh");
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
    finally { refreshing = false; rerenderActive(); }
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
  async function loadCachedWeights(){
    try {
      const r = await fetch("/api/waystone/market-weights");
      const d = await r.json();
      if (d && d.weights && d.weights.stats && d.weights.stats.length && d.weights.stats[0].curve){ liveWeights = d.weights; rerenderActive(); }
    } catch {}
  }
  function bindCopy(){
    els.panel.querySelectorAll("[data-copy]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const txt = b.getAttribute("data-copy");
        const orig = b.textContent;
        try { await navigator.clipboard.writeText(txt); b.textContent="Copied"; }
        catch { b.textContent="Copy failed"; }
        setTimeout(()=>{ b.textContent=orig; }, 1200);
      });
    });
  }
  let active = D.contentTypes[0].id;
  function renderTabs(){
    els.tabs.innerHTML = D.contentTypes.map(ct=>
      `<button class="tab ${ct.id===active?"active":""}" data-tab="${esc(ct.id)}">${esc(ct.label)}</button>`).join("");
    els.tabs.querySelectorAll("[data-tab]").forEach(b=>{
      b.addEventListener("click", ()=>{ active=b.getAttribute("data-tab"); renderTabs(); renderPanel(D.contentTypes.find(c=>c.id===active)); });
    });
  }
  const STAT_RE = { packSize: /pack size/i, monsterEffectiveness: /monster effectiveness|magic monster/i, itemRarity: /rarity of items|item rarity/i, monsterRarity: /monster rarity|rare monster/i };
  const SUSTAIN_RE = /waystones? (found|in area)|waystone drop/i;
  function statRoll(text, re){
    let found=false, value=0;
    for (const line of String(text).split(/\n/)){ if (!re.test(line)) continue; found = true; const m = line.match(/(\d+(?:\.\d+)?)\s*%/); if (m) value = Math.max(value, parseFloat(m[1])); }
    return { found, value };
  }
  const DANGER = [ ["less Recovery Rate", /less recovery rate/i], ["reduced Flask Charges", /reduced flask/i], ["-max Player Resistances", /maximum (player )?.*resistanc/i], ["less Cooldown Recovery", /less cooldown/i] ];
  function detectContent(t){ for (const ct of D.contentTypes){ if (ct.id!=="general" && new RegExp(ct.tabletToken,"i").test(t)) return ct; } return null; }
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
    return (D.contentTypes || []).filter(c => c.scalesWith).map(ct => {
      let fit = 0, top = null;
      for (const [k, w] of Object.entries(ct.scalesWith)){ const norm = Math.min(1, (rolls[k] || 0) / (ceil[k] || 100)); const contrib = w * norm; fit += contrib; if (contrib > 0 && (!top || contrib > top.c)) top = { k, c: contrib }; }
      return { ct, fit, top };
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
      const ct = detectContent(text);
      const name = ct ? ct.label : "Generic / Precursor";
      const n = ms.rows.length;
      const norm = ms.rows.map(r => r.ceiling ? Math.min(1, r.value / r.ceiling) : 0);
      const q = norm.length ? norm.reduce((a,b)=>a+b,0)/norm.length : 0;
      const band = (n>=2 && q>=0.5) ? "Strong" : (n>=2 || q>=0.4) ? "Decent" : n>=1 ? "Light" : "Weak";
      if (band==="Strong"){ cls="good"; head=`✓ Strong ${name} tablet — use it`; }
      else if (band==="Decent"){ cls="good"; head=`✓ Decent ${name} tablet — worth using`; }
      else if (band==="Light"){ cls="warn"; head=`~ Light ${name} tablet — low roll, okay for cheap runs`; }
      else { cls="bad"; head=`✗ Weak ${name} tablet — sell/skip`; }
      scoreHtml = `<div class="scoreline">Approx. value <b>${esc(band)}</b><span>${ct?`for ${esc(ct.label)} content`:`generic`} · roll quality ${Math.round(q*100)}%</span></div>`;
      for (const r of ms.rows){ lines.push(`<span class="tag ${r.tagCls}">${esc(r.tagTxt)}</span>${esc(r.label)} ${r.value?`<b>${r.value}%</b>`:""}`); }
      if (ct) lines.push(`<span class="tag mid">content</span>This is a <b>${esc(ct.label)}</b> tablet — socket it in a Tower covering maps you run for ${esc(ct.label)}.`);
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
  els.evalBtn.addEventListener("click", evaluate);
  renderTabs();
  renderPanel(D.contentTypes[0]);
  loadCachedWeights();
  loadExchange();
};

window.__viewInit=window.__viewInit||{};
window.__viewInit["map-juicer"]=function(){
  const D = window.WAYSTONE_DATA;
  const T = D.tokens;
  let liveWeights = null;            // upgraded by loadCachedWeights; only feeds the evaluator
  function MW(){ return liveWeights || D.marketWeights; }
  const els = {
    patchline: document.getElementById("patchline"),
    sheet: document.getElementById("mjSheet"),
    aside: document.getElementById("mjAside"),
    footPatch: document.getElementById("footPatch"),
    evalInput: document.getElementById("evalInput"),
    evalBtn: document.getElementById("evalBtn"),
    evalOut: document.getElementById("evalOut"),
  };
  els.patchline.textContent = "Waystone & precursor-tablet stash regex · Patch " + D.patch + " · " + D.league;
  if (els.footPatch) els.footPatch.textContent = D.patch;
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

  // ── %-aware regex generators (smoke-tested) ───────────────────────────────
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

  // ── Cheat sheet ───────────────────────────────────────────────────────────
  function rxcard(title, kind, body){
    return `<div class="rxcard">
      <div class="rxcard-head"><span class="rxcard-title">${esc(title)}</span><span class="rxcard-kind">${esc(kind)}</span></div>
      <div class="rxcard-body">${body}</div>
    </div>`;
  }
  function waystoneSection(){
    const opt = (v, cur) => `<option value="${v}"${v===cur?" selected":""}>${v}%</option>`;
    return rxcard("Waystones", "%-aware", `
      <div class="rx-thresholds">
        <label>Min Item Rarity <select id="rxRarity">${[40,50,60,70].map(v=>opt(v,rarityMin)).join("")}</select></label>
        <label>Min Pack Size <select id="rxPack">${[20,30,40].map(v=>opt(v,packMin)).join("")}</select></label>
      </div>
      ${regexRow(`Best maps to run — Rarity ≥${rarityMin}% or Pack ≥${packMin}%, no risk suffixes`, runRegex())}
      ${regexRow("Fully-juiced only — 6 mods / 0 revives left", noRevivesRegex(), "Revives drop 6→0 as mods are added; 0 revives = a 6-mod map (one death = fail).")}
      ${regexRow("Any reward mod — blue waystones worth upgrading", blueRegex())}
      <div class="rxcard-note">Matches the waystone "<b>Label: +X%</b>" reward block (0.5). Verify wording in your stash.</div>`);
  }
  function tabletSection(){
    const rows = D.contentTypes.map(c => regexRow(`${c.label} tablet`, tabletRegex(c.tabletToken), c.blurb)).join("");
    return rxcard("Precursor Tablets", "by content",
      rows + `<div class="rxcard-note">Socket in a Tower covering the maps you run. Each matches the content keyword + a desirable mod (pack size / monsters / rarity).</div>`);
  }
  function avoidSection(){
    const exclude = `"!${T.danger}"`;
    const danger = (D.dangerousMods||[]).map(m=>`<li>${esc(m)}</li>`).join("");
    const removed = (D.removedInPatch||[]).join(", ");
    return rxcard("Avoid / bait mods", "skip", `
      <div class="regexrow"><code class="regexbox">${esc(exclude)}</code><button class="copy" type="button" data-copy="${esc(exclude)}">Copy</button></div>
      <div class="rxcard-note">Excludes the risk suffixes (the run / blue regex already fold this in). Strip a bricked map with Omen of Whittling + Chaos.</div>
      <ul class="avoidlist">${danger}</ul>
      ${removed?`<div class="rxcard-note">Removed in 0.5 (don't target): <b>${esc(removed)}</b></div>`:""}`);
  }
  function renderSheet(){
    els.sheet.innerHTML = waystoneSection() + tabletSection() + avoidSection();
    bindCopy();
    bindThresholds();
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
  function bindThresholds(){
    const r = els.sheet.querySelector("#rxRarity"), p = els.sheet.querySelector("#rxPack");
    if (r) r.addEventListener("change", () => { rarityMin = Number(r.value) || 60; renderSheet(); });
    if (p) p.addEventListener("change", () => { packMin = Number(p.value) || 30; renderSheet(); });
  }

  // ── Mod value table (sorted affixes) + live Trade2 refresh ────────────────
  function peakEx(s){ return s.peakEx || (s.curve && s.curve.length ? s.curve[s.curve.length-1][1] : 0) || 0; }
  let mwStatus = "", refreshing = false;
  function renderMarket(){
    const mw = MW();
    if (!mw || !mw.stats || !mw.stats.length){ els.aside.innerHTML = ""; return; }
    const live = !!liveWeights || /live refresh/i.test(mw.source || "");
    const stats = mw.stats.slice().sort((a,b)=>peakEx(b)-peakEx(a));
    const max = Math.max(1, ...stats.map(peakEx));
    const rows = stats.map(s=>{
      const pk = peakEx(s), pct = Math.round(pk / max * 100);
      return `<tr>
        <td><div class="mw-name">${esc(s.label)}</div><div class="mw-bar"><span style="width:${pct}%"></span></div></td>
        <td class="mw-val"><b>${pk}</b> ex${s.ceiling?`<span class="mw-cap">cap ~${s.ceiling}%</span>`:""}</td>
      </tr>`;
    }).join("");
    els.aside.innerHTML = `
      <div class="rxcard mj-mod">
        <div class="rxcard-head"><span class="rxcard-title">Mod Value</span><span class="rxcard-kind">${live?"live":"baked"}</span></div>
        <div class="rxcard-body">
          <table class="mwtable"><thead><tr><th>Affix</th><th>Peak value</th></tr></thead><tbody>${rows}</tbody></table>
          ${mwStatus?`<div class="mw-status">${esc(mwStatus)}</div>`:""}
          <button class="mw-refresh" id="weightRefresh" type="button"${refreshing?" disabled":""}>${refreshing?"Sweeping…":"Refresh from market"}</button>
          <div class="rxcard-note">Tier-16 price-vs-% sweep${mw.analyzed?` · ${esc(mw.analyzed)}`:""}. Peak ex at the stat's best roll; re-run each patch.</div>
        </div>
      </div>`;
    const btn = els.aside.querySelector("#weightRefresh");
    if (btn) btn.addEventListener("click", ()=>refreshWeights(false));
  }
  async function refreshWeights(force){
    if (refreshing) return;
    refreshing = true; mwStatus = "Sweeping live market prices… (~1 min, shared rate limit)"; renderMarket();
    try {
      const r = await fetch("/api/waystone/market-weights/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: !!force }) });
      const d = await r.json();
      if (d.weights) liveWeights = d.weights;
      if (d.limited) mwStatus = "Trade2 rate-limited — showing last result. Try again in a few minutes.";
      else if (d.cooldown) mwStatus = "Refreshed recently — showing latest (cooldown ~2 min).";
      else if (d.refreshed) mwStatus = "Updated from live market just now.";
      else if (d.error) mwStatus = "Refresh failed: " + d.error;
      else mwStatus = "No market data returned.";
    } catch { mwStatus = "Refresh failed (is the local server running?)."; }
    finally { refreshing = false; renderMarket(); }
  }
  async function loadCachedWeights(){
    try {
      const r = await fetch("/api/waystone/market-weights");
      const d = await r.json();
      if (d && d.weights && d.weights.stats && d.weights.stats.length && d.weights.stats[0].curve){ liveWeights = d.weights; renderMarket(); }
    } catch {}
  }

  // ── Paste evaluator (kept) ────────────────────────────────────────────────
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
  renderSheet();
  renderMarket();
  loadCachedWeights();
};

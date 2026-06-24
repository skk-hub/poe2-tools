window.__viewInit=window.__viewInit||{};
window.__viewInit["map-juicer"]=function(){
  const D = window.WAYSTONE_DATA;
  const T = D.tokens;
  let liveWeights = null;            // upgraded by loadCachedWeights; only feeds the evaluator
  function MW(){ return liveWeights || D.marketWeights; }
  // The live sweep doesn't price every stat (waystoneDrop is an estimate, not
  // Trade2-swept), so merge in any baked stat it omits — else it vanishes from
  // the Mod Value table the moment live weights load.
  function mergeLive(live){
    if (!live || !live.stats) return live;
    const have = new Set(live.stats.map(s => s.key));
    const extra = (D.marketWeights.stats || []).filter(s => !have.has(s.key));
    return Object.assign({}, live, { stats: live.stats.concat(extra) });
  }
  const els = {
    patchline: document.getElementById("patchline"),
    sheet: document.getElementById("mjSheet"),
    aside: document.getElementById("mjAside"),
    footPatch: document.getElementById("footPatch"),
    evalInput: document.getElementById("evalInput"),
    evalBtn: document.getElementById("evalBtn"),
    evalOut: document.getElementById("evalOut"),
  };
  els.patchline.textContent = "Waystone & tablet stash regex · Patch " + D.patch + " · " + D.league;
  if (els.footPatch) els.footPatch.textContent = D.patch;
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

  // ── %-aware regex generators (smoke-tested) ───────────────────────────────
  const L = D.tokens.line;
  let rarityMin = 0, packMin = 0, wdropMin = 0;   // all start at 0 (off) — build up from nothing; wdrop is 0 or 100
  const DUMP_CAP_EX = 40;   // "low value" cutoff for the dump filter (baked — see buildDump)
  // Match a number ≥ pct (pct is a multiple of 10). Two-digit: first digit
  // (pct/10)…9 + any second digit (so ≥ pct); OR any three-digit (100+). Uses
  // [0-9] not "." so it can't swallow the trailing "%". The label token carries the
  // stat name; we bridge the real in-stash format "Label: +X%" with ": \+…%".
  function geNum(pct){
    if (pct >= 100) return "[0-9][0-9][0-9]";                    // 100%+ only
    const d = Math.max(1, Math.floor(pct / 10));
    return `([${d}-9][0-9]|[0-9][0-9][0-9])`;
  }
  function atLeast(token, pct){ return `${token}: \\+${geNum(pct)}%`; }
  function noRevivesRegex(){ return `"${T.revivesZero}"`; }

  // ── Regex Forge — answer a few questions, the regex rebuilds on every change ──
  let target = "waystones";    // "waystones" | "tablets"
  let wMatch = "floor";        // "floor" (rarity/pack ≥) | "blue" (any reward mod)
  let wRevives = false;        // require fully-juiced (0 revives)
  let wExclude = false;        // exclude risk suffixes — off by default; tick it when you want it
  let wCorrupt = false;        // require Corrupted
  const tContent = new Set();  // selected tablet content-type ids
  const tMods = new Set();      // selected desirable-mod tokens to require
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Desirable mods available for the current content picks: each content's own list, then the general set.
  function gatherDesirables(){
    const seen = new Set(), out = [];
    const add = m => { if (!seen.has(m.token)) { seen.add(m.token); out.push(m); } };
    D.contentTypes.filter(c => tContent.has(c.id)).forEach(c => (c.desirable || []).forEach(add));
    (D.tabletGeneral || []).forEach(add);
    return out;
  }

  // Lowest 10%-decade at which `stat` alone is worth >= capEx, read off its baked
  // price curve. Floored to the decade so we stay CONSERVATIVE: a roll anywhere in
  // that decade *could* clear the cap, so we exclude the whole band rather than risk
  // dumping a valuable map. Returns null if the stat never reaches capEx.
  function dumpThreshold(stat, capEx){
    const top = stat.ceiling || 130;
    for (let p = 10; p <= top; p++){ if (curveEx(stat.curve, p) >= capEx) return Math.max(10, Math.floor(p/10)*10); }
    return null;
  }
  // "Low-value dump" filter: fully exalt-slammed (0 revives) + Corrupted waystones
  // worth roughly under DUMP_CAP_EX. A map's value ≈ its single best reward stat
  // (see waystone-data marketWeights note), so a map is low-value when EVERY stat is
  // below its cap threshold — we require corrupted + 0 revives and exclude any stat
  // rolled into its >=cap band. Stats that can't reach the cap alone (peakEx < cap)
  // need no exclusion. Thresholds come from the baked curves — no live scan needed.
  function buildDump(){
    const blocks = [`"${T.corrupted}"`, `"${T.revivesZero}"`];
    for (const s of (MW().stats || [])){
      if (!s.curve || !s.curve.length || (s.peakEx || 0) < DUMP_CAP_EX) continue;
      const tok = L[s.key]; if (!tok) continue;
      const decade = dumpThreshold(s, DUMP_CAP_EX);
      if (decade != null) blocks.push(`"!${atLeast(tok, decade)}"`);
    }
    return blocks.join(" ");
  }

  function buildWaystone(){
    if (wMatch === "dump") return buildDump();
    const blocks = [];
    if (wMatch === "blue") {
      blocks.push(`"(${L.itemRarity}|${L.packSize}|${L.monsterRarity}|${L.monsterEffectiveness}|${L.waystoneDrop})"`);
    } else {
      // Each set floor is its OWN quoted block = AND in stash regex: a waystone must
      // clear EVERY minimum you set (not just one). One block per stat, not a single
      // `|`-joined block — that OR'd them, so a high Drop roll alone passed and the
      // pack/rarity floor got "ignored".
      if (rarityMin > 0) blocks.push(`"${atLeast(L.itemRarity, rarityMin)}"`);
      if (packMin > 0)   blocks.push(`"${atLeast(L.packSize, packMin)}"`);
      if (wdropMin > 0)  blocks.push(`"${atLeast(L.waystoneDrop, wdropMin)}"`);
    }
    if (wRevives) blocks.push(noRevivesRegex());
    if (wCorrupt) blocks.push(`"${T.corrupted}"`);
    if (wExclude) blocks.push(`"!${T.danger}"`);
    return blocks.join(" ");
  }
  function buildTablet(){
    const toks = D.contentTypes.filter(c => tContent.has(c.id)).map(c => c.tabletToken);
    if (!toks.length) return "";
    const kw = toks.length === 1 ? `"${toks[0]}"` : `"(${toks.join("|")})"`;
    const mods = gatherDesirables().map(m => m.token).filter(t => tMods.has(t));
    if (!mods.length) return kw;
    const md = mods.length === 1 ? `"${mods[0]}"` : `"(${mods.join("|")})"`;
    return `${kw} ${md}`;
  }
  function currentRegex(){ return target === "tablets" ? buildTablet() : buildWaystone(); }

  // ── Controls ──
  function seg(attr, val, cur, label){ return `<button class="seg-btn${val===cur?" on":""}" type="button" data-${attr}="${val}">${esc(label)}</button>`; }
  function stepper(id, label, val, lo, hi){
    return `<div class="forge-step"><span class="forge-step-lbl">${esc(label)}</span>
      <button class="step" type="button" data-step="${id}" data-dir="-1"${val<=lo?" disabled":""} aria-label="decrease ${esc(label)}">−</button>
      <span class="forge-step-val">${val}%</span>
      <button class="step" type="button" data-step="${id}" data-dir="1"${val>=hi?" disabled":""} aria-label="increase ${esc(label)}">+</button></div>`;
  }
  function toggle(id, label, on){
    return `<label class="forge-tog"><input type="checkbox" data-tog="${id}"${on?" checked":""}><span>${esc(label)}</span></label>`;
  }
  function waystoneQs(){
    const segs = `<div class="forge-seg" role="group" aria-label="Match mode">${seg("wmatch","floor",wMatch,"Rarity / Pack floor")}${seg("wmatch","blue",wMatch,"Any reward mod")}${seg("wmatch","dump",wMatch,"Low-value dump")}</div>`;
    if (wMatch === "dump") {
      return `${segs}<p class="forge-hint">Finds <b>corrupted, fully-juiced</b> waystones worth roughly <b>under ${DUMP_CAP_EX} ex</b> — the cheap slammed maps safe to dump/vendor. Requires Corrupted + 0 revives and excludes any reward stat rolled high enough to be worth ~${DUMP_CAP_EX}ex+ (thresholds read off the baked Mod Value curves — no price refresh needed). Value ≈ best stat, so spot-check a map carrying several mid rolls.</p>`;
    }
    return `
      ${segs}
      ${wMatch==="floor"
        ? `<div class="forge-steps">${stepper("rarity","Min Item Rarity",rarityMin,0,70)}${stepper("pack","Min Pack Size",packMin,0,40)}</div><p class="forge-hint">Every minimum you set is <b>required</b> (AND) — a stone must clear all of them. Set a stat to 0 to drop it.</p>`
        : `<p class="forge-hint">Matches any waystone carrying a reward mod — the blue stones worth upgrading.</p>`}
      ${wMatch==="floor" ? toggle("wdrop","Require Waystone Drop ≥100% (midrange isn't worth it)",wdropMin>=100) : ""}
      ${toggle("revives","Fully juiced only (0 revives = 6-mod map)",wRevives)}
      ${toggle("corrupt","Corrupted only",wCorrupt)}
      ${toggle("exclude","Exclude risk suffixes (less recovery, −max res, …)",wExclude)}`;
  }
  function tabletQs(){
    const chips = D.contentTypes.map(c => `<button class="chip${tContent.has(c.id)?" on":""}" type="button" data-chip="${c.id}">${esc(c.label)}</button>`).join("");
    let mods = "";
    if (tContent.size){
      const modChips = gatherDesirables().map(m => `<button class="chip${tMods.has(m.token)?" on":""}" type="button" data-mod="${esc(m.token)}">${esc(m.label)}</button>`).join("");
      mods = `<p class="forge-hint">Optionally require some of these mods (tick to add — none required by default):</p><div class="forge-chips">${modChips}</div>`;
    }
    return `
      <p class="forge-hint">Pick the content you're farming — socket the tablet in a Tower covering those maps.</p>
      <div class="forge-chips">${chips}</div>
      ${mods}`;
  }
  function forgeOutput(){
    const rx = currentRegex(), len = rx.length, over = len > D.regexLimit, empty = !rx;
    const ph = target === "tablets" ? "Pick at least one content type…" : "Set a minimum on at least one stat…";
    return `<div class="forge-out${empty?" empty":""}">
      <code class="regexbox">${empty ? ph : esc(rx)}</code>
      <div class="forge-meta">
        <span class="rx-len ${over?"over":""}">${len}/${D.regexLimit}</span>
        <button class="copy" type="button" data-copy="${esc(rx)}"${empty?" disabled":""}>Copy</button>
      </div>
    </div>`;
  }
  function renderSheet(){
    const note = target === "tablets"
      ? `Each block is <code>"keyword"</code> AND <code>"desirable"</code>; multiple picks become <code>"(a|b|c)"</code>. Verify wording in your stash.`
      : `Matches the waystone "<b>Label: +X%</b>" reward block (0.5). Risk excluded: <b>${esc((D.dangerousMods||[]).join(", "))}</b>.`;
    els.sheet.innerHTML = `<div class="rxcard rx-forge">
      <div class="rxcard-head"><span class="rxcard-title">Regex Forge</span><span class="rxcard-kind">live</span></div>
      <div class="rxcard-body">
        <div class="forge-seg forge-target" role="group" aria-label="Target">${seg("target","waystones",target,"Waystones")}${seg("target","tablets",target,"Tablets")}</div>
        <div class="forge-qs">${target==="tablets" ? tabletQs() : waystoneQs()}</div>
        ${forgeOutput()}
        <div class="rxcard-note">${note}</div>
      </div>
    </div>`;
    bindForge();
    bindCopy();
  }
  function bindForge(){
    const root = els.sheet;
    root.querySelectorAll("[data-target]").forEach(b => b.addEventListener("click", () => { target = b.getAttribute("data-target"); renderSheet(); }));
    root.querySelectorAll("[data-wmatch]").forEach(b => b.addEventListener("click", () => { wMatch = b.getAttribute("data-wmatch"); renderSheet(); }));
    root.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
      const dir = Number(b.getAttribute("data-dir")), id = b.getAttribute("data-step");
      if (id === "rarity") rarityMin = clamp(rarityMin + dir*10, 0, 70);
      else packMin = clamp(packMin + dir*10, 0, 40);
      renderSheet();
    }));
    root.querySelectorAll("[data-tog]").forEach(c => c.addEventListener("change", () => {
      const k = c.getAttribute("data-tog");
      if (k === "revives") wRevives = c.checked; else if (k === "exclude") wExclude = c.checked; else if (k === "corrupt") wCorrupt = c.checked; else if (k === "wdrop") wdropMin = c.checked ? 100 : 0;
      renderSheet();
    }));
    root.querySelectorAll("[data-chip]").forEach(b => b.addEventListener("click", () => {
      const id = b.getAttribute("data-chip"), c = D.contentTypes.find(x => x.id === id);
      if (tContent.has(id)) tContent.delete(id);
      else tContent.add(id);   // no mods pre-picked — tick the ones you want
      renderSheet();
    }));
    root.querySelectorAll("[data-mod]").forEach(b => b.addEventListener("click", () => {
      const t = b.getAttribute("data-mod"); tMods.has(t) ? tMods.delete(t) : tMods.add(t); renderSheet();
    }));
  }
  async function copyText(txt){
    // navigator.clipboard only exists in a secure context (HTTPS/localhost).
    // Over LAN/Tailscale on plain HTTP it's undefined → fall back to execCommand.
    if (navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(txt); return true;
    }
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  function bindCopy(){
    document.querySelectorAll(".toolroot-mj [data-copy]").forEach(b=>{
      b.addEventListener("click", async (e)=>{
        e.preventDefault(); e.stopPropagation();   // don't toggle the <details> it sits in
        const txt = b.getAttribute("data-copy"), orig = b.textContent;
        let ok = false;
        try { ok = await copyText(txt); } catch { ok = false; }
        b.textContent = ok ? "Copied" : "Copy failed";
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
  function asideSlots(){
    if (!document.getElementById("mjAsideW")) els.aside.innerHTML = '<div id="mjAsideW"></div><div id="mjAsideT"></div>';
    return { w: document.getElementById("mjAsideW"), t: document.getElementById("mjAsideT") };
  }
  function renderMarket(){
    const mw = MW();
    const slot = asideSlots().w;
    if (!mw || !mw.stats || !mw.stats.length){ slot.innerHTML = ""; return; }
    const live = !!liveWeights || /live refresh/i.test(mw.source || "");
    const stats = mw.stats.slice().sort((a,b)=>peakEx(b)-peakEx(a));
    const max = Math.max(1, ...stats.map(peakEx));
    const rows = stats.map(s=>{
      const pk = peakEx(s), pct = Math.round(pk / max * 100);
      return `<li class="mw-item">
        <div class="mw-line"><span class="mw-name">${esc(s.label)}${s.est?` <span title="estimate — not yet Trade2-swept" style="color:var(--mu);font-size:.8em">(est)</span>`:""}</span><span class="mw-val"><b>${pk}</b> ex</span></div>
        <div class="mw-bar"><span style="width:${pct}%"></span></div>
        ${s.ceiling?`<div class="mw-cap">best roll caps ~${s.ceiling}%</div>`:""}
      </li>`;
    }).join("");
    slot.innerHTML = `
      <div class="rxcard mj-mod">
        <div class="rxcard-head"><span class="rxcard-title">Waystone Mod Value</span><span class="rxcard-kind">${live?"live":"baked"}</span></div>
        <div class="rxcard-body">
          <div class="mw-legend">Bar = peak value vs. the most valuable mod</div>
          <ul class="mwlist">${rows}</ul>
          ${mwStatus?`<div class="mw-status">${esc(mwStatus)}</div>`:""}
          <button class="mw-refresh" id="weightRefresh" type="button"${refreshing?" disabled":""}>${refreshing?"Sweeping…":"Refresh from market"}</button>
          <div class="rxcard-note">Tier-16 price-vs-% sweep${mw.analyzed?` · ${esc(mw.analyzed)}`:""}. Re-run each patch.</div>
        </div>
      </div>`;
    const btn = slot.querySelector("#weightRefresh");
    if (btn) btn.addEventListener("click", ()=>refreshWeights(false));
  }

  // ── Tablet Mod Value (curated divine values) ──────────────────────────────
  // Tablets are MULTI-MOD so value is combination-driven — these are ground-truth
  // divine values (see waystone-data.js): `div` solo, `comboDiv` paired peak,
  // `pairs` = low-solo/high-paired, `priceCheck` = "price-check if 2+".
  function modWorth(m){ return m.comboDiv || m.div || 0; }
  function valBadge(m){
    if (m.priceCheck) return `<span class="tag mid">stack</span>`;
    if (m.div != null){ const txt = m.comboDiv && m.comboDiv > m.div ? `${m.div}–${m.comboDiv} div` : `${m.div} div`; const cls = modWorth(m) >= 10 ? "good" : modWorth(m) >= 2 ? "mid" : "bad"; return `<span class="tag ${cls}">${txt}</span>`; }
    if (m.pairs) return `<span class="tag mid">pairs ↑</span>`;
    if (m.enabler) return `<span class="tag bad">enabler</span>`;
    return "";
  }
  function tabletGroups(){
    // mechanic content first (only those with desirable mods), then the generic enablers
    const groups = (D.contentTypes || [])
      .filter(c => (c.desirable || []).length)
      .map(c => ({ name: c.label, note: c.valueNote || "", mods: c.desirable.slice() }));
    groups.push({ name: "Generic juicing (any tablet)", note: "", mods: (D.tabletGeneral || []).slice() });
    return groups;
  }
  function renderTabletValue(){
    const slot = asideSlots().t;
    const groups = tabletGroups();
    const sections = groups.map(g => {
      const mods = g.mods.slice().sort((a, b) => (b.priceCheck - a.priceCheck) || (modWorth(b) - modWorth(a)) || a.label.localeCompare(b.label));
      const items = mods.map(m => `<li class="tv-item">
        <div class="tv-line"><span class="tv-name">${esc(m.label)}</span>${valBadge(m)}</div>
        ${m.note ? `<div class="tv-sub">${esc(m.note)}</div>` : ""}
      </li>`).join("");
      return `<details class="tv-group"><summary class="tv-grouphead">${esc(g.name)}${g.note ? `<span class="tv-pc">${esc(g.note)}</span>` : ""}</summary><ul class="tvlist">${items}</ul></details>`;
    }).join("");
    slot.innerHTML = `
      <div class="rxcard mj-mod">
        <div class="rxcard-head"><span class="rxcard-title">Tablet Mod Value</span><span class="rxcard-kind">divine</span></div>
        <div class="rxcard-body">
          <div class="mw-legend">Values in divine · tablet value is COMBO-driven (a mod's worth jumps when paired)</div>
          ${sections}
          <div class="rxcard-note"><b>Combine for value:</b> a chase mod + good generic juicing (or 2+ mechanic mods) is worth far more than any single roll. <span style="color:var(--mu)">stack = price-check if you have 2+ · enabler = generic juicing, low alone.</span></div>
        </div>
      </div>`;
  }
  async function refreshWeights(force){
    if (refreshing) return;
    refreshing = true; mwStatus = "Sweeping live market prices… (~1 min, shared rate limit)"; renderMarket();
    try {
      const r = await fetch("/api/waystone/market-weights/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: !!force }) });
      const d = await r.json();
      if (d.weights) liveWeights = mergeLive(d.weights);
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
      if (d && d.weights && d.weights.stats && d.weights.stats.length && d.weights.stats[0].curve){ liveWeights = mergeLive(d.weights); renderMarket(); }
    } catch {}
  }

  // ── Paste evaluator (kept) ────────────────────────────────────────────────
  const STAT_RE = { packSize: /pack size/i, monsterEffectiveness: /monster effectiveness|magic monster/i, itemRarity: /rarity of items|item rarity/i, monsterRarity: /monster rarity|rare monster/i, waystoneDrop: /waystones? (found|in area)|waystone drop/i };
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
    const isTablet = /\btablet\b/i.test(text);
    const isWaystone = /waystone/i.test(text);
    const dangers = DANGER.filter(r=>r[1].test(text)).map(r=>r[0]);
    const ms = marketScore(text);
    let cls="warn", head="", lines=[], scoreHtml="";
    const rolls = {}; ms.rows.forEach(r => { rolls[r.key] = r.value; });
    const fits = contentFit(rolls);
    if (isTablet){
      const c = detectContent(text);
      const name = c ? c.label : "Generic tablet";
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
      if (fits.length && fits[0].fit > 0.15){ const top = fits[0], driver = top.top ? statLabel(top.top.k) : ""; let pair = `<span class="tag mid">pair</span>Best for <b>${esc(top.ct.label)}</b>${driver?` (${esc(driver)}-heavy)`:""} — socket ${esc(top.ct.label)} tablets`; if (fits[1] && fits[1].fit >= top.fit * 0.8) pair += `, or ${esc(fits[1].ct.label)}`; lines.push(pair); }
    } else { cls="warn"; head="Couldn't tell if this is a waystone or tablet — paste the full copied item text"; }
    if (dangers.length) lines.push(`<span class="tag bad">risk</span>${dangers.join(", ")}`);
    els.evalOut.innerHTML = `<div class="verdict ${cls}"><div class="head">${esc(head)}</div>${scoreHtml}${lines.length?`<ul>${lines.map(l=>`<li>${l}</li>`).join("")}</ul>`:""}</div>`;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  els.evalBtn.addEventListener("click", evaluate);
  renderSheet();
  renderMarket();
  renderTabletValue();
  loadCachedWeights();
};

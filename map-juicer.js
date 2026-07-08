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
    const baked = new Map((D.marketWeights.stats || []).map(s => [s.key, s]));
    // A sweep's ceiling is only the max roll SEEN in listings — never let it shrink the known roll cap.
    const stats = live.stats.map(s => Object.assign({}, s, { ceiling: Math.max(s.ceiling || 0, (baked.get(s.key) || {}).ceiling || 0) }));
    const have = new Set(stats.map(s => s.key));
    const extra = (D.marketWeights.stats || []).filter(s => !have.has(s.key));
    return Object.assign({}, live, { stats: stats.concat(extra) });
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
  let rarityMin = 0, packMin = 0, effMin = 0, monRarMin = 0, wdropMin = 0;   // floor mins — all start at 0 (off), build up from nothing
  // Dump = corrupted + 0-revive stones whose BEST reward stat is worth less than the
  // cutoff, priced against the LIVE market curve (not hand-set thresholds). Each stat's
  // keep-% is derived at render time from curveEx: the lowest roll that clears the cutoff.
  // A stat that can't reach the cutoff even maxed gets no keep block (can't rescue).
  let dropKeep = 115;        // keep Waystone Drop Chance >= this% — SUSTAIN rule (personal, not resale); its curve is flat at baseline, so it's kept separately, NOT via the value cutoff. 0 = dump any drop roll
  let dumpCutoffC = null;    // dump if best reward stat < this many chaos; lazy-inits to ~2.5× baseline (the "good roll" tier). Converted to ex via chaosRate() for the curve lookup
  // Match a number ≥ pct — EXACT for any threshold, not just multiples of 10
  // (≥45 must not match 40-44; ≥5 must match 5-9). Uses [0-9] not "." so it
  // can't swallow the trailing "%". The label token carries the stat name; we
  // bridge the real in-stash format "Label: +X%" with ": \+…%". Multiples of 10
  // keep the historical compact form ([d-9][0-9]) so default regexes don't churn;
  // in-game search caps regex length, so every branch stays as short as it can.
  function geNum(pct, ceiling){
    // 3-digit threshold (e.g. Drop Chance >=115): match 1XX >= pct. Same-tens with
    // units>=u, OR any higher tens. Lets the Drop keep be an exact %, not just "100+".
    if (pct > 100 && pct < 200){
      const tens = Math.floor((pct % 100) / 10), units = pct % 10;
      const hi = tens >= 9 ? "" : `|1[${tens + 1}-9][0-9]`;
      return `(1${tens}[${units}-9]${hi})`;
    }
    if (pct >= 100) return "[0-9][0-9][0-9]";                    // exactly 100% = any 3-digit
    // If the stat can't roll into three digits, omit the 100+ alternation — keeps the
    // dump regex short enough to stack several exclusions under the 250-char limit.
    const three = (ceiling && ceiling < 100) ? "" : "|[0-9][0-9][0-9]";
    if (pct < 10) return `([${Math.max(1, pct)}-9]|[1-9][0-9]${three})`;   // single digit OR any 2-digit
    const tens = Math.floor(pct / 10), units = pct % 10;
    if (units === 0){                                            // multiple of 10 — compact form
      const two = `[${tens}-9][0-9]`;
      return three ? `(${two}${three})` : two;
    }
    // e.g. ≥45 → 4[5-9] (same tens, units ≥5) OR [5-9][0-9] (any higher tens)
    const hi = tens >= 9 ? "" : `|[${tens + 1}-9][0-9]`;
    return `(${tens}[${units}-9]${hi}${three})`;
  }
  function atLeast(token, pct, ceiling){ return `${token}: \\+${geNum(pct, ceiling)}%`; }
  function noRevivesRegex(){ return `"${T.revivesZero}"`; }

  // ── Regex Forge — answer a few questions, the regex rebuilds on every change ──
  let target = "waystones";    // "waystones" | "tablets"
  let wMatch = "floor";        // "floor" (all-stat ≥ mins) | "dump" (low-value dump)
  let wRevives = false;        // require fully-juiced (0 revives)
  let wExclude = false;        // exclude risk suffixes — off by default; tick it when you want it
  let wCorrupt = false;        // require Corrupted
  let wNotRevives = false;     // exclude fully-juiced (keep maps that still have revives)
  let wNotCorrupt = false;     // exclude Corrupted
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

  // "Low-value dump" filter, priced off the LIVE market curve. Dump = corrupted +
  // 0-revive stones whose reward stats are ALL worth less than the cutoff. Each stat's
  // keep-% is derived from curveEx (the lowest roll clearing the cutoff), so a live
  // Mod-Value sweep actually moves the dump. Solo-OR: a stone is kept if ANY single
  // stat clears the cutoff (stash regex can't AND-of-keeps for true combos — use the
  // paste evaluator for those). Drop Chance is priced flat, so it's a separate sustain keep.
  const DUMP_KEYS = { itemRarity: L.itemRarity, packSize: L.packSize, monsterEffectiveness: L.monsterEffectiveness, monsterRarity: L.monsterRarity };
  function cutoffDefaultC(){ return Math.max(1, Math.round((baseEx() * 2.5) / chaosRate())); }   // ~2.5× baseline = the "good roll" tier (valTier)
  function dumpCutoffEx(){ if (dumpCutoffC == null) dumpCutoffC = cutoffDefaultC(); return dumpCutoffC * chaosRate(); }
  // Lowest integer roll % where this stat's live curve clears the cutoff. null = can't
  // reach it even at its ceiling → the stat can never rescue a stone, so no keep block.
  function dumpThreshold(stat, cutoffEx){
    const ceil = Math.round(stat.ceiling || 100);
    if (curveEx(stat.curve, ceil) < cutoffEx) return null;
    for (let p = 1; p <= ceil; p++){ if (curveEx(stat.curve, p) >= cutoffEx) return p; }
    return null;
  }
  function buildDump(){
    const blocks = [ `"${T.corrupted}"`, `"${T.revivesZero}"` ];
    const cutoffEx = dumpCutoffEx();
    // Keep (exclude from dump) any stone with a stat that clears the cutoff on the live curve.
    for (const s of ((MW() && MW().stats) || [])){
      const tok = DUMP_KEYS[s.key]; if (!tok) continue;
      const th = dumpThreshold(s, cutoffEx); if (th == null) continue;
      blocks.push(`"!${atLeast(tok, th, s.ceiling)}"`);
    }
    if (dropKeep > 0) blocks.push(`"!${atLeast(L.waystoneDrop, dropKeep)}"`);   // sustain keep, not resale
    return blocks.join(" ");
  }

  function buildWaystone(){
    if (wMatch === "dump") return buildDump();
    const blocks = [];
    // Each set floor is its OWN quoted block = AND in stash regex: a waystone must clear EVERY
    // minimum you set (not just one). One block per stat, not a single `|`-joined block — that
    // OR'd them, so a high Drop roll alone passed and the pack/rarity floor got "ignored".
    if (rarityMin > 0) blocks.push(`"${atLeast(L.itemRarity, rarityMin)}"`);
    if (packMin > 0)   blocks.push(`"${atLeast(L.packSize, packMin)}"`);
    if (effMin > 0)    blocks.push(`"${atLeast(L.monsterEffectiveness, effMin, 70)}"`);
    if (monRarMin > 0) blocks.push(`"${atLeast(L.monsterRarity, monRarMin, 60)}"`);
    if (wdropMin > 0)  blocks.push(`"${atLeast(L.waystoneDrop, wdropMin)}"`);
    if (wRevives) blocks.push(noRevivesRegex());
    else if (wNotRevives) blocks.push(`"!${T.revivesZero}"`);
    if (wCorrupt) blocks.push(`"${T.corrupted}"`);
    else if (wNotCorrupt) blocks.push(`"!${T.corrupted}"`);
    if (wExclude) blocks.push(`"!${T.danger}"`);
    return blocks.join(" ");
  }
  function buildTablet(){
    const toks = D.contentTypes.filter(c => tContent.has(c.id)).map(c => c.tabletToken);
    if (!toks.length) return "";
    // Content types OR into one block — a tablet is ONE mechanic, so "(breach|ritual)"
    // = "either". Each ticked mod gets its OWN quoted block = AND in stash search: the
    // tablet must have ALL ticked mods. (Was a single |-joined OR group, so ticking
    // Effectiveness + Rarity matched a tablet with EITHER — a pure-Rarity tablet showed
    // when you wanted Effectiveness. That's the "shows others" bug.)
    const kw = toks.length === 1 ? `"${toks[0]}"` : `"(${toks.join("|")})"`;
    const mods = gatherDesirables().map(m => m.token).filter(t => tMods.has(t)).map(t => `"${t}"`);
    return mods.length ? `${kw} ${mods.join(" ")}` : kw;
  }
  function currentRegex(){ return target === "tablets" ? buildTablet() : buildWaystone(); }

  // ── Pinned regexes (localStorage, persist across sessions) ──
  // Built expressions are throwaway by default — rebuild them through the forge each
  // time. Pin one to keep it: it lands in the "Pinned" card below with its own Copy,
  // so you grab a saved filter without re-deriving it. A short auto-label (target +
  // mode/content at pin time) makes the list readable since raw regex is cryptic.
  const PIN_KEY = "poe2.regexForge.pins";
  function loadPins(){ try { return JSON.parse(localStorage.getItem(PIN_KEY)) || []; } catch { return []; } }
  function savePins(p){ try { localStorage.setItem(PIN_KEY, JSON.stringify(p)); } catch {} }
  // A pin's label must describe the actual filter, not just the mode — otherwise
  // every floor pin reads "Waystones · rarity/pack floor" and they're indistinguishable.
  function currentLabel(){
    if (target === "tablets"){
      const names = D.contentTypes.filter(c => tContent.has(c.id)).map(c => c.label);
      const nMods = gatherDesirables().filter(m => tMods.has(m.token)).length;
      return "Tablets · " + (names.length ? names.join("/") : "any") + (nMods ? " +" + nMods + " mod" + (nMods > 1 ? "s" : "") : "");
    }
    if (wMatch === "dump") return "Waystones dump · keep ≥" + (dumpCutoffC || cutoffDefaultC()) + "c";
    const tags = [];
    if (rarityMin > 0) tags.push("Rarity ≥" + rarityMin);
    if (packMin > 0)   tags.push("Pack ≥" + packMin);
    if (effMin > 0)    tags.push("Eff ≥" + effMin);
    if (monRarMin > 0) tags.push("MonRar ≥" + monRarMin);
    if (wdropMin > 0)  tags.push("Drop ≥" + wdropMin);
    if (!tags.length)  tags.push("floor");
    if (wRevives) tags.push("juiced"); else if (wNotRevives) tags.push("not-juiced");
    if (wCorrupt) tags.push("corrupt"); else if (wNotCorrupt) tags.push("not-corrupt");
    if (wExclude) tags.push("no-risk");
    return "Waystones · " + tags.join(", ");
  }
  function pinCurrent(){
    const rx = currentRegex();
    if (!rx) return;
    const pins = loadPins();
    if (pins.some(p => p.rx === rx)) return;   // already pinned — no dupes
    pins.unshift({ rx, label: currentLabel(), ts: Date.now() });
    savePins(pins);
    renderSheet();
  }
  function unpin(rx){ savePins(loadPins().filter(p => p.rx !== rx)); renderSheet(); }
  // Rename a pin in place (pins are keyed by ts). Fixes old pins saved before the
  // auto-label change AND lets you give a pin any name you want.
  function renamePin(ts, label){
    const pins = loadPins();
    const p = pins.find(x => String(x.ts) === String(ts));
    if (p) { p.label = (label || "").trim() || p.label; savePins(pins); }
    renderSheet();
  }
  function startRename(ts){
    const span = els.sheet.querySelector(`[data-pinlabel="${ts}"]`);
    if (!span) return;
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = span.textContent; inp.className = "pin-rename-in"; inp.setAttribute("aria-label", "Pin name");
    span.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); else if (e.key === "Escape") { done = true; renderSheet(); } });
    inp.addEventListener("blur", () => { if (!done) { done = true; renamePin(ts, inp.value); } });
  }
  function pinsHtml(){
    const pins = loadPins();
    if (!pins.length) return "";
    const items = pins.map(p => `<li class="pin-item">
      <div class="pin-row">
        <span class="pin-label" data-pinlabel="${p.ts}">${esc(p.label)}</span>
        <span class="pin-actions">
          <button class="pin-rename" type="button" data-rename="${p.ts}" aria-label="Rename pin" title="Rename">✎</button>
          <button class="copy" type="button" data-copy="${esc(p.rx)}">Copy</button>
          <button class="pin-del" type="button" data-unpin="${esc(p.rx)}" aria-label="Remove pin" title="Remove pin">✕</button>
        </span>
      </div>
      <code class="pin-rx">${esc(p.rx)}</code>
    </li>`).join("");
    return `<div class="rxcard rx-pins">
      <div class="rxcard-head"><span class="rxcard-title">Pinned</span><span class="rxcard-kind">saved</span></div>
      <div class="rxcard-body"><ul class="pinlist">${items}</ul></div>
    </div>`;
  }

  // ── Controls ──
  function seg(attr, val, cur, label){ return `<button class="seg-btn${val===cur?" on":""}" type="button" data-${attr}="${val}">${esc(label)}</button>`; }
  // Each tunable: [lo, hi, click-step]. The control is a typeable number input
  // (type the value directly — no clicking to 0) flanked by −/+ for quick nudges.
  const STEP_CFG = { rarity:[0,80,10], pack:[0,50,10], eff:[0,70,10], monRar:[0,60,5], wdrop:[0,130,5], dropKeep:[0,130,5] };
  function stepCur(id){ return ({ rarity:rarityMin, pack:packMin, eff:effMin, monRar:monRarMin, wdrop:wdropMin, dropKeep })[id]; }
  function setStep(id, v){
    const c = STEP_CFG[id]; if (!c) return;
    v = clamp(Math.round(Number(v) || 0), c[0], c[1]);
    if (id==="rarity") rarityMin=v; else if (id==="pack") packMin=v; else if (id==="eff") effMin=v; else if (id==="monRar") monRarMin=v; else if (id==="wdrop") wdropMin=v;
    else if (id==="dropKeep") dropKeep=v;
  }
  function stepper(id, label){
    const [lo, hi, step] = STEP_CFG[id], val = stepCur(id);
    return `<div class="forge-step"><span class="forge-step-lbl">${esc(label)}</span>
      <span class="forge-step-ctl">
        <button class="step" type="button" data-step="${id}" data-dir="-1"${val<=lo?" disabled":""} aria-label="decrease ${esc(label)}">−</button>
        <input class="forge-step-in" type="number" data-stepin="${id}" value="${val}" min="${lo}" max="${hi}" step="${step}" inputmode="numeric" aria-label="${esc(label)}">
        <span class="forge-step-unit">%</span>
        <button class="step" type="button" data-step="${id}" data-dir="1"${val>=hi?" disabled":""} aria-label="increase ${esc(label)}">+</button>
      </span></div>`;
  }
  function toggle(id, label, on){
    return `<label class="forge-tog"><input type="checkbox" data-tog="${id}"${on?" checked":""}><span>${esc(label)}</span></label>`;
  }
  function waystoneQs(){
    const segs = `<div class="forge-seg" role="group" aria-label="Match mode">${seg("wmatch","floor",wMatch,"Stat floors")}${seg("wmatch","dump",wMatch,"Low-value dump")}</div>`;
    if (wMatch === "dump") {
      const cutoffEx = dumpCutoffEx();   // also lazy-inits dumpCutoffC
      const derived = ((MW() && MW().stats) || []).filter(s => DUMP_KEYS[s.key]).map(s => {
        const th = dumpThreshold(s, cutoffEx);
        return `${esc(s.label)} ${th == null ? "—" : "≥" + th + "%"}`;
      }).join(" · ");
      return `${segs}<div class="forge-steps">
        <div class="forge-step"><span class="forge-step-lbl">Dump if best stat worth under</span>
          <span class="forge-step-ctl">
            <button class="step" type="button" data-cut="-1"${dumpCutoffC<=1?" disabled":""} aria-label="decrease cutoff">−</button>
            <input class="forge-step-in" type="number" data-cutin value="${dumpCutoffC}" min="1" max="200" step="1" inputmode="numeric" aria-label="Dump cutoff in chaos">
            <span class="forge-step-unit">c</span>
            <button class="step" type="button" data-cut="1" aria-label="increase cutoff">+</button>
          </span></div>
        ${stepper("dropKeep","Keep if Drop Chance ≥")}
      </div><p class="forge-hint">Finds <b>corrupted, fully-juiced</b> waystones to bulk-dump. Keeps any stone with a reward stat worth <b>≥ ${dumpCutoffC}c</b> on the <b>live market curve</b>, dumps the rest. Per-stat keep %, auto-derived from the curve: <b>${derived || "—"}</b> <span class="muted">(“—” = that stat can't reach the cutoff even maxed)</span>.${dropKeep>0?` <b>Drop Chance ≥${dropKeep}%</b> kept as your <b>sustain</b> rule (priced flat; 0 = dump any drop).`:``} Hit <b>Refresh from market</b> to reprice.</p>`;
    }
    return `
      ${segs}
      <div class="forge-steps">${stepper("rarity","Min Item Rarity")}${stepper("pack","Min Pack Size")}${stepper("eff","Min Effectiveness")}${stepper("monRar","Min Monster Rarity")}${stepper("wdrop","Min Waystone Drop")}</div>
      <p class="forge-hint">Every minimum you set is <b>required</b> (AND) — a stone must clear all of them. Type a value or use −/+; set a stat to 0 to drop it.</p>
      <div class="forge-togrow">${toggle("revives","Fully juiced only (0 revives = 6-mod map)",wRevives)}${toggle("notrevives","Not juiced",wNotRevives)}</div>
      <div class="forge-togrow">${toggle("corrupt","Corrupted only",wCorrupt)}${toggle("notcorrupt","Not corrupted",wNotCorrupt)}</div>
      ${toggle("exclude","Exclude risk suffixes (less recovery, −max res, …)",wExclude)}`;
  }
  function tabletQs(){
    const chips = D.contentTypes.map(c => `<button class="chip${tContent.has(c.id)?" on":""}" type="button" data-chip="${c.id}">${esc(c.label)}</button>`).join("");
    let mods = "";
    if (tContent.size){
      const modChips = gatherDesirables().map(m => `<button class="chip${tMods.has(m.token)?" on":""}" type="button" data-mod="${esc(m.token)}">${esc(m.label)}</button>`).join("");
      mods = `<p class="forge-hint">Require specific mods — a tablet must have <b>every</b> ticked one (AND). None required by default:</p><div class="forge-chips">${modChips}</div>`;
    }
    return `
      <p class="forge-hint">Pick the content you're farming — socket the tablet in a Tower covering those maps.</p>
      <div class="forge-chips">${chips}</div>
      ${mods}`;
  }
  function forgeOutput(){
    const rx = currentRegex(), len = rx.length, over = len > D.regexLimit, empty = !rx;
    const ph = target === "tablets" ? "Pick at least one content type…" : "Set a minimum on at least one stat…";
    const pinned = !empty && loadPins().some(p => p.rx === rx);
    return `<div class="forge-out${empty?" empty":""}">
      <code class="regexbox">${empty ? ph : esc(rx)}</code>
      <div class="forge-meta">
        <span class="rx-len ${over?"over":""}">${len}/${D.regexLimit}</span>
        <span class="forge-acts">
          <button class="pin-btn${pinned?" on":""}" type="button" data-pin="1"${empty||pinned?" disabled":""}>${pinned?"Pinned ✓":"Pin"}</button>
          <button class="copy" type="button" data-copy="${esc(rx)}"${empty?" disabled":""}>Copy</button>
        </span>
      </div>
    </div>`;
  }
  // Live-update only the output box (regex + length + pin/copy state) without
  // rebuilding the controls — so a typed value doesn't yank focus out of the input.
  function paintOutput(){
    const rx = currentRegex(), len = rx.length, over = len > D.regexLimit, empty = !rx;
    const box = els.sheet.querySelector(".regexbox");
    if (box) box.textContent = empty ? (target === "tablets" ? "Pick at least one content type…" : "Set a minimum on at least one stat…") : rx;
    const lenEl = els.sheet.querySelector(".rx-len");
    if (lenEl) { lenEl.textContent = len + "/" + D.regexLimit; lenEl.classList.toggle("over", over); }
    const copy = els.sheet.querySelector(".forge-out .copy");
    if (copy) { copy.setAttribute("data-copy", rx); copy.disabled = empty; }
    const pin = els.sheet.querySelector(".pin-btn");
    if (pin) { const pinned = !empty && loadPins().some(p => p.rx === rx); pin.disabled = empty || pinned; pin.textContent = pinned ? "Pinned ✓" : "Pin"; pin.classList.toggle("on", pinned); }
  }
  function renderSheet(){
    const note = target === "tablets"
      ? `Content types OR into one block (a tablet is one mechanic); each ticked mod is <b>required</b> (its own AND block). Verify wording in your stash.`
      : `Matches the waystone "<b>Label: +X%</b>" reward block (0.5). Risk excluded: <b>${esc((D.dangerousMods||[]).join(", "))}</b>.`;
    els.sheet.innerHTML = `<div class="rxcard rx-forge">
      <div class="rxcard-head"><span class="rxcard-title">Regex Forge</span><span class="rxcard-kind">live</span></div>
      <div class="rxcard-body">
        <div class="forge-seg forge-target" role="group" aria-label="Target">${seg("target","waystones",target,"Waystones")}${seg("target","tablets",target,"Tablets")}</div>
        <div class="forge-qs">${target==="tablets" ? tabletQs() : waystoneQs()}</div>
        ${forgeOutput()}
        <div class="rxcard-note">${note}</div>
      </div>
    </div>` + pinsHtml();
    bindForge();
    bindCopy();
    bindPins();
  }
  function bindPins(){
    const pinBtn = els.sheet.querySelector("[data-pin]");
    if (pinBtn) pinBtn.addEventListener("click", pinCurrent);
    els.sheet.querySelectorAll("[data-unpin]").forEach(b => b.addEventListener("click", () => unpin(b.getAttribute("data-unpin"))));
    els.sheet.querySelectorAll("[data-rename]").forEach(b => b.addEventListener("click", () => startRename(b.getAttribute("data-rename"))));
  }
  function bindForge(){
    const root = els.sheet;
    root.querySelectorAll("[data-target]").forEach(b => b.addEventListener("click", () => { target = b.getAttribute("data-target"); renderSheet(); }));
    root.querySelectorAll("[data-wmatch]").forEach(b => b.addEventListener("click", () => { wMatch = b.getAttribute("data-wmatch"); renderSheet(); }));
    // −/+ buttons nudge by the per-control step; full re-render (focus isn't in play).
    root.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
      const id = b.getAttribute("data-step"), dir = Number(b.getAttribute("data-dir"));
      const st = (STEP_CFG[id] || [0,0,10])[2];
      setStep(id, stepCur(id) + dir * st);
      renderSheet();
    }));
    // Typeable inputs: live-update just the regex while typing (keeps focus), and do a
    // full re-render on blur/Enter to snap the value + sync the −/+ disabled states.
    root.querySelectorAll("[data-stepin]").forEach(inp => {
      inp.addEventListener("input", () => { setStep(inp.getAttribute("data-stepin"), inp.value); paintOutput(); });
      inp.addEventListener("change", () => { setStep(inp.getAttribute("data-stepin"), inp.value); renderSheet(); });
    });
    // Dump cutoff (chaos) — its own control since it's a price, not a % roll.
    root.querySelectorAll("[data-cut]").forEach(b => b.addEventListener("click", () => {
      dumpCutoffC = clamp((dumpCutoffC || cutoffDefaultC()) + Number(b.getAttribute("data-cut")), 1, 200);
      renderSheet();
    }));
    const cutin = root.querySelector("[data-cutin]");
    if (cutin){
      cutin.addEventListener("input", () => { dumpCutoffC = clamp(Math.round(Number(cutin.value) || 1), 1, 200); paintOutput(); });
      cutin.addEventListener("change", () => { dumpCutoffC = clamp(Math.round(Number(cutin.value) || 1), 1, 200); renderSheet(); });
    }
    root.querySelectorAll("[data-tog]").forEach(c => c.addEventListener("change", () => {
      const k = c.getAttribute("data-tog");
      // corrupt/juiced each have an "only" + a "not" toggle — mutually exclusive
      // (can't require AND exclude the same thing), so ticking one clears its opposite.
      if (k === "revives") { wRevives = c.checked; if (c.checked) wNotRevives = false; }
      else if (k === "notrevives") { wNotRevives = c.checked; if (c.checked) wRevives = false; }
      else if (k === "corrupt") { wCorrupt = c.checked; if (c.checked) wNotCorrupt = false; }
      else if (k === "notcorrupt") { wNotCorrupt = c.checked; if (c.checked) wCorrupt = false; }
      else if (k === "exclude") wExclude = c.checked;
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
  const copyText = window.__copyText;   // shared helper (index.html) — uniform copy feedback
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
        <div class="mw-line"><span class="mw-name">${esc(s.label)}${s.est?` <span title="estimate — not yet Trade2-swept" style="color:var(--mu);font-size:.8em">(est)</span>`:""}</span><span class="mw-val"><b>${inChaos(pk)}</b>c <span style="color:var(--mu);font-size:.85em">(${pk}ex)</span></span></div>
        <div class="mw-bar"><span style="width:${pct}%"></span></div>
        ${s.ceiling?`<div class="mw-cap">top roll seen ~${s.ceiling}%</div>`:""}
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
      const mods = g.mods.slice().sort((a, b) => ((b.priceCheck?1:0) - (a.priceCheck?1:0)) || (modWorth(b) - modWorth(a)) || a.label.localeCompare(b.label));
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
      if (d.limited) mwStatus = "Trade2 is rate-limited — showing last result. Try again shortly.";
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
  function detectContent(t){ for (const c of D.contentTypes){ if (c.id!=="general" && new RegExp(c.tabletToken,"i").test(t)) return c; } return null; }
  function curveEx(curve, pct){
    if (!curve || !curve.length || pct <= 0) return 0;
    if (pct <= curve[0][0]) return curve[0][1] * (pct / curve[0][0]);
    for (let i = 1; i < curve.length; i++){ if (pct <= curve[i][0]){ const [x0,y0] = curve[i-1], [x1,y1] = curve[i]; return y0 + (y1 - y0) * (pct - x0) / (x1 - x0); } }
    const a = curve[curve.length-2] || curve[0], b = curve[curve.length-1];
    const slope = (b[1]-a[1]) / Math.max(1, b[0]-a[0]);
    return Math.max(b[1], b[1] + slope * (pct - b[0]));
  }
  // Value scale is anchored to baselineEx (~2 chaos = the floor for ANY usable stone).
  // Tiers are multiples of that floor so they auto-rescale if the baseline moves.
  function baseEx(){ return (MW() && MW().baselineEx) || 1; }
  function chaosRate(){ return (MW() && MW().rates && MW().rates.chaosEx) || 86; }
  function inChaos(ex){ const c = ex / chaosRate(); return c >= 10 ? String(Math.round(c)) : (Math.round(c*10)/10).toString(); }
  function exChaos(ex){ return `${inChaos(ex)}c (${Math.round(ex)}ex)`; }
  function valTier(ex){ const b = baseEx(); if (ex >= b*7) return ["good","premium"]; if (ex >= b*2.5) return ["mid","good roll"]; return ["bad","floor"]; }
  function marketScore(text){
    const stats = (MW() && MW().stats) || [];
    let best = null, rows = [];
    for (const s of stats){ const re = STAT_RE[s.key]; if (!re) continue; const { found, value } = statRoll(text, re); if (!found) continue; const ex = Math.round(curveEx(s.curve, value)); const [tagCls, tagTxt] = valTier(ex); rows.push({ key: s.key, label: s.label, value, ex, tagCls, tagTxt, ceiling: s.ceiling || 0 }); if (!best || ex > best.ex) best = { label: s.label, value, ex }; }
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
    const ms = marketScore(text);
    let cls="warn", head="", lines=[], scoreHtml="";
    const rolls = {}; ms.rows.forEach(r => { rolls[r.key] = r.value; });
    const fits = contentFit(rolls);
    // Combo signal: reward stats compound in-run (more pack × rarity × monsters =
    // multiplicative loot), and a map with 2+ HIGH rolls is the rare chase that sells
    // above any single stat. Gated scan found such combos have ~0 listings (scarce),
    // so we DON'T fabricate an ex number — we surface it and flag a price-check.
    // Exclude Waystone Drop from the combo signal — it's sustain-only (worth ~baseline),
    // so a high Drop roll shouldn't make a floor stone look like a valuable multi-stat map.
    const normRolls = ms.rows.filter(r => r.ceiling && r.key !== "waystoneDrop").map(r => Math.min(1, r.value / r.ceiling));
    const decentStats = normRolls.filter(n => n >= 0.5).length;
    const highStats = normRolls.filter(n => n >= 0.7).length;
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
      const base = baseEx();
      const ex = Math.max(base, ms.headlineEx);   // every usable stone floors at ~2 chaos
      const bestTxt = ms.best ? `${ms.best.label} ${ms.best.value}% ≈ ${exChaos(ms.best.ex)}` : "no reward stats";
      if (rarity==="normal"){ cls="warn"; head="White waystone — Alch (or Transmute→Aug→Regal), chase high Rarity / Pack Size"; }
      else if (rarity==="magic"){
        if (ex >= base*2.5){ cls="good"; head=`Good blue (best: ${bestTxt}) — Regal then Exalt, push that roll higher`; }
        else if (ms.best){ cls="warn"; head=`Weak blue (best: ${bestTxt}) — Aug toward Rarity / Pack Size, or reroll`; }
        else { cls="warn"; head="Weak blue — Augment for a reward mod, or Transmute-reroll"; }
      } else if (highStats >= 2){
        cls="good"; head=`✓ Multi-stat chase — ${highStats} high rolls together. Price-check it: combos this juiced are scarce and sell well above any single stat`;
      } else {
        if (ex >= base*7){ cls="good"; head=`✓ Premium juice (best: ${bestTxt})`; }
        else if (ex >= base*2.5){ cls="good"; head=`Solid map (best: ${bestTxt}) — run or sell`; }
        else { cls="warn"; const spread = decentStats>=2?` — ${decentStats} mid stats compound a bit in-run`:""; head=`Floor stone (${exChaos(ex)})${spread} — nothing premium; bulk-sell or run cheap`; }
      }
      scoreHtml = `<div class="scoreline">Est. floor value <b>≈ ${inChaos(ex)} chaos</b><span>(${Math.round(ex)}ex · securable floor of its best stat)</span></div>`;
      for (const r of ms.rows){ lines.push(`<span class="tag ${r.tagCls}">${esc(r.tagTxt)}</span>${esc(r.label)} ${r.value?`<b>${r.value}%</b>`:""} <span style="color:var(--mu)">≈ ${exChaos(r.ex)}</span>`); }
      if (highStats >= 2) lines.push(`<span class="tag good">combo</span><b>${highStats} high rolls together</b> — reward mods compound in-run and multi-high maps are a scarce chase. <b>Price-check before dumping</b> — worth well above the ${exChaos(ex)} solo floor.`);
      if (fits.length && fits[0].fit > 0.15){ const top = fits[0], driver = top.top ? statLabel(top.top.k) : ""; let pair = `<span class="tag mid">pair</span>Best for <b>${esc(top.ct.label)}</b>${driver?` (${esc(driver)}-heavy)`:""} — socket ${esc(top.ct.label)} tablets`; if (fits[1] && fits[1].fit >= top.fit * 0.8) pair += `, or ${esc(fits[1].ct.label)}`; lines.push(pair); }
    } else { cls="warn"; head="Couldn't tell if this is a waystone or tablet — paste the full copied item text"; }
    els.evalOut.innerHTML = `<div class="verdict ${cls}"><div class="head">${esc(head)}</div>${scoreHtml}${lines.length?`<ul>${lines.map(l=>`<li>${l}</li>`).join("")}</ul>`:""}</div>`;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  els.evalBtn.addEventListener("click", evaluate);
  renderSheet();
  renderMarket();
  renderTabletValue();
  loadCachedWeights();
};

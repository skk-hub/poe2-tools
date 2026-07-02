// Crafter — Phase 1: mod-pool browser + paste-an-item preview. Pick a base + item
// level (or paste a copied item) to see every prefix/suffix it can roll, grouped by
// mod with tiers, spawn weights, and roll-chance share. Pasting an item also renders
// it as an in-game-style tooltip and auto-loads its pool. Data from /api/craft/*
// (offline, no trade). Phase 2 adds the currency-route probability/cost engine.
window.__viewInit = window.__viewInit || {};
window.__viewInit["craft"] = function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baseIn = $("cfBase"), ilvlIn = $("cfIlvl"), status = $("cfStatus"), out = $("cfOut"),
    summary = $("cfSummary"), dl = $("cfBaseList"), paste = $("cfPaste"), itemView = $("cfItemView");
  let byName = {};

  fetch("/api/craft/bases").then((r) => r.json()).then((d) => {
    const bases = d.bases || [];
    byName = Object.fromEntries(bases.map((b) => [b.name, b]));
    dl.innerHTML = bases.map((b) => `<option value="${esc(b.name)}">${esc(b.class)}</option>`).join("");
    status.textContent = `${bases.length} bases — type, pick, or paste an item.`;
  }).catch((e) => { status.textContent = "Failed to load bases: " + (e.message || e); status.className = "status err"; });

  // ── mod pool (right of the paste box) ──
  // Each tier is individually targetable (a checkbox per tier); the group summary has a
  // master "any tier" checkbox that selects/clears all tiers. targets: group -> Set(keys).
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  function tierRow(t, sideW, tierNo, group) {
    const pct = sideW ? (t.weight / sideW) * 100 : 0;
    return `<label class="cf-tier"><input type="checkbox" class="cf-tsel" data-group="${esc(group)}" data-key="${esc(t.key)}">` +
      `<span class="cf-troll"><b class="cf-tno">T${tierNo}</b> ${esc(t.stats.join("  /  "))}</span>` +
      `<span class="cf-tmeta">iL${t.ilvl}<b title="spawn weight">w${t.weight}</b><i title="roll chance vs all mods on this side">${pct.toFixed(1)}%</i></span></label>`;
  }
  function groupCard(g, sideW) {
    const tiers = g.tiers.map((t, i) => tierRow(t, sideW, i + 1, g.group)).join("");
    const n = g.tiers.length;
    return `<details class="cf-grp" data-group="${esc(g.group)}"><summary>` +
      `<input type="checkbox" class="cf-gall" title="target this mod (any tier)" data-group="${esc(g.group)}">` +
      `<span class="cf-glabel">${esc(g.label)}</span>` +
      `<span class="cf-gmeta">${n} tier${n > 1 ? "s" : ""} · w${g.totalWeight}</span></summary>${tiers}</details>`;
  }
  function column(title, groups, sideW) {
    const head = `<div class="cf-colhead">${title}<span class="cf-count">${groups.length} mods · total weight ${sideW}</span></div>`;
    if (!groups.length) return head + `<p class="muted cf-empty">No ${title.toLowerCase()} on this base.</p>`;
    return head + groups.map((g) => groupCard(g, sideW)).join("");
  }
  const scopeNote = $("cfScopeNote"), simBar = $("cfSimBar"), simOut = $("cfSimOut"), targetsEl = $("cfTargets"), simBtn = $("cfSimBtn");
  const targets = new Map();     // group -> Set(tier keys)
  const groupMeta = new Map();   // group -> { label, type, keys:[tier keys in T1..Tn order] }
  let lastBase = "", lastIlvl = 0;

  function renderPool(d) {
    status.textContent = ""; status.className = "status";
    if (scopeNote) scopeNote.hidden = false;
    // targets belong to a specific base+ilvl pool; reset when either changes
    if (d.base !== lastBase || d.ilvl !== lastIlvl) { targets.clear(); simOut.innerHTML = ""; lastBase = d.base; lastIlvl = d.ilvl; }
    groupMeta.clear();
    for (const g of d.prefixes) groupMeta.set(g.group, { label: g.label, type: "prefix", keys: g.tiers.map((t) => t.key) });
    for (const g of d.suffixes) groupMeta.set(g.group, { label: g.label, type: "suffix", keys: g.tiers.map((t) => t.key) });
    summary.innerHTML = `<b>${esc(d.base)}</b> <span class="muted">${esc(d.class)} · item level ${d.ilvl}</span>` +
      (d.implicit ? ` <span class="cf-impl" title="implicit modifier">${esc(d.implicit)}</span>` : "");
    out.innerHTML = `<div class="cf-col">${column("Prefixes", d.prefixes, d.prefixWeight)}</div>` +
      `<div class="cf-col">${column("Suffixes", d.suffixes, d.suffixWeight)}</div>`;
    out.querySelectorAll(".cf-tsel").forEach((c) => c.addEventListener("change", onTierToggle));
    out.querySelectorAll(".cf-gall").forEach((c) => c.addEventListener("change", onAllToggle));
    renderTargetBar();
  }
  // a checkbox in a <summary> would also toggle the <details> — stop the master one
  out.addEventListener("click", (e) => { if (e.target.classList && e.target.classList.contains("cf-gall")) e.stopPropagation(); });

  function onTierToggle(e) {
    const g = e.target.dataset.group, key = e.target.dataset.key;
    let set = targets.get(g); if (!set) { set = new Set(); targets.set(g, set); }
    if (e.target.checked) set.add(key); else set.delete(key);
    if (!set.size) targets.delete(g);
    syncMaster(g); renderTargetBar();
  }
  function onAllToggle(e) {
    e.stopPropagation();
    const g = e.target.dataset.group, meta = groupMeta.get(g); if (!meta) return;
    if (e.target.checked) targets.set(g, new Set(meta.keys)); else targets.delete(g);
    out.querySelectorAll(`.cf-tsel[data-group="${cssEsc(g)}"]`).forEach((c) => { c.checked = e.target.checked; });
    e.target.indeterminate = false;
    renderTargetBar();
  }
  function syncMaster(g) {
    const meta = groupMeta.get(g), set = targets.get(g);
    const master = out.querySelector(`.cf-gall[data-group="${cssEsc(g)}"]`); if (!master || !meta) return;
    const size = set ? set.size : 0, total = meta.keys.length;
    master.checked = total > 0 && size === total;
    master.indeterminate = size > 0 && size < total;
  }
  function tierDesc(g, set) {
    const meta = groupMeta.get(g); if (!meta) return "";
    if (set.size === meta.keys.length) return "any tier";
    return [...set].map((k) => meta.keys.indexOf(k) + 1).sort((a, b) => a - b).map((n) => "T" + n).join(", ");
  }
  function renderTargetBar() {
    simBar.hidden = targets.size === 0;
    targetsEl.innerHTML = [...targets.entries()].map(([g, set]) => {
      const meta = groupMeta.get(g);
      return `<span class="cf-tchip" data-group="${esc(g)}">${esc(meta ? meta.label : g)} <em>${esc(tierDesc(g, set))}</em><button type="button" aria-label="remove">×</button></span>`;
    }).join("");
    targetsEl.querySelectorAll(".cf-tchip button").forEach((b) => b.addEventListener("click", () => {
      const g = b.parentElement.getAttribute("data-group");
      targets.delete(g); simOut.innerHTML = "";
      out.querySelectorAll(`.cf-tsel[data-group="${cssEsc(g)}"]`).forEach((c) => { c.checked = false; });
      syncMaster(g); renderTargetBar();
    }));
  }
  let poolGen = 0;   // request generation — two in-flight pool loads can land out of order
  async function load() {
    const base = baseIn.value.trim();
    if (!byName[base]) {
      poolGen++;   // invalidate any in-flight pool response
      out.innerHTML = ""; summary.innerHTML = "";
      // the pool is gone — stale target chips / sim results from the previous base go too
      targets.clear(); groupMeta.clear(); simOut.innerHTML = ""; renderTargetBar();
      lastBase = ""; lastIlvl = 0;
      status.textContent = base ? "Pick a base from the list." : "Type, pick, or paste an item."; status.className = "status"; return;
    }
    const ilvl = Math.max(1, Math.min(100, parseInt(ilvlIn.value, 10) || 100));
    const gen = ++poolGen;
    status.textContent = "Resolving mod pool…"; status.className = "status";
    try {
      const r = await fetch("/api/craft/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, ilvl }) });
      const d = await r.json();
      if (gen !== poolGen) return;   // a newer request superseded this one — drop it
      if (d.error) { status.textContent = d.error; status.className = "status err"; return; }
      renderPool(d);
    } catch (e) { if (gen === poolGen) { status.textContent = "Failed: " + (e.message || e); status.className = "status err"; } }
  }
  baseIn.addEventListener("change", load);
  ilvlIn.addEventListener("change", load);

  // ── paste-an-item: parse the PoE2 clipboard format → in-game-style tooltip ──
  const TAG = /\((implicit|enchant|rune|fractured|crafted|desecrated|scourge|veiled)\)\s*$/i;
  function parseItem(text) {
    const raw = (text || "").replace(/\r/g, "").trim();
    if (!/(^|\n)(Item Class|Rarity):/i.test(raw)) return null;
    const secs = raw.split(/\n-{3,}\n/);
    const head = secs[0].split("\n").map((s) => s.trim()).filter(Boolean);
    let rarity = "normal", itemClass = "";
    const nameLines = [];
    for (const l of head) {
      if (/^Item Class:/i.test(l)) itemClass = l.replace(/^Item Class:\s*/i, "");
      else if (/^Rarity:/i.test(l)) {
        const r = l.replace(/^Rarity:\s*/i, "").toLowerCase();
        rarity = /unique/.test(r) ? "unique" : /rare/.test(r) ? "rare" : /magic/.test(r) ? "magic" : /currency/.test(r) ? "currency" : /gem/.test(r) ? "gem" : "normal";
      } else nameLines.push(l);
    }
    const it = { rarity, itemClass, name: nameLines[0] || "", base: nameLines[1] || nameLines[0] || "",
      itemLevel: "", quality: "", requirements: [], props: [], enchants: [], implicits: [], explicits: [], corrupted: false, flavour: [] };
    for (const s of secs.slice(1)) {
      const lines = s.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (lines.some((l) => TAG.test(l))) {                 // a modifier section (has a tag)
        for (const l of lines) {
          const m = l.match(TAG), tag = m ? m[1].toLowerCase() : "", txt = l.replace(TAG, "").trim();
          if (tag === "implicit") it.implicits.push(txt);
          else if (tag === "enchant" || tag === "rune") it.enchants.push(txt);
          else it.explicits.push({ text: txt, tag });
        }
        continue;
      }
      if (/^Requirements:/i.test(lines[0])) {
        for (const l of lines.slice(1)) { const mm = l.match(/^([^:]+):\s*(.+)$/); if (mm) { const k = mm[1].trim(), v = mm[2].trim(); it.requirements.push(/^level$/i.test(k) ? "Level " + v : v + " " + k); } }
        continue;
      }
      if (lines.length === 1 && /^(Corrupted|Mirrored|Split|Unmodifiable)$/i.test(lines[0])) { if (/corrupted/i.test(lines[0])) it.corrupted = true; continue; }
      if (lines.every((l) => /^[^:]{2,}:\s*.+$/.test(l))) {  // a property section (Label: value)
        for (const l of lines) {
          const mm = l.match(/^([^:]+):\s*(.+)$/), k = mm[1].trim(), v = mm[2].trim().replace(/\s*\(augmented\)\s*$/i, "");
          if (/^item level$/i.test(k)) it.itemLevel = v;
          else if (/^quality$/i.test(k)) it.quality = v;
          else if (/^(sockets|note|rune sockets)$/i.test(k)) { /* skip */ }
          else it.props.push({ k, v });
        }
        continue;
      }
      if (it.rarity === "unique" && !lines.some((l) => /\d/.test(l))) { it.flavour.push(...lines); continue; }
      for (const l of lines) it.explicits.push({ text: l, tag: "" });
    }
    return it;
  }
  const hl = (s) => esc(s).replace(/([+\-]?\d+(?:\.\d+)?)/g, "<b>$1</b>");   // brighten numbers, PoE-style
  const modLine = (t, cls) => `<div class="cf-tip-mod ${cls || ""}">${hl(t)}</div>`;
  const sec = (inner) => `<div class="cf-tip-sec">${inner}</div>`;
  function renderTip(it) {
    if (!it) return "";
    const H = [`<div class="cf-tip ${esc(it.rarity)}">`];
    H.push(`<div class="cf-tip-head"><div class="cf-tip-name">${esc(it.name || it.base || "Item")}</div>` +
      (it.base && it.base !== it.name ? `<div class="cf-tip-base">${esc(it.base)}</div>` : "") + `</div>`);
    if (it.enchants.length) H.push(sec(it.enchants.map((m) => modLine(m, "enchant")).join("")));
    const props = [];
    if (it.quality) props.push(`<div class="cf-tip-prop"><span>Quality: </span><b>${esc(it.quality)}</b></div>`);
    for (const p of it.props) props.push(`<div class="cf-tip-prop"><span>${esc(p.k)}: </span><b>${esc(p.v)}</b></div>`);
    if (it.requirements.length) props.push(`<div class="cf-tip-req">Requires ${esc(it.requirements.join(", "))}</div>`);
    if (it.itemLevel) props.push(`<div class="cf-tip-prop"><span>Item Level: </span><b>${esc(it.itemLevel)}</b></div>`);
    if (props.length) H.push(sec(props.join("")));
    if (it.implicits.length) H.push(sec(it.implicits.map((m) => modLine(m, "implicit")).join("")));
    if (it.explicits.length) H.push(sec(it.explicits.map((m) => modLine(m.text, m.tag)).join("")));
    if (it.corrupted) H.push(sec(`<div class="cf-tip-corrupt">Corrupted</div>`));
    if (it.flavour.length) H.push(sec(`<div class="cf-tip-flav">${it.flavour.map(esc).join("<br>")}</div>`));
    H.push(`</div>`);
    return H.join("");
  }
  // Find the known base the pasted item is built on (rare/normal name it directly;
  // magic names embed it, e.g. "Sapphire Ring of the Bear" → longest base substring wins).
  function detectBase(it) {
    if (byName[it.base]) return it.base;
    const hay = (it.name + " " + it.base).toLowerCase();
    let best = null;
    for (const name in byName) { if (hay.includes(name.toLowerCase()) && (!best || name.length > best.length)) best = name; }
    return best;
  }
  function onPaste() {
    const it = parseItem(paste.value);
    itemView.innerHTML = renderTip(it);
    if (!it) return;
    const base = detectBase(it);
    if (base) {
      baseIn.value = base;
      if (/^\d+$/.test(it.itemLevel)) ilvlIn.value = it.itemLevel;
      load();
    }
  }
  paste.addEventListener("input", onPaste);

  // ── simulate: best crafting route to the selected target mods ──
  const fmtN = (n) => !isFinite(n) ? "?" : n >= 100 ? Math.round(n).toLocaleString() : n >= 10 ? Math.round(n) : n >= 0.1 ? n.toFixed(1) : n.toFixed(2);
  function fmtOrbs(orbs) {
    const parts = Object.entries(orbs).filter(([, n]) => n > 0).map(([k, n]) => `<b>${fmtN(n)}</b> ${esc(k)}`);
    return parts.length ? parts.join(" + ") : "—";
  }
  const fmtDiv = (d) => !isFinite(d) ? "?" : d >= 100 ? Math.round(d).toLocaleString() : d >= 10 ? d.toFixed(1) : d.toFixed(2);
  function renderMethods(r) {
    if (r.error) { simOut.innerHTML = `<div class="cf-simerr">${esc(r.error)}</div>`; return; }
    if (r.impossible) {
      const bits = [];
      if (r.missing && r.missing.length) bits.push("this base can't roll: " + r.missing.map(esc).join(", "));
      if (r.overCap) bits.push(`too many on one side (${r.prefixTargets} prefixes, ${r.suffixTargets} suffixes — max 3 each)`);
      simOut.innerHTML = `<div class="cf-simerr">Can't craft these together — ${bits.join("; ")}.</div>`;
      return;
    }
    const feasible = r.methods.filter((m) => m.feasible);
    if (!feasible.length) { simOut.innerHTML = `<div class="cf-simerr">No method reached all targets in ${r.trials.toLocaleString()} simulations — the combo is extremely rare. Try fewer/looser targets.</div>`; return; }
    const priced = !!r.priced;
    const rows = r.methods.map((m, i) => {
      const chance = (m.successPerAttempt * 100);
      const chanceStr = chance >= 10 ? chance.toFixed(0) + "%" : chance >= 1 ? chance.toFixed(1) + "%" : chance > 0 ? chance.toFixed(2) + "%" : "—";
      const cls = "cf-method" + (i === 0 && m.feasible ? " best" : "") + (m.feasible ? "" : " dim");
      // headline cost = Divine (when priced), orbs shown as the breakdown underneath
      const cost = !m.feasible ? `not reached in ${r.trials.toLocaleString()} sims`
        : priced && m.divineCost != null ? `<b>${fmtDiv(m.divineCost)}</b> div${m.priceMissing ? " +" : ""}`
        : fmtOrbs(m.expectedOrbs);
      const chanceBit = m.key === "chaos_spam" ? `lands ${chanceStr}/attempt within ${m.cap} Chaos` : `lands ${chanceStr}/attempt`;
      const sub = m.feasible && priced && m.divineCost != null
        ? `${fmtOrbs(m.expectedOrbs)} · ${chanceBit}` + (m.priceMissing ? ` · +unpriced: ${m.priceMissing.map(esc).join(", ")}` : "")
        : `each attempt ${chanceBit}`;
      return `<div class="${cls}"><div class="cf-method-top"><span class="cf-method-name">${i === 0 && m.feasible ? "★ " : ""}${esc(m.label)}</span>` +
        `<span class="cf-method-cost">${cost}</span></div><div class="cf-method-sub">${sub}</div></div>`;
    }).join("");
    const head = priced
      ? `Expected cost to hit all ${r.prefixTargets + r.suffixTargets} mods — ranked by Divine (poe.ninja), avg over ${r.trials.toLocaleString()} sims`
      : `Expected currency to hit all ${r.prefixTargets + r.suffixTargets} mods (avg over ${r.trials.toLocaleString()} sims · prices unavailable — ranked by orb count)`;
    simOut.innerHTML = `<div class="cf-simresult"><div class="cf-simresult-head">${head}</div>${rows}</div>`;
  }
  async function simulate() {
    const base = baseIn.value.trim();
    if (!byName[base] || !targets.size) return;
    const ilvl = Math.max(1, Math.min(100, parseInt(ilvlIn.value, 10) || 100));
    simBtn.disabled = true; simOut.innerHTML = `<div class="cf-simload">Simulating…</div>`;
    // send {group, keys} — omit keys when all tiers selected (= any tier)
    const payload = [...targets.entries()].map(([g, set]) => {
      const meta = groupMeta.get(g);
      return meta && set.size === meta.keys.length ? { group: g } : { group: g, keys: [...set] };
    });
    try {
      const r = await fetch("/api/craft/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, ilvl, targets: payload }) });
      renderMethods(await r.json());
    } catch (e) { simOut.innerHTML = `<div class="cf-simerr">Failed: ${esc(e.message || e)}</div>`; }
    finally { simBtn.disabled = false; }
  }
  simBtn.addEventListener("click", simulate);

  // ── desecrated modifier reference (Abyssal Bones + Well of Souls) ──
  const desecEl = $("cfDesec"), desecOut = $("cfDesecOut"), desecSearch = $("cfDesecSearch");
  const FACTION_LABEL = { lightless: "Lightless", amanamu: "Amanamu", kurgal: "Kurgal", ulaman: "Ulaman", abyss: "Abyss" };
  let desecMods = null;
  function renderDesec(q) {
    if (!desecMods) return;
    q = (q || "").trim().toLowerCase();
    const hit = desecMods.filter((m) => !q || m.stats.join(" ").toLowerCase().includes(q) || m.faction.includes(q) || m.tags.join(" ").includes(q));
    if (!hit.length) { desecOut.innerHTML = `<p class="muted cf-empty">No desecrated mods match "${esc(q)}".</p>`; return; }
    const byF = {};
    for (const m of hit) (byF[m.faction] = byF[m.faction] || []).push(m);
    desecOut.innerHTML = Object.entries(byF).map(([f, ms]) =>
      `<div class="cf-dfac"><div class="cf-dfac-head">${esc(FACTION_LABEL[f] || f)} <span class="cf-count">${ms.length}</span></div>` +
      ms.map((m) => `<div class="cf-dmod"><span class="cf-dtype cf-${m.type}">${m.type === "prefix" ? "P" : "S"}</span>` +
        `<span class="cf-dstats">${m.stats.map(esc).join("<br>")}</span>` +
        `<span class="cf-dmeta">iL${m.ilvl}</span></div>`).join("") + `</div>`).join("");
  }
  function loadDesec() {
    if (desecMods) return;
    desecOut.innerHTML = `<p class="muted">Loading…</p>`;
    fetch("/api/craft/desecrated").then((r) => r.json()).then((d) => {
      if (d.error) { desecOut.innerHTML = `<p class="muted">${esc(d.error)}</p>`; return; }
      desecMods = d.mods || [];
      renderDesec(desecSearch.value);
    }).catch((e) => { desecOut.innerHTML = `<p class="muted">Failed: ${esc(e.message || e)}</p>`; });
  }
  desecEl.addEventListener("toggle", () => { if (desecEl.open) loadDesec(); });
  desecSearch.addEventListener("input", () => renderDesec(desecSearch.value));
};

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
  function tierRow(t, sideW) {
    const pct = sideW ? (t.weight / sideW) * 100 : 0;
    return `<div class="cf-tier"><span class="cf-troll">${esc(t.stats.join("  /  "))}</span>` +
      `<span class="cf-tmeta">iL${t.ilvl}<b title="spawn weight">w${t.weight}</b><i title="roll chance vs all mods on this side">${pct.toFixed(1)}%</i></span></div>`;
  }
  function groupCard(g, sideW) {
    const tiers = g.tiers.map((t) => tierRow(t, sideW)).join("");
    const n = g.tiers.length;
    return `<details class="cf-grp"><summary><span class="cf-glabel">${esc(g.label)}</span>` +
      `<span class="cf-gmeta">${n} tier${n > 1 ? "s" : ""} · w${g.totalWeight}</span></summary>${tiers}</details>`;
  }
  function column(title, groups, sideW) {
    const head = `<div class="cf-colhead">${title}<span class="cf-count">${groups.length} mods · total weight ${sideW}</span></div>`;
    if (!groups.length) return head + `<p class="muted cf-empty">No ${title.toLowerCase()} on this base.</p>`;
    return head + groups.map((g) => groupCard(g, sideW)).join("");
  }
  function renderPool(d) {
    status.textContent = ""; status.className = "status";
    summary.innerHTML = `<b>${esc(d.base)}</b> <span class="muted">${esc(d.class)} · item level ${d.ilvl}</span>` +
      (d.implicit ? ` <span class="cf-impl" title="implicit modifier">${esc(d.implicit)}</span>` : "");
    out.innerHTML = `<div class="cf-col">${column("Prefixes", d.prefixes, d.prefixWeight)}</div>` +
      `<div class="cf-col">${column("Suffixes", d.suffixes, d.suffixWeight)}</div>`;
  }
  async function load() {
    const base = baseIn.value.trim();
    if (!byName[base]) { out.innerHTML = ""; summary.innerHTML = ""; status.textContent = base ? "Pick a base from the list." : "Type, pick, or paste an item."; status.className = "status"; return; }
    const ilvl = Math.max(1, Math.min(100, parseInt(ilvlIn.value, 10) || 100));
    status.textContent = "Resolving mod pool…"; status.className = "status";
    try {
      const r = await fetch("/api/craft/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, ilvl }) });
      const d = await r.json();
      if (d.error) { status.textContent = d.error; status.className = "status err"; return; }
      renderPool(d);
    } catch (e) { status.textContent = "Failed: " + (e.message || e); status.className = "status err"; }
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
};

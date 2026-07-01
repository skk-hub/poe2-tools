// Crafter — Phase 1: mod-pool browser. Pick a base + item level, see every prefix/
// suffix it can roll, grouped by mod (mutually-exclusive group) with tiers, spawn
// weights, and each tier's roll-chance share. Data from /api/craft/* (offline, no
// trade). Phase 2 will add the currency-route probability/cost engine on top.
window.__viewInit = window.__viewInit || {};
window.__viewInit["craft"] = function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baseIn = $("cfBase"), ilvlIn = $("cfIlvl"), status = $("cfStatus"), out = $("cfOut"), summary = $("cfSummary"), dl = $("cfBaseList");
  let byName = {};

  fetch("/api/craft/bases").then((r) => r.json()).then((d) => {
    const bases = d.bases || [];
    byName = Object.fromEntries(bases.map((b) => [b.name, b]));
    dl.innerHTML = bases.map((b) => `<option value="${esc(b.name)}">${esc(b.class)}</option>`).join("");
    status.textContent = `${bases.length} bases — type or pick one.`;
  }).catch((e) => { status.textContent = "Failed to load bases: " + (e.message || e); status.className = "status err"; });

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
  function render(d) {
    status.textContent = ""; status.className = "status";
    summary.innerHTML = `<b>${esc(d.base)}</b> <span class="muted">${esc(d.class)} · item level ${d.ilvl}</span>` +
      (d.implicit ? ` <span class="cf-impl" title="implicit modifier">${esc(d.implicit)}</span>` : "");
    out.innerHTML = `<div class="cf-col">${column("Prefixes", d.prefixes, d.prefixWeight)}</div>` +
      `<div class="cf-col">${column("Suffixes", d.suffixes, d.suffixWeight)}</div>`;
  }
  async function load() {
    const base = baseIn.value.trim();
    if (!byName[base]) { out.innerHTML = ""; summary.innerHTML = ""; status.textContent = base ? "Pick a base from the list." : "Type or pick a base."; status.className = "status"; return; }
    const ilvl = Math.max(1, Math.min(100, parseInt(ilvlIn.value, 10) || 100));
    status.textContent = "Resolving mod pool…"; status.className = "status";
    try {
      const r = await fetch("/api/craft/pool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, ilvl }) });
      const d = await r.json();
      if (d.error) { status.textContent = d.error; status.className = "status err"; return; }
      render(d);
    } catch (e) { status.textContent = "Failed: " + (e.message || e); status.className = "status err"; }
  }
  baseIn.addEventListener("change", load);
  ilvlIn.addEventListener("change", load);
};

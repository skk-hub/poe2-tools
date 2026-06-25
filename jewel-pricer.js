window.__viewInit = window.__viewInit || {};
window.__viewInit["jewel-pricer"] = function () {
  const D = window.JEWEL_DATA;
  const els = {
    input: document.getElementById("jpInput"),
    evalBtn: document.getElementById("jpEval"),
    out: document.getElementById("jpOut"),
    patch: document.getElementById("jpPatch"),
  };
  if (els.patch) els.patch.textContent = D.patch + " · " + D.league;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TIER_RANK = { S: 3, A: 2, B: 1 };

  // Parse one item block: highest % per known mod (mirrors map-juicer statRoll).
  function parseJewel(block) {
    const isJewel = /Item Class:\s*Jewels/i.test(block);
    const rarityM = block.match(/Rarity:\s*([A-Za-z]+)/i);
    const rarity = rarityM ? rarityM[1].toLowerCase() : "";
    const lines = block.split(/\n/);
    const mods = [];
    for (const def of D.mods) {
      let found = false, value = 0;
      for (const line of lines) {
        if (!def.re.test(line)) continue;
        found = true;
        const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) value = Math.max(value, parseFloat(m[1]));
      }
      if (found) mods.push({ def, value });
    }
    return { isJewel, rarity, mods };
  }

  // Combo-driven verdict: tiers drive it, not a per-mod sum.
  function verdict(parsed) {
    const mods = parsed.mods;
    const sCount = mods.filter((m) => m.def.tier === "S").length;
    const aCount = mods.filter((m) => m.def.tier === "A").length;
    const bCount = mods.filter((m) => m.def.tier === "B").length;
    const hasCrit = mods.some((m) => m.def.key === "critDamage");
    const high = sCount + aCount;
    let band, cls, head;
    if (high >= 2) { band = "chase"; cls = "good"; head = `✓ Chase combo — ${high} strong mods together${hasCrit ? " incl. Crit Damage" : ""}. Price-check it.`; }
    else if (sCount >= 1) { band = "strong"; cls = "good"; head = `✓ Strong — has Crit Damage. Price-check it.`; }
    else if (aCount >= 1 || bCount >= 2) { band = "decent"; cls = "warn"; head = `~ Decent — one good mod or two minor ones. Worth a price-check.`; }
    else { band = "junk"; cls = "bad"; head = `✗ Junk — no chase mods. Vendor / disenchant.`; }
    // headline floor band = best matched mod's est solo floor (honest: combos beat it).
    const headlineEx = mods.reduce((mx, m) => Math.max(mx, m.def.soloEx || 0), 0);
    return { band, cls, head, headlineEx, sCount, aCount, bCount, hasCrit };
  }

  // Top mods to AND in the live query: highest tier, then highest roll, with a statId.
  function topQueryMods(parsed) {
    return parsed.mods
      .filter((m) => m.def.statId)
      .sort((a, b) => (TIER_RANK[b.def.tier] - TIER_RANK[a.def.tier]) || (b.value - a.value))
      .slice(0, 3)
      .map((m) => ({ statId: m.def.statId, min: Math.floor(m.value) || 1, label: m.def.label }));
  }

  let lastJewels = [];
  function tagCls(tier) { return tier === "S" ? "s" : tier === "A" ? "a" : tier === "B" ? "b" : "junk"; }

  function evaluate() {
    const text = els.input.value || "";
    if (!text.trim()) { els.out.innerHTML = ""; lastJewels = []; return; }
    // Split into item copies on the "Item Class:" boundary (one item -> one block).
    const raw = text.split(/(?=Item Class:)/i).map((b) => b.trim()).filter(Boolean);
    const blocks = raw.length ? raw : [text];
    lastJewels = [];
    const cards = [];
    blocks.forEach((block) => {
      const parsed = parseJewel(block);
      if (!parsed.isJewel) {
        cards.push(`<div class="verdict warn"><div class="head">Not a jewel — paste a copied <b>Jewel</b> (its text starts with "Item Class: Jewels").</div></div>`);
        return;
      }
      if (parsed.rarity && parsed.rarity !== "rare") {
        cards.push(`<div class="verdict warn"><div class="head">${esc(parsed.rarity[0].toUpperCase() + parsed.rarity.slice(1))} jewel — this tool prices <b>rare</b> jewels. Uniques price by name (later pass).</div></div>`);
        return;
      }
      const v = verdict(parsed);
      const idx = lastJewels.length;
      lastJewels.push({ parsed, v });
      const modLines = parsed.mods
        .sort((a, b) => (TIER_RANK[b.def.tier] - TIER_RANK[a.def.tier]) || (b.value - a.value))
        .map((m) => `<span class="tag ${tagCls(m.def.tier)}">${m.def.tier}</span>${esc(m.def.label)}${m.value ? ` <b>${m.value}%</b>` : ""}`);
      const scoreHtml = `<div class="scoreline">Est. floor <b>≈ ${Math.round(v.headlineEx)} ex</b><span>(best single mod — combos sell higher; price-check for the real number)</span></div>`;
      const pc = v.band === "junk" ? "" :
        `<div class="jp-pc"><button type="button" data-jp-check="${idx}">Price check</button><span class="jp-pcout" id="jpPc${idx}"></span></div>`;
      cards.push(`<div class="verdict ${v.cls}"><div class="head">${esc(v.head)}</div>${scoreHtml}<ul>${modLines.map((l) => `<li>${l}</li>`).join("")}${parsed.mods.length === 0 ? "<li>No recognised mods — likely junk or a mod the tool doesn't track yet.</li>" : ""}</ul>${pc}</div>`);
    });
    els.out.innerHTML = cards.join("");
  }

  async function priceCheck(idx, btn) {
    const entry = lastJewels[idx];
    const outEl = document.getElementById("jpPc" + idx);
    if (!entry || !outEl) return;
    const mods = topQueryMods(entry.parsed);
    if (!mods.length) { outEl.textContent = "No priceable mods (none have a verified trade id)."; return; }
    btn.disabled = true; outEl.textContent = "Pricing… (one Trade2 search)";
    try {
      const r = await fetch("/api/jewel/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league: D.league, mods: mods.map((m) => ({ statId: m.statId, min: m.min })) }),
      });
      const d = await r.json();
      const used = mods.map((m) => `${m.label} ≥${m.min}`).join(" + ");
      if (d.limited) { outEl.innerHTML = `Trade2 is rate-limited — try again shortly.`; btn.disabled = false; return; }
      if (!d.found || !(d.ex > 0)) { outEl.innerHTML = `No comparable listings for <b>${esc(used)}</b>.`; btn.disabled = false; return; }
      const thin = d.thin ? " thin" : "";
      const note = d.thin ? ` (thin book — only ${d.depth || "a few"} sellers, treat as rough)` : ` (${d.depth} sellers)`;
      outEl.className = "jp-pcout" + thin;
      outEl.innerHTML = `Floor <b>≈ ${d.ex} ex</b> for <b>${esc(used)}</b>${esc(note)}`;
    } catch (e) {
      outEl.textContent = "Price check failed — is the server running?";
      btn.disabled = false;
    }
  }

  els.evalBtn.addEventListener("click", evaluate);
  els.out.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-jp-check]");
    if (btn) priceCheck(Number(btn.getAttribute("data-jp-check")), btn);
  });
};

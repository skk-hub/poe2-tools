// Filter Helper view: lists exchange items worth >= a threshold (liquid, via the
// poe.ninja volume gate + our Trade2 prices) and emits a top-priority Show block to
// paste at the top of a loot filter so they're never hidden. The scan is a gentle
// ~2-min background job server-side, so the page kicks it then polls until it lands.
// Optional: paste your filter and it prunes the list to the items your filter
// actually HIDES (so you don't get a block full of stuff you already see). The
// filter never leaves the browser — parsing + pruning is all client-side.
window.__viewInit["filter-helper"] = function () {
  const $ = (id) => document.getElementById(id);
  const league = $("fhLeague"), minEx = $("fhMinEx"), minVol = $("fhMinVol");
  const genBtn = $("fhGen"), statusEl = $("fhStatus"), rows = $("fhRows"), wrap = $("fhTableWrap");
  const sub = $("fhSub"), blockArea = $("fhBlock"), copyBtn = $("fhCopy"), blockWrap = $("fhBlockWrap");
  const filterArea = $("fhFilter");
  let pollTimer = null, lastData = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtEx = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 100) / 100) + " ex";
  const normBase = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = "status" + (cls ? " " + cls : ""); }
  function clearTimers() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  // Parse a PoE2 loot filter into the BaseTypes and Classes it SHOWS vs HIDES,
  // considering only ENDGAME blocks (a block with `AreaLevel <= N` and no
  // `AreaLevel >=` is leveling-only and ignored — e.g. Regal Orb is shown while
  // leveling but hidden in maps). The server decides "hidden" = a candidate the
  // filter doesn't show (Show wins the cascade), so we also flag `catchAllHide`: a
  // Hide block with no BaseType/Class conditions = "hide everything not shown
  // above", which is how almost every real filter actually hides things.
  function parseFilter(text) {
    const out = { shownBases: [], shownClasses: [], hiddenBases: [], hiddenClasses: [], catchAllHide: false };
    const quoted = (s) => (s.match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1));
    const lines = String(text).split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].trim(); i++;
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(Show|Hide)\b/i);
      if (!m) continue;
      const mode = m[1].toLowerCase();
      const blockLines = [t];
      while (i < lines.length) {
        const btt = lines[i].trim();
        if (!btt) { i++; break; }                  // blank line ends the block
        if (/^(Show|Hide)\b/i.test(btt)) break;     // next block — don't consume
        if (!btt.startsWith("#")) blockLines.push(btt);
        i++;
      }
      let hasMax = false, hasMin = false; const bases = [], classes = [];
      for (const bl of blockLines) {
        if (/AreaLevel\s*<=?\s*\d/i.test(bl)) hasMax = true;
        if (/AreaLevel\s*>=/i.test(bl)) hasMin = true;
        const bm = bl.match(/^BaseType\b\s*(==)?\s*(.+)$/i);
        if (bm) for (const x of quoted(bm[2])) bases.push(normBase(x));
        const cm = bl.match(/^Class\b\s*(==)?\s*(.+)$/i);
        if (cm) for (const x of quoted(cm[2])) classes.push(x);
      }
      if (hasMax && !hasMin) continue;              // leveling-only block — ignore
      if (mode === "show") { out.shownBases.push(...bases); out.shownClasses.push(...classes); }
      else {
        out.hiddenBases.push(...bases); out.hiddenClasses.push(...classes);
        if (!bases.length && !classes.length) out.catchAllHide = true;  // hide-everything-else
      }
    }
    return out;
  }

  function render(d) {
    lastData = d;
    const items = (d && d.items) || [];        // server already scoped to the filter's hidden set
    const floor = (d && d.minEx) || minEx.value || 1;
    rows.innerHTML = items.map((it) =>
      "<tr><td>" + esc(it.name) + "</td><td class=\"num\">" + esc(fmtEx(it.ex)) + "</td><td class=\"num muted\">" + esc(it.volume) + "</td></tr>"
    ).join("");
    wrap.hidden = !items.length;
    blockWrap.hidden = !(d && d.showBlock);
    if (d && d.showBlock) blockArea.value = d.showBlock;
    const bits = [];
    if (d.filtered) {
      bits.push(items.length + " item" + (items.length === 1 ? "" : "s") + " your filter hides ≥ " + floor + " ex" + (d.liquidTotal ? " (of " + d.liquidTotal + " liquid)" : ""));
      if (!items.length && !d.building) bits.push("your filter already shows everything valuable — nothing to unhide 👍");
    } else if (typeof d.count === "number") {
      bits.push(d.count + " item" + (d.count === 1 ? "" : "s") + " ≥ " + floor + " ex");
      if (d.candidates) bits.push(d.candidates + " liquid candidates scanned");
    }
    if (d.partial) bits.push("partial — rate limit hit, click Generate to finish");
    if (d.updated) bits.push("priced " + new Date(d.updated).toLocaleString());
    sub.textContent = bits.join(" · ");
  }

  // Build the request: opens/edits send refresh=false (serve the cached price book,
  // ZERO Trade2 calls); only Generate sends refresh=true to run the gentle live scan.
  // A pasted filter is POSTed as parsed Show/Hide sets so the server can scope to what
  // it hides — that scoping is in-memory over the cached book, still zero calls.
  function buildReq(force) {
    const ft = filterArea ? filterArea.value.trim() : "";
    const lg = league.value.trim() || "Runes of Aldur", ex = Number(minEx.value) || 1, vol = Number(minVol.value) || 10;
    if (ft) {
      return ["/api/filter-helper", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league: lg, minEx: ex, minVol: vol, filter: parseFilter(ft), refresh: !!force }) }];
    }
    return ["/api/filter-helper?league=" + encodeURIComponent(lg) + "&minEx=" + ex + "&minVol=" + vol + (force ? "&refresh=1" : ""), { method: "GET" }];
  }

  async function load(force) {
    clearTimers();
    try {
      const [u, opts] = buildReq(force);
      const r = await fetch(u, opts);
      const d = await r.json();
      render(d);
      if (d.building) {
        setStatus("Pricing live off the exchange (gentle, ~1 call/10s — won't trip the limit). Results fill in as it goes…", "");
        genBtn.disabled = true; genBtn.classList.add("loading");
        pollTimer = setTimeout(() => load(false), 4000);
      } else {
        genBtn.disabled = false; genBtn.classList.remove("loading");
        if (force && d.limited) setStatus("Trade2 is rate-limited right now — showing cached prices. Click Generate again in a few min to refresh.", "err");
        else setStatus(d.count ? "Done — paste the Show block at the TOP of your filter." : "No priced items ≥ threshold yet. Click Generate to price live, or lower the threshold.", d.count ? "ok" : "");
      }
    } catch {
      genBtn.disabled = false; genBtn.classList.remove("loading");
      setStatus("Couldn't reach the server.", "err");
    }
  }

  genBtn.addEventListener("click", () => { setStatus("Starting scan…", ""); load(true); });
  // Filter pasted/edited → re-scan (debounced). With a filter the scan is scoped to
  // just what it hides, so it's tiny and safe to re-run.
  let filterDebounce = null;
  if (filterArea) filterArea.addEventListener("input", () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => { setStatus("Applying your filter…", ""); load(false); }, 1500);
  });
  copyBtn.addEventListener("click", async () => {
    if (!blockArea.value) return;
    try { await navigator.clipboard.writeText(blockArea.value); copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy Show block"), 1500); }
    catch { blockArea.select(); document.execCommand("copy"); }
  });

  load(false); // show whatever's cached on open
};

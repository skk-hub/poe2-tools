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
  let pollTimer = null, limitTimer = null, lastData = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtEx = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 100) / 100) + " ex";
  const fmtDur = (s) => { s = Math.max(0, Math.ceil(s)); const m = Math.floor(s / 60); return m ? m + "m " + (s % 60) + "s" : s + "s"; };
  const normBase = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = "status" + (cls ? " " + cls : ""); }
  function clearTimers() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (limitTimer) { clearInterval(limitTimer); limitTimer = null; } }

  function startLimitCountdown(untilMs) {
    clearTimers();
    genBtn.disabled = true;
    const tick = async () => {
      const s = (untilMs - Date.now()) / 1000;
      if (s > 0) { setStatus("Trade2 rate-limited — try in " + fmtDur(s) + ".", "err"); return; }
      clearInterval(limitTimer); limitTimer = null;
      try {
        const st = await (await fetch("/api/trade-status")).json();
        if (st.limited) {
          const u = st.tradeLimitedUntil ? new Date(st.tradeLimitedUntil).getTime() : Date.now() + (st.secondsRemaining || 0) * 1000;
          return startLimitCountdown(u);
        }
      } catch {}
      genBtn.disabled = false; setStatus("Rate limit cleared — click Generate.", "");
    };
    tick(); limitTimer = setInterval(tick, 1000);
  }

  // Parse a PoE2 loot filter into the set of base types it SHOWS and the set it
  // HIDES, considering only ENDGAME blocks (a block with `AreaLevel <= N` and no
  // `AreaLevel >=` is leveling-only and ignored — e.g. Regal Orb is shown while
  // leveling but hidden in maps). An item counts as hidden if it's in a Hide list
  // and NOT in any (endgame) Show list — Show wins the first-match cascade. Exact
  // base-name match; the restex catch-all / partial matches are a known minor gap.
  function parseFilter(text) {
    const shown = new Set(), hidden = new Set();
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
        const bt = lines[i];
        const btt = bt.trim();
        if (!btt) { i++; break; }                  // blank line ends the block
        if (/^(Show|Hide)\b/i.test(btt)) break;     // next block — don't consume
        if (!btt.startsWith("#")) blockLines.push(btt);
        i++;
      }
      let hasMax = false, hasMin = false; const bases = [];
      for (const bl of blockLines) {
        if (/AreaLevel\s*<=?\s*\d/i.test(bl)) hasMax = true;
        if (/AreaLevel\s*>=/i.test(bl)) hasMin = true;
        const bm = bl.match(/BaseType\b\s*(==)?\s*(.+)$/i);
        if (bm) { const q = bm[2].match(/"([^"]+)"/g) || []; for (const x of q) bases.push(normBase(x.slice(1, -1))); }
      }
      if (hasMax && !hasMin) continue;              // leveling-only block — ignore
      const set = mode === "show" ? shown : hidden;
      for (const b of bases) set.add(b);
    }
    return { shown, hidden };
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
    if (d.partial) bits.push("partial — rate limit hit, click Refresh to finish");
    if (d.updated) bits.push("updated " + new Date(d.updated).toLocaleString());
    sub.textContent = bits.join(" · ");
  }

  // Build the request: with a filter pasted we POST the hidden base set so the server
  // only prices what the filter hides (tiny scan, can't trip the rate limit); without
  // one we GET the full liquid scan.
  function buildReq(force) {
    const ft = filterArea ? filterArea.value.trim() : "";
    const lg = league.value.trim() || "Runes of Aldur", ex = Number(minEx.value) || 1, vol = Number(minVol.value) || 10;
    if (ft) {
      const { shown, hidden } = parseFilter(ft);
      const hiddenList = [...hidden].filter((h) => !shown.has(h));
      return ["/api/filter-helper", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league: lg, minEx: ex, minVol: vol, hidden: hiddenList, refresh: !!force }) }];
    }
    return ["/api/filter-helper?league=" + encodeURIComponent(lg) + "&minEx=" + ex + "&minVol=" + vol + (force ? "&refresh=1" : ""), { method: "GET" }];
  }

  async function load(force) {
    clearTimers();
    try {
      const [u, opts] = buildReq(force);
      const r = await fetch(u, opts);
      const d = await r.json();
      if (d.limited) {
        const until = d.tradeLimitedUntil ? new Date(d.tradeLimitedUntil).getTime() : (Date.now() + (d.secondsRemaining || 0) * 1000);
        startLimitCountdown(until); render(d); return;
      }
      render(d);
      if (d.building) {
        setStatus("Scanning the exchange for your prices… (~2 min, gentle so it can't trip the rate limit)", "");
        genBtn.disabled = true; genBtn.classList.add("loading");
        pollTimer = setTimeout(() => load(false), 8000);
      } else {
        genBtn.disabled = false; genBtn.classList.remove("loading");
        setStatus(d.count ? "Done — paste the Show block at the TOP of your filter." : "No items ≥ threshold yet. Lower it or click Generate.", d.count ? "ok" : "");
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

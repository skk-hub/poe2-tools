// Filter Helper view: lists exchange items worth >= a threshold (liquid, via the
// poe.ninja volume gate + our Trade2 prices) and emits a top-priority Show block to
// paste at the top of a loot filter so they're never hidden. The scan is a gentle
// ~2-min background job server-side, so the page kicks it then polls until it lands.
window.__viewInit["filter-helper"] = function () {
  const $ = (id) => document.getElementById(id);
  const league = $("fhLeague"), minEx = $("fhMinEx"), minVol = $("fhMinVol");
  const genBtn = $("fhGen"), statusEl = $("fhStatus"), rows = $("fhRows"), wrap = $("fhTableWrap");
  const sub = $("fhSub"), blockArea = $("fhBlock"), copyBtn = $("fhCopy"), blockWrap = $("fhBlockWrap");
  let pollTimer = null, limitTimer = null;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtEx = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 100) / 100) + " ex";
  const fmtDur = (s) => { s = Math.max(0, Math.ceil(s)); const m = Math.floor(s / 60); return m ? m + "m " + (s % 60) + "s" : s + "s"; };

  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = "status" + (cls ? " " + cls : ""); }
  function clearTimers() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (limitTimer) { clearInterval(limitTimer); limitTimer = null; } }

  // Tick down the API's unlock timestamp; when it elapses, re-confirm against
  // /api/trade-status (that endpoint reads cached state — NO trade2 call, so it
  // can't collide with the shared queue or other tools). Don't auto-scan; just
  // re-enable Generate, or re-sync the countdown if a fresh limit is reported.
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

  function qs() {
    return "?league=" + encodeURIComponent(league.value.trim() || "Runes of Aldur") +
      "&minEx=" + encodeURIComponent(minEx.value || "1") +
      "&minVol=" + encodeURIComponent(minVol.value || "10");
  }

  function render(d) {
    const items = (d && d.items) || [];
    rows.innerHTML = items.map((it) =>
      "<tr><td>" + esc(it.name) + "</td><td class=\"num\">" + esc(fmtEx(it.ex)) + "</td><td class=\"num muted\">" + esc(it.volume) + "</td></tr>"
    ).join("");
    wrap.hidden = !items.length;
    blockWrap.hidden = !(d && d.showBlock);
    if (d && d.showBlock) blockArea.value = d.showBlock;
    const bits = [];
    if (typeof d.count === "number") bits.push(d.count + " item" + (d.count === 1 ? "" : "s") + " ≥ " + (d.minEx || minEx.value) + " ex");
    if (d.candidates) bits.push(d.candidates + " liquid candidates scanned");
    if (d.partial) bits.push("partial — rate limit hit, click Refresh to finish");
    if (d.updated) bits.push("updated " + new Date(d.updated).toLocaleString());
    sub.textContent = bits.join(" · ");
  }

  async function load(force) {
    clearTimers();
    try {
      const r = await fetch("/api/filter-helper" + qs() + (force ? "&refresh=1" : ""));
      const d = await r.json();
      if (d.limited) {
        const until = d.tradeLimitedUntil ? new Date(d.tradeLimitedUntil).getTime() : (Date.now() + (d.secondsRemaining || 0) * 1000);
        startLimitCountdown(until);
        render(d); return;
      }
      render(d);
      if (d.building) {
        setStatus("Scanning the exchange for your prices… (~2 min, gentle so it can't trip the rate limit)", "");
        genBtn.disabled = true; genBtn.classList.add("loading");
        pollTimer = setTimeout(() => load(false), 8000);
      } else {
        genBtn.disabled = false; genBtn.classList.remove("loading");
        setStatus((d.count ? "Done — paste the Show block at the TOP of your filter." : "No items ≥ threshold yet. Lower it or click Generate."), d.count ? "ok" : "");
      }
    } catch {
      genBtn.disabled = false; genBtn.classList.remove("loading");
      setStatus("Couldn't reach the server.", "err");
    }
  }

  genBtn.addEventListener("click", () => { setStatus("Starting scan…", ""); load(true); });
  copyBtn.addEventListener("click", async () => {
    if (!blockArea.value) return;
    try { await navigator.clipboard.writeText(blockArea.value); copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy Show block"), 1500); }
    catch { blockArea.select(); document.execCommand("copy"); }
  });

  load(false); // show whatever's cached on open
};

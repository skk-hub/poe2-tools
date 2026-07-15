/* Home — currency value strip under the hero. Reads the cached overview on open
   (instant, no network wait); the ↻ button forces a live Trade2 refresh.
   Inlined view, lazy-init on first open (registers in __viewInit). */
window.__viewInit = window.__viewInit || {};
window.__viewInit["home"] = function () {
  const strip = document.getElementById("fxStrip");
  const chips = document.getElementById("fxStripChips");
  const meta = document.getElementById("fxStripMeta");
  const btn = document.getElementById("fxStripRefresh");
  if (!strip || !chips) return;
  const LEAGUE = "Runes of Aldur";

  // Compact, never more than 2 decimals: big values round to a whole number,
  // mid values get 1 dp, small values 2 dp.
  function fmtEx(v) {
    if (!isFinite(v) || v <= 0) return "—";
    if (v >= 100) return Math.round(v).toLocaleString();
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "";
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    return Math.round(m / 60) + "h ago";
  }
  function shortName(name) { return name.replace(/^Orb of /, "").replace(/ Orb$/, ""); }

  // True once real chips have been painted — so a later fetch THROW (static host,
  // no server) hides the strip, but a throw after we already have data leaves the
  // last-good chips up rather than wiping them.
  let rendered = false;

  // Visible "something's loading" state — the strip used to stay hidden until data
  // arrived, so the home page showed nothing on a cold cache / slow fetch. Render a
  // few shimmer placeholders (respects prefers-reduced-motion via CSS).
  function showSkeleton() {
    chips.innerHTML = Array.from({ length: 6 }, () =>
      '<span class="fxchip skel"><span class="fxbar"></span></span>').join("");
    if (meta) { meta.textContent = "Loading…"; meta.classList.remove("stale"); }
    strip.hidden = false;
  }

  function render(d) {
    if (!d || !d.items || !d.items.length) {
      // The server RESPONDED but has no rates yet (cold cache that hit the Trade2
      // limit, or a transient error). Keep the strip VISIBLE with a status + the
      // ↻ button so the user can retry — hiding it entirely looked broken and
      // removed the only way to re-fetch. (A true fetch failure — e.g. the page
      // opened as a static file with no server — is caught in load() and hides it.)
      chips.innerHTML = '<span class="fxchip"><span class="fxname">No currency rates yet</span></span>';
      if (meta) {
        meta.textContent = (d && d.limited) ? "Trade2 is rate-limited — click ↻ to retry" : "Rates unavailable — click ↻ to retry";
        meta.classList.add("stale");
      }
      strip.hidden = false;
      return;
    }
    // Chaos is now the base unit; Divine stays the high-value anchor. Item .ex
    // values are exalted-denominated, so divide by chaosEx to read in chaos.
    const divineItem = d.items.find((i) => i.id === "divine");
    const divineEx = divineItem && divineItem.ex > 0 ? divineItem.ex : 0;
    const chaosItem = d.items.find((i) => i.id === "chaos");
    const chaosEx = chaosItem && chaosItem.ex > 0 ? chaosItem.ex : 0;
    const toC = (ex) => chaosEx ? ex / chaosEx : ex;     // ponytail: falls back to ex if chaos rate missing
    const unit = chaosEx ? "c" : "ex";
    chips.innerHTML = d.items.map((c) => {
      const base = c.id === "chaos";
      const val = base
        ? '1 <small>' + unit + ' (base)</small>'
        : divineEx && c.ex > divineEx
          ? fmtEx(c.ex / divineEx) + ' <small>div</small>'
          : fmtEx(toC(c.ex)) + ' <small>' + unit + '</small>';
      const icon = c.icon ? '<img class="fxicon" src="' + esc(c.icon) + '" alt="" loading="lazy" decoding="async">' : '';
      return '<span class="fxchip' + (c.id === "divine" ? " gold" : "") + '">' + icon +
        '<span class="fxname">' + esc(shortName(c.name)) + '</span>' +
        '<span class="fxval">' + val + '</span></span>';
    }).join("");
    meta.textContent = (d.stale ? "rate-limited · " : "") + (d.cached ? "cached" : "live") +
      (d.updated ? " · " + ago(d.updated) : "");
    meta.classList.toggle("stale", !!d.stale);
    strip.hidden = false;
    rendered = true;
  }

  async function load(force) {
    // Reveal a loading skeleton on the first fetch (none yet rendered) so the home
    // page shows activity instead of an empty gap; a forced ↻ refresh keeps the
    // existing chips and just spins the button.
    if (!rendered) showSkeleton();
    if (btn) { btn.classList.add("spin"); btn.disabled = true; }
    try {
      const r = await fetch("/api/currency/overview?league=" + encodeURIComponent(LEAGUE) + (force ? "&refresh=1" : ""));
      render(await r.json());
    } catch {
      // True fetch failure (static host / no server): hide unless we already have
      // real data up — the skeleton's placeholder chips don't count as data.
      if (!rendered) strip.hidden = true;
    } finally {
      if (btn) { btn.classList.remove("spin"); btn.disabled = false; }
    }
  }

  if (btn) btn.addEventListener("click", () => load(true));
  load(false);

  // ── Trade2 availability pill — the one global go/no-go to check before opening
  //    a call-heavy tool (e.g. Gear Finder / Rune Picker). /api/trade-status
  //    is local-only (no GGG call), so polling it is free. ─────────────────────
  const ts = document.getElementById("tradeStatus");
  if (ts) {
    const tsText = ts.querySelector(".tstatus-text");
    let tsTimer = null;
    const fmtSecs = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), r = s % 60; return m ? m + "m" + (r ? " " + r + "s" : "") : s + "s"; };
    function paintTrade(d) {
      if (tsTimer) { clearInterval(tsTimer); tsTimer = null; }
      if (!d) { ts.className = "tstatus"; if (tsText) tsText.textContent = "Trade2 status unavailable"; return; }
      if (!d.limited) { ts.className = "tstatus ok"; if (tsText) tsText.textContent = "Trade2 ready"; return; }
      ts.className = "tstatus limited";
      const untilMs = d.tradeLimitedUntil ? new Date(d.tradeLimitedUntil).getTime()
        : (d.secondsRemaining ? Date.now() + d.secondsRemaining * 1000 : 0);
      const tick = () => {
        const secs = untilMs ? (untilMs - Date.now()) / 1000 : 0;
        if (untilMs && secs <= 0) { loadTrade(); return; }   // just cleared — recheck
        if (tsText) tsText.textContent = untilMs ? "Trade2 is rate-limited — clears in " + fmtSecs(secs) : "Trade2 is rate-limited";
      };
      tick();
      if (untilMs) tsTimer = setInterval(tick, 1000);
    }
    let tsLoading = false;   // countdown hitting 0 ticks every second — don't stack requests
    async function loadTrade() {
      if (tsLoading) return;
      tsLoading = true;
      try { const r = await fetch("/api/trade-status"); paintTrade(await r.json()); }
      catch { paintTrade(null); }
      finally { tsLoading = false; }
    }
    loadTrade();
    setInterval(loadTrade, 30000);   // state can flip while sitting on home; cheap local poll
  }

  // ── Economy dashboard (replaces the tool cards) ───────────────────────────
  const econ = document.getElementById("econ");
  const econHeadline = document.getElementById("econHeadline");
  const econSub = document.getElementById("econSub");
  const econRefresh = document.getElementById("econRefresh");
  const econChartWrap = document.getElementById("econChartWrap");
  const econChart = document.getElementById("econChart");
  const econLegend = document.getElementById("econLegend");
  const econCards = document.getElementById("econCards");
  const econEmpty = document.getElementById("econEmpty");
  const econMain = document.getElementById("econMain");
  const econCmp = document.getElementById("econCmp");
  const econChartTitle = document.getElementById("econChartTitle");
  if (!econ) return;
  // Divine = gold, then distinct hues in ECONOMY_ITEMS order.
  const COLORS = ["#e8b23a", "#5aa9e6", "#7ed957", "#e06c9f", "#b98cff", "#46d0c0", "#f2784b"];
  let econRendered = false;
  let econLimited = false;        // rate-limited right now → keep ↻ disabled
  let econLimitTimer = null;      // 1s ticker for the "clears in …" countdown
  let econSelId = null;           // clicked card → isolate that series, grey the rest
  let econMainId = null, econCmpId = null;   // pair mode: plot cmp priced in main over time
  let econView = null;            // last-painted {series, points, latest, ...} for re-paint on select

  // Every point is priced in exalted; chaos is the exception — it's the base unit the
  // cards read AGAINST, so it's not in the per-point ex map. Its value in exalted lives
  // in p.chaosEx, recorded on every historical point, so we can plot chaos's own trend
  // (in exalted) straight from the existing history. valOf routes chaos to chaosEx.
  const valOf = (p, id) => id === "chaos" ? (p && p.chaosEx) : (p && p.ex && p.ex[id]);

  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60), r = s % 60;
    return m + "m" + (r ? " " + r + "s" : "");
  }
  function clearLimitCountdown() { if (econLimitTimer) { clearInterval(econLimitTimer); econLimitTimer = null; } }

  function esc(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m])); }
  function fmtDiv(v) {
    if (!isFinite(v) || v <= 0) return "—";
    if (v >= 100) return Math.round(v).toLocaleString();
    if (v >= 10) return v.toFixed(1);
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return v.toFixed(4);
  }
  function shortName(name) {
    return name.replace(/^Orb of /, "").replace(/ Orb$/, "").replace(/ of Kalandra$/, "");
  }
  // Percent change vs start. Small moves read clearest as a signed %; anything past
  // ~10x reads as a runaway number ("+166567%"), so collapse big growth to a "×N"
  // multiplier — same value, legible. (An early/seed baseline can make a thin-market
  // currency look astronomically up; this keeps the label honest but readable.)
  function fmtChg(pct) {
    if (pct >= 1000) { const m = pct / 100 + 1; return "×" + (m >= 10 ? Math.round(m) : m.toFixed(1)); }
    return (pct > 0 ? "+" : "") + pct + "%";
  }

  // Series present in the data (skip currencies that had no offer that sample).
  function buildSeries(points, items) {
    return items.map((it, idx) => {
      const pts = [];
      points.forEach((p, i) => { const v = valOf(p, it.id); if (v > 0) pts.push({ i, v }); });
      return { it, idx, pts };
    }).filter(s => s.pts.length);
  }

  // Pair mode: exchange rate cmp/main over time (both are in exalted, so units
  // cancel → "how many main is one cmp worth"). Only points where both traded.
  function buildRatio(points, mainId, cmpId) {
    const pts = [];
    points.forEach((p, i) => { const m = valOf(p, mainId), c = valOf(p, cmpId); if (m > 0 && c > 0) pts.push({ i, v: c / m }); });
    return pts;
  }
  const nameOf = id => { const it = ((econView && econView.items) || []).find(x => x.id === id); return it ? shortName(it.name) : id; };
  // Fill both selects once per item set; keep the current selection.
  function fillPairSelects(items) {
    const sig = items.map(i => i.id).join(",");
    if (econMain.dataset.sig !== sig) {
      const rest = items.map(it => '<option value="' + esc(it.id) + '">' + esc(shortName(it.name)) + '</option>').join("");
      econMain.innerHTML = '<option value="">Base…</option>' + rest;
      econCmp.innerHTML = '<option value="">pick…</option>' + rest;
      econMain.dataset.sig = econCmp.dataset.sig = sig;
    }
    econMain.value = econMainId || ""; econCmp.value = econCmpId || "";
  }

  // A date tick: "Jun 24", plus the hour when the whole window is under ~2 days
  // (so a fresh, dense history still tells you "today 14:00" not just "Jun 26").
  function fmtTick(iso, withTime) {
    const dt = new Date(iso);
    const lbl = dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (!withTime) return lbl;
    return lbl + " " + String(dt.getHours()).padStart(2, "0") + ":00";
  }

  // Multi-line chart, each series indexed to 100 at its first sample → slopes show
  // what's inflating relative to what. `sel` (a currency id) isolates one line and
  // greys the rest. Default preserveAspectRatio keeps it undistorted; CSS scales width.
  function lineChart(series, points, sel) {
    const n = points.length;
    const W = 820, H = 258, pad = 10, axisH = 16, innerW = W - pad * 2, innerH = H - pad * 2 - axisH;
    let minY = 100, maxY = 100;
    series.forEach(s => {
      const base = s.pts[0].v;
      s.norm = s.pts.map(p => ({ i: p.i, y: p.v / base * 100 }));
      s.norm.forEach(q => { minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); });
    });
    // Log Y axis: relative value is multiplicative, so one fast-mover (a thin-market
    // currency up 1000%+) would flatten every other line to the baseline on a linear
    // scale. In log space a 1.8x and a 17x both render as readable slopes. (norm y is
    // always > 0: price and base are both positive.)
    const lo = Math.log(Math.max(minY, 1e-6)), hi = Math.log(Math.max(maxY, minY * 1.0001));
    const lpad = (hi - lo) * 0.12 || 0.1, logMin = lo - lpad, logMax = hi + lpad;
    const X = i => n <= 1 ? pad + innerW / 2 : pad + (i / (n - 1)) * innerW;
    const Y = y => pad + (1 - (Math.log(y) - logMin) / (logMax - logMin)) * innerH;
    const base100 = Y(100).toFixed(1);
    const grid = '<line x1="' + pad + '" y1="' + base100 + '" x2="' + (W - pad) + '" y2="' + base100 + '" stroke="var(--bd)" stroke-dasharray="3 5"/>';
    // Date axis: up to ~5 ticks at real point indices, with a faint vertical guide.
    const spanMs = new Date(points[n - 1].t) - new Date(points[0].t);
    const withTime = spanMs > 0 && spanMs < 2 * 864e5;
    const axisY = H - pad, step = Math.max(1, Math.ceil((n - 1) / 4));
    let axis = "";
    for (let i = 0; i < n; i += step) {
      const x = X(i), last = i + step >= n;
      const anchor = i === 0 ? "start" : last ? "end" : "middle";
      axis += '<line x1="' + x.toFixed(1) + '" y1="' + pad + '" x2="' + x.toFixed(1) + '" y2="' + (pad + innerH).toFixed(1) + '" stroke="var(--bd)" stroke-opacity="0.35"/>' +
        '<text class="econ-tick" x="' + x.toFixed(1) + '" y="' + axisY + '" text-anchor="' + anchor + '">' + esc(fmtTick(points[i].t, withTime)) + '</text>';
    }
    const body = series.map(s => {
      const c = COLORS[s.idx % COLORS.length];
      const muted = sel && s.it.id !== sel;
      const op = muted ? 0.12 : 1, w = sel && s.it.id === sel ? 2.6 : 2;
      const d = s.norm.map((q, k) => (k ? "L" : "M") + X(q.i).toFixed(1) + " " + Y(q.y).toFixed(1)).join(" ");
      const dots = muted ? "" : s.norm.map(q => '<circle cx="' + X(q.i).toFixed(1) + '" cy="' + Y(q.y).toFixed(1) + '" r="2.6" fill="' + c + '"/>').join("");
      return '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + w + '" stroke-opacity="' + op + '" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
    }).join("");
    return '<svg class="econ-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Relative currency values over time">' + grid + axis + body + "</svg>";
  }

  function legend(series, sel) {
    return series.map(s => {
      const chg = Math.round(s.norm[s.norm.length - 1].y - 100);
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      const dim = sel && s.it.id !== sel ? " dim" : "";
      return '<span class="econ-leg' + dim + '"><i style="background:' + COLORS[s.idx % COLORS.length] + '"></i>' +
        esc(shortName(s.it.name)) + ' <b class="' + cls + '">' + fmtChg(chg) + "</b></span>";
    }).join("");
  }

  function sparkline(points, id, color) {
    const vals = points.map(p => valOf(p, id)).filter(x => x > 0);
    if (vals.length < 2) return "";
    const w = 76, h = 22, min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
    const d = vals.map((v, i) => (i ? "L" : "M") + (i / (vals.length - 1) * w).toFixed(1) + " " + ((1 - (v - min) / rng) * (h - 3) + 1.5).toFixed(1)).join(" ");
    return '<svg class="econ-spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function cards(latest, exPerDiv, chaosEx, items, points, sel) {
    const toC = (ex) => chaosEx ? ex / chaosEx : ex;     // ponytail: falls back to ex if chaos rate missing
    const unit = chaosEx ? "c" : "ex";
    return items.map((it, idx) => {
      const v = valOf(latest, it.id);
      if (!(v > 0)) return "";
      const isDiv = it.id === "divine";
      const isChaos = it.id === "chaos";
      const divVal = exPerDiv ? v / exPerDiv : 0;
      // Worth less than a Divine reads better in chaos (e.g. Greater Exalted,
      // not "0.07 div"). Lead with the natural unit; show the other as the sub.
      // Chaos is the base unit, so it can't price itself in chaos (would be a flat
      // "1 c") — it leads in exalted instead.
      const underDiv = !isDiv && !isChaos && divVal > 0 && divVal < 1;
      const main = isChaos ? fmtEx(v) + ' <small>ex</small>'
        : (isDiv || underDiv) ? fmtEx(toC(v)) + ' <small>' + unit + '</small>' : fmtDiv(divVal) + ' <small>div</small>';
      const subEx = (isDiv || isChaos) ? ""
        : underDiv ? '<span class="econ-card-ex">' + fmtDiv(divVal) + " div</span>"
        : '<span class="econ-card-ex">' + fmtEx(toC(v)) + " " + unit + "</span>";
      const hist = points.map(p => valOf(p, it.id)).filter(x => x > 0);
      const chg = hist.length > 1 ? Math.round((v / hist[0] - 1) * 100) : null;
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      const chgHtml = chg === null ? "" : '<span class="econ-card-chg ' + cls + '">' + fmtChg(chg) + ' <small>vs start</small></span>';
      const state = sel === it.id ? " sel" : sel ? " dim" : "";
      return '<div class="econ-card' + state + '" data-id="' + esc(it.id) + '" role="button" tabindex="0" aria-pressed="' + (sel === it.id) + '"><div class="econ-card-top"><i style="background:' + COLORS[idx % COLORS.length] + '"></i>' +
        '<span class="econ-card-name">' + esc(shortName(it.name)) + '</span></div>' +
        '<div class="econ-card-val">' + main + "</div>" + subEx +
        '<div class="econ-card-foot">' + chgHtml + sparkline(points, it.id, COLORS[idx % COLORS.length]) + "</div></div>";
    }).join("");
  }

  // When Trade2 is rate-limited, hold the ↻ button disabled and tick down the time
  // until it clears; auto-refresh the moment it does. (Sampling while limited just
  // returns stale data, so there's nothing to gain from letting it be tapped.)
  // When Trade2 is rate-limited, hold the ↻ button disabled and (in the empty
  // state) tick down the time until it clears, auto-refreshing the moment it does.
  // showCountdown=false just manages the disable + auto-reattempt without writing
  // over the message when samples are already on screen.
  function applyLimit(d, showCountdown) {
    clearLimitCountdown();
    const untilMs = d && d.tradeLimitedUntil ? new Date(d.tradeLimitedUntil).getTime()
      : (d && d.secondsRemaining ? Date.now() + d.secondsRemaining * 1000 : 0);
    econLimited = true;
    if (econRefresh) econRefresh.disabled = true;
    const tick = () => {
      const secs = untilMs ? (untilMs - Date.now()) / 1000 : 0;
      if (untilMs && secs <= 0) {
        clearLimitCountdown();
        econLimited = false;
        if (econRefresh) econRefresh.disabled = false;
        loadEconomy(false);                       // it just cleared — refresh now
        return;
      }
      if (showCountdown) econEmpty.textContent = untilMs
        ? "Trade2 is rate-limited — ↻ available in " + fmtDur(secs) + "."
        : "Trade2 is rate-limited — ↻ re-enables once it clears.";
    };
    tick();
    if (untilMs) econLimitTimer = setInterval(tick, 1000);
  }

  function renderEconomy(d) {
    econ.hidden = false;
    const limited = !!(d && d.limited);
    if (!limited) { clearLimitCountdown(); econLimited = false; if (econRefresh) econRefresh.disabled = false; }
    const points = (d && d.points) || [];
    let items = (d && d.items) || [];
    // Headline + cards show CURRENT (live, shared with the currency strip); the
    // history points only drive the trend graph + "% vs start".
    const cur = d && d.current && d.current.ex && Object.keys(d.current.ex).length ? d.current : null;
    const latest = cur || (points.length ? points[points.length - 1] : null);
    // Chaos as a plotted series/card (from chaosEx history) — see valOf. Appended so
    // it takes the next color and doesn't reshuffle the others'.
    if ((latest && latest.chaosEx > 0) || points.some(p => p.chaosEx > 0)) {
      items = items.concat([{ id: "chaos", name: "Chaos Orb" }]);
    }
    if (!latest) {
      econChartWrap.hidden = true; econCards.innerHTML = ""; econHeadline.innerHTML = "";
      econEmpty.hidden = false;
      if (limited) applyLimit(d, true);
      else econEmpty.textContent = "No economy data yet — click ↻ to fetch (~1 min).";
      return;
    }
    if (limited) applyLimit(d, false);
    const exPerDiv = latest.exPerDiv || 0;
    const chaosEx = latest.chaosEx || 0;     // exalted-per-chaos; chaos is the base unit now
    const unit = chaosEx ? "c" : "ex";
    econHeadline.innerHTML = exPerDiv ? '<b>' + fmtEx(chaosEx ? exPerDiv / chaosEx : exPerDiv) + '</b> <span>' + unit + ' / Divine</span>' : "";
    const hasChart = points.length >= 2;
    const series = hasChart ? buildSeries(points, items) : null;
    // Drop a stale selection if that currency isn't in the current data.
    if (econSelId && !items.some(it => it.id === econSelId)) econSelId = null;
    if (econMainId && !items.some(it => it.id === econMainId)) econMainId = null;
    if (econCmpId && !items.some(it => it.id === econCmpId)) econCmpId = null;
    econView = { series, points, latest, exPerDiv, chaosEx, items, hasChart };
    paintEcon();
    if (!hasChart) {
      econChartWrap.hidden = true; econEmpty.hidden = false;
      econEmpty.textContent = "Live values below — the relative-value trend graph fills in as history accumulates (sampled twice a day).";
    } else { econChartWrap.hidden = false; econEmpty.hidden = true; }
    econSub.textContent = "Live · priced in Divine" + (points.length ? " · " + points.length + "-pt trend" : "") +
      (cur ? "" : (d.updated ? " · " + ago(d.updated) : ""));
    econRendered = true;
  }

  // Repaint chart + legend + cards from econView, applying the current selection.
  // Cheap (string rebuild, no refetch) so a card click is instant.
  function paintEcon() {
    if (!econView) return;
    const v = econView;
    fillPairSelects(v.items);
    const pairOn = econMainId && econCmpId && econMainId !== econCmpId;
    if (v.hasChart && pairOn) {
      const pts = buildRatio(v.points, econMainId, econCmpId);
      if (pts.length >= 2) {
        const series = [{ it: { id: econCmpId, name: nameOf(econCmpId) }, idx: 0, pts }];
        econChart.innerHTML = lineChart(series, v.points, null);
        econLegend.innerHTML = legend(series, null);       // needs s.norm from lineChart — call after
        const rate = valOf(v.latest, econCmpId) / valOf(v.latest, econMainId);
        econChartTitle.innerHTML = '1 ' + esc(nameOf(econCmpId)) + ' <small>= ' + fmtDiv(rate) + ' ' + esc(nameOf(econMainId)) + ' now · trend indexed to 100</small>';
      } else {
        econChart.innerHTML = ""; econLegend.innerHTML = "";
        econChartTitle.innerHTML = 'Not enough shared history <small>these two haven’t both traded on 2+ samples yet</small>';
      }
    } else if (v.hasChart) {
      econChart.innerHTML = lineChart(v.series, v.points, econSelId);
      econLegend.innerHTML = legend(v.series, econSelId);   // legend needs s.norm from lineChart — call after
      econChartTitle.innerHTML = 'Relative value <small>each currency vs. where it started</small>';
    }
    econCards.innerHTML = cards(v.latest, v.exPerDiv, v.chaosEx, v.items, v.points, econSelId);
  }

  async function loadEconomy(force) {
    if (econRefresh) { econRefresh.classList.add("spin"); econRefresh.disabled = true; }
    if (force && !econRendered) { econEmpty.hidden = false; econEmpty.textContent = "Sampling the market… (~1 min)"; econ.hidden = false; }
    try {
      const r = await fetch("/api/economy/history?league=" + encodeURIComponent(LEAGUE) + (force ? "&refresh=1" : ""));
      renderEconomy(await r.json());
    } catch {
      if (!econRendered) econ.hidden = true;
    } finally {
      if (econRefresh) { econRefresh.classList.remove("spin"); econRefresh.disabled = econLimited; }
    }
  }
  if (econRefresh) econRefresh.addEventListener("click", () => loadEconomy(true));
  // Click a card to isolate its line (grey the rest); click it again to show all.
  function toggleSel(card) {
    const id = card && card.dataset.id; if (!id) return;
    econSelId = econSelId === id ? null : id;
    paintEcon();
  }
  econMain.addEventListener("change", () => { econMainId = econMain.value || null; paintEcon(); });
  econCmp.addEventListener("change", () => { econCmpId = econCmp.value || null; paintEcon(); });
  econCards.addEventListener("click", e => toggleSel(e.target.closest(".econ-card")));
  econCards.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".econ-card"); if (!card) return;
    e.preventDefault(); toggleSel(card);
  });
  loadEconomy(false);
};

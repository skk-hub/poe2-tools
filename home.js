/* Home — currency value strip under the hero. Reads the cached overview on open
   (instant, no network wait); the ↻ button forces a live Trade2 refresh.
   Inlined view, lazy-init on first open (registers in __viewInit). */
window.__viewInit = window.__viewInit || {};
window.__viewInit["home"] = function () {
  const strip = document.getElementById("fxStrip");
  const chips = document.getElementById("fxStripChips");
  const meta = document.getElementById("fxStripMeta");
  const btn = document.getElementById("fxStripRefresh");
  const heroStat = document.getElementById("homePriceStatus");
  const heroLabel = document.getElementById("homePriceLabel");
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
        meta.textContent = (d && d.limited) ? "Trade2 rate-limited — tap ↻ to retry" : "Rates unavailable — tap ↻ to retry";
        meta.classList.add("stale");
      }
      strip.hidden = false;
      return;
    }
    // Anything worth more than a single Divine reads better in divine.
    const divineItem = d.items.find((i) => i.id === "divine");
    const divineEx = divineItem && divineItem.ex > 0 ? divineItem.ex : 0;
    // Surface the live Divine price in the hero stat (was a static "Ready").
    if (heroStat && divineEx) {
      heroStat.textContent = fmtEx(divineEx) + " ex";
      if (heroLabel) heroLabel.textContent = "per Divine" + (d.stale ? " · stale" : "");
    }
    chips.innerHTML = d.items.map((c) => {
      const base = c.id === "exalted";
      const val = base
        ? '1 <small>ex (base)</small>'
        : divineEx && c.ex > divineEx
          ? fmtEx(c.ex / divineEx) + ' <small>div</small>'
          : fmtEx(c.ex) + ' <small>ex</small>';
      const icon = c.icon ? '<img class="fxicon" src="' + c.icon + '" alt="" loading="lazy" decoding="async">' : '';
      return '<span class="fxchip' + (c.id === "divine" ? " gold" : "") + '">' + icon +
        '<span class="fxname">' + shortName(c.name) + '</span>' +
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
  if (!econ) return;
  // Divine = gold, then distinct hues in ECONOMY_ITEMS order.
  const COLORS = ["#e8b23a", "#5aa9e6", "#7ed957", "#e06c9f", "#b98cff", "#46d0c0", "#f2784b"];
  let econRendered = false;
  let econLimited = false;        // rate-limited right now → keep ↻ disabled
  let econLimitTimer = null;      // 1s ticker for the "clears in …" countdown

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

  // Series present in the data (skip currencies that had no offer that sample).
  function buildSeries(points, items) {
    return items.map((it, idx) => {
      const pts = [];
      points.forEach((p, i) => { const v = p.ex && p.ex[it.id]; if (v > 0) pts.push({ i, v }); });
      return { it, idx, pts };
    }).filter(s => s.pts.length);
  }

  // Multi-line chart, each series indexed to 100 at its first sample → slopes show
  // what's inflating relative to what. Default preserveAspectRatio keeps it
  // undistorted; CSS scales width.
  function lineChart(series, n) {
    const W = 820, H = 240, pad = 10, innerW = W - pad * 2, innerH = H - pad * 2;
    let minY = 100, maxY = 100;
    series.forEach(s => {
      const base = s.pts[0].v;
      s.norm = s.pts.map(p => ({ i: p.i, y: p.v / base * 100 }));
      s.norm.forEach(q => { minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); });
    });
    const span = Math.max(8, maxY - minY);
    minY -= span * 0.12; maxY += span * 0.12;
    const X = i => n <= 1 ? pad + innerW / 2 : pad + (i / (n - 1)) * innerW;
    const Y = y => pad + (1 - (y - minY) / (maxY - minY)) * innerH;
    const base100 = Y(100).toFixed(1);
    const grid = '<line x1="' + pad + '" y1="' + base100 + '" x2="' + (W - pad) + '" y2="' + base100 + '" stroke="var(--bd)" stroke-dasharray="3 5"/>';
    const body = series.map(s => {
      const c = COLORS[s.idx % COLORS.length];
      const d = s.norm.map((q, k) => (k ? "L" : "M") + X(q.i).toFixed(1) + " " + Y(q.y).toFixed(1)).join(" ");
      const dots = s.norm.map(q => '<circle cx="' + X(q.i).toFixed(1) + '" cy="' + Y(q.y).toFixed(1) + '" r="2.6" fill="' + c + '"/>').join("");
      return '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
    }).join("");
    return '<svg class="econ-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Relative currency values over time">' + grid + body + "</svg>";
  }

  function legend(series) {
    return series.map(s => {
      const chg = Math.round(s.norm[s.norm.length - 1].y - 100);
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      return '<span class="econ-leg"><i style="background:' + COLORS[s.idx % COLORS.length] + '"></i>' +
        esc(shortName(s.it.name)) + ' <b class="' + cls + '">' + (chg > 0 ? "+" : "") + chg + "%</b></span>";
    }).join("");
  }

  function sparkline(points, id, color) {
    const vals = points.map(p => p.ex && p.ex[id]).filter(x => x > 0);
    if (vals.length < 2) return "";
    const w = 76, h = 22, min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
    const d = vals.map((v, i) => (i ? "L" : "M") + (i / (vals.length - 1) * w).toFixed(1) + " " + ((1 - (v - min) / rng) * (h - 3) + 1.5).toFixed(1)).join(" ");
    return '<svg class="econ-spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function cards(latest, exPerDiv, items, points) {
    return items.map((it, idx) => {
      const v = latest.ex && latest.ex[it.id];
      if (!(v > 0)) return "";
      const isDiv = it.id === "divine";
      const divVal = exPerDiv ? v / exPerDiv : 0;
      // Worth less than a Divine reads better in ex (e.g. Greater Exalted ~12ex,
      // not "0.07 div"). Lead with the natural unit; show the other as the sub.
      const underDiv = !isDiv && divVal > 0 && divVal < 1;
      const main = (isDiv || underDiv) ? fmtEx(v) + ' <small>ex</small>' : fmtDiv(divVal) + ' <small>div</small>';
      const subEx = isDiv ? ""
        : underDiv ? '<span class="econ-card-ex">' + fmtDiv(divVal) + " div</span>"
        : '<span class="econ-card-ex">' + fmtEx(v) + " ex</span>";
      const hist = points.map(p => p.ex && p.ex[it.id]).filter(x => x > 0);
      const chg = hist.length > 1 ? Math.round((v / hist[0] - 1) * 100) : null;
      const cls = chg > 0 ? "up" : chg < 0 ? "down" : "";
      const chgHtml = chg === null ? "" : '<span class="econ-card-chg ' + cls + '">' + (chg > 0 ? "+" : "") + chg + '% <small>vs start</small></span>';
      return '<div class="econ-card"><div class="econ-card-top"><i style="background:' + COLORS[idx % COLORS.length] + '"></i>' +
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
        ? "Trade2 rate-limited — ↻ available in " + fmtDur(secs) + "."
        : "Trade2 rate-limited — ↻ re-enables once it clears.";
    };
    tick();
    if (untilMs) econLimitTimer = setInterval(tick, 1000);
  }

  function renderEconomy(d) {
    econ.hidden = false;
    const limited = !!(d && d.limited);
    if (!limited) { clearLimitCountdown(); econLimited = false; if (econRefresh) econRefresh.disabled = false; }
    const points = (d && d.points) || [], items = (d && d.items) || [];
    // Headline + cards show CURRENT (live, shared with the currency strip); the
    // history points only drive the trend graph + "% vs start".
    const cur = d && d.current && d.current.ex && Object.keys(d.current.ex).length ? d.current : null;
    const latest = cur || (points.length ? points[points.length - 1] : null);
    if (!latest) {
      econChartWrap.hidden = true; econCards.innerHTML = ""; econHeadline.innerHTML = "";
      econEmpty.hidden = false;
      if (limited) applyLimit(d, true);
      else econEmpty.textContent = "No economy data yet — tap ↻ to fetch (~1 min).";
      return;
    }
    if (limited) applyLimit(d, false);
    const exPerDiv = latest.exPerDiv || 0;
    econHeadline.innerHTML = exPerDiv ? '<b>' + fmtEx(exPerDiv) + '</b> <span>ex / Divine</span>' : "";
    if (points.length >= 2) {
      const series = buildSeries(points, items);
      econChart.innerHTML = lineChart(series, points.length);
      econLegend.innerHTML = legend(series);
      econChartWrap.hidden = false; econEmpty.hidden = true;
    } else {
      econChartWrap.hidden = true; econEmpty.hidden = false;
      econEmpty.textContent = "Live values below — the relative-value trend graph fills in as history accumulates (sampled twice a day).";
    }
    econCards.innerHTML = cards(latest, exPerDiv, items, points);
    econSub.textContent = "Live · priced in Divine" + (points.length ? " · " + points.length + "-pt trend" : "") +
      (cur ? "" : (d.updated ? " · " + ago(d.updated) : ""));
    econRendered = true;
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
  loadEconomy(false);
};

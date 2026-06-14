/* Home — currency value strip under the hero. Reads the cached overview on open
   (instant, no network wait); the ↻ button forces a poe.ninja refresh.
   Inlined view, lazy-init on first open (registers in __viewInit). */
window.__viewInit = window.__viewInit || {};
window.__viewInit["home"] = function () {
  const strip = document.getElementById("fxStrip");
  const chips = document.getElementById("fxStripChips");
  const meta = document.getElementById("fxStripMeta");
  const btn = document.getElementById("fxStripRefresh");
  if (!strip || !chips) return;
  const LEAGUE = "Runes of Aldur";

  function fmtEx(v) {
    if (!isFinite(v) || v <= 0) return "—";
    if (v >= 100) return Math.round(v).toLocaleString();
    if (v >= 10) return v.toFixed(1);
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(3);
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

  function render(d) {
    if (!d || !d.items || !d.items.length) { strip.hidden = true; return; }
    chips.innerHTML = d.items.map((c) => {
      const base = c.id === "exalted";
      const val = base ? '1 <small>ex (base)</small>' : fmtEx(c.ex) + ' <small>ex</small>';
      return '<span class="fxchip' + (c.id === "divine" ? " gold" : "") + '">' +
        '<span class="fxname">' + shortName(c.name) + '</span>' +
        '<span class="fxval">' + val + '</span></span>';
    }).join("");
    meta.textContent = (d.stale ? "rate-limited · " : "") + (d.cached ? "cached" : "live") +
      (d.updated ? " · " + ago(d.updated) : "");
    meta.classList.toggle("stale", !!d.stale);
    strip.hidden = false;
  }

  async function load(force) {
    if (btn) { btn.classList.add("spin"); btn.disabled = true; }
    try {
      const r = await fetch("/api/currency/overview?league=" + encodeURIComponent(LEAGUE) + (force ? "&refresh=1" : ""));
      render(await r.json());
    } catch {
      if (!chips.children.length) strip.hidden = true;
    } finally {
      if (btn) { btn.classList.remove("spin"); btn.disabled = false; }
    }
  }

  if (btn) btn.addEventListener("click", () => load(true));
  load(false);
};

/* Filter Helper — paste a PoE2 .filter, it tells you what CURRENCY your filter hides.
   100% client-side: no Trade2, no pricing, no rate limits. It simulates the real
   loot-filter cascade (first matching block wins, like the game evaluates it) over a
   small set of currency item-classes, so it catches a Hide that sits ABOVE your
   currency Show — which the old set-based check couldn't see.

   Ceiling (ponytail): matches on Class + BaseType only. Styling-only blocks are
   skipped; a block whose ONLY conditions are non-class/base (e.g. `Rarity Rare`) is
   treated as not-targeting-currency. Good enough for "is my currency hidden"; a full
   condition engine would be tighter but is YAGNI here. */

// ── pure logic (also exported for filter-helper-test.js under node) ──────────────
const _nameEq = (a, b) => String(a).toLowerCase().replace(/\s+/g, " ").trim() === String(b).toLowerCase().replace(/\s+/g, " ").trim();
const _normCls = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/s$/, "");
const _clsHit = (blockClasses, itemClasses) =>
  itemClasses.some((ic) => { const a = _normCls(ic); return blockClasses.some((bc) => { const b = _normCls(bc); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); }); });

// Styling / action lines — present in a block but don't narrow what it matches.
const FILTER_ACTIONS = /^(Set(FontSize|TextColor|BackgroundColor|BorderColor)|Play(AlertSound|AlertSoundPositional|Effect)|CustomAlertSound|MinimapIcon|(Disable|Enable)DropSound|Continue)\b/i;

// The currency item-classes a PoE2 filter actually uses (confirmed against real
// filters). Stackable Currency covers orbs, shards, essences, runes, soul cores,
// catalysts, distilled emotions and splinters — they're all that one class, addressed
// by BaseType. Omens/Tablets/Breachstones/Map Fragments are their own classes.
const CURRENCY_GROUPS = [
  { label: "Currency — orbs, shards, essences, runes…", classes: ["Stackable Currency", "Currency"], bases: [
    "Divine Orb", "Mirror of Kalandra", "Perfect Exalted Orb", "Greater Exalted Orb", "Exalted Orb",
    "Chaos Orb", "Orb of Annulment", "Regal Orb", "Vaal Orb", "Orb of Alchemy", "Orb of Chance",
    "Fracturing Orb", "Artificer's Orb", "Gemcutter's Prism", "Orb of Transmutation", "Orb of Augmentation",
    "Glassblower's Bauble", "Arcanist's Etcher", "Armourer's Scrap", "Blacksmith's Whetstone", "Chance Shard",
    "Simulacrum Splinter", "Breach Splinter"] },
  { label: "Omens", classes: ["Omen"], bases: [] },
  { label: "Precursor Tablets", classes: ["Tablet"], bases: [] },
  { label: "Breachstones", classes: ["Breachstones"], bases: [] },
  { label: "Map Fragments", classes: ["Map Fragments"], bases: [] },
];

// Parse a .filter into ordered blocks. Each block keeps its starting line, its
// BaseType/Class lists, whether it's leveling-only (AreaLevel cap, no floor),
// whether it has a Continue, and whether it's a bare catch-all (no conditions at all).
function parseFilterBlocks(text) {
  // A Class/BaseType value list is quoted strings AND/OR bare words (legal PoE
  // filter syntax: `Class Currency` ≡ `Class "Currency"`; bare words are
  // space-separated tokens). Unquoted values used to yield [] → the block looked
  // condition-less → catchAll → "matches everything" (a Hide with an unquoted
  // Class read as hiding ALL groups).
  const values = (s) => {
    const out = (s.match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1));
    const bare = s.replace(/"[^"]*"/g, " ").replace(/#.*$/, "");   // strip quoted parts + trailing comment
    for (const w of bare.split(/\s+/)) if (w) out.push(w);
    return out;
  };
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const headLine = i + 1;
    const t = lines[i].trim(); i++;
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(Show|Hide)\b/i);
    if (!m) continue;
    const mode = m[1].toLowerCase();
    const body = [];
    while (i < lines.length) {
      const x = lines[i].trim();
      if (!x) { i++; break; }                      // blank line ends the block
      if (/^(Show|Hide)\b/i.test(x)) break;        // next block — don't consume
      if (!x.startsWith("#")) body.push(x);
      i++;
    }
    const bases = [], classes = [];
    let hasMax = false, hasMin = false, hasContinue = false, otherCond = false;
    for (const l of body) {
      if (/AreaLevel\s*<=?\s*\d/i.test(l)) hasMax = true;
      if (/AreaLevel\s*>=?\s*\d/i.test(l)) hasMin = true;
      if (FILTER_ACTIONS.test(l)) { if (/^Continue\b/i.test(l)) hasContinue = true; continue; }
      const bm = l.match(/^BaseType\b\s*(==|>=|<=)?\s*(.+)$/i);
      const cm = l.match(/^Class\b\s*(==|>=|<=)?\s*(.+)$/i);
      if (bm) bases.push(...values(bm[2]));
      else if (cm) classes.push(...values(cm[2]));
      else otherCond = true;                       // some other condition (Rarity, Sockets…)
    }
    blocks.push({ mode, line: headLine, bases, classes, hasMax, hasMin, hasContinue,
      catchAll: !bases.length && !classes.length && !otherCond });
  }
  return blocks;
}

// Does this block apply to this currency item? Conditions within a block are AND:
// if it lists BaseTypes the name must be in them; if it lists Classes the item's
// class must match; a bare block (no conditions) matches everything.
function blockMatches(b, item) {
  if (b.hasMax && !b.hasMin) return false;                        // leveling-only block
  if (b.bases.length && !b.bases.some((x) => _nameEq(x, item.name))) return false;
  if (b.classes.length && !_clsHit(b.classes, item.classes)) return false;
  if (!b.bases.length && !b.classes.length) return b.catchAll;    // bare = match; conditional-only = ignore
  return true;
}

// Walk the cascade: last matching block whose Continue chain reaches it wins; a
// non-Continue match stops evaluation. Nothing matches → shown (the game default).
function verdictFor(item, blocks) {
  let mode = null, line = null;
  for (const b of blocks) {
    if (!blockMatches(b, item)) continue;
    mode = b.mode; line = b.line;
    if (!b.hasContinue) break;
  }
  return { hidden: mode === "hide", line };
}

// Analyze a filter → per-group verdict + the named valuable items each group hides.
function analyzeFilter(text) {
  const blocks = parseFilterBlocks(text);
  const groups = CURRENCY_GROUPS.map((g) => {
    const classV = verdictFor({ name: " none ", classes: g.classes }, blocks); // tests the broad-class path
    const hiddenBases = g.bases.filter((b) => verdictFor({ name: b, classes: g.classes }, blocks).hidden);
    const hidden = classV.hidden || hiddenBases.length > 0;
    return { label: g.label, classes: g.classes, bases: g.bases, classHidden: classV.hidden, line: classV.line, hiddenBases, hidden };
  });
  return { blocks: blocks.length, groups, anyHidden: groups.some((g) => g.hidden) };
}

// A top-of-filter Show block that un-hides what's flagged: whole hidden classes by
// Class, plus any individually-hidden bases whose class isn't already covered.
function buildShowBlock(report) {
  const hiddenClasses = [];
  for (const g of report.groups) if (g.classHidden) for (const c of g.classes) if (!hiddenClasses.includes(c)) hiddenClasses.push(c);
  const looseBases = [];
  for (const g of report.groups) if (!g.classHidden) for (const b of g.hiddenBases) if (!looseBases.includes(b)) looseBases.push(b);
  if (!hiddenClasses.length && !looseBases.length) return "";
  const style = ["    SetFontSize 45", "    SetTextColor 255 255 255 255", "    SetBackgroundColor 140 30 30 255",
    "    SetBorderColor 255 220 100 255", "    PlayAlertSound 2 300", "    MinimapIcon 1 Yellow Star", "    PlayEffect Yellow"];
  const out = ["# poe-tools Filter Helper — paste at the VERY TOP of your filter so this currency is never hidden."];
  if (hiddenClasses.length) out.push("Show", "    Class " + hiddenClasses.map((c) => '"' + c + '"').join(" "), ...style);
  if (looseBases.length) out.push("Show", "    BaseType == " + looseBases.map((b) => '"' + b.replace(/"/g, "") + '"').join(" "), ...style);
  return out.join("\n");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseFilterBlocks, blockMatches, verdictFor, analyzeFilter, buildShowBlock, CURRENCY_GROUPS };
}

// ── view (browser only) ─────────────────────────────────────────────────────────
if (typeof window !== "undefined") {
  window.__viewInit = window.__viewInit || {};
  window.__viewInit["filter-helper"] = function () {
    const $ = (id) => document.getElementById(id);
    const filterArea = $("fhFilter"), statusEl = $("fhStatus"), rows = $("fhRows"), wrap = $("fhTableWrap");
    const blockArea = $("fhBlock"), copyBtn = $("fhCopy"), blockWrap = $("fhBlockWrap");
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const setStatus = (msg, cls) => { statusEl.textContent = msg; statusEl.className = "status" + (cls ? " " + cls : ""); };

    function render(report) {
      rows.innerHTML = report.groups.map((g) => {
        const badge = g.hidden ? '<span class="fh-bad">HIDDEN</span>' : '<span class="fh-ok">shown</span>';
        let detail = g.line ? (g.hidden ? "buried at line " + g.line : "shown at line " + g.line) : "no rule — shown by default";
        if (g.hiddenBases.length) detail += " · hides: " + g.hiddenBases.join(", ");
        return "<tr><td>" + esc(g.label) + "</td><td>" + badge + "</td><td class=\"muted\">" + esc(detail) + "</td></tr>";
      }).join("");
      wrap.hidden = false;
      const block = buildShowBlock(report);
      blockWrap.hidden = !block;
      if (block) blockArea.value = block;
      if (report.anyHidden) {
        const n = report.groups.filter((g) => g.hidden).length;
        setStatus(n + " currency group" + (n === 1 ? "" : "s") + " hidden by your filter — paste the Show block below at the top to fix.", "err");
      } else {
        setStatus("Your filter shows all currency — nothing hidden.", "ok");
      }
    }

    function run() {
      const text = filterArea.value.trim();
      if (!text) { wrap.hidden = true; blockWrap.hidden = true; setStatus("Paste your .filter below to check it.", ""); return; }
      const report = analyzeFilter(text);
      if (!report.blocks) { wrap.hidden = true; blockWrap.hidden = true; setStatus("No Show/Hide blocks found — is this a PoE2 loot filter?", "err"); return; }
      render(report);
    }

    let debounce = null;
    filterArea.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(run, 400); });
    copyBtn.addEventListener("click", async () => {
      if (!blockArea.value) return;
      let ok = false;
      try { ok = await window.__copyText(blockArea.value); } catch { ok = false; }
      copyBtn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy Show block"), 1500);
    });
    run();
  };
}

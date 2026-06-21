// Offline test for Filter Helper's "what does this filter HIDE" decision — the
// logic that stops it scanning items the filter already shows. Uses the REAL
// server.js exports (no port, no network). Models a typical PoE2 filter: show
// top currency by BaseType, show the rest of currency by Class, then a catch-all
// Hide for everything else.
const { buildFilterSpec, filterHelperHides } = require("./server.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// Parsed-filter payload as the browser's parseFilter would emit it.
const spec = buildFilterSpec({
  shownBases: ["Divine Orb", "Mirror of Kalandra"],   // explicit top-currency Show
  shownClasses: ["Currency", "Soul Core"],            // bulk currency + soul cores shown by Class
  hiddenBases: [],
  hiddenClasses: [],
  catchAllHide: true,                                  // "Hide everything not shown above"
});

const cand = (name, category) => ({ name, category });

// Shown explicitly by BaseType -> NOT hidden.
ok(!filterHelperHides(cand("Divine Orb", "Currency"), spec), "BaseType-shown currency is not hidden");
// Shown by Class (its category maps to a shown Class) -> NOT hidden.
ok(!filterHelperHides(cand("Chaos Orb", "Currency"), spec), "Class-shown currency is not hidden (the over-scan bug)");
ok(!filterHelperHides(cand("Soul Core of Tacati", "Soul Cores"), spec), "Class match is plural-insensitive (Soul Cores ~ Soul Core)");
// Not shown by base or class, catch-all hides the rest -> HIDDEN.
ok(filterHelperHides(cand("Lesser Desert Rune", "Runes"), spec), "an item no Show block covers IS hidden under a catch-all");
ok(filterHelperHides(cand("Distilled Isolation", "Liquid Emotions"), spec), "an unshown category is hidden under a catch-all");

// No catch-all: only items explicitly in a Hide block count as hidden.
const spec2 = buildFilterSpec({ shownClasses: ["Currency"], hiddenBases: ["Lesser Desert Rune"], catchAllHide: false });
ok(!filterHelperHides(cand("Greater Desert Rune", "Runes"), spec2), "no catch-all: an unmentioned item is NOT reported hidden (no over-scan)");
ok(filterHelperHides(cand("Lesser Desert Rune", "Runes"), spec2), "no catch-all: an explicitly-Hidden base IS hidden");
ok(!filterHelperHides(cand("Exalted Orb", "Currency"), spec2), "no catch-all: a Class-shown item is not hidden");

// buildFilterSpec returns null for no filter (-> server does the full scan, by design).
ok(buildFilterSpec(null) === null && buildFilterSpec(undefined) === null, "no filter -> null spec (full scan)");

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

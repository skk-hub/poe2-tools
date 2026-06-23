// Offline test for Filter Helper's cascade analysis — the order-aware "what currency
// does this filter HIDE" logic. Uses the REAL filter-helper.js exports (no DOM, no
// network). The key property the old set-based check lacked: a Hide block ABOVE a
// Show is seen, and a catch-all Hide at the bottom hides everything not shown above.
const { analyzeFilter, verdictFor, parseFilterBlocks } = require("./filter-helper.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const groupBy = (r, label) => r.groups.find((g) => g.label.includes(label));

// A typical filter: show top currency by BaseType, show the rest by Class, catch-all Hide.
const normal = `
Show
    BaseType "Divine Orb" "Mirror of Kalandra"
    SetFontSize 45
Show
    Class "Stackable Currency"
    SetFontSize 40
Show
    Class "Omen"
Hide
`;
let r = analyzeFilter(normal);
ok(!groupBy(r, "orbs").hidden, "currency shown (by Class) is not flagged hidden");
ok(!groupBy(r, "Omens").hidden, "omens shown by Class are not hidden");
ok(groupBy(r, "Tablets").hidden, "tablets (never shown) are hidden by the catch-all");
ok(groupBy(r, "Breachstones").hidden, "breachstones (never shown) are hidden by the catch-all");

// The bug the rewrite fixes: a Hide block ABOVE the currency Show buries it. The old
// order-blind check thought the later Show saved it; the cascade knows Hide wins first.
const hideAbove = `
Hide
    Class "Stackable Currency"
Show
    Class "Stackable Currency"
`;
ok(groupBy(analyzeFilter(hideAbove), "orbs").hidden, "Hide above Show wins the cascade (currency IS hidden)");

// Explicit Hide of one orb while the class is shown → that base flagged, class not.
const oneHidden = `
Hide
    Class "Stackable Currency"
    BaseType "Chance Shard"
Show
    Class "Stackable Currency"
`;
r = analyzeFilter(oneHidden);
ok(!groupBy(r, "orbs").classHidden, "class-wide currency still shown when only one base is hidden");
ok(groupBy(r, "orbs").hiddenBases.includes("Chance Shard"), "the explicitly-hidden base is named");
ok(!groupBy(r, "orbs").hiddenBases.includes("Divine Orb"), "a non-hidden base is not falsely named");

// AND within a block: `Class X + BaseType Y` must not hide all of class X.
const andBlock = `
Hide
    Class "Stackable Currency"
    BaseType "Chance Shard"
`;
ok(!verdictFor({ name: "Divine Orb", classes: ["Stackable Currency"] }, parseFilterBlocks(andBlock)).hidden,
  "Class+BaseType Hide only hits the listed base, not the whole class");

// Leveling-only block (AreaLevel cap, no floor) is ignored.
const leveling = `
Show
    Class "Stackable Currency"
    AreaLevel <= 67
Hide
`;
ok(groupBy(analyzeFilter(leveling), "orbs").hidden, "a leveling-only Show doesn't count as showing currency in maps");

// No catch-all: an unshown class is NOT reported hidden (default is show).
const noCatchAll = `
Show
    Class "Stackable Currency"
`;
ok(!groupBy(analyzeFilter(noCatchAll), "Tablets").hidden, "no catch-all: unmentioned class defaults to shown");

// Continue: a styling Continue block doesn't end the cascade; a later Hide still wins.
const withContinue = `
Show
    Class "Stackable Currency"
    SetFontSize 40
    Continue
Hide
    Class "Stackable Currency"
`;
ok(groupBy(analyzeFilter(withContinue), "orbs").hidden, "Continue keeps evaluating — a later Hide wins");

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

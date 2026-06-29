// Rune-socket fill: an extra socket must add one more of YOUR rune; empty sockets count;
// the seller's runes are dropped. Pure string logic — no PoB, no network.
const assert = require("assert");
const { pobItemFromTradeEntry, extractRuneLines } = require("./server");

// Your current 1-socket item: PoB tags rune mods {rune}.
// {rune} is PoB-native and fed straight back to PoB, so it's kept (not stripped).
const myRune = extractRuneLines("Rarity: Rare\nFoo\nBody Armour\n+18% to Lightning Resistance {rune}\n+100 to Armour");
assert.deepStrictEqual(myRune, ["+18% to Lightning Resistance {rune}"], "extractRuneLines picks the {rune} line");

const mk = (sockets) => ({ item: { typeLine: "Test Plate", baseType: "Test Plate", ilvl: 81,
  sockets, runeMods: ["SELLER RUNE +50% to Cold Resistance"], explicitMods: ["+100 to maximum Life"] } });
const count = (txt, needle) => txt.split("\n").filter((l) => l.includes(needle)).length;

// 2-socket candidate, your rune filled twice, seller rune gone.
const two = pobItemFromTradeEntry(mk([{ type: "rune" }, { type: "rune" }]), [], myRune);
assert.strictEqual(count(two, "Lightning Resistance"), 2, "2 sockets → your rune x2");
assert.strictEqual(count(two, "SELLER RUNE"), 0, "seller rune dropped");
assert.strictEqual(count(two, "maximum Life"), 1, "base explicit kept");

// 1-socket → x1; 0-socket (no sockets field) → none (can't rune it → scores lower).
assert.strictEqual(count(pobItemFromTradeEntry(mk([{ type: "rune" }]), [], myRune), "Lightning Resistance"), 1, "1 socket → x1");
assert.strictEqual(count(pobItemFromTradeEntry(mk(undefined), [], myRune), "Lightning Resistance"), 0, "no sockets → x0");

// No runeLines (legacy path) → seller's rune still scored.
assert.strictEqual(count(pobItemFromTradeEntry(mk([{ type: "rune" }]), []), "SELLER RUNE"), 1, "legacy path keeps seller rune");

console.log("ok");

// Rune-socket fill: the candidate's rune value scales with ITS socket count, using YOUR
// rune (plain stackable text, seller's runes dropped). Pure string logic — no PoB/network.
const assert = require("assert");
const { pobItemFromTradeEntry, extractRuneFill } = require("./server");

// Current item: 2 sockets, both Perfect Iron Rune → PoB combines to one summed line
// ({enchant}{rune} tagged) + Bonded lines. extractRuneFill strips tags/Bonded → plain.
const cur = [
  "Rarity: RARE", "Soul Veil", "Corsair Coat", "Sockets: S S",
  "Rune: Perfect Iron Rune", "Rune: Perfect Iron Rune", "Implicits: 4",
  "{enchant}{rune}40% increased Armour, Evasion and Energy Shield",
  "{enchant}{rune}Bonded: +40 to maximum Life",
  "+358 to Evasion Rating",
].join("\n");
const fill = extractRuneFill(cur);
assert.deepStrictEqual(fill.lines, ["40% increased Armour, Evasion and Energy Shield", "+40 to maximum Life"], "plain lines, tags+Bonded stripped");
assert.strictEqual(fill.sockets, 2, "2 'Rune:' lines → 2 sockets");

const mk = (n) => ({ item: { typeLine: "Corsair Coat", baseType: "Corsair Coat", ilvl: 81,
  runeMods: ["SELLER 50% increased Cold Resistance"], explicitMods: ["+100 to maximum Life"], sockets: Array(n).fill({ type: "rune" }) } });
const get = (txt, re) => Number((txt.match(re) || [])[1] || 0);

// 2-socket candidate == your current rune block (factor 2/2=1): 40% AES, +40 Life.
const two = pobItemFromTradeEntry(mk(2), [], fill);
assert.strictEqual(get(two, /(\d+)% increased Armour/), 40, "2 sockets → 40% (factor 1)");
assert.strictEqual(get(two, /\+(\d+) to maximum Life\b/), 40, "2 sockets → +40 Life");
assert.ok(!/SELLER/.test(two), "seller rune dropped");
assert.ok(/\+100 to maximum Life/.test(two), "base explicit kept");

// 3 sockets → factor 1.5 → 60% / +60. 1 socket → factor .5 → 20% / +20. 0 → no rune.
assert.strictEqual(get(pobItemFromTradeEntry(mk(3), [], fill), /(\d+)% increased Armour/), 60, "3 sockets → 60%");
assert.strictEqual(get(pobItemFromTradeEntry(mk(1), [], fill), /(\d+)% increased Armour/), 20, "1 socket → 20%");
assert.ok(!/increased Armour/.test(pobItemFromTradeEntry(mk(0), [], fill)), "0 sockets → no rune");

// No runeFill (legacy) → seller's rune kept.
assert.ok(/SELLER/.test(pobItemFromTradeEntry(mk(2), [])), "legacy path keeps seller rune");

console.log("ok");
